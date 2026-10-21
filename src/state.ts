// 插件全局状态
import type { ActionMap } from 'napcat-types/napcat-onebot/action/index';
import type { PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { NetworkAdapterConfig } from 'napcat-types/napcat-onebot/config/config';
import type { PluginConfig, EventCache } from './types';
import { DEFAULT_CONFIG } from './config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

interface LogEntry { time: number; level: string; msg: string; }

// 运行时从 package.json 读取版本号
function getPluginVersion (): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '1.0.0';
    }
  } catch { /* 读取失败使用默认版本 */ }
  return '1.0.0';
}

class PluginState {
  /** 插件版本（运行时从 package.json 读取） */
  version: string = getPluginVersion();
  logger: PluginLogger | null = null;
  actions: ActionMap | undefined;
  adapterName = '';
  networkConfig: NetworkAdapterConfig | null = null;
  config: PluginConfig = { ...DEFAULT_CONFIG, subscriptions: [] };
  configPath = '';
  dataPath = '';
  /** WebUI 实际监听端口（运行时探测到的，用于拼 puppeteer 渲染服务地址） */
  httpPort = 0;
  cache: EventCache = {};
  /** ETag 缓存，key 为接口标识，value 为上次响应的 ETag（仅内存，不落盘） */
  etags: Record<string, string> = {};
  logBuffer: LogEntry[] = [];
  private readonly maxLogEntries = 500;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** 标记已排队一次 cache 落盘，用于合并同一轮内的多次 saveCache */
  private cacheSaveScheduled = false;

  private pushLog (level: string, msg: string): void {
    this.logBuffer.push({ time: Date.now(), level, msg });
    if (this.logBuffer.length > this.maxLogEntries) this.logBuffer.splice(0, this.logBuffer.length - this.maxLogEntries);
  }

  log (level: 'info' | 'warn' | 'error', msg: string): void {
    this.logger?.[level](`[GitHub Sub] ${msg}`);
    this.pushLog(level, msg);
  }

  debug (msg: string): void {
    if (this.config.debug) {
      this.pushLog('debug', msg);
    }
  }

  clearLogs (): void { this.logBuffer = []; }

  saveConfig (): void {
    if (!this.configPath) return;
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.writeFileAtomic(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) { this.log('error', `保存配置失败: ${e}`); }
  }

  saveCache (): void {
    if (!this.dataPath) return;
    // 一轮轮询里可能连续多次设置游标，没必要每次都落盘。
    // 合并到一次微任务里写，既减少 IO 也避免频繁同步写阻塞事件循环。
    if (this.cacheSaveScheduled) return;
    this.cacheSaveScheduled = true;
    queueMicrotask(() => {
      this.cacheSaveScheduled = false;
      try {
        if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
        this.writeFileAtomic(path.join(this.dataPath, 'cache.json'), JSON.stringify(this.cache, null, 2));
      } catch (e) {
        // 不能静默吞：磁盘满 / dataPath 只读 / Windows 上 rename 撞文件锁（EPERM）
        // 时用户以为游标在持久化，实际每次重启都重新记基线、重新推历史。
        this.log('error', `保存缓存失败: ${e}`);
      }
    });
  }

  /** 立即落盘，卸载时用（queueMicrotask 可能来不及执行） */
  saveCacheNow (): void {
    if (!this.dataPath) return;
    this.cacheSaveScheduled = false;
    try {
      if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
      this.writeFileAtomic(path.join(this.dataPath, 'cache.json'), JSON.stringify(this.cache, null, 2));
    } catch (e) {
      this.log('error', `保存缓存失败: ${e}`);
    }
  }

  /**
   * 先写临时文件、fsync 再 rename。
   *
   * 直接 writeFileSync 覆盖原文件时，如果正好断电或进程被杀，
   * 会留下一个截断的 JSON——下次启动解析失败，订阅和游标全丢。
   * rename 在同一文件系统内是原子操作，要么旧内容要么新内容。
   *
   * 光有 rename 还不够：ext4 的 data=ordered 下 rename 可能先于数据块落盘，
   * 崩溃后仍可能得到 0 字节文件。所以临时文件写完要 fsync，rename 后
   * 再 fsync 一次目录（Windows 上目录 fsync 会失败，忽略即可）。
   */
  private writeFileAtomic (target: string, content: string): void {
    const tmp = `${target}.tmp-${process.pid}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, content, 'utf-8');
      try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持，忽略 */ }
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, target);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    // rename 后同步目录项，保证「文件已改名」这件事本身落盘
    try {
      const dirFd = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dirFd); } catch { /* Windows 上不支持，忽略 */ }
      fs.closeSync(dirFd);
    } catch { /* ignore */ }
  }

  loadCache (): void {
    try {
      const fp = path.join(this.dataPath, 'cache.json');
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      // 必须校验类型：cache.json 被手改成 null / 数字 / 字符串（或旧版本非原子写入
      // 留下的残片恰好是合法 JSON）时，this.cache 会被赋成原始值，
      // 之后 cache[key] = ... 在严格模式下直接抛 TypeError，每个仓库每轮都失败。
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.cache = parsed as EventCache;
      } else {
        this.log('warn', 'cache.json 内容不是对象，已重置为空缓存');
        this.cache = {};
      }
    } catch (e) {
      this.log('warn', `读取缓存失败，已重置: ${e}`);
      this.cache = {};
    }
  }

  setPollTimer (timer: ReturnType<typeof setTimeout>): void { this.pollTimer = timer; }
  clearPollTimer (): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /**
   * 清掉某个仓库+分支相关的所有游标和 ETag。
   * 删订阅、改分支时必须调用，否则残留的 key 会一直堆积，
   * 更麻烦的是重新订阅同名分支时会拿旧游标比对，导致漏推或补推历史。
   */
  dropRepoCursors (repo: string, branch?: string): void {
    const lowRepo = repo.toLowerCase();

    for (const k of Object.keys(this.cache)) {
      if (k.startsWith('user:')) continue;
      if (branch) {
        // 精确删掉这个分支的两类 key：`repo:branch` 和 `repo:branch:head`
        if (k === `${lowRepo}:${branch}` || k === `${lowRepo}:${branch}:head`) delete this.cache[k];
      } else {
        if (k.toLowerCase().startsWith(`${lowRepo}:`)) delete this.cache[k];
      }
    }
    // actions 游标按仓库，不分分支
    if (!branch) delete this.cache[`${lowRepo}:actions`];

    for (const k of Object.keys(this.etags)) {
      const lowK = k.toLowerCase();
      if (branch) {
        if (lowK === `commits:${lowRepo}:${branch}`) delete this.etags[k];
      } else if (lowK.startsWith(`commits:${lowRepo}:`)) {
        delete this.etags[k];
      }
    }
    // 删除是即时操作，直接落盘，别等微任务
    this.saveCacheNow();
  }

  /**
   * 发群消息。
   *
   * 这里**不能**再 `.catch(() => {})` 把异常吞掉：
   * `poller.ts` 的 sendImage 靠 `try { sendGroupMsg(...) } catch { 降级为文本 }`
   * 来保证「图片发不出去至少还有文字」，异常被吞之后那段降级是死代码 ——
   * 图片发送失败时用户什么也收不到，日志里也没有任何记录。
   * 现在统一：记录 warn 后向上抛，由调用方决定降级还是重试。
   */
  async sendGroupMsg (groupId: string, message: unknown): Promise<void> {
    if (!this.actions || !this.networkConfig) {
      throw new Error('插件尚未初始化（actions/networkConfig 为空），无法发送消息');
    }
    try {
      await this.actions.call('send_group_msg', { group_id: groupId, message } as never, this.adapterName, this.networkConfig);
    } catch (e) {
      this.log('warn', `[推送] 发送到群 ${groupId} 失败: ${e}`);
      throw e;
    }
  }
}

export const pluginState = new PluginState();
