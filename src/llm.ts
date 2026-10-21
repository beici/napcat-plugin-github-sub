// AI 更新摘要（LLM）
// 调 OpenAI 兼容的 /chat/completions 接口，把一批提交压成一段中文说明。
import type { CommitData } from './types';
import { pluginState } from './state';

/** 默认系统提示词 */
const DEFAULT_PROMPT = [
  '你是一个代码变更分析助手。根据给定的 git 提交信息和代码差异，用中文写一段简明的更新摘要。',
  '要求：',
  '1. 字数控制在 80-150 字；',
  '2. 说清这次改动做了什么、影响哪些功能模块；',
  '3. 不要罗列文件路径，不要复述提交信息原文；',
  '4. 直接输出摘要正文，不要加任何前缀、标题或 Markdown 记号。',
].join('\n');

/** 把提交列表整理成喂给模型的上下文，按 maxDiffChars 控制体积 */
function buildCommitContext (repo: string, commits: CommitData[]): string {
  const cfg = pluginState.config.llm;
  const maxDiff = cfg?.maxDiffChars ?? 6000;

  const parts: string[] = [`仓库: ${repo}`, `本次新增 ${commits.length} 个提交:`, ''];
  let diffBudget = maxDiff;

  for (const c of commits.slice(0, 10)) {
    const msg = String(c.commit?.message || '').trim();
    parts.push(`--- 提交 ${String(c.sha || '').slice(0, 7)} | 作者 ${c.commit?.author?.name || 'unknown'} ---`);
    parts.push(`提交说明: ${msg}`);

    const files = Array.isArray(c.files) ? c.files : [];
    if (files.length) {
      const fileList = files
        .slice(0, 20)
        .map(f => `${f.status || 'modified'} ${f.filename} (+${f.additions || 0}/-${f.deletions || 0})`);
      parts.push(`变更文件(${files.length}): ${fileList.join('; ')}`);

      if (diffBudget > 0) {
        const chunks: string[] = [];
        for (const f of files) {
          if (!f.patch || diffBudget <= 0) continue;
          const piece = f.patch.slice(0, Math.min(diffBudget, 1200));
          chunks.push(`[${f.filename}]\n${piece}`);
          diffBudget -= piece.length;
        }
        if (chunks.length) parts.push(`关键改动:\n${chunks.join('\n')}`);
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * 生成一段更新摘要。失败或未启用时返回空串，调用方据此跳过推送。
 * 注意：这里不抛异常——摘要只是锦上添花，不该让轮询崩掉。
 */
export async function summarizeCommits (repo: string, commits: CommitData[]): Promise<string> {
  const cfg = pluginState.config.llm;
  if (!cfg?.enabled || !cfg.apiKey) return '';

  const base = (cfg.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const systemPrompt = cfg.prompt?.trim() || DEFAULT_PROMPT;
  let userPrompt = '';
  try {
    userPrompt = buildCommitContext(repo, commits);
  } catch (e) {
    pluginState.log('warn', `[LLM] 构建上下文失败: ${(e as Error).message}`);
    return '';
  }
  if (!userPrompt) return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout || 15000);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: cfg.temperature ?? 0.3,
        max_tokens: cfg.maxTokens || 400,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      pluginState.log('warn', `[LLM 摘要] 请求失败: HTTP ${res.status}`);
      return '';
    }

    const data = await res.json() as { choices?: { message?: { content?: string; }; }[]; };
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    if (!text) return '';

    // 模型偶尔会无视提示词，把摘要套上「以下是摘要：」之类的壳，或者用
    // Markdown 标题包起来。推送时我们自己会加标题，这里统一剥掉，
    // 否则群里会看到「本次更新摘要（x）」下面又跟一个「## 更新摘要」。
    //
    // 前缀词用 `[\u4e00-\u9fa5]{0,8}` 兜住「以下是摘要」这种组合：
    // 原来的交替写法 `(?:以下是|摘要)` 要求前缀**整体**等于其中之一，
    // 「以下是摘要：」两段都有，反而一条都不匹配，原样漏到群里。
    const cleaned = text
      .replace(/^\s*#{1,6}\s*.*?\n+/, '')
      .replace(/^\s*(?:以下是|下面是|这是|本次|此次)?[\u4e00-\u9fa5]{0,6}?(?:更新)?摘要\s*[:：]\s*/i, '')
      .replace(/^\s*(?:以下是|下面是|这是)\s*[:：]\s*/i, '')
      .trim();
    if (!cleaned) return text;

    pluginState.debug(`[LLM 摘要] ${repo} 生成成功，长度 ${cleaned.length}`);
    return cleaned;
  } catch (e) {
    const reason = (e as { name?: string; })?.name === 'AbortError' ? '请求超时' : e;
    pluginState.log('warn', `[LLM 摘要] 生成失败: ${reason}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 摘要推送时的标题。
 *
 * 有别名就用别名，没有就退回 owner/repo。加 repo 是为了同一个别名
 * 挂在多个仓库上时还能分清是哪一个。
 */
export function buildSummaryTitle (repo: string, alias?: string): string {
  const name = alias?.trim() || repo;
  if (alias?.trim() && alias.trim() !== repo) {
    return `本次更新摘要（${name} · ${repo}）`;
  }
  return `本次更新摘要（${repo}）`;
}

/** 生成摘要并推送到群 */
export async function pushCommitSummary (groups: string[], repo: string, commits: CommitData[], alias?: string): Promise<void> {
  if (!commits?.length) return;
  // 没有推送目标时先返回：否则会白花一次 LLM 请求（有 token 成本），
  // 生成完才发现没群可发。
  if (!groups?.length) return;

  const summary = await summarizeCommits(repo, commits);
  if (!summary) return;

  const text = `${buildSummaryTitle(repo, alias)}\n\n${summary}`;
  for (const gid of groups) {
    try {
      await pluginState.sendGroupMsg(gid, [{ type: 'text', data: { text } }]);
    } catch (e) {
      pluginState.log('warn', `[LLM 摘要] 发送到群 ${gid} 失败: ${e}`);
    }
  }
}

/** 正在后台跑的摘要任务，便于清理时等待 */
const pendingSummaries = new Set<Promise<void>>();

/**
 * 同时在跑的摘要任务上限。
 *
 * LLM 请求的 timeout 是分钟级的，而轮询是 60 秒一轮。原来不限并发，
 * 只要每轮都有新提交、模型又慢，任务就会不断堆积：并发请求越来越多、
 * token 消耗按倍增长，还容易被上游限流。限制成 2 个之后，
 * 超出的直接跳过（摘要本来就是锦上添花，丢一次无所谓）。
 */
const MAX_CONCURRENT_SUMMARIES = 2;

/**
 * 把摘要丢到后台跑，不阻塞轮询。
 *
 * 之前是直接 await 的，模型一慢就把整轮轮询拖住，后面几轮还会因为
 * polling 标志被跳过，表现就是"一段时间一条推送都没有"。
 */
export function scheduleCommitSummary (groups: string[], repo: string, commits: CommitData[], alias?: string): void {
  if (!commits?.length) return;
  if (!groups?.length) return;
  if (!pluginState.config.llm?.enabled) return;

  if (pendingSummaries.size >= MAX_CONCURRENT_SUMMARIES) {
    pluginState.debug(`[LLM 摘要] 并发已达上限 ${MAX_CONCURRENT_SUMMARIES}，跳过 ${repo} 本次摘要`);
    return;
  }

  const task = pushCommitSummary(groups, repo, commits, alias)
    .catch((e) => { pluginState.log('warn', `[LLM 摘要] 后台任务失败: ${e}`); })
    .finally(() => { pendingSummaries.delete(task); });

  pendingSummaries.add(task);
}

/** 等待所有在跑的摘要任务结束（卸载时调用，避免日志写到已关闭的 logger） */
export async function flushSummaries (): Promise<void> {
  if (!pendingSummaries.size) return;
  // 必须带超时：LLM 请求的 timeout 上限是 120 秒，卸载时如果正好在跑，
  // 没有上限的 await 会让 plugin_cleanup 挂住（NapCat 重载插件时卡住整个进程）。
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000);
    // unref 让这个定时器不阻止进程退出
    if (typeof (t as { unref?: () => void; }).unref === 'function') (t as { unref: () => void; }).unref();
  });
  await Promise.race([Promise.allSettled([...pendingSummaries]).then(() => undefined), timeout]);
}
