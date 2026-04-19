# Flaude Roadmap

Phase 1（本地骨架）、Phase 2（鉴权 + 配额 + DeepSeek 代理）、Phase 3（双向同步）已经落地。
这份 ROADMAP 把**还没做的事情**按阻塞程度从高到低列出。

编号是"工作项编号"，不是优先级——阻塞级一定先做，同档内顺序可调。

---

## 最近完成（本 session）

- **多 provider 注册表**：服务端 `providers.ts` 从只支持 DeepSeek 扩到 DeepSeek + Qwen + Zhipu GLM + Moonshot Kimi。commit `ab0651a`。
- **Sidebar 同步状态角标**：v0.1 版本号旁边显示 pulling/pushing spinner，失败显示 CloudOff 图标。commit `dea6c9a`。
- **startSync 双触发修复**：React.StrictMode 下的 useEffect 双调用用 in-flight promise 合并。commit `ba1b9dc`（含在 initial commit 里）。

**重要修正**：老版本 ROADMAP 里把"Code 模式真工具"列为阻塞级待办是**错的**——`src/lib/desktopTools.ts` 已经通过 Tauri 原生 API 接了 `fs_list_dir` / `fs_read_file` / `fs_stat` / `fs_write_file` / `shell_exec` 五件套，带权限门，Code agent 能真读写文件、跑 shell 命令。那项打磨性的工作移到下面 **#2**。

---

## 阻塞级（不做完，"实际可用"就有明显缺口）

### 1. Projects 和 Artifacts 还没同步

- **现状**：Phase 3 只同步了 `conversations + messages`。Projects（项目集合，给对话绑 system prompt + 知识源）和 Artifacts（会话里生成的独立代码/文档块）仍然只存在 `localStorage` 里的 Zustand persist。
- **证据**：`server/schema.sql` 的 messages 表有注释 `project_id TEXT, -- loose ref; projects aren't synced yet`；`server/src/sync.ts` 里没有 projects / artifacts 任何提及。
- **后果**：
  - **Projects**：在机器 A 建的项目，机器 B 登录看不到。
  - **Artifacts**：机器 A 让模型生成的 HTML/React artifact，机器 B 打开同一会话看不到那个附件——但对话内容都同步了，出现"模型上一句说'见下方'，但下方什么都没有"的诡异状态。
- **下一步**：
  1. D1 加 `projects` 和 `artifacts` 表（复用 `updatedAt` + `deletedAt` 的 LWW 模式）。
  2. `/sync/pull` 和 `/sync/push` 扩展 payload 接收/返回两类新实体。
  3. 客户端 `applyPulledConversations` 旁边加 `applyPulledProjects` / `applyPulledArtifacts`，store 里加对应的 dirty 追踪。
  4. 注意 artifact 的 binary 存储策略：规模小就 D1 TEXT 列，未来超过几 MB 再迁 R2。

---

## 体验级（不做完，产品能用但粗糙）

### 2. Code agent 打磨项

- **现状**：工具链跑通了，但离 Claude Code / Cursor agent 的打磨度还有距离。能跑不等于好用。
- **下一步候选**（按性价比排）：
  1. **写前确认 UI（diff preview）**：`fs_write_file` 前弹窗给用户看一个 diff，点"应用"才真写。现在是 `allowFileWrites` 开关一打开所有写入直接通过，没有 per-call 审查。**最重要的一项**——涉及实际项目文件安全。
  2. **持久 PTY**：当前 `shell_exec` 是一次性起子进程收集 stdout，像 `npm run dev` 这种持续输出的命令没法好好用。对应 Claude Code 的 `Bash(run_in_background=true)`。
  3. **迭代循环上限**：核一下 `useStreamedChat` 现在允许模型最多连续调几次工具。Claude Code 默认几十次；限得太紧 agent 行为会半途而废。
  4. **工具结果可折叠展示**：长 `fs_read_file` / `shell_exec` 输出在对话里默认折叠，点开看全文，不然会议滚条被工具输出淹没。
  5. **Agent 自维护 TODO**：加一个 `todo_write` 工具让 agent 自己做任务拆解（Claude Code 的做法）。长任务可见度大幅提升。

### 3. 网络失败没有重试 / 退避

- **现状**：`src/lib/sync.ts` 的 pull/push 失败只是 `setSyncState('error', msg)`，下次触发才重试。
- **后果**：网络抖一下（地铁、电梯、wifi 切换），同步角标会变红，一直到用户下次手动编辑才恢复。
- **下一步**：失败后指数退避重试（1s / 5s / 30s / 2min 四次），彻底放弃才把状态设成 `error`。`sync.ts` 注释已经写了"等真变成问题再加"——就是现在。

### 4. 多设备冲突没有 UI 呈现

- **现状**：服务端 LWW 正确处理（`updatedAt` 新的赢），但客户端看不出"我这条被对方覆盖了"。
- **后果**：两台机器同时编辑同一会话标题，后保存的赢，前者的修改悄悄消失——用户一脸懵。
- **下一步**：pull 时如果发现本地 dirty 的 conv 被服务端版本覆盖（比较 `updatedAt`），Toast 提示"该会话已在另一设备修改"，并把本地版本存到"冲突备份"里 1 小时（让用户有机会恢复）。

### 5. 核心路径测试覆盖不足

- **现状**：`src/lib/` 已有 8 个 Vitest 单元测试（artifacts / tokenEstimate / systemPrompt / conversationSearch / conversationSummary / conversationMarkdown / slashCommands / builtinSkills），**都是纯函数**。
- **缺口**：
  - `src/store/useAppStore.ts` 完全没测试（dirty 追踪、LWW 合并、会话 CRUD 都是手测）。
  - `src/lib/sync.ts` 没测试（pull/push/startSync 的 in-flight 合并、cursor 推进逻辑）。
  - 服务端 `server/src/` 目录下零测试。
- **后果**：重构核心同步路径只能靠手测，迟早踩坑。回归 bug 不易第一时间发现。
- **下一步**：
  1. Vitest 覆盖 store actions（mock persist，跑 markDirty / apply / delete 流程）。
  2. Vitest 覆盖 sync.ts（mock `flaudeApi`，验证 startSync 只触发一次 pull+push、push 成功后 cursor 推进）。
  3. 服务端用 `wrangler dev` 起本地 D1，vitest 跑 `/sync/push` + `/sync/pull` + JWT 中间件的集成测试。
  4. Playwright E2E 暂缓——Tauri 里跑有坑。

### 6. 全账号数据导出

- **现状**：Sidebar 里有"导出 Markdown"按钮，但只能导**单个会话**。没有"把我的全部数据打包带走"的入口。
- **后果**：D1 挂了、账号忘了、服务下线——用户全盘丢失；即使信任服务也无法"换机器前先备份一份"。
- **下一步**：
  1. 设置页加"导出全部数据"按钮，下载一个 JSON 压缩包（包括 conversations、projects、artifacts、skills、settings）。
  2. 格式与 `/sync/pull` 的 payload 对齐，方便将来做"导入备份"。

---

## 打磨级（做完会显得"用心"，不做也不影响可用）

### 7. 管理员使用统计页刷新体验

- **现状**：`AdminView` 首次加载后不会自动刷新，需要重新进视图才看到新数据。
- **下一步**：定时（30s）后台刷新，或加个刷新按钮配 `Loader2` spinner（复用 Sidebar 的 spinner 模式）。

### 8. 部署文档

- **现状**：`server/README.md` 提了 wrangler 的基本命令，但没有完整的"从零部署一套 Flaude 自建服务端"walk-through。
- **下一步**：写 `server/DEPLOY.md`：Cloudflare 账号准备 → 每个 provider key `wrangler secret put` → D1 `create` + `schema.sql` + migration → 客户端 `VITE_FLAUDE_API_BASE` 指向新域名 → 测试同步能打通。

### 9. Windows 打包与自动更新

- **现状**：`tauri build` 能出 `.msi`，但没配 signing key（装起来 SmartScreen 会警告），也没挂 updater。
- **后果**：分发给朋友得手工 Dropbox 传文件，下次升级他们要自己下；SmartScreen 警告对非技术用户是劝退的。
- **下一步**：
  1. 申请或自签证书解决 SmartScreen 警告（免费方案：微软开发者账号 $19/年）。
  2. 配 Tauri v2 updater 插件，分发源挂 GitHub Releases（免费档够"朋友圈 deployment"用）。
  3. CI 打 Release 的 `.msi`，`tauri.conf.json` 里配 updater 公钥。

---

## 不在 roadmap 里（明确放弃的事）

- **移动端（iOS/Android）**：Tauri v2 有实验性 mobile，但成本远高于收益。Flaude 定位是桌面工作者。
- **语音输入**：DeepSeek 等国内模型没有统一的 realtime audio API，接一家断一家，维护负担不划算。
- **图片生成**：跟 Flaude 的"代码/文档 copilot"定位不符。真想要就让 agent 调 MCP 工具对接外部服务。

---

## 当前状态速览（2026-04-19）

| 模块 | 状态 |
|---|---|
| 本地骨架（UI + Zustand + 三模式） | ✅ 完成 |
| 鉴权（JWT + Cloudflare Worker） | ✅ 完成 |
| 配额 + 计费（DeepSeek） | ✅ 完成 |
| 双向同步（conversations + messages） | ✅ 完成 |
| 多 provider 注册表（DeepSeek + Qwen + GLM + Kimi） | ✅ 完成 |
| Code 模式真工具（fs_\* + shell_exec + Tauri IPC） | ✅ 完成 |
| Sidebar 同步状态角标 | ✅ 完成 |
| **Projects / Artifacts 同步** | ⏭️ 下一步（#1 阻塞级） |
| Code agent 打磨 | 🔜 #2 |
| 网络重试退避 | 🔜 #3 |
| 多设备冲突 UI | 🔜 #4 |
| store / sync / 服务端测试补齐 | 🔜 #5 |
| 全账号导出 | 🔜 #6 |
| 管理员页刷新 | 🔜 #7 |
| 部署文档 | 🔜 #8 |
| Windows 打包 + updater | 🔜 #9 |
