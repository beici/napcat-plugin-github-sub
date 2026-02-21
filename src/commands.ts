// 指令处理模块
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import type { EventType, Subscription, UserSubscription } from './types';
import { pluginState } from './state';
import { fetchDefaultBranch } from './github';
import { stopPoller, startPoller } from './poller';

function isOwner (userId: string): boolean {
  const owners = pluginState.config.owners || [];
  return owners.length === 0 || owners.includes(String(userId));
}

/** 是否有订阅操作权限（主人 或 allowMemberSub 开启） */
function canSub (userId: string): boolean {
  return isOwner(userId) || pluginState.config.allowMemberSub;
}

async function sendReply (event: OB11Message, text: string, ctx: NapCatPluginContext): Promise<void> {
  const msg: unknown[] = [{ type: 'text', data: { text } }];
  if (event.message_type === 'group') {
    await ctx.actions.call('send_group_msg', { group_id: event.group_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
  } else {
    await ctx.actions.call('send_private_msg', { user_id: event.user_id, message: msg } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
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
    const repo = subMatch[1];
    const specifiedBranch = subMatch[2] || '';
    if (!repo.includes('/')) {
      await sendReply(event, '❌ 格式错误，请使用 owner/repo 格式', ctx);
      return true;
    }

    const types: EventType[] = ['commits', 'issues', 'pulls'];

    const branch = specifiedBranch || await fetchDefaultBranch(repo);

    const existing = pluginState.config.subscriptions.find(s => s.repo === repo && s.branch === branch);
    if (existing) {
      if (groupId && !existing.groups.includes(groupId)) {
        existing.groups.push(groupId);
      }
      existing.enabled = true;
      pluginState.saveConfig();
      await sendReply(event, `✅ 已更新订阅 ${repo} (${branch})\n推送群: ${existing.groups.join(', ')}`, ctx);
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
    await sendReply(event, `✅ 已订阅 ${repo}\n分支: ${branch}\n监控: ${types.join(', ')}\n推送群: ${sub.groups.join(', ') || '无'}`, ctx);
    return true;
  }

  // gh 取消 owner/repo [branch]
  const unsubMatch = cmd.match(/^取消\s+([^\s]+)(?:\s+([^\s]+))?$/);
  if (unsubMatch) {
    if (!canSub(userId)) {
      await sendReply(event, '❌ 该指令仅主人可触发', ctx);
      return true;
    }
    const repo = unsubMatch[1];
    const branch = unsubMatch[2] || '';
    // 如果指定了分支，精确匹配；否则匹配所有该仓库的订阅
    const matches = pluginState.config.subscriptions.filter(s =>
      s.repo === repo && (!branch || s.branch === branch)
    );
    if (!matches.length) {
      await sendReply(event, `❌ 未找到订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
      return true;
    }
    for (const sub of matches) {
      const idx = pluginState.config.subscriptions.indexOf(sub);
      if (groupId) {
        sub.groups = sub.groups.filter(g => g !== groupId);
        if (sub.groups.length === 0) {
          pluginState.config.subscriptions.splice(idx, 1);
        }
      } else {
        pluginState.config.subscriptions.splice(idx, 1);
      }
    }
    pluginState.saveConfig();
    const label = `${repo}${branch ? ` (${branch})` : ''}`;
    await sendReply(event, `✅ 已取消订阅 ${label}`, ctx);
    return true;
  }

  // gh 列表（所有人可用）
  if (cmd === '列表') {
    const subs = pluginState.config.subscriptions.filter(s => !groupId || s.groups.includes(groupId));
    if (!subs.length) {
      await sendReply(event, '📋 当前无订阅', ctx);
      return true;
    }
    const lines = subs.map(s =>
      `${s.enabled ? '✅' : '❌'} ${s.repo} [${s.types.join(',')}] → ${s.groups.length}个群`
    );
    await sendReply(event, `📋 订阅列表 (${subs.length}个):\n${lines.join('\n')}`, ctx);
    return true;
  }

  // gh 全部（所有人可用）
  if (cmd === '全部') {
    const subs = pluginState.config.subscriptions;
    if (!subs.length) {
      await sendReply(event, '📋 当前无订阅', ctx);
      return true;
    }
    const lines = subs.map(s =>
      `${s.enabled ? '✅' : '❌'} ${s.repo} (${s.branch}) [${s.types.join(',')}] → 群:${s.groups.join(',') || '无'}`
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
    const repo = toggleMatch[2];
    const branch = toggleMatch[3] || '';
    const matches = pluginState.config.subscriptions.filter(s =>
      s.repo === repo && (!branch || s.branch === branch)
    );
    if (!matches.length) {
      await sendReply(event, `❌ 未找到订阅 ${repo}${branch ? ` (${branch})` : ''}`, ctx);
      return true;
    }
    for (const sub of matches) sub.enabled = enable;
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
    if (!pluginState.config.userSubscriptions) pluginState.config.userSubscriptions = [];
    const existing = pluginState.config.userSubscriptions.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      if (groupId && !existing.groups.includes(groupId)) existing.groups.push(groupId);
      existing.enabled = true;
      pluginState.saveConfig();
      await sendReply(event, `✅ 已更新用户监控 ${username}\n推送群: ${existing.groups.join(', ')}`, ctx);
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
    if (groupId) {
      const sub = pluginState.config.userSubscriptions[idx];
      sub.groups = sub.groups.filter(g => g !== groupId);
      if (sub.groups.length === 0) {
        pluginState.config.userSubscriptions.splice(idx, 1);
        await sendReply(event, `✅ 已完全取关 ${username}`, ctx);
      } else {
        await sendReply(event, `✅ 已从本群取关 ${username}（其他群仍在推送）`, ctx);
      }
    } else {
      pluginState.config.userSubscriptions.splice(idx, 1);
      await sendReply(event, `✅ 已取关 ${username}`, ctx);
    }
    pluginState.saveConfig();
    return true;
  }

  // gh 关注列表
  if (cmd === '关注列表') {
    const users = (pluginState.config.userSubscriptions || []).filter(u => !groupId || u.groups.includes(groupId));
    if (!users.length) {
      await sendReply(event, '📋 当前无用户监控', ctx);
      return true;
    }
    const lines = users.map(u =>
      `${u.enabled ? '✅' : '❌'} ${u.username} → ${u.groups.length}个群`
    );
    await sendReply(event, `📋 用户监控列表 (${users.length}个):\n${lines.join('\n')}`, ctx);
    return true;
  }

  return false;
}
