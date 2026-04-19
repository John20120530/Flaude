# Flaude Roadmap

Phase 1（本地骨架）、Phase 2（鉴权 + 配额 + DeepSeek 代理）、Phase 3（双向同步）已经落地。
这份 ROADMAP 把**还没做的事情**按阻塞程度从高到低列出。

编号是"工作项编号"，不是优先级——阻塞级一定先做，同档内顺序可调。

---

## 最近完成（本 session）

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

### 2. Code agent 打磨项

- **现状**：工具链跑通了，但离 Claude Code / Cursor agent 的打磨度还有距离。能跑不等于好用。
- **已完成**（本 session）：**2-1 写前确认 UI**、**2-3 迭代循环上限**、**2-4 工具结果折叠**——见"最近完成"。
- **剩余候选**：
  1. ~~**写前确认 UI（diff preview）**~~ ✅ 完成
  2. **持久 PTY**：当前 `shell_exec` 是一次性起子进程收集 stdout，像 `npm run dev` 这种持续输出的命令没法好好用。对应 Claude Code 的 `Bash(run_in_background=true)`。
  3. ~~**迭代循环上限**~~ ✅ 完成（8 → 30）
  4. ~~**工具结果可折叠展示**~~ ✅ 完成
  5. **Agent 自维护 TODO**：加一个 `todo_write` 工具让 agent 自己做任务拆解（Claude Code 的做法）。长任务可见度大幅提升。

### 3. 网络失败没有重试 / 退避

- **现状**：`src/lib/sync.ts` 的 pull/push 失败只是 `setSyncState('error', msg)`，下次触发才重试。
- **后果**：网络抖一下（地铁、电梯、wifi 切换），同步角标会变红，一直到用户下次手动编辑才恢复。
- **下一步**：失败后指数退避重试（1s / 5s / 30s / 2min 四次），彻底放弃才把状态设成 `error`。`sync.ts` 注释已经写了"等真变成问题再加"——就是现在。

### 4. 多设备冲突没有 UI 呈现

- **现状**：服务端 LWW 正确处理（`updatedAt` 新的赢），但客户端看不出"我这条被对方覆盖了"。
- **后果**：两台机器同时编辑同一会话标题，后保存的赢，前者的修改悄悄消失——用户一脸懵。
- **下一步**：pull 时如果发现本地 dirty 的 conv 被服务端版本覆盖（比较 `updatedAt`），Toast 提示"该会话已在另一设备修改"，并把本地版本存到"冲突备份"里 1 小时（让用户有机会恢复）。

### 5. ~~核心路径测试覆盖不足~~ ✅ 完成（见"最近完成"）

三步走全部落地：store 49 个、`lib/sync.ts` 22 个、服务端 25 个集成测试，总计 203 客户端 + 25 服务端。服务端测试跑在 node-env 下用 better-sqlite3 shim D1（放弃 `@cloudflare/vitest-pool-workers` 因为仓库路径 `C:\D\4 研究\...` 含非 ASCII 字符会打挂 workerd 的 fallback service）。顺手修掉一个生产 bug：`admin.use('*', requireAdmin)` 在 Hono sub-app 挂 `/` 时 `*` 会匹配全路径，非 admin 用户拉 /sync/pull 会被 403。Playwright E2E 仍暂缓。

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
| **Projects / Artifacts 同步** | ✅ 完成（本 session，commits `14d9463` / `83ee165` / `b50267b`） |
| store / sync / 服务端测试补齐 | ✅ 完成（本 session，commits `bb1c737` / `93e8751` / `test(server)`） |
| Code agent 打磨 | 🔜 #2（当前优先级最高） |
| 网络重试退避 | 🔜 #3 |
| 多设备冲突 UI | 🔜 #4 |
| 全账号导出 | 🔜 #6 |
| 管理员页刷新 | 🔜 #7 |
| 部署文档 | 🔜 #8 |
| Windows 打包 + updater | 🔜 #9 |
