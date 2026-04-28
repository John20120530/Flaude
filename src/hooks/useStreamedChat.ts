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
import {
  PLAN_MODE_PROMPT,
  isDestructiveToolName,
} from '@/lib/planModeRuntime';
import { requestPlanApproval } from '@/lib/planMode';
import { runSubagent } from '@/lib/subagent';
import {
  formatHookOutputForAgent,
  matchTool,
  runHook,
  type HookVars,
} from '@/lib/hooks';
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
  attachments: Attachment[],
  visionModelId: string,
): string | undefined {
  if (mode !== 'design') return undefined;
  const hasImage = attachments.some((a) =>
    typeof a.mimeType === 'string' && a.mimeType.startsWith('image/')
  );
  if (!hasImage) return undefined;
  // Already on a vision-capable model? Don't bounce to a different one — if
  // the user manually picked Qwen / GLM-4 / Claude they presumably wanted it.
  // The "vision-capable" heuristic is loose on purpose (prefix match) so we
  // don't have to reach back into the providers catalog from here; cleaner
  // when there's a real per-model `capabilities.vision` field but moving to
  // it requires threading providers through every caller. For now: name
  // prefixes cover all currently-shipping vision models.
  if (currentModelId === visionModelId) return undefined;
  if (
    currentModelId.startsWith('qwen-') ||
    currentModelId.startsWith('qwen3-vl-') ||
    currentModelId.startsWith('glm-') ||
    currentModelId.startsWith('pa/claude-') // v0.1.49 Claude provider prefix
  ) {
    return undefined;
  }
  return visionModelId;
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

/**
 * Builtin tools that mutate ONLY the conversation (todo list, artifacts,
 * the plan-mode terminator). Hooks targeting these wouldn't have anything
 * meaningful to gate against — the tool doesn't touch the file system or
 * shell. Skipping them here saves a few hundred ms per call by avoiding
 * an unnecessary shellExec round-trip.
 */
const TOOLS_WITHOUT_HOOKS = new Set([
  'todo_write',
  'create_artifact',
  'exit_plan_mode',
]);

function shouldFireToolHooks(toolName: string): boolean {
  return !TOOLS_WITHOUT_HOOKS.has(toolName);
}

/** Pull the substitution variables for a tool call. fs_write_file's
 *  `path` argument is the only one we extract specifically; everything
 *  else gets the generic JSON dump of args.
 */
function buildHookVars(
  toolName: string,
  args: Record<string, unknown>,
): HookVars {
  const workspace = useAppStore.getState().workspacePath ?? '';
  const file =
    toolName === 'fs_write_file' && typeof args.path === 'string'
      ? args.path
      : '';
  let argsJson = '';
  try {
    argsJson = JSON.stringify(args);
  } catch {
    argsJson = '{}';
  }
  return { tool: toolName, workspace, file, argsJson };
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

  /**
   * Plan-mode turn state. Lives only for the duration of a single user→model
   * turn; reset on every new send.
   *
   *   'inactive' → user did not enable Plan for this turn (default)
   *   'planning' → user enabled Plan; destructive tools blocked, agent must
   *                call exit_plan_mode before fs_write/shell_exec
   *   'approved' → user clicked Approve in the modal; destructive tools
   *                unlocked for the remainder of this turn
   *
   * Stored in a ref (not state) because the chat loop reads it
   * synchronously inside the tool dispatch — a state update wouldn't be
   * visible until the next render cycle, by which time the tool would
   * already have executed.
   */
  const planTurnStateRef = useRef<'inactive' | 'planning' | 'approved'>('inactive');

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

      // Design mode skips the artifact pipeline entirely. The DesignCanvas
      // is the dedicated render surface for ```html / ```jsx / ```svg /
      // ```mermaid blocks, and `extractDesignFromMessage` reads them from
      // the *raw* message content. If we let parseMessage promote those
      // fenced blocks into artifacts, two things break simultaneously:
      //   (1) the artifact lifts the fenced block out and replaces it with
      //       `[[ARTIFACT:id]]` in message.content — so designExtract sees
      //       no fenced block and DesignCanvas shows the empty state,
      //   (2) the Artifacts panel pops out unprompted in Design mode,
      //       duplicating the canvas with mismatched UX (different toolbar,
      //       no breakpoint switcher, no version stepper).
      // Skipping parseMessage for design mode keeps message.content raw,
      // which is exactly what designExtract expects.
      const isDesignMode = conversation.mode === 'design';

      // Throttle store patches during streaming. DeepSeek V4 Pro thinking-
      // mode emits a long CoT (1500-1700 chars/turn); a `create_artifact`
      // call streams its `content` arg as a multi-KB HTML blob token by
      // token. Each token would otherwise trigger a Zustand persist write
      // of the entire conversation state to localStorage — across thousands
      // of tokens that's the difference between "smooth" and "WebView2
      // renderer OOM mid-stream". Buffer for ~150 ms between flushes —
      // visually indistinguishable from real-time, but ~50× fewer state
      // writes. Always flush the latest snapshot at end-of-stream.
      const STREAM_FLUSH_MS = 150;

      // Reasoning throttle.
      let reasoningPending = false;
      let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
      const flushReasoning = () => {
        if (reasoningTimer) {
          clearTimeout(reasoningTimer);
          reasoningTimer = null;
        }
        if (reasoningPending) {
          patchLastMessage(conversation.id, { reasoning });
          reasoningPending = false;
        }
      };
      const scheduleReasoning = () => {
        reasoningPending = true;
        if (reasoningTimer) return;
        reasoningTimer = setTimeout(flushReasoning, STREAM_FLUSH_MS);
      };

      // Tool-call-delta throttle. Critical for create_artifact whose
      // `content` argument can stream as 5-20 KB of HTML/CSS — without
      // throttling, every chunk triggers a persist of the full state
      // including the in-progress tool call args.
      let toolCallsPending = false;
      let toolCallsTimer: ReturnType<typeof setTimeout> | null = null;
      const flushToolCalls = () => {
        if (toolCallsTimer) {
          clearTimeout(toolCallsTimer);
          toolCallsTimer = null;
        }
        if (toolCallsPending) {
          patchLastMessage(conversation.id, {
            toolCalls: [...toolCallsMap.values()],
          });
          toolCallsPending = false;
        }
      };
      const scheduleToolCalls = () => {
        toolCallsPending = true;
        if (toolCallsTimer) return;
        toolCallsTimer = setTimeout(flushToolCalls, STREAM_FLUSH_MS);
      };

      for await (const chunk of streamChat({
        modelId: effectiveModelId,
        messages: history,
        system: effectiveSystem,
        tools: tools.length > 0 ? tools : undefined,
        signal: controller.signal,
      })) {
        if (chunk.delta) {
          accumulated += chunk.delta;
          if (isDesignMode) {
            patchLastMessage(conversation.id, { content: accumulated });
          } else {
            const parsed = parseMessage(accumulated, assistantMsgId);
            patchLastMessage(conversation.id, { content: parsed.cleanContent });
            for (const art of parsed.artifacts) upsertArtifact(art);
          }
        }
        if (chunk.reasoningDelta) {
          reasoning += chunk.reasoningDelta;
          scheduleReasoning();
        }
        if (chunk.toolCallDelta) {
          const tc = chunk.toolCallDelta;
          if (tc.id) {
            // providerClient yields the same buffer object repeatedly; storing
            // it by id lets later deltas mutate in place.
            toolCallsMap.set(tc.id, tc as ToolCall);
            scheduleToolCalls();
          }
        }
        if (chunk.usage) {
          patchLastMessage(conversation.id, {
            tokensIn: chunk.usage.promptTokens,
            tokensOut: chunk.usage.completionTokens,
          });
        }
        if (chunk.finish === 'error' && chunk.error) {
          // Same isDesignMode bypass as above — error append shouldn't trip
          // the artifact pipeline either, otherwise a partial fenced block
          // emitted before the error gets stolen by Artifacts.
          if (isDesignMode) {
            patchLastMessage(conversation.id, {
              content: accumulated + `\n\n> ⚠ 错误：${chunk.error}`,
            });
          } else {
            const parsed = parseMessage(accumulated, assistantMsgId);
            patchLastMessage(conversation.id, {
              content: parsed.cleanContent + `\n\n> ⚠ 错误：${chunk.error}`,
            });
          }
        }
        if (chunk.finish) {
          finishReason = chunk.finish;
          break;
        }
      }

      // Stream ended (or errored) — flush all throttled streams so the
      // store reflects the final snapshot. Without these flushes the
      // user could see reasoning / tool-call args freeze 100-150 ms short
      // of complete because the throttle timer never got to fire.
      flushReasoning();
      flushToolCalls();

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
      //
      // `reasoning` MUST be carried through here. DeepSeek's thinking-mode
      // contract is: "every API call after the model produced
      // reasoning_content must echo that content back inside the same
      // assistant message." We accumulate the reasoning string during the
      // stream above (line ~210) and persist it to the store via
      // patchLastMessage, but the *history array* used for the next API
      // call is constructed by hand right here — so we have to read the
      // local `reasoning` variable, not rely on the stored message. Without
      // this line the upstream returns 400 with "The reasoning_content in
      // the thinking mode must be passed back to the API." on the second
      // turn of any tool-calling thinking-mode conversation. (v0.1.18 fixed
      // serializeMessages to forward `reasoning_content` from m.reasoning
      // to the wire — but m.reasoning was always empty here because of
      // this very omission. v0.1.19 closes the loop.)
      const assistantTurn: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: accumulated, // raw; serializeMessages will still ship it
        reasoning: reasoning || undefined,
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
          // Plan-mode gate: while the agent is between "user enabled Plan"
          // and "user clicked Approve", reject destructive tools with a
          // helpful message. The model adjusts and either calls a read-
          // only tool, refines the plan, or invokes exit_plan_mode.
          if (
            planTurnStateRef.current === 'planning' &&
            isDestructiveToolName(tc.name)
          ) {
            throw new Error(
              `工具 "${tc.name}" 在 Plan 模式中被锁定。请先调用 exit_plan_mode 提交计划，等用户批准后再执行副作用操作。`,
            );
          }

          // Pre-tool-use hooks. Each runs sequentially; first non-zero exit
          // BLOCKS the tool, with the hook's stderr (or stdout fallback)
          // becoming the synthetic tool result so the model knows why.
          // Builtin tools that mutate the conversation only (todo_write,
          // create_artifact, exit_plan_mode) skip hook firing — they have
          // no shell side-effect a hook would meaningfully gate against,
          // and firing pointlessly slows the loop.
          const hookVars = buildHookVars(tc.name, args);
          const enabledHooks = useAppStore.getState().hooks.filter((h) => h.enabled);
          if (shouldFireToolHooks(tc.name)) {
            for (const h of enabledHooks) {
              if (h.event !== 'pre_tool_use') continue;
              if (!matchTool(h.toolMatcher, tc.name)) continue;
              const r = await runHook(h, hookVars);
              if (r.code !== 0) {
                const msg =
                  (r.stderr.trim() || r.stdout.trim() || r.spawnError) ??
                  `hook "${h.name}" 阻止了 ${tc.name}（exit ${r.code}）`;
                throw new Error(`hook "${h.name}" 阻止了 ${tc.name}：${msg}`);
              }
            }
          }

          resultText = await executeTool(tc.name, args, {
            conversationId: conversation.id,
            signal: controller.signal,
            upsertArtifact: upsertArtifactAdapter,
            setTodos: setTodosAdapter,
            requestPlanApproval: async (plan: string) => {
              const result = await requestPlanApproval({
                conversationId: conversation.id,
                plan,
              });
              if (result.kind === 'approved') {
                // Unlock destructive tools for the rest of this turn.
                planTurnStateRef.current = 'approved';
              }
              // 'feedback' / 'rejected' keep the gate engaged — the model
              // either revises and re-submits, or stops touching anything.
              return result;
            },
            spawnSubtask: async (req) => {
              // Bake the parent's conversation id in here — the tool
              // handler in tools.ts is conversation-agnostic, but the
              // runtime needs to know whose subagent this is.
              return runSubagent({
                parentConversationId: conversation.id,
                title: req.title,
                prompt: req.prompt,
                context: req.context,
              });
            },
            readSkillAsset: ({ skillName, assetPath }) => {
              // Look up the skill by `name` (not title — the agent
              // sees `name` in the system-prompt manifest). Then find
              // the asset by relative path. Returns null on miss; the
              // tool wrapper turns null into a clear error message.
              const skills = useAppStore.getState().skills;
              const skill = skills.find((s) => s.name === skillName);
              if (!skill?.assets) return null;
              const asset = skill.assets.find((a) => a.path === assetPath);
              if (!asset) return null;
              return { content: asset.content, size: asset.size };
            },
          });
          tc.status = 'success';
          tc.result = resultText;

          // Post-tool-use hooks. Run after a successful tool execution.
          // Output is appended to the tool result text so the agent sees
          // it in the next round-trip (auto-typecheck output, lint
          // warnings, etc.). Errors here don't fail the tool — the tool
          // already succeeded; the hook is supplementary.
          if (shouldFireToolHooks(tc.name)) {
            for (const h of enabledHooks) {
              if (h.event !== 'post_tool_use') continue;
              if (!matchTool(h.toolMatcher, tc.name)) continue;
              const r = await runHook(h, hookVars);
              resultText += formatHookOutputForAgent(h.name, r);
            }
            tc.result = resultText;
          }
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
        // Fire `stop` hooks. These run after the turn is fully done —
        // perfect for "git status", desktop notifications, save-to-
        // markdown, etc. We don't await them blocking-style because the
        // user doesn't need to wait for hook output to interact again,
        // but we DO use `void` so the runner schedules them.
        if (conversation.mode === 'code') {
          const stopHooks = useAppStore
            .getState()
            .hooks.filter((h) => h.enabled && h.event === 'stop');
          if (stopHooks.length > 0) {
            const vars: HookVars = {
              tool: '',
              workspace: useAppStore.getState().workspacePath ?? '',
              file: '',
              argsJson: '{}',
            };
            for (const h of stopHooks) {
              void runHook(h, vars).catch((e) => {
                console.warn(`[hook] ${h.name} failed:`, e);
              });
            }
          }
        }
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
    async (
      text: string,
      attachments: Attachment[] = [],
      options?: { planMode?: boolean },
    ) => {
      if (streaming || compressing) return;

      // Set per-turn plan state BEFORE awaiting auto-compress, so the loop
      // sees the right state when tool calls start firing. Reset to
      // 'inactive' on every send so a previous turn's state can't leak.
      planTurnStateRef.current = options?.planMode ? 'planning' : 'inactive';

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
      // v0.1.48: vision model id is user-configurable in Settings →
      // 默认模型 → design · 视觉; we read the live store value here so
      // changes take effect for the very next message without reload.
      const modelOverride = pickModelOverride(
        conversation.mode,
        conversation.modelId,
        attachments,
        useAppStore.getState().designVisionModelId,
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
      // System prompt for this turn. When Plan mode is on, append the
      // PLAN_MODE_PROMPT directive — the existing prompt still wins for
      // identity / mode / project rules; the directive layers on top.
      const baseSystem = composeSystemWithSummary(systemPrompt, current.summary);
      const fullSystem = options?.planMode
        ? (baseSystem ?? '') + PLAN_MODE_PROMPT
        : baseSystem;

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
      lastUserAttachments,
      useAppStore.getState().designVisionModelId,
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
    // Clean up any tool_calls the model emitted but never got results for.
    // Without this, the next user message serializes a history with orphan
    // tool_calls and the upstream returns 400 "An assistant message with
    // 'tool_calls' must be followed by tool messages…". The wire-format
    // serializer also drops orphans defensively, but doing it in the store
    // too means the user sees the truth visually (✗ canceled badges
    // instead of a forever-spinning 等待 chip).
    const conv = useAppStore
      .getState()
      .conversations.find((c) => c.id === conversation.id);
    if (!conv) return;
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.toolCalls?.length) return;
    const respondedIds = new Set<string>();
    // Walk forward from the assistant message's index — tool messages
    // always come after their owning assistant message in our protocol.
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (!m) continue;
      if (m.role === 'tool') {
        const tcid = m.toolCalls?.[0]?.id;
        if (tcid) respondedIds.add(tcid);
      }
      if (m === last) break;
    }
    const orphans = last.toolCalls.filter((tc) => !respondedIds.has(tc.id));
    if (orphans.length === 0) return;

    // Mark each orphan tool_call as errored on the assistant message.
    const patchedToolCalls = last.toolCalls.map((tc) => {
      if (respondedIds.has(tc.id)) return tc;
      return {
        ...tc,
        status: 'error' as const,
        error: '用户取消',
      };
    });
    patchLastMessage(conversation.id, { toolCalls: patchedToolCalls });

    // Append a synthetic tool result for each orphan so the conversation
    // history is valid OpenAI-shape going forward.
    for (const tc of orphans) {
      appendMessage(conversation.id, {
        id: uid('msg'),
        role: 'tool',
        content: '用户取消',
        toolCalls: [
          {
            ...tc,
            status: 'error',
            error: '用户取消',
          },
        ],
        createdAt: Date.now(),
      });
    }
  }, [conversation.id, appendMessage, patchLastMessage]);

  return { send, regenerate, stop, streaming, compress, compressing };
}
