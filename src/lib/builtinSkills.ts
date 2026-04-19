/**
 * Built-in skill definitions, shipped with Flaude. Re-seeded on store rehydrate
 * so newly-added ones land without clobbering user customizations.
 *
 * Naming & style:
 *   - `name`: short kebab-case, shown to the model (it's a stable identifier).
 *   - `title`: display name for the Settings UI (Chinese is fine).
 *   - `description`: one line, the *when-to-use* signal the model reads to
 *     decide whether to activate the skill.
 *   - `instructions`: markdown body — the *how-to-do-it* guidance. Keep it
 *     concrete and actionable. Reference specific tools by name.
 *
 * A skill's `modes` array filters which conversation modes it's injected into.
 * Empty = all modes. We prefer to scope tightly so the catalogue stays short.
 */
import type { Skill } from '@/types';

const now = 0; // Stable timestamp for builtins so re-seeding is idempotent.

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'builtin-skill-code-review',
    name: 'code-review',
    title: '代码评审',
    description: '用户要求审查代码、找 bug、提改进建议时使用',
    instructions: [
      '严格的代码评审流程：',
      '',
      '1. **先读全貌**：用 `fs_read_file` 读完整文件，不要只看 snippet。如果是跨文件改动，先 `fs_list_dir` 摸结构。',
      '2. **按严重性分级**：',
      '   - `critical`：bug、数据丢失、安全漏洞、竞态',
      '   - `major`：类型不安全、错误处理缺失、性能坑',
      '   - `minor`：命名、风格、冗余',
      '3. **引用行号**：用 `file.ts:123` 格式，别只写"这段"。',
      '4. **给可行动建议**：不只指出问题，还要说怎么改（贴一段修正代码最好）。',
      '5. **保留上下文**：如果某段代码"看起来奇怪但其实有理由"，先问用户再下结论。',
      '',
      '输出格式：先报 critical 若干条，再 major，最后 minor；每条 ≤3 句话。',
    ].join('\n'),
    modes: ['code'],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'builtin-skill-write-tests',
    name: 'write-tests',
    title: '写单元测试',
    description: '用户要求给某段代码写测试时使用',
    instructions: [
      '写测试的流程：',
      '',
      '1. **先看现有测试**：用 `fs_list_dir` 找 `__tests__/` 或 `*.test.*`，读一两个样例，遵循项目的测试风格（jest / vitest / mocha）。',
      '2. **别重复发明**：复用项目里已有的 mock helper、fixture、setup 文件。',
      '3. **覆盖三类场景**：',
      '   - happy path（正常输入）',
      '   - edge case（空输入、极值、Unicode、超长字符串）',
      '   - error case（抛错、reject、非法输入）',
      '4. **断言要具体**：`expect(x).toBe(42)` 好过 `expect(x).toBeTruthy()`。',
      '5. **快速、独立**：每个测试不依赖前一个的状态；不碰网络、不碰真实文件系统（用 mock）。',
      '',
      '写完列出你覆盖了哪些场景，哪些没覆盖（留给用户决定要不要补）。',
    ].join('\n'),
    modes: ['code'],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'builtin-skill-refactor',
    name: 'refactor',
    title: '重构',
    description: '用户要求在不改变行为的前提下整理 / 拆分 / 改名某段代码时使用',
    instructions: [
      '重构的红线：**对外行为不能变**。',
      '',
      '流程：',
      '1. **先读懂**：用 `fs_read_file` 读当前代码 + 所有引用它的地方（`grep` 找调用点）。',
      '2. **列清单**：告诉用户你打算做什么改动（拆函数 / 改名 / 提参数 / 换数据结构），一条一条列，让用户确认。',
      '3. **小步提交**：每一步都保持可编译、可通过现有测试。不要一次改太多。',
      '4. **不顺手修 bug**：如果发现 bug，单独说明、单独提出来修——混在重构里会让 diff 变得无法 review。',
      '5. **改名格外小心**：用 `replace_all` 之前，先 grep 看全部引用，避免同名变量被误伤。',
      '',
      '重构完跑一次 typecheck / lint / tests 验证行为不变。',
    ].join('\n'),
    modes: ['code'],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'builtin-skill-explain-code',
    name: 'explain-code',
    title: '解释代码',
    description: '用户要求解释某段代码/某个机制是怎么工作的时使用',
    instructions: [
      '解释代码的原则：**面向中级工程师，而不是新手**。',
      '',
      '',
      '1. **从高到低**：先一句话说它干什么（What），再说为什么这么做（Why），最后才展开机制细节（How）。',
      '2. **识别非显然的点**：绕过直觉的地方（怪异的早返回、莫名的 setTimeout、看似冗余的类型断言）往往有历史原因——把这些挑出来讲。',
      '3. **指出坑**：有哪些"改起来会炸"的隐含前提？例如：依赖某个全局 mutable state、要求调用方已经 await 了某个 Promise。',
      '4. **引用行号**：`file.ts:42` 这种格式，让用户能跳过去看。',
      '5. **别抄代码**：贴一大段原代码没意义，用户自己能看到。只在需要标记"重点看这行"时贴短片段。',
    ].join('\n'),
    modes: ['chat', 'code'],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'builtin-skill-spec-writing',
    name: 'spec-writing',
    title: '写技术方案',
    description: '用户要求起草设计文档 / 技术方案 / RFC 时使用',
    instructions: [
      '技术方案的结构（按这个顺序写）：',
      '',
      '1. **背景**：当前现状 + 要解决的问题。两段以内。',
      '2. **目标 & 非目标**：列 3–5 条目标，明确"这次不做什么"。',
      '3. **方案**：主推方案的具体做法。贴接口签名、数据结构、关键流程。',
      '4. **备选方案**：至少列 1 个，说清楚为什么没选。',
      '5. **风险 & 权衡**：性能、兼容性、迁移成本、上线风险。',
      '6. **里程碑**：怎么分阶段落地。每个里程碑可独立验收。',
      '',
      '风格：',
      '- 中文技术文档风，不要"我们将会"这种虚词，直接"方案 A 用 X 实现"。',
      '- 用 mermaid / 表格承载结构化信息，别用一大段散文。',
      '- 不要写"优点：…缺点：…"的套话，用具体场景说明。',
    ].join('\n'),
    modes: ['chat'],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  },
];
