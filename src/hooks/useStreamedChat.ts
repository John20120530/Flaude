import { useRef, useState, useCallback, useMemo } from 'react';
import { streamChat } from '@/services/providerClient';
import { useAppStore } from '@/store/useAppStore';
import { uid } from '@/lib/utils';
import { parseMessage } from '@/lib/artifacts';
import { executeTool, toolsForMode } from '@/lib/tools';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '@/lib/tokenEstimate';
import { summarizeConversation } from '@/lib/conversationSummary';
import { DESIGN_VISION_FALLBACK_MODEL } from '@/config/providers';
import type {
  Attachment,
  Conversation,
  Message,
  TodoItem,
  ToolCall,
} from '@/types';
import type { ArtifactType } from '@/lib/artifacts';

/**
 * Decide whether this turn should be routed through a vision-capable model
 * instead of the conversation's default. Currently only Design mode opts in:
 *   - V4 Pro / V4 Flash can't see images,
 *   - if the user attached one, the only sensible response is to read the
 *     image, so we silently route just that turn through Qwen-Max.
 *
 * Returns the override modelId, or `undefined` to use the conversation's
 * stored modelId.
 */
function pickModelOverride(
  mode: Conversation['mode'],
  currentModelId: string,
  attachments: Attachment[]
): string | undefined {
  if (mode !== 'design') return undefined;
  const hasImage = attachments.some((a) =>
    typeof a.mimeType === 'string' && a.mimeType.startsWith('image/')
  );
  if (!hasImage) return undefined;
  // Already on a vision-capable model? Don't bounce to a different one — if
  // the user manually picked Qwen / GLM-4 they presumably wanted it.
  if (currentModelId === DESIGN_VISION_FALLBACK_MODEL) return undefined;
  if (currentModelId.startsWith('qwen-') || currentModelId.startsWith('glm-')) {
    return undefined;
  }
  return DESIGN_VISION_FALLBACK_MODEL;
}

interface Options {
  conversation: Conversation;
  systemPrompt?: string;
}

/**
 * Max number of tool round-trips per user turn. After this many recursions
 * we stop and append a warning so the model doesn't spiral.
 *
 * Why 30: Claude Code's default is in the 25–50 range, and real agentic
 * tasks (read file → edit → run tests → fix → re-run) routinely chew
 * through 15–20. The old cap of 8 bit on moderate tasks — the model would
 * get halfway through a refactor and hit the wall. 30 leaves headroom
 * without letting a broken model burn infinite tokens. If a user wants
 * further control we'll add a setting; bumping the constant buys us the
 * common case for free.
 */
const MAX_TOOL_ROUNDTRIPS = 30;

/**
 * When automatically deciding to summarize before a send, use at most this
 * fraction of the model's context window for (system + summary + history +
 * user message). The remainder is reserved for the model's completion.
 * 0.75 is a pragmatic default — most replies don't need 25% of the window,
 * but reasoning models occasionally do.
 */
const AUTO_SUMMARIZE_BUDGET_RATIO = 0.75;

/** Summarization keeps the last N messages verbatim (both manual + auto). */
const KEEP_RECENT_DEFAULT = 4;

/**
 * Build the effective system prompt by appending the conversation's stored
 * summary as a clearly labeled section. Returns `undefined` if there's no
 * base prompt *and* no summary (i.e. nothing to send).
 */
function composeSystemWithSummary(
  basePrompt: string | undefined,
  summary: string | undefined
): string | undefined {
  if (!summary || !summary.trim()) return basePrompt;
  const header = '\n\n## 对话摘要（已压缩的早期历史）\n\n';
  return (basePrompt ?? '') + header + summary.trim();
}

export function useStreamedChat({ conversation, systemPrompt }: Options) {
  const appendMessage = useAppStore((s) => s.appendMessage);
  const patchLastMessage = useAppStore((s) => s.patchLastMessage);
  const upsertArtifact = useAppStore((s) => s.upsertArtifact);
  const setConversationSummary = useAppStore((s) => s.setConversationSummary);
  const setConversationTodos = useAppStore((s) => s.setConversationTodos);
  const providers = useAppStore((s) => s.providers);
  const [streaming, setStreaming] = useState(false);
  /**
   * True while a summarization round-trip is in flight. Separate from
   * `streaming` because the composer should still be "send disabled" even
   * when no chat completion is running — we're waiting on the summarizer.
   */
  const [compressing, setCompressing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /** The current model's context window (tokens). Undefined if not found. */
  const contextWindow = useMemo(() => {
    for (const p of providers) {
      const m = p.models.find((x) => x.id === conversation.modelId);
      if (m) return m.contextWindow;
    }
    return undefined;
  }, [providers, conversation.modelId]);

  const upsertArtifactAdapter = useCallback(
    (a: { id: string; type: string; title: string; content: string; language?: string }) => {
      upsertArtifact({
        id: a.id,
        type: a.type as ArtifactType,
        title: a.title,
        content: a.content,
        language: a.language,
        createdAt: Date.now(),
      });
    },
    [upsertArtifact]
  );

  // Conversation-scoped setTodos adapter for the todo_write tool. Closing over
  // `conversation.id` here keeps the tool handler conversation-agnostic — it
  // just calls `setTodos(...)` and trusts the adapter to route to the right
  // bucket. Same pattern as `upsertArtifactAdapter` above.
  const setTodosAdapter = useCallback(
    (todos: TodoItem[]) => setConversationTodos(conversation.id, todos),
    [setConversationTodos, conversation.id]
  );

  /**
   * Core streaming loop — one LLM turn. Returns the final assistant message
   * (with any tool calls attached) and the updated history. Recurses on
   * tool-use round-trips until the model emits a normal stop.
   *
   * `effectiveSystem` is passed in (not read from closure) so that during
   * tool round-trips inside a single turn, all recursive calls share the
   * same system prompt snapshot — including any summary active at send time.
   */
  const runStream = useCallback(
    async (
      history: Message[],
      assistantMsgId: string,
      controller: AbortController,
      effectiveSystem: string | undefined,
      modelOverride: string | undefined,
      depth = 0
    ): Promise<void> => {
      const mode = conversation.mode;
      const tools = toolsForMode(mode);
      // `modelOverride` lets the caller route a single turn through a
      // different model than the conversation's stored modelId — used by
      // Design mode to auto-fall-back to a vision-capable model when the
      // user attaches an image. We pass it down through tool round-trips
      // so the whole turn (initial reply + any tool follow-ups) stays on
      // the same model; otherwise mid-turn we'd switch back and the
      // model context would shift.
      const effectiveModelId = modelOverride ?? conversation.modelId;

      let accumulated = '';
      let reasoning = '';
      const toolCallsMap = new Map<string, ToolCall>();
      let finishReason: string | undefined;

      for await (const chunk of streamChat({
        modelId: effectiveModelId,
        messages: history,
        system: effectiveSystem,
        tools: tools.length > 0 ? tools : undefined,
        signal: controller.signal,
      })) {
        if (chunk.delta) {
          accumulated += chunk.delta;
          const parsed = parseMessage(accumulated, assistantMsgId);
          patchLastMessage(conversation.id, { content: parsed.cleanContent });
          for (const art of parsed.artifacts) upsertArtifact(art);
        }
        if (chunk.reasoningDelta) {
          reasoning += chunk.reasoningDelta;
          patchLastMessage(conversation.id, { reasoning });
        }
        if (chunk.toolCallDelta) {
          const tc = chunk.toolCallDelta;
          if (tc.id) {
            // providerClient yields the same buffer object repeatedly; storing
            // it by id lets later deltas mutate in place.
            toolCallsMap.set(tc.id, tc as ToolCall);
            patchLastMessage(conversation.id, {
              toolCalls: [...toolCallsMap.values()],
            });
          }
        }
        if (chunk.usage) {
          patchLastMessage(conversation.id, {
            tokensIn: chunk.usage.promptTokens,
            tokensOut: chunk.usage.completionTokens,
          });
        }
        if (chunk.finish === 'error' && chunk.error) {
          const parsed = parseMessage(accumulated, assistantMsgId);
          patchLastMessage(conversation.id, {
            content: parsed.cleanContent + `\n\n> ⚠ 错误：${chunk.error}`,
          });
        }
        if (chunk.finish) {
          finishReason = chunk.finish;
          break;
        }
      }

      // Normal termination — nothing more to do.
      if (finishReason !== 'tool_calls' || toolCallsMap.size === 0) return;

      // ---- Tool round-trip ----
      if (depth >= MAX_TOOL_ROUNDTRIPS) {
        patchLastMessage(conversation.id, {
          content:
            accumulated +
            `\n\n> ⚠ 已达到工具调用最大轮次 (${MAX_TOOL_ROUNDTRIPS})，终止本次会话。`,
        });
        return;
      }

      const toolCalls: ToolCall[] = [...toolCallsMap.values()].map((tc) => ({
        ...tc,
        status: 'pending',
      }));
      patchLastMessage(conversation.id, { toolCalls });

      // The assistant turn that just ended — record it in history with its
      // tool_calls so the follow-up request has proper context.
      const assistantTurn: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: accumulated, // raw; serializeMessages will still ship it
        toolCalls,
        createdAt: Date.now(),
        modelId: effectiveModelId,
      };
      const newHistory: Message[] = [...history, assistantTurn];

      // Execute every tool, append a tool message per result, update UI live.
      for (const tc of toolCalls) {
        tc.status = 'running';
        patchLastMessage(conversation.id, { toolCalls: [...toolCalls] });

        let resultText: string;
        let ok = true;
        try {
          // Unwrap {__raw} if providerClient left it there (malformed JSON)
          let args: Record<string, unknown> = {};
          if (tc.arguments && typeof tc.arguments === 'object') {
            const raw = (tc.arguments as { __raw?: string }).__raw;
            if (typeof raw === 'string') {
              try {
                args = JSON.parse(raw);
              } catch {
                args = {};
              }
            } else {
              args = tc.arguments as Record<string, unknown>;
            }
          }
          resultText = await executeTool(tc.name, args, {
            conversationId: conversation.id,
            signal: controller.signal,
            upsertArtifact: upsertArtifactAdapter,
            setTodos: setTodosAdapter,
          });
          tc.status = 'success';
          tc.result = resultText;
        } catch (e) {
          ok = false;
          resultText = (e as Error).message || '工具执行失败';
          tc.status = 'error';
          tc.error = resultText;
        }
        patchLastMessage(conversation.id, { toolCalls: [...toolCalls] });

        const toolMsg: Message = {
          id: uid('msg'),
          role: 'tool',
          content: ok ? resultText : `工具错误: ${resultText}`,
          toolCalls: [tc],
          createdAt: Date.now(),
        };
        appendMessage(conversation.id, toolMsg);
        newHistory.push(toolMsg);
      }

      // Start a fresh assistant message and recurse.
      const nextAssistantId = uid('msg');
      appendMessage(conversation.id, {
        id: nextAssistantId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: effectiveModelId,
      });

      await runStream(
        newHistory,
        nextAssistantId,
        controller,
        effectiveSystem,
        modelOverride,
        depth + 1
      );
    },
    [
      conversation.id,
      conversation.mode,
      conversation.modelId,
      appendMessage,
      patchLastMessage,
      upsertArtifact,
      upsertArtifactAdapter,
      setTodosAdapter,
    ]
  );

  /** Kick off a streaming turn with shared abort + UI-state management. */
  const runTurn = useCallback(
    async (
      history: Message[],
      assistantMsgId: string,
      effectiveSystem: string | undefined,
      modelOverride?: string
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      try {
        await runStream(
          history,
          assistantMsgId,
          controller,
          effectiveSystem,
          modelOverride,
          0
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          patchLastMessage(conversation.id, {
            content: `\n\n> ⚠ 流式中断: ${(err as Error).message}`,
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [runStream, conversation.id, patchLastMessage]
  );

  /**
   * Manually trigger a history compression. Keeps `keepRecent` trailing
   * messages verbatim, summarizes everything before them into the
   * conversation's `summary` field. No-op if there's nothing new to compress
   * (e.g. keepRecent >= unsummarized message count).
   */
  const compress = useCallback(
    async (keepRecent: number = KEEP_RECENT_DEFAULT) => {
      if (streaming || compressing) return;
      // Always read fresh state — the props-carried `conversation` may be
      // stale (parent hasn't re-rendered yet after a recent append).
      const fresh = useAppStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      if (!fresh) return;
      setCompressing(true);
      try {
        const result = await summarizeConversation(fresh, { keepRecent });
        if (result) {
          setConversationSummary(
            fresh.id,
            result.summary,
            result.summaryMessageCount
          );
        }
      } catch (e) {
        // Surface the failure to the conversation so the user sees why.
        // We append a system-flavored marker rather than a real system
        // message (which would alter the model's view of history).
        console.warn('[flaude] compress failed:', (e as Error).message);
        appendMessage(conversation.id, {
          id: uid('msg'),
          role: 'assistant',
          content: `> ⚠ 压缩历史失败：${(e as Error).message}`,
          createdAt: Date.now(),
          modelId: conversation.modelId,
        });
      } finally {
        setCompressing(false);
      }
    },
    [
      streaming,
      compressing,
      conversation.id,
      conversation.modelId,
      setConversationSummary,
      appendMessage,
    ]
  );

  /**
   * Decide whether an upcoming send would overflow and, if so, run a
   * compression first. Returns true when compression was attempted (whether
   * or not it succeeded) so the caller can re-read state.
   */
  const maybeAutoCompress = useCallback(
    async (pendingUserText: string): Promise<void> => {
      if (!contextWindow) return; // unknown model — skip the heuristic
      const fresh = useAppStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      if (!fresh) return;

      const skip = Math.min(
        fresh.summaryMessageCount ?? 0,
        fresh.messages.length
      );
      const unsummarized = fresh.messages.slice(skip);
      const estimated =
        estimateTokens(systemPrompt ?? '') +
        estimateTokens(fresh.summary ?? '') +
        estimateMessagesTokens(unsummarized) +
        estimateTokens(pendingUserText);

      const budget = Math.floor(contextWindow * AUTO_SUMMARIZE_BUDGET_RATIO);
      if (estimated <= budget) return;

      // Over budget — try to compress. We keep it non-fatal: if the model
      // refuses or the network fails, we'd rather send with full history
      // and let the provider error out than block the user entirely.
      setCompressing(true);
      try {
        const result = await summarizeConversation(fresh, {
          keepRecent: KEEP_RECENT_DEFAULT,
        });
        if (result) {
          setConversationSummary(
            fresh.id,
            result.summary,
            result.summaryMessageCount
          );
        }
      } catch (e) {
        console.warn('[flaude] auto-compress failed:', (e as Error).message);
      } finally {
        setCompressing(false);
      }
    },
    [contextWindow, conversation.id, systemPrompt, setConversationSummary]
  );

  const send = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (streaming || compressing) return;

      // Step 1: auto-compress if the pending payload would overflow.
      await maybeAutoCompress(text);

      // Step 2: re-read conversation state — it may have just gained a
      // summary which changes both the system prompt and the history slice.
      const current =
        useAppStore
          .getState()
          .conversations.find((c) => c.id === conversation.id) ?? conversation;

      // Per-turn vision routing: Design mode auto-bounces a single turn to a
      // vision-capable model when there's an image attached. The conversation's
      // stored modelId stays untouched, so the next text-only turn returns to
      // V4 Pro automatically. See pickModelOverride() for the policy.
      const modelOverride = pickModelOverride(
        conversation.mode,
        conversation.modelId,
        attachments
      );

      const userMsg: Message = {
        id: uid('msg'),
        role: 'user',
        content: text,
        attachments: attachments.length ? attachments : undefined,
        createdAt: Date.now(),
      };
      appendMessage(conversation.id, userMsg);

      const assistantMsg: Message = {
        id: uid('msg'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        modelId: modelOverride ?? conversation.modelId,
      };
      appendMessage(conversation.id, assistantMsg);

      const skip = Math.min(
        current.summaryMessageCount ?? 0,
        current.messages.length
      );
      const historyToSend: Message[] = [
        ...current.messages.slice(skip),
        userMsg,
      ];
      const fullSystem = composeSystemWithSummary(systemPrompt, current.summary);

      await runTurn(historyToSend, assistantMsg.id, fullSystem, modelOverride);
    },
    [
      conversation,
      streaming,
      compressing,
      appendMessage,
      runTurn,
      systemPrompt,
      maybeAutoCompress,
    ]
  );

  /**
   * Re-run the last assistant response. We rewind to the message just before
   * the last assistant turn (which may include preceding tool messages from a
   * previous round-trip), wipe the assistant message, and rerun.
   */
  const regenerate = useCallback(async () => {
    if (streaming || compressing) return;
    const current =
      useAppStore
        .getState()
        .conversations.find((c) => c.id === conversation.id) ?? conversation;
    const msgs = current.messages;
    if (msgs.length === 0) return;

    // Find the last assistant message and any trailing tool messages.
    let cutIdx = msgs.length - 1;
    while (cutIdx > 0 && msgs[cutIdx].role === 'tool') cutIdx--;
    if (msgs[cutIdx].role !== 'assistant') return;

    const target = msgs[cutIdx];
    // Reset the assistant turn's state.
    patchLastMessage(current.id, {
      content: '',
      reasoning: undefined,
      tokensIn: undefined,
      tokensOut: undefined,
      toolCalls: undefined,
    });

    // Clip history to just before the (now-wiped) assistant turn, and
    // skip anything already covered by the summary.
    const skip = Math.min(current.summaryMessageCount ?? 0, cutIdx);
    const history = msgs.slice(skip, cutIdx);
    const fullSystem = composeSystemWithSummary(systemPrompt, current.summary);

    // Re-evaluate vision routing on regenerate: if the immediately-preceding
    // user message carried an image, we still want Qwen-Max even on the
    // re-roll. Walk back from cutIdx to find the most recent user message
    // (skipping any tool messages that may sit between).
    let userIdx = cutIdx - 1;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    const lastUserAttachments =
      userIdx >= 0 ? msgs[userIdx].attachments ?? [] : [];
    const modelOverride = pickModelOverride(
      conversation.mode,
      conversation.modelId,
      lastUserAttachments
    );

    await runTurn(history, target.id, fullSystem, modelOverride);
  }, [
    conversation,
    streaming,
    compressing,
    patchLastMessage,
    runTurn,
    systemPrompt,
  ]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, regenerate, stop, streaming, compress, compressing };
}
