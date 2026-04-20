# Flaude Roadmap

Phase 1（本地骨架）、Phase 2（鉴权 + 配额 + DeepSeek 代理）、Phase 3（双向同步）已经落地。
这份 ROADMAP 把**还没做的事情**按阻塞程度从高到低列出。

编号是"工作项编号"，不是优先级——阻塞级一定先做，同档内顺序可调。

---

## 最近完成（本 session，2026-04-20）

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

## 之前完成

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

## 当前状态速览（2026-04-20）

| 模块 | 状态 |
|---|---|
| 本地骨架（UI + Zustand + 三模式） | ✅ 完成 |
| 鉴权（JWT + Cloudflare Worker） | ✅ 完成 |
| 配额 + 计费（DeepSeek） | ✅ 完成 |
| 双向同步（conversations + messages） | ✅ 完成 |
| 多 provider 注册表（DeepSeek + Qwen + GLM + Kimi） | ✅ 完成 |
| Code 模式真工具（fs_\* + shell_exec + Tauri IPC） | ✅ 完成 |
| Sidebar 同步状态角标 | ✅ 完成 |
| Projects / Artifacts 同步 | ✅ 完成 |
| store / sync / 服务端测试补齐 | ✅ 完成 |
| **Code agent 打磨（持久 PTY + todo_write）** | ✅ 完成（本 session） |
| 网络重试退避 | ✅ 完成（commit `93cb433`） |
| 多设备冲突 UI | ✅ 完成（commit `b50267b`） |
| **全账号导出** | ✅ 完成（本 session） |
| **管理员页刷新** | ✅ 完成（本 session） |
| **部署文档** | ✅ 完成（本 session） |
| **Windows 打包 + updater** | ✅ 完成（本 session，免费方案） |

**Phase 1–9 全部完成。** 进入新增功能阶段。

---

## 新增功能（本 session，2026-04-20 起）

### 10. 网页版 + 独立域名（`flaude.net`）

**动机**：桌面版只能 Windows 跑，限制了首次体验。网页版作为"先试后装"入口：
- 网页上能做的：注册、登录、聊天、Chat 模式全部能力、Code 模式只读/轻度模式、查看 artifacts
- 网页上**不能**做的：读写本地文件、起后台 shell、对 Windows 文件系统操作的任何 agent 工具
- 顶部常驻「下载桌面版」按钮，悬浮提示 `要想使用 Code 的全部功能（读写本地文件等）需要下载客户端`

**架构**：
```
flaude.net         → 301 → app.flaude.net
app.flaude.net     → Cloudflare Pages（前端 dist）
api.flaude.net     → 现有 Cloudflare Worker（flaude-server.john-bw521.workers.dev 的自定义域）
```

**步骤**：
1. 用户在 NameSilo 下单 `flaude.net` + 其它 add-on 全不要
2. NameSilo → nameserver 改成 Cloudflare 的两个 NS
3. Cloudflare 加站 `flaude.net`，Pages 项目绑 `app.flaude.net`，Worker Route 配 `api.flaude.net/*`
4. 前端加 `DownloadDesktopBanner`（浏览器下渲染，悬浮提示链到 GitHub Releases 最新 MSI）
5. Tauri-only 工具在 `!isTauri()` 下灰掉并显示"仅桌面版"提示
6. `pnpm deploy:web` 脚本（`wrangler pages deploy dist`）
7. 发 v0.1.2：桌面版 `VITE_FLAUDE_SERVER_URL` 指向 `https://api.flaude.net`，也在 MSI 里 bake
