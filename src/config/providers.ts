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
        // `deepseek-chat` 这个别名 DeepSeek 官方悄悄迁到了 V4 flash 非思考模式，
        // 为不破坏老对话里 localStorage 存下来的 modelId，我们保留别名，只更新
        // 展示名和描述。新用户也会拿到 V4，老用户无感升级。
        id: 'deepseek-chat',
        providerId: 'deepseek',
        displayName: 'DeepSeek V4 Flash',
        description: '通用对话，1M 上下文，工具调用稳定，性价比极高（$0.14/M in）',
        contextWindow: 1_000_000,
        capabilities: { tools: true },
        recommendedFor: ['chat', 'code'],
      },
      {
        // V4 的"思考模式"；和 deepseek-chat 共享底座，只是调用时走推理路径、
        // 响应里多一份 reasoning_content。V4 里思考其实是个请求参数，但为了
        // 保持 UI 的「深度思考」一键切换逻辑，我们仍把它暴露成独立 model ID，
        // 并复用 `deepseek-reasoner` 别名——官方同样迁到了 V4 flash 思考模式。
        id: 'deepseek-reasoner',
        providerId: 'deepseek',
        displayName: 'DeepSeek V4 Flash · Thinking',
        description: '深度思考模式（V4 hybrid），数学/代码/逻辑推理最强',
        contextWindow: 1_000_000,
        capabilities: { tools: true, reasoning: true },
        recommendedFor: ['chat', 'code'],
      },
      {
        // V4 旗舰，真正的升级档位。比 flash 贵 ~12 倍但推理/代码/长文都更强；
        // 默认不选它，让用户在重任务里主动切过来。思考模式同样是参数化的，
        // 但我们只暴露一个 ID——Pro 本身就贵到不适合随手开深度思考。
        id: 'deepseek-v4-pro',
        providerId: 'deepseek',
        displayName: 'DeepSeek V4 Pro',
        description: '旗舰模型，1M 上下文，数学/代码/长文最强；$1.74/M in，重任务再开',
        contextWindow: 1_000_000,
        capabilities: { tools: true, reasoning: true, longContext: true },
        recommendedFor: ['code'],
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
        description: '旗舰对话模型，通用能力最强（仅文本）',
        contextWindow: 32_000,
        // qwen-max in DashScope's OpenAI-compat mode is text-only — sending
        // image_url parts to it gets them silently dropped. Vision lives on
        // the dedicated qwen-vl-* family below. We had this set to `true`
        // and design-mode image attachments routed here for ~3 releases
        // before we caught it; the model produces hallucinated picsum
        // placeholders since it never actually saw the image.
        capabilities: { tools: true },
        recommendedFor: ['chat'],
      },
      {
        id: 'qwen3-vl-plus',
        providerId: 'qwen',
        displayName: 'Qwen3-VL-Plus（视觉旗舰）',
        description: '视觉理解 + 深度思考双模式，设计稿改写首选',
        contextWindow: 128_000,
        capabilities: { vision: true },
        // Design picks this up automatically when an image is attached;
        // listing `recommendedFor: ['design']` keeps it discoverable in
        // the model picker for users who want to manually pin it.
        recommendedFor: ['design'],
      },
      {
        id: 'qwen3-vl-flash',
        providerId: 'qwen',
        displayName: 'Qwen3-VL-Flash（视觉极速）',
        description: '小尺寸视觉理解，便宜快速；适合粗略描述图片',
        contextWindow: 128_000,
        capabilities: { vision: true },
        recommendedFor: ['design'],
      },
      {
        id: 'qwen-plus',
        providerId: 'qwen',
        displayName: 'Qwen-Plus',
        description: '平衡性能与成本',
        contextWindow: 128_000,
        // Same caveat as qwen-max — compat-mode is text-only despite the
        // model card listing multimodal snapshots. Don't claim vision here.
        capabilities: { tools: true },
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
  // 智谱 GLM 已下架（v0.1.51）。BigModel 的 OpenAI-compat 端点对工具调用经常
  // 给出不规范的 finish_reason，叠加 GLM-4-Plus 在中文长文上又比 DeepSeek V4 Pro
  // 弱，留着只会让默认池子更复杂；用户也可以在 Settings 里手动加回 custom
  // provider 如果真的想用。
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
  {
    // PPIO is a model gateway exposing multiple model families behind
    // ONE host but DIFFERENT endpoint paths. The `baseUrl` field on
    // ProviderConfig is OpenAI-compat-shaped — it doesn't fit cleanly
    // here, since neither of PPIO's path families is OpenAI-compatible
    // for Claude or for image gen. We keep `baseUrl` set to the host
    // root for clarity and document the actual paths in each model's
    // comment.
    //
    // Path family 1 — image gen: POST https://api.ppio.com/v3/gpt-image-2-text-to-image
    //   Invoked via Worker `/tools/image_generate` (server-side proxy
    //   with shared key). Does NOT use ProviderConfig.baseUrl at all
    //   — the Worker hardcodes the full URL.
    //
    // Path family 2 — Anthropic chat (v0.1.49): POST https://api.ppio.com/anthropic/v1/messages
    //   Wired by a Worker-side OpenAI ↔ Anthropic translator
    //   (server/src/anthropicAdapter.ts) that detects `pa/claude-*` model
    //   ids and switches request base path + auth header (Bearer →
    //   x-api-key + anthropic-version) + body shape (OpenAI messages →
    //   Anthropic system/messages/content blocks). Streaming is
    //   transformed event-by-event so the client still consumes
    //   OpenAI-shaped SSE.
    id: 'ppio',
    displayName: 'PPIO 派欧',
    baseUrl: 'https://api.ppio.com',
    enabled: true,
    models: [
      {
        id: 'gpt-image-2',
        providerId: 'ppio',
        displayName: 'GPT Image 2 · 文生图',
        description:
          '高质量 AI 图像生成。Design 模式 image_generate 工具调用此模型。低/中/高三档质量。' +
          '实际请求走 Worker 代理 → POST api.ppio.com/v3/gpt-image-2-text-to-image。',
        contextWindow: 0, // image gen — not a chat model
        capabilities: { imageGen: true },
        recommendedFor: ['design'],
      },
      {
        // Claude Sonnet 4.6 — daily-driver Claude tier. Best balance of
        // intelligence + speed + cost in the 4.x lineage. Tools + vision +
        // reasoning all on. Recommended for everyday Code + Design work
        // where DeepSeek V4 Pro feels slightly off.
        id: 'pa/claude-sonnet-4-6',
        providerId: 'ppio',
        displayName: 'Claude Sonnet 4.6',
        description:
          '日常旗舰 Claude（4.x 线）。代码 / 推理 / 视觉 / 工具调用全开。$3 / $15 per M tokens。',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true, longContext: true },
        recommendedFor: ['chat', 'code', 'design'],
      },
      {
        // Claude Haiku 4.5 — fastest / cheapest of the 4.x line. Vision
        // + tools still supported but with weaker reasoning. Good for
        // chat / classification / quick lookups where Sonnet is overkill.
        id: 'pa/claude-haiku-4-5-20251001',
        providerId: 'ppio',
        displayName: 'Claude Haiku 4.5',
        description:
          '小尺寸 Claude，快 + 便宜。视觉 + 工具仍开。适合快速对话 / 分类。$1 / $5 per M tokens。',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true },
        recommendedFor: ['chat'],
      },
      {
        // Claude Opus 4.6 — top-tier reasoning. 5x cost of Sonnet,
        // typically reserved for tasks Sonnet visibly fails at (long-form
        // synthesis, hard math, multi-step planning). Don't make it the
        // default — too easy to burn budget unintentionally.
        id: 'pa/claude-opus-4-6',
        providerId: 'ppio',
        displayName: 'Claude Opus 4.6',
        description:
          '顶配 Claude，深度推理 / 长文综合 / 难任务。$15 / $75 per M tokens——重任务再开。',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true, longContext: true },
        recommendedFor: ['code'],
      },
      // v0.1.50: Extended Thinking variants. Functionally same model
      // as Sonnet/Opus but with `thinking: enabled` injected at the
      // Worker. Toggleable from Composer's 「深度思考」 button — see
      // REASONER_PAIRS below.
      // (No Haiku-thinking entry: Anthropic Haiku 4.5 doesn't support
      // extended thinking.)
      {
        id: 'pa/claude-sonnet-4-6-thinking',
        providerId: 'ppio',
        displayName: 'Claude Sonnet 4.6 · Thinking',
        description:
          '深度思考模式（extended thinking）。模型先输出推理链再给答案；适合数学、代码、多步规划。同价 $3 / $15 per M tokens——budget 16k 思考 token 内不额外计费。',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true, longContext: true },
        recommendedFor: ['code'],
      },
      {
        id: 'pa/claude-opus-4-6-thinking',
        providerId: 'ppio',
        displayName: 'Claude Opus 4.6 · Thinking',
        description:
          '顶配 Claude + 深度思考。最强推理 + 长文 + 难任务。$15 / $75 per M tokens。',
        contextWindow: 200_000,
        capabilities: { tools: true, vision: true, reasoning: true, longContext: true },
        recommendedFor: ['code'],
      },
    ],
  },
];

/** Default *language* model picks per mode — used when user has not overridden.
 *  Design has additional defaults (vision + image-gen) below; this one is
 *  for the text/code generation slot only. */
export const DEFAULT_MODEL_BY_MODE: Record<'chat' | 'code' | 'design', string> = {
  chat: 'deepseek-chat',
  code: 'deepseek-chat',
  // Design mode produces UI code (HTML/Tailwind/JSX/SVG); V4 Pro generates
  // noticeably more polished and complete designs than Flash, and the visual
  // quality difference dwarfs the token-cost difference for this use case.
  // Users who want to save tokens can manually flip to deepseek-chat (Flash);
  // we surface that hint via UI in DesignView.
  design: 'deepseek-v4-pro',
};

/** Default vision model for Design mode. Used when an image is attached and
 *  the active language model can't see images — useStreamedChat auto-routes
 *  that single turn through this model. v0.1.48 made this user-configurable
 *  via Settings → 默认模型 → Design → 视觉模型. */
export const DEFAULT_DESIGN_VISION_MODEL = 'qwen3-vl-plus';

/** Default image-generation model for Design mode. The `image_generate`
 *  tool calls /tools/image_generate with this model id; v1 only supports
 *  gpt-image-2 but the server-side endpoint accepts a `model` field for
 *  future expansion. */
export const DEFAULT_DESIGN_IMAGE_GEN_MODEL = 'gpt-image-2';

/**
 * Vision-capable model used as a fallback when a Design-mode message has
 * image attachments. V4 Pro can't see images; Qwen3-VL-Plus can. We
 * auto-route just that single turn through Qwen3-VL-Plus and bounce back
 * to V4 Pro on the next text-only turn — the user gets screenshot-redesign
 * for free, with no manual model switching.
 *
 * **Why `qwen3-vl-plus` and not Qwen-VL-Max**: as of 2026-04 Alibaba
 * retired the `qwen-vl-max` line and rolled the flagship vision tier into
 * Qwen3-VL-Plus, which adds a "thinking" mode on top of vision — useful
 * when the user asks for stylistic transforms ("change to van Gogh
 * style") that benefit from reasoning before output. The previous
 * `qwen-vl-max-latest` ID is no longer listed on bailian.console; if a
 * user has a stale conversation pinned to it, the upstream returns 400
 * and we'd need a one-shot heal at rehydrate (not currently shipped —
 * those conversations would just need a model re-pick).
 *
 * **Why not `qwen-max` (the original default, replaced 2026-04-26)**:
 * `qwen-max` in DashScope's OpenAI-compat mode is text-only — image_url
 * content parts get silently dropped, the model hallucinates picsum.photos
 * placeholders, and the user gets a mountain stock photo instead of a
 * redesigned screenshot. Vision lives on the dedicated `qwen3-vl-*`
 * family. (See `git log src/config/providers.ts` for the v0.1.14 → v0.1.15
 * sequence that worked through this.)
 *
 * **Why Plus over Flash**: Plus's reasoning + larger model is worth the
 * 4-5× cost premium when the user's whole point is "look at this and
 * redesign it" — Flash is cheap but tends to ignore subtle layout cues
 * the user expects to be picked up. Users who want speed-over-quality
 * can manually pick `qwen3-vl-flash` from the model picker.
 *
 * **Why not Claude vision here as default**: Sonnet 4.6 vision is excellent
 * but PPIO charges $3/M input — vs. Qwen3-VL-Plus at ~$0.86/M input. For the
 * "redesign this screenshot" use case the quality bump doesn't justify ~3.5×
 * cost; users who want it can pick it explicitly in the Design TopBar.
 */
export const DESIGN_VISION_FALLBACK_MODEL = 'qwen3-vl-plus';

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
  // v0.1.50: Claude extended-thinking variants. The `-thinking` suffix
  // is stripped Worker-side by anthropicAdapter; the suffixed id is
  // purely a client-side toggle marker. Haiku-4.5 has no thinking
  // mode upstream, so it's not paired.
  'pa/claude-sonnet-4-6': 'pa/claude-sonnet-4-6-thinking',
  'pa/claude-sonnet-4-6-thinking': 'pa/claude-sonnet-4-6',
  'pa/claude-opus-4-6': 'pa/claude-opus-4-6-thinking',
  'pa/claude-opus-4-6-thinking': 'pa/claude-opus-4-6',
};

/**
 * Is this model id the "thinking ON" side of a reasoner pair?
 *
 * Composer's 「思考」 toggle uses this to decide whether the button is
 * highlighted (purple "on" pill) vs neutral. **It's deliberately separate
 * from `capabilities.reasoning`**: that capability flag advertises a
 * model's general reasoning strength to the user (e.g. Claude Opus 4.6 is
 * a strong reasoner regardless of whether extended-thinking is enabled —
 * we want the 推理 badge in the model dropdown). Conflating the two —
 * which v0.1.50 / v0.1.51 did — meant Opus 4.6 (capabilities.reasoning
 * = true) showed the toggle as already-ON and clicking it just bounced
 * to the `-thinking` variant (still ON) → user could never turn it off.
 *
 * Rule of truth: thinking is ON iff the current model id matches a
 * statically-known thinking variant — Anthropic's `-thinking` suffix or
 * DeepSeek's `deepseek-reasoner` alias. Any future provider that adds
 * a clean toggle should be appended here, NOT inferred from capabilities.
 */
export function isThinkingVariant(modelId: string): boolean {
  if (!modelId) return false;
  if (modelId.endsWith('-thinking')) return true;
  if (modelId === 'deepseek-reasoner') return true;
  return false;
}
