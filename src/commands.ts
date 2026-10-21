// 指令处理模块
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import type { EventType, Subscription, UserSubscription } from './types';
import { pluginState } from './state';
import { fetchDefaultBranch, normalizeRepo } from './github';

/**
 * 是否为主人。
 *
 * 注意这里必须 fail-closed：原来写的是 `owners.length === 0 || ...`，
 * 而默认配置 owners 就是空数组 —— 等于**任何** QQ 用户都是主人。
 * 私聊发一句 `gh 全部` 就能拿到全部群号，`gh 开启/关闭` 能全局开关别人的订阅。
 * 现在空 owners 视为「还没配置主人」，一律拒绝，由 WebUI 里配置。
 */
function isOwner (userId: string): boolean {
  const owners = pluginState.config.owners || [];
  if (!owners.length) return false;
  return owners.map(String).includes(String(userId));
}

/** 是否有订阅操作权限（主人 或 allowMemberSub 开启） */
function canSub (userId: string): boolean {
  return isOwner(userId) || pluginState.config.allowMemberSub;
}

async function sendReply (event: OB11Message, text: string, ctx: NapCatPluginContext): Promise<void> {
  const msg: unknown[] = [{ type: 'text', data: { text } }];
  // 回复失败不能让指令处理整体失败（配置可能已经保存成功了），
  // 但也不能完全静默——否则用户看不到回复时日志里没有任何线索。
  const target = event.message_type === 'group' ? `群 ${event.group_id}` : `用户 ${event.user_id}`;
  try {
    if (event.message_type === 'group') {
      await ctx.actions.call('send_group_msg', { group_id: event.group_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config);
    } else {
      await ctx.actions.call('send_private_msg', { user_id: event.user_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config);
    }
  } catch (e) {
    pluginState.log('warn', `[指令] 回复${target}失败: ${e}`);
  }
}

/** 处理指令 */
export async function handleCommand (event: OB11Message, cmd: string, ctx: NapCatPluginContext): Promise<boolean> {
  const groupId = event.group_id ? String(event.group_id) : '';
  const userId = String(event.user_id);

  // gh帮助
  if (cmd === '帮助' || cmd === '') {
    const prefix = 'gh';
    const lines: string[] = ['📦 GitHub 订阅插件', ''];
    lines.push(
      `${prefix} 帮助`,
      `${prefix} 列表`,
      `${prefix} 全部`,
    );
    if (canSub(userId)) {
      lines.push(
        `${prefix} 订阅 <owner/repo> [分支名]`,
        `${prefix} 取消 <owner/repo> [分支名]`,
        `${prefix} 开启/关闭 <owner/repo> [分支名]`,
        `${prefix} 关注 <username>`,
        `${prefix} 取关 <username>`,
        `${prefix} 关注列表`,
      );
    }
    lines.push('', '细节配置请前往 WebUI 控制台');
    await sendReply(event, lines.join('\n'), ctx);
    return true;
  }

  // gh 订阅 owner/repo [branch]
  const subMatch = cmd.match(/^订阅\s+([^\s]+)(?:\s+([^\s]+))?$/);
  if (subMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const rawRepo = subMatch[1];
    const specifiedBranch = subMatch[2] || '';
    const repo = normalizeRepo(rawRepo);
    if (!repo) {
      await sendReply(event, '❌ 格式错误，请使用 owner/repo 或仓库链接', ctx);
      return true;
    }

    // 私聊里订阅没有「当前群」可绑定，groups 会是空数组，
    // 而 poll() 会跳过 groups.length === 0 的订阅 —— 用户看着订阅成功，
    // 实际永远不会收到推送。这里直接拒绝并指路 WebUI。
    if (!groupId) {
      await sendReply(event, '❌ 私聊无法确定推送群。请在群里发送订阅指令，或到 WebUI 控制台指定推送群', ctx);
      return true;
    }

    const types: EventType[] = ['commits', 'issues', 'pulls'];

    // 没指定分支就去查默认分支。查不到时不能直接抛（会中断整条指令），
    // 退化成 main，并如实告知用户分支名可能不准
    let branch = specifiedBranch;
    let branchGuessed = false;
    if (!branch) {
      try {
        branch = await fetchDefaultBranch(repo);
      } catch {
        branch = 'main';
        branchGuessed = true;
      }
    }

    const existing = pluginState.config.subscriptions.find(
      s => s.repo.toLowerCase() === repo.toLowerCase() && s.branch === branch,
    );
    if (existing) {
      // 脏配置里 groups 可能不是数组（旧版本/手改），先归一化再操作
      if (!Array.isArray(existing.groups)) existing.groups = [];
      if (groupId && !existing.groups.includes(groupId)) {
        existing.groups.push(groupId);
      }
      existing.enabled = true;
      pluginState.saveConfig();
      await sendReply(event, `✅ 已更新订阅 ${repo} (${branch})\n推送群: ${existing.groups.join(', ') || '无'}`, ctx);
      return true;
    }
    const sub: Subscription = {
      repo, branch, types,
      groups: groupId ? [groupId] : [],
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    pluginState.config.subscriptions.push(sub);
    pluginState.saveConfig();
    const guessHint = branchGuessed ? '\n⚠ 未能读取默认分支，已按 main 订阅，请确认分支名是否正确' : '';
    await sendReply(event, `✅ 已订阅 ${repo}\n分支: ${branch}\n监控: ${types.join(', ')}\n推送群: ${sub.groups.join(', ') || '无'}${guessHint}`, ctx);
    return true;
  }

  // gh 取消 owner/repo [branch]
  const unsubMatch = cmd.match(/^取消\s+([^\s]+)(?:\s+([^\s]+))?$/);
  if (unsubMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const rawRepo = unsubMatch[1];
    const branch = unsubMatch[2] || '';
    const repo = normalizeRepo(rawRepo) || rawRepo;
    // 私聊里 groupId 为空，原逻辑会把订阅整个删掉（跨群越权）：
    // A 群里订阅的仓库，任何人在私聊发「gh 取消」就全没了。
    // 私聊只允许本人看列表，删除必须回到对应群里操作。
    if (!groupId) {
      await sendReply(event, '❌ 请在订阅所在的群里发送取消指令（私聊无法确定要取消哪个群的推送）', ctx);
      return true;
    }
    // 如果指定了分支，精确匹配；否则匹配所有该仓库的订阅
    const matches = pluginState.config.subscriptions.filter(s =>
      s.repo.toLowerCase() === repo.toLowerCase() && (!branch || s.branch === branch)
    );
    if (!matches.length) {
      await sendReply(event, `❌ 未找到订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
      return true;
    }
    // 倒序删：一边遍历一边 splice 会让后面的元素前移，正向遍历会漏删
    const removed: Subscription[] = [];
    let detached = 0;
    for (let i = pluginState.config.subscriptions.length - 1; i >= 0; i--) {
      const sub = pluginState.config.subscriptions[i];
      if (!matches.includes(sub)) continue;
      if (!Array.isArray(sub.groups)) { sub.groups = []; continue; }
      if (sub.groups.includes(groupId)) {
        sub.groups = sub.groups.filter(g => g !== groupId);
        detached++;
        if (sub.groups.length === 0) {
          pluginState.config.subscriptions.splice(i, 1);
          removed.push(sub);
        }
      }
    }
    // 本群压根没订阅这个仓库时，原来会照样回「已取消」——
    // 用户以为取消了，其实别的群还在推，或者本来就没订阅。
    if (!detached) {
      await sendReply(event, `❌ 本群未订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
      return true;
    }
    pluginState.saveConfig();

    // 真正删掉的订阅要连带清掉游标，否则残留 key 会一直堆着；
    // 更麻烦的是重新订阅同名分支时会拿旧游标比对，导致漏推或补推历史。
    for (const sub of removed) {
      const stillHasRepo = pluginState.config.subscriptions.some(
        s => s.repo.toLowerCase() === sub.repo.toLowerCase(),
      );
      pluginState.dropRepoCursors(sub.repo, stillHasRepo ? sub.branch : undefined);
    }
    const label = `${repo}${branch ? ` (${branch})` : ''}`;
    await sendReply(event, `✅ 已取消订阅 ${label}`, ctx);
    return true;
  }

  // gh 列表（所有人可用）
  if (cmd === '列表') {
    // 私聊里 groupId 为空，原来的 filter 条件 `!groupId || ...` 恒真 → 把全部订阅
    // （含其它群的推送目标）都吐给任何一个普通成员。私聊只有主人能看全量。
    if (!groupId && !isOwner(userId)) {
      await sendReply(event, '❌ 私聊查看全部订阅仅主人可用，请在群里发送 ' + '`gh 列表`', ctx);
      return true;
    }
    const subs = pluginState.config.subscriptions.filter(s => !groupId || (Array.isArray(s.groups) && s.groups.includes(groupId)));
    if (!subs.length) {
      await sendReply(event, '📋 当前无订阅', ctx);
      return true;
    }
    const lines = subs.map(s =>
      `${s.enabled ? '✅' : '❌'} ${s.repo}${s.alias ? ` (${s.alias})` : ''} [${(Array.isArray(s.types) ? s.types : []).join(',')}] → ${(Array.isArray(s.groups) ? s.groups : []).length}个群`
    );
    await sendReply(event, `📋 订阅列表 (${subs.length}个):\n${lines.join('\n')}`, ctx);
    return true;
  }

  // gh 全部（含群号，仅主人可看：私聊里任何人发一句就能拿到全部群的群号）
  if (cmd === '全部') {
    if (!isOwner(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const subs = pluginState.config.subscriptions;
    if (!subs.length) {
      await sendReply(event, '📋 当前无订阅', ctx);
      return true;
    }
    const lines = subs.map(s =>
      `${s.enabled ? '✅' : '❌'} ${s.repo} (${s.branch}) [${(Array.isArray(s.types) ? s.types : []).join(',')}] → 群:${(Array.isArray(s.groups) ? s.groups : []).join(',') || '无'}`
    );
    await sendReply(event, `📋 全部订阅 (${subs.length}个):\n${lines.join('\n')}`, ctx);
    return true;
  }

  // gh 开启/关闭 owner/repo [branch]
  const toggleMatch = cmd.match(/^(开启|关闭)\s+([^\s]+)(?:\s+([^\s]+))?$/);
  if (toggleMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const enable = toggleMatch[1] === '开启';
    const repo = normalizeRepo(toggleMatch[2]) || toggleMatch[2];
    const branch = toggleMatch[3] || '';
    const matches = pluginState.config.subscriptions.filter(s =>
      s.repo.toLowerCase() === repo.toLowerCase() && (!branch || s.branch === branch)
    );
    if (!matches.length) {
      await sendReply(event, `❌ 未找到订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
      return true;
    }
    // 群聊里只允许开关「本群在推」的订阅；私聊里只有主人能操作（会影响所有群）
    if (groupId) {
      const mine = matches.filter(s => Array.isArray(s.groups) && s.groups.includes(groupId));
      if (!mine.length) {
        await sendReply(event, `❌ 本群未订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
        return true;
      }
      for (const sub of mine) sub.enabled = enable;
    } else {
      if (!isOwner(userId)) {
        await sendReply(event, '❌ 私聊开关会影响所有群，仅主人可操作', ctx);
        return true;
      }
      for (const sub of matches) sub.enabled = enable;
    }
    pluginState.saveConfig();
    const label = `${repo}${branch ? ` (${branch})` : ''}`;
    await sendReply(event, `✅ ${label} 已${enable ? '开启' : '关闭'}`, ctx);
    return true;
  }

  // gh 关注 username
  const followMatch = cmd.match(/^关注\s+([^\s]+)$/);
  if (followMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const username = followMatch[1];
    if (username.includes('/')) {
      await sendReply(event, '❌ 请输入用户名，不是仓库名', ctx);
      return true;
    }
    // 同「订阅」：私聊关注会得到空 groups，永远不推送
    if (!groupId) {
      await sendReply(event, '❌ 私聊无法确定推送群。请在群里发送关注指令，或到 WebUI 控制台指定推送群', ctx);
      return true;
    }
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const existing = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      if (!Array.isArray(existing.groups)) existing.groups = [];
      if (groupId && !existing.groups.includes(groupId)) existing.groups.push(groupId);
      existing.enabled = true;
      pluginState.saveConfig();
      await sendReply(event, `✅ 已更新用户监控 ${username}\n推送群: ${existing.groups.join(', ') || '无'}`, ctx);
      return true;
    }
    const userSub: UserSubscription = {
      username,
      groups: groupId ? [groupId] : [],
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    pluginState.config.userSubscriptions.push(userSub);
    pluginState.saveConfig();
    await sendReply(event, `✅ 已关注用户 ${username}\n推送群: ${userSub.groups.join(', ') || '无'}`, ctx);
    return true;
  }

  // gh 取关 username
  const unfollowMatch = cmd.match(/^取关\s+([^\s]+)$/);
  if (unfollowMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const username = unfollowMatch[1];
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const idx = pluginState.config.userSubscriptions.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx === -1) {
      await sendReply(event, `❌ 未找到用户监控 ${username}`, ctx);
      return true;
    }
    // 私聊取关同理：groupId 为空时原逻辑会整条删掉（跨群越权）
    if (!groupId) {
      await sendReply(event, '❌ 请在关注该用户的群里发送取关指令（私聊无法确定要取消哪个群的推送）', ctx);
      return true;
    }
    {
      const sub = pluginState.config.userSubscriptions[idx];
      if (!Array.isArray(sub.groups)) sub.groups = [];
      if (!sub.groups.includes(groupId)) {
        await sendReply(event, `❌ 本群未关注 ${username}`, ctx);
        return true;
      }
      sub.groups = sub.groups.filter(g => g !== groupId);
      const fullyRemoved = sub.groups.length === 0;
      if (fullyRemoved) pluginState.config.userSubscriptions.splice(idx, 1);
      // 先落盘再回复：原来回复在前、saveConfig 在后，
      // 回复一旦失败（QQ 掉线、群被禁言）直接 return，配置就不保存了 ——
      // 用户看着操作没成功，重启后订阅却还在。
      pluginState.saveConfig();
      await sendReply(
        event,
        fullyRemoved ? `✅ 已完全取关 ${username}` : `✅ 已从本群取关 ${username}（其他群仍在推送）`,
        ctx,
      );
    }
    return true;
  }

  // gh 关注列表
  if (cmd === '关注列表') {
    // 与「列表」同理：私聊不限 groupId 会把全部用户监控（含其它群）吐给普通成员
    if (!groupId && !isOwner(userId)) {
      await sendReply(event, '❌ 私聊查看全部用户监控仅主人可用，请在群里发送 ' + '`gh 关注列表`', ctx);
      return true;
    }
    const users = (pluginState.config.userSubscriptions || []).filter(u => !groupId || (Array.isArray(u.groups) && u.groups.includes(groupId)));
    if (!users.length) {
      await sendReply(event, '📋 当前无用户监控', ctx);
      return true;
    }
    const lines = users.map(u =>
      `${u.enabled ? '✅' : '❌'} ${u.username} → ${(Array.isArray(u.groups) ? u.groups : []).length}个群`
    );
    await sendReply(event, `📋 用户监控列表 (${users.length}个):\n${lines.join('\n')}`, ctx);
    return true;
  }

  return false;
}
