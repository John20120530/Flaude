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

export type ProviderId = 'deepseek';

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
//   deepseek-chat     : input  $0.27 / 1M  (cache miss)  →  270 micros/1k
//                       output $1.10 / 1M                → 1100 micros/1k
//   deepseek-reasoner : input  $0.55 / 1M                →  550 micros/1k
//                       output $2.19 / 1M                → 2190 micros/1k
//
// We ignore cache-hit discounts in accounting — the savings are small at our
// scale and it's not worth tracking the hit/miss split.
const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  keyEnvName: 'DEEPSEEK_API_KEY',
  models: {
    'deepseek-chat':     { inputMicroUsdPer1k: 270, outputMicroUsdPer1k: 1100 },
    'deepseek-reasoner': { inputMicroUsdPer1k: 550, outputMicroUsdPer1k: 2190 },
  },
};

const PROVIDERS: ProviderConfig[] = [DEEPSEEK];

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
