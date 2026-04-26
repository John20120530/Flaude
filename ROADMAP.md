# Flaude Roadmap

Phase 1–10（本地骨架 / 鉴权 / 配额 / 双向同步 / Code agent / 打磨 / 文档 / 打包 / 网页版 / Design 模式）全部完成。
当前已经发到 **v0.1.22**，无阻塞级或体验级待办。

这份 ROADMAP 现在的结构：
- **最近完成（v0.1.2 → v0.1.22）**：按版本号小步迭代的增量
- **之前完成（早期 session）**：v0.1.0 / v0.1.1 之前的 phase 工作
- **下一步候选**：按价值/成本估的可选方向，无强制顺序
- **不在 roadmap 里**：明确放弃的方向

老的"阻塞级 / 体验级 / 打磨级"分档只剩历史记录用途——里面的项已经全部 ✅。

---

## 最近完成（v0.1.2 → v0.1.23，2026-04-20 至 2026-04-26）

发版节奏从「Phase 完成」转向「按版本号小步迭代」。这一段时间补齐了 #10 网页版、做了一个全新的 Design 模式、把 Code mode 的几个深坑（Office 文件、长 thinking-mode、内存）一一打掉，并按 [Claude vs Flaude 全面对比](#) 的优先级表把最痛的两条（CLAUDE.md 自动加载、附件类型扩展）一起做了。

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

## 当前状态速览（2026-04-26，v0.1.23）

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
- 配置 UI 是否能直接装 Anthropic / Smithery 推荐的 MCP（VSCode 风格的"应用市场"）
