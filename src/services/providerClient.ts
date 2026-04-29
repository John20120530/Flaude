/**
 * OpenAI-compatible streaming client — now routed through the Flaude server.
 *
 * Pre-Phase-4 history: this file fetched provider endpoints directly using a
 * per-user API key stored in Settings. Phase 4 moved keys server-side: the
 * client no longer knows DeepSeek/Qwen/GLM keys. Every completion goes to
 * `POST {serverUrl}/v1/chat/completions` with a JWT Bearer, and the server
 * fans out to the real provider, records usage, and streams the response back.
 *
 * What the client still does:
 *   - Serialize Message[] → OpenAI wire format (incl. tool_calls, attachments).
 *   - Parse the SSE stream and yield StreamChunks.
 *   - Translate HTTP errors (including Flaude-specific 402/429 quota) into
 *     human Chinese copy.
 *
 * What the client no longer does:
 *   - Look up provider base URLs or API keys. The server decides based on
 *     modelId. The local `providers` store is now purely UI metadata (display
 *     names, capabilities, model lists for the picker).
 */

import type { Message, StreamChunk, ToolCall } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { authFetch, FlaudeApiError, getServerUrl } from '@/lib/flaudeApi';
import { serializeMessages } from './wireFormat';

export interface ChatRequest {
  modelId: string;
  messages: Message[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Translate HTTP errors from the Flaude server (or passed-through upstream
 * errors) into clear human Chinese copy. The server's error envelope is
 * `{ error: string, detail?: string }`; upstream provider errors bubble up
 * as `{ error: { message, type } }` inside the body the server passes through.
 */
function formatHttpError(status: number, raw: string): string {
  let inner = raw;
  try {
    const j = JSON.parse(raw);
    // Flaude server shape: { error: "..." }
    // OpenAI shape (passthrough): { error: { message, type } }
    inner =
      (typeof j?.error === 'string' ? j.error : j?.error?.message) ||
      j?.message ||
      j?.error?.type ||
      raw;
  } catch {
    /* raw is not JSON */
  }

  // Flaude-specific codes first (server enforces these before hitting upstream)
  if (status === 402 || /quota/i.test(inner))
    return `这个月的额度用光了。\n\n详情：${inner}`;
  if (status === 429 && /quota|额度/i.test(inner))
    return `这个月的额度用光了。\n\n详情：${inner}`;

  // Generic HTTP mapping
  if (status === 400) return `请求无效（${inner}）`;
  if (status === 401 || status === 403)
    return `未登录或会话已失效，请重新登录。\n\n详情：${inner}`;
  if (status === 404) return `未找到该模型，可能服务端未开通。\n\n详情：${inner}`;
  if (status === 429) return `请求过于频繁，稍后再试。\n\n详情：${inner}`;
  if (status === 502)
    return `上游 LLM 服务连不上或超时，稍后再试。\n\n详情：${inner}`;
  if (status >= 500) return `服务端异常（HTTP ${status}）。\n\n详情：${inner}`;
  return `HTTP ${status}\n\n详情：${inner}`;
}

/**
 * Model metadata lookup — used only to decide whether to forward `tools` on
 * this request. Does not gate the request (server owns provider keys).
 * Returns `null` if the model isn't in our local catalog; we still send the
 * request and let the server 404 it.
 */
function lookupModel(modelId: string) {
  const { providers } = useAppStore.getState();
  for (const p of providers) {
    const m = p.models.find((x) => x.id === modelId);
    if (m) return m;
  }
  return null;
}

/** Stream chat completions. Yields deltas as they arrive. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
  const model = lookupModel(req.modelId);

  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: serializeMessages(req.messages, req.system),
    stream: true,
    temperature: req.temperature ?? 0.7,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  // Only forward tools if the model advertises support. If we don't have
  // metadata for the model locally, forward them anyway and let the server
  // / provider decide.
  if (req.tools && req.tools.length > 0 && (!model || model.capabilities.tools)) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  let response: Response;
  try {
    response = await authFetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    // authFetch throws FlaudeApiError on 401/403 (after clearing auth) — in
    // that case App.tsx will rerender to LoginView on next tick; here we just
    // emit a readable error so the current stream placeholder resolves.
    if (err instanceof FlaudeApiError) {
      yield { finish: 'error', error: formatHttpError(err.status, err.message) };
      return;
    }
    // Plain network error — fetch() threw before a Response. Usually the
    // server is down or the URL is wrong. Surface the server URL so the user
    // can sanity-check it.
    yield {
      finish: 'error',
      error: `连不上 Flaude 服务端（${(err as Error).message}）。\n当前地址 ${getServerUrl()}`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    yield { finish: 'error', error: formatHttpError(response.status, text) };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { finish: 'error', error: '响应不支持流式读取' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallBuf: Record<number, ToolCall> = {};
  // v0.1.58: track whether we've yielded ANY data so we can detect "empty
  // stream" — happens when the upstream/Worker closes the connection
  // cleanly without sending `data: [DONE]\n\n` AND without sending any
  // body chunks. Pre-v0.1.58 this fell out of the loop with no `finish`
  // chunk, the streaming hook treated it as a "valid empty completion",
  // and the assistant bubble just sat empty forever — exactly what the
  // user reported as "对话停了，发新消息也没反馈". (Subsequent sends did
  // start fresh streams; what stuck was the user's perception that the
  // turn before never resolved.)
  let producedAnything = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE lines are delimited by \n\n
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { finish: 'stop' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            producedAnything = true;
            yield { delta: delta.content };
          }
          // Thinking / reasoning content (DeepSeek-R1 style)
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            producedAnything = true;
            yield { reasoningDelta: delta.reasoning_content };
          }
          // Anthropic Extended Thinking signature (v0.1.52). Surfaced by
          // server/anthropicAdapter.translateStream from `signature_delta`
          // events. Without persisting this on the assistant message,
          // a 2nd send into the same Claude thinking conversation 400s on
          // `messages[i].content[j].thinking.signature: Field required`.
          if (
            typeof delta.reasoning_signature === 'string' &&
            delta.reasoning_signature.length > 0
          ) {
            producedAnything = true;
            yield { reasoningSignatureDelta: delta.reasoning_signature };
          }
          // Tool call deltas
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCallBuf[i]) {
                toolCallBuf[i] = {
                  id: tc.id ?? `tc_${i}`,
                  name: tc.function?.name ?? '',
                  arguments: {},
                  status: 'pending',
                };
              }
              const buf = toolCallBuf[i];
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) {
                const prev = (buf.arguments as { __raw?: string }).__raw ?? '';
                (buf.arguments as { __raw?: string }).__raw = prev + tc.function.arguments;
              }
              producedAnything = true;
              yield { toolCallDelta: buf };
            }
          }
          if (choice.finish_reason) {
            const reason = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
            // Finalize tool call arguments (parse JSON)
            for (const k of Object.keys(toolCallBuf)) {
              const t = toolCallBuf[Number(k)];
              const raw = (t.arguments as { __raw?: string }).__raw;
              if (raw) {
                try {
                  t.arguments = JSON.parse(raw);
                } catch {
                  // keep raw
                }
              }
            }
            if (json.usage) {
              yield {
                usage: {
                  promptTokens: json.usage.prompt_tokens ?? 0,
                  completionTokens: json.usage.completion_tokens ?? 0,
                },
              };
            }
            yield { finish: reason };
            return;
          }
        } catch {
          // Ignore malformed SSE frames
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      yield { finish: 'stop' };
    } else {
      yield { finish: 'error', error: (err as Error).message };
    }
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // noop
    }
  }

  // v0.1.58: stream ended cleanly (reader done) WITHOUT seeing
  // `data: [DONE]\n\n` and without throwing. The early-return on `[DONE]`
  // covers the happy path; reaching here means upstream (Worker / PPIO /
  // DeepSeek) closed the connection mid-flight without the terminator.
  // Emit something so the streaming hook doesn't sit on an empty bubble:
  //   - if we got nothing at all, that's an error the user must see
  //   - if we got partial content, treat as a 'stop' so the partial
  //     output is preserved and the agent can continue (tool round-trips
  //     finalize on `finishReason !== 'tool_calls'`, which 'stop' satisfies)
  if (!producedAnything) {
    yield {
      finish: 'error',
      error: '上游流提前结束（没有 [DONE]，也没有任何输出）。可能是网络瞬断或上游崩了，重试一次试试。',
    };
  } else {
    yield { finish: 'stop' };
  }
}
