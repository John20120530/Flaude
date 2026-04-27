/**
 * Subagent runtime — runs a fresh Code-mode conversation to completion
 * and returns its final assistant text. Used by the `spawn_subtask` tool
 * to delegate scoped chunks of work without polluting the parent's
 * context window.
 *
 * Design choices and what's deliberately *not* here:
 *
 * - **Not a React hook.** The parent's chat hook (useStreamedChat) is
 *   fine for the human-in-the-loop UI, but we can't invoke a hook from
 *   a tool handler. This module talks to the store directly.
 *
 * - **Reuses the existing wire format + tool registry + protocol-compliance
 *   fixes** (orphan strip / dedup / etc., see wireFormat.ts). The runtime
 *   loop here is the absolute minimum: stream → execute tools → recurse,
 *   no Plan mode, no Hooks (subagents don't fire hooks because the user
 *   already approved the parent's plan), no thinking-mode reasoning
 *   round-trip (DeepSeek thinking models work but won't get the
 *   `reasoning_content` echo — acceptable; subagents are short-running).
 *
 * - **Cap is tighter than the parent (15 vs. 30 rounds).** Subagents
 *   that go runaway are harder for the user to notice — they don't see
 *   the rounds tick by in the same window. Lower cap = lower blast radius.
 *
 * - **No abort UI.** Subagents always run to completion (or hit the
 *   round cap). If a subagent gets stuck, the user can `shell_kill`
 *   any background processes it spawned and let it time out naturally.
 *   Future: thread an AbortController through to the streamChat call.
 *
 * The function returns the subagent's final assistant message text. This
 * text is the only thing the parent sees — that's the whole point of
 * sub-agents (token efficiency through summarization).
 */

import type { ToolCall } from '@/types';
import { uid } from './utils';
import { streamChat } from '@/services/providerClient';
import { executeTool, toolsForMode } from './tools';
import { useAppStore } from '@/store/useAppStore';
import { composeSystemPrompt } from './systemPrompt';
import { CODE_BASE_PROMPT_WITH_WORKSPACE, CODE_BASE_PROMPT_NO_WORKSPACE } from '@/config/codeSystemPrompt';

/** Max iterations of stream → tools → recurse before we bail. */
export const SUBAGENT_MAX_ROUNDS = 15;

export interface SubagentRequest {
  /** The conversation that's spawning this subtask (used for hierarchy). */
  parentConversationId: string;
  /** Human-readable title shown in the sidebar (model picks this). */
  title: string;
  /** The actual instructions for the subagent. */
  prompt: string;
  /**
   * Optional context the parent wants to pass down. Prepended to the
   * subagent's first user message under a `## 父任务上下文` heading.
   * Keep this short — it's pure overhead on every subagent's prompt.
   */
  context?: string;
}

export interface SubagentResult {
  /** The subagent's final assistant text — what we hand back to the parent. */
  finalText: string;
  /** Conversation id of the spawned subagent (for sidebar deeplink). */
  subConversationId: string;
  /** True if we hit the round cap before the agent stopped on its own. */
  truncated: boolean;
}

/**
 * Run a subagent end-to-end. Synchronous from the parent's perspective:
 * the returned promise resolves only when the subagent has finished
 * (no more tool calls) or hit the round cap. The parent's tool handler
 * awaits this and feeds `finalText` back to the parent's model as the
 * tool result.
 */
export async function runSubagent(req: SubagentRequest): Promise<SubagentResult> {
  const store = useAppStore.getState();

  const parent = store.conversations.find((c) => c.id === req.parentConversationId);
  if (!parent) {
    throw new Error(`spawn_subtask: parent conversation ${req.parentConversationId} not found`);
  }

  // Subagents inherit the parent's model + workspace. Code mode only.
  const subId = store.newSubtaskConversation({
    parentConversationId: req.parentConversationId,
    title: req.title || '子任务',
    mode: 'code',
    modelId: parent.modelId,
    projectId: parent.projectId,
  });

  // Compose the user message: optional inherited context + the actual prompt.
  // Putting context inside the user message (not the system prompt) keeps
  // the system prompt identical to what a normal Code-mode conversation
  // would see — the subagent doesn't know it's a subagent, just that the
  // user gave it a focused task.
  const userContent = req.context?.trim()
    ? `## 父任务上下文\n\n${req.context.trim()}\n\n## 你的任务\n\n${req.prompt}`
    : req.prompt;

  store.appendMessage(subId, {
    id: uid('msg'),
    role: 'user',
    content: userContent,
    createdAt: Date.now(),
  });

  // Build system prompt — Code mode WITH workspace if parent had one.
  // We use the parent's globalMemory / skills since the subagent is
  // working on the parent's behalf.
  const { workspacePath, globalMemory, skills } = useAppStore.getState();
  const basePrompt = workspacePath
    ? CODE_BASE_PROMPT_WITH_WORKSPACE
    : CODE_BASE_PROMPT_NO_WORKSPACE;
  const systemPrompt = composeSystemPrompt({
    basePrompt,
    mode: 'code',
    globalMemory,
    skills,
    project: parent.projectId
      ? store.projects.find((p) => p.id === parent.projectId)
      : undefined,
  });

  // Run the loop. Each iteration: stream → if tool_calls, execute + recurse.
  for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
    const conv = useAppStore
      .getState()
      .conversations.find((c) => c.id === subId);
    if (!conv) {
      throw new Error('subagent conversation vanished mid-run');
    }

    // Append the empty assistant message that streaming will fill in.
    const asstId = uid('msg');
    store.appendMessage(subId, {
      id: asstId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      modelId: parent.modelId,
    });

    let accumulated = '';
    const toolCallsMap = new Map<string, ToolCall>();
    let finishReason: 'stop' | 'length' | 'tool_calls' | 'error' | undefined;
    let streamErr: string | undefined;

    try {
      for await (const chunk of streamChat({
        modelId: parent.modelId,
        // Slice off the empty assistant placeholder we just appended;
        // the wire serializer would otherwise emit an empty assistant
        // turn that the upstream rejects.
        messages: conv.messages.concat([
          {
            id: 'placeholder',
            role: 'user',
            content: userContent,
            createdAt: 0,
          },
        ]).slice(0, -1),
        system: systemPrompt,
        // toolsForMode already returns wire-shape ToolSpec[]. We drop
        // spawn_subtask from the subagent's toolset to prevent fork
        // bombs — subagents can use everything else but can't recursively
        // delegate. Single-layer delegation is enough to validate the
        // pattern; nested is a future enhancement.
        tools: toolsForMode('code').filter((t) => t.name !== 'spawn_subtask'),
      })) {
        if (chunk.delta) {
          accumulated += chunk.delta;
          store.patchLastMessage(subId, { content: accumulated });
        }
        if (chunk.toolCallDelta) {
          const tc = chunk.toolCallDelta;
          if (tc.id) toolCallsMap.set(tc.id, tc as ToolCall);
        }
        if (chunk.finish) {
          finishReason = chunk.finish;
        }
        if (chunk.finish === 'error' && chunk.error) {
          streamErr = chunk.error;
        }
      }
    } catch (e) {
      streamErr = (e as Error).message ?? 'stream failed';
    }

    if (streamErr) {
      // Surface stream errors as the subagent's final answer rather than
      // throwing — gives the parent something to react to instead of an
      // opaque tool failure.
      store.patchLastMessage(subId, {
        content: accumulated + `\n\n> ⚠ 子任务流式中断: ${streamErr}`,
      });
      return {
        finalText: accumulated + `\n\n[子任务因流式错误中断: ${streamErr}]`,
        subConversationId: subId,
        truncated: false,
      };
    }

    // No tool calls (or the model said "stop"): we're done.
    if (finishReason !== 'tool_calls' || toolCallsMap.size === 0) {
      return {
        finalText: accumulated.trim() || '(子任务无文本输出)',
        subConversationId: subId,
        truncated: false,
      };
    }

    // Tool calls. Patch them onto the assistant message + execute each.
    const toolCalls: ToolCall[] = [...toolCallsMap.values()].map((tc) => ({
      ...tc,
      status: 'pending' as const,
    }));
    store.patchLastMessage(subId, { toolCalls });

    for (const tc of toolCalls) {
      // Unwrap mid-stream {__raw: jsonString} args to plain object.
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

      let resultText: string;
      let ok = true;
      try {
        resultText = await executeTool(tc.name, args, {
          conversationId: subId,
        });
        tc.status = 'success';
        tc.result = resultText;
      } catch (e) {
        ok = false;
        resultText = (e as Error).message || '工具执行失败';
        tc.status = 'error';
        tc.error = resultText;
      }
      store.patchLastMessage(subId, { toolCalls: [...toolCalls] });
      store.appendMessage(subId, {
        id: uid('msg'),
        role: 'tool',
        content: ok ? resultText : `工具错误: ${resultText}`,
        toolCalls: [tc],
        createdAt: Date.now(),
      });
    }
  }

  // Hit the round cap. Return whatever the last assistant message has,
  // tagged so the parent knows it was truncated.
  const conv = useAppStore
    .getState()
    .conversations.find((c) => c.id === subId);
  const lastAssistant = conv?.messages
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant');
  const partial = lastAssistant?.content?.trim() || '(子任务尚未给出最终回答)';
  return {
    finalText: `${partial}\n\n[⚠ 子任务达到 ${SUBAGENT_MAX_ROUNDS} 轮工具上限，未自然结束 — 上面是它最后一段文字]`,
    subConversationId: subId,
    truncated: true,
  };
}
