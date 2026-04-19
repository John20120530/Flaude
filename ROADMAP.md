# Flaude Roadmap

Phase 1（本地骨架）、Phase 2（鉴权 + 配额 + DeepSeek 代理）、Phase 3（双向同步）已经落地并在 GitHub 上跑通。
这份 ROADMAP 把"还没做"的事情按**阻塞程度**从高到低列出来，作为下一步工作的备忘。

跟进时请保持顺序感：前几项阻塞实际可用性（没做完，客户端能力就打折扣），后几项属于产品打磨。

---

## 阻塞级（不做完，"实际可用"就有明显缺口）

### 1. 服务端 provider 注册表只有 DeepSeek

- **现状**：`server/src/providers.ts` 只有 `PROVIDERS = [DEEPSEEK]`，`ProviderId = 'deepseek'`。
- **客户端**：`src/types/index.ts` 里 `ProviderId` 已经声明 `'deepseek' | 'qwen' | 'zhipu' | 'moonshot' | 'minimax' | 'baichuan'`，UI 选择器也让用户选得到。
- **后果**：用户在 UI 里挑 Qwen / GLM / Kimi 会被服务端 400 拒绝。**等于现在只能用 DeepSeek 一家。**
- **下一步**：
  1. `providers.ts` 扩 `ProviderConfig` 注册表（Qwen DashScope OpenAI-mode、Zhipu BigModel、Moonshot Kimi）。
  2. `env.ts` 增加 `QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`。
  3. `server/.dev.vars.example` 补上占位 key。
  4. 这三家上游都是 OpenAI 兼容，请求/响应 schema 基本不用改。

### 2. Code 模式还没接真正的工具调用

- **现状**：UI 有 Chat / Code / Cowork 三种模式选择，Chat 跑得很顺。Code 模式目前只是"换了个 system prompt 的 Chat"，没有真正的 read-file / write-file / run-command 工具。
- **后果**：产品宣传里"能帮你写代码"目前只是能聊代码，不能真的动项目文件。
- **下一步**：
  1. 确定工具协议（OpenAI function calling 风格 / 自定义 JSON-RPC）。
  2. 客户端实现 `read_file` / `list_dir` / `write_file` / `run_command` 四件套（Tauri 有原生文件系统 API，不用走浏览器 sandbox）。
  3. 服务端把工具 schema 塞进请求，解析工具调用响应，走 iteration 循环。
  4. UI 展示工具调用卡片（读文件展开 diff、运行命令展开输出）。

### 3. Projects 和 Artifacts 还没同步

- **现状**：Phase 3 只同步了 `conversations + messages`。Projects（项目集合）和 Artifacts（会话里生成的代码块/文档快照）仍然只存在 `localStorage` 的 Zustand persist 里。
- **后果**：
  - **Projects**：在机器 A 建的项目，机器 B 登录看不到。
  - **Artifacts**：机器 A 生成的代码 artifact，机器 B 打开同一会话看不到那个附件。
- **下一步**：
  1. D1 加 `projects` 和 `artifacts` 表（复用 `updatedAt` + `deletedAt` LWW 模式）。
  2. `/sync/pull` 和 `/sync/push` 扩展 payload 接收/返回两类新实体。
  3. 客户端 `applyPulledConversations` 旁边加 `applyPulledProjects` / `applyPulledArtifacts`。
  4. 注意 artifact 的 binary 内容策略：是存 D1 文本列，还是 R2 对象存储？——规模小就前者。

---

## 体验级（不做完，产品能用但粗糙）

### 4. 网络失败没有重试/退避

- **现状**：`src/lib/sync.ts` 的 pull/push 失败只是 `setSyncState('error', msg)`，下次触发才重试。
- **后果**：网络抖一下（地铁、电梯），同步角标会变红一直到用户下次手动编辑才恢复。
- **下一步**：失败后指数退避重试（1s / 5s / 30s / 2min 四次），彻底放弃才把状态设成 `error`。`sync.ts` 的注释已经提到"等真变成问题再加"——现在该加了。

### 5. 多设备冲突没有 UI 呈现

- **现状**：服务端 LWW 正确处理，但客户端看不出"我这条被对方覆盖了"。
- **后果**：两台机器同时编辑同一会话标题，后保存的赢，前者的修改悄悄消失。
- **下一步**：pull 时如果发现本地 dirty 的 conv 被服务端版本覆盖（比较 `updatedAt`），在 Toast 提示"该会话已在另一设备修改"。

### 6. 没有 E2E / 自动化测试

- **现状**：仓库里没有 `vitest` / `playwright` / `@testing-library` 配置。
- **后果**：重构（特别是 store / sync.ts 这类核心路径）只能靠手测。迟早踩坑。
- **下一步**：
  1. Vitest 覆盖 `store/useAppStore.ts` 的 actions（dirty 追踪、LWW 合并逻辑）。
  2. Vitest 覆盖 `sync.ts` 的 pull/push/startSync 逻辑（mock flaudeApi）。
  3. 服务端 `wrangler dev` 起本地 D1，用 `vitest` 跑集成测试。
  4. Playwright 之类的 E2E 暂且不上——Tauri 里跑 Playwright 有坑。

### 7. 没有导出 / 备份

- **现状**：用户的对话全部在 D1 里，D1 挂了、账号忘了、服务下线——全丢。
- **下一步**：
  1. 设置页加"导出我的全部数据"按钮，下载一个 JSON 压缩包。
  2. 格式与 `/sync/pull` payload 对齐，方便将来做"导入备份"。

---

## 打磨级（做完会显得"用心"）

### 8. 管理员使用统计页刷新体验

- **现状**：`AdminView` 首次加载后不会自动刷新，需要重新进视图才看到新数据。
- **下一步**：定时（30s）后台刷新，或加个刷新按钮配 `Loader2` spinner。

### 9. 部署文档

- **现状**：`server/README.md` 提了 wrangler 的基本命令，但没有完整"从零部署一套 Flaude 自建服务端"的 walk-through。
- **下一步**：写一份 `server/DEPLOY.md`：Cloudflare 账号准备 → `wrangler secret put` 每个 key → D1 创建 + migration → 客户端 `VITE_FLAUDE_API_BASE` 指向新域名。

### 10. Windows 打包与自动更新

- **现状**：`tauri build` 能出 `.msi`，但没配 signing key，也没挂 `updater`。
- **后果**：分发给朋友得手工 Dropbox 传文件，下次升级他们要自己下。
- **下一步**：研究 Tauri v2 的 updater 插件 + GitHub Releases 作为分发源。对"朋友圈 deployment"来说，免费档就够用。

---

## 不在 roadmap 里（明确放弃的事）

- 移动端（iOS/Android）：Tauri 有实验性 mobile，但成本远高于收益。用户是桌面工作者。
- 语音输入：DeepSeek 等国内模型没统一的 realtime audio API，接一家断一家。
- 图片生成：跟 Flaude 的"代码/文档 copilot"定位不符。

---

## 当前状态速览（2026-04-19）

| 模块 | 状态 |
|---|---|
| 本地骨架（UI + Zustand + 三模式） | ✅ 完成 |
| 鉴权（JWT + Cloudflare Worker） | ✅ 完成 |
| 配额 + 计费（DeepSeek） | ✅ 完成 |
| 双向同步（conversations + messages） | ✅ 完成 |
| 多 provider 注册表 | ⏭️ 下一步（roadmap #1） |
| Code 模式工具调用 | 🔜 roadmap #2 |
| Projects / Artifacts 同步 | 🔜 roadmap #3 |
