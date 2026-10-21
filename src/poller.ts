// 轮询模块
// commits 走 /commits 快通道；issues/pulls 走 /events；actions 走 /actions/runs
import type { GitHubEvent, GitHubCommitItem, CommitData, IssueData, CommentData, ActionRunData, EventType, UserActivityItem } from './types';
import { pluginState } from './state';
import { fetchEvents, fetchBranchCommits, fetchCommitDetail, fetchActionRuns, fetchUserEvents, NOT_MODIFIED } from './github';
import { scheduleCommitSummary } from './llm';
import { renderCommits, renderIssues, renderPulls, renderComments, renderActions, commitsSummary, issuesSummary, commentsSummary, actionsSummary, renderUserActivity, userActivitySummary, renderMergedRepo, mergedRepoSummary, renderMergedUsers, mergedUsersSummary } from './render';

/** 发送 base64 图片消息到群，失败则降级为文本 */
export async function sendImage (groupId: string, base64: string | null, fallbackText: string): Promise<void> {
  if (base64) {
    try {
      pluginState.debug(`[推送] 发送图片到群 ${groupId}，base64 长度: ${base64.length}`);
      await pluginState.sendGroupMsg(groupId, [
        { type: 'image', data: { file: `base64://${base64}` } }
      ]);
      pluginState.debug(`[推送] 图片发送成功: 群 ${groupId}`);
      return;
    } catch (e) {
      pluginState.debug(`[推送] 图片发送失败: 群 ${groupId}，错误: ${e}，降级为文本`);
    }
  } else {
    pluginState.debug(`[推送] 渲染失败，使用文本降级: 群 ${groupId}`);
  }

  // 降级文本本身也可能因为数据脏而生成失败，
  // 这里兜一层：至少发条「有更新但生成失败」，别让推送彻底消失
  let text = fallbackText;
  try {
    if (!text || typeof text !== 'string') throw new Error('降级文本为空');
  } catch {
    text = `[推送] 检测到更新，但生成通知内容失败（群 ${groupId}），请查看插件日志`;
    pluginState.log('warn', `[推送] 降级文本不可用，已发送兜底提示: 群 ${groupId}`);
  }
  await pluginState.sendGroupMsg(groupId, [{ type: 'text', data: { text } }]);
}

/**
 * 逐群推送，单个群失败不影响其它群。
 *
 * 返回 true 表示「至少有一个群成功」（或本来就没有群），调用方据此决定是否推进游标。
 *
 * 原来 events 分支里是裸的 `for (const gid of groups) await sendImage(...)`：
 * 第一个群发失败就抛到 checkRepo 外面，导致
 *   ① 该仓库同一轮后面几种类型（issues 失败 → pulls/comments）全部跳过；
 *   ② 已经推送成功的那些群，下一轮会把同一批事件重推一遍（游标没推进）。
 */
async function pushToGroups (
  groups: string[],
  base64: string | null,
  fallbackText: string,
  label: string,
): Promise<boolean> {
  if (!groups.length) return true;
  let okCount = 0;
  let failCount = 0;
  for (const gid of groups) {
    try {
      await sendImage(gid, base64, fallbackText);
      okCount++;
    } catch (e) {
      failCount++;
      pluginState.log('warn', `[推送] ${label} 推送到群 ${gid} 失败: ${e}`);
    }
  }
  if (failCount && okCount) {
    pluginState.log('warn', `[推送] ${label}: ${okCount} 个群成功、${failCount} 个群失败`);
  }
  return okCount > 0 || groups.length === 0;
}

/** 从 PushEvent 提取 CommitData */
export function extractCommits (events: GitHubEvent[], branch: string): CommitData[] {
  const commits: CommitData[] = [];
  // GitHub /events 偶尔返回非数组（错误体），裸 for...of 会 TypeError 炸掉整轮轮询
  if (!Array.isArray(events)) return commits;
  for (const raw of events) {
    const ev = raw as GitHubEvent;
    if (ev?.type !== 'PushEvent') continue;
    const payload = (ev.payload || {}) as Record<string, any>;
    const actor = ev.actor || { login: 'unknown', avatar_url: '' };
    const repoName = String(payload.repo || '');
    const ref = String(payload.ref || '');
    if (branch && !ref.endsWith(`/${branch}`)) continue;
    const payloadCommits = Array.isArray(payload.commits) ? payload.commits : [];
    if (payloadCommits.length) {
      for (const c of payloadCommits) {
        const sha = String(c?.sha || '');
        commits.push({
          sha,
          commit: {
            message: String(c?.message || ''),
            author: { name: c?.author?.name || actor.login, date: ev.created_at },
            committer: { name: c?.author?.name || actor.login, date: ev.created_at },
          },
          author: { login: actor.login, avatar_url: actor.avatar_url },
          html_url: `https://github.com/${repoName}/commit/${sha}`,
        });
      }
    } else if (payload.head) {
      // payload.commits 为空时（web 操作等），用 head sha 构造
      const sha = String(payload.head);
      commits.push({
        sha,
        commit: {
          message: `Push to ${ref.replace('refs/heads/', '')}`,
          author: { name: actor.login, date: ev.created_at },
          committer: { name: actor.login, date: ev.created_at },
        },
        author: { login: actor.login, avatar_url: actor.avatar_url },
        html_url: `https://github.com/${repoName}/commit/${sha}`,
      });
    }
  }
  return commits;
}

/** 从 IssuesEvent 提取 IssueData */
export function extractIssues (events: GitHubEvent[]): IssueData[] {
  const issues: IssueData[] = [];
  const seen = new Set<number>();
  // 与 extractCommits 对齐：/events 偶尔返回非数组或含 null 元素，
  // payload 缺失、labels 不是数组都会让裸访问抛 TypeError，
  // 而调用点不在 try 里，异常会冒到 poll() 的 per-repo catch ——
  // 这一轮该仓库已提取到的 commits 也会一起丢掉。
  if (!Array.isArray(events)) return issues;
  for (const raw of events) {
    const ev = raw as GitHubEvent;
    if (ev?.type !== 'IssuesEvent') continue;
    const payload = (ev.payload || {}) as Record<string, any>;
    const i = payload.issue as any;
    if (!i || seen.has(i.number)) continue;
    seen.add(i.number);
    const actor = ev.actor || { login: 'unknown', avatar_url: '' };
    const labels = Array.isArray(i.labels) ? i.labels : [];
    issues.push({
      number: i.number ?? 0,
      title: String(i.title || ''),
      state: String(i.state || 'open'),
      user: { login: String(i.user?.login || actor.login), avatar_url: String(i.user?.avatar_url || '') },
      created_at: String(i.created_at || ev.created_at || ''),
      updated_at: String(i.updated_at || ev.created_at || ''),
      html_url: String(i.html_url || ''),
      body: i.body ? String(i.body) : null,
      labels: labels.map((l: any) => ({ name: String(l?.name || ''), color: String(l?.color || '888888') })),
      action: payload.action ? String(payload.action) : undefined,
    });
  }
  return issues;
}

/** 从 PullRequestEvent 提取 IssueData */
export function extractPulls (events: GitHubEvent[]): IssueData[] {
  const pulls: IssueData[] = [];
  const seen = new Set<number>();
  if (!Array.isArray(events)) return pulls;
  for (const raw of events) {
    const ev = raw as GitHubEvent;
    if (ev?.type !== 'PullRequestEvent') continue;
    const payload = (ev.payload || {}) as Record<string, any>;
    const p = payload.pull_request as any;
    if (!p || seen.has(p.number)) continue;
    seen.add(p.number);
    const prTitle = String(p.title || payload.title || '');
    pluginState.debug(`[PR] #${p.number} title=${JSON.stringify(prTitle)} raw_title=${JSON.stringify(p.title)}`);
    const actor = ev.actor || { login: 'unknown', avatar_url: '' };
    const labels = Array.isArray(p.labels) ? p.labels : [];
    pulls.push({
      number: p.number ?? 0,
      title: prTitle,
      state: p.merged ? 'merged' : String(p.state || 'open'),
      user: { login: String(p.user?.login || actor.login), avatar_url: String(p.user?.avatar_url || '') },
      created_at: String(p.created_at || ev.created_at || ''),
      updated_at: String(p.updated_at || ev.created_at || ''),
      html_url: String(p.html_url || ''),
      body: p.body ? String(p.body) : null,
      labels: labels.map((l: any) => ({ name: String(l?.name || ''), color: String(l?.color || '888888') })),
      action: p.merged ? 'merged' : (payload.action ? String(payload.action) : undefined),
      pull_request: true,
    });
  }
  return pulls;
}

/** 从 IssueCommentEvent / PullRequestReviewCommentEvent 提取评论 */
export function extractComments (events: GitHubEvent[]): CommentData[] {
  const comments: CommentData[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(events)) return comments;
  for (const raw of events) {
    const ev = raw as GitHubEvent;
    if (ev?.type !== 'IssueCommentEvent' && ev?.type !== 'PullRequestReviewCommentEvent') continue;
    const payload = (ev.payload || {}) as Record<string, any>;
    const comment = payload.comment as any;
    if (!comment) continue;
    const key = String(comment.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const issue = payload.issue as any;
    const pr = payload.pull_request as any;
    const target = issue || pr;
    const actor = ev.actor || { login: 'unknown', avatar_url: '' };
    comments.push({
      number: target?.number ?? 0,
      title: String(target?.title || ''),
      body: String(comment.body || ''),
      user: { login: String(comment.user?.login || actor.login), avatar_url: String(comment.user?.avatar_url || '') },
      created_at: String(comment.created_at || ev.created_at || ''),
      html_url: String(comment.html_url || ''),
      source: ev.type === 'PullRequestReviewCommentEvent' ? 'pull_request' : 'issue',
    });
  }
  return comments;
}

/** 单个仓库收集到的更新数据（合并模式用） */
export interface RepoCollected {
  repo: string;
  branch: string;
  alias?: string;
  groups: string[];
  commits: CommitData[];
  issues: IssueData[];
  pulls: IssueData[];
  comments: CommentData[];
  actions: ActionRunData[];
}

/**
 * 把 /commits 返回的一条提交，转换成渲染层通用的 CommitData 结构。
 * 渲染模块（render.ts）不关心数据是从哪个接口来的，统一吃 CommitData。
 */
export function commitToData (c: GitHubCommitItem, repo: string): CommitData {
  // GitHub 偶尔会返回 commit 字段缺失的条目（删号、私有转公开的残留等），
  // 原来 c.commit.author 直接裸访问会 TypeError，把整批提交都炸掉。
  const commit = c.commit;
  const sha = String(c.sha || '');
  const authorName = commit?.author?.name || c.author?.login || 'unknown';
  const authorDate = commit?.author?.date
    || commit?.committer?.date
    || new Date().toISOString();

  return {
    sha,
    commit: {
      message: commit?.message || '',
      author: { name: authorName, date: authorDate },
      committer: {
        name: commit?.committer?.name || authorName,
        date: commit?.committer?.date || authorDate,
      },
    },
    author: {
      login: c.author?.login || authorName,
      avatar_url: c.author?.avatar_url || '',
    },
    html_url: c.html_url || `https://github.com/${repo}/commit/${sha}`,
  };
}

/**
 * commits 快通道：用 /commits 判断有没有新提交。
 *
 * 游标存的是分支 head 的 sha（key 为 `${repo}:${branch}:head`）。
 * 不再是原来那套「事件 id 水位线」——事件 id 会被 star/fork 等无关事件顶掉，
 * 而且 /events 本身滞后，两个毛病叠加就表现为「明明有人提交却永远不推送」。
 *
 * @param collected 合并模式下用来收集结果；非合并模式直接推送
 */
export async function checkRepoCommits (
  repo: string,
  branch: string,
  types: EventType[],
  groups: string[],
  collect: boolean | undefined,
  collected: RepoCollected,
  alias?: string,
): Promise<void> {
  if (!types.includes('commits')) return;

  // 统一小写：与 state.dropRepoCursors 的匹配规则对齐，否则删订阅时游标删不掉
  const cacheKey = `${repo.toLowerCase()}:${branch}:head`;
  const commits = await fetchBranchCommits(repo, branch);

  // 304：这一轮没有任何提交变化，直接回，连渲染都不用做
  if (commits === NOT_MODIFIED) {
    pluginState.debug(`[commits源] ${repo}@${branch}: 304 无变化，本轮跳过`);
    return;
  }
  if (!commits || !Array.isArray(commits) || !commits.length) {
    pluginState.debug(`[commits源] ${repo}@${branch}: 无提交数据`);
    return;
  }

  // commits[0] 可能是 null，也可能缺 sha（GitHub 返回畸形数据时）。
  // 不校验的话 latestSha 是 undefined，下面 .slice() 直接抛 TypeError，
  // 而 pluginState.debug 的模板字符串在传参前就求值（debug 关闭也照样执行）。
  // 异常会从 checkRepoCommits 冒到 checkRepo，把同仓库的 actions / events
  // 一起跳过 —— 该仓库就永久什么都推不出来了。
  const latestSha = String(commits[0]?.sha || '');
  if (!latestSha) {
    pluginState.log('warn', `[commits源] ${repo}@${branch}: 返回数据缺少 sha，跳过本轮`);
    return;
  }
  const lastHead = pluginState.cache[cacheKey];
  pluginState.debug(`[commits源] ${repo}@${branch}: 最新 head=${latestSha.slice(0, 7)}, 缓存=${lastHead ? String(lastHead).slice(0, 7) : '无'}`);

  // 首次运行只记基线，不推送历史
  if (!lastHead) {
    pluginState.cache[cacheKey] = latestSha;
    pluginState.saveCache();
    pluginState.log('info', `[${repo}@${branch}] commits 源首次运行，记录 head: ${latestSha.slice(0, 7)}，不推送`);
    return;
  }

  if (lastHead === latestSha) {
    pluginState.debug(`[commits源] ${repo}@${branch}: 头部一致，无新提交`);
    return;
  }

  // 在最近窗口里找旧 head，它之前的都是新提交
  const lastIdx = commits.findIndex(c => c.sha === lastHead);

  if (lastIdx === -1) {
    // 找不到旧 head：可能是强制推送（rebase/force push），或两轮之间提交数超过窗口。
    // 这种情况重置游标、本轮不推，避免把历史提交当新提交刷屏。
    // 注意：这里必须先判 -1 再切片 —— 之前写成 slice(0, 20) 然后判 length，
    // 而 slice(0, 20) 永远返回 20 条，守卫条件永远为假，强推时会把 20 条历史全推出去。
    pluginState.cache[cacheKey] = latestSha;
    pluginState.saveCache();
    pluginState.log('warn', `[${repo}@${branch}] 未在最近窗口内找到旧 head（可能强推或提交过多），已重置游标，本轮不推送`);
    return;
  }

  const rawNew = commits.slice(0, lastIdx);

  // /commits 是「新的在前」，推送时按时间正序更自然，所以 reverse 一下
  const commitList = rawNew.map(c => commitToData(c, repo)).reverse();
  pluginState.log('info', `[${repo}@${branch}] commits 源发现 ${commitList.length} 条新提交: ${commitList.map(c => String(c.sha || '').slice(0, 7)).join(', ')}`);

  // 补全每个 commit 的文件改动（用于渲染 diff）
  // 用并发闸门：这里是「每条提交一个请求」，20 条提交全并发会触发 GitHub 二级限流
  await runLimited(commitList, MAX_CONCURRENT_REQUESTS, async (c) => {
    try {
      const detail = await fetchCommitDetail(repo, c.sha);
      if (detail?.files) {
        c.files = detail.files.map((f: any) => ({
          filename: f.filename || '', status: f.status || '',
          additions: f.additions || 0, deletions: f.deletions || 0,
          patch: f.patch || undefined,
        }));
      }
      if (detail?.commit?.message && c.commit.message.startsWith('Push to ')) {
        c.commit.message = detail.commit.message;
      }
    } catch { /* 拿不到详情就只显示标题，不影响推送 */ }
  });

  if (collect) {
    // 合并模式下真正的推送在 poll() 里统一做，这里先把游标推上去。
    // （合并模式没有逐条回执，失败重试的代价是整个批次重推，得不偿失）
    pluginState.cache[cacheKey] = latestSha;
    pluginState.saveCache();
    collected.commits = commitList;
    return;
  }

  pluginState.log('info', `[${repo}] 推送 ${commitList.length} 条新 Commit 到 ${groups.length} 个群`);

  // 游标必须在**推送成功之后**才推进。
  // 原来是在渲染/发送之前就写 cache 并落盘，一旦 puppeteer 挂了或 QQ 发送失败，
  // 这批提交永远不会再推（下一轮 lastHead 已经更新），用户完全收不到，
  // 日志里也看不出丢过东西。
  let okCount = 0;
  let failCount = 0;
  try {
    const base64 = await renderCommits(repo, commitList);
    const fallback = commitsSummary(repo, commitList);
    for (const gid of groups) {
      try {
        await sendImage(gid, base64, fallback);
        okCount++;
      } catch (e) {
        failCount++;
        pluginState.log('warn', `[commits源] ${repo} 推送到群 ${gid} 失败: ${e}`);
      }
    }
  } catch (e) {
    failCount += groups.length - okCount - failCount;
    pluginState.log('error', `[commits源] 渲染失败: ${e}`);
  }

  // 至少有一个群推送成功才推进游标：
  // 全部失败时保留旧游标，下一轮会重新发现这批提交并重试。
  // 只要有一个成功就不重试，否则某个已解散的群会让同一批提交被无限重推。
  if (okCount > 0 || groups.length === 0) {
    pluginState.cache[cacheKey] = latestSha;
    pluginState.saveCache();
    if (failCount) {
      pluginState.log('warn', `[commits源] ${repo}@${branch}: ${okCount} 个群成功、${failCount} 个群失败，游标已推进`);
    }
  } else {
    pluginState.log('warn', `[commits源] ${repo}@${branch}: 全部 ${groups.length} 个群推送失败，游标保持在 ${lastHead.slice(0, 7)}，下一轮重试`);
  }

  // AI 摘要放后台跑，不阻塞本轮轮询
  scheduleCommitSummary(groups, repo, commitList, alias);
}

/** 单个用户收集到的活动数据（合并模式用） */
export interface UserCollected {
  username: string;
  groups: string[];
  items: UserActivityItem[];
}

/**
 * Actions 检查（独立接口 /actions/runs，与 /events 无关）
 *
 * 必须从 checkRepo 的 events 流程里抽出来：events 有多个提前 return
 * （无事件 / 首次运行 / 无更新 / 游标失效 / 新事件为空），
 * 原来 actions 的代码写在它们后面，只要 events 没变化就永远走不到，
 * 表现为「只订阅 commits+actions 的仓库，workflow 跑完永远不推送」。
 */
export async function checkRepoActions (
  repo: string,
  types: EventType[],
  groups: string[],
  collect: boolean | undefined,
  collected: RepoCollected,
): Promise<void> {
  if (!types.includes('actions')) return;

  const actionsCacheKey = `${repo.toLowerCase()}:actions`;

  // Actions 是**仓库级**数据（游标 `${repo}:actions`），但推送群是**订阅级**的。
  // 同一仓库订阅多个分支时（owner/repo@main / owner/repo@dev），
  // poll() 会并发跑两个 checkRepo，两条都进到这里：
  // 先返回的那条读旧游标、推完、推进游标，后返回的走「无更新」直接返回 ——
  // 结果是只有一个分支的群收到了 Actions，另一个分支的群永远收不到。
  // 解决：每个仓库每轮只真正检查一次，但把该仓库**所有**订阅的群合起来推。
  // 同一仓库的多分支订阅共享这一份结果（见 actionsRoundCache 注释）
  const roundKey = actionsCacheKey;
  if (actionsCheckedThisRound.has(roundKey)) {
    pluginState.debug(`[轮询] ${repo}: Actions 本轮已检查过，复用结果`);
    if (collect) {
      const cached = actionsRoundCache.get(roundKey);
      if (cached?.length) collected.actions = cached;
    }
    return;
  }
  actionsCheckedThisRound.add(roundKey);

  // Actions 是仓库级数据，推送群却是订阅级：同一仓库订阅多个分支时
  // （owner/repo@main / owner/repo@dev），poll() 会并发跑多个 checkRepo，
  // 若各自只推自己订阅的群，只有一个分支的群能收到 Actions。
  // 这里把该仓库所有启用订阅的群合并成一份推送目标。
  const targetGroups = new Set<string>(groups);
  for (const s of pluginState.config.subscriptions) {
    if (!s.enabled || !Array.isArray(s.groups)) continue;
    if (s.repo.toLowerCase() !== repo.toLowerCase()) continue;
    for (const g of s.groups) targetGroups.add(String(g));
  }
  const pushGroups = [...targetGroups].filter(Boolean);

  pluginState.debug(`[轮询] ${repo}: 检查 Actions runs`);
  const runs = await fetchActionRuns(repo);
  if (!runs.length) {
    // 仓库长期没有 workflow 活动时，旧的 run 会被 GitHub 按保留策略清掉。
    // 这时如果保留旧游标，等下一个 workflow 真的跑起来，findIndex 必然 -1，
    // 会走「重置基线、本轮不推送」——用户订阅后遇到的第一次构建结果就收不到。
    // 直接清掉游标，让下一次非空响应走「首次运行」路径重新记基线。
    if (pluginState.cache[actionsCacheKey]) {
      delete pluginState.cache[actionsCacheKey];
      pluginState.saveCache();
    }
    return;
  }

  // 游标不能只存 run id：run 一创建就出现在列表里（status=queued、conclusion=null），
  // 那时就被当成新事件推出去并把游标推到该 id；等它变成 in_progress / completed
  // （success/failure）时 id 没变，`lastKnownRun === latestRunId` 直接返回 ——
  // 用户永远只看得到 [queued] 的卡片，看不到构建结果。手动 re-run 复用同一 id 也一样。
  // 所以游标记成 `id:status:conclusion:run_attempt`，状态一变就算「有更新」。
  const sigOf = (r: any): string => `${r.id}:${r.status || ''}:${r.conclusion || ''}:${r.run_attempt || 1}`;

  const latestSig = sigOf(runs[0]);
  const lastKnownRun = pluginState.cache[actionsCacheKey];
  if (!lastKnownRun) {
    pluginState.cache[actionsCacheKey] = latestSig;
    pluginState.saveCache();
    pluginState.log('info', `[${repo}] Actions 首次运行，记录基线: ${latestSig}`);
    return;
  }
  if (lastKnownRun === latestSig) {
    pluginState.debug(`[轮询] ${repo}: Actions 无更新`);
    return;
  }

  // 旧游标可能带 status/conclusion（新格式），也可能是纯 id（老格式）
  const lastSigRaw = String(lastKnownRun);
  const isOldFormat = !lastSigRaw.includes(':');
  const lastRunId = lastSigRaw.split(':')[0];
  const lastRunIdx = runs.findIndex(r => String(r.id) === lastRunId);
  // 游标不在最近 runs 里：重置基线不推送，避免把历史 workflow 当新事件刷屏
  if (lastRunIdx === -1) {
    pluginState.cache[actionsCacheKey] = latestSig;
    pluginState.saveCache();
    pluginState.log('warn', `[${repo}] Actions 游标已失效，重置基线，本轮不推送`);
    return;
  }

  // 窗口内比旧游标「更新」的 run：新 id 的，以及同一 id 但状态/尝试次数变了的
  const newRuns: ActionRunData[] = runs.slice(0, lastRunIdx).map((r: any) => ({
    id: r.id, name: r.name || r.display_title || '', head_branch: r.head_branch || '',
    head_sha: r.head_sha || '', status: r.status || '', conclusion: r.conclusion || null,
    html_url: r.html_url || '', created_at: r.created_at || '', updated_at: r.updated_at || '',
    actor: { login: r.actor?.login || '', avatar_url: r.actor?.avatar_url || '' },
    event: r.event || '', run_number: r.run_number || 0,
  }));

  // 旧游标那条 run 自己也可能已经变成终态（这是最常被漏掉的一种：
  // 上一轮推的是 queued，这一轮它已经 completed，但 id 没变）
  // 老格式（纯 id）不知道它上一轮是什么状态，只把游标迁移成新格式，不补推，
  // 否则升级后第一轮会把每个仓库当前那条 run 都当新事件刷一遍。
  const tracked = runs[lastRunIdx] as any;
  if (!isOldFormat && tracked && sigOf(tracked) !== lastSigRaw) {
    newRuns.push({
      id: tracked.id, name: tracked.name || tracked.display_title || '',
      head_branch: tracked.head_branch || '', head_sha: tracked.head_sha || '',
      status: tracked.status || '', conclusion: tracked.conclusion || null,
      html_url: tracked.html_url || '', created_at: tracked.created_at || '',
      updated_at: tracked.updated_at || '',
      actor: { login: tracked.actor?.login || '', avatar_url: tracked.actor?.avatar_url || '' },
      event: tracked.event || '', run_number: tracked.run_number || 0,
    });
  }

  if (!newRuns.length) {
    pluginState.cache[actionsCacheKey] = latestSig;
    pluginState.saveCache();
    return;
  }

  // 缓存本轮结果：同仓库其它分支的 checkRepo 直接复用，不重复请求也不重复推送
  actionsRoundCache.set(roundKey, newRuns);

  if (collect) {
    pluginState.cache[actionsCacheKey] = latestSig;
    pluginState.saveCache();
    collected.actions = newRuns;
    return;
  }

  pluginState.log('info', `[${repo}] 推送 ${newRuns.length} 条 Actions 更新到 ${pushGroups.length} 个群`);

  // 与 commits 同理：游标必须在推送成功之后才推进，
  // 否则渲染/发送失败一次，这批 workflow 结果就永远丢了。
  let okCount = 0;
  let failCount = 0;
  try {
    const base64 = await renderActions(repo, newRuns);
    const fallback = actionsSummary(repo, newRuns);
    for (const gid of pushGroups) {
      try {
        await sendImage(gid, base64, fallback);
        okCount++;
      } catch (e) {
        failCount++;
        pluginState.log('warn', `[${repo}] Actions 推送到群 ${gid} 失败: ${e}`);
      }
    }
  } catch (e) {
    failCount += pushGroups.length - okCount - failCount;
    pluginState.log('error', `[${repo}] Actions 渲染失败: ${e}`);
  }

  if (okCount > 0 || pushGroups.length === 0) {
    pluginState.cache[actionsCacheKey] = latestSig;
    pluginState.saveCache();
    if (failCount) pluginState.log('warn', `[${repo}] Actions: ${okCount} 个群成功、${failCount} 个群失败，游标已推进`);
  } else {
    pluginState.log('warn', `[${repo}] Actions: 全部 ${pushGroups.length} 个群推送失败，游标保持在 ${lastKnownRun}，下一轮重试`);
  }
}

export async function checkRepo (repo: string, branch: string, types: EventType[], groups: string[], collect?: boolean, alias?: string): Promise<RepoCollected | null> {
  // 脏配置防御：配置可能被手改或由旧版本写入，types/groups 不是数组时
  // 后面的 types.includes / groups.join / for...of 全都会炸。
  const typeList: EventType[] = Array.isArray(types) ? types : [];
  const groupList: string[] = Array.isArray(groups) ? groups.map(g => String(g)).filter(Boolean) : [];
  // 就地归一，后续所有分支继续用原变量名（改动面最小，避免漏改）
  types = typeList;
  groups = groupList;
  // 统一小写：与 state.dropRepoCursors 的匹配规则对齐
  const cacheKey = `${repo.toLowerCase()}:${branch}`;
  const collected: RepoCollected = { repo, branch, alias, groups: groupList, commits: [], issues: [], pulls: [], comments: [], actions: [] };
  pluginState.debug(`[轮询] 检查仓库: ${repo} (分支: ${branch}, 类型: ${typeList.join(',')}, 群: ${groupList.join(',')})`);

  // 收集模式下有没有攒到任何数据；两个闭包统一所有提前 return 的写法，
  // 避免再出现「某个分支忘记带上 collected.commits」这类漏洞
  const hasCollected = (): boolean => Boolean(
    collected.commits.length || collected.issues.length || collected.pulls.length
    || collected.comments.length || collected.actions.length,
  );
  const done = (): RepoCollected | null => (collect && hasCollected() ? collected : null);

  // 是否使用 commits 快通道（默认开启，可在配置里切回 events）
  const useCommitSource = (pluginState.config.commitSource ?? 'commits') !== 'events';

  // ---- 第一步：commits 走快通道 ----
  // 每个数据源各自包 try/catch：一个数据源的脏数据不该把同仓库的其它数据源一起跳过。
  // 原来没有任何隔离，commits[0].sha 缺失就能让 actions 和 events 整轮都不执行。
  if (useCommitSource) {
    try {
      await checkRepoCommits(repo, branch, types, groups, collect, collected, alias);
    } catch (e) {
      pluginState.log('error', `[${repo}@${branch}] commits 检查失败: ${e}`);
    }
  }

  // ---- 第二步：Actions 走独立接口 ----
  // 必须放在 events 之前：events 那条路有多个提前 return，actions 写在后面会被挡掉
  try {
    await checkRepoActions(repo, types, groups, collect, collected);
  } catch (e) {
    pluginState.log('error', `[${repo}] Actions 检查失败: ${e}`);
  }

  // ---- 第三步：其余类型（issues/pulls）才需要 /events ----
  // actions 走的是独立接口，不需要 /events；原来只排除了 commits，
  // 只订阅 actions 的仓库每轮都白跑一次 /events（还维护一个没用的 events 游标）。
  const needEventTypes = useCommitSource
    ? types.filter(t => t !== 'commits' && t !== 'actions')
    : types.filter(t => t !== 'actions');

  // 只订阅 commits 时，完全不用碰 /events，直接收工
  // （这一条也顺手解决了「游标被 star 事件顶掉」的历史问题）
  if (!needEventTypes.length) {
    return done();
  }

  const events = await fetchEvents(repo);
  if (!events.length) {
    pluginState.debug(`[轮询] ${repo}: 无事件，跳过（commits/actions 已独立处理）`);
    return done();
  }

  const latestId = events[0].id;
  const lastKnown = pluginState.cache[cacheKey];

  pluginState.debug(`[轮询] ${repo}: 最新事件 ID=${latestId}, 缓存 ID=${lastKnown || '无'}`);

  if (!lastKnown) {
    pluginState.cache[cacheKey] = latestId;
    pluginState.saveCache();
    pluginState.log('info', `[${repo}] 首次运行，记录最新事件 ID: ${latestId}，不推送`);
    return done();
  }

  if (lastKnown === latestId) {
    pluginState.debug(`[轮询] ${repo}: events 无更新`);
    return done();
  }

  const lastIdx = events.findIndex(e => e.id === lastKnown);
  // 游标不在当前窗口里（订阅关闭很久、或事件太多被挤出）时，
  // 旧逻辑会取最近 10 条直接推——那是历史事件，会一次性刷屏。
  // 这种情况直接重建基线、不推送。
  if (lastIdx === -1) {
    pluginState.cache[cacheKey] = latestId;
    pluginState.saveCache();
    pluginState.log('warn', `[${repo}] events 游标已失效（不在最近 ${events.length} 条内），重置基线，本轮不推送`);
    return done();
  }
  const newEvents = events.slice(0, lastIdx);

  if (!newEvents.length) {
    pluginState.debug(`[轮询] ${repo}: 新事件列表为空，跳过`);
    return done();
  }

  const eventTypes = [...new Set(newEvents.map(e => e.type))];
  pluginState.log('info', `[${repo}] 发现 ${newEvents.length} 条新事件: ${eventTypes.join(', ')}`);

  // 游标推迟到所有推送都成功之后再写（见函数末尾）。
  // 原来在这里就写 cache 并落盘，任何一条 sendImage 抛错（QQ 掉线、图片超限、
  // 群被解散）都会让这批事件永久丢失 —— 下一轮 lastKnown 已经是 latestId，
  // 直接走「无更新」返回，用户什么也收不到，日志里只有一行 error。

  // 按类型分类
  // commits 若已走快通道，这里就不再重复处理一遍
  // 各类型推送的总体成败：只要有一类在所有群都失败，游标就不推进，下一轮重试
  let okAll = true;
  if (!useCommitSource && types.includes('commits')) {
    const commits = extractCommits(newEvents, branch);
    pluginState.debug(`[轮询] ${repo}: 提取到 ${commits.length} 条 Commit`);
    if (commits.length) {
      await runLimited(commits, MAX_CONCURRENT_REQUESTS, async (c) => {
        try {
          const detail = await fetchCommitDetail(repo, c.sha);
          if (detail?.files) {
            c.files = detail.files.map((f: any) => ({
              filename: f.filename || '', status: f.status || '',
              additions: f.additions || 0, deletions: f.deletions || 0,
              patch: f.patch || undefined,
            }));
          }
          // 用 API 返回的真实 commit message 覆盖 fallback 消息
          if (detail?.commit?.message && c.commit.message.startsWith('Push to ')) {
            c.commit.message = detail.commit.message;
          }
        } catch (e) {
          // 详情只是补充 diff 和真实 message，拿不到就用 fallback 消息照常推，
          // 但要留痕：否则用户看到「Push to xxx」这种占位标题时无从排查
          pluginState.debug(`[轮询] ${repo}: 获取 ${c.sha.slice(0, 7)} 详情失败: ${e}`);
        }
      });
      if (collect) { collected.commits = commits; }
      else {
        pluginState.log('info', `[${repo}] 推送 ${commits.length} 条新 Commit 到 ${groups.length} 个群`);
        const base64 = await renderCommits(repo, commits);
        const fallback = commitsSummary(repo, commits);
        okAll = await pushToGroups(groups, base64, fallback, `[${repo}] Commit`) && okAll;
      }
    }
  }

  if (types.includes('issues')) {
    const issues = extractIssues(newEvents);
    pluginState.debug(`[轮询] ${repo}: 提取到 ${issues.length} 条 Issue`);
    if (issues.length) {
      if (collect) { collected.issues = issues; }
      else {
        pluginState.log('info', `[${repo}] 推送 ${issues.length} 条新 Issue 到 ${groups.length} 个群`);
        const base64 = await renderIssues(repo, issues);
        const fallback = issuesSummary(repo, issues, 'Issues');
        okAll = await pushToGroups(groups, base64, fallback, `[${repo}] Issue`) && okAll;
      }
    }
  }

  if (types.includes('pulls')) {
    const pulls = extractPulls(newEvents);
    pluginState.debug(`[轮询] ${repo}: 提取到 ${pulls.length} 条 PR`);
    if (pulls.length) {
      if (collect) { collected.pulls = pulls; }
      else {
        pluginState.log('info', `[${repo}] 推送 ${pulls.length} 条新 PR 到 ${groups.length} 个群`);
        const base64 = await renderPulls(repo, pulls);
        const fallback = issuesSummary(repo, pulls, 'Pull Requests');
        okAll = await pushToGroups(groups, base64, fallback, `[${repo}] PR`) && okAll;
      }
    }
  }

  const wantIssueComments = types.includes('issues');
  const wantPrComments = types.includes('pulls');
  if (wantIssueComments || wantPrComments) {
    let comments = extractComments(newEvents);
    if (!wantIssueComments) comments = comments.filter(c => c.source === 'pull_request');
    if (!wantPrComments) comments = comments.filter(c => c.source === 'issue');
    pluginState.debug(`[轮询] ${repo}: 提取到 ${comments.length} 条评论`);
    if (comments.length) {
      if (collect) { collected.comments = comments; }
      else {
        pluginState.log('info', `[${repo}] 推送 ${comments.length} 条新评论到 ${groups.length} 个群`);
        const base64 = await renderComments(repo, comments);
        const fallback = commentsSummary(repo, comments);
        okAll = await pushToGroups(groups, base64, fallback, `[${repo}] 评论`) && okAll;
      }
    }
  }

  // Actions 已在第二步（checkRepoActions）独立处理，这里不再重复
  // 游标最后写：只有所有类型都至少有一个群推送成功才推进，
  // 否则保留旧游标，下一轮重试同一批事件（宁可重复，不可丢）
  if (okAll) {
    pluginState.cache[cacheKey] = latestId;
    pluginState.saveCache();
  } else {
    pluginState.log('warn', `[${repo}] 本轮有类型在所有群都推送失败，游标保持在 ${String(latestId).slice(0, 10)}，下一轮重试`);
  }
  return done();
}

/** 从用户事件中提取活动摘要 */
export function extractUserActivity (events: GitHubEvent[], username: string): UserActivityItem[] {
  const items: UserActivityItem[] = [];
  // 与 extractCommits 对齐：/events 偶尔返回非数组或含 null 元素，
  // payload 缺失时 ev.payload.commits 等裸访问会抛 TypeError
  if (!Array.isArray(events)) return items;
  for (const raw of events) {
    const ev = raw as GitHubEvent;
    if (!ev || !ev.type) continue;
    const payload = (ev.payload || {}) as Record<string, any>;
    const repo = payload.repo?.name || (ev as any).repo?.name || '';
    let desc = '';
    switch (ev.type) {
      case 'PushEvent': {
        const commits = Array.isArray(payload.commits) ? payload.commits : [];
        const count = payload.size || payload.distinct_size || commits.length || 1;
        const msg = String(commits[0]?.message || '').split('\n')[0];
        desc = `推送 ${count} 个 commit` + (msg ? `: ${msg}` : '');
        break;
      }
      case 'CreateEvent':
        desc = `创建 ${payload.ref_type || 'repository'}` + (payload.ref ? ` ${payload.ref}` : '');
        break;
      case 'DeleteEvent':
        desc = `删除 ${payload.ref_type || ''} ${payload.ref || ''}`;
        break;
      case 'IssuesEvent': {
        const issue = payload.issue as any;
        desc = `${payload.action || ''} Issue #${issue?.number || ''}: ${issue?.title || ''}`;
        break;
      }
      case 'IssueCommentEvent': {
        const issue = payload.issue as any;
        const body = String(payload.comment?.body || '');
        desc = `评论 #${issue?.number || ''}: ${body.replace(/\n/g, ' ')}`;
        break;
      }
      case 'PullRequestEvent': {
        const pr = payload.pull_request as any;
        desc = `${payload.action || ''} PR #${pr?.number || ''}: ${pr?.title || ''}`;
        break;
      }
      case 'PullRequestReviewEvent': {
        const pr = payload.pull_request as any;
        desc = `Review PR #${pr?.number || ''}: ${pr?.title || ''}`;
        break;
      }
      case 'PullRequestReviewCommentEvent': {
        const pr = payload.pull_request as any;
        const body = String(payload.comment?.body || '');
        desc = `评论 PR #${pr?.number || ''}: ${body.replace(/\n/g, ' ')}`;
        break;
      }
      case 'WatchEvent':
        desc = `Star 了仓库`;
        break;
      case 'ForkEvent':
        desc = `Fork 了仓库`;
        break;
      case 'ReleaseEvent': {
        const rel = payload.release as any;
        desc = `${payload.action || ''} Release ${rel?.tag_name || ''}`;
        break;
      }
      default:
        desc = String(ev.type).replace('Event', '');
    }
    items.push({ type: ev.type, repo, desc, time: ev.created_at, url: '' });
  }
  return items;
}

/**
 * 本轮已经检查过 Actions 的仓库集合。
 *
 * Actions 是仓库级数据（游标 `${repo}:actions`），推送群却是订阅级的。
 * 同一仓库订阅多个分支时，poll() 会并发跑多个 checkRepo 进到 checkRepoActions，
 * 先返回的读旧游标推完并推进，后返回的走「无更新」直接返回 ——
 * 只有一个分支的群能收到 Actions。用这个集合保证每仓库每轮只查一次。
 */
const actionsCheckedThisRound = new Set<string>();
/** 本轮 Actions 检查结果，供同仓库其它分支订阅复用（避免重复请求与重复推送） */
const actionsRoundCache = new Map<string, ActionRunData[]>();

/**
 * 清空「本轮已检查 Actions」的去重状态。
 *
 * 正常运行时 poll() 每轮开头会自己清；这个导出只为测试服务 ——
 * 测试在同一个进程里连续调用 checkRepoActions 模拟多轮轮询，
 * 不重置的话第二次起会命中「本轮已检查过」直接返回。
 */
export function resetActionsRoundGuard (): void {
  actionsCheckedThisRound.clear();
  actionsRoundCache.clear();
}

/** 检查单个用户的活动 */
/** 已推送的用户事件 ID 集合（防止重复推送） */
const sentUserEventIds = new Map<string, Set<string>>();

export async function checkUser (username: string, groups: string[], collect?: boolean): Promise<UserCollected | null> {
  // 统一小写：与 api.ts /user/delete 的清理 key 对齐
  const cacheKey = `user:${username.toLowerCase()}`;
  pluginState.debug(`[轮询] 检查用户: ${username}`);

  const events = await fetchUserEvents(username);
  if (!events.length) {
    pluginState.debug(`[轮询] ${username}: 无事件`);
    return null;
  }

  const latestId = events[0].id;
  const lastKnown = pluginState.cache[cacheKey];
  // 已推送集合统一用小写 key：游标用的是 username.toLowerCase()，
  // 这里用原始大小写的话，用户删掉再以不同大小写加回来时旧集合残留且永远不命中。
  const sentKey = username.toLowerCase();
  const sentSet = (): Set<string> => {
    let s = sentUserEventIds.get(sentKey);
    if (!s) { s = new Set<string>(); sentUserEventIds.set(sentKey, s); }
    return s;
  };

  if (!lastKnown) {
    pluginState.cache[cacheKey] = latestId;
    pluginState.saveCache();
    const sent = sentSet();
    for (const e of events) sent.add(e.id);
    pluginState.log('info', `[${username}] 用户监控首次运行，记录最新事件 ID: ${latestId}`);
    return null;
  }

  if (lastKnown === latestId) {
    pluginState.debug(`[轮询] ${username}: 无更新`);
    return null;
  }

  const lastIdx = events.findIndex(e => e.id === lastKnown);
  let newEvents: GitHubEvent[];
  if (lastIdx > 0) {
    newEvents = events.slice(0, lastIdx);
  } else if (lastIdx === -1) {
    // 游标已滚出窗口，用数值比较挑出比它新的事件。
    // lastKnown 若不是纯数字（旧版本遗留或手改过），BigInt 会抛错，
    // 这时直接重置基线，不要连带把整个用户监控搞崩。
    let lastNum: bigint | null = null;
    try { lastNum = BigInt(lastKnown); } catch { lastNum = null; }

    if (lastNum === null) {
      pluginState.cache[cacheKey] = latestId;
      pluginState.saveCache();
      pluginState.log('warn', `[${username}] 游标值不合法 (${lastKnown})，已重置基线，本轮不推送`);
      return null;
    }
    newEvents = events.filter(e => {
      try { return BigInt(e.id) > lastNum!; } catch { return false; }
    });
    if (newEvents.length > 5) newEvents = newEvents.slice(0, 5);
  } else {
    return null;
  }

  // 即使这一轮没挑出新事件，游标也要推到最新：
  // 否则下一轮会重复同样的 fetchUserEvents + 过滤，永远不会自愈。
  pluginState.cache[cacheKey] = latestId;
  pluginState.saveCache();

  if (!newEvents.length) {
    pluginState.debug(`[轮询] ${username}: 无新事件，游标已推进`);
    return null;
  }

  const sent = sentSet();
  newEvents = newEvents.filter(e => !sent.has(e.id));

  if (!newEvents.length) {
    pluginState.debug(`[轮询] ${username}: 新事件已推送过，跳过`);
    return null;
  }

  // 已推送集合必须在**推送成功之后**才标记。
  // 原来在渲染/发送之前就 `for (const e of newEvents) sent.add(e.id)`，
  // 一旦 QQ 掉线或图片超限，这批事件就被记成「已推送」，永远不会再试。
  const markSent = (): void => {
    for (const e of newEvents) sent.add(e.id);
    if (sent.size > 100) {
      const arr = Array.from(sent);
      sentUserEventIds.set(sentKey, new Set(arr.slice(arr.length - 100)));
    }
  };

  const items = extractUserActivity(newEvents, username);
  if (!items.length) {
    // 没提取出可展示内容，事件本身也不算「推送过」，但游标已推进，
    // 下一轮不会再取到它们 —— 标记掉避免集合无界增长
    markSent();
    return null;
  }

  if (collect) {
    return { username, groups, items };
  }

  pluginState.log('info', `[${username}] 推送 ${items.length} 条用户动态到 ${groups.length} 个群`);
  const base64 = await renderUserActivity(username, items);
  const fallback = userActivitySummary(username, items);
  let okCount = 0;
  let failCount = 0;
  for (const gid of groups) {
    try {
      await sendImage(gid, base64, fallback);
      okCount++;
    } catch (e) {
      failCount++;
      pluginState.log('warn', `[${username}] 推送到群 ${gid} 失败: ${e}`);
    }
  }
  if (okCount > 0 || groups.length === 0) {
    markSent();
  } else {
    pluginState.log('warn', `[${username}] 全部 ${failCount} 个群推送失败，已推送集合不推进，下一轮重试`);
  }
  return null;
}

/** 清理某个用户的已推送集合（删除用户监控时调用，避免 Map 无界增长） */
export function dropUserSentEvents (username: string): void {
  sentUserEventIds.delete(String(username || '').toLowerCase());
}

/**
 * 防止并发轮询。
 *
 * 原来只有一个布尔量，且没有任何超时兜底：poll() 里唯一可能永不 settle 的
 * await 是 sendImage → sendGroupMsg → actions.call('send_group_msg')，
 * QQ 掉线 / 适配器不响应时这个 Promise 可能永远不 resolve，polling 就永远是 true，
 * 之后每一轮 tick 都在入口直接返回 —— 轮询彻底停摆，且 debug 关闭时连日志都没有。
 * stopPoller() 也不复位它，所以 WebUI 点「保存配置」都救不回来，只能重载插件。
 */
let polling = false;
let pollStartedAt = 0;

/**
 * 每一轮的序号。
 *
 * 看门狗会在「上一轮卡死」时把 polling 强制置回 false 并让新一轮进来，
 * 但卡死的那一轮并没有真的结束——它只是某个 await 不返回。等它终于返回时，
 * `finally { polling = false; }` 会把**新一轮**的在途标记清掉，
 * 于是第三轮又能进来，又变成两条链并行。
 * 所以 finally 里必须确认「我还是当前那一轮」才允许清标记。
 */
let pollSeq = 0;

/** 单轮轮询的最长容忍时间（毫秒），超过就认为卡死，允许下一轮进入 */
function pollWatchdogMs (): number {
  const raw = Number(pluginState.config.interval);
  const sec = Number.isFinite(raw) ? Math.min(Math.max(raw, 5), MAX_INTERVAL_SEC) : 60;
  return Math.max(sec * 2, 120) * 1000;
}

/** 供 stopPoller 调用：强制清掉在途标记，避免停摆后新链进不来 */
export function resetPollingFlag (): void {
  polling = false;
  pollStartedAt = 0;
  // 让所有在途轮次的 finally 都认不出自己，不再去清新一轮的标记
  pollSeq++;
}

/**
 * 简单的并发闸门。
 *
 * 原来 poll() 对全部订阅无节流并发，checkRepoCommits 又对窗口内每条新提交
 * 再并发一次 fetchCommitDetail —— 20 条提交 × 30 个仓库就是 600 个并发请求，
 * GitHub 的 secondary rate limit（abuse detection）会直接 403，
 * 表现为「这一轮所有仓库都没推送，日志里只有一堆 403」。
 */
const MAX_CONCURRENT_REQUESTS = 6;

async function runLimited<T> (items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

/**
 * 执行一次完整轮询。
 *
 * `gen` 是调用方的轮询代数。代数机制只拦「续命/排下一轮」，拦不住已经进
 * await 的这一轮：用户删掉订阅后，旧轮次仍会按旧配置把消息推到已删除的群。
 * 所以在每个仓库/用户开始处理前校验一次代数，失效就中止。
 */
export async function poll (gen?: number): Promise<void> {
  const stale = (): boolean => gen !== undefined && gen !== pollGeneration;
  if (polling) {
    if (pollStartedAt && Date.now() - pollStartedAt > pollWatchdogMs()) {
      pluginState.log('warn', `[定时] 上一轮轮询已运行 ${Math.round((Date.now() - pollStartedAt) / 1000)} 秒仍未结束，判定卡死并强制复位`);
      polling = false;
    } else {
      pluginState.debug('[定时] 上一次轮询尚未完成，跳过');
      return;
    }
  }
  polling = true;
  pollStartedAt = Date.now();
  // 认领本轮序号：finally 里只有序号还是自己时才允许清在途标记，
  // 否则「卡死被看门狗放行」的那一轮结束时会清掉新一轮的标记。
  const mySeq = ++pollSeq;
  // 每轮重置「已检查 Actions 的仓库」集合（见 actionsCheckedThisRound 注释）
  actionsCheckedThisRound.clear();
  actionsRoundCache.clear();
  try {
    // 过滤必须校验 Array.isArray：配置被手改成 groups: "123456789" 时，
    // s.groups.length 会按字符长度通过过滤，后面 `for (const gid of groups)`
    // 就会逐字符推送到「1」「1」「0」「4」…… 一堆不存在的群号。
    const activeSubs = pluginState.config.subscriptions.filter(
      s => s.enabled && Array.isArray(s.groups) && s.groups.length && Array.isArray(s.types) && s.types.length,
    );
    const activeUsers = (pluginState.config.userSubscriptions || []).filter(
      u => u.enabled && Array.isArray(u.groups) && u.groups.length,
    );
    const merge = pluginState.config.mergeNotify;
    pluginState.debug(`[定时] 开始轮询，共 ${activeSubs.length} 个仓库订阅，${activeUsers.length} 个用户监控，合并模式: ${merge}`);
    const start = Date.now();

    // 并发收集仓库数据（带并发上限，避免触发 GitHub 二级限流）
    const repoResults: RepoCollected[] = [];
    const repoSlots: (RepoCollected | null)[] = new Array(activeSubs.length).fill(null);
    await runLimited(activeSubs, MAX_CONCURRENT_REQUESTS, async (sub) => {
      if (stale()) return;
      try {
        const result = await checkRepo(sub.repo, sub.branch, sub.types, sub.groups, merge, sub.alias);
        if (merge && result) repoSlots[activeSubs.indexOf(sub)] = result;
      } catch (e) {
        pluginState.log('error', `轮询 ${sub.repo} 失败: ${e}`);
      }
    });
    for (const r of repoSlots) { if (r) repoResults.push(r); }

    // 并发收集用户数据
    const userResults: UserCollected[] = [];
    const userSlots: (UserCollected | null)[] = new Array(activeUsers.length).fill(null);
    await runLimited(activeUsers, MAX_CONCURRENT_REQUESTS, async (userSub) => {
      if (stale()) return;
      try {
        const result = await checkUser(userSub.username, userSub.groups, merge);
        if (merge && result) userSlots[activeUsers.indexOf(userSub)] = result;
      } catch (e) {
        pluginState.log('error', `轮询用户 ${userSub.username} 失败: ${e}`);
      }
    });
    for (const u of userSlots) { if (u) userResults.push(u); }

    // 合并模式：按群分组，合并渲染
    if (merge) {
      // 仓库合并推送
      if (repoResults.length) {
        // 按群分组：每个群收到的仓库更新可能不同
        const groupRepoMap = new Map<string, RepoCollected[]>();
        for (const r of repoResults) {
          for (const gid of r.groups) {
            if (!groupRepoMap.has(gid)) groupRepoMap.set(gid, []);
            groupRepoMap.get(gid)!.push(r);
          }
        }
        for (const [gid, repos] of groupRepoMap) {
          pluginState.log('info', `[合并推送] 仓库更新 ${repos.length} 个仓库 → 群 ${gid}`);
          // 单个群推送失败不能中断后面的群：原来这里是裸 await sendImage，
          // 一个群解散/被禁言，同轮其它群全都收不到合并卡片。
          try {
            const base64 = await renderMergedRepo(repos);
            const fallback = mergedRepoSummary(repos);
            await sendImage(gid, base64, fallback);
          } catch (e) {
            pluginState.log('warn', `[合并推送] 推送到群 ${gid} 失败: ${e}`);
            continue;
          }

          // 合并模式下，每个仓库各生成一条摘要（放后台，别拖住这一轮）
          for (const r of repos) {
            if (!r.commits?.length) continue;
            // 直接用该仓库收集时带过来的别名。
            // 原来用 subscriptions.find(s => s.repo === r.repo && ...) 反查，
            // 同一仓库订阅多个分支（如 owner/repo@main / owner/repo@dev）时
            // find 只命中第一条，摘要标题里的别名会张冠李戴。
            scheduleCommitSummary([gid], r.repo, r.commits, r.alias);
          }
        }
      }

      // 用户合并推送
      if (userResults.length) {
        const groupUserMap = new Map<string, UserCollected[]>();
        for (const u of userResults) {
          for (const gid of u.groups) {
            if (!groupUserMap.has(gid)) groupUserMap.set(gid, []);
            groupUserMap.get(gid)!.push(u);
          }
        }
        for (const [gid, users] of groupUserMap) {
          pluginState.log('info', `[合并推送] 用户动态 ${users.length} 个用户 → 群 ${gid}`);
          try {
            const base64 = await renderMergedUsers(users);
            const fallback = mergedUsersSummary(users);
            await sendImage(gid, base64, fallback);
          } catch (e) {
            pluginState.log('warn', `[合并推送] 用户动态推送到群 ${gid} 失败: ${e}`);
          }
        }
      }
    }

    const ms = Date.now() - start;
    pluginState.debug(`[定时] 轮询完成，耗时 ${ms}ms`);
  } finally {
    // 只有本轮仍是「当前轮」才清标记：被看门狗强制放行后，
    // 卡死的旧轮次会晚一步返回，它不能把新一轮的在途标记清掉。
    if (mySeq === pollSeq) polling = false;
  }
}

let startupTimer: ReturnType<typeof setTimeout> | null = null;
let chainTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 轮询「代数」。
 *
 * tick 是递归闭包，每轮结束都会给自己排下一轮。问题在于 tick 里有 await poll()：
 * 如果这段时间内有人 stopPoller() + startPoller()（比如改了配置），
 * 旧的那条链跑完 await 后仍会照常续命，于是新旧两条链并行——
 * 请求量翻倍、同一批提交被推两次。
 *
 * 每次 startPoller() 让代数 +1 并捕获自己的代数，tick 在每个可能被中断的位置
 * 校验代数是否还是自己那一代，不是就直接 return（这条链作废）。
 */
let pollGeneration = 0;

/** setTimeout 的最大安全延迟（Node 上限 2147483647ms），超过会退化成 1ms 紧循环 */
const MAX_INTERVAL_SEC = 86400;

/**
 * 启动轮询（链式调度）
 *
 * 不再用 setInterval —— 它有个坑：如果某一轮跑超过间隔（比如补 commit 详情、
 * 渲染图片慢、或者下游接口卡住），后续几轮会被直接跳过，用户侧就表现为
 * 「一段时间一条消息都没有」。这里改成「本轮跑完再排下一轮」，
 * 超时也不会丢轮次，只是下一轮立刻开始。
 */
export function startPoller (): void {
  // interval 可能被手改配置成 "abc" / Infinity。
  // 原来的 `pluginState.config.interval || 60` 对 "abc" 是真值，Math.max("abc", 5) 得 NaN，
  // Math.min(NaN, 86400) 仍是 NaN，setTimeout(fn, NaN) 等价 0ms —— 变成不间断热循环打 GitHub，
  // 几分钟就能把配额打光并触发封禁。
  const rawInterval = Number(pluginState.config.interval);
  const sec = Number.isFinite(rawInterval)
    ? Math.min(Math.max(Math.floor(rawInterval), 5), MAX_INTERVAL_SEC)
    : 60;
  const userCount = (pluginState.config.userSubscriptions || []).length;
  const source = pluginState.config.commitSource ?? 'commits';
  pluginState.log('info', `轮询已启动，间隔 ${sec} 秒（自适应调度），共 ${pluginState.config.subscriptions.length} 个仓库订阅，${userCount} 个用户监控；commits 源=${source}`);

  stopPollingTimers();

  const myGeneration = ++pollGeneration;

  const tick = async (): Promise<void> => {
    // 进 tick 先校验：如果这条链已经被 stop/restart 作废，直接退出
    if (myGeneration !== pollGeneration) return;

    const startedAt = Date.now();
    try {
      // 把代数传进去：在途的这一轮也要能被 stopPoller 中止，
      // 否则删掉订阅后旧轮次仍会按旧配置推送到已删除的群
      await poll(myGeneration);
    } catch (e) {
      pluginState.log('error', `[定时] 轮询异常: ${e}`);
    }

    // await 期间可能被 stopPoller() + startPoller() 打断，这里必须再校验一次，
    // 否则旧链会继续 setTimeout，和新链并行
    if (myGeneration !== pollGeneration) return;

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(sec * 1000 - elapsed, 1000);
    if (elapsed > sec * 1000) {
      pluginState.log('warn', `[定时] 本轮耗时 ${elapsed}ms 超过轮询间隔 ${sec}s，立即进入下一轮`);
    }

    chainTimer = setTimeout(() => {
      chainTimer = null;
      void tick();
    }, waitMs);
    pluginState.setPollTimer(chainTimer);
  };

  // 启动后 2 秒跑首轮，避免和插件初始化抢时间
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (myGeneration !== pollGeneration) return;
    void tick();
  }, 2000);
}

/** 内部用：清掉所有轮询定时器 */
function stopPollingTimers (): void {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (chainTimer) { clearTimeout(chainTimer); chainTimer = null; }
  pluginState.clearPollTimer();
}

/** 停止轮询 */
export function stopPoller (): void {
  // 代数 +1：让所有在途的旧 tick 链在下一个校验点自行作废
  pollGeneration++;
  stopPollingTimers();
  // 在途的 poll() 如果卡在 sendGroupMsg 上，polling 会一直是 true，
  // 新链首轮会被入口的互斥判断挡掉，表现为「改了配置要等一整个间隔才生效」。
  resetPollingFlag();
  pluginState.log('info', '轮询已停止');
}
