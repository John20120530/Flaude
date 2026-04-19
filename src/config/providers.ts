import type { ProviderConfig } from '@/types';

/**
 * Default provider catalog for Chinese open-source LLMs.
 * All endpoints expose OpenAI-compatible APIs, so we can use one client.
 *
 * Users fill in their own API keys via Settings; keys are stored locally only.
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: true,
    models: [
      {
        id: 'deepseek-chat',
        providerId: 'deepseek',
        displayName: 'DeepSeek V3',
        description: '通用对话，代码能力强，性价比极高',
        contextWindow: 128_000,
        capabilities: { tools: true },
        recommendedFor: ['chat', 'code'],
      },
      {
        // V3.2 的"思考模式"；和 deepseek-chat 共享底座，只是调用时走推理路径、
        // 响应里多一份 reasoning_content。不支持工具调用（官方限制）。
        id: 'deepseek-reasoner',
        providerId: 'deepseek',
        displayName: 'DeepSeek Reasoner',
        description: '深度思考模式（V3.2 hybrid），数学/代码/逻辑最强；不支持工具调用',
        contextWindow: 128_000,
        capabilities: { tools: false, reasoning: true },
        recommendedFor: ['chat', 'code'],
      },
    ],
  },
  {
    id: 'qwen',
    displayName: 'Qwen 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    enabled: true,
    models: [
      {
        id: 'qwen-max',
        providerId: 'qwen',
        displayName: 'Qwen-Max',
        description: '旗舰对话模型，通用能力最强',
        contextWindow: 32_000,
        capabilities: { tools: true, vision: true },
        recommendedFor: ['chat'],
      },
      {
        id: 'qwen-plus',
        providerId: 'qwen',
        displayName: 'Qwen-Plus',
        description: '平衡性能与成本',
        contextWindow: 128_000,
        capabilities: { tools: true, vision: true },
        recommendedFor: ['chat', 'code'],
      },
      {
        id: 'qwen-long',
        providerId: 'qwen',
        displayName: 'Qwen-Long',
        description: '超长上下文，文档分析',
        contextWindow: 10_000_000,
        capabilities: { tools: false, longContext: true },
        recommendedFor: ['chat'],
      },
      {
        id: 'qwen-coder-plus',
        providerId: 'qwen',
        displayName: 'Qwen-Coder',
        description: '代码生成专精',
        contextWindow: 128_000,
        capabilities: { tools: true },
        recommendedFor: ['code'],
      },
    ],
  },
  {
    id: 'zhipu',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    enabled: true,
    models: [
      {
        id: 'glm-4-plus',
        providerId: 'zhipu',
        displayName: 'GLM-4 Plus',
        description: '旗舰模型，工具调用稳定',
        contextWindow: 128_000,
        capabilities: { tools: true, vision: true },
        recommendedFor: ['chat', 'code'],
      },
      {
        id: 'glm-4-air',
        providerId: 'zhipu',
        displayName: 'GLM-4 Air',
        description: '轻量快速',
        contextWindow: 128_000,
        capabilities: { tools: true },
        recommendedFor: ['chat'],
      },
    ],
  },
  {
    id: 'moonshot',
    displayName: 'Kimi 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    enabled: true,
    models: [
      {
        id: 'moonshot-v1-128k',
        providerId: 'moonshot',
        displayName: 'Kimi 128K',
        description: '长上下文擅长文档问答',
        contextWindow: 128_000,
        capabilities: { tools: true, longContext: true },
        recommendedFor: ['chat'],
      },
      {
        id: 'moonshot-v1-auto',
        providerId: 'moonshot',
        displayName: 'Kimi Auto',
        description: '自动选择上下文长度',
        contextWindow: 200_000,
        capabilities: { tools: true, longContext: true },
        recommendedFor: ['chat'],
      },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    enabled: false,
    models: [
      {
        id: 'abab6.5s-chat',
        providerId: 'minimax',
        displayName: 'MiniMax M1',
        description: '长文本能力强',
        contextWindow: 245_000,
        capabilities: { tools: true, longContext: true },
        recommendedFor: ['chat'],
      },
    ],
  },
];

/** Default model picks per mode — used when user has not overridden. */
export const DEFAULT_MODEL_BY_MODE: Record<'chat' | 'code', string> = {
  chat: 'qwen-plus',
  code: 'deepseek-chat',
};

/**
 * Models that come in "base ↔ reasoner" pairs — same family, non-thinking vs
 * thinking variant. The Composer's 「深度思考」 toggle only shows up when the
 * current conversation's model is a key in this map (either side of a pair).
 *
 * We keep this as a flat symmetric map so the toggle logic is a single lookup
 * in either direction: `REASONER_PAIRS[modelId]` returns the *other* variant,
 * or undefined if this model family doesn't have a thinking sibling in our
 * catalog.
 *
 * Currently only DeepSeek exposes a clean toggle like this (`deepseek-chat`
 * ↔ `deepseek-reasoner` share the V3.2 base). Qwen / GLM / Kimi all have
 * reasoning models too but they're separately-named and fee-structured
 * enough that pairing would mislead — add them here as we gain confidence.
 */
export const REASONER_PAIRS: Record<string, string> = {
  'deepseek-chat': 'deepseek-reasoner',
  'deepseek-reasoner': 'deepseek-chat',
};
