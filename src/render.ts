// 渲染模块 - 通过 puppeteer 插件截图 HTML 为 base64 图片
import type { CommitData, IssueData, CommentData, ActionRunData, ThemeColors, RepoInfo, UserActivityItem } from './types';
import { pluginState } from './state';

/** 转义 HTML */
function esc (s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 截断文本 */
function truncate (s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/** 格式化时间 */
function fmtTime (iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

/** 获取当前主题色 */
function getTheme (): ThemeColors {
  const mode = pluginState.config.theme || 'light';
  if (mode === 'dark') return THEME_DARK;
  if (mode === 'custom' && pluginState.config.customTheme) {
    return { ...THEME_LIGHT, ...pluginState.config.customTheme };
  }
  return THEME_LIGHT;
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
async function renderToBase64 (html: string): Promise<string | null> {
  try {
    const port = pluginState.config.webuiPort || 6099;
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
function wrapHTML (repo: string, typeName: string, color: string, icon: string, count: number, content: string): string {
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
    <div class="header-info"><h2>${typeName} 更新</h2><div class="repo">${esc(repo)}</div></div>
    <span class="badge">${count} 条新更新</span>
  </div>
  <div class="body">${content}</div>
  <div class="footer">GitHub Subscription ${SVG.sep} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>
</div>
</body></html>`;
}

/** 渲染 patch 内容为带颜色的 diff */
function renderPatch (patch: string, maxChars: number): string {
  const lines = patch.split('\n');
  let charCount = 0;
  let truncated = false;
  const rendered: string[] = [];
  for (const line of lines) {
    if (charCount + line.length > maxChars) { truncated = true; break; }
    charCount += line.length + 1;
    const escaped = esc(line);
    if (line.startsWith('+')) rendered.push(`<div class="l-add">${escaped}</div>`);
    else if (line.startsWith('-')) rendered.push(`<div class="l-del">${escaped}</div>`);
    else if (line.startsWith('@@')) rendered.push(`<div class="l-hunk">${escaped}</div>`);
    else rendered.push(`<div>${escaped}</div>`);
  }
  if (truncated) rendered.push(`<div style="color:#8b949e;font-style:italic">... 内容过长已截断</div>`);
  return rendered.join('');
}

/** 生成单个文件的 diff HTML */
function fileDiffHTML (file: { filename: string; status: string; additions: number; deletions: number; patch?: string; }): string {
  const patchContent = file.patch ? renderPatch(file.patch, 3000) : '<div style="color:#8b949e">（二进制文件或无变更内容）</div>';
  return `<div class="diff-file"><div class="diff-name"><span>${esc(file.filename)}</span><span class="add">+${file.additions}</span><span class="del">-${file.deletions}</span></div><div class="diff-code">${patchContent}</div></div>`;
}

/** 生成 Commits HTML（含 diff） */
function commitsHTML (repo: string, commits: CommitData[]): string {
  // 多 commit 时限制显示数量，避免图片过大
  const showCommits = commits.slice(0, 5);
  const restCommits = commits.length - showCommits.length;
  const rows = showCommits.map(c => {
    const msg = esc(truncate(c.commit.message.split('\n')[0], 80));
    const author = esc(c.commit.author.name);
    const sha = c.sha.slice(0, 7);
    const time = fmtTime(c.commit.author.date);
    let diffHtml = '';
    if (c.files && c.files.length) {
      const show = c.files.slice(0, 5);
      const rest = c.files.length - show.length;
      diffHtml = show.map(f => fileDiffHTML(f)).join('');
      if (rest > 0) diffHtml += `<div class="diff-more">还有 ${rest} 个文件变更</div>`;
    }
    return `<div class="item"><div class="item-header"><span class="sha">${sha}</span><span class="author">${author}</span><span class="time">${time}</span></div><div class="msg">${msg}</div>${diffHtml}</div>`;
  }).join('');
  const extra = restCommits > 0 ? `<div class="diff-more">还有 ${restCommits} 条 commit，请前往 GitHub 查看</div>` : '';
  return wrapHTML(repo, 'Commits', '#2ea44f', SVG.commit, commits.length, rows + extra);
}

/** 动作标签映射 */
const ACTION_MAP: Record<string, { text: string; color: string; bg: string; }> = {
  opened: { text: '新建', color: '#3fb950', bg: 'rgba(63,185,80,.15)' },
  closed: { text: '关闭', color: '#f85149', bg: 'rgba(248,81,73,.15)' },
  reopened: { text: '重新打开', color: '#d29922', bg: 'rgba(210,153,34,.15)' },
  merged: { text: '已合并', color: '#a371f7', bg: 'rgba(163,113,247,.15)' },
};

function actionTag (action?: string): string {
  if (!action) return '';
  const a = ACTION_MAP[action];
  if (!a) return `<span class="action-tag" style="background:rgba(139,148,158,.15);color:#8b949e">${esc(action)}</span>`;
  return `<span class="action-tag" style="background:${a.bg};color:${a.color}">${a.text}</span>`;
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
    <div><h2>${typeName} 更新</h2><div class="repo">${esc(repo)}</div></div>
    <span class="badge">${count} 条新更新</span>
  </div>
  <div class="md">${mdBody}</div>
  <div class="ft">GitHub Subscription ${SVG.sep} ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>
</div>
</body></html>`;
}

/** 动作 → Markdown 标签 */
function mdActionTag (action?: string, state?: string): string {
  const a = action || state || '';
  const map: Record<string, string> = { opened: 'tag-open', closed: 'tag-closed', reopened: 'tag-reopened', merged: 'tag-merged', open: 'tag-open' };
  const cls = map[a] || '';
  const textMap: Record<string, string> = { opened: '新建', closed: '已关闭', reopened: '重新打开', merged: '已合并', open: '打开中' };
  const text = textMap[a] || a;
  return text ? `<span class="tag ${cls}">${esc(text)}</span>` : '';
}

/** 简易 Markdown body → HTML（处理代码块、引用、列表等） */
function mdBodyToHTML (raw: string | null, maxLen = 3000): string {
  if (!raw) return '';
  let s = raw.length > maxLen ? raw.slice(0, maxLen) + '\n\n...(内容过长已截断)' : raw;

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
  // 斜体 *text* 或 _text_
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/_(.+?)_/g, '<i>$1</i>');
  // 删除线 ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 无序列表 - item（使用 CSS 圆点替代 • 字符）
  s = s.replace(/^[-*]\s+(.+)$/gm, '<div style="padding-left:16px;display:flex;align-items:baseline;gap:0"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0.4;flex-shrink:0;margin-right:6px;margin-top:6px"></span><span>$1</span></div>');
  // 有序列表 1. item（使用 CSS 圆点替代 · 字符）
  s = s.replace(/^\d+\.\s+(.+)$/gm, (_, content) => `<div style="padding-left:16px;display:flex;align-items:baseline;gap:0"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:0.35;flex-shrink:0;margin-right:6px;margin-top:7px"></span><span>${content}</span></div>`);

  // GitHub emoji :name: → 移除冒号显示名称（服务器无 emoji 字体）
  s = s.replace(/:([a-z0-9_+-]+):/g, '[$1]');

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
function issuesHTML (repo: string, issues: IssueData[]): string {
  const rows = issues.map(i => {
    const title = esc(truncate(i.title, 80));
    const author = esc(i.user.login);
    const time = fmtTime(i.created_at);
    const tag = mdActionTag(i.action, i.state);
    const labels = i.labels.map(l => `<span class="lbl" style="background:#${l.color}20;color:#${l.color};border:1px solid #${l.color}40">${esc(l.name)}</span>`).join('');
    const body = i.body ? `<blockquote>${mdBodyToHTML(i.body, 3000)}</blockquote>` : '';
    return `<h3><code>#${i.number}</code> ${title} ${tag}${labels}</h3>
<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p>${body}`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Issues', '#8957e5', SVG.issue, issues.length, rows);
}

/** 生成 Pull Requests Markdown 风格 HTML */
function pullsHTML (repo: string, pulls: IssueData[]): string {
  const rows = pulls.map(p => {
    const title = esc(truncate(p.title, 80));
    pluginState.debug(`[渲染PR] #${p.number} title="${p.title}" escaped="${title}"`);
    const author = esc(p.user.login);
    const time = fmtTime(p.created_at);
    const tag = mdActionTag(p.action, p.state);
    return `<h3><code>#${p.number}</code> ${title} ${tag}</h3>
<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p>`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Pull Requests', '#db6d28', SVG.pr, pulls.length, rows);
}

/** 生成 Comments Markdown 风格 HTML */
function commentsHTML (repo: string, comments: CommentData[]): string {
  // 按 Issue/PR 编号分组
  const grouped = new Map<number, CommentData[]>();
  for (const c of comments) {
    const arr = grouped.get(c.number) || [];
    arr.push(c);
    grouped.set(c.number, arr);
  }

  const sections: string[] = [];
  for (const [num, group] of grouped) {
    const first = group[0];
    const srcLabel = first.source === 'pull_request' ? 'PR' : 'Issue';
    const title = esc(truncate(first.title, 60));
    let html = `<h3><code>${srcLabel} #${num}</code> ${title} <span class="meta">(${group.length} 条评论)</span></h3>`;
    for (const c of group) {
      const author = esc(c.user.login);
      const time = fmtTime(c.created_at);
      const body = mdBodyToHTML(c.body, 3000);
      html += `<p class="meta">${SVG.user}${author} ${SVG.sep} ${time}</p><blockquote>${body}</blockquote>`;
    }
    sections.push(html);
  }

  return wrapMarkdownHTML(repo, 'Comments', '#58a6ff', SVG.comment, comments.length, sections.join('<hr>'));
}


/** 生成 Actions Markdown 风格 HTML */
function actionsHTML (repo: string, runs: ActionRunData[]): string {
  const rows = runs.map(r => {
    const name = esc(truncate(r.name, 60));
    const actor = esc(r.actor.login);
    const time = fmtTime(r.created_at);
    const conclusion = r.conclusion || r.status;
    const cMap: Record<string, { text: string; cls: string; }> = {
      success: { text: '成功', cls: 'tag-open' },
      failure: { text: '失败', cls: 'tag-closed' },
      cancelled: { text: '已取消', cls: 'tag-reopened' },
      in_progress: { text: '运行中', cls: 'tag-reopened' },
      queued: { text: '排队中', cls: '' },
    };
    const c = cMap[conclusion] || { text: conclusion, cls: '' };
    const tag = `<span class="tag ${c.cls}">${esc(c.text)}</span>`;
    return `<h3><code>#${r.run_number}</code> ${name} ${tag}</h3>
<p class="meta">${SVG.user}${actor} ${SVG.sep} ${esc(r.event)} ${SVG.sep} ${esc(r.head_branch)} ${SVG.sep} ${time}</p>`;
  }).join('<hr>');
  return wrapMarkdownHTML(repo, 'Actions', '#d29922', SVG.actions, runs.length, rows);
}

/** 格式化数字（k/m 缩写） */
function fmtNum (n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** 渲染仓库信息卡片 HTML */
function repoCardHTML (repo: RepoInfo, readme: string | null): string {
  const t = getTheme();
  const desc = repo.description ? esc(truncate(repo.description, 120)) : '<span style="opacity:0.5">No description</span>';
  const lang = repo.language ? esc(repo.language) : '';
  const license = repo.license?.name ? esc(repo.license.name) : '';
  const topics = (repo.topics || []).slice(0, 8).map(tp =>
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
      <div style="font-size:16px;font-weight:600;color:#1f6feb">${esc(repo.full_name)}</div>
      <div style="font-size:13px;color:${t.textSub};margin-top:2px;line-height:1.4">${desc}</div>
    </div>
  </div>

  <div style="padding:12px 20px;display:flex;flex-wrap:wrap;gap:16px;border-bottom:1px solid ${t.border};font-size:12px;color:${t.textSub}">
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="#e3b341"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
      ${fmtNum(repo.stargazers_count)}
    </span>
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>
      ${fmtNum(repo.forks_count)}
    </span>
    <span style="display:flex;align-items:center;gap:4px">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="${t.textSub}"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>
      ${fmtNum(repo.open_issues_count)} issues
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
  return renderToBase64(repoCardHTML(repo, readme));
}

/** 仓库信息文本摘要（降级用） */
export function repoSummary (repo: RepoInfo): string {
  const lines = [
    `📦 ${repo.full_name}`,
    repo.description || '',
    `⭐ ${repo.stargazers_count} | 🍴 ${repo.forks_count} | 📝 ${repo.open_issues_count} issues`,
    repo.language ? `语言: ${repo.language}` : '',
    `🔗 ${repo.html_url}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/** 文本摘要（降级用） */
export function commitsSummary (repo: string, commits: CommitData[]): string {
  const lines = [`[${repo}] ${commits.length} 条新 Commit\n`];
  for (const c of commits) {
    const msg = c.commit.message.split('\n')[0].slice(0, 60);
    lines.push(`* ${c.sha.slice(0, 7)} ${c.commit.author.name}: ${msg}`);
  }
  return lines.join('\n');
}

export function issuesSummary (repo: string, issues: IssueData[], type: 'Issues' | 'Pull Requests'): string {
  const lines = [`[${repo}] ${issues.length} 条新 ${type}\n`];
  for (const i of issues) {
    const actionText = i.action ? `[${i.action}]` : (i.state === 'open' ? '[open]' : '[closed]');
    lines.push(`${actionText} #${i.number} ${i.title.slice(0, 50)} - ${i.user.login}`);
  }
  return lines.join('\n');
}

export function commentsSummary (repo: string, comments: CommentData[]): string {
  const lines = [`[${repo}] ${comments.length} 条新评论\n`];
  for (const c of comments) {
    const src = c.source === 'pull_request' ? 'PR' : 'Issue';
    lines.push(`[${src}#${c.number}] ${c.user.login}: ${c.body.replace(/\n/g, ' ').slice(0, 500)}`);
  }
  return lines.join('\n');
}

export function actionsSummary (repo: string, runs: ActionRunData[]): string {
  const lines = [`[${repo}] ${runs.length} 条 Actions 更新\n`];
  for (const r of runs) {
    const c = r.conclusion || r.status;
    lines.push(`#${r.run_number} ${r.name} [${c}] - ${r.actor.login}`);
  }
  return lines.join('\n');
}

/** 渲染 Actions */
export async function renderActions (repo: string, runs: ActionRunData[]): Promise<string | null> {
  return renderToBase64(actionsHTML(repo, runs));
}

/** 自定义模板变量替换 */
function tplReplace (tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/** 构建 commits 的模板变量 */
function commitsTplVars (repo: string, commits: CommitData[]): Record<string, string> {
  const itemsJson = JSON.stringify(commits.map(c => ({
    sha: c.sha, sha7: c.sha.slice(0, 7),
    message: c.commit.message.split('\n')[0],
    author: c.commit.author.name, date: c.commit.author.date,
    url: c.html_url,
    files: (c.files || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '' })),
  })));
  return {
    repo, count: String(commits.length), type: 'Commits',
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    items: itemsJson,
  };
}

/** 构建 issues/pulls 的模板变量 */
function issuesTplVars (repo: string, items: IssueData[], type: string): Record<string, string> {
  const itemsJson = JSON.stringify(items.map(i => ({
    number: i.number, title: i.title, state: i.state, action: i.action || '',
    author: i.user.login, created_at: i.created_at, url: i.html_url,
    labels: i.labels.map(l => ({ name: l.name, color: l.color })),
  })));
  return {
    repo, count: String(items.length), type,
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    items: itemsJson,
  };
}

/** 渲染 Commits 并返回 base64 图片（失败返回 null） */
export async function renderCommits (repo: string, commits: CommitData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.commits;
  if (custom) {
    pluginState.debug('[渲染] 使用自定义 Commits 模板');
    return renderToBase64(tplReplace(custom, commitsTplVars(repo, commits)));
  }
  return renderToBase64(commitsHTML(repo, commits));
}

/** 渲染 Issues */
export async function renderIssues (repo: string, issues: IssueData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.issues;
  if (custom) {
    pluginState.debug('[渲染] 使用自定义 Issues 模板');
    return renderToBase64(tplReplace(custom, issuesTplVars(repo, issues, 'Issues')));
  }
  return renderToBase64(issuesHTML(repo, issues));
}

/** 渲染 Pull Requests */
export async function renderPulls (repo: string, pulls: IssueData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.pulls;
  if (custom) {
    pluginState.debug('[渲染] 使用自定义 Pulls 模板');
    return renderToBase64(tplReplace(custom, issuesTplVars(repo, pulls, 'Pull Requests')));
  }
  return renderToBase64(pullsHTML(repo, pulls));
}

/** 渲染 Comments */
export async function renderComments (repo: string, comments: CommentData[]): Promise<string | null> {
  const custom = pluginState.config.customHTML?.comments;
  if (custom) {
    pluginState.debug('[渲染] 使用自定义 Comments 模板');
    const itemsJson = JSON.stringify(comments.map(c => ({
      number: c.number, title: c.title, body: c.body, author: c.user.login,
      created_at: c.created_at, url: c.html_url, source: c.source,
    })));
    return renderToBase64(tplReplace(custom, {
      repo, count: String(comments.length), type: 'Comments',
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      items: itemsJson,
    }));
  }
  return renderToBase64(commentsHTML(repo, comments));
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
function userActivityHTML (username: string, items: UserActivityItem[]): string {
  const t = getTheme();
  const rows = items.map(item => {
    const ev = USER_EVENT_MAP[item.type] || { icon: SVG.commit, color: t.textSub };
    const time = fmtTime(item.time);
    return `<div class="item">
  <div class="item-header">
    <span class="header-icon" style="display:inline-flex;align-items:center">${ev.icon}</span>
    <span style="color:${ev.color};font-weight:500;font-size:12px">${esc(item.type.replace('Event', ''))}</span>
    <span style="color:${t.textSub};font-size:12px">${esc(item.repo)}</span>
    <span class="time">${time}</span>
  </div>
  <div class="msg">${esc(truncate(item.desc, 120))}</div>
</div>`;
  }).join('');

  const userIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="#58a6ff"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;
  return wrapHTML(username, `${username} 动态`, '#58a6ff', userIcon, items.length, rows);
}

/** 渲染用户活动 */
export async function renderUserActivity (username: string, items: UserActivityItem[]): Promise<string | null> {
  return renderToBase64(userActivityHTML(username, items));
}

/** 用户活动文本摘要（降级用） */
export function userActivitySummary (username: string, items: UserActivityItem[]): string {
  const lines = [`[${username}] ${items.length} 条新动态\n`];
  for (const item of items) {
    const type = item.type.replace('Event', '');
    lines.push(`[${type}] ${item.repo}: ${item.desc.slice(0, 60)}`);
  }
  return lines.join('\n');
}

// ===== 合并推送渲染 =====

/** 合并推送的仓库数据类型 */
interface RepoCollectedData {
  repo: string;
  commits: CommitData[];
  issues: IssueData[];
  pulls: IssueData[];
  comments: CommentData[];
  actions: ActionRunData[];
}

/** 合并推送的用户数据类型 */
interface UserCollectedData {
  username: string;
  items: UserActivityItem[];
}

/** 合并仓库推送 HTML */
function mergedRepoHTML (repos: RepoCollectedData[]): string {
  const t = getTheme();
  let totalCount = 0;
  const sections: string[] = [];

  for (const r of repos) {
    const parts: string[] = [];

    if (r.commits.length) {
      totalCount += r.commits.length;
      const showCommits = r.commits.slice(0, 3);
      parts.push(showCommits.map(c => {
        const msg = esc(truncate(c.commit.message.split('\n')[0], 60));
        const sha = c.sha.slice(0, 7);
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span class="sha">${sha}</span><span style="color:${t.textSub};font-size:11px">Commit</span><span class="time">${fmtTime(c.commit.author.date)}</span></div><div class="msg">${msg}</div></div>`;
      }).join(''));
      if (r.commits.length > 3) parts.push(`<div style="font-size:11px;color:${t.textMuted};padding:2px 0">还有 ${r.commits.length - 3} 条 commit</div>`);
    }

    if (r.issues.length) {
      totalCount += r.issues.length;
      parts.push(r.issues.map(i => {
        const tag = mdActionTag(i.action, i.state);
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#8957e5;font-size:11px">Issue #${i.number}</span>${tag}<span class="time">${fmtTime(i.created_at)}</span></div><div class="msg">${esc(truncate(i.title, 60))}</div></div>`;
      }).join(''));
    }

    if (r.pulls.length) {
      totalCount += r.pulls.length;
      parts.push(r.pulls.map(p => {
        const tag = mdActionTag(p.action, p.state);
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#db6d28;font-size:11px">PR #${p.number}</span>${tag}<span class="time">${fmtTime(p.created_at)}</span></div><div class="msg">${esc(truncate(p.title, 60))}</div></div>`;
      }).join(''));
    }

    if (r.comments.length) {
      totalCount += r.comments.length;
      parts.push(r.comments.slice(0, 2).map(c => {
        const src = c.source === 'pull_request' ? 'PR' : 'Issue';
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#58a6ff;font-size:11px">${src} #${c.number} 评论</span><span class="time">${fmtTime(c.created_at)}</span></div><div class="msg">${mdBodyToHTML(c.body, 500)}</div></div>`;
      }).join(''));
    }

    if (r.actions.length) {
      totalCount += r.actions.length;
      parts.push(r.actions.slice(0, 2).map(a => {
        const conclusion = a.conclusion || a.status;
        return `<div class="item" style="padding:6px 0"><div class="item-header"><span style="color:#d29922;font-size:11px">Action #${a.run_number}</span><span style="font-size:11px;color:${t.textMuted}">${esc(conclusion)}</span><span class="time">${fmtTime(a.created_at)}</span></div><div class="msg">${esc(truncate(a.name, 60))}</div></div>`;
      }).join(''));
    }

    if (parts.length) {
      sections.push(`<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid ${t.divider}"><div style="font-size:13px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">${SVG.commit}<span>${esc(r.repo)}</span></div>${parts.join('')}</div>`);
    }
  }

  // 去掉最后一个 section 的 border-bottom
  if (sections.length) {
    sections[sections.length - 1] = sections[sections.length - 1].replace(/border-bottom:1px solid [^;]+;/, 'border-bottom:none;');
  }

  const ghIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="${t.text}"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  return wrapHTML(`${repos.length} 个仓库`, '仓库订阅汇总', '#2ea44f', ghIcon, totalCount, sections.join(''));
}

/** 合并用户推送 HTML */
function mergedUsersHTML (users: UserCollectedData[]): string {
  const t = getTheme();
  let totalCount = 0;
  const sections: string[] = [];

  for (const u of users) {
    totalCount += u.items.length;
    const rows = u.items.slice(0, 5).map(item => {
      const ev = USER_EVENT_MAP[item.type] || { icon: SVG.commit, color: t.textSub };
      return `<div class="item" style="padding:6px 0"><div class="item-header"><span class="header-icon" style="display:inline-flex;align-items:center">${ev.icon}</span><span style="color:${ev.color};font-weight:500;font-size:11px">${esc(item.type.replace('Event', ''))}</span><span style="color:${t.textSub};font-size:11px">${esc(item.repo)}</span><span class="time">${fmtTime(item.time)}</span></div><div class="msg">${esc(truncate(item.desc, 80))}</div></div>`;
    }).join('');
    const extra = u.items.length > 5 ? `<div style="font-size:11px;color:${t.textMuted};padding:2px 0">还有 ${u.items.length - 5} 条动态</div>` : '';
    sections.push(`<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid ${t.divider}"><div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(u.username)}</div>${rows}${extra}</div>`);
  }

  if (sections.length) {
    sections[sections.length - 1] = sections[sections.length - 1].replace(/border-bottom:1px solid [^;]+;/, 'border-bottom:none;');
  }

  const userIcon = `<svg width="20" height="20" viewBox="0 0 16 16" fill="#58a6ff"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>`;
  return wrapHTML(`${users.length} 个用户`, '用户动态汇总', '#58a6ff', userIcon, totalCount, sections.join(''));
}

/** 渲染合并仓库推送 */
export async function renderMergedRepo (repos: RepoCollectedData[]): Promise<string | null> {
  return renderToBase64(mergedRepoHTML(repos));
}

/** 合并仓库推送文本摘要 */
export function mergedRepoSummary (repos: RepoCollectedData[]): string {
  const lines = [`[仓库订阅汇总] ${repos.length} 个仓库有更新\n`];
  for (const r of repos) {
    const parts: string[] = [];
    if (r.commits.length) parts.push(`${r.commits.length} commits`);
    if (r.issues.length) parts.push(`${r.issues.length} issues`);
    if (r.pulls.length) parts.push(`${r.pulls.length} PRs`);
    if (r.comments.length) parts.push(`${r.comments.length} comments`);
    if (r.actions.length) parts.push(`${r.actions.length} actions`);
    lines.push(`${r.repo}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

/** 渲染合并用户推送 */
export async function renderMergedUsers (users: UserCollectedData[]): Promise<string | null> {
  return renderToBase64(mergedUsersHTML(users));
}

/** 合并用户推送文本摘要 */
export function mergedUsersSummary (users: UserCollectedData[]): string {
  const lines = [`[用户动态汇总] ${users.length} 个用户有更新\n`];
  for (const u of users) {
    lines.push(`${u.username}: ${u.items.length} 条动态`);
  }
  return lines.join('\n');
}
