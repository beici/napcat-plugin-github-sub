// WebUI API 路由
import type { Subscription, EventType, UserSubscription } from './types';
import { pluginState } from './state';
import { fetchDefaultBranch, fetchBranches } from './github';
import { stopPoller, startPoller } from './poller';

export function registerApiRoutes (router: any): void {
  // 获取配置 + 订阅列表
  router.getNoAuth('/config', (_: any, res: any) => {
    res.json({
      success: true,
      version: pluginState.version,
      config: {
        token: pluginState.config.token ? '***' : '',
        tokens: (pluginState.config.tokens || []).map(t => t ? '***' : ''),
        tokenCount: (pluginState.config.tokens || []).filter(t => t.trim()).length + (pluginState.config.token ? 1 : 0),
        apiBase: pluginState.config.apiBase,
        interval: pluginState.config.interval,
        debug: pluginState.config.debug,
        owners: pluginState.config.owners || [],
        allowMemberSub: pluginState.config.allowMemberSub ?? false,
        autoDetectRepo: pluginState.config.autoDetectRepo !== false,
        mergeNotify: pluginState.config.mergeNotify ?? false,
        theme: pluginState.config.theme || 'light',
        customTheme: pluginState.config.customTheme || null,
        customHTML: pluginState.config.customHTML || null,
        webuiPort: pluginState.config.webuiPort || null,
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
      pluginState.config.tokens = (body.tokens as string[]).filter(t => t && t !== '***').map(String);
    }
    if (body.apiBase !== undefined) pluginState.config.apiBase = String(body.apiBase);
    if (body.interval !== undefined) {
      const n = Number(body.interval);
      if (n >= 5) pluginState.config.interval = n;
    }
    if (body.debug !== undefined) pluginState.config.debug = Boolean(body.debug);
    if (body.owners !== undefined && Array.isArray(body.owners)) {
      pluginState.config.owners = (body.owners as string[]).map(String).filter(s => s.trim());
    }
    if (body.allowMemberSub !== undefined) pluginState.config.allowMemberSub = Boolean(body.allowMemberSub);
    if (body.autoDetectRepo !== undefined) pluginState.config.autoDetectRepo = Boolean(body.autoDetectRepo);
    if (body.mergeNotify !== undefined) pluginState.config.mergeNotify = Boolean(body.mergeNotify);
    if (body.theme !== undefined && ['light', 'dark', 'custom'].includes(String(body.theme))) {
      pluginState.config.theme = String(body.theme) as 'light' | 'dark' | 'custom';
    }
    if (body.customTheme !== undefined && typeof body.customTheme === 'object' && body.customTheme !== null) {
      pluginState.config.customTheme = body.customTheme as any;
    }
    if (body.customHTML !== undefined && typeof body.customHTML === 'object' && body.customHTML !== null) {
      pluginState.config.customHTML = body.customHTML as any;
    }
    if (body.webuiPort !== undefined) {
      const p = Number(body.webuiPort);
      if (p > 0 && p <= 65535) {
        pluginState.config.webuiPort = p;
        pluginState.httpPort = p;
      } else if (!p) {
        delete pluginState.config.webuiPort;
      }
    }
    pluginState.saveConfig();
    stopPoller();
    startPoller();
    res.json({ success: true });
  });

  // 获取仓库分支列表
  router.postNoAuth('/repo/branches', async (req: any, res: any) => {
    const repo = ((req.body as any)?.repo as string || '').trim().toLowerCase();
    if (!repo || !repo.includes('/')) { res.json({ success: false, error: '仓库格式错误' }); return; }
    try {
      const branches = await fetchBranches(repo);
      if (!branches.length) { res.json({ success: false, error: '未找到分支，请检查仓库名是否正确' }); return; }
      res.json({ success: true, data: branches });
    } catch (e) {
      res.json({ success: false, error: String(e) });
    }
  });

  // 添加订阅（支持单分支 branch 或多分支 branches 数组）
  router.postNoAuth('/sub/add', async (req: any, res: any) => {
    const { repo: rawRepo, types, groups, branch: specifiedBranch, branches: specifiedBranches } = req.body as {
      repo?: string; types?: string[]; groups?: string[];
      branch?: string; branches?: string[];
    };
    const repo = rawRepo?.trim().toLowerCase();
    if (!repo || !repo.includes('/')) { res.json({ success: false, error: '仓库格式错误，请使用 owner/repo' }); return; }

    const validTypes: EventType[] = (types || ['commits', 'issues', 'pulls']).filter(t =>
      ['commits', 'issues', 'pulls', 'actions'].includes(t)
    ) as EventType[];

    // 收集要订阅的分支列表
    let branchList: string[] = [];
    if (specifiedBranches && Array.isArray(specifiedBranches) && specifiedBranches.length) {
      branchList = specifiedBranches.map(b => b.trim()).filter(Boolean);
    } else if (specifiedBranch?.trim()) {
      branchList = [specifiedBranch.trim()];
    }
    if (!branchList.length) {
      try { branchList = [await fetchDefaultBranch(repo)]; } catch { branchList = ['main']; }
    }

    // 过滤已订阅的分支
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
        groups: groups || [],
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      pluginState.config.subscriptions.push(sub);
      added.push(sub);
    }
    pluginState.saveConfig();
    stopPoller();
    startPoller();
    const msg = skipped.length ? `已添加 ${toAdd.join(', ')}，跳过已订阅: ${skipped.join(', ')}` : undefined;
    res.json({ success: true, data: added.length === 1 ? added[0] : added, message: msg });
  });

  // 更新订阅
  router.postNoAuth('/sub/update', (req: any, res: any) => {
    const body = req.body as Record<string, any>;
    const repo = body.repo as string;
    const oldBranch = body.oldBranch as string | undefined;
    const newBranch = body.branch as string | undefined;
    const types = body.types as EventType[] | undefined;
    const groups = body.groups as string[] | undefined;
    const enabled = body.enabled as boolean | undefined;

    // 用 oldBranch 精确定位原订阅，fallback 到 newBranch
    const matchBranch = oldBranch || newBranch;
    const sub = pluginState.config.subscriptions.find(s => s.repo === repo && (!matchBranch || s.branch === matchBranch));
    if (!sub) { res.json({ success: false, error: '未找到该订阅' }); return; }

    if (types) sub.types = types;
    if (groups) sub.groups = groups;
    if (enabled !== undefined) sub.enabled = enabled;
    if (newBranch) sub.branch = newBranch;
    pluginState.saveConfig();
    res.json({ success: true, data: sub });
  });

  // 删除订阅
  router.postNoAuth('/sub/delete', (req: any, res: any) => {
    const { repo, branch } = req.body as { repo?: string; branch?: string; };
    const idx = pluginState.config.subscriptions.findIndex(s => s.repo === repo && (!branch || s.branch === branch));
    if (idx === -1) { res.json({ success: false, error: '未找到该订阅' }); return; }
    pluginState.config.subscriptions.splice(idx, 1);
    pluginState.saveConfig();
    res.json({ success: true });
  });

  // ===== 用户监控 API =====

  // 添加用户监控
  router.postNoAuth('/user/add', (req: any, res: any) => {
    const { username, groups } = req.body as { username?: string; groups?: string[]; };
    const name = username?.trim();
    if (!name) { res.json({ success: false, error: '用户名不能为空' }); return; }
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const existing = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === name.toLowerCase());
    if (existing) { res.json({ success: false, error: '该用户已在监控列表' }); return; }
    const userSub: UserSubscription = {
      username: name,
      groups: groups || [],
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    pluginState.config.userSubscriptions.push(userSub);
    pluginState.saveConfig();
    stopPoller();
    startPoller();
    res.json({ success: true, data: userSub });
  });

  // 更新用户监控
  router.postNoAuth('/user/update', (req: any, res: any) => {
    const { username, groups, enabled } = req.body as Partial<UserSubscription> & { username: string; };
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const sub = pluginState.config.userSubscriptions.find(u => u.username === username);
    if (!sub) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    if (groups) sub.groups = groups;
    if (enabled !== undefined) sub.enabled = enabled;
    pluginState.saveConfig();
    res.json({ success: true, data: sub });
  });

  // 删除用户监控
  router.postNoAuth('/user/delete', (req: any, res: any) => {
    const { username } = req.body as { username?: string; };
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const idx = pluginState.config.userSubscriptions.findIndex(u => u.username === username);
    if (idx === -1) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    pluginState.config.userSubscriptions.splice(idx, 1);
    pluginState.saveConfig();
    res.json({ success: true });
  });

  // 切换用户监控开关
  router.postNoAuth('/user/toggle', (req: any, res: any) => {
    const { username } = req.body as { username?: string; };
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const sub = pluginState.config.userSubscriptions.find(u => u.username === username);
    if (!sub) { res.json({ success: false, error: '未找到该用户监控' }); return; }
    sub.enabled = !sub.enabled;
    pluginState.saveConfig();
    res.json({ success: true, enabled: sub.enabled });
  });

  // 获取群列表
  router.getNoAuth('/groups', async (_: any, res: any) => {
    try {
      if (!pluginState.actions || !pluginState.networkConfig) {
        res.json({ success: false, error: '插件未初始化' }); return;
      }
      const result = await pluginState.actions.call('get_group_list', {} as never, pluginState.adapterName, pluginState.networkConfig);
      res.json({ success: true, data: result || [] });
    } catch (e) { res.json({ success: false, error: String(e) }); }
  });

  // 切换订阅开关
  router.postNoAuth('/sub/toggle', (req: any, res: any) => {
    const { repo, branch } = req.body as { repo?: string; branch?: string; };
    const sub = pluginState.config.subscriptions.find(s => s.repo === repo && (!branch || s.branch === branch));
    if (!sub) { res.json({ success: false, error: '未找到该订阅' }); return; }
    sub.enabled = !sub.enabled;
    pluginState.saveConfig();
    res.json({ success: true, enabled: sub.enabled });
  });

  // Ping GitHub API 连通性测试
  router.getNoAuth('/ping', async (_: any, res: any) => {
    const base = pluginState.config.apiBase || 'https://api.github.com';
    const start = Date.now();
    try {
      const headers: Record<string, string> = { 'User-Agent': 'napcat-plugin-github-sub' };
      // 使用第一个可用 token
      const allTokens = [...(pluginState.config.tokens || [])];
      if (pluginState.config.token && !allTokens.includes(pluginState.config.token)) allTokens.push(pluginState.config.token);
      const firstToken = allTokens.find(t => t.trim());
      if (firstToken) headers['Authorization'] = `Bearer ${firstToken}`;
      const hasToken = !!firstToken;
      const r = await fetch(`${base}/zen`, { headers, signal: AbortSignal.timeout(10000) });
      const ms = Date.now() - start;

      if (r.ok) {
        res.json({ success: true, ms, status: r.status, authenticated: hasToken });
      } else {
        res.json({ success: false, ms, status: r.status, error: `HTTP ${r.status}` });
      }
    } catch (e) {
      const ms = Date.now() - start;
      res.json({ success: false, ms, error: String(e) });
    }
  });

  // Puppeteer 状态检测
  router.getNoAuth('/puppeteer', async (_: any, res: any) => {
    try {
      const port = pluginState.config.webuiPort || 6099;
      const r = await fetch(`http://127.0.0.1:${port}/plugin/napcat-plugin-puppeteer/api/status`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        res.json({ success: true, connected: true });
      } else {
        res.json({ success: true, connected: false, error: `HTTP ${r.status}` });
      }
    } catch (e) {
      res.json({ success: true, connected: false, error: String(e) });
    }
  });

  // 调试日志
  router.getNoAuth('/logs', (_: any, res: any) => {
    res.json({ success: true, data: pluginState.logBuffer });
  });

  router.postNoAuth('/logs/clear', (_: any, res: any) => {
    pluginState.clearLogs();
    res.json({ success: true });
  });
}
