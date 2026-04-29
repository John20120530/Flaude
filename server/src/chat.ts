/**
 * LLM proxy + usage accounting.
 *
 * Routes (all under this sub-app, all requireAuth'd):
 *   GET  /usage                   — current month usage snapshot for this user
 *   POST /v1/chat/completions     — OpenAI-compatible chat proxy
 *
 * Flow for a chat request:
 *   1. Validate body (known model, non-empty messages).
 *   2. Pre-flight quota: sum current month's tokens, 429 if >= quota.
 *   3. Forward to upstream provider with our API key.
 *   4. Non-stream: await json, extract usage, log, return.
 *      Stream:     tee response — one half to client as SSE, the other into
 *                  an accumulator that reads the final usage chunk and logs
 *                  via executionCtx.waitUntil (keeps isolate alive past the
 *                  client disconnect long enough to persist the row).
 *
 * Intentionally out of scope here:
 *   - Retries. Never auto-retry LLM calls — an upstream 500 can mean the
 *     request completed and we still got billed; silent retry double-charges.
 *   - Per-call cost preview. Deferred to Phase 5 admin UI.
 *   - Anthropic message format. DeepSeek/Qwen/Zhipu all speak OpenAI chat
 *     format, so we pin to that and don't fragment.
 */
import { Hono } from 'hono';

import {
  type AnthropicResponse,
  type OpenAIRequest,
  translateRequest,
  translateResponse,
  translateStream,
} from './anthropicAdapter';
import type { AppContext } from './env';
import { requireAuth } from './middleware';
import {
  computeCostMicroUsd,
  getProviderApiKey,
  listSupportedModels,
  resolveModel,
} from './providers';
import {
  getMonthlyUsage,
  getUsageSnapshot,
  insertUsageLog,
  resolveQuota,
} from './usage';

const chat = new Hono<AppContext>();

chat.use('*', requireAuth);

// -----------------------------------------------------------------------------
// GET /usage — for the client's "X / Y tokens used this month" display.
// -----------------------------------------------------------------------------
chat.get('/usage', async (c) => {
  const userId = c.get('userId');
  const userRow = await c.env.DB
    .prepare('SELECT monthly_quota_tokens FROM users WHERE id = ?')
    .bind(userId)
    .first<{ monthly_quota_tokens: number | null }>();

  const snap = await getUsageSnapshot(
    c.env.DB,
    userId,
    userRow?.monthly_quota_tokens ?? null,
    c.env.MONTHLY_QUOTA_TOKENS,
  );
  return c.json(snap);
});

// -----------------------------------------------------------------------------
// POST /v1/chat/completions — OpenAI-compatible proxy.
// -----------------------------------------------------------------------------
interface ChatBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  // `conversation_id` is our own addition — strip it before forwarding so
  // upstream doesn't choke on an unknown field.
  conversation_id?: unknown;
  // Any other OpenAI params (temperature, max_tokens, tools, ...) flow
  // through untouched; we don't enumerate or validate them.
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

chat.post('/v1/chat/completions', async (c) => {
  const userId = c.get('userId');

  // ---- parse + validate ------------------------------------------------
  const body = (await c.req.json().catch(() => null)) as ChatBody | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid json body' }, 400);
  }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) return c.json({ error: 'model is required' }, 400);

  const resolved = resolveModel(model);
  if (!resolved) {
    return c.json(
      { error: `unsupported model "${model}"`, supported: listSupportedModels() },
      400,
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages must be a non-empty array' }, 400);
  }

  const wantsStream = body.stream === true;
  const conversationId =
    typeof body.conversation_id === 'string' ? body.conversation_id : null;

  // ---- quota pre-flight -----------------------------------------------
  const userRow = await c.env.DB
    .prepare('SELECT monthly_quota_tokens FROM users WHERE id = ?')
    .bind(userId)
    .first<{ monthly_quota_tokens: number | null }>();

  const quota = resolveQuota(
    userRow?.monthly_quota_tokens ?? null,
    c.env.MONTHLY_QUOTA_TOKENS,
  );
  const used = await getMonthlyUsage(c.env.DB, userId);
  if (used >= quota) {
    return c.json(
      { error: 'monthly quota exceeded', used_tokens: used, quota_tokens: quota },
      429,
    );
  }

  // ---- build forward body ---------------------------------------------
  const apiKey = getProviderApiKey(c.env, resolved.provider);
  if (!apiKey) {
    console.error(`missing secret for provider ${resolved.provider.id}`);
    return c.json({ error: 'server not configured' }, 500);
  }

  const forwardBody: Record<string, unknown> = { ...body };
  delete forwardBody.conversation_id;

  // v0.1.49: PPIO Claude models speak Anthropic native protocol on
  // /anthropic/v1/messages. We translate the OpenAI-shape request the
  // client just sent into an Anthropic-shape request, send it with the
  // x-api-key + anthropic-version headers PPIO expects, then translate
  // the response (or SSE stream) back to OpenAI shape so the client
  // doesn't see the difference.
  const useAnthropicProtocol = resolved.provider.id === 'ppio';

  let upstreamUrl: string;
  let upstreamHeaders: Record<string, string>;
  let upstreamBody: string;

  if (useAnthropicProtocol) {
    upstreamUrl = `${resolved.provider.baseUrl}/v1/messages`;
    upstreamHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    upstreamBody = JSON.stringify(
      translateRequest(forwardBody as OpenAIRequest),
    );
  } else {
    upstreamUrl = resolved.provider.baseUrl;
    upstreamHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    // For streaming OpenAI-compat, force the upstream to emit a final
    // usage chunk so we can log tokens. include_usage is the OpenAI
    // stream_options flag DeepSeek/Qwen/GLM honour. If the client set
    // its own stream_options we merge so forward-compat fields survive.
    // (Anthropic always emits usage in message_delta — no flag needed.)
    if (wantsStream) {
      const existing = (forwardBody.stream_options ?? {}) as Record<string, unknown>;
      forwardBody.stream_options = { ...existing, include_usage: true };
    }
    upstreamBody = JSON.stringify(forwardBody);
  }

  // ---- call upstream --------------------------------------------------
  // Provider-aware fetch timeout. The number is a ceiling on how long we'll
  // wait for the upstream to send response *headers*; once headers arrive
  // and we hand back the stream, the Workers runtime takes over (it has
  // its own 100s subrequest cap that bounds total wall time).
  //
  //   - DeepSeek / Qwen / Moonshot (OpenAI-compat): 60s. Their p99 ttfb is
  //     under 5s, so 60s is just there to catch network stalls (seen
  //     intermittently on wrangler 3.x / Windows).
  //   - PPIO Anthropic (Claude Sonnet/Opus + extended thinking): 180s.
  //     v0.1.55 raised this from 60s after a user hit "upstream timed out"
  //     in Design mode with Opus 4.6 + thinking. Live measurement showed
  //     ttfb=21s and total=96s for that exact prompt — comfortably inside
  //     180s but flagrantly over 60s on bad runs. Anthropic's extended
  //     thinking buffers the entire `thinking` block before emitting the
  //     first SSE event, and on Opus + a 5KB system prompt that buffer
  //     can take a full minute. The Workers subrequest cap (~100s) still
  //     limits the absolute worst case below this number, so 180s is
  //     "as much slack as the runtime will give us"; effective ceiling
  //     is whichever is smaller.
  const ABORT_MS = resolved.provider.id === 'ppio' ? 180_000 : 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ABORT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: upstreamBody,
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    console.error('upstream fetch failed', { aborted, err });
    return c.json(
      { error: aborted ? 'upstream timed out' : 'upstream unreachable' },
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  // Upstream error: pass through body + status so the client sees the real
  // reason (context window exceeded, 429 from provider, auth failure, etc.).
  // We do NOT log usage for failed requests — nothing was consumed.
  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      },
    });
  }

  // ---- streaming path -------------------------------------------------
  if (wantsStream) {
    if (!upstream.body) {
      return c.json({ error: 'upstream returned empty stream' }, 502);
    }

    // For PPIO/Anthropic, transform the upstream SSE through our
    // adapter first so what flows downstream is OpenAI-shaped (which
    // is what both the client AND `accumulateStreamUsage` expect).
    // For OpenAI-compat providers (DeepSeek/Qwen/etc.) the body is
    // already in the right shape — pipe straight through.
    const sseStream: ReadableStream<Uint8Array> = useAnthropicProtocol
      ? upstream.body.pipeThrough(translateStream(model))
      : upstream.body;

    // Split the SSE stream in two: one copy goes straight to the client as
    // bytes pass through, the other is read in-memory by the accumulator.
    const [toClient, toAccumulator] = sseStream.tee();

    // Fire-and-forget with waitUntil. This keeps the isolate alive until the
    // usage row is persisted, even if the client closes the connection early.
    c.executionCtx.waitUntil(
      accumulateStreamUsage(toAccumulator)
        .then(async (usage) => {
          if (!usage) {
            console.warn('no usage chunk in stream', { userId, model });
            return;
          }
          const cost = computeCostMicroUsd(
            resolved.pricing,
            usage.prompt_tokens,
            usage.completion_tokens,
          );
          await insertUsageLog(c.env.DB, {
            userId,
            model,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            costMicroUsd: cost,
            conversationId,
          });
        })
        .catch((err) => console.error('stream accounting failed', err)),
    );

    return new Response(toClient, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ---- non-streaming path ---------------------------------------------
  let json: { usage?: OpenAIUsage };
  if (useAnthropicProtocol) {
    // Anthropic returns its own shape; translate to OpenAI before doing
    // anything else so usage extraction + the client-facing response
    // both follow the same code path.
    const raw = (await upstream.json()) as AnthropicResponse;
    json = translateResponse(raw);
  } else {
    json = (await upstream.json()) as { usage?: OpenAIUsage };
  }

  if (json.usage) {
    const cost = computeCostMicroUsd(
      resolved.pricing,
      json.usage.prompt_tokens,
      json.usage.completion_tokens,
    );
    // Use waitUntil so we don't delay the response on the log INSERT.
    c.executionCtx.waitUntil(
      insertUsageLog(c.env.DB, {
        userId,
        model,
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        costMicroUsd: cost,
        conversationId,
      }).catch((err) => console.error('usage_log insert failed', err)),
    );
  } else {
    // Should not happen for supported providers, but we don't want to
    // crash the response if it does.
    console.warn('non-stream response missing usage', { userId, model });
  }

  return c.json(json);
});

/**
 * Drain an OpenAI-compatible SSE stream, returning the last `usage` object
 * seen. DeepSeek emits it on the penultimate event when stream_options
 * .include_usage is set; the final event is always `data: [DONE]`.
 */
async function accumulateStreamUsage(
  stream: ReadableStream<Uint8Array>,
): Promise<OpenAIUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: OpenAIUsage | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines (\n\n). Process complete
      // events and leave any trailing partial event in the buffer for the
      // next iteration.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as { usage?: OpenAIUsage };
            if (parsed.usage && typeof parsed.usage.total_tokens === 'number') {
              usage = parsed.usage;
            }
          } catch {
            // Malformed chunk: ignore. Don't let accounting failures
            // cascade into visible errors for the user.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return usage;
}

export default chat;
