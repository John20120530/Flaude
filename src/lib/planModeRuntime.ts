/**
 * Plan-mode runtime helpers — pure functions / constants used by the
 * streamed-chat loop.
 *
 * Why a separate module: the chat hook needs to know "is this tool
 * destructive?" and "what directive do I tack onto the system prompt?"
 * Putting these in tools.ts would make tools.ts know about plan mode,
 * which is the wrong direction (tools.ts should be a pure registry).
 * Putting them in planMode.ts would mix UI bridge code with runtime
 * gating. So they live here.
 */

/**
 * System-prompt directive injected when the user enabled Plan mode for
 * this turn. Goes onto the END of the existing system prompt so it
 * overrides any earlier instructions to "just do it".
 *
 * Wording priorities, in order:
 *   1. Tell the model exactly which tools are blocked (no guessing)
 *   2. Tell it exactly which tools are allowed during planning (so it
 *      doesn't refuse to even read files)
 *   3. Give a clean exit path (call exit_plan_mode) with concrete
 *      structure expectations
 *   4. Promise destructive tools come back after approval (otherwise
 *      a cautious model will keep re-planning forever)
 */
export const PLAN_MODE_PROMPT = `

## Plan 模式（本轮已启用，必须遵守）

用户为本轮开启了 Plan 模式，意思是：**先讲清楚要做什么，得到批准，再动手**。

**禁止使用**的工具（调用会报错）：
- fs_write_file（写文件）
- shell_exec / shell_start / shell_write / shell_kill（任何 shell 副作用）

**允许使用**的工具：
- 所有只读 fs_*：fs_list_dir / fs_read_file / fs_stat
- shell_read（读已运行后台 shell 的输出）/ shell_list
- web_fetch / web_search / current_time / calculator
- todo_write / create_artifact

工作流：
1. 用只读工具充分了解上下文（项目结构、现有实现、相关代码）
2. 起草 markdown 计划，结构建议：
   \`\`\`
   ## 目标
   一句话说清楚要解决的问题。

   ## 步骤
   1. 改 src/foo.ts:42 — 把 X 替换成 Y
   2. 在 tests/foo.test.ts 加一个用例覆盖 Z
   3. 跑 \`pnpm test\` 验证

   ## 风险
   - 可能影响 bar 模块的 baz 行为，需要顺手检查
   - 如果 X 已经被外部依赖引用，需先确认

   ## 验证标准
   - 测试全绿
   - typecheck 通过
   \`\`\`
   不要把读到的源码贴在计划里——只写「读了 X、发现 Y、所以打算做 Z」。
3. 调用 \`exit_plan_mode(plan="...")\` 把计划交给用户审批
4. 用户三种反应：
   - **批准** → 你会收到「✅ 用户已批准」，副作用工具自动解锁，继续执行
   - **反馈** → 你会收到用户的具体修改要求，按要求调整后重新调用 \`exit_plan_mode\`
   - **拒绝** → 你会收到「❌ 用户拒绝」，停止 plan，根据下一条用户输入继续

如果用户的请求很简单（一行命令、查个状态、改个typo），不需要 plan——但**禁用工具的限制依然有效**，你需要直接答复或建议用户关掉 Plan 模式。
`;

/**
 * Tools that mutate state outside the conversation (file system, shell).
 * In Plan mode these are blocked until exit_plan_mode is approved.
 *
 * Notes on what's NOT here:
 *   - todo_write: writes to conversation state only, useful for sketching
 *     a plan, no risk. Allowed.
 *   - create_artifact: same — purely conversation-side.
 *   - fs_list_dir / fs_read_file / fs_stat / shell_read / shell_list:
 *     read-only, allowed.
 *   - web_fetch / web_search / current_time / calculator: read-only.
 *   - MCP tools: pass-through to user-installed servers — semantics
 *     vary, but most browse/search MCPs are read-only and useful for
 *     context gathering. Conservative default would be to block them,
 *     but that breaks the most common MCP use case (read documentation
 *     during planning). For now we err toward allowing them; if a
 *     specific MCP turns out to be destructive in plan mode, the user
 *     can disable it in Settings.
 */
const DESTRUCTIVE_TOOL_NAMES = new Set([
  'fs_write_file',
  'shell_exec',
  'shell_start',
  'shell_write',
  'shell_kill',
]);

export function isDestructiveToolName(name: string): boolean {
  return DESTRUCTIVE_TOOL_NAMES.has(name);
}
