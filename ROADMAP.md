# Flaude Roadmap

Phase 1–10（本地骨架 / 鉴权 / 配额 / 双向同步 / Code agent / 打磨 / 文档 / 打包 / 网页版 / Design 模式）全部完成。
当前已经发到 **v0.1.51**，无阻塞级或体验级待办。

这份 ROADMAP 现在的结构：
- **最近完成（v0.1.2 → v0.1.22）**：按版本号小步迭代的增量
- **之前完成（早期 session）**：v0.1.0 / v0.1.1 之前的 phase 工作
- **下一步候选**：按价值/成本估的可选方向，无强制顺序
- **不在 roadmap 里**：明确放弃的方向

老的"阻塞级 / 体验级 / 打磨级"分档只剩历史记录用途——里面的项已经全部 ✅。

---

## 最近完成（v0.1.2 → v0.1.51，2026-04-20 至 2026-04-29）

发版节奏从「Phase 完成」转向「按版本号小步迭代」。这一段时间补齐了 #10 网页版、做了一个全新的 Design 模式、把 Code mode 的几个深坑（Office 文件、长 thinking-mode、内存）一一打掉，并按 [Claude vs Flaude 全面对比](#) 的优先级表把最痛的十一条（CLAUDE.md 自动加载、附件类型扩展、globalMemory 条目化、Plan 模式、数据导入、Hooks、后台任务面板、Sub-agents、Skills/MCP marketplaces、stdio MCP 一键装、Skills 联邦搜索）一起做了。

**v0.1.51 — 用户回归测 v0.1.50 的 5 条修补**
- 用户回归测后 5 条问题：
  1. **MCP 还是连不上 + 错误框是空的**：根因 = Tauri 2 的 `invoke` reject 时直接抛 `Err(String)`，老代码 `(e as Error).message` 在字符串上读 `.message` 得 `undefined`，UI 一律 fallback 到「无具体错误信息——可能是子进程立刻崩溃或返回了空错误」。修：`mcpErrorMessage(e)` helper 兼容 Error / 裸字符串 / 任意对象三种 throw 形状（Tauri 2 默认就是裸字符串）。同时 stdio child 死掉时 `recvLoop` 把 stderr 末 6 行拼到 exit error 后面（`stderr 末尾:\n...`）——以前用户看到「exited code=1」啥也不知道，其实子进程一直在喊「FILESYSTEM_ROOT environment variable is required」。
  2. **Chat 选 Opus 4.6 但请求超时；Code/Design 选 Claude 但 metadata 还是 deepseek/qwen**：根因 = TopBar 的 `setModelForMode(mode, id)` 只更新 `modelByMode[mode]`（下一条新对话用的默认），不动当前对话的 `conversation.modelId`。所以「角标显示 Claude，请求实际跑 DeepSeek」。修：TopBar 一选模型就同时 `setConversationModel(activeConv.id, modelId)` + `setModelForMode(mode, modelId)`，且 `currentModelId` 优先读 `activeConv.modelId` fallback 到 `modelByMode[mode]`——badge 跟实际请求模型一致了。Live smoke 直 Opus 4.6 6s 返回，所以 Chat 超时是 PPIO 的瞬时——v0.1.51 不动 60s timeout。
  3. **Design 模式 DeepSeek 提示横幅删掉**：「当前用 DeepSeek V4 Pro —— 设计稿质量更高，但每 1M tokens 约 $1.74。简单设计可以切到 V4 Flash 省 ~12 倍 token 费」整段移除（`Sparkles`/`Zap` import + `setConversationModel`/`setModelForMode` 选择器 + `showFlashHint`/`switchToFlash` 全清）。Design 现在三槽位选 Claude / Qwen / DeepSeek 都能用，单一「切 Flash」横幅意义不大了。
  4. **删智谱（Zhipu GLM）**：从客户端 `DEFAULT_PROVIDERS` / 服务端 `PROVIDERS` array / `ProviderId` 联合类型 / `.dev.vars.example` / `DEPLOY.md` / `env.ts` 全部移除。`ZHIPU_API_KEY` wrangler secret 留着无害（没人 reference）。catalogDrift 测试不变（只校验客户端 → 服务端 ⊆，删了客户端就自动不会要求服务端有）。
  5. **Design TopBar 三槽位**：模拟 Settings → 默认模型 → Design 那块的 lang / vision / image-gen 三选，搬到 TopBar——只在 `activeMode === 'design'` 时显示，每个槽是个 compact `<ModelSlot>` pill（label + select + chevron）。语言槽走 `onPickLanguageModel` 同步两侧（per-mode default + active conv），视觉/生图槽各自走 `setDesignVisionModelId` / `setDesignImageGenModelId`。Chat / Code 仍然单选不变。
- **测试**：客户端 549/549（+6 mcpErrorMessage / stderr-tail tests）；server 165/165 不变。
- **Live smoke**：Opus 4.6 非流式 6s，流式 7s，都正常——确认 PPIO 链路健康，用户的 Chat 超时是瞬时事件。

**v0.1.50 — Claude extended thinking + sub-agent 真并行**
- **A. Claude extended thinking**：新两个变体 `pa/claude-sonnet-4-6-thinking` / `pa/claude-opus-4-6-thinking`（Haiku-4.5 上游不支持，不收）。Worker 翻译层全程支持：
  - **请求**：检测 `-thinking` 后缀 → 剥后缀传上游 + 加 `thinking: { enabled, budget_tokens: 16k }` + max_tokens 自动顶到 budget+4k（Anthropic 400 拦截）+ drop temperature/top_p（thinking 强制 temp=1）。同时把上一轮 assistant 的 `reasoning_content` 重建成 `thinking` content block 放消息头部——保证多轮 thinking 推理连贯（不然下一轮模型从零再推可能跟自己矛盾）。
  - **非流式响应**：`thinking` block → `reasoning_content` 字段（跟 DeepSeek thinking 用同一个字段，客户端推理面板渲染逻辑零改动）。
  - **流式**：`content_block_start{type:'thinking'}` 开 thinking 块，`thinking_delta` event → OpenAI delta 的 `reasoning_content` 字段（providerClient 映射成 `chunk.reasoningDelta` → 推理面板实时跳动）。`signature_delta` 不暴露给客户端（opaque proof-of-thinking 字段，渲染没意义）。
  - **REASONER_PAIRS** 加了 sonnet/opus 的双向映射，Composer 「深度思考」按钮自动支持（一键切 thinking ↔ 非 thinking 变体）。
  - **价格**同非 thinking 变体（Anthropic thinking token 计入普通 output 费率，budget 上限自然限制 token 数）。
  - **测试**：anthropicAdapter +11 测试覆盖后缀剥离 / max_tokens 顶起 / temp 丢 / 历史 reasoning_content 重建为 leading thinking block / 与 tool_calls 共存的顺序 / 流式 thinking_delta 与 signature_delta 区分处理。

- **B. Sub-agent 真并行**：assistant 在一轮里 emit 多个 `spawn_subtask` 时，Promise.all 并发跑，concurrency cap 4（典型 2-4 个并发，5+ 才分批）。混合 batch（subtask + 其他工具）保持串行——不能让非幂等工具抢在 sibling subtask 前面跑。
  - **重构**：`useStreamedChat.ts` 里 inline 工具执行 body 抽出 `executeOneTool(tc)` helper，并行 + 串行两条路共用同一套 plan-mode gate / hooks / ctx wiring / 状态更新。非 subtask 路径行为零变化。
  - **检测规则**：`toolCalls.length > 1 && toolCalls.every(tc => tc.name === 'spawn_subtask')` → 走 Promise.all。Results 按 submission order append（不按完成顺序），日志和 replay 更好读。

- **Live smoke 端到端通过**：thinking sonnet 流式解一道火车相遇问题——89 条 reasoning_content delta（一步步推算）→ 100 条 content delta（格式化最终答案），finish_reason=stop，usage 1532 tokens（90 prompt + 1442 completion）。
- **测试**：客户端 543/543 不变；server 165/165（+11 thinking 测试）。

**v0.1.49 — PPIO Claude provider（OpenAI ↔ Anthropic 翻译层）**
- 痛点：PPIO 的 Claude 模型走 `/anthropic/v1/messages`（Anthropic native 协议——不是 OpenAI 兼容），客户端如果直接喊它得改一大坨。所以在 Worker 端做翻译层，客户端继续 speak OpenAI，三个 Claude 模型（Sonnet 4.6 / Haiku 4.5 / Opus 4.6）就插上来用。
- **`server/src/anthropicAdapter.ts`**：纯翻译模块。3 个 export：
  - `translateRequest`：system 抽顶层，role:'tool' → tool_result block，assistant.tool_calls → tool_use block，image_url → image source（base64 / URL 两种），tools → input_schema，max_tokens 默认 8192，丢 stream_options + reasoning_content。
  - `translateResponse`：text block 拼 content，tool_use → tool_calls(arguments JSON.stringify)，stop_reason 映射。
  - `translateStream`：TransformStream，按 `\n\n` 切 SSE event（处理跨 chunk 拼接），把 message_start / content_block_start / content_block_delta / message_delta / message_stop 翻译成 OpenAI chunk + `[DONE]` 收尾。tool_use 的 partial_json 流式按一对一传。
- **`chat.ts` 分支**：检测 `provider.id === 'ppio'` 即走 Anthropic 路径——`/v1/messages` URL，`x-api-key` + `anthropic-version` header（不是 Bearer），body translateRequest，streaming 在 tee 之前先 pipe 过 translateStream。usage 提取 + cost log 完全复用现有 OpenAI 路径（因为流出来已经是 OpenAI 形）。
- **PPIO 三个模型注册**（server + client 同步）：
  - `pa/claude-sonnet-4-6` 日常旗舰，$3 / $15 per M
  - `pa/claude-haiku-4-5-20251001` 小快便宜，$1 / $5 per M
  - `pa/claude-opus-4-6` 顶配深度，$15 / $75 per M
  - 都标了 `capabilities: { tools, vision, reasoning?, longContext }`，自动出现在 Settings → 默认模型 → 语言 + 视觉 下拉里
- **Live smoke 3/3 通过**：非流式 Sonnet 返回正确 + usage；流式 Haiku 文本 deltas + finish_reason + [DONE]；流式 Haiku + tool_call 头部 chunk + 4 个 partial JSON args delta + finish_reason: tool_calls + usage。
- **测试**：客户端 543/543 不变；server 154/154（+20 anthropicAdapter 测试）。

**v0.1.48 — Design 真生图（GPT Image 2 via PPIO）+ 模型槽位三分**
- **真生图**：Design / Chat 模式新增 builtin 工具 `image_generate`，agent 决定何时调用。Worker 端 `/tools/image_generate` 代理 PPIO `https://api.ppio.com/v3/gpt-image-2-text-to-image`，shared `PPIO_API_KEY` 服务端管。返回的 URLs 自动 promote 成 `image` artifact 落到右侧面板，同时在聊天里 inline 渲染（markdown `![]()` ）。
- **三层 Design 模型槽位**：Settings → 默认模型 → Design 行拆成三选——**语言模型**（生成 HTML/SVG/解释）/ **视觉模型**（理解上传图片，自动接管含图请求那一轮）/ **生图模型**（agent 调 image_generate 工具时用）。Chat / Code 各自仍是单一选择。
- **Type 系统**：`ModelDefinition.capabilities += { vision?, imageGen? }`，`ProviderId += 'ppio'`，`ArtifactType += 'image'`。
- **Providers**：新 PPIO entry 注册 `gpt-image-2`（`capabilities: { imageGen: true }`）。`DESIGN_VISION_FALLBACK_MODEL` 常量退役，改 store-driven 让用户自由配置。
- **Store**：`designVisionModelId` + `designImageGenModelId` 双新字段，partialize 持久化，rehydrate backfill 兼容老用户。
- **Design 系统提示**：新增「生成真实图片：image_generate 工具」章节，告诉 agent 什么时候调（栅格 / 摄影 / 插画 / 海报）vs 什么时候写代码（UI / 流程图 / 图标矢量），混合需求（landing page + hero photo）的处理流程。
- **Worker cost tracking**：image_generate 调用入 usage_log，`model='gpt-image-2'`，按 quality 阶梯计 micro-USD（low ≈ \$0.011，medium ≈ \$0.042，high ≈ \$0.167）。
- **测试**：客户端 543/543 不变；server 134/134（+15 image_generate 测试）。
- **未带 Claude provider**——PPIO `/anthropic/v1/messages` 走 Anthropic 原生协议，需要 OpenAI ↔ Anthropic 翻译层（请求 / 流式 / 工具 / 视觉），单独留 v0.1.49。

**v0.1.47 — 修 v0.1.45 的两个错位修补 + Filesystem MCP 真能用了**
- 用户报：(a) v0.1.45 把整个设置页 scrollbar 都隐了，但其实想隐的是 sticky 分栏栏内部那个小 scrollbar；(b) MCP 连不上时还是看不到任何诊断信息。
- **修 (a)**：把 `.no-scrollbar` 从外层 `flex-1 overflow-y-auto` 拿掉（页面 scrollbar 恢复），改加在 sticky 分栏栏内部的 `<nav>` 上（5 个 tab 不会真的横向溢出，hide gutter 没损失）。
- **修 (b)**：错误框的渲染条件从 `{server.lastError && ...}` 改成 `{server.status === 'error' && ...}`。原来空 lastError 字符串会被 falsy 掉整个箱体，用户看到「error」徽章但啥诊断都没有。空 lastError 现在 fallback 到「（无具体错误信息）」+ 仍然显示完整诊断 hints。**额外加** `<title>` 在 error 徽章上 hover 即出 lastError。
- **顺便修 Filesystem MCP 真能用**：默认参数是 `.`，但 Tauri 子进程 cwd 是 app bundle 不是用户工作区——server 拿不到能用的目录就立刻崩。装 Filesystem MCP 时现在自动弹出文件夹选择对话框，让用户挑要暴露的目录，把 `.` 替换成绝对路径再启动。Cancel 就 abort 安装（不留半残废 entry）。
- **测试**：客户端 543/543 不变。

**v0.1.46 — sidebar 双流并发不再闪**
- 用户报：两个 Code 对话同时跑时 sidebar 顺序在两条之间持续跳闪。
- Root cause：`patchLastMessage` 每个流式 token 都 `updatedAt: Date.now()`，sidebar 按 `updatedAt DESC` 排序——两条流并发时每个 token 都把对应对话顶到最上面，每秒几十次互相轮换。
- Fix：去掉 `patchLastMessage` 里的 `updatedAt` 自动 bump。`appendMessage`（流开始时插 assistant 占位消息）已经 stamp 一次了，足够「最新流浮顶」语义。Sync 不受影响——它用 `dirtyConversationIds` 不是 updatedAt-based polling。
- Sidebar 时间戳显示在流式期间不再 tick——可接受（这是对话列表，不是流进度条）。

**v0.1.45 — v0.1.43 四个修补的真正修补**
- 用户报「v0.1.43 整体不 work」。逐条 debug 后发现：
  - **工作区跟对话绑定**：代码确实在 master，但只 stamp 新创建的对话；用户已有的旧对话没 workspacePath，所以恢复逻辑没数据可用——guard 正确跳过 = 看起来"没反应"。修：在 `appendMessage` 里 backfill，code 模式 + 没 workspacePath + 当前有 workspace + 用户消息 → 第一次发消息时 stamp，从此绑定。
  - **设置 sticky 分栏 scrollbar 残影**：v0.1.43 去掉 `-mx-6 px-6` 没用，因为外层 `flex-1 overflow-y-auto` 总会留 10px gutter 给 scrollbar（per index.css）。修：新加 `.no-scrollbar` 工具类（`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`），整个设置页隐藏 scrollbar。滚动用滚轮/触控板，不影响功能。
  - **MCP 安装后连不上**：底层失败原因有几种（stdio 在网页 / 缺 env / npx 不在 PATH / server crash），全显示成一行小红字，用户看不到上下文也不知道怎么修。修：(a) stdio MCP + 网页 → 直接 disable 「连接」按钮 + tooltip 解释「浏览器不能 spawn 子进程」；(b) `lastError` 改成大红框 + 三种常见失败的 inline 诊断提示。
  - **HTTP 排序优于 stdio**：v0.1.43 加了 +6k 端点 bonus 但 trust tier 权重是 1M，未审核 HTTP 永远输给流行 stdio。实测 "memory" 关键词只有 1 条 HTTP，被埋在 30 条结果的第 23 位。修：UI 端把搜索结果按 endpoint type 分三组渲染（HTTP / stdio-tauri / 需手动），每组带 label + 计数。HTTP section 直接显示在顶部。
- **测试**：客户端 543/543 不变。

**v0.1.44 — Skills 文件夹模式（templates/scripts/config 全部捆绑）**
- **痛点**：用户给的医疗融资监控 skill 例子里，SKILL.md 引用 `scripts/monitor.py` / `templates/alert.md` / `config/companies.json`——pre-v0.1.44 Flaude 只下载 SKILL.md，所有这种文件引用都断。GitHub 上大量 skill 是这种 folder 结构。
- **架构**：`Skill.assets?: SkillAsset[]` 类型扩展（path/content/size），新 Worker endpoint `GET /api/skills/fetch-bundle` 走 GitHub Trees API 把 SKILL.md 同目录下所有文本文件一起打包返回，新 builtin 工具 `read_skill_asset(skill_name, asset_path)` 让 agent 在 Code 模式按需读捆绑文件。
- **过滤策略**：text-only 扩展白名单（`.md/.py/.js/.ts/.json/.yaml/...`，禁用二进制/图片/.env/lock 文件），单文件 ≤64KB，整 bundle ≤1MB，目录深度 ≤3 层，黑名单前缀（`.git/` / `node_modules/` / `__pycache__/` / `dist/` / 等）。null-byte 检测拦截扩展名错配的二进制。
- **Worker 端**：HEAD/main/master 自动解析为 repo 的 `default_branch`；并发 8 路 fetch；tree API 5xx 时降级返回 SKILL.md alone + error note；Cache API 1h TTL；负面结果也缓存。
- **System prompt**：捆绑文件不直接 inline（每个 skill 可能 20+ 文件 × 几 KB，全塞进 prompt 烧 20K token 没意义），只列 manifest（path + size），让 agent 调 `read_skill_asset` 按需读。
- **Settings UI**：每个 skill 行加「N 个文件」徽章 + 可展开的文件列表 + per-file 内容查看器。
- **Smoke 测试**：实测安装 `1sadjlk/bounty-hunter-skill`，5 个 asset（README + 2 references + 2 scripts）全部正确捆绑 + 干净 UTF-8 + 0 错误。
- **测试**：客户端 543/543 不变；server 119/119（+21 新 bundle 测试，覆盖 URL parser / 路径过滤 / 二进制检测 / pipeline 端到端 / 错误降级）。

**v0.1.43 — 4 个用户报告的修补一起发**
- **Code 模式工作区跟对话绑定**：每个 Code conversation 现在 stamp 当前 workspace path 在创建时（`Conversation.workspacePath?` 新增），切回旧对话从 sidebar 自动恢复对应的文件夹。v0.1.41 已经做了「换工作区开新对话」，这次补完反向：「切对话恢复工作区」。两边对称。
- **设置 sticky 分栏 scrollbar 残影**：原来的 `-mx-6 px-6` 把 sticky 背景延伸到了页面右边的 scrollbar gutter 之下，滚动时 scrollbar 看起来挤进了 tab 栏。去掉负 margin，scrollbar 回到 max-w-3xl 之外正常位置。
- **MCP 市场安装失败修补**：
  - **后端**新增 `NON_SERVER_NPM_PACKAGES` blocklist：`@modelcontextprotocol/sdk` / `inspector` / `create-server` / `create-python-server` 这些是库 / 工具不是 server，`npx -y` 起不来或没 bin，从搜索结果直接过滤。
  - **前端**：stdio 类需要必填环境变量（如 `GITHUB_PERSONAL_ACCESS_TOKEN`）的 entry，token 输入框空着时点「安装」按钮**不再真正安装**——改成自动展开详情面板 + 红色边框输入框 + 红色 inline help 提示。原来空 token 安装会让子进程立刻 crash 留下个 vague「error」徽章无法恢复。
  - HTTP bearer token 维持「可选」语义不变（很多端点匿名也能用）。
- **MCP 市场 HTTP 排序优于 stdio**：在 `scoreOf` 加 endpoint-type bonus（HTTP +6000 / stdio-tauri +1000 / stdio-instructions 0），同 tier 内排。trust tier 仍然绝对优先（1M / 10K / 0），所以官方 stdio 仍然在流行 HTTP 之上。HTTP 网页/桌面都能用、不需 Node.js / 不烧环境变量，per-click 价值最高。
- **测试**：客户端 543/543 不变；server 98/98（+3 endpoint-bonus 测试）。

**v0.1.42 — 默认模型加 Design**
- Settings → General → 默认模型 原来只显示 chat / code 两行，是 v0.1.0 的硬编码遗留——Design 模式（v0.1.9-v0.1.15）的 type / store / 默认值早就支持了，只有 UI 选择器没跟上。一行 `['chat', 'code']` → `['chat', 'code', 'design']` 修好。

**v0.1.41 — 7 个小改动一起发**
- **设置改用分栏**（General / 数据 / Skills / MCP / 工具）替换原来的长滚动页面，sticky 分栏头跟随滚动；侧 hint 显示每栏含哪些子节。「关于」放在 General 末尾。
- **Code 模式换工作区开新对话**：换文件夹或关闭 workspace 时 spawn 一个新的 code conversation，避免旧对话里的 FLAUDE.md / 文件路径上下文跟新工作区错位（同 folder 重选是 no-op）。
- **Skills/MCP 市场搜索改成显式提交**：原来的 350ms debounce 拿掉，必须按回车 / 点搜索按钮才发请求——federated 搜索 hit 4 个上游 registry，半截关键词（"ja"、"jav"）烧 cache 没意义。
- **管理员可删除非管理员用户**：新 endpoint `DELETE /admin/users/:id`，三层防御（不能自删 / 不能删另一个管理员 / 不存在 404），cascade 清掉对话/消息/项目/工件/usage_log。客户端两阶段确认：confirm 警告 + prompt 让管理员手抄目标 email——破坏力越大摩擦越多。8 个 server 单测覆盖每条 guard。
- **欢迎页 + 关于文案**：去掉「中国开源模型」「DeepSeek/Qwen/GLM/Kimi」等限定，改成「全球顶级模型」；关于栏去掉 v0.1 版本号（角标已经显示真版本了）。
- **设置侧 "技能" → "Skills"**：跟「Skills 市场」标签对齐。
- **测试**：客户端 543/543 不变；server 95/95（+8 admin DELETE）。

**v0.1.40 — MCP 市场联邦搜索（5 来源 + 三层信任徽章 + 🔴 强制勾选）**
- **痛点**：v0.1.37 的 MCP 市场是 6 条静态 manifest，加 MCP 必须发新版客户端。用户想搜某个特定关键词的 MCP 没法做。
- **跟 Skills 市场关键差异**：Skills 是文本注入（最差给烂建议）；MCP 是**在你电脑上执行代码**（stdio）或**给远端发任意请求带你的 prompt 数据**（HTTP）。一键装一个陌生 MCP = 把电脑给 random GitHub 用户。所以这次 trust gate 比 license filter 重要得多。
- **5 数据源并发**：PulseMCP（13k）/ Glama（22k）/ npm registry（双查询：keywords:mcp + 宽搜带 mcp 过滤）/ GitHub Code Search（topic:mcp-server）/ **官方包直接探**（hardcoded list of `@modelcontextprotocol/server-*`，绕过搜索引擎排序——经验上他们会把 mongodb-memory-server 排在 server-memory 50 倍以上）。
- **去重**：canonical id `npm:<package>` 优先，fallback `gh:<owner>/<repo>` 小写化。Promise.allSettled 让一个慢上游不沉其他。
- **三层信任徽章**：
  - 🟢 **官方**：`@modelcontextprotocol/*` / `@anthropic-ai/*` / repo `modelcontextprotocol/servers` → 一键
  - 🟡 **流行**：周下载 ≥1000 OR ⭐ ≥500 → 一键 + 详情默认展开（鼓励看一眼再装）
  - 🔴 **未审核**：其余 → 装按钮 disabled，必须勾选「我理解会执行 @publisher 的代码」
  - tier 权重在 score 函数里是绝对的（1M/10K/0），signals 只在 tier 内打破平局
- **License 不当主门槛**（跟 Skills 不同）——很多优质 MCP 仓库 license 字段空但 npm 包是 MIT，license 严格过滤会误伤太多。trust tier 是更准确的门槛。
- **Cache API 1h TTL**，8s upstream timeout。
- **Tools 列表预览砍掉 v1**——实测 Glama tools[] 95% 空，PulseMCP 没 detail endpoint。诚实显示「未知」比假装空预览强。
- **测试**：客户端 543/543（+7），server 88/88（+34 mcpsSearch）。

**v0.1.39 — Skills 市场联邦搜索（GitHub-wide, MIT/Apache 严格）**
- **痛点**：v0.1.37 的 Skills 市场是 8 条静态 manifest，加 skill 必须发新版客户端。用户想搜某个特定关键词的 skill 没法做。
- **方案**：搜索框接到 Worker 上新加的 `/api/skills/search?q=` 端点。Worker 调 GitHub Code Search API 找 `filename:SKILL.md`，对每条结果 fetch LICENSE + raw SKILL.md → 严格按 spdx_id ∈ {MIT, Apache-2.0} 过滤 + 解 frontmatter 验 name+description → 返回最多 20 条。
- **Worker** 新模块 [`server/src/skillsSearch.ts`](server/src/skillsSearch.ts)：requireAuth 守门（防 anonymous abuse 烧 GITHUB_TOKEN），并发 fetch license/raw、Cloudflare Cache API 1h 缓存、8s upstream timeout。`anthropics/skills` 显式 blocklist（proprietary LICENSE 双保险）。
- **Worker 修了一个真实 bug**：truncate 函数原来用 `s.slice(0, n-1)` 切 UTF-16 code units，遇到 emoji 或部分 CJK 字符（surrogate pair）会切掉一半，留 orphan low surrogate 在 JSON 出口里。改成 `[...s].slice(...)` codepoint-aware 切，并加回归测试。
- **客户端** [`SkillsMarketSection`](src/views/SettingsView.tsx) 顶上加搜索框：350ms debounce、inflightRef 抗 race、curated 与搜索结果按 id 去重、curated 命中关键词浮顶（带「推荐」徽章）、搜索结果带「GitHub」徽章 + license chip（MIT 绿 / Apache 紫）。
- **顺手修了另一个 bug（hotfix）**：v0.1.37 的 MCP 市场卡片「Echo demo (Flaude hosted)」指向 `api.flaude.net/mcp/echo` 但 Worker 端从未实现。补了个 80 行的最小 MCP HTTP 服务器（initialize / tools/list / tools/call echo），mount 顺序修正（必须在 `app.route('/', chat)` 前，否则 chat 的 `'*'` requireAuth 会先 401）。9 单测覆盖 wire 协议。
- **GITHUB_TOKEN 配置**：Worker secret，5000 req/h（认证）vs 10 req/min（不认证）。
- **测试**：客户端 536/536（+6），server 53/53（+19 search + 9 echo）。

**v0.1.38 — stdio MCP 服务器一键安装（桌面）**
- **痛点**：v0.1.37 的 MCP 市场 5 张 stdio 卡片只是给用户看的——要本地全局 npm 装、自启动、用 mcp-proxy 包成 HTTP 才能让 Flaude 接，6 步操作几乎没人会真做。
- **方案**：桌面版点「安装」就直接 spawn 子进程。Flaude 把 stdin/stdout 当 JSON-RPC 通道，注册的工具与 HTTP MCP 完全等价。Web 版保持「显示安装命令」不变。
- **Rust** 新模块 [`src-tauri/src/mcp_stdio.rs`](src-tauri/src/mcp_stdio.rs)：照 `bgshell.rs` 的 pattern，spawn child + drain stdout 按行进队列（newline-delimited JSON-RPC，MCP stdio spec 的标准帧格式）+ stderr 留作诊断。5 个 IPC 命令（spawn/send/recv/kill/list），16 并发 + 1024 队列上限，4 单测覆盖溢出路径。
- **TS** [`src/lib/mcp.ts`](src/lib/mcp.ts) 重构：抽出 `MCPTransport` 接口，`HttpTransport`（原 fetch 路径）+ 新 `StdioTransport`（Tauri invoke + 长轮询 recv），单 recv 循环按 JSON-RPC id 分发到 pending resolver。10 单测覆盖并发响应顺序、abort、子进程退出、stderr 累积。
- **Store** `MCPServer` 加 `transport` + `stdioConfig`；新 action `restartStdioMCPs` 在 app 启动时给每个 enabled stdio entry spawn 新进程（session id 不跨进程持久化，OS 在 app 退出时把子进程一起 reap 了）。
- **UI**：4 张 stdio 卡（filesystem、github、slack、memory）现在桌面一键装；postgres 故意不一键（每个用户的连接串不同）。带 envKey 的 token 输入框被改造，粘的值直接当 spawn env 注入子进程。
- **要求**：用户系统装了 Node.js（npx 在 PATH 里）。Flaude 不打包 Node——多花 30MB 装个不是必备的运行时不划算。
- **测试**：530/530 绿（+10 mcp.test.ts），4 Rust 单测。

**v0.1.37 — Skills 市场 + MCP 市场（curated, MIT-only）**
- **Skills 市场**：8 个社区 SKILL.md 入口，全部 MIT 授权且逐一 curl 验过。来源：`@nxd1184/java-clean-code`、`@thenguyenvn90/session-handoff`、`@avalonreset/claude-github`（audit + community）、`@scdenney/open-science-skills`（hypothesis-building + conjoint-design）、`@ronaldolaj/prodops-kit`（engineering + design-review）。Anthropic 官方 skills repo **故意不收**——其 LICENSE.txt 明确禁止把内容保留在 Anthropic Services 之外，再分发到 Flaude 是合规雷区。
- **MCP 市场**：6 个入口，1 个 HTTP 一键安装（Flaude echo demo）+ 5 个 stdio 安装说明（filesystem、github、postgres、slack、memory，来自 `modelcontextprotocol/servers`）。stdio 类暂不能一键，因为 Flaude MCP 客户端只支持 HTTP/SSE——卡片显示 npm 命令 + 复制按钮，提示用 `mcp-proxy` 包成 HTTP 再加。
- **SKILL.md 适配器**（`src/lib/skillsImport.ts`）：30 行扁平 YAML 解析，支持 plain/quoted/block-scalar，BOM 容忍，14 单测覆盖错误路径。比直接拉一个 YAML lib 划算。
- **设计选择**：静态 manifest 烘进 bundle（刷新 catalog = 发新版）。理由：精挑 ~10 条优质 > 服务 500 条自动爬来的垃圾。v2 候选：动态 registry。
- 每张卡片显示 publisher / source / license 归属；安装后的 Skill 加 attribution footer，用户日后改时仍记得来源。
- **测试**：520/520 绿（+14 新）。

**v0.1.36 — 修 sub-agent 在 DeepSeek thinking 模式下立刻 400**
- 用户实测 v0.1.34 sub-agent：默认 DeepSeek V4 Pro（带 reasoning），spawn_subtask 第一轮工具调用立刻 400「The reasoning_content in the thinking mode must be passed back to the API」。
- 跟 v0.1.18-19 修主聊天的是同一个 DeepSeek thinking 协议契约——turn N 的 reasoning_content 必须在 turn N+1 的 assistant 消息里 echo 回去。我写 v0.1.34 sub-agent 时偷懒了，没处理这条。
- 修：runSubagent 加 `reasoning` 累积 + 在 assistant 消息打 toolCalls 时同时 patch `reasoning` 字段；wireFormat 已有的 echo 逻辑接管剩下的事。

**v0.1.35 — 5 分钟空闲自动登出**
- 用户实际请求：「客户端关闭 5 分钟后 / 网页关 tab 5 分钟后自动退出当前账户」。
- **机制**：心跳（每 60s 写 `lastActiveAt`，加 `visibilitychange` / `pagehide` / `beforeunload` 关闭瞬间补一次）+ 启动时 `onRehydrateStorage` 检查 `Date.now() - lastActiveAt > 5min` → 清 `auth` 但保留 conversations/skills/memory（重登不必重 sync）。
- **重要语义**：开着页面不动 = JS 活着 = 心跳持续 = 不登出。只有「关 tab/app 5+ 分钟没回来」才强制重登。`lastActiveAt: 0`（升级前持久化状态没这字段）当作"fresh enough"，避免老用户首次升级被误踢。
- **测试**：506/506 绿（+8 新；纯函数 `shouldClearAuthOnRehydrate` 全分支：null auth / 0 lastActiveAt / 边界 / 过期 / 自定义 timeout）。

**v0.1.34 — Sub-agents（cheap 版，对比表 P2）**
- **核心**：Code 模式新增 `spawn_subtask({title, prompt, context?})` 内置工具，把独立工作外包给隔离的子 conversation。子 agent 跑工具循环、产出最终文本回传 parent——parent 上下文里只见一段总结，不见 30 个工具调用。Token 效率最大化。
- **新模块** [`src/lib/subagent.ts`](src/lib/subagent.ts) ~250 行独立 runtime（不依赖 React），创建子 conversation → 流式 → 工具循环 → 返回最终文本。15 轮上限（parent 30）防跑飞。
- **`Conversation.parentConversationId`** 字段：标记子任务对话；新 store action `newSubtaskConversation` 不改 activeConversationId（背景跑，不打扰用户）。
- **隔离边界**：子 agent 继承父 model / workspace / projectId / globalMemory / skills；**不**继承父对话历史 / Plan 状态 / 父 hooks。子 agent 不能再开子 agent（v1 防 fork bomb）。
- **Code prompt 抽出** [`src/config/codeSystemPrompt.ts`](src/config/codeSystemPrompt.ts)：避免 subagent runtime → view 模块依赖。
- **测试**：498/498 绿（+11 新）。

**v0.1.33 — wire format 400 修复三连击的第三发：assistant.tool_calls 内 dedup**
- v0.1.26 修了 orphan tool_calls（assistant 含 tool_calls 但无 tool 消息），v0.1.30 修了重复 tool_call_id 跨 tool 消息，**这次是同一 assistant 消息的 tool_calls 数组自身含重复 id**（如 `[A, B, B, C]`）→ 上游声明 4 个、响应 3 条 → 「insufficient tool messages following tool_calls message」。
- 把 orphan-strip 改成「过滤 + 去重」一遍过：先看 id 是否有 tool 消息响应（orphan check），再看是否本次循环已 emit 过（dedup check）。First occurrence 保留。
- +3 测试，487/487 绿。

**v0.1.32 — 后台任务面板二修：sub-second 命令也能显示时长**
- v0.1.31 修了「还没有输出」+「跑了 53 秒」假数据，但首次轮询就已经退出的快任务（如 `node -e 'console.log("hi"); process.exit(2)'`）只显示「完成」/「退出码 N」，没时长——因为我用「见证 running→done 转换」当唯一捕获条件。
- 真实场景：bgshell 是内存态、不持久化，不存在「应用启动时遗留旧任务」这个我之前担心的场景。所以「首次见到就已完成 → 不记录」的 guard 没意义，去掉。
- 现在：所有首次见到的已完成任务都记录 `now` 当 endedMs，最多差一个轮询间隔（~2 s），对秒级以下任务 `formatDuration` 渲染成「<1 秒」无感。`diffNewlyCompleted`（badge 计数）保持只在见证转换时触发，避免噪音。

**v0.1.31 — 后台任务面板修复：输出常空 + 时长不准**
- **bug 1「还没有输出」**：v0.1.29 的 BackgroundTaskRow `loadOutput` 是 `useCallback([task])`，每 2 秒轮询都创建新 task 对象 → loadOutput 身份变 → useEffect 重新触发 → shellRead drain ring buffer → setOutput 用空覆盖前一次捕获。修：task.id 用 ref 稳住 callback 身份；`initialLoadRef` 只在 expand false→true 转换触发；setOutput 改成 append（手动 ↻ 时累积）。
- **bug 2「运行了 53 秒」**：`Date.now() - startedMs` 对已完成任务无意义但仍在算——快速退出的任务也显示一直增长的时长。bgshell Rust 侧没暴露 ended_ms。修：客户端加 `updateObservedEndedMs` helper，轮询看到 running:true→false 转换时记录 Date.now() 当合成结束时间；首次轮询就已完成的任务（没观察到转换）干脆不显示时长，避免撒谎。
- **测试**：484/484 绿（+6 新；transition 记录 / 已记录保留 / first-poll-finished 不记 / 移除清理 / 并发 / round-trip）。

**v0.1.30 — 双修：tool_call_id 重复 400 + 底部面板可拖拽**
- **bug**：用户实测发现，跑完一个有 3 个 shell_start 的 prompt、手动从后台任务面板 remove 掉 3 个进程、再发新 prompt → 上游 400 「Duplicate value for 'tool_call_id' of call_X in message[N]」。具体路径未完全定位（可能是 v0.1.26 stop-cleanup 合成的「用户取消」消息与真实 tool 结果竞争，或 regenerate 路径残留），但症状是历史里两条 `role: tool` 消息共享同一 `tool_call_id`。
- **防御层修复**：`wireFormat.serializeMessages` 加 last-write-wins 去重——同 tool_call_id 多个 tool 消息时只 emit 最后一条。这是 v0.1.26 orphan tool_calls 修复的姊妹补丁，把 wire format 协议合规收紧到「每个 tool_call_id 至多对应一条 tool 消息」。
- **UX**：Code 模式底部面板（Tools/Terminal/Git/后台任务）从原 180px 死高改成可拖拽——拖把手位于 tab 上方，row-resize cursor，clamp [80, 800]，新字段 `codeBottomPanelHeight` 持久化（同 artifacts panel 的 column resize 同一套机制）。
- **测试**：478/478 绿（+3 新；单 dup / 三 dup / distinct ids 不误杀）。

**v0.1.29 — 后台任务面板（对比表 P1）**
- **核心问题**：bgshell 基建 v0.1.4 就有了（agent 调 shell_start/read/write/kill），但用户**完全看不见**正在跑啥——只能翻 chat 历史找原 tool call。
- **新 hook** [`useBackgroundTasks`](src/hooks/useBackgroundTasks.ts)：每 2 s 轮询 `shell_list`；纯函数 `diffNewlyCompleted` 检测 running → done 转换（一次性、不重复 emit；首次见到的已完成任务不算「刚完成」，避免应用启动时旧任务刷屏）。
- **新组件** [`BackgroundTasksPanel`](src/components/code/BackgroundTasksPanel.tsx)：列表 + 状态徽章（运行中 pulsing dot / 完成 / 失败 / 被杀）+ 点击展开看输出（按需 `shell_read`，显示最后 4 KB 偏向用户想看的近期输出，buffer overflow 警示）+ 行内 kill / remove 操作。
- **CodeView 加第 4 个底部 tab**：Tools / Terminal / Git / 后台任务，带运行数 emerald badge——其他 tab 时也能看到「有 N 个进程在跑」。CodeView 自身轮询保持 badge 实时；面板用同一 hook 但 `active=tab-is-current` 避免双倍轮询。
- **测试**：475/475 绿（+12 新；snapshotOf + diffNewlyCompleted 全分支覆盖）；浏览器预览验证 tab 渲染 + 浏览器模式空态。

**v0.1.28 — Hooks（对比表 P1）**
- **核心**：Code 模式 agent 事件触发自动跑 shell 命令，把 agent 输出接进工程纪律——写完文件自动 typecheck、危险命令自动拦截、本轮结束自动 git status / 桌面通知。
- **三种事件**：`pre_tool_use`（exit ≠ 0 阻止工具，stderr 反馈给 agent）/ `post_tool_use`（stdout/stderr 拼到工具结果给 agent 看）/ `stop`（背景执行，输出丢弃）。
- **新模块** [`src/lib/hooks.ts`](src/lib/hooks.ts)：纯函数 `matchTool` / `interpolateCommand` / `shellQuote`（平台感知）+ `runHook()` 用 `cmd /c`（Windows）/ `sh -c`（POSIX）包装。
- **变量替换**（执行前 shell-quoted）：`$FLAUDE_TOOL` / `$FLAUDE_FILE` / `$FLAUDE_WORKSPACE` / `$FLAUDE_ARGS_JSON`。
- **工具匹配器**：精确 / `|` 分隔多个 / `*` 通配。3 个 conversation-only 工具（todo_write / create_artifact / exit_plan_mode）跳过 hook 触发避免空跑。
- **运行时插入**：`useStreamedChat` 在 `executeTool` 前后 + `runTurn` finally 三个点；与 Plan 模式的人工审批互补——Plan 在副作用前人工审，Hooks 在副作用后机器审。
- **Settings UI**：HooksSection 列表 + 编辑器（事件下拉 / 工具匹配 / 多行命令 / 超时 / enabled / 可展开变量帮助）。
- **持久 + 可携**：`hooks` 加 persist 白名单 + accountExport bundle + accountImport LWW 合并。
- **测试**：463/463 绿（+30 新；纯函数全覆盖）。运行时本身依赖 Tauri shell_exec，桌面构建实测。

**v0.1.27 — 数据导入（对比表 P1）**
- **闭环 v0.1.20 的 export**：用户能把以前导出的 JSON 备份导回来——换设备 / 换 Worker / 实验前快照恢复都管用。
- **新模块** [`src/lib/accountImport.ts`](src/lib/accountImport.ts) 三段式：`parseImportBundle`（schema 校验 + 5 类错误）/ `previewImportBundle`（per-entity 计数 + 跨账号检测）/ `applyImportBundle`（调 `applyPulled*` 复用 sync 路径的 LWW + tombstone + 冲突 toast）。
- **SettingsView UI**：「从备份导入」按钮紧挨「导出全部数据」；隐藏 file input 在浏览器和 Tauri WebView2 都能跑；预览 modal 显示计数表 + 跨账号 amber 警告 + 「同时导入设置」勾选（默认关）+ Apply/Cancel。
- **保守默认**：settings（主题/默认模型/全局记忆/MCP/斜杠/禁用工具）默认**不**导入——多数「换设备恢复」想要数据不想要 per-device 偏好；用户主动勾选才合并。
- **测试**：433/433 绿（+19 新）；浏览器预览端到端验证 LWW 正确（本地新的保留、bundle 新的覆盖）+ 跨账号警告 + 错误内联显示 + 设置 gate 工作。

**v0.1.26 — 修 Stop 中断后无法继续对话的死锁 bug**
- **症状**：Code 模式 agent 刚发起一个 tool_call、用户点 Stop 中断、再发新 prompt → 上游 400 「assistant message with tool_calls must be followed by tool messages」，会话从此永久死锁。用户实测发现的真坑。
- **根因**：abort 路径只 `controller.abort()` 不清状态——assistant 消息留下孤儿 tool_call，下次序列化时违反 OpenAI 协议。
- **双层修复**：(1) `wireFormat.ts` 序列化前 pre-pass 收集所有有 tool 结果的 tool_call_id，emit 时过滤孤儿；全孤儿 → fallback 纯文本 assistant 消息（保留 partial content + reasoning_content）。(2) `stop()` 标 pending tool_calls 为 `status='error' error='用户取消'` 并补 synthetic tool 结果消息——chat 里看 ✗ canceled 不再永远 spinning。+5 单测。

**v0.1.25 — Plan 模式（对比表 P0.3）**
- **核心问题**：Code mode 30-round 工具循环跑歪 90% 因为 turn 1 理解错任务，烧 token 还可能改坏文件——把 Claude Code 的 Plan 模式搬过来。
- **Composer 加 Plan 切换**（Code 模式可见，per-message，自动 reset）：开启后下一轮 agent 必须先用只读工具调研、写一份 markdown 计划、调 `exit_plan_mode` 让用户审，批准后副作用工具才解锁。
- **三向退出**：批准（解锁继续）/ 反馈（具体说要怎么改，agent 重新提交）/ 拒绝（停止）——比 yes/no 多出来的「反馈」覆盖最常见的「差不多但改 X」场景。
- **新模块** [`src/lib/planModeRuntime.ts`](src/lib/planModeRuntime.ts) 含 `PLAN_MODE_PROMPT`（系统提示词，明确列出 5 个被锁工具 + 所有允许工具 + 计划结构模板）+ `isDestructiveToolName`；[`src/lib/planMode.ts`](src/lib/planMode.ts) 是仿 writeApproval 的 Promise 桥；[`src/components/code/PlanApprovalModal.tsx`](src/components/code/PlanApprovalModal.tsx) 渲染 markdown 计划。
- **运行时门禁**：`useStreamedChat` 加 `planTurnStateRef`（inactive / planning / approved），副作用工具调用前检查；批准后解锁直到本轮结束。
- **测试**：409/409 绿（+22 新；6 个 bridge + 16 个 runtime）；浏览器预览端到端验过 toggle、modal 渲染、反馈流、队列清空。

**v0.1.24 — globalMemory 条目化 UI（对比表推荐 3）**
- **核心问题**：原 textarea 答不出「这条记忆现在到底有没有进 system prompt」，也没法临时关掉一条而不删掉。这两个回答关系到所有未来 memory 工作（自动抽取、provenance、「为啥模型这样回」）的可用性，所以先把基建打上。
- **不改 schema**：`globalMemory` 仍是 string，禁用通过每行 `<!--disabled-->` 标记实现——sync / accountExport / 老存档全部继续工作；future 自动抽取直接 append 字符串就能融入。
- **新模块** [`src/lib/globalMemory.ts`](src/lib/globalMemory.ts)：`parseEntries` / `serializeEntries` / `effectiveGlobalMemory`。`composeSystemPrompt` 调 `effectiveGlobalMemory` 剥离禁用行；全部禁用时整段「用户记忆」section 不输出，避免空 header。
- **UI 重写**：[`MemorySection`](src/views/SettingsView.tsx) 从 textarea 改成行列表——每行 Eye/EyeOff toggle + 内联编辑（blur/Enter commit、Esc revert）+ Trash 删除；底部「+ 添加一条」按钮起一个临时空行（不写入持久化字符串），只有提交后才落地。计数器 `{total} 条（{enabled} 启用）· 约 X tokens 注入` 实时显示成本。
- **新 footgun 修复**：老 textarea「打字 → 关 tab → 丢失」的隐 bug 没了——所有编辑都 commit on blur/Enter，没有「Save」按钮可以错过。
- **测试**：387/387 绿（+24 新；19 个 globalMemory loader 测试 + 2 个 systemPrompt 集成测试 + 旧测全保留）。
- **浏览器预览端到端**：seed 4 条（含 1 条禁用）→ toggle 让计数器从「3 启用」掉到「2 启用」+ raw 字符串获得 `<!--disabled-->` 前缀；「+ 添加」+ Enter 提交 → 字符串 append；Trash 删除 → 行 + 字符串都清。零 console 错误。

**v0.1.23 — workspace memory + 附件类型扩展（按对比表 P0.1 + 推荐 1）**
- **CLAUDE.md / FLAUDE.md 自动加载**（[#1 推荐](#)）：新增 [`src/lib/workspaceMemory.ts`](src/lib/workspaceMemory.ts) 在 Code 模式工作区根目录探测 `FLAUDE.md`（首选）/ `CLAUDE.md`（fallback），100 KB 上限、UTF-8 边界感知截断；注入到 system prompt 的 `## 工作区约定` section（位于 globalMemory 之后、skills 之前）。CodeView 文件浏览器顶部加状态徽章——绿色「FLAUDE.md · 2.1 KB」/ 琥珀色「· 已截断」/ 灰色「未找到」，window focus 时自动重读外部编辑器的改动。16 个 vitest 覆盖 loader 边界 + 5 个新 systemPrompt 注入测试。
- **附件类型扩到 PDF / 文本 / 代码**（对比表 P0.1）：之前 [`providerClient.ts`](src/services/providerClient.ts) 只把 `image/*` 序列化成 `image_url`，其他静默丢——投研贴 PDF、Code 模式贴 requirements.txt 都白费力气。新增 [`src/lib/fileExtraction.ts`](src/lib/fileExtraction.ts) 处理三类：image（base64 data URL，避开 FileReader 走 `arrayBuffer + btoa` 让 vitest node env 也能跑）/ text（File.text() + 扩展名 allowlist 兜空 mime 的代码文件）/ pdf（pdf.js 5.6 客户端抽取，per-page section header，命中 256 KB 上限早退）。Office 文档（docx/xlsx/pptx）保持拒绝但提示用户走 `fs_read_file`（Tauri 已有 native 抽取器）。
- **Ctrl+V 粘贴文件**：Composer textarea 监听 `paste`，clipboardData.files 非空时 preventDefault 走附件路径。截图工具直接 Ctrl+V，文件管理器复制文件 Ctrl+V，都直接成附件——纯文本粘贴不受影响。
- **wireFormat 重构**：`serializeMessages` 从 [`providerClient.ts`](src/services/providerClient.ts) 抽到 [`src/services/wireFormat.ts`](src/services/wireFormat.ts) 独立单测；text 附件渲染成 ` **附件: name**\n```lang\n...\n``` ` 拼到 user 消息体（或多模态 text part），混合 image+text 时同帧多模态。21 个新 wireFormat 测试 + 13 个 fileExtraction 测试。
- **UI 微调**：附件 chip 区分 📄 文本（含字符数 + 截断标记）/ 🖼 图片，文件选择器 `accept` 从 `image/*` 拓宽到全部支持类型。
- **测试**：363/363 vitests 绿（v0.1.22 时 313 → 此版 363，+50）；typecheck 干净；浏览器预览端到端跑过 paste 三类文件 + 拒绝路径。

**网页版 + 独立域名（原 #10，已完成）**
- **v0.1.2**：客户端 bundle 切到 `https://api.flaude.net`（Cloudflare Pages + Worker custom domain）；`DownloadDesktopButton` 在挂载时打 GitHub Releases API 拿到最新 MSI 直链，浏览器用户一键下载而不是落到 release 列表页。`workers.dev` 老地址保持在线让 v0.1.1 的旧装机包继续工作。
- **v0.1.3**：MSI 安装器 chrome 切到 zh-CN（`tauri.conf.json` 的 `wix.language`）；AdminView 创建用户 modal 修复"在输入框里框选文字、鼠标抬到背景上 → 误触关闭并丢失草稿"——`mousedown` 起源跟踪，press 和 release 都落在背景上才关。
- 桌面专属能力（`fs_*` / `shell_*` / 工作区选择器）在浏览器下灰掉并提示"仅桌面版"——见 [CodeView.tsx:116](src/views/CodeView.tsx:116) 等十处 `isTauri()` 守卫。

**Design 模式（全新第三模式，v0.1.9 → v0.1.15）**

- **v0.1.9**：Phase 1 落地。模型每轮产出一个自包含的 ` ```html / ```jsx / ```svg / ```mermaid` fence，[`DesignCanvas`](src/components/design/DesignCanvas.tsx) 在 sandboxed iframe 里渲染，带移动/平板/桌面三种断点 + preview/source toggle + 版本步进 + HTML 下载 + 2x retina PNG 导出（postMessage + html2canvas 桥）。默认模型 DeepSeek V4 Pro，空会话 banner 提供一键切到 Flash 节省 ~12x 成本。带图附件的轮次自动透传到 Qwen-Max（vision），下一轮文本回到 V4 Pro——逻辑在 [`useStreamedChat`](src/hooks/useStreamedChat.ts) 的 `pickModelOverride`，view 不感知。19 个 unit test 覆盖 [`designExtract`](src/lib/designExtract.ts) 解析。
- **v0.1.10**：升级老存档 `modelByMode`/`conv.modelId` 缺失时自愈（rehydrate 时补齐），不弹 modelId not found。
- **v0.1.11**：Design fence 绕过 artifact 抽取管道，让 `DesignCanvas` 拿到原始 fenced block 而不是被前面的 artifact 流把 ``` 吃掉。
- **v0.1.12**：把 chat 流里的 design fence 折叠成一个 chip，避免长 HTML 把消息列表撑爆。
- **v0.1.13**：PNG 导出的临时 iframe 加 `allow-same-origin`，修跨域报错。
- **v0.1.14 / v0.1.15**：vision 回退模型从 `qwen-max`（不支持图）→ `qwen-vl-max-latest` →（VL-Max 即将下线）→ `qwen3-vl-plus`。

**Code mode 深坑修复（v0.1.16 → v0.1.22）**

- **v0.1.16**：Office/PDF 原生抽取。新增 [`src-tauri/src/office.rs`](src-tauri/src/office.rs)，`fs_read_file` 按扩展名分流：xlsx/xls/xlsm/xlsb 用 calamine 0.30 转 markdown 表格、docx/pptx 用 zip + quick-xml 走 `w:t`/`a:t` 拿纯文本、pdf 用 pdf-extract（外加 panic-catch 兜马尔形 PDF）。封顶 512 KB（plain text 仍是 256 KB）。**起因**：旧版 `String::from_utf8_lossy` 在 .xlsx 上吐 256 KB 的 `PK\x03\x04` 乱码——一个真实投研任务因此跑了 42 个 tool call、7 次错误、浏览器卡死才放弃。
- **v0.1.17**：CI release workflow 修复——`tsc -b` 需要服务端 deps 才能 resolve `workers-types`，加 `pnpm install` 服务端步骤。
- **v0.1.18 / v0.1.19**：DeepSeek thinking-mode + 工具调用循环回传修复。第一轮 `reasoning_content` 一并 echo 给上游让 DeepSeek 接得上自己的思考链；下一轮的 history 也带 reasoning，否则 DeepSeek 会在第二个 tool call 之后开始重复自己。Sidebar 顺手把"v0.1"硬编码改成读真版本号。
- **v0.1.20 / v0.1.21**：WebView2 OOM 修复。长 thinking-mode + Office 抽取轮里 Chromium 进程会涨到 4 GB+ 然后挂——把 thinking 流式 patch 限流到 30 fps，tool-call-arg 同样。
- **v0.1.22**：Artifact 面板下载在 Tauri 下走 `downloadTextFile`（原生保存对话框）而不是 `<a download>`（在 Tauri WebView 里不弹保存框）。

**辅助修复（v0.1.4 → v0.1.8）**
- **v0.1.4**：todo_write 重构。原方案 `tools.ts` 直接 import `useAppStore`，重构成 `TodoItem` 类型 + `ctx.setTodos` 注入 + 独立 `TodoPanel` 组件——store 与工具实现解耦，便于未来加 todo 上下文同步。
- **v0.1.5**：登出擦除用户内容防跨账号串数据（同一 Windows 帐户上多人用 Flaude 的边界情况）。
- **v0.1.6**：DeepSeek catalog 升到 V4（flash + pro），并把 `qwen-long`/`qwen-coder`/`moonshot-v1-auto` 也注册到服务端 `providers.ts`，加 catalog drift 测试防止再漂移。
- **v0.1.7**：每次 rehydrate 重新从代码 seed provider catalog——避免老 localStorage 把已下线模型钉住。
- **v0.1.8**：Projects 创建 modal 同样的 drag-select 误关 fix（与 v0.1.3 admin modal 同模式）。

---

## 之前完成（2026-04-20 那次 session，对应 v0.1.0 / v0.1.1 之前打底）

- **Code agent 打磨 2-2（持久 PTY / 后台 shell）**：新增 Rust `bgshell` 模块（`src-tauri/src/bgshell.rs`）——`tokio::process` 起子进程 + 独立 task 分别 drain stdout/stderr 到 256 KB ring-buffered 缓冲区 + 第三个 task 用 `tokio::select!` 同时等待自然退出与 kill 信号。前端 5 个 agent 工具：`shell_start` / `shell_read`（可选 wait_ms blocking drain）/ `shell_write` / `shell_kill` / `shell_list`。上限 8 并发。`kill_on_drop(true)` 保证 app 退出时所有子进程被清理。`shell_read` 报告 stdout/stderr 各自的 overflow dropped bytes，让模型知道输出被截断。11 个 vitest + 4 个 Rust 单测（缓冲区溢出裁剪逻辑）。
- **Code agent 打磨 2-5（Agent 自维护 TODO）**：新增 `todo_write` 内置工具 + `AgentTodo` 类型 + 每会话 `agentTodos[convId]` 存储。严格校验：schema 完整、status ∈ {pending, in_progress, completed}、最多一个 in_progress。`ToolCallCard` 识别 `todo_write` 后切换到专用 `TodoListCard` 渲染——checklist 样式，`in_progress` 显示 activeForm 加粗 + 旋转 spinner，`completed` 描划线。删除会话时自动清理 `agentTodos`。9 个 vitest。
- **#6 全账号数据导出**：新增 [`src/lib/accountExport.ts`](src/lib/accountExport.ts)，`buildAccountBundle()` 从 store 构建 JSON 包；conversations / projects / artifacts 复用 `sync.ts` 已有的 wire 转换器（改为 `export` 暴露给导出模块），所以 bundle 格式与 `/sync/pull` payload 一致——未来写导入路径可直接喂给 `applyPulledConversations` 等。`SettingsView` 在「全局记忆」后插入「数据管理」section：7 项计数卡（会话/消息/项目/工件/技能/斜杠/MCP）+「导出全部数据」按钮。浏览器走 Blob + `<a download>`，Tauri 走原生保存对话框。有意**不包含**：`workspacePath` / `allowFileWrites` / `allowShellExec`（按设备配置）、`auth` / sync cursor / dirty queues / `pendingWrites` / `agentTodos` / `conflictRecords`（transient）。带 `schemaVersion: 1` 方便未来破坏性演进拒绝旧格式。12 个 vitest + 浏览器预览实测通过：button click 触发 bundle（捕获了 13.5 KB JSON，shape 完全符合预期）+「已保存」反馈 + 零 console 错误。
- **#7 管理员页自动刷新**：`AdminView` 的 `load()` 拆成手动/静默两档（`{ silent: true }` 不触发 spinner、不清空 error banner）。加 30 s `setInterval` 做后台 silent 轮询，两条护栏：**visibilityState !== 'visible' 跳过**（后台 tab 不打服务器）+ **modal 打开时不调度**（避免跟内联编辑打架）。另挂一个 `visibilitychange` 监听，tab 回到前台立刻补一次 silent fetch。UI 在刷新按钮旁加「更新于 N 秒前/N 分钟前/N 小时前」标签，`title` 显示绝对时间戳；tick 靠 5 s 的 `setInterval` 驱动。新增 6 个 vitest 覆盖 `formatRelativeTime` 的各段边界。浏览器实测：手动点击→label 变 "刚刚"；重写 `visibilityState` + 派发事件→后台 fetch +1；打开「新建用户」modal 再派发→fetch 不变（暂停生效）；关闭 modal 再派发→fetch 恢复 +1。
- **#8 部署文档**：新增 [`server/DEPLOY.md`](server/DEPLOY.md)，约 280 行的从零自建 walk-through：前置条件（`wrangler login`）→ `d1 create flaude` + 粘贴 id → `db:init:remote` 跑 schema（不需要跑 migrations，schema.sql 已经包含全部 phase 3 表）→ `wrangler secret put` 推必选 `JWT_SECRET` 和可选的 4 家 LLM provider + 博查 → `pnpm deploy` → `curl /setup` 做 bootstrap admin → 客户端 `VITE_FLAUDE_SERVER_URL` 指向新域名 + `tauri:build`。附「日常运营」（加用户 / 轮换 secret / 跑新 migration / tail 日志 / 回滚）+「排错」（CORS / 401 / `setup already complete` / `d1 create` name conflict）+「自定义域名」+「成本估算」（10 人团队 ~$1/月）。更正了 ROADMAP 原文里把客户端变量名写成 `VITE_FLAUDE_API_BASE` 的错误——实际变量是 `VITE_FLAUDE_SERVER_URL`。[`server/README.md`](server/README.md) 的 Deploy 段替换成一句总结 + 到 DEPLOY.md 的链接，避免两份文档漂移。
- **#9 Windows 打包 + 自动更新（免费方案）**：按用户要求只做免费部分，签名留给未来。
  - **Rust 侧**：`src-tauri/Cargo.toml` 加 `tauri-plugin-updater` + `tauri-plugin-process`；`lib.rs` `.plugin()` 注册；`capabilities/default.json` 授权 `updater:default` + `process:allow-restart`。
  - **配置**：[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) bundle target 收敛到 `["nsis", "msi"]`，NSIS 走 per-user 安装（`installMode: "currentUser"` 不要管理员权限），中英双语安装器；新加 `plugins.updater` 段带 endpoint（占位 GitHub URL）+ pubkey 占位。`createUpdaterArtifacts: true` 让 `tauri:build` 自动产出 `.sig` 文件。
  - **前端**：[`src/lib/updater.ts`](src/lib/updater.ts) 封装 `@tauri-apps/plugin-updater` 的 `check()` / `downloadAndInstall()` + `@tauri-apps/plugin-process` 的 `relaunch()`，5 分钟缓存避免重复拉 `latest.json`；`isTauri()` 短路保证浏览器版零副作用。[`src/components/shell/UpdateBanner.tsx`](src/components/shell/UpdateBanner.tsx) 右下角卡片 UI，文案「Flaude X.Y.Z 可用」+ 发布说明 + 三按钮「立即更新 / 稍后 / 忽略此版本」（「忽略此版本」写 `localStorage`，新版出现时自动失效）；下载中显示带进度条。挂在 `AppShell` 最底层，跟 `ConflictToasts` / `WriteApprovalModal` 同级。
  - **CI**：[`.github/workflows/release.yml`](.github/workflows/release.yml) 在 tag push `v*` 时跑 Windows runner 构建，签安装器，写 `latest.json`，创建 GitHub Release 附上所有产物。支持 `workflow_dispatch` 手动触发出 artifacts 但不建 release（CI 流程自测用）。缓存 Rust target 目录把第二次以上的构建从 ~10 min 压到 ~3 min。
  - **文档**：[`RELEASE.md`](RELEASE.md)（~230 行，根目录）。首次一次性准备三件事：`pnpm tauri signer generate` 生 updater 密钥对、私钥 + 密码推 GitHub Secrets、公钥填 `tauri.conf.json`。之后每次发版只需 `git tag vX.Y.Z && git push --tags`。同事侧：下载 `-setup.exe` → 首次点「仍要运行」过 SmartScreen → 以后自动更新。详述为什么不做代码签名（自签无效、EV 贵、MS $19/年 + HSM 不划算、Azure Trusted Signing 未来再开）以及 SmartScreen reputation 会随下载量累积消警告。包含忘记私钥密码 / CI 凭据错 / endpoint URL 错 / 私有仓库等故障场景。
  - **浏览器预览实测**：浏览器下 `isTauri() === false`，UpdateBanner 短路不渲染（body 不含"可用"），AppShell 正常渲染（侧栏 + 主区存在），无新增 console 错误。typecheck 绿 + 266/266 测试通过 + `cargo check` 通过（含新增两个 plugin crate 编译）。

---

## 之前完成（更早的 session，phase 期）

- **多 provider 注册表**：服务端 `providers.ts` 从只支持 DeepSeek 扩到 DeepSeek + Qwen + Zhipu GLM + Moonshot Kimi。commit `ab0651a`。
- **Sidebar 同步状态角标**：v0.1 版本号旁边显示 pulling/pushing spinner，失败显示 CloudOff 图标。commit `dea6c9a`。
- **startSync 双触发修复**：React.StrictMode 下的 useEffect 双调用用 in-flight promise 合并。commit `ba1b9dc`（含在 initial commit 里）。
- **Projects / Artifacts 同步（原 #1 阻塞级）**：D1 加表 + `/sync/pull|push` 扩展 payload + 客户端 dirty 追踪全部落地；LWW + tombstone 与 conversations 共用一套。commits `14d9463`（projects）、`83ee165`（artifacts）、`b50267b`（LWW 冲突 toast）。
- **核心路径测试覆盖（原 #5 体验级）**：分三个 commit 补齐。`bb1c737`—store actions 49 个 vitest；`93e8751`—`lib/sync.ts` 22 个（pull/push/debounce/retry）；`test(server)`—服务端 25 个集成测试（node-env + better-sqlite3 D1 shim，跳过 workerd 因为仓库路径含非 ASCII 字符）。测试过程中顺手修掉一个生产 bug：`admin.use('*', requireAdmin)` 因为 sub-app 挂在 `/`，`*` 在 Hono 下匹配所有路径，导致非 admin 用户被锁在 /sync/pull 外——现在 scope 到 `/admin/*`。
- **Code agent 打磨 2-3 / 2-4（原 #2 体验级，部分）**：`useStreamedChat` 工具调用上限 8 → 30；`ToolCallCard` 长输出（>20 行 / >2000 字符）默认折叠，展开按钮显示总量。commit `bee00f8`。
- **Code agent 打磨 2-1（原 #2 体验级，最重要一项）**：`fs_write_file` 调用前弹 diff preview 让用户审查。新增 `lib/diff.ts`（LCS 行级 diff，5000 行硬上限）+ `lib/writeApproval.ts`（handler↔modal 桥，module-level resolver Map + zustand 传可序列化数据）+ `WriteApprovalModal`（mono diff view + Esc 拒绝 / Ctrl/⌘+Enter 应用）。`allowFileWrites` 从"全开全关"变成"gate + per-call 审查"——用户看得到 diff 再决定。新增 20 个 vitest（15 diff + 5 approval 桥）。

**重要修正**：老版本 ROADMAP 里把"Code 模式真工具"列为阻塞级待办是**错的**——`src/lib/desktopTools.ts` 已经通过 Tauri 原生 API 接了 `fs_list_dir` / `fs_read_file` / `fs_stat` / `fs_write_file` / `shell_exec` 五件套，带权限门，Code agent 能真读写文件、跑 shell 命令。那项打磨性的工作移到下面 **#2**。

---

## 阻塞级（不做完，"实际可用"就有明显缺口）

_当前无阻塞级待办。原 #1（Projects / Artifacts 同步）已于本 session 完成——见上方"最近完成"。_

---

## 体验级（不做完，产品能用但粗糙）

### 2. ~~Code agent 打磨项~~ ✅ 完成

全部五项打磨已落地（跨 session）：

1. ~~**写前确认 UI（diff preview）**~~ ✅
2. ~~**持久 PTY / 后台 shell**~~ ✅（`shell_start/read/write/kill/list` 五件套；本 session）
3. ~~**迭代循环上限**~~ ✅（8 → 30）
4. ~~**工具结果可折叠展示**~~ ✅
5. ~~**Agent 自维护 TODO**~~ ✅（`todo_write` + `TodoListCard` 专用渲染；本 session）

### 3. ~~网络失败没有重试 / 退避~~ ✅ 完成（commit `93cb433`，2026-04-19）

指数退避 1s / 5s / 30s / 2min 四次已落地在 [`src/lib/sync.ts`](src/lib/sync.ts)，pull 和 push 各有独立重试计数器。可重试 = 网络层 throw + 5xx；4xx 直接失败。重试期内 `syncState` 保持 `pulling` / `pushing`，spinner 继续转，用户看到的是"还在试"而不是"失败"。显式触发（用户编辑 → schedulePush 或另一次 pullNow）会抢占重试定时器。22 个 vitest 专门覆盖这条路径（见 `retries a 500 (retryable) with 1s backoff` / `flips to error on non-retryable 400` 等）。

### 4. ~~多设备冲突没有 UI 呈现~~ ✅ 完成（commit `b50267b`，2026-04-19）

[`applyPulledConversations`](src/store/useAppStore.ts:1140) 在 LWW 覆盖 + 本地 dirty 时把旧版本 stash 成 `ConflictRecord`（含 tombstone 路径），[`ConflictToasts`](src/components/shell/ConflictToasts.tsx) 挂在 [AppShell:95](src/components/shell/AppShell.tsx:95) 右下角渲染 amber 警告卡，文案"该会话已在另一设备修改"，两按钮「保留本地版本 / 忽略」→ `restoreConflict` / `dismissConflict`。1 小时 TTL 双层兜底（store 读时 lazy 过滤 + 组件每次 render 过滤）。6+ 个 vitest 覆盖 detect/restore/dismiss/tombstone/TTL。Projects 和 Artifacts 按设计走安静覆盖，不弹 Toast（store 注释已解释）。

### 5. ~~核心路径测试覆盖不足~~ ✅ 完成（见"最近完成"）

三步走全部落地：store 49 个、`lib/sync.ts` 22 个、服务端 25 个集成测试，总计 203 客户端 + 25 服务端。服务端测试跑在 node-env 下用 better-sqlite3 shim D1（放弃 `@cloudflare/vitest-pool-workers` 因为仓库路径 `C:\D\4 研究\...` 含非 ASCII 字符会打挂 workerd 的 fallback service）。顺手修掉一个生产 bug：`admin.use('*', requireAdmin)` 在 Hono sub-app 挂 `/` 时 `*` 会匹配全路径，非 admin 用户拉 /sync/pull 会被 403。Playwright E2E 仍暂缓。

### 6. ~~全账号数据导出~~ ✅ 完成（本 session）

设置页「数据管理」section 加了「导出全部数据」按钮，一键下 JSON 包；格式与 `/sync/pull` 对齐，为将来做"导入备份"铺路。详见上方"最近完成"。

---

## 打磨级（做完会显得"用心"，不做也不影响可用）

### 7. ~~管理员使用统计页刷新体验~~ ✅ 完成（本 session）

30 s 静默轮询 + 绝对/相对时间标签已落地，详见上方「最近完成」。

### 8. ~~部署文档~~ ✅ 完成（本 session）

[`server/DEPLOY.md`](server/DEPLOY.md) 已写。详见上方「最近完成」。

### 9. ~~Windows 打包与自动更新~~ ✅ 完成（本 session，免费方案）

Tauri v2 updater + GitHub Actions + `RELEASE.md` 全套落地。代码签名按用户要求留空——首次安装点一次 SmartScreen「仍要运行」，reputation 会随下载量累积消警告。详见上方「最近完成」。

如果未来要彻底消 SmartScreen 警告，`RELEASE.md` 第一节列了三条路径（EV 证书、微软开发者 $19/年、Azure Trusted Signing）。

---

## 不在 roadmap 里（明确放弃的事）

- **移动端（iOS/Android）**：Tauri v2 有实验性 mobile，但成本远高于收益。Flaude 定位是桌面工作者。
- **语音输入**：DeepSeek 等国内模型没有统一的 realtime audio API，接一家断一家，维护负担不划算。
- **图片生成**：跟 Flaude 的"代码/文档 copilot"定位不符。真想要就让 agent 调 MCP 工具对接外部服务。

---

## 当前状态速览（2026-04-29，v0.1.50）

| 模块 | 状态 |
|---|---|
| 本地骨架（UI + Zustand + 三模式 → 现在 **四视图**：Chat / Code / Design / Projects） | ✅ 完成 |
| 鉴权（JWT + Cloudflare Worker） | ✅ 完成 |
| 配额 + 计费（DeepSeek + Qwen + GLM + Kimi） | ✅ 完成 |
| 双向同步（conversations / messages / projects / artifacts） | ✅ 完成 |
| 多 provider 注册表（含 DeepSeek V4 flash + pro、Qwen3-VL-Plus、moonshot-v1-auto） | ✅ 完成 |
| Code 模式真工具（fs_\* + shell_exec + 持久 shell + Office/PDF 抽取 + write diff approval） | ✅ 完成 |
| Sidebar 同步状态角标 + 真版本号 | ✅ 完成 |
| 网络重试退避（1s / 5s / 30s / 2min） | ✅ 完成 |
| 多设备冲突 UI（ConflictToasts） | ✅ 完成 |
| 全账号导出（SettingsView 数据管理 section） | ✅ 完成 |
| 管理员页 30 s 静默轮询 | ✅ 完成 |
| 部署文档（[server/DEPLOY.md](server/DEPLOY.md)） + 发版文档（[RELEASE.md](RELEASE.md)） | ✅ 完成 |
| Windows 打包 + Tauri updater + GitHub Actions release | ✅ 完成（免费方案，未签名） |
| **网页版 + 独立域名（`flaude.net` / `app.flaude.net` / `api.flaude.net`）** | ✅ 完成（v0.1.2 / v0.1.3） |
| **Design 模式（HTML/JSX/SVG/Mermaid + sandboxed iframe + 视觉模型回退）** | ✅ 完成（v0.1.9 → v0.1.15） |
| **Office/PDF 原生抽取（calamine / quick-xml / pdf-extract）** | ✅ 完成（v0.1.16） |
| **DeepSeek thinking-mode 工具循环** | ✅ 完成（v0.1.18 / v0.1.19） |
| **WebView2 OOM 限流（thinking + tool-call 流式 patch）** | ✅ 完成（v0.1.20 / v0.1.21） |
| **CLAUDE.md / FLAUDE.md 工作区记忆自动加载** | ✅ 完成（v0.1.23） |
| **Composer 附件类型扩展（PDF + 文本 + 代码 + Ctrl+V 粘贴）** | ✅ 完成（v0.1.23） |
| **globalMemory 条目化 UI（每条独立开关 + 内联编辑）** | ✅ 完成（v0.1.24） |
| **Plan 模式（agent 先 plan 后 act + 用户三向审批）** | ✅ 完成（v0.1.25） |
| **数据导入（备份 JSON 反向恢复，含 LWW + 跨账号警告）** | ✅ 完成（v0.1.27） |
| **Hooks（pre/post tool use + stop 事件触发的 shell 自动化）** | ✅ 完成（v0.1.28） |
| **后台任务面板（shell_start 进程可见 + 输出查看 + kill/remove）** | ✅ 完成（v0.1.29） |
| **Sub-agents（spawn_subtask 工具 + 子 conversation 隔离 + 总结回传）** | ✅ 完成（v0.1.34，cheap 版无并行） |
| **5 分钟空闲自动登出（关 app/tab 5min+ 重登；开着不动不触发）** | ✅ 完成（v0.1.35） |
| **Skills 市场 + MCP 市场（curated MIT-only，静态烘进 bundle）** | ✅ 完成（v0.1.37） |
| **stdio MCP 一键安装（桌面 spawn 子进程 + JSON-RPC 帧解析）** | ✅ 完成（v0.1.38） |
| **Skills 市场联邦搜索（GitHub-wide，MIT/Apache 严格过滤）** | ✅ 完成（v0.1.39） |
| **MCP 市场联邦搜索（5 源 + 3 层信任徽章 + 🔴 强制勾选）** | ✅ 完成（v0.1.40） |

**Phase 1–10 全部完成。** 当前没有阻塞级 / 体验级待办；下一步进入"打磨 + 平台扩展"阶段。

---

## 下一步候选（2026-04-26 起，按价值/成本估）

无强制顺序——按你想花钱/精力的方向选。

### A. 代码签名 / 消 SmartScreen 警告（小钱大体验）

[RELEASE.md:188](RELEASE.md:188) 列出三条路径：
- **Azure Trusted Signing**（推荐）：$10/月起，需个人验证；Tauri v2 已支持 signtool.exe 链路，CI 加 `AZURE_*` 三个 secret 即可
- **微软开发者账号** $19/年 + HSM/硬件 token，对小团队不划算
- **EV 代码签名证书** $200+/年，免立即生效但贵且年检繁琐

**触发条件**：装机量到了几十、有非技术用户被 SmartScreen 吓退。

### B. macOS / Linux 构建

CI matrix 加 `macos-latest` 和 `ubuntu-latest`，对应产物放进 `latest.json` 的 `darwin-*` / `linux-*` 平台键。**触发条件**：有 mac 用户提需求；目前 ROADMAP 里"放弃移动端"没改，桌面跨平台仍在视野内。

### C. Delta 更新

Tauri v2 updater 支持二进制 diff。当前每次更新下完整 ~30 MB；对流量敏感的用户、或者自动更新频率高了之后做。

### D. Beta 渠道

加 `latest-beta.json` + 应用内开关，让愿意尝鲜的人切到 beta 通道。便于单独验证 thinking-mode / Office 抽取这类容易出 regression 的改动。

### E. Playwright E2E

[ROADMAP.md:104](ROADMAP.md:104) 当时标"暂缓"。覆盖核心：登录 → 新会话 → Code 模式打开工作区 → 写文件 approve → 看到 artifact。Tauri WebView 下 Playwright 配置不平凡，但服务端 + 浏览器版那条链最容易上。

### F. Code mode 性能持续监控

近五个版本（v0.1.18 → v0.1.22）都是性能/兼容 hotfix（thinking 回传、WebView2 OOM、artifact 下载、Office 抽取）。这块可以做成系统化的——

- **建议 1**：加内存/CPU 仪表盘（开发模式下 DevTools 面板看 Chromium 进程实时占用）
- **建议 2**：加 thinking-mode 回归测试——现实任务的 token 序列重放，跑完不允许 OOM 或循环
- **建议 3**：Office 抽取 corpus——准备 5–10 个真实 .xlsx/.docx/.pdf 当回归基线，每次 [office.rs](src-tauri/src/office.rs) 改动都跑一遍

### G. 数据导入路径

[#6 全账号导出](#) 落地了 JSON 包，但**反向的"导入备份"还没做**。`buildAccountBundle()` 已经按 `/sync/pull` 同 schema 写出，喂给 `applyPulledConversations` 等就能跑——但需要：

- SettingsView「数据管理」section 加「从备份导入」按钮
- 冲突策略：是 LWW 覆盖、还是创建副本（`-imported` 后缀）、还是问用户？建议默认 LWW + 显示「合并预览」（X 条新增 / Y 条更新 / Z 条按本地版本保留）
- schema migration：`schemaVersion: 1` 之后的格式破坏性变更要拒绝旧包并提示用户

### H. MCP 客户端打磨

[`src/lib/mcp.ts`](src/lib/mcp.ts) 早就接好了，但 ROADMAP 里没有专门的 MCP 工作项。值得检查的几件事：
- MCP server 列表 UI 是否清晰展示状态（连接中/已连接/失败）
- 工具调用配额——单 MCP 上限多少 / 失败重试策略
- ~~配置 UI 是否能直接装 Anthropic / Smithery 推荐的 MCP（VSCode 风格的"应用市场"）~~ → ✅ v0.1.37 做了 curated MCP 市场（HTTP 一键 + stdio 说明）。剩 v2 候选：动态 registry / OAuth-based MCP 安装。
