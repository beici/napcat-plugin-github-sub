// 默认配置
import type { PluginConfig } from './types';

export const DEFAULT_CONFIG: PluginConfig = {
  token: '',
  tokens: [],
  apiBase: 'https://api.github.com',
  interval: 60,
  commitSource: 'commits',
  debug: false,
  owners: [],
  allowMemberSub: true,
  theme: 'light',
  autoDetectRepo: true,
  mergeNotify: false,
  llm: {
    enabled: false,
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    maxTokens: 400,
    timeout: 15000,
    temperature: 0.3,
    maxDiffChars: 6000,
    prompt: '',
  },
  subscriptions: [],
  userSubscriptions: [],
};
