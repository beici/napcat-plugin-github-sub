// WebUI API 路由
import type { Subscription, EventType, UserSubscription, PluginConfig, ThemeColors } from './types';
import { pluginState } from './state';
import { fetchDefaultBranch, fetchBranches, normalizeRepo, getLastFetchError } from './github';
import { stopPoller, startPoller, dropUserSentEvents } from './poller';

/** ThemeColors 的全部键，用于白名单式接收 customTheme（必须与 types.ts 的 ThemeColors 保持一致） */
const THEME_KEYS: readonly string[] = [
  'bg', 'card', 'border', 'divider', 'text', 'textSub', 'textMuted', 'codeBg', 'codeHeader',
];

/** 单个自定义模板的最大长度（字符）。四个模板 × 这个值就是 config.json 的膨胀上限 */
const MAX_CUSTOM_HTML_LEN = 200_000;

/**
 * 校验一个 URL 是否可以安全地由服务端发起请求（SSRF 防护）。
 *
 * WebUI 的配置类接口都是无鉴权的（NapCat 的 postNoAuth），
 * 请求方可以自由指定要访问的地址。如果不加限制，
 * 填 http://127.0.0.1:6379 就能探测内网端口，
 * 填 http://169.254.169.254 就能读云厂商元数据接口拿临时凭据。
 */
function checkExternalUrl (raw: string): { ok: boolean; error?: string; } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `非法的 URL: ${raw}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只支持 http/https，收到 ${u.protocol}` };
  }
  // 末尾点必须去掉：`http://localhost.:6379` 的 hostname 是 `localhost.`，
  // 既不在黑名单里也不以 `.localhost` 结尾，但系统解析时就是回环地址。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  // 本机与内网主机名
  const blockedNames = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', '0.0.0.0']);
  if (blockedNames.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, error: '不允许访问本机/内网地址' };
  }
  // 把任意域名解析到回环的公共 DNS 服务（nip.io / sslip.io / xip.io 等）
  // 是绕过「只匹配字面 IP」的经典手法：127.0.0.1.nip.io 的 hostname 不含点分四段，
  // 正则不命中，但 DNS 解析结果就是 127.0.0.1。
  if (/(?:^|\.)(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|traefik\.me)$/.test(host)) {
    return { ok: false, error: '不允许访问本机/内网地址' };
  }

  // IPv4 私有段 + 回环 + 链路本地 + 云元数据
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)   // 链路本地（含 169.254.169.254 元数据）
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) // CGNAT
      || a >= 224;                  // 组播/保留
    if (isPrivate) return { ok: false, error: '不允许访问本机/内网地址' };
  }

  // IPv6：回环、未指定、唯一本地、链路本地、以及 IPv4-mapped 形式。
  // `http://[::ffff:127.0.0.1]` 会被 WHATWG 规范化成 `::ffff:7f00:1`，
  // 既不是 `::1` 也不以 fc/fd/fe80 开头，只匹配字符串会直接放行到回环。
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return { ok: false, error: '不允许访问本机/内网地址' };
    if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) {
      return { ok: false, error: '不允许访问本机/内网地址' };
    }
    // IPv4-mapped：::ffff:a.b.c.d 或 ::ffff:xxxx:xxxx（十六进制形式）
    const mapped = /^::ffff:(.+)$/.exec(host);
    if (mapped) {
      const tail = mapped[1];
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
        const chk = checkExternalUrl(`http://${tail}`);
        if (!chk.ok) return chk;
      } else {
        // 十六进制形式（如 7f00:1）一律拒绝，避免手工推算绕过
        return { ok: false, error: '不允许访问本机/内网地址' };
      }
    }
    // IPv4-compatible 形式（::a.b.c.d）
    if (/^::\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      return { ok: false, error: '不允许访问本机/内网地址' };
    }
  }

  return { ok: true };
}

/**
 * 宽松布尔解析。
 *
 * 前端偶尔会把布尔值当字符串传（`{"debug":"false"}`），
 * 直接 `Boolean("false")` 得到 true —— 用户点「关闭」反而打开了开关。
 */
function toBool (v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fallback;
}

/**
 * 字符串数组归一：非数组返回 null（调用方据此跳过该字段），
 * 元素统一 String 化、trim、去空、去重。
 */
function toStringArray (v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map(x => String(x ?? '').trim()).filter(Boolean))];
}

/**
 * 包一层 try/catch。
 *
 * Express 4 不捕获 async handler 的 rejection：一个 TypeError 就会让
 * 这个 HTTP 请求永久挂起（前端一直转圈），同时变成 unhandled rejection，
 * Node 15+ 默认直接退出进程 —— 整个 QQ 就掉了。
 */
function safeHandler (fn: (req: any, res: any) => unknown) {
  return (req: any, res: any): void => {
    const onError = (e: unknown): void => {
      pluginState.log('error', `[API] ${req?.method || ''} ${req?.path || req?.url || ''} 处理失败: ${e}`);
      try {
        if (!res.headersSent) res.json({ success: false, error: String(e) });
      } catch { /* 响应已经发出去或连接已断，忽略 */ }
    };
    try {
      const r = fn(req, res);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).catch(onError);
      }
    } catch (e) {
      onError(e);
    }
  };
}

/**
 * 上一次保存配置时的「影响轮询的字段」快照。
 *
 * 用来判断这次保存到底需不需要重建轮询链：WebUI 每次打开都会自动保存一次，
 * 改个主题、改个 token 也重启轮询的话，每轮至少丢一个周期，还会重置游标比对。
 */
let lastPollKey = '';

/**
 * 计算「影响轮询」的配置快照。
 *
 * 只包含真正决定轮询行为的字段：订阅/用户监控的内容、间隔、commits 源、合并开关。
 * 主题、Token、debug 之类的改动不该重建轮询链 —— 重建会丢掉当前周期的等待，
 * 还会让 startupTimer 重新走一遍「首次运行记基线」。
 */
function pollKeyOf (): string {
  // 防御式取值：subscriptions 被手改成非数组时，这里原来会直接抛 TypeError。
  // 它在 POST /config 的同步 handler 里被调用，Express 4 对同步抛错返回 500，
  // 用户看到的是「保存失败」但完全不知道为什么。
  const subs = Array.isArray(pluginState.config.subscriptions) ? pluginState.config.subscriptions : [];
  const users = Array.isArray(pluginState.config.userSubscriptions) ? pluginState.config.userSubscriptions : [];
  return JSON.stringify([
    // alias / groups 刻意不放进快照：它们只影响推送目标的展示与选择，
    // poll() 每轮都从 config 现读，改别名/改群完全不需要重建轮询链。
    subs.map(s => [s?.repo, s?.branch, s?.types, s?.enabled]),
    users.map(u => [u?.username, u?.enabled]),
    pluginState.config.interval, pluginState.config.commitSource, pluginState.config.mergeNotify,
  ]);
}

/**
 * 配置变更后按需重建轮询链（幂等：没变就什么都不做）。
 *
 * 所有改订阅/改配置的入口都该走这里，而不是无条件 stopPoller+startPoller ——
 * 连加 N 个分支会重启 N 次，每次重启都白丢一个轮询周期。
 */
export function syncPoller (): void {
  const key = pollKeyOf();
  if (key === lastPollKey) return;
  lastPollKey = key;
  const hasWork = (Array.isArray(pluginState.config.subscriptions) ? pluginState.config.subscriptions.length : 0) > 0
    || (Array.isArray(pluginState.config.userSubscriptions) ? pluginState.config.userSubscriptions.length : 0) > 0;
  stopPoller();
  if (hasWork) startPoller();
}

/**
 * 把当前配置记为「已同步」快照。
 *
 * plugin_init 已经自己 startPoller 过一次了，如果不记快照，
 * 用户第一次在 WebUI 点保存（哪怕只改主题）就会判定为「变了」再重启一次。
 * 卸载时也要调一次清零，否则插件重载后首次保存不会生效。
 */
export function seedPollKey (): void {
  lastPollKey = pollKeyOf();
}

export function registerApiRoutes (router: any): void {
  // 获取配置 + 订阅列表
  router.getNoAuth('/config', (_: any, res: any) => {
    res.json({
      success: true,
      version: pluginState.version,
      config: {
        token: pluginState.config.token ? '***' : '',
        tokens: (pluginState.config.tokens || []).map(t => t ? '***' : ''),
        tokenCount: (pluginState.config.tokens || []).filter(t => String(t ?? '').trim()).length + (pluginState.config.token ? 1 : 0),
        apiBase: pluginState.config.apiBase,
        interval: pluginState.config.interval,
        commitSource: pluginState.config.commitSource ?? 'commits',
        debug: pluginState.config.debug,
        owners: pluginState.config.owners || [],
        allowMemberSub: pluginState.config.allowMemberSub ?? false,
        autoDetectRepo: pluginState.config.autoDetectRepo !== false,
        mergeNotify: pluginState.config.mergeNotify ?? false,
        theme: pluginState.config.theme || 'light',
        customTheme: pluginState.config.customTheme || null,
        customHTML: pluginState.config.customHTML || null,
        webuiPort: pluginState.config.webuiPort || null,
        // apiKey 不回传明文，前端看到 *** 就知道"已配置，不修改"
        llm: pluginState.config.llm
          ? { ...pluginState.config.llm, apiKey: pluginState.config.llm.apiKey ? '***' : '' }
          : null,
      },
      subscriptions: pluginState.config.subscriptions,
      userSubscriptions: pluginState.config.userSubscriptions || [],
    });
  });

  // 保存基础配置
  router.postNoAuth('/config', (req: any, res: any) => {
    const body = req.body as Record<string, unknown>;
    if (body.token !== undefined && body.token !== '***') pluginState.config.token = String(body.token);
    if (body.tokens !== undefined && Array.isArray(body.tokens)) {
      // 前端回读的是 *** 掩码。原来 filter 掉 *** 后整体覆盖，等于「打开页面点保存」
      // 就把所有 token 清空，配额立刻从 5000 掉到 60，表现为突然大面积 403。
      // 现在按位置合并：占位符沿用该位置旧值，空串视为删除，真值视为新增/替换。
      const existing = (pluginState.config.tokens || []).map(t => String(t ?? ''));
      const incoming = (body.tokens as unknown[]).map(t => String(t ?? ''));
      const merged: string[] = [];
      for (let i = 0; i < incoming.length; i++) {
        const v = incoming[i];
        if (v === '***') {
          // 占位符：沿用同一位置旧值
          if (existing[i]) merged.push(existing[i]);
        } else if (v.trim()) {
          merged.push(v.trim());
        }
        // 空串：用户删了这一行，丢弃
      }
      pluginState.config.tokens = merged;
    }
    if (body.apiBase !== undefined) {
      // 去尾部斜杠：填 https://api.github.com/ 时拼接会变成 //repos/...，GitHub 返回 404
      const base = String(body.apiBase || '').trim().replace(/\/+$/, '');
      if (base) {
        const chk = checkExternalUrl(base);
        if (chk.ok) pluginState.config.apiBase = base;
        else pluginState.log('warn', `[配置] 忽略 API 地址: ${chk.error}`);
      }
    }
    if (body.interval !== undefined) {
      const n = Number(body.interval);
      // 上界必须有：Infinity 落盘后 JSON.stringify 变 null，运行期
      // setTimeout(Infinity) 会溢出成 1ms —— 变成不间断的热循环打 GitHub。
      if (Number.isFinite(n) && n >= 5) pluginState.config.interval = Math.min(Math.floor(n), 86400);
    }
    // commits 探测源：commits（推荐）/ events（旧行为）
    if (body.commitSource !== undefined) {
      const src = String(body.commitSource);
      if (src === 'commits' || src === 'events') pluginState.config.commitSource = src;
    }
    // 布尔字段统一走 toBool：前端偶尔把布尔当字符串传，
    // Boolean("false") === true，点「关闭」反而打开了开关。
    if (body.debug !== undefined) pluginState.config.debug = toBool(body.debug, pluginState.config.debug);
    if (body.owners !== undefined) {
      const owners = toStringArray(body.owners);
      if (owners) pluginState.config.owners = owners;
    }
    if (body.allowMemberSub !== undefined) pluginState.config.allowMemberSub = toBool(body.allowMemberSub, pluginState.config.allowMemberSub ?? false);
    if (body.autoDetectRepo !== undefined) pluginState.config.autoDetectRepo = toBool(body.autoDetectRepo, pluginState.config.autoDetectRepo !== false);
    if (body.mergeNotify !== undefined) pluginState.config.mergeNotify = toBool(body.mergeNotify, pluginState.config.mergeNotify ?? false);
    if (body.theme !== undefined && ['light', 'dark', 'custom'].includes(String(body.theme))) {
      pluginState.config.theme = String(body.theme) as 'light' | 'dark' | 'custom';
    }
    if (body.customTheme !== undefined && typeof body.customTheme === 'object' && body.customTheme !== null && !Array.isArray(body.customTheme)) {
      // 只保留 ThemeColors 里认识的键，且必须是字符串。
      // 原来直接 `as any` 落库：传入 {__proto__: {...}} 或嵌套对象都会原样保存，
      // 渲染时再拼进 <style> —— 值虽然过 safeColor，但键名不受控。
      const incoming = body.customTheme as Record<string, unknown>;
      const theme: Record<string, string> = {};
      for (const k of THEME_KEYS) {
        if (typeof incoming[k] === 'string') theme[k] = String(incoming[k]).slice(0, 64);
      }
      pluginState.config.customTheme = theme as unknown as ThemeColors;
    }
    if (body.customHTML !== undefined && typeof body.customHTML === 'object' && body.customHTML !== null && !Array.isArray(body.customHTML)) {
      // 同理：只允许四个已知模板键 + 字符串值，且限制长度。
      // 这四个模板会被原样塞进 puppeteer 渲染的页面，长度不限制等于允许
      // 一次 POST 写入几十 MB 到 config.json，下次启动解析就慢/失败。
      const incoming = body.customHTML as Record<string, unknown>;
      const tpl: Record<string, string> = {};
      for (const k of ['commits', 'issues', 'pulls', 'comments']) {
        if (typeof incoming[k] === 'string') tpl[k] = String(incoming[k]).slice(0, MAX_CUSTOM_HTML_LEN);
      }
      pluginState.config.customHTML = tpl as unknown as PluginConfig['customHTML'];
    }
    // AI 摘要配置：只覆盖显式传过来的字段，避免前端漏传时把已有 key 清空
    if (body.llm !== undefined && typeof body.llm === 'object' && body.llm !== null) {
      const inc = body.llm as Record<string, any>;
      const cur = pluginState.config.llm || {
        enabled: false, apiBase: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini',
        maxTokens: 400, timeout: 15000, temperature: 0.3, maxDiffChars: 6000, prompt: '',
      };
      const next = { ...cur };
      // 走 toBool：前端偶尔把布尔当字符串传，Boolean('false') === true
      // 会让用户点「关闭」反而打开 AI 摘要（每轮白花 LLM token）
      if (inc.enabled !== undefined) next.enabled = toBool(inc.enabled, cur.enabled);
      if (inc.apiBase !== undefined) {
        // 去掉尾部斜杠：前端可能填 https://api.openai.com/v1/，
        // 拼接后变成 //chat/completions，部分网关直接 404。
        const base = String(inc.apiBase || '').trim().replace(/\/+$/, '');
        // SSRF 校验必须在这里做，不能只在 /llm/test 里做。
        // 保存下来的 apiBase 会被 llm.ts 每轮轮询主动 POST（带 Authorization），
        // 设成 http://127.0.0.1:6379 或云元数据地址就是一个持久的 SSRF 通道，
        // 比 /llm/test 更隐蔽——连「测试」按钮都不用点。
        const chk = checkExternalUrl(base);
        if (chk.ok) next.apiBase = base;
        else pluginState.log('warn', `[配置] 忽略 LLM API 地址: ${chk.error}`);
      }
      // apiKey 传 *** 表示"保持原值不变"
      if (inc.apiKey !== undefined && String(inc.apiKey) !== '***') next.apiKey = String(inc.apiKey || '').trim();
      if (inc.model !== undefined) next.model = String(inc.model || '').trim();
      if (inc.maxTokens !== undefined) next.maxTokens = Math.max(50, Math.min(8000, Number(inc.maxTokens) || 400));
      if (inc.timeout !== undefined) next.timeout = Math.max(3000, Math.min(120000, Number(inc.timeout) || 15000));
      if (inc.temperature !== undefined) {
        // Number('abc') 是 NaN，Math.min/max 传播 NaN，temperature 落库成 NaN
        // 之后 JSON.stringify 写盘变 null，LLM 请求带 null 直接被上游 400。
        const t = Number(inc.temperature);
        next.temperature = Number.isFinite(t) ? Math.max(0, Math.min(2, t)) : 0.3;
      }
      if (inc.maxDiffChars !== undefined) next.maxDiffChars = Math.max(500, Math.min(200000, Number(inc.maxDiffChars) || 6000));
      if (inc.prompt !== undefined) next.prompt = String(inc.prompt || '');
      pluginState.config.llm = next;
    }
    if (body.webuiPort !== undefined) {
      const p = Number(body.webuiPort);
      if (Number.isFinite(p) && p > 0 && p <= 65535) {
        pluginState.config.webuiPort = p;
        pluginState.httpPort = p;
      } else if (!p) {
        // 清空时要连 httpPort 一起清：renderToBase64 优先读 httpPort，
        // 只删 webuiPort 会让渲染继续打那个已经失效的旧端口。
        delete pluginState.config.webuiPort;
        pluginState.httpPort = 0;
      }
    }
    pluginState.saveConfig();
    // 只有真的会影响轮询的字段变了才重启，否则「只改个主题」也会重建轮询链。
    // 原来这里无条件 stop+start，WebUI 每次打开都会自动保存一次配置。
    syncPoller();
    res.json({ success: true });
  });

  // 获取仓库分支列表
  router.postNoAuth('/repo/branches', safeHandler(async (req: any, res: any) => {
    const raw = String((req.body as any)?.repo ?? '').trim();
    const repo = normalizeRepo(raw);
    if (!repo) {
      res.json({ success: false, error: `无法识别仓库名：${raw || '(空)'}。请填 owner/repo，或直接粘贴 github.com 仓库链接` });
      return;
    }
    try {
      const branches = await fetchBranches(repo);
      if (!branches.length) {
        // 不能再一律报「可能是空仓库」：fetchJSON 失败时返回 null，
        // fetchBranches 把它当成空数组，于是 401/403/404/网络不通
        // 全都被说成「空仓库」，用户按这个提示排查永远找不到真正原因。
        const why = getLastFetchError();
        res.json({
          success: false,
          error: why
            ? `无法读取 ${repo} 的分支：${why}`
            : `仓库 ${repo} 没有可用分支（可能是空仓库）`,
        });
        return;
      }
      res.json({ success: true, data: branches, repo });
    } catch (e) {
      res.json({ success: false, error: String(e) });
    }
  }));

  // 添加订阅（支持单分支 branch 或多分支 branches 数组，支持别名 alias）
  router.postNoAuth('/sub/add', safeHandler(async (req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawRepo = String(body.repo ?? '').trim();
    const repo = normalizeRepo(rawRepo);
    if (!repo) {
      res.json({ success: false, error: `无法识别仓库名：${rawRepo || '(空)'}。请填 owner/repo，或直接粘贴 github.com 仓库链接` });
      return;
    }

    // types：只保留合法枚举；非数组时退回默认值
    const rawTypes = Array.isArray(body.types) ? body.types : [];
    const validTypes: EventType[] = rawTypes.filter(t =>
      ['commits', 'issues', 'pulls', 'actions'].includes(String(t))
    ) as EventType[];
    if (!Array.isArray(body.types)) validTypes.push('commits', 'issues', 'pulls');
    // 前端传空数组时上面的 || 不会兜底（[] 是真值），会建出一条
    // 什么类型都不监控的订阅——看着加成功了，实际永远不推送。
    if (!validTypes.length) validTypes.push('commits');

    // 别名：去掉多余空白，留空表示不设
    const alias = String(body.alias ?? '').trim() || undefined;

    // 推送群：过滤非法值并去重，空数组也保留（= 暂不推送到任何群，
    // 由用户在编辑界面补群号；若在这里塞默认群，用户会莫名其妙被推送）
    const groupList = toStringArray(body.groups) ?? [];

    // 收集要订阅的分支列表
    let branchList: string[] = [];
    if (Array.isArray(body.branches) && body.branches.length) {
      branchList = body.branches.map(b => String(b ?? '').trim()).filter(Boolean);
    } else if (String(body.branch ?? '').trim()) {
      branchList = [String(body.branch).trim()];
    }
    if (!branchList.length) {
      try { branchList = [await fetchDefaultBranch(repo)]; } catch { branchList = ['main']; }
    }

    // 去重后过滤已订阅的分支
    branchList = [...new Set(branchList)];
    // 分支名合法性校验：带空格、斜杠开头、含 .. 的分支名会让
    // /repos/{repo}/commits?sha=<branch> 请求打到错误路径或 404
    branchList = branchList.filter(b => /^[A-Za-z0-9._\/-]+$/.test(b) && !b.includes('..'));
    if (!branchList.length) {
      res.json({ success: false, error: '分支名不合法' });
      return;
    }
    const skipped: string[] = [];
    const toAdd: string[] = [];
    for (const b of branchList) {
      if (pluginState.config.subscriptions.some(s => s.repo.toLowerCase() === repo && s.branch === b)) {
        skipped.push(b);
      } else {
        toAdd.push(b);
      }
    }
    if (!toAdd.length) {
      res.json({ success: false, error: `所选分支均已订阅: ${skipped.join(', ')}` });
      return;
    }

    const added: Subscription[] = [];
    for (const branch of toAdd) {
      const sub: Subscription = {
        repo, branch, types: validTypes,
        groups: [...groupList],
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      // 别名只在有值时才写，避免配置里堆一堆 undefined
      if (alias) sub.alias = alias;
      pluginState.config.subscriptions.push(sub);
      added.push(sub);
    }
    pluginState.saveConfig();
    syncPoller();
    const msg = skipped.length ? `已添加 ${toAdd.join(', ')}，跳过已订阅: ${skipped.join(', ')}` : undefined;
    res.json({ success: true, data: added.length === 1 ? added[0] : added, message: msg });
  }));

  // 更新订阅
  router.postNoAuth('/sub/update', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    // repo 一律走 normalizeRepo：前端可能传完整 URL、带大小写，
    // 直接拿原串去 === 比对会找不到订阅（配置里存的是小写 owner/repo）。
    const repoRaw = String(body.repo ?? '');
    const repo = normalizeRepo(repoRaw) || repoRaw;
    const lowRepo = repo.toLowerCase();
    const oldBranch = body.oldBranch === undefined ? undefined : String(body.oldBranch);
    const newBranch = body.branch === undefined ? undefined : String(body.branch);
    const aliasGiven = Object.prototype.hasOwnProperty.call(body, 'alias');

    // 定位原订阅。
    // 原来写的是 `const matchBranch = oldBranch || newBranch`：只传 branch 时
    // 会拿新分支名去匹配，命中的是「本来就是这条分支」的记录——等于什么都没改
    // 却回 success。这里改成三级回退：oldBranch → 该仓库唯一订阅 → branch。
    const sameRepo = pluginState.config.subscriptions.filter(s => s.repo.toLowerCase() === lowRepo);
    let sub: Subscription | undefined;
    if (oldBranch !== undefined) {
      sub = sameRepo.find(s => s.branch === oldBranch);
    }
    if (!sub && sameRepo.length === 1) {
      sub = sameRepo[0];
    }
    if (!sub && newBranch !== undefined) {
      sub = sameRepo.find(s => s.branch === newBranch);
    }
    if (!sub) { res.json({ success: false, error: '未找到该订阅' }); return; }

    // 记住改之前的真实分支，后面判断要不要清游标用它，而不是看 oldBranch 有没有传
    const prevBranch = sub.branch;

    // 先把所有校验做完，再统一写字段。
    // 原来 types/groups/enabled 写在分支校验之前，校验失败 return 时内存里
    // 已经改了一半（甚至被 disabled）—— 用户看到「保存失败」，实际订阅已经不推了，
    // 之后任意一次无关的 saveConfig 还会把这份半成品持久化。
    const nextTypes = Array.isArray(body.types)
      ? (body.types as unknown[])
        .map(t => String(t))
        .filter(t => ['commits', 'issues', 'pulls', 'actions'].includes(t)) as EventType[]
      : null;
    const nextGroups = toStringArray(body.groups);
    const nextEnabled = body.enabled === undefined ? null : toBool(body.enabled, sub.enabled);
    const nextAliasGiven = aliasGiven;
    const nextAlias = String(body.alias ?? '').trim();
    const branchChanged = newBranch !== undefined && newBranch !== prevBranch;

    if (branchChanged) {
      // 分支名合法性：含空格 / 前导斜杠 / .. 会让 commits 请求打到错误路径
      if (!/^[A-Za-z0-9._\/-]+$/.test(newBranch) || newBranch.includes('..')) {
        res.json({ success: false, error: `分支名不合法: ${newBranch}` });
        return;
      }
      // 改成已订阅的分支会产生两条 repo+branch 完全相同的订阅，
      // 轮询时同一份提交被推两次（用户看到重复消息）。
      const dup = pluginState.config.subscriptions.some(
        s => s !== sub && s.repo.toLowerCase() === lowRepo && s.branch === newBranch,
      );
      if (dup) {
        res.json({ success: false, error: `分支 ${newBranch} 已存在同仓库订阅` });
        return;
      }
    }

    // ==== 校验全部通过，开始落库 ====
    // 传了空数组/全非法值时不要落成「什么都不监控」
    if (nextTypes && nextTypes.length) sub.types = nextTypes;
    if (nextGroups) {
      // 空数组不能落库：订阅没有推送群就永远不会推送，但界面会显示「更新成功」
      if (nextGroups.length) sub.groups = nextGroups;
      else pluginState.log('warn', `[${sub.repo}] 忽略空推送群设置（订阅至少需要一个推送群）`);
    }
    if (nextEnabled !== null) sub.enabled = nextEnabled;
    if (branchChanged) sub.branch = newBranch;
    // alias 传空串表示清除别名，没传则保持原值
    if (nextAliasGiven) {
      if (nextAlias) sub.alias = nextAlias;
      else delete sub.alias;
    }
    pluginState.saveConfig();

    // 分支被改了：旧分支的游标必须清掉。
    // 原来的条件是 `newBranch && oldBranch && newBranch !== oldBranch`，
    // 只传 branch 不传 oldBranch 时永远不成立 —— 旧分支的 head 游标留在缓存里，
    // 之后再把分支改回去就会拿旧游标比对，表现是「重新订阅旧分支后一条都不推」。
    if (branchChanged) {
      pluginState.dropRepoCursors(sub.repo, prevBranch);
      pluginState.log('info', `[${sub.repo}] 分支 ${prevBranch} → ${sub.branch}，已重置该分支游标`);
    }

    res.json({ success: true, data: sub });
  }));

  // 删除订阅
  router.postNoAuth('/sub/delete', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const repoRaw = String(body.repo ?? '');
    const repo = normalizeRepo(repoRaw) || repoRaw;
    const lowRepo = repo.toLowerCase();
    const branch = body.branch === undefined ? undefined : String(body.branch);

    // 不传 branch 时删掉该仓库的**全部**分支订阅。
    // 原来用 findIndex 只删第一条：用户以为整个仓库都取消订阅了，
    // 其它分支还在继续推（和 commands.ts 的 `gh 取消` 行为也不一致）。
    const targets = pluginState.config.subscriptions.filter(
      s => s.repo.toLowerCase() === lowRepo && (!branch || s.branch === branch),
    );
    if (!targets.length) { res.json({ success: false, error: '未找到该订阅' }); return; }

    const removedBranches = targets.map(s => s.branch);
    pluginState.config.subscriptions = pluginState.config.subscriptions.filter(
      s => !targets.includes(s),
    );
    pluginState.saveConfig();

    // 该仓库如果还有别的订阅，只清被删掉的分支游标；否则整个仓库的游标一起清
    const stillHasRepo = pluginState.config.subscriptions.some(
      s => s.repo.toLowerCase() === lowRepo,
    );
    if (stillHasRepo) {
      for (const b of removedBranches) {
        if (b) pluginState.dropRepoCursors(targets[0].repo, b);
      }
    } else {
      pluginState.dropRepoCursors(targets[0].repo);
    }

    res.json({ success: true, removed: removedBranches });
  }));

  // ===== 用户监控 API =====

  // 添加用户监控
  router.postNoAuth('/user/add', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const name = String(body.username ?? '').trim();
    if (!name) { res.json({ success: false, error: '用户名不能为空' }); return; }
    // GitHub 用户名的合法字符集。不校验的话可以塞 `../../orgs/xxx`
    // 之类的路径片段，请求会打到别的 /users 子路径上。
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(name)) {
      res.json({ success: false, error: `用户名不合法: ${name}` }); return;
    }
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const existing = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === name.toLowerCase());
    if (existing) { res.json({ success: false, error: '该用户已在监控列表' }); return; }
    const userSub: UserSubscription = {
      username: name,
      groups: toStringArray(body.groups) ?? [],
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    pluginState.config.userSubscriptions.push(userSub);
    pluginState.saveConfig();
    syncPoller();
    res.json({ success: true, data: userSub });
  }));

  // 更新用户监控
  router.postNoAuth('/user/update', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const name = String(body.username ?? '').trim();
    // 大小写不敏感匹配，与 /user/add 保持一致（GitHub 用户名本身不区分大小写）
    const sub = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === name.toLowerCase());
    if (!sub) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    const nextGroups = toStringArray(body.groups);
    if (nextGroups) {
      if (nextGroups.length) sub.groups = nextGroups;
      else pluginState.log('warn', `[${sub.username}] 忽略空推送群设置（用户监控至少需要一个推送群）`);
    }
    if (body.enabled !== undefined) sub.enabled = toBool(body.enabled, sub.enabled);
    pluginState.saveConfig();
    res.json({ success: true, data: sub });
  }));

  // 删除用户监控
  router.postNoAuth('/user/delete', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const name = String(body.username ?? '').trim();
    const idx = pluginState.config.userSubscriptions.findIndex(u => u.username.toLowerCase() === name.toLowerCase());
    if (idx === -1) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    const removedUser = pluginState.config.userSubscriptions[idx];
    pluginState.config.userSubscriptions.splice(idx, 1);
    pluginState.saveConfig();
    // 清掉该用户的动态游标，避免重新关注时拿旧游标比对导致漏推
    delete pluginState.cache[`user:${(removedUser.username || '').toLowerCase()}`];
    pluginState.saveCache();
    // 已推送事件集合也要清：Map 的条目数没有上限，反复增删用户会持续泄漏
    dropUserSentEvents(removedUser.username);
    res.json({ success: true });
  }));

  // 切换用户监控开关
  router.postNoAuth('/user/toggle', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const name = String(body.username ?? '').trim();
    const sub = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === name.toLowerCase());
    if (!sub) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    sub.enabled = !sub.enabled;
    pluginState.saveConfig();
    res.json({ success: true, enabled: sub.enabled });
  }));

  // 获取群列表
  router.getNoAuth('/groups', safeHandler(async (_: any, res: any) => {
    try {
      if (!pluginState.actions || !pluginState.networkConfig) {
        res.json({ success: false, error: '插件未初始化' }); return;
      }
      const result = await pluginState.actions.call('get_group_list', {} as never, pluginState.adapterName, pluginState.networkConfig);
      res.json({ success: true, data: result || [] });
    } catch (e) { res.json({ success: false, error: String(e) }); }
  }));

  // 切换订阅开关
  router.postNoAuth('/sub/toggle', safeHandler((req: any, res: any) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const repoRaw = String(body.repo ?? '');
    const repo = normalizeRepo(repoRaw) || repoRaw;
    const lowRepo = repo.toLowerCase();
    const branch = body.branch === undefined ? undefined : String(body.branch);
    // 与 /sub/delete 对齐：不传 branch 时作用于该仓库的全部分支订阅，
    // 否则只切第一条，用户以为整个仓库都关了、实际还有分支在推。
    const targets = pluginState.config.subscriptions.filter(
      s => s.repo.toLowerCase() === lowRepo && (!branch || s.branch === branch),
    );
    if (!targets.length) { res.json({ success: false, error: '未找到该订阅' }); return; }
    // 以第一条的当前状态取反，整组设成同一个值（避免一半开一半关）
    const next = !targets[0].enabled;
    for (const s of targets) s.enabled = next;
    pluginState.saveConfig();
    res.json({ success: true, enabled: next, branches: targets.map(s => s.branch) });
  }));

  // Ping GitHub API 连通性测试
  router.getNoAuth('/ping', safeHandler(async (_: any, res: any) => {
    const base = String(pluginState.config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
    const start = Date.now();
    try {
      const headers: Record<string, string> = { 'User-Agent': 'napcat-plugin-github-sub' };
      // 使用第一个可用 token（脏配置里可能有 null/number，统一 String 化再 trim）
      const allTokens: string[] = (pluginState.config.tokens || []).map(t => String(t ?? ''));
      const legacy = String(pluginState.config.token || '');
      if (legacy && !allTokens.includes(legacy)) allTokens.push(legacy);
      const firstToken = allTokens.find(t => t.trim());
      if (firstToken) headers['Authorization'] = `Bearer ${firstToken}`;
      const hasToken = !!firstToken;
      const r = await fetch(`${base}/zen`, { headers, signal: AbortSignal.timeout(10000) });
      const ms = Date.now() - start;

      if (r.ok) {
        // 顺带把剩余配额读出来，用户能看到 token 是不是真生效了
        const remaining = r.headers.get('x-ratelimit-remaining');
        const limit = r.headers.get('x-ratelimit-limit');
        res.json({ success: true, ms, status: r.status, authenticated: hasToken, remaining, limit });
      } else {
        res.json({ success: false, ms, status: r.status, error: `HTTP ${r.status}` });
      }
    } catch (e) {
      const ms = Date.now() - start;
      res.json({ success: false, ms, error: String(e) });
    }
  }));

  // Puppeteer 状态检测
  router.getNoAuth('/puppeteer', safeHandler(async (_: any, res: any) => {
    try {
      // 与 renderToBase64 用同一套端口推导：httpPort 是 NapCat 实际监听的端口，
      // 只读 webuiPort 时，没配 webuiPort 的部署会去探测 6099 拿到失败，
      // 前端于是长期显示「未连接」，但实际渲染是正常的。
      const port = pluginState.httpPort || pluginState.config.webuiPort || 6099;
      const r = await fetch(`http://127.0.0.1:${port}/plugin/napcat-plugin-puppeteer/api/status`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        res.json({ success: true, connected: true });
      } else {
        res.json({ success: true, connected: false, error: `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ success: true, connected: false, error: String(e) });
    }
  }));

  // 调试日志
  router.getNoAuth('/logs', (_: any, res: any) => {
    res.json({ success: true, data: pluginState.logBuffer });
  });

  router.postNoAuth('/logs/clear', (_: any, res: any) => {
    pluginState.clearLogs();
    res.json({ success: true });
  });

  // LLM 连通性测试：发一个最小请求，验证 base/apiKey/model 是否可用
  router.postNoAuth('/llm/test', safeHandler(async (req: any, res: any) => {
    const body = (req.body || {}) as Record<string, any>;
    const cur = pluginState.config.llm;
    const apiBase = String(body.apiBase || cur?.apiBase || '').replace(/\/+$/, '');
    // 前端传 *** 表示沿用已保存的 key
    const apiKey = String(body.apiKey && body.apiKey !== '***' ? body.apiKey : (cur?.apiKey || ''));
    const model = String(body.model || cur?.model || '');

    if (!apiBase) { res.json({ success: false, error: 'API 地址为空' }); return; }
    if (!apiKey) { res.json({ success: false, error: 'API Key 为空' }); return; }
    if (!model) { res.json({ success: false, error: '模型名为空' }); return; }

    // SSRF 防护：这个接口是无鉴权的，apiBase 完全由请求方控制。
    // 不校验的话，填 http://127.0.0.1:6379 就能让服务端去打内网端口，
    // 填 http://169.254.169.254 就能摸云厂商元数据（拿到临时凭据）。
    const baseCheck = checkExternalUrl(apiBase);
    if (!baseCheck.ok) { res.json({ success: false, error: baseCheck.error }); return; }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是测试助手。' },
            { role: 'user', content: '只回复两个字：正常' },
          ],
          max_tokens: 20,
          temperature: 0,
        }),
        signal: controller.signal,
        // 禁止跟随跳转：否则校验过 https://evil.com 后 302 到 127.0.0.1 就绕过了
        redirect: 'manual',
      });
      const ms = Date.now() - started;
      if (r.status >= 300 && r.status < 400) {
        res.json({ success: false, error: `API 地址返回重定向 HTTP ${r.status}，已拒绝跟随`, ms });
        return;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        res.json({ success: false, error: `HTTP ${r.status} ${txt.slice(0, 200)}`, ms });
        return;
      }
      const data = await r.json() as { choices?: { message?: { content?: string; }; }[]; };
      const reply = data?.choices?.[0]?.message?.content?.trim() || '';
      res.json({ success: true, ms, model, reply: reply.slice(0, 100) });
    } catch (e) {
      const ms = Date.now() - started;
      const reason = (e as { name?: string; })?.name === 'AbortError' ? '请求超时（30s）' : String(e);
      res.json({ success: false, error: reason, ms });
    } finally {
      clearTimeout(timer);
    }
  }));
}
