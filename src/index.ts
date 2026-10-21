// NapCat GitHub 订阅插件
import type { PluginModule, NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import fs from 'fs';
import path from 'path';
import type { PluginConfig } from './types';
import { DEFAULT_CONFIG } from './config';
import { pluginState } from './state';
import { handleCommand } from './commands';
import { registerApiRoutes, syncPoller, seedPollKey } from './api';
import { startPoller, stopPoller } from './poller';
import { flushSummaries } from './llm';
import { fetchRepoInfo, fetchReadme, normalizeRepo } from './github';
import { renderRepoCard, repoSummary } from './render';

export let plugin_config_ui: PluginConfigSchema = [];

const PREFIX = 'gh';

/**
 * 自动识别仓库链接的限流状态。
 *
 * 原实现完全没有限制：任何人发一条含 github.com 链接的消息就触发
 * 2 次 GitHub API + 1 次 puppeteer 渲染 + 1 次图片上传。
 * 几十条消息能打光 5000/h 配额，或把 puppeteer 打满导致正常订阅推送也渲染失败。
 */
const AUTO_DETECT_PER_KEY_MS = 30_000;
const AUTO_DETECT_GLOBAL_PER_MIN = 20;
const autoDetectLastAt = new Map<string, number>();
const autoDetectGlobal: number[] = [];

function checkAutoDetectRate (key: string): boolean {
  const now = Date.now();
  // 单群/单用户冷却
  const last = autoDetectLastAt.get(key) || 0;
  if (now - last < AUTO_DETECT_PER_KEY_MS) return false;

  // 全局每分钟上限：先清掉窗口外的记录
  while (autoDetectGlobal.length && now - autoDetectGlobal[0] > 60_000) autoDetectGlobal.shift();
  if (autoDetectGlobal.length >= AUTO_DETECT_GLOBAL_PER_MIN) return false;

  autoDetectLastAt.set(key, now);
  autoDetectGlobal.push(now);

  // 防止 Map 无限增长：超过 1000 个 key 时清掉过期的
  if (autoDetectLastAt.size > 1000) {
    for (const [k, t] of autoDetectLastAt) {
      if (now - t > AUTO_DETECT_PER_KEY_MS) autoDetectLastAt.delete(k);
    }
  }
  return true;
}

/**
 * 订阅状态的轻量指纹，用来判断一条指令是否真的改了订阅。
 * 只取影响轮询行为的字段，避免 groups/alias 之类的展示性修改也触发重启。
 */
function subscriptionFingerprint (): string {
  // 全部字段防御式取值：配置被手改成非数组、或者某条订阅缺 types 时，
  // 这里原来会直接抛 TypeError，而它是在 onmessage 里被调的（async 回调），
  // 未捕获的 rejection 在 Node 15+ 默认会直接退出进程。
  const list = Array.isArray(pluginState.config.subscriptions) ? pluginState.config.subscriptions : [];
  const subs = list
    .map(s => `${s?.repo || ''}|${s?.branch || ''}|${(Array.isArray(s?.types) ? s.types : []).join(',')}|${s?.enabled ? 1 : 0}`)
    .sort()
    .join(';');
  const users = (Array.isArray(pluginState.config.userSubscriptions) ? pluginState.config.userSubscriptions : [])
    .map(u => `${u?.username || ''}|${u?.enabled ? 1 : 0}`)
    .sort()
    .join(';');
  return `${subs}#${users}`;
}

// 初始化
const plugin_init: PluginModule['plugin_init'] = async (ctx: NapCatPluginContext) => {
  Object.assign(pluginState, {
    logger: ctx.logger,
    actions: ctx.actions,
    adapterName: ctx.adapterName,
    networkConfig: ctx.pluginManager.config,
    dataPath: ctx.dataPath || path.join(path.dirname(ctx.configPath), 'data'),
    configPath: ctx.configPath,
  });

  pluginState.log('info', 'GitHub 订阅插件初始化中...');

  // 配置 UI — 仅展示信息，引导用户前往 WebUI 配置
  try {
    const C = ctx.NapCatConfig;
    if (C) {
      plugin_config_ui = C.combine(
        C.html(`
          <div style="padding: 16px; background: linear-gradient(135deg, rgba(31,111,235,0.1), rgba(31,35,40,0.1)); border: 1px solid rgba(31,111,235,0.3); border-radius: 12px; margin-bottom: 20px; box-shadow: 0 2px 6px rgba(0,0,0,0.04); font-family: system-ui, -apple-system, sans-serif;">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
              <div style="width: 36px; height: 36px; background: #24292f; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                <svg width="20" height="20" viewBox="0 0 16 16" fill="#fff"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              </div>
              <div>
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #374151;">GitHub 订阅推送 v${pluginState.version}</h3>
                <p style="margin: 2px 0 0; font-size: 12px; color: #9ca3af;">napcat-plugin-github-sub | 作者: 冷曦</p>
              </div>
            </div>
            <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.5;">
              监控 GitHub 仓库的 Commits / Issues / PR 并推送到群 | 
              发送 <code style="background: rgba(31,111,235,0.15); padding: 2px 6px; border-radius: 4px; color: #1f6feb;">gh帮助</code> 查看指令
            </p>
          </div>
        `),
        C.html(`
          <div style="padding: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; display: flex; gap: 10px; align-items: center; font-family: system-ui, -apple-system, sans-serif;">
            <div style="color: #6b7280; flex-shrink: 0;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            </div>
            <div style="font-size: 13px; color: #4b5563;">
              所有配置（Token、主人权限、订阅管理、主题等）请前往 
              <a href="#" onclick="window.open(window.location.origin + '/plugin/napcat-plugin-github-sub/page/config', '_blank'); return false;" style="color: #1f6feb; text-decoration: none; font-weight: 600;">WebUI 控制台</a> 
              进行管理。
            </div>
          </div>
        `)
      );
    }
  } catch (e) {
    pluginState.debug('配置 UI 初始化失败: ' + e);
  }

  // 注册 WebUI 路由和页面
  const router = (ctx as any).router;
  registerApiRoutes(router);
  router.page({ path: 'config', title: 'GitHub 订阅管理', icon: '📦', htmlFile: 'webui/config.html', description: 'GitHub 订阅配置面板' });

  // 加载配置
  if (fs.existsSync(ctx.configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
      // 配置被手改坏或写盘中断时，subscriptions 可能不是数组。
      // 不校验的话后面 .filter/.push 全都会抛，而 plugin_init 抛错
      // 会让整个插件加载失败——用户只能看到「插件未加载」。
      pluginState.config = {
        ...DEFAULT_CONFIG,
        ...raw,
        // llm 要深合并：旧配置文件里没有新字段时，不能被整块覆盖掉
        llm: { ...DEFAULT_CONFIG.llm!, ...(raw.llm || {}) },
        subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
        userSubscriptions: Array.isArray(raw.userSubscriptions) ? raw.userSubscriptions : [],
        owners: Array.isArray(raw.owners) ? raw.owners : [],
        tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
      };
    } catch (e) {
      // 原来这里是 `catch { /* ignore */ }`：配置解析失败就静默用默认值启动，
      // 然后任何一次 saveConfig 都会把「空配置」写回磁盘 ——
      // 用户的所有订阅、Token、别名一次性永久丢失，且日志里毫无线索。
      // 现在先备份坏文件，再明确报错。
      pluginState.log('error', `配置文件解析失败: ${e}`);
      const bak = `${ctx.configPath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(ctx.configPath, bak);
        pluginState.log('warn', `已备份损坏的配置文件到 ${bak}，本次以默认配置启动`);
      } catch (e2) {
        pluginState.log('error', `备份损坏配置失败: ${e2}`);
      }
    }
  }

  // 确保数据目录
  if (!fs.existsSync(pluginState.dataPath)) fs.mkdirSync(pluginState.dataPath, { recursive: true });

  // 加载缓存
  pluginState.loadCache();

  // 检测 Puppeteer 渲染服务
  try {
    // 与 renderToBase64 保持同一套端口推导：httpPort 是 NapCat 实际监听端口，
    // 只读 webuiPort 时，没配 webuiPort 的部署会去探测 6099 拿到 404/503，
    // 日志里就一直挂着「图片推送将降级为文本」，但实际渲染可能是好的。
    const port = pluginState.httpPort || pluginState.config.webuiPort || 6099;
    const res = await fetch(`http://127.0.0.1:${port}/plugin/napcat-plugin-puppeteer/api/status`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      pluginState.log('info', `Puppeteer 渲染服务已连接 (端口: ${port})`);
    } else {
      pluginState.log('warn', `Puppeteer 渲染服务响应异常 (HTTP ${res.status})，图片推送将降级为文本`);
    }
  } catch {
    pluginState.log('warn', '未检测到 napcat-plugin-puppeteer 插件，图片推送将降级为文本');
  }

  // 启动轮询
  if (pluginState.config.subscriptions.length > 0 || (pluginState.config.userSubscriptions || []).length > 0) {
    startPoller();
  }
  // 记下启动时的配置快照：WebUI 首次打开会自动保存一次，
  // 不记的话那次保存会被判定为「轮询相关字段变了」而白白重启一轮
  seedPollKey();

  const userCount = (pluginState.config.userSubscriptions || []).length;
  pluginState.log('info', `GitHub 订阅插件初始化完成，${pluginState.config.subscriptions.length} 个仓库订阅，${userCount} 个用户监控`);
};

// 配置读写
export const plugin_get_config = async (): Promise<PluginConfig> => pluginState.config;
export const plugin_set_config = async (_ctx: NapCatPluginContext, _config: PluginConfig): Promise<void> => {
  // 配置通过 WebUI 管理，此处不做任何操作
};

// 清理
const plugin_cleanup: PluginModule['plugin_cleanup'] = async () => {
  stopPoller();
  // 清零快照：插件重载后是新的模块实例，但同一进程里热重载可能复用，
  // 不清零会导致「重载后第一次保存配置不生效」
  seedPollKey();
  // 等在后台跑的 AI 摘要收尾，否则可能往已关闭的 logger 里写东西
  await flushSummaries();
  // 用 Now 版本：卸载后微任务未必还有机会执行
  pluginState.saveCacheNow();
  pluginState.log('info', 'GitHub 订阅插件已卸载');
};

// 消息处理
const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx: NapCatPluginContext, event: OB11Message) => {
  // 整个函数体必须包 try/catch：这是 async 事件回调，抛出的 rejection
  // 没有任何人接。Node 15+ 默认 `--unhandled-rejections=throw`，一条畸形
  // 配置（subscriptions 被手改成对象）就能让整个 NapCat 进程退出。
  try {
    if (event.post_type !== 'message') return;
    const raw = (event.raw_message || '').trim();

    // 匹配前缀指令
    const match = raw.match(new RegExp(`^${PREFIX}\\s*(.*)`, 'is'));
    if (match) {
      const cmd = match[1].trim();
      // 记录执行前后订阅状态，只有真的变了才重启轮询。
      // 原来是无条件 stopPoller()+startPoller()，导致发一句 `gh 帮助`、
      // 甚至 `gh 列表` 都会重建轮询链——既浪费也可能和正在跑的那轮撞车。
      const before = subscriptionFingerprint();
      const handled = await handleCommand(event, cmd, ctx);
      if (handled && subscriptionFingerprint() !== before) {
        syncPoller();
      }
      return;
    }

    // 自动识别 GitHub 仓库链接
    if (!pluginState.config.autoDetectRepo) return;
    const repoMatch = raw.match(/https?:\/\/github\.com\/([a-zA-Z0-9\-_.]+\/[a-zA-Z0-9\-_.]+)/);
    if (!repoMatch) return;

    // 统一走 normalizeRepo：正则允许 `..`，`https://github.com/../foo` 会
    // 得到 repoName='../foo'，拼出 `https://api.github.com/repos/../foo`。
    const repoName = normalizeRepo(repoMatch[1].replace(/\.git$/, ''));
    if (!repoName) return;

    // 限流：每群/每人 30 秒一次、全局每分钟 20 次。
    // 原来没有任何限制，任何人（含陌生人私聊）发一条带 github.com 链接的消息
    // 就触发 2 次 GitHub API + 1 次 puppeteer 渲染 + 1 次图片上传，
    // 几十条消息就能打光 5000/h 配额，或把 puppeteer 打满导致正常推送也渲染失败。
    const throttleKey = event.message_type === 'group'
      ? `g:${event.group_id}`
      : `u:${event.user_id}`;
    if (!checkAutoDetectRate(throttleKey)) {
      pluginState.debug(`[自动识别] 触发限流，跳过: ${throttleKey}`);
      return;
    }

    pluginState.debug(`[自动识别] 检测到 GitHub 仓库链接: ${repoName}`);

    const repoInfo = await fetchRepoInfo(repoName);
    if (!repoInfo) {
      pluginState.debug(`[自动识别] 获取仓库信息失败: ${repoName}`);
      return;
    }

    const readme = await fetchReadme(repoName);
    const base64 = await renderRepoCard(repoInfo, readme);
    const fallback = repoSummary(repoInfo);

    const msg: unknown[] = base64
      ? [{ type: 'image', data: { file: `base64://${base64}` } }]
      : [{ type: 'text', data: { text: fallback } }];

    if (event.message_type === 'group' && event.group_id) {
      await ctx.actions.call('send_group_msg', { group_id: event.group_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config)
        .catch(e => pluginState.log('warn', `[自动识别] 发送仓库卡片到群 ${event.group_id} 失败: ${e}`));
    } else {
      await ctx.actions.call('send_private_msg', { user_id: event.user_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config)
        .catch(e => pluginState.log('warn', `[自动识别] 发送仓库卡片给用户 ${event.user_id} 失败: ${e}`));
    }

    pluginState.debug(`[自动识别] 仓库卡片已发送: ${repoName}`);
  } catch (e) {
    pluginState.log('error', `[onmessage] 处理消息失败: ${e}`);
  }
};

export { plugin_init, plugin_onmessage, plugin_cleanup };
