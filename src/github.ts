// GitHub API 请求模块
// commits 走 /commits（数据新鲜、有序）；issues/pulls 走 /events（一次拿全）
import type { GitHubEvent, GitHubCommitItem, RepoInfo } from './types';
import { pluginState } from './state';

/** 轮询计数器，用于多 token 轮转 */
let tokenIndex = 0;

/** 304 未修改的哨兵值，用于区分「没变化」和「请求失败」 */
export const NOT_MODIFIED = Symbol('NOT_MODIFIED');
export type NotModified = typeof NOT_MODIFIED;

/**
 * 把用户随手粘贴的各种写法，统一成 GitHub API 要的 `owner/repo`。
 *
 * 实际收到的输入五花八门，直接拼进 URL 就会 404：
 *   https://github.com/owner/repo          ← 最常见，直接复制地址栏
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/main
 *   git@github.com:owner/repo.git
 *   github.com/owner/repo
 *   owner/repo （带空格、末尾斜杠、大写）
 *
 * 返回 null 表示认不出来，调用方据此给出明确提示，而不是让它悄悄 404。
 *
 * 注意：结果统一转小写。GitHub 的 API 路径对大小写不敏感，但缓存 key 是
 * 按字符串拼的——不统一大小写的话，同一个仓库会因为写法不同产生两套游标，
 * 表现为「明明订阅了却重复记录基线」。
 */
export function normalizeRepo (input: string): string | null {
  if (!input) return null;
  let s = String(input).trim();

  // 去掉可能被复制进来的引号/尖括号
  s = s.replace(/^[<'"`]+|[>'"`]+$/g, '').trim();

  // git@github.com:owner/repo.git → owner/repo
  s = s.replace(/^git@github\.com[:/]/i, '');

  // 去掉协议头（也覆盖 //github.com/... 这种协议相对写法）
  s = s.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i, '');
  s = s.replace(/^git@/i, '');

  // 带点的主机名只接受 github.com，其余域名（gitlab.com 等）直接判无效，
  // 否则会被当成 owner 去查，结果 404，很难看出是哪一步错了。
  //
  // 但不能「含点就判域名」：GitHub 允许 owner 带点号（如 john.doe/myrepo），
  // 那样会把合法仓库名误杀成「无法识别仓库名」。所以这里额外要求
  // ① 首段看起来像主机名（以常见 TLD 结尾）且 ② 后面还剩至少两段路径。
  const HOST_TLD_RE = /\.(?:com|org|net|io|dev|me|cn|co|app|xyz|top|info|site|cloud|tech|cc|tv)$/i;
  const hostMatch = s.match(/^(?:www\.)?([^/:]+)[/:]/);
  if (hostMatch) {
    const first = hostMatch[1];
    const restCount = s.slice(first.length).split('/').filter(p => p !== '').length;
    if (first.includes('.') && HOST_TLD_RE.test(first) && restCount >= 2 && first.toLowerCase() !== 'github.com') {
      return null;
    }
  }
  s = s.replace(/^(?:www\.)?github\.com[/:]?/i, '');

  // 去掉 ?query 和 #hash，以及可能残留的前导斜杠
  s = s.split(/[?#]/)[0];
  s = s.replace(/^\/+/, '');

  const parts = s.split('/').filter(p => p !== '');
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');

  // GitHub 命名只含字母数字和 - _ .
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) return null;
  // 纯点号（"." / ".."）能通过上面的字符集，但它会被 URL 规范化成上级路径，
  // 拼出来是 /repos/owner/../etc —— 请求打到别的接口上，不是简单的 404。
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;

  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * 获取当前可用的 token（多 token 轮转）。
 *
 * 注意：这个函数**会**推进 tokenIndex，所以每个请求只能调用一次。
 * 原来 fetchJSON 里调了两次（一次给 debug 日志、一次给 fetch），
 * 而 debug 的参数在调用前就求值（即使 debug 关闭也照样执行），
 * 结果每次请求消耗两个下标 —— token 数为偶数时只有一半 token 真正参与请求
 * （N=2 时请求恒用 tokens[1]，tokens[0] 只出现在日志里），
 * 用户配了 4 个 token 却只有 2 个的配额，403 会提前出现。
 */
function getActiveToken (): string {
  // 合并 tokens 数组和旧的单 token 字段
  const all = [...(pluginState.config.tokens || [])];
  if (pluginState.config.token && !all.includes(pluginState.config.token)) all.push(pluginState.config.token);
  const valid = all.filter(t => t.trim());
  if (!valid.length) return '';
  const t = valid[tokenIndex % valid.length];
  tokenIndex++;
  return t;
}

/** 构造请求头。每次调用都会消耗一个 token 轮转位，因此每个请求只调一次。 */
function getHeaders (): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'napcat-plugin-github-sub',
    'Accept': 'application/vnd.github+json',
  };
  const token = getActiveToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/** 日志用的请求头副本：把所有凭据掩码，且**不**消耗 token 轮转位。 */
function describeHeaders (headers: Record<string, string>): string {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    masked[k] = k.toLowerCase() === 'authorization' ? 'Bearer ***' : v;
  }
  return JSON.stringify(masked);
}

/** 单次 API 请求超时（毫秒）。GitHub 偶尔会挂起不响应，没有超时会把轮询永久卡住。 */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * 统一的对外请求选项。
 *
 * `redirect: 'manual'` 是必须的：apiBase 可以被配置成任意域名，
 * 一个「校验时是公网域名、实际 302 到 http://127.0.0.1:6099」的地址
 * 就能让服务端去打内网（checkExternalUrl 只校验第一跳）。
 * GitHub 的 API 本身不做重定向，所以禁止跟随没有副作用。
 */
const FETCH_OPTS: RequestInit = { redirect: 'manual' };

/**
 * 最近一次请求失败的原因。
 *
 * `fetchJSON` 出错时统一返回 null，调用方无法区分「仓库不存在 / Token 无权限 /
 * 网络不通」和「接口正常但没有数据」。WebUI 的「获取分支」原来就把这些情况
 * 全报成「可能是空仓库」，用户按提示去查空仓库永远查不出问题。
 * 这里把最近一次失败原因记下来，供 API 层生成准确的提示。
 */
let lastFetchError: string | null = null;

/** 取最近一次请求失败原因（成功请求会把它清空） */
export function getLastFetchError (): string | null {
  return lastFetchError;
}

async function fetchJSON<T> (url: string): Promise<T | null> {
  const start = Date.now();
  lastFetchError = null;
  try {
    pluginState.debug(`[HTTP] GET ${url}`);
    // headers 只构造一次：getHeaders() 内部会推进 token 轮转下标，
    // 多调一次就会跳过一半 token（见 getActiveToken 的注释）。
    const headers = getHeaders();
    pluginState.debug(`[HTTP] Headers: ${describeHeaders(headers)}`);
    const res = await fetch(url, { ...FETCH_OPTS, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const ms = Date.now() - start;

    pluginState.debug(`[HTTP] 响应: ${res.status} ${res.statusText} (${ms}ms)`);

    if (!res.ok) {
      let msg = `状态码: ${res.status} ${res.statusText || ''}`;
      switch (res.status) {
        case 301: case 302: case 303: case 307: case 308:
          msg = `API 地址返回重定向 (${res.status})，已拒绝跟随。请检查 API 地址是否填错`; break;
        case 401: msg = '访问令牌无效或已过期 (code: 401)'; break;
        case 403: msg = '请求达到 API 速率限制或无权限，请尝试填写 token 或降低请求频率后重试 (code: 403)'; break;
        case 404: msg = '未找到仓库 (code: 404)'; break;
        case 500: msg = '服务器错误 (code: 500)'; break;
      }
      lastFetchError = msg;
      pluginState.log('warn', `请求失败: ${url}, ${msg} (${ms}ms)`);
      return null;
    }
    const data = await res.json() as T;
    const count = Array.isArray(data) ? data.length : 1;
    pluginState.debug(`[HTTP] 解析成功: ${count} 条数据 (${ms}ms)`);
    return data;
  } catch (e) {
    const ms = Date.now() - start;
    const reason = (e as { name?: string; })?.name === 'TimeoutError'
      ? `请求超时（${REQUEST_TIMEOUT_MS}ms）`
      : e;
    lastFetchError = String(reason);
    pluginState.log('error', `请求失败: ${url} (${ms}ms)，错误信息: ${reason}`);
    return null;
  }
}

/** 获取仓库事件（一次请求包含 push/issues/PR 等所有活动） */
export async function fetchEvents (repo: string, perPage = 30): Promise<GitHubEvent[]> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const url = `${base}/repos/${repo}/events?per_page=${perPage}`;
  pluginState.debug(`[GitHub] 获取仓库事件: ${repo}`);
  const events = await fetchJSON<GitHubEvent[]>(url) || [];
  if (events.length) {
    const types = [...new Set(events.map(e => e.type))];
    pluginState.debug(`[GitHub] ${repo}: ${events.length} 条事件，类型: ${types.join(', ')}`);
  } else {
    pluginState.debug(`[GitHub] ${repo}: 无事件`);
  }
  return events;
}

/**
 * 带 ETag 条件请求的 JSON 拉取。
 *
 * 首次请求把响应的 ETag 存进 `pluginState.etags`，之后带上 `If-None-Match`。
 * GitHub 在内容没变时返回 304 空响应，**这次请求不计入 core 速率配额**，
 * 所以轮询间隔再密也不会把 5000/h 的额度烧掉。
 *
 * 返回值：数据 / NOT_MODIFIED（没变化）/ null（出错）
 */
async function fetchJSONWithETag<T> (url: string, etagKey: string): Promise<T | NotModified | null> {
  const start = Date.now();
  const headers = getHeaders();
  const prevTag = pluginState.etags[etagKey];
  if (prevTag) headers['If-None-Match'] = prevTag;

  try {
    const res = await fetch(url, { ...FETCH_OPTS, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const ms = Date.now() - start;

    if (res.status === 304) {
      pluginState.debug(`[HTTP] 304 未修改 (${ms}ms) ${url}`);
      return NOT_MODIFIED;
    }

    pluginState.debug(`[HTTP] 响应: ${res.status} ${res.statusText} (${ms}ms)`);

    if (!res.ok) {
      // 出错时把该 URL 的 ETag 清掉。原来这里在 !res.ok 判断之前就把
      // 新 ETag 存了进去——错误响应也可能带 ETag，缓存下来之后下一轮
      // 带 If-None-Match 一直拿 304，于是「接口恢复后仍然一条数据都拿不到」。
      delete pluginState.etags[etagKey];
      let msg = `状态码: ${res.status} ${res.statusText || ''}`;
      switch (res.status) {
        case 301: case 302: case 303: case 307: case 308:
          msg = `API 地址返回重定向 (${res.status})，已拒绝跟随。请检查 API 地址是否填错`; break;
        case 401: msg = '访问令牌无效或已过期 (code: 401)'; break;
        case 403: msg = '请求达到 API 速率限制或无权限，请尝试填写 token 或降低请求频率后重试 (code: 403)'; break;
        case 404: msg = '未找到仓库 (code: 404)'; break;
        case 500: msg = '服务器错误 (code: 500)'; break;
      }
      pluginState.log('warn', `请求失败: ${url}, ${msg} (${ms}ms)`);
      return null;
    }

    // ETag 必须在**响应体解析成功之后**才落库。
    // 原来写在 res.json() 之前：200 响应体被截断（连接重置）、或 apiBase 指向
    // 的镜像返回了 HTML 错误页时，res.json() 抛错 → 返回 null、游标不推进，
    // 但 ETag 已经更新。下一轮带 If-None-Match 一直拿 304，于是该仓库的
    // commits 推送永久停止，只有重启插件（ETag 只在内存里）才恢复。
    const data = await res.json() as T;
    const newTag = res.headers.get('etag');
    if (newTag) pluginState.etags[etagKey] = newTag;
    pluginState.debug(`[HTTP] 解析成功 (${ms}ms)`);
    return data;
  } catch (e) {
    const ms = Date.now() - start;
    pluginState.log('error', `请求失败: ${url} (${ms}ms)，错误信息: ${e}`);
    return null;
  }
}

/**
 * 拉取指定分支的最近提交列表（commits 探测源）。
 *
 * 相比 /events，这个接口：数据新鲜（几乎实时）、严格按提交时间倒序、
 * 不会被 star/fork 之类的事件把游标带偏，也支持 since/path 等过滤。
 */
export async function fetchBranchCommits (repo: string, branch: string, perPage = 20): Promise<GitHubCommitItem[] | NotModified | null> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const shaQuery = branch ? `&sha=${encodeURIComponent(branch)}` : '';
  const url = `${base}/repos/${repo}/commits?per_page=${perPage}${shaQuery}`;
  pluginState.debug(`[GitHub] 获取分支提交: ${repo}@${branch || '默认分支'}`);

  // ETag key 用小写 repo，和 state.dropRepoCursors 的匹配规则对齐，
  // 否则删订阅时清不掉对应的 ETag，重新订阅会带着旧 ETag 拿到 304，
  // 表现为「重新订阅后一条都不推」。
  const etagKey = `commits:${repo.toLowerCase()}:${branch}`;
  const data = await fetchJSONWithETag<GitHubCommitItem[]>(url, etagKey);
  if (data === NOT_MODIFIED || data === null) return data;
  if (!Array.isArray(data)) return null;

  pluginState.debug(`[GitHub] ${repo}@${branch}: ${data.length} 条提交`);
  return data;
}

/** 获取用户公开事件 */
export async function fetchUserEvents (username: string, perPage = 30): Promise<GitHubEvent[]> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  // 用户名必须编码：不编码时 `../repos/owner/repo` 会被 URL 规范化成
  // `${base}/repos/owner/repo/events/public`，请求打到完全不同的接口；
  // `x?per_page=100#` 还能注入查询参数。GitHub 用户名本身只含 [A-Za-z0-9-]，
  // 编码后行为不变，但脏配置/手改配置就被挡住了。
  const safeName = encodeURIComponent(String(username || ''));
  const url = `${base}/users/${safeName}/events/public?per_page=${perPage}`;
  pluginState.debug(`[GitHub] 获取用户事件: ${username}`);
  const events = await fetchJSON<GitHubEvent[]>(url) || [];
  if (events.length) {
    const types = [...new Set(events.map(e => e.type))];
    pluginState.debug(`[GitHub] ${username}: ${events.length} 条事件，类型: ${types.join(', ')}`);
  } else {
    pluginState.debug(`[GitHub] ${username}: 无事件`);
  }
  return events;
}

/** 获取仓库默认分支 */
export async function fetchDefaultBranch (repo: string): Promise<string> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  pluginState.debug(`[GitHub] 获取默认分支: ${repo}`);
  const data = await fetchJSON<{ default_branch: string; }>(`${base}/repos/${repo}`);
  const branch = data?.default_branch || 'main';
  pluginState.debug(`[GitHub] ${repo} 默认分支: ${branch}`);
  return branch;
}

/** 获取仓库分支列表 */
export async function fetchBranches (repo: string, perPage = 100): Promise<{ name: string; isDefault: boolean; }[]> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  pluginState.debug(`[GitHub] 获取分支列表: ${repo}`);
  const [repoData, branches] = await Promise.all([
    fetchJSON<{ default_branch: string; }>(`${base}/repos/${repo}`),
    fetchJSON<{ name: string; }[]>(`${base}/repos/${repo}/branches?per_page=${perPage}`),
  ]);
  const defaultBranch = repoData?.default_branch || 'main';
  const list = (branches || []).map(b => ({ name: b.name, isDefault: b.name === defaultBranch }));
  // 默认分支排在最前面
  list.sort((a, b) => (a.isDefault ? -1 : 0) - (b.isDefault ? -1 : 0));
  pluginState.debug(`[GitHub] ${repo}: ${list.length} 个分支，默认: ${defaultBranch}`);
  return list;
}

/** 获取单个 commit 的详情（含文件变更） */
export async function fetchCommitDetail (repo: string, sha: string): Promise<{ files?: any[]; commit?: { message?: string; }; } | null> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const url = `${base}/repos/${repo}/commits/${sha}`;
  pluginState.debug(`[GitHub] 获取 commit 详情: ${repo}@${sha.slice(0, 7)}`);
  return await fetchJSON<{ files?: any[]; commit?: { message?: string; }; }>(url);
}

/** 获取仓库最近的 Actions workflow runs */
export async function fetchActionRuns (repo: string, perPage = 10): Promise<any[]> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const url = `${base}/repos/${repo}/actions/runs?per_page=${perPage}`;
  pluginState.debug(`[GitHub] 获取 Actions runs: ${repo}`);
  const data = await fetchJSON<{ workflow_runs: any[]; }>(url);
  const runs = data?.workflow_runs || [];
  pluginState.debug(`[GitHub] ${repo}: ${runs.length} 条 Actions runs`);
  return runs;
}

/** 获取仓库信息 */
export async function fetchRepoInfo (repo: string): Promise<RepoInfo | null> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const url = `${base}/repos/${repo}`;
  pluginState.debug(`[GitHub] 获取仓库信息: ${repo}`);
  return await fetchJSON<RepoInfo>(url);
}

/** 获取仓库 README 内容（返回解码后的文本） */
export async function fetchReadme (repo: string): Promise<string | null> {
  const base = pluginState.config.apiBase || 'https://api.github.com';
  const url = `${base}/repos/${repo}/readme`;
  pluginState.debug(`[GitHub] 获取 README: ${repo}`);
  const data = await fetchJSON<{ content: string; encoding: string; }>(url);
  if (!data?.content) return null;
  try {
    // GitHub API 返回 base64 编码的内容
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    pluginState.debug(`[GitHub] README 解码成功，长度: ${decoded.length}`);
    return decoded;
  } catch (e) {
    pluginState.log('warn', `README 解码失败: ${e}`);
    return null;
  }
}
