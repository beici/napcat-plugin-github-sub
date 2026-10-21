// 渲染模块 - 通过 puppeteer 插件截图 HTML 为 base64 图片
import type { CommitData, IssueData, CommentData, ActionRunData, ThemeColors, RepoInfo, UserActivityItem } from './types';
import { pluginState } from './state';

/**
 * 转义 HTML。
 *
 * 入参声明成 unknown 而不是 string：全库有几十个调用点直接把接口返回的字段丢进来，
 * 其中不少字段（commit.author、user.login、conclusion…）在脏数据下是 null/undefined。
 * 原来直接 .replace() 会抛 TypeError，而 HTML 是在进 renderToBase64 之前就拼好的，
 * 外层 try 抓不到 —— 结果就是整批推送静默消失。
 */
export function esc (s: unknown): string {
  const str = s === null || s === undefined ? '' : String(s);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 截断文本（按码点切，避免把 emoji 的代理对切坏成乱码） */
export function truncate (s: unknown, max: number): string {
  const str = s === null || s === undefined ? '' : String(s);
  const cp = Array.from(str);
  return cp.length > max ? cp.slice(0, max).join('') + '...' : str;
}

/** 时间统一按东八区展示，与页脚保持一致（机器人可能跑在 UTC 容器里） */
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** 格式化时间；空值/非法日期返回空串，不输出 NaN-NaN-NaN */
export function fmtTime (iso: unknown): string {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  const p: Record<string, string> = {};
  for (const part of TIME_FMT.formatToParts(d)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

// ===== 内置主题 =====
const THEME_LIGHT: ThemeColors = {
  bg: '#ffffff', card: '#f6f8fa', border: '#d0d7de', divider: '#d8dee4',
  text: '#1f2328', textSub: '#656d76', textMuted: '#8b949e',
  codeBg: '#f6f8fa', codeHeader: '#eaeef2',
};

const THEME_DARK: ThemeColors = {
  bg: '#0d1117', card: '#161b22', border: '#30363d', divider: '#21262d',
  text: '#e6edf3', textSub: '#8b949e', textMuted: '#484f58',
  codeBg: '#0d1117', codeHeader: '#1c2128',
};

/** 合法的 CSS 颜色（自定义主题来自 WebUI，是用户可写字段，不能原样插进 <style>） */
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\))$/;

function safeColor (v: unknown, fallback: string): string {
  return typeof v === 'string' && CSS_COLOR_RE.test(v.trim()) ? v.trim() : fallback;
}

/** 获取当前主题色 */
export function getTheme (): ThemeColors {
  const mode = pluginState.config.theme || 'light';
  let base: ThemeColors;
  if (mode === 'dark') {
    base = THEME_DARK;
  } else if (mode === 'custom' && pluginState.config.customTheme) {
    base = { ...THEME_LIGHT, ...pluginState.config.customTheme };
  } else {
    base = THEME_LIGHT;
  }
  // 逐个字段校验：customTheme 的值会直接进 CSS 与 SVG 属性，
  // 一个 "</style><script>" 就能跳出样式表执行脚本（WebUI 的 /config 是无鉴权 POST）。
  const out = { ...base };
  for (const k of Object.keys(out) as (keyof ThemeColors)[]) {
    out[k] = safeColor(out[k], THEME_LIGHT[k]);
  }
  return out;
}

// ===== SVG 图标（替代 emoji，避免服务器无字体显示方块） =====
const SVG = {
  commit: `<svg width="20" height="20" viewBox="0 0 16 16" fill="#3fb950"><path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.25a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`,
  issue: `<svg width="20" height="20" viewBox="0 0 16 16" fill="#8957e5"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`,
  pr: `<svg width="20" height="20" viewBox="0 0 16 16" fill="#db6d28"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`,
  dotOpen: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#3fb950"/></svg>`,
  dotClosed: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#f85149"/></svg>`,
  dotMerged: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#a371f7"/></svg>`,
  comment: `<svg width="20" height="20" viewBox="0 0 16 16" fill="#58a6ff"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`,
  actions: `<svg width="20" height="20" viewBox="0 0 16 16" fill="#d29922"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/></svg>`,
  // 分隔点（替代 · 中点字符）
  sep: `<svg width="4" height="4" viewBox="0 0 4 4" style="display:inline-block;vertical-align:middle;margin:0 5px"><circle cx="2" cy="2" r="2" fill="currentColor" opacity="0.4"/></svg>`,
  // 用户图标（替代 @ 字符）
  user: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:1px;opacity:0.5"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`,
  // 列表项圆点（替代 • 字符）
  bullet: `<svg width="6" height="6" viewBox="0 0 6 6" style="display:inline-block;vertical-align:middle;margin-right:6px"><circle cx="3" cy="3" r="3" fill="currentColor" opacity="0.4"/></svg>`,
};

/** 调用 puppeteer 插件渲染 HTML 为 base64 图片 */
export async function renderToBase64 (html: string): Promise<string | null> {
  try {
    // httpPort 是运行时探测到的实际端口；config.webuiPort 只是用户手填的期望值。
    // 原来只读 webuiPort，端口不是 6099 时每张图都静默降级成纯文本。
    const port = pluginState.httpPort || pluginState.config.webuiPort || 6099;
    const host = `http://127.0.0.1:${port}`;
    const url = `${host}/plugin/napcat-plugin-puppeteer/api/render`;

    pluginState.debug(`调用 puppeteer 渲染，HTML 长度: ${html.length}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        file_type: 'htmlString',
        selector: 'body',
        type: 'png',
        encoding: 'base64',
        setViewport: { width: 600, height: 100 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json() as { code: number; data?: string; message?: string; };
    if (data.code === 0 && data.data) {
      pluginState.debug('puppeteer 渲染成功');
      return data.data;
    }
    pluginState.log('warn', `puppeteer 渲染失败: ${data.message || '未知错误'}`);
    return null;
  } catch (e) {
    pluginState.log('error', `puppeteer 渲染请求失败: ${e}`);
    return null;
  }
}

/** 通用 HTML 模板（主题驱动） */
export function wrapHTML (repo: string, typeName: string, color: string, icon: string, count: number, content: string): string {
  const t = getTheme();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:${t.bg};color:${t.text};padding:20px;width:600px}
.card{background:${t.card};border:1px solid ${t.border};border-radius:12px;overflow:hidden}
.header{padding:16px 20px;border-bottom:1px solid ${t.border};display:flex;align-items:center;gap:12px}
.header-icon{display:flex;align-items:center}
.header-info h2{font-size:16px;font-weight:600;color:${t.text}}
.header-info .repo{font-size:13px;color:${t.textSub};margin-top:2px}
.badge{background:${color}20;color:${color};border:1px solid ${color}40;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500;margin-left:auto}
.body{padding:12px 20px}
.item{padding:10px 0;border-bottom:1px solid ${t.divider}}
.item:last-child{border-bottom:none}
.item-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px}
.sha{background:${t.border};color:#7ee787;padding:1px 6px;border-radius:4px;font-family:monospace;font-size:11px}
.author{color:${t.textSub}}
.time{color:${t.textMuted};margin-left:auto;font-size:11px}
.msg{font-size:13px;color:${t.text};line-height:1.5}
.label{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;margin-left:4px}
.footer{padding:10px 20px;border-top:1px solid ${t.border};text-align:center;font-size:11px;color:${t.textMuted}}
.diff-file{margin-top:8px;border:1px solid ${t.border};border-radius:6px;overflow:hidden}
.diff-name{padding:4px 10px;background:${t.codeHeader};font-size:11px;font-family:monospace;color:${t.textSub};display:flex;align-items:center;gap:6px;border-bottom:1px solid ${t.border}}
.diff-name .add{color:#3fb950}.diff-name .del{color:#f85149}
.diff-code{padding:6px 10px;font-family:monospace;font-size:10px;line-height:1.6;white-space:pre-wrap;word-break:break-all;background:${t.codeBg};color:${t.textSub}}
.diff-code .l-add{color:#3fb950;background:rgba(63,185,80,.1)}
.diff-code .l-del{color:#f85149;background:rgba(248,81,73,.1)}
.diff-code .l-hunk{color:#79c0ff}
.diff-more{padding:6px 10px;font-size:10px;color:${t.textSub};text-align:center;background:${t.codeBg};border-top:1px solid ${t.divider}}
.st-dot{display:inline-flex;align-items:center;vertical-align:middle;margin-right:2px}
.action-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:500;margin-left:6px}
</style></head><body>
<div class="card">
  <div class="header">
    <span class="header-icon">${icon}</span>
    <div class="header-info"><h2>${esc(typeName)} 更新</h2><div class="repo">${esc(repo)}</div></div>
    <span class="badge">${count} 条新更新</span>
  </div>
  <div class="body">${content}</div>
  <div class="footer">GitHub Subscription ${SVG.sep} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>
</div>
</body></html>`;
}

/**
 * 渲染 patch 内容为带颜色的 diff。
 *
 * 单行超长时不能整行丢弃：minified 文件（一行几万字符）会让第一行就 break，
 * diff 框整个空白，用户看到的是「有文件变更但内容一片空白」。
 * 正确做法是把这一行按剩余预算裁掉，然后收尾。
 */
export function renderPatch (patch: unknown, maxChars: number): string {
  if (typeof patch !== 'string' || !patch) return '';
  const lines = patch.split('\n');
  let charCount = 0;
  let truncated = false;
  const rendered: string[] = [];
  for (const line of lines) {
    if (charCount >= maxChars) { truncated = true; break; }
    const budget = maxChars - charCount;
    const shown = line.length > budget ? line.slice(0, budget) : line;
    if (shown.length < line.length) truncated = true;
    charCount += shown.length + 1;
    const escaped = esc(shown);
    if (shown.startsWith('+')) rendered.push(`<div class="l-add">${escaped}</div>`);
    else if (shown.startsWith('-')) rendered.push(`<div class="l-del">${escaped}</div>`);
    else if (shown.startsWith('@@')) rendered.push(`<div class="l-hunk">${escaped}</div>`);
    else rendered.push(`<div>${escaped}</div>`);
    if (truncated) break;
  }
  if (truncated) rendered.push(`<div style="color:#8b949e;font-style:italic">... 内容过长已截断</div>`);
  return rendered.join('');
}

/** 生成单个文件的 diff HTML */
function fileDiffHTML (file: { filename?: string; status?: string; additions?: number; deletions?: number; patch?: string; }): string {
  const patchContent = file?.patch
    ? renderPatch(file.patch, 3000)
    : '<div style="color:#8b949e">（二进制文件或无变更内容）</div>';
  return `<div class="diff-file"><div class="diff-name"><span>${esc(file?.filename)}</span><span class="add">+${file?.additions ?? 0}</span><span class="del">-${file?.deletions ?? 0}</span></div><div class="diff-code">${patchContent}</div></div>`;
}

/** 生成 Commits HTML（含 diff） */
export function commitsHTML (repo: string, commits: CommitData[]): string {
  const list = Array.isArray(commits) ? commits : [];
  // 多 commit 时限制显示数量，避免图片过大
  const showCommits = list.slice(0, 5);
  const restCommits = list.length - showCommits.length;
  const rows = showCommits.map(c => {
    // 这几处原来全是裸访问（c.commit.message / c.commit.author.name / c.sha），
    // 合并 PR 的空 commit、被删除的账号都会让 commit.author 为 null —— 一抛错整张卡片就没了
    const msg = esc(truncate(String(c?.commit?.message || '').split('\n')[0], 80));
    const author = esc(c?.commit?.author?.name || 'unknown');
    const sha = esc(String(c?.sha || '').slice(0, 7));
    const time = fmtTime(c?.commit?.author?.date);
    let diffHtml = '';
    const files = Array.isArray(c?.files) ? c.files : [];
    if (files.length) {
      const show = files.slice(0, 5);
      const rest = files.length - show.length;
      diffHtml = show.map(f => fileDiffHTML(f)).join('');
      if (rest > 0) diffHtml += `<div class="diff-more">还有 ${rest} 个文件变更</div>`;
    }
    return `<div class="item"><div class="item-header"><span class="sha">${sha}</span><span class="author">${author}</span><span class="time">${time}</span></div><div class="msg">${msg}</div>${diffHtml}</div>`;
  }).join('');
  const extra = restCommits > 0 ? `<div class="diff-more">还有 ${restCommits} 条 commit，请前往 GitHub 查看</div>` : '';
  return wrapHTML(repo, 'Commits', '#2ea44f', SVG.commit, list.length, rows + extra);
}

/** Markdown 风格渲染容器 */
function wrapMarkdownHTML (repo: string, typeName: string, color: string, icon: string, count: number, mdBody: string): string {
  const t = getTheme();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:${t.bg};color:${t.text};padding:20px;width:600px}
.card{background:${t.card};border:1px solid ${t.border};border-radius:12px;overflow:hidden}
.hd{padding:16px 20px;border-bottom:1px solid ${t.border};display:flex;align-items:center;gap:12px}
.hd-icon{display:flex;align-items:center}
.hd h2{font-size:16px;font-weight:600;color:${t.text}}
.hd .repo{font-size:13px;color:${t.textSub};margin-top:2px}
.hd .badge{background:${color}20;color:${color};border:1px solid ${color}40;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500;margin-left:auto}
.md{padding:16px 20px;font-size:13px;line-height:1.7;color:${t.text}}
.md h3{font-size:14px;font-weight:600;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid ${t.divider};color:${t.text}}
.md h3:first-child{margin-top:0}
.md p{margin:4px 0}
.md code{background:${t.codeBg};border:1px solid ${t.border};padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px}
.md blockquote{margin:6px 0;padding:6px 14px;border-left:3px solid ${t.border};color:${t.textSub};background:${t.codeBg};border-radius:0 6px 6px 0;font-size:12px;line-height:1.6}
.md ul{padding-left:20px;margin:4px 0}
.md li{margin:2px 0}
.md .tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:500;margin-left:4px}
.md .tag-open{background:rgba(63,185,80,.12);color:#3fb950}
.md .tag-closed{background:rgba(248,81,73,.12);color:#f85149}
.md .tag-merged{background:rgba(163,113,247,.12);color:#a371f7}
.md .tag-reopened{background:rgba(210,153,34,.12);color:#d29922}
.md .lbl{display:inline-block;padding:0 6px;border-radius:8px;font-size:10px;margin-left:3px}
.md .meta{font-size:11px;color:${t.textMuted}}
.md hr{border:none;border-top:1px solid ${t.divider};margin:8px 0}
.ft{padding:10px 20px;border-top:1px solid ${t.border};text-align:center;font-size:11px;color:${t.textMuted}}
</style></head><body>
<div class="card">
  <div class="hd">
    <span class="hd-icon">${icon}</span>
    <div><h2>${esc(typeName)} 更新</h2><div class="repo">${esc(repo)}</div></div>
    <span class="badge">${count} 条新更新</span>
  </div>
  <div class="md">${mdBody}</div>
  <div class="ft">GitHub Subscription ${SVG.sep} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>
</div>
</body></html>`;
}

/** 动作 → Markdown 标签 */
export function mdActionTag (action?: string, state?: string): string {
  const a = action || state || '';
  const map: Record<string, string> = { opened: 'tag-open', closed: 'tag-closed', reopened: 'tag-reopened', merged: 'tag-merged', open: 'tag-open' };
  const cls = map[a] || '';
  const textMap: Record<string, string> = { opened: '新建', closed: '已关闭', reopened: '重新打开', merged: '已合并', open: '打开中' };
  const text = textMap[a] || a;
  return text ? `<span class="tag ${cls}">${esc(text)}</span>` : '';
}

/** 简易 Markdown body → HTML（处理代码块、引用、列表等） */
export function mdBodyToHTML (raw: unknown, maxLen = 3000): string {
  // 入参来自 GitHub 的 issue/PR/comment 正文，字段可能缺失或不是字符串。
  // 原来签名是 `string | null`，`if (!raw) return ''` 只挡住 null，
  // 传数字/对象时 raw.length 是 undefined、raw.slice 直接抛 TypeError。
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  if (!text) return '';
  let s = text.length > maxLen ? text.slice(0, maxLen) + '\n\n...(内容过长已截断)' : text;

  // 保存代码块，避免被后续处理干扰
  const codeBlocks: string[] = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre style="background:rgba(110,118,129,.1);border:1px solid rgba(110,118,129,.2);border-radius:6px;padding:8px 12px;font-family:monospace;font-size:11px;line-height:1.6;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0">${esc(code.trim())}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // 保存行内代码
  const inlineCodes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code style="background:rgba(110,118,129,.15);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:12px">${esc(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // 转义 HTML
  s = esc(s);

  // 标题 ### / ## / #
  s = s.replace(/^#{3}\s+(.+)$/gm, '<div style="font-size:13px;font-weight:600;margin:10px 0 4px;border-bottom:1px solid rgba(110,118,129,.2);padding-bottom:3px">$1</div>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<div style="font-size:14px;font-weight:700;margin:12px 0 4px;border-bottom:1px solid rgba(110,118,129,.2);padding-bottom:3px">$1</div>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<div style="font-size:15px;font-weight:700;margin:14px 0 6px;border-bottom:1px solid rgba(110,118,129,.3);padding-bottom:4px">$1</div>');

  // 加粗 **text**
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // 斜体 *text*：要求两侧不是星号，避免 **** 之类嵌套时错配
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  // 斜体 _text_：必须有词边界。
  // 原来 /_(.+?)_/ 会把 snake_case_name 变成 snake<i>case</i>name —— 代码标识符在 issue 正文里极常见。
  s = s.replace(/(?<![\w])_(?!_)(.+?)(?<![\w])_(?![\w])/g, '<i>$1</i>');
  // 删除线 ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 无序列表 - item（使用 CSS 圆点替代 • 字符）
  s = s.replace(/^[-*]\s+(.+)$/gm, '<div style="padding-left:16px;display:flex;align-items:baseline;gap:0"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0.4;flex-shrink:0;margin-right:6px;margin-top:6px"></span><span>$1</span></div>');
  // 有序列表 1. item（使用 CSS 圆点替代 · 字符）
  s = s.replace(/^\d+\.\s+(.+)$/gm, (_, content) => `<div style="padding-left:16px;display:flex;align-items:baseline;gap:0"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:0.35;flex-shrink:0;margin-right:6px;margin-top:7px"></span><span>${content}</span></div>`);

  // GitHub emoji :name: → 移除冒号显示名称（服务器无 emoji 字体）
  // 必须以字母开头且至少 2 字符：原来允许纯数字，会把 10:30:45 变成 10[30]45、把
  // 端口号 127.0.0.1:8080: 之类的文本也吃掉；单个字母的 :x: 也不是合法 emoji 名。
  s = s.replace(/:([a-z][a-z0-9_+-]+):/g, '[$1]');

  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span style="color:#58a6ff;text-decoration:underline">$1</span>');

  // 引用 > text
  s = s.replace(/^&gt;\s?(.+)$/gm, '<div style="padding:4px 12px;border-left:3px solid rgba(110,118,129,.3);color:rgba(139,148,158,1);margin:4px 0">$1</div>');

  // 分隔线 ---
  s = s.replace(/^-{3,}$/gm, '<hr style="border:none;border-top:1px solid rgba(110,118,129,.2);margin:8px 0">');

  // 恢复代码块
  s = s.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)] || '');
  // 恢复行内代码
  s = s.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[Number(idx)] || '');

  // 换行
  s = s.replace(/\n/g, '<br>');

  return s;
}

/** 生成 Issues Markdown 风格 HTML */
export function issuesHTML (repo: string, issues: IssueData[]): string {
  const list = Array.isArray(issues) ? issues : [];
  const rows = list.map(i => {
    const title = esc(truncate(i?.title, 80));
    const author = esc(i?.user?.login || 'unknown');
    const time = fmtTime(i?.created_at);
    const tag = mdActionTag(i?.action, i?.state);
    // 标签颜色来自仓库维护者填写的 label.color，是 GitHub 侧的可写字段。
    // esc() 只挡 HTML 特殊字符，挡不住 CSS 注入：color 填成
    // `red;background:url(http://attacker/x)` 就能带出一次外部请求。
    // 这里只允许 3/6/8 位十六进制。
    const hex = (c: unknown): string => {
      const s = String(c ?? '').trim().replace(/^#/, '');
      return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(s) ? s : '888888';
    };
    const labels = (Array.isArray(i?.labels) ? i.labels : [])
      .map((l) => {
        const c = hex(l?.color);
        return `<span class="lbl" style="background:#${c}20;color:#${c};border:1px solid #${c}40">${esc(l?.name)}</span>`;
      })
      .join('');
    const body = i?.body ? `<blockquote>${mdBodyToHTML(i.body, 3000)}</blockquote>` : '';
    return `<h3><code>#${i?.number ?? 0}</code> ${title} ${tag}${labels}</h3>
<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p>${body}`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Issues', '#8957e5', SVG.issue, list.length, rows);
}

/** 生成 Pull Requests Markdown 风格 HTML */
export function pullsHTML (repo: string, pulls: IssueData[]): string {
  const list = Array.isArray(pulls) ? pulls : [];
  const rows = list.map(p => {
    const title = esc(truncate(p?.title, 80));
    // 原来用 "${p.title}" 直接拼进日志：标题里的换行会伪造出一条独立日志行
    pluginState.debug(`[渲染PR] #${p?.number ?? 0} title=${JSON.stringify(p?.title ?? '')}`);
    const author = esc(p?.user?.login || 'unknown');
    const time = fmtTime(p?.created_at);
    const tag = mdActionTag(p?.action, p?.state);
    return `<h3><code>#${p?.number ?? 0}</code> ${title} ${tag}</h3>
<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p>`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Pull Requests', '#db6d28', SVG.pr, list.length, rows);
}

/** 生成 Comments Markdown 风格 HTML */
export function commentsHTML (repo: string, comments: CommentData[]): string {
  const list = Array.isArray(comments) ? comments : [];
  // 按 Issue/PR 编号分组
  const grouped = new Map<number, CommentData[]>();
  for (const c of list) {
    const num = c?.number ?? 0;
    const arr = grouped.get(num) || [];
    arr.push(c);
    grouped.set(num, arr);
  }

  const sections: string[] = [];
  for (const [num, group] of grouped) {
    const first = group[0];
    const srcLabel = first?.source === 'pull_request' ? 'PR' : 'Issue';
    const title = esc(truncate(first?.title, 60));
    let html = `<h3><code>${srcLabel} #${num}</code> ${title} <span class="meta">(${group.length} 条评论)</span></h3>`;
    for (const c of group) {
      const author = esc(c?.user?.login || 'unknown');
      const time = fmtTime(c?.created_at);
      const body = mdBodyToHTML(c?.body, 3000);
      html += `<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p><blockquote>${body}</blockquote>`;
    }
    sections.push(html);
  }

  return wrapMarkdownHTML(repo, 'Comments', '#58a6ff', SVG.comment, list.length, sections.join('<hr>'));
}


/** 生成 Actions Markdown 风格 HTML */
export function actionsHTML (repo: string, runs: ActionRunData[]): string {
  const list = Array.isArray(runs) ? runs : [];
  const rows = list.map(r => {
    const name = esc(truncate(r?.name, 60));
    const actor = esc(r?.actor?.login || 'unknown');
    const time = fmtTime(r?.created_at);
    // 运行中的 workflow 没有 conclusion（只有 status=in_progress），两者都缺失时不能输出 undefined
    const conclusion = String(r?.conclusion || r?.status || '');
    const cMap: Record<string, { text: string; cls: string; }> = {
      success: { text: '成功', cls: 'tag-open' },
      failure: { text: '失败', cls: 'tag-closed' },
      cancelled: { text: '已取消', cls: 'tag-reopened' },
      in_progress: { text: '运行中', cls: 'tag-reopened' },
      queued: { text: '排队中', cls: '' },
    };
    const c = cMap[conclusion] || { text: conclusion || '未知', cls: '' };
    const tag = `<span class="tag ${c.cls}">${esc(c.text)}</span>`;
    return `<h3><code>#${r?.run_number ?? 0}</code> ${name} ${tag}</h3>
<p class="meta">${SVG.user}${actor} ${SVG.sep} ${esc(r?.event)} ${SVG.sep} ${esc(r?.head_branch)} ${SVG.sep} ${time}</p>`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Actions', '#d29922', SVG.actions, list.length, rows);
}

/**
 * 格式化数字（k/m 缩写）。
 *
 * 原来只判断 >= 1000 就 toFixed(1) + 'k'：999999 会输出 "1000.0k"（该进位到 1m），
 * 999950 也一样。改成先四舍五入到一位小数，再判断是否跨过 1000/1000000。
 * 入参可能是 undefined（接口字段缺失），统一当 0。
 */
export function fmtNum (n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  if (abs >= 999950) return (v / 1000000).toFixed(1) + 'm';
  if (abs >= 999.5) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** 渲染仓库信息卡片 HTML */
export function repoCardHTML (repo: RepoInfo, readme: string | null): string {
  const t = getTheme();
  const r = (repo ?? {}) as RepoInfo;
  const desc = r.description ? esc(truncate(r.description, 120)) : '<span style="opacity:0.5">No description</span>';
  const lang = r.language ? esc(r.language) : '';
  const license = r.license?.name ? esc(r.license.name) : '';
  const topics = (Array.isArray(r.topics) ? r.topics : []).slice(0, 8).map(tp =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:rgba(31,111,235,0.1);color:#1f6feb;border:1px solid rgba(31,111,235,0.2);margin:2px 3px 2px 0">${esc(tp)}</span>`
  ).join('');

  // README 渲染（截断到合理长度）
  let readmeHTML = '';
  if (readme) {
    const truncatedReadme = readme.length > 6000 ? readme.slice(0, 6000) + '\n\n...(README 内容过长已截断)' : readme;
    readmeHTML = `
    <div style="border-top:1px solid ${t.border};padding:16px 20px">
      <div style="font-size:13px;font-weight:600;color:${t.text};margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"/></svg>
        README.md
      </div>
      <div style="font-size:13px;line-height:1.7;color:${t.text};word-break:break-word">${mdBodyToHTML(truncatedReadme, 6000)}</div>
    </div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:${t.bg};color:${t.text};padding:20px;width:600px}
.card{background:${t.card};border:1px solid ${t.border};border-radius:12px;overflow:hidden}
</style></head><body>
<div class="card">
  <div style="padding:16px 20px;border-bottom:1px solid ${t.border};display:flex;align-items:center;gap:12px">
    <div style="width:40px;height:40px;background:#24292f;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <svg width="22" height="22" viewBox="0 0 16 16" fill="#fff"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>
    </div>
    <div style="flex:1;min-width:0">
      <div style="font-size:16px;font-weight:600;color:#1f6feb">${esc(r.full_name)}</div>
      <div style="font-size:13px;color:${t.textSub};margin-top:2px;line-height:1.4">${desc}</div>
    </div>
  </div>

  <div style="padding:12px 20px;display:flex;flex-wrap:wrap;gap:16px;border-bottom:1px solid ${t.border};font-size:12px;color:${t.textSub}">
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="#e3b341"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
      ${fmtNum(r.stargazers_count)}
    </span>
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>
      ${fmtNum(r.forks_count)}
    </span>
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>
      ${fmtNum(r.open_issues_count)} issues
    </span>
    ${lang ? `<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:50%;background:#3178c6;display:inline-block"></span>${esc(lang)}</span>` : ''}
    ${license ? `<span style="display:flex;align-items:center;gap:4px"><svg width="14" height="14" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M8.75.75V2h.985c.304 0 .603.08.867.231l1.29.736c.038.022.08.033.124.033h2.234a.75.75 0 0 1 0 1.5h-.427l2.111 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01a3.2 3.2 0 0 1-.149.135 4.5 4.5 0 0 1-.488.365c-.431.278-1.09.558-1.942.558-.852 0-1.511-.28-1.942-.558a4.5 4.5 0 0 1-.488-.365 3.2 3.2 0 0 1-.15-.136l-.01-.01-.005-.005a.75.75 0 0 1-.154-.838L12.178 4.5h-.162c-.305 0-.604-.079-.868-.231l-1.29-.736a.245.245 0 0 0-.124-.033H8.75V13h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5V3.5h-.984a.245.245 0 0 0-.124.033l-1.29.736c-.264.152-.563.231-.868.231h-.162l2.112 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01a3.2 3.2 0 0 1-.149.135 4.5 4.5 0 0 1-.488.365c-.431.278-1.09.558-1.942.558-.852 0-1.511-.28-1.942-.558a4.5 4.5 0 0 1-.488-.365 3.2 3.2 0 0 1-.15-.136l-.01-.01-.005-.005a.75.75 0 0 1-.154-.838L3.822 4.5h-.427a.75.75 0 0 1 0-1.5h2.234a.249.249 0 0 0 .125-.033l1.29-.736c.264-.152.563-.231.867-.231h.985V.75a.75.75 0 0 1 1.5 0Z"/></svg>${esc(license)}</span>` : ''}
  </div>

  ${topics ? `<div style="padding:10px 20px;border-bottom:1px solid ${t.border}">${topics}</div>` : ''}

  ${readmeHTML}

  <div style="padding:10px 20px;border-top:1px solid ${t.border};text-align:center;font-size:11px;color:${t.textMuted}">
    GitHub Repo Card ${SVG.sep} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
  </div>
</div>
</body></html>`;
}

/** 渲染仓库信息卡片 */
export async function renderRepoCard (repo: RepoInfo, readme: string | null): Promise<string | null> {
  return safeRender(() => repoCardHTML(repo, readme), 'RepoCard');
}

/** 仓库信息文本摘要（降级用） */
export function repoSummary (repo: RepoInfo): string {
  // 兜底文本自己绝不能再抛错，字段一律 ?? 顶上
  const r = (repo ?? {}) as RepoInfo;
  const lines = [
    `📦 ${r.full_name || '(未知仓库)'}`,
    r.description || '',
    `⭐ ${r.stargazers_count ?? 0} | 🍴 ${r.forks_count ?? 0} | 📝 ${r.open_issues_count ?? 0} issues`,
    r.language ? `语言: ${r.language}` : '',
    `🔗 ${r.html_url || ''}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/** 文本摘要（降级用） */
export function commitsSummary (repo: string, commits: CommitData[]): string {
  const list = Array.isArray(commits) ? commits : [];
  const lines = [`[${repo}] ${list.length} 条新 Commit\n`];
  for (const c of list) {
    // 降级文本是「渲染失败时的兜底」，这里绝不能再抛异常，
    // 否则用户什么都收不到。字段缺失一律用占位符顶上。
    const msg = String(c?.commit?.message || '').split('\n')[0].slice(0, 60) || '(无提交说明)';
    const sha = String(c?.sha || '').slice(0, 7) || '???????';
    const author = c?.commit?.author?.name || 'unknown';
    lines.push(`* ${sha} ${author}: ${msg}`);
  }
  return lines.join('\n');
}

export function issuesSummary (repo: string, issues: IssueData[], type: 'Issues' | 'Pull Requests'): string {
  const list = Array.isArray(issues) ? issues : [];
  const lines = [`[${repo}] ${list.length} 条新 ${type}\n`];
  for (const i of list) {
    const actionText = i?.action ? `[${i.action}]` : (i?.state === 'open' ? '[open]' : '[closed]');
    const title = String(i?.title || '').slice(0, 50) || '(无标题)';
    const who = i?.user?.login || 'unknown';
    lines.push(`${actionText} #${i?.number ?? '?'} ${title} - ${who}`);
  }
  return lines.join('\n');
}

export function commentsSummary (repo: string, comments: CommentData[]): string {
  const list = Array.isArray(comments) ? comments : [];
  const lines = [`[${repo}] ${list.length} 条新评论\n`];
  for (const c of list) {
    const src = c?.source === 'pull_request' ? 'PR' : 'Issue';
    const body = String(c?.body || '').replace(/\n/g, ' ').slice(0, 500) || '(无内容)';
    const who = c?.user?.login || 'unknown';
    lines.push(`[${src}#${c?.number ?? '?'}] ${who}: ${body}`);
  }
  return lines.join('\n');
}

export function actionsSummary (repo: string, runs: ActionRunData[]): string {
  const list = Array.isArray(runs) ? runs : [];
  const lines = [`[${repo}] ${list.length} 条 Actions 更新\n`];
  for (const r of list) {
    const c = String(r?.conclusion || r?.status || 'unknown');
    const who = r?.actor?.login || 'unknown';
    lines.push(`#${r?.run_number ?? '?'} ${r?.name || '(未命名)'} [${c}] - ${who}`);
  }
  return lines.join('\n');
}

/** 渲染 Actions */
export async function renderActions (repo: string, runs: ActionRunData[]): Promise<string | null> {
  return safeRender(() => actionsHTML(repo, runs), 'Actions');
}

/**
 * 自定义模板变量替换。
 *
 * 三处加固：
 * 1. tpl/vars 缺失不抛错（签名上 vars 可选，新增调用点忘传参数不该整条推送崩）
 * 2. 只认自有属性 —— 否则 {{constructor}} / {{__proto__}} 会命中 Object.prototype
 * 3. {{ items }} 这种带空格的写法也认（WebUI 文档里就是这么写的）
 */
export function tplReplace (tpl: string, vars?: Record<string, string>): string {
  if (typeof tpl !== 'string') return '';
  const safe = vars ?? {};
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(safe, key) && typeof safe[key] === 'string' ? safe[key] : '');
}

/**
 * 安全渲染：构建 HTML 的任一步出错都返回 null（而不是 reject）。
 *
 * 所有 renderXxx 的签名都是 Promise<string | null>，调用方据此降级成纯文本。
 * 但函数体原来没有任何 try —— 数据一脏就 reject，poller 里
 * 非合并模式会跳过该仓库后续推送，合并模式 poll() 没有 catch，
 * 连 mergedRepoSummary 生成的兜底文本都来不及用，整群这一轮静默丢失。
 * 越是数据脏（最需要兜底）的时候，兜底越不生效。
 */
export async function safeRender (build: () => string, label: string): Promise<string | null> {
  try {
    return await renderToBase64(build());
  } catch (e) {
    pluginState.log('error', `构建 ${label} HTML 失败，降级为文本: ${e}`);
    return null;
  }
}

/** 内联到 HTML/JS 的 JSON 必须转义 < > & 和 U+2028/2029，否则能闭合 <script> */
export function safeJson (v: unknown): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** 构建 commits 的模板变量 */
function commitsTplVars (repo: string, commits: CommitData[]): Record<string, string> {
  const itemsJson = safeJson(commits.map(c => ({
    sha: String(c?.sha || ''), sha7: String(c?.sha || '').slice(0, 7),
    message: String(c?.commit?.message || '').split('\n')[0],
    author: c?.commit?.author?.name || 'unknown', date: c?.commit?.author?.date || '',
    url: c?.html_url || '',
    files: (c?.files || []).map(f => ({
      filename: String(f?.filename || ''), status: String(f?.status || ''),
      additions: f?.additions ?? 0, deletions: f?.deletions ?? 0, patch: String(f?.patch || ''),
    })),
  })));
  return {
    repo: esc(repo), count: String(commits.length), type: 'Commits',
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    items: itemsJson,
  };
}

/** 构建 issues/pulls 的模板变量 */
function issuesTplVars (repo: string, items: IssueData[], type: string): Record<string, string> {
  const itemsJson = safeJson(items.map(i => ({
    number: i?.number ?? 0, title: String(i?.title || ''), state: String(i?.state || ''),
    action: String(i?.action || ''),
    author: i?.user?.login || 'unknown', created_at: String(i?.created_at || ''),
    url: String(i?.html_url || ''),
    labels: (i?.labels || []).map(l => ({ name: String(l?.name || ''), color: String(l?.color || '') })),
  })));
  return {
    repo: esc(repo), count: String(items.length), type,
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    items: itemsJson,
  };
}

/** 渲染 Commits 并返回 base64 图片（失败返回 null） */
export async function renderCommits (repo: string, commits: CommitData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.commits;
  return safeRender(() => {
    if (typeof custom === 'string' && custom) {
      pluginState.debug('[渲染] 使用自定义 Commits 模板');
      return tplReplace(custom, commitsTplVars(repo, commits));
    }
    return commitsHTML(repo, commits);
  }, 'Commits');
}

/** 渲染 Issues */
export async function renderIssues (repo: string, issues: IssueData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.issues;
  return safeRender(() => {
    if (typeof custom === 'string' && custom) {
      pluginState.debug('[渲染] 使用自定义 Issues 模板');
      return tplReplace(custom, issuesTplVars(repo, issues, 'Issues'));
    }
    return issuesHTML(repo, issues);
  }, 'Issues');
}

/** 渲染 Pull Requests */
export async function renderPulls (repo: string, pulls: IssueData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.pulls;
  return safeRender(() => {
    if (typeof custom === 'string' && custom) {
      pluginState.debug('[渲染] 使用自定义 Pulls 模板');
      return tplReplace(custom, issuesTplVars(repo, pulls, 'Pull Requests'));
    }
    return pullsHTML(repo, pulls);
  }, 'Pulls');
}

/** 渲染 Comments */
export async function renderComments (repo: string, comments: CommentData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.comments;
  return safeRender(() => {
    if (typeof custom === 'string' && custom) {
      pluginState.debug('[渲染] 使用自定义 Comments 模板');
      const itemsJson = safeJson(comments.map(c => ({
        number: c?.number ?? 0, title: String(c?.title || ''), body: String(c?.body || ''),
        author: c?.user?.login || 'unknown',
        created_at: String(c?.created_at || ''), url: String(c?.html_url || ''),
        source: String(c?.source || ''),
      })));
      return tplReplace(custom, {
        repo: esc(repo), count: String(comments.length), type: 'Comments',
        time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        items: itemsJson,
      });
    }
    return commentsHTML(repo, comments);
  }, 'Comments');
}

/** 事件类型 → 中文描述 + 颜色 */
const USER_EVENT_MAP: Record<string, { icon: string; color: string; }> = {
  PushEvent: { icon: SVG.commit, color: '#3fb950' },
  CreateEvent: { icon: SVG.commit, color: '#58a6ff' },
  DeleteEvent: { icon: SVG.commit, color: '#f85149' },
  IssuesEvent: { icon: SVG.issue, color: '#8957e5' },
  IssueCommentEvent: { icon: SVG.comment, color: '#58a6ff' },
  PullRequestEvent: { icon: SVG.pr, color: '#db6d28' },
  PullRequestReviewEvent: { icon: SVG.pr, color: '#db6d28' },
  PullRequestReviewCommentEvent: { icon: SVG.comment, color: '#db6d28' },
  WatchEvent: { icon: SVG.commit, color: '#e3b341' },
  ForkEvent: { icon: SVG.commit, color: '#58a6ff' },
  ReleaseEvent: { icon: SVG.commit, color: '#3fb950' },
};

/** 生成用户活动 HTML */
export function userActivityHTML (username: string, items: UserActivityItem[]): string {
  const t = getTheme();
  const list = Array.isArray(items) ? items : [];
  const showItems = list.slice(0, 20);
  const restItems = list.length - showItems.length;
  const rows = showItems.map(item => {
    const ev = USER_EVENT_MAP[String(item?.type || '')] || { icon: SVG.commit, color: t.textSub };
    const time = fmtTime(item?.time);
    return `<div class="item">
  <div class="item-header">
    <span class="header-icon" style="display:inline-flex;align-items:center">${ev.icon}</span>
    <span style="color:${ev.color};font-weight:500;font-size:12px">${esc(String(item?.type || '').replace('Event', ''))}</span>
    <span style="color:${t.textSub};font-size:12px">${esc(item?.repo)}</span>
    <span class="time">${time}</span>
  </div>
  <div class="msg">${esc(truncate(item?.desc, 120))}</div>
</div>`;
  }).join('');

  const extra = restItems > 0 ? `<div class="diff-more">还有 ${restItems} 条动态</div>` : '';
  const userIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="#58a6ff"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;
  // 用户名放在 typeName 位置，wrapHTML 里已对 typeName 做 esc —— 原来这里直接拼进 <h2>，
  // 而 /user/add 是无鉴权 POST、QQ 指令也只拒绝 '/'，构成存储型 HTML 注入
  return wrapHTML(username, `${username} 动态`, '#58a6ff', userIcon, list.length, rows + extra);
}

/** 渲染用户活动 */
export async function renderUserActivity (username: string, items: UserActivityItem[]): Promise<string | null> {
  return safeRender(() => userActivityHTML(username, items), 'UserActivity');
}

/** 用户活动文本摘要（降级用） */
export function userActivitySummary (username: string, items: UserActivityItem[]): string {
  const list = Array.isArray(items) ? items : [];
  const lines = [`[${username}] ${list.length} 条新动态\n`];
  for (const item of list) {
    // 兜底文本不能抛错：type/desc 在脏数据下可能是 null
    const type = String(item?.type || '').replace('Event', '') || 'Event';
    const repo = String(item?.repo || '');
    const desc = String(item?.desc || '').slice(0, 60);
    lines.push(`[${type}] ${repo}: ${desc}`);
  }
  return lines.join('\n');
}

// ===== 合并推送渲染 =====

/** 合并推送的仓库数据类型 */
export interface RepoCollectedData {
  repo: string;
  commits: CommitData[];
  issues: IssueData[];
  pulls: IssueData[];
  comments: CommentData[];
  actions: ActionRunData[];
}

/** 合并推送的用户数据类型 */
export interface UserCollectedData {
  username: string;
  items: UserActivityItem[];
}

/** 合并仓库推送 HTML */
export function mergedRepoHTML (repos: RepoCollectedData[]): string {
  const t = getTheme();
  const list = Array.isArray(repos) ? repos : [];
  let totalCount = 0;
  const sections: string[] = [];

  for (const r of list) {
    const parts: string[] = [];
    const commits = Array.isArray(r?.commits) ? r.commits : [];
    const issues = Array.isArray(r?.issues) ? r.issues : [];
    const pulls = Array.isArray(r?.pulls) ? r.pulls : [];
    const comments = Array.isArray(r?.comments) ? r.comments : [];
    const actions = Array.isArray(r?.actions) ? r.actions : [];

    if (commits.length) {
      totalCount += commits.length;
      const showCommits = commits.slice(0, 3);
      parts.push(showCommits.map(c => {
        const msg = esc(truncate(String(c?.commit?.message || '').split('\n')[0], 120));
        const sha = esc(String(c?.sha || '').slice(0, 7));
        const author = esc(c?.commit?.author?.name || 'unknown');
        let diffHtml = '';
        const files = Array.isArray(c?.files) ? c.files : [];
        if (files.length) {
          const showFiles = files.slice(0, 3);
          const restFiles = files.length - showFiles.length;
          diffHtml = showFiles.map(f => fileDiffHTML(f)).join('');
          if (restFiles > 0) diffHtml += `<div class="diff-more">还有 ${restFiles} 个文件变更</div>`;
        }
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span class="sha">${sha}</span><span style="color:${t.textSub};font-size:11px">${author}</span><span class="time">${fmtTime(c?.commit?.author?.date)}</span></div><div class="msg">${msg}</div>${diffHtml}</div>`;
      }).join(''));
      if (commits.length > 3) parts.push(`<div style="font-size:11px;color:${t.textMuted};padding:2px 0">还有 ${commits.length - 3} 条 commit</div>`);
    }

    if (issues.length) {
      totalCount += issues.length;
      parts.push(issues.map(i => {
        const tag = mdActionTag(i?.action, i?.state);
        const body = i?.body ? `<div style="margin-top:4px;font-size:12px">${mdBodyToHTML(i.body, 500)}</div>` : '';
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#8957e5;font-size:11px">Issue #${i?.number ?? 0}</span>${tag}<span class="time">${fmtTime(i?.created_at)}</span></div><div class="msg">${esc(truncate(i?.title, 120))}</div>${body}</div>`;
      }).join(''));
    }

    if (pulls.length) {
      totalCount += pulls.length;
      parts.push(pulls.map(p => {
        const tag = mdActionTag(p?.action, p?.state);
        const body = p?.body ? `<div style="margin-top:4px;font-size:12px">${mdBodyToHTML(p.body, 500)}</div>` : '';
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#db6d28;font-size:11px">PR #${p?.number ?? 0}</span>${tag}<span class="time">${fmtTime(p?.created_at)}</span></div><div class="msg">${esc(truncate(p?.title, 120))}</div>${body}</div>`;
      }).join(''));
    }

    if (comments.length) {
      totalCount += comments.length;
      parts.push(comments.slice(0, 2).map(c => {
        const src = c?.source === 'pull_request' ? 'PR' : 'Issue';
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#58a6ff;font-size:11px">${src} #${c?.number ?? 0} 评论</span><span class="time">${fmtTime(c?.created_at)}</span></div><div class="msg">${mdBodyToHTML(c?.body, 500)}</div></div>`;
      }).join(''));
    }

    if (actions.length) {
      totalCount += actions.length;
      parts.push(actions.slice(0, 2).map(a => {
        const conclusion = String(a?.conclusion || a?.status || 'unknown');
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#d29922;font-size:11px">Action #${a?.run_number ?? 0}</span><span style="font-size:11px;color:${t.textMuted}">${esc(conclusion)}</span><span class="time">${fmtTime(a?.created_at)}</span></div><div class="msg">${esc(truncate(a?.name, 60))}</div></div>`;
      }).join(''));
    }

    if (parts.length) {
      sections.push(`<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid ${t.divider}"><div style="font-size:13px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">${SVG.commit}<span>${esc(r?.repo)}</span></div>${parts.join('')}</div>`);
    }
  }

  // 去掉最后一个 section 的 border-bottom
  if (sections.length) {
    sections[sections.length - 1] = sections[sections.length - 1].replace(/border-bottom:1px solid [^;]+;/, 'border-bottom:none;');
  }

  const ghIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="${t.text}"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  return wrapHTML(`${list.length} 个仓库`, '仓库订阅汇总', '#2ea44f', ghIcon, totalCount, sections.join(''));
}

/** 合并用户推送 HTML */
export function mergedUsersHTML (users: UserCollectedData[]): string {
  const t = getTheme();
  const list = Array.isArray(users) ? users : [];
  let totalCount = 0;
  const sections: string[] = [];

  for (const u of list) {
    const items = Array.isArray(u?.items) ? u.items : [];
    totalCount += items.length;
    const rows = items.slice(0, 20).map(item => {
      const ev = USER_EVENT_MAP[String(item?.type || '')] || { icon: SVG.commit, color: t.textSub };
      return `<div class="item" style="padding:6px 0"><div class="item-header"><span class="header-icon" style="display:inline-flex;align-items:center">${ev.icon}</span><span style="color:${ev.color};font-weight:500;font-size:11px">${esc(String(item?.type || '').replace('Event', ''))}</span><span style="color:${t.textSub};font-size:11px">${esc(item?.repo)}</span><span class="time">${fmtTime(item?.time)}</span></div><div class="msg">${esc(truncate(item?.desc, 80))}</div></div>`;
    }).join('');
    const extra = items.length > 20 ? `<div style="font-size:11px;color:${t.textMuted};padding:2px 0">还有 ${items.length - 20} 条动态</div>` : '';
    sections.push(`<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid ${t.divider}"><div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(u?.username)}</div>${rows}${extra}</div>`);
  }

  if (sections.length) {
    sections[sections.length - 1] = sections[sections.length - 1].replace(/border-bottom:1px solid [^;]+;/, 'border-bottom:none;');
  }

  const userIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="#58a6ff"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;
  return wrapHTML(`${list.length} 个用户`, '用户动态汇总', '#58a6ff', userIcon, totalCount, sections.join(''));
}

/** 渲染合并仓库推送 */
export async function renderMergedRepo (repos: RepoCollectedData[]): Promise<string | null> {
  return safeRender(() => mergedRepoHTML(repos), 'MergedRepo');
}

/** 合并仓库推送文本摘要 */
export function mergedRepoSummary (repos: RepoCollectedData[]): string {
  const list = Array.isArray(repos) ? repos : [];
  const lines = [`[仓库订阅汇总] ${list.length} 个仓库有更新\n`];
  for (const r of list) {
    const parts: string[] = [];
    // 兜底文本同样不能抛错
    const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
    if (n(r?.commits)) parts.push(`${n(r.commits)} commits`);
    if (n(r?.issues)) parts.push(`${n(r.issues)} issues`);
    if (n(r?.pulls)) parts.push(`${n(r.pulls)} PRs`);
    if (n(r?.comments)) parts.push(`${n(r.comments)} comments`);
    if (n(r?.actions)) parts.push(`${n(r.actions)} actions`);
    lines.push(`${String(r?.repo || '')}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

/** 渲染合并用户推送 */
export async function renderMergedUsers (users: UserCollectedData[]): Promise<string | null> {
  return safeRender(() => mergedUsersHTML(users), 'MergedUsers');
}

/** 合并用户推送文本摘要 */
export function mergedUsersSummary (users: UserCollectedData[]): string {
  const list = Array.isArray(users) ? users : [];
  const lines = [`[用户动态汇总] ${list.length} 个用户有更新\n`];
  for (const u of list) {
    const count = Array.isArray(u?.items) ? u.items.length : 0;
    lines.push(`${String(u?.username || '')}: ${count} 条动态`);
  }
  return lines.join('\n');
}
