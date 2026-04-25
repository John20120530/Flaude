/**
 * Upstream provider registry.
 *
 * Adding a new provider later:
 *   1. Add a ProviderConfig entry below (baseUrl, keyEnvName, models + prices).
 *   2. Add the env var to env.ts's Env interface.
 *   3. Add a placeholder to .dev.vars.example, then `wrangler secret put NAME`
 *      for the production Worker.
 *
 * We deliberately stay OpenAI-compatible on the wire: request bodies use
 * { model, messages, stream, ... } and responses conform to the
 * chat.completions schema. Every Chinese provider we care about (DeepSeek,
 * Qwen/DashScope's OpenAI-mode, Zhipu BigModel, Moonshot) exposes this shape,
 * so the proxy body passes through with minimal rewriting.
 */
import type { Env } from './env';

export type ProviderId = 'deepseek' | 'qwen' | 'zhipu' | 'moonshot';

export interface ModelPricing {
  /** Input tokens: cost in micro-USD per 1_000 tokens. */
  inputMicroUsdPer1k: number;
  /** Output tokens: cost in micro-USD per 1_000 tokens. */
  outputMicroUsdPer1k: number;
}

export interface ProviderConfig {
  id: ProviderId;
  /** Full URL of the chat.completions endpoint. */
  baseUrl: string;
  /** Name of the env var that holds the API key for this provider. */
  keyEnvName: keyof Env;
  /** Models we expose through this provider, keyed by the string the client
   *  sends in `model`. */
  models: Record<string, ModelPricing>;
}

// DeepSeek pricing as of 2026-04 (always re-check https://api-docs.deepseek.com
// before a deploy; prices have dropped twice in the last year).
//
//   deepseek-chat       : input  $0.27 / 1M  (cache miss)  →  270 micros/1k
//                         output $1.10 / 1M                → 1100 micros/1k
//   deepseek-reasoner   : input  $0.55 / 1M                →  550 micros/1k
//                         output $2.19 / 1M                → 2190 micros/1k
//   deepseek-v4-flash   : input  $0.14 / 1M                →  140 micros/1k
//                         output $0.55 / 1M                →  550 micros/1k
//   deepseek-v4-pro     : input  $1.74 / 1M                → 1740 micros/1k
//                         output $8.70 / 1M                → 8700 micros/1k
//
// V4 family note: the new `deepseek-v4-flash` and `deepseek-v4-pro` IDs are
// what the upstream actually exposes for the V4 series — clients pick them
// directly. The legacy `deepseek-chat` / `deepseek-reasoner` IDs remain
// accepted by the upstream until 2026-07-24, after which they're retired and
// callers must use the V4-* IDs. We register both today so:
//   - Existing conversations in users' localStorage with modelId='deepseek-chat'
//     keep working through the transition,
//   - New conversations created in v0.1.9+ stamp 'deepseek-v4-pro' (Design
//     mode default) or 'deepseek-v4-flash' and route correctly.
// Cleanup of the legacy entries should ship in the deploy after 2026-07-24,
// at which point the upstream will start returning 400 for them anyway.
//
// We ignore cache-hit discounts in accounting — the savings are small at our
// scale and it's not worth tracking the hit/miss split.
const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  keyEnvName: 'DEEPSEEK_API_KEY',
  models: {
    'deepseek-chat':       { inputMicroUsdPer1k:  270, outputMicroUsdPer1k: 1100 },
    'deepseek-reasoner':   { inputMicroUsdPer1k:  550, outputMicroUsdPer1k: 2190 },
    'deepseek-v4-flash':   { inputMicroUsdPer1k:  140, outputMicroUsdPer1k:  550 },
    'deepseek-v4-pro':     { inputMicroUsdPer1k: 1740, outputMicroUsdPer1k: 8700 },
  },
};

// Qwen via DashScope's OpenAI-compatible endpoint. The `compatible-mode`
// path exists specifically so chat.completions clients work unchanged —
// don't fall back to the native /api/v1/services/... endpoint, it has a
// different request schema.
//
// Pricing as of 2026-04 (DashScope public rates, converted from CNY @ ~¥7/$):
//   qwen-turbo       : input  ¥0.3 / 1M  ≈ $0.043 → 43 micros/1k
//                      output ¥0.6 / 1M  ≈ $0.086 → 86 micros/1k
//   qwen-plus        : input  ¥0.8 / 1M  ≈ $0.114 → 114 micros/1k
//                      output ¥2.0 / 1M  ≈ $0.286 → 286 micros/1k
//   qwen-max         : input  ¥2.4 / 1M  ≈ $0.343 → 343 micros/1k
//                      output ¥9.6 / 1M  ≈ $1.371 → 1371 micros/1k
//   qwen-long        : input  ¥0.5 / 1M  ≈ $0.071 → 71 micros/1k  (long-ctx tier)
//                      output ¥2.0 / 1M  ≈ $0.286 → 286 micros/1k
//   qwen-coder-plus  : input  ¥3.5 / 1M  ≈ $0.500 → 500 micros/1k (coder tier)
//                      output ¥7.0 / 1M  ≈ $1.000 → 1000 micros/1k
//
// Re-check before production; Alibaba adjusts prices quarterly.
const QWEN: ProviderConfig = {
  id: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  keyEnvName: 'QWEN_API_KEY',
  models: {
    'qwen-turbo':       { inputMicroUsdPer1k:  43, outputMicroUsdPer1k:   86 },
    'qwen-plus':        { inputMicroUsdPer1k: 114, outputMicroUsdPer1k:  286 },
    'qwen-max':         { inputMicroUsdPer1k: 343, outputMicroUsdPer1k: 1371 },
    'qwen-long':        { inputMicroUsdPer1k:  71, outputMicroUsdPer1k:  286 },
    'qwen-coder-plus':  { inputMicroUsdPer1k: 500, outputMicroUsdPer1k: 1000 },
  },
};

// Zhipu GLM via BigModel. Their OpenAI-compatible endpoint under /paas/v4 is
// the one to target; the older /api/paas/v3 one uses their own schema.
//
// Pricing as of 2026-04 (rough, converted from CNY @ ~¥7/$):
//   glm-4-air  : input  ¥0.5 / 1M  ≈ $0.071 → 71 micros/1k
//                output ¥0.5 / 1M  ≈ $0.071 → 71 micros/1k
//   glm-4-plus : input  ¥5   / 1M  ≈ $0.714 → 714 micros/1k
//                output ¥5   / 1M  ≈ $0.714 → 714 micros/1k
//   glm-4-flash: free tier — still bill at a nominal rate so quota math works.
//
// Re-check upstream before production.
const ZHIPU: ProviderConfig = {
  id: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  keyEnvName: 'ZHIPU_API_KEY',
  models: {
    'glm-4-flash': { inputMicroUsdPer1k:   0, outputMicroUsdPer1k:   0 },
    'glm-4-air':   { inputMicroUsdPer1k:  71, outputMicroUsdPer1k:  71 },
    'glm-4-plus':  { inputMicroUsdPer1k: 714, outputMicroUsdPer1k: 714 },
  },
};

// Moonshot Kimi. Standard OpenAI-compatible at /v1/chat/completions. The
// model name encodes context window (8k / 32k / 128k) — clients pick the
// right one, pricing scales accordingly.
//
// Pricing as of 2026-04 (rough, converted from CNY @ ~¥7/$):
//   moonshot-v1-8k   : ¥12 / 1M  ≈ $1.71  → 1714 micros/1k (both dirs)
//   moonshot-v1-32k  : ¥24 / 1M  ≈ $3.43  → 3429 micros/1k
//   moonshot-v1-128k : ¥60 / 1M  ≈ $8.57  → 8571 micros/1k
//   moonshot-v1-auto : Moonshot picks the cheapest tier large enough for the
//                      prompt. We bill at the 128k rate (worst case) since we
//                      can't see Moonshot's tier choice from the response;
//                      this slightly over-bills auto-mode users on short
//                      prompts but never under-bills, which is the right
//                      direction for a prepaid quota system.
//
// Re-check upstream before production.
const MOONSHOT: ProviderConfig = {
  id: 'moonshot',
  baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
  keyEnvName: 'MOONSHOT_API_KEY',
  models: {
    'moonshot-v1-8k':   { inputMicroUsdPer1k: 1714, outputMicroUsdPer1k: 1714 },
    'moonshot-v1-32k':  { inputMicroUsdPer1k: 3429, outputMicroUsdPer1k: 3429 },
    'moonshot-v1-128k': { inputMicroUsdPer1k: 8571, outputMicroUsdPer1k: 8571 },
    'moonshot-v1-auto': { inputMicroUsdPer1k: 8571, outputMicroUsdPer1k: 8571 },
  },
};

const PROVIDERS: ProviderConfig[] = [DEEPSEEK, QWEN, ZHIPU, MOONSHOT];

// Flat lookup: model string → (provider, pricing). Built once at module load.
const MODEL_INDEX: Record<string, { provider: ProviderConfig; pricing: ModelPricing }> = {};
for (const p of PROVIDERS) {
  for (const [model, pricing] of Object.entries(p.models)) {
    MODEL_INDEX[model] = { provider: p, pricing };
  }
}

export function resolveModel(
  model: string,
): { provider: ProviderConfig; pricing: ModelPricing } | null {
  return MODEL_INDEX[model] ?? null;
}

export function listSupportedModels(): string[] {
  return Object.keys(MODEL_INDEX);
}

/**
 * Extract the API key for a provider from Env at runtime. Returns undefined
 * if the secret isn't set — caller should treat that as "server not
 * configured" (500) rather than exposing the key name in an error response.
 */
export function getProviderApiKey(env: Env, config: ProviderConfig): string | undefined {
  const value = env[config.keyEnvName];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Compute cost for a completed request. Integer math, rounded to nearest
 * micro-USD. Overflow isn't a concern — a single-session cost in micros fits
 * in a JS safe integer well beyond anything realistic.
 */
export function computeCostMicroUsd(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): number {
  const input = Math.round((promptTokens * pricing.inputMicroUsdPer1k) / 1000);
  const output = Math.round((completionTokens * pricing.outputMicroUsdPer1k) / 1000);
  return input + output;
}
