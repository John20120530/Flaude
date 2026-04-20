# 发布 Flaude 新版本

把 Flaude 做成一个真正能发给同事用的 Windows 桌面产品所需要的所有运维步骤。
本文档只讲发版侧；服务端部署见 [server/DEPLOY.md](server/DEPLOY.md)。

**总览**：首次发版需要做三件一次性的事（**1. 生成 updater 签名密钥**、**2. 把密钥推到 GitHub 仓库 Secrets**、**3. 填 `tauri.conf.json` 里的公钥**）。之后每次发版只需要 `git tag v0.X.Y && git push origin v0.X.Y`，CI 会自动打包 MSI / NSIS 安装器并发到 GitHub Releases，所有已安装的 Flaude 启动时会检测到更新。

---

## 一、关于代码签名（SmartScreen 警告）

**当前状态：没签名**。Windows 首次运行安装器时会弹 SmartScreen 警告（「Windows 已保护你的电脑」），用户点「更多信息 → 仍要运行」即可继续。几十次下载之后，SmartScreen 会自动攒出 reputation，警告消失。

**我们为什么不签名**：
- 自签证书 **不消除** SmartScreen 警告，还要每次在 CI 里搬证书，徒增维护成本。
- EV 代码签名证书（$200+/年起）消除警告但贵且年检繁琐，不适合自用/朋友圈规模。
- 微软开发者账号（$19/年）拿证书也需要单独申请和 HSM/硬件 token，对 5-10 人团队不划算。
- **Azure Trusted Signing**（2024 年 GA）是目前最接近"便宜"的路径，需要个人验证 + $10/月起。真要消警告再开。

**对用户影响**：首次安装需要多一次点击，此后正常。非技术用户可能被吓到，这一步最好在私聊里预先告知。

真想消警告的操作路径（未来考虑）：
- 走 Azure Trusted Signing：注册个人验证后向 CI 加 `AZURE_` 三个 secret，Tauri 本身已支持 signtool.exe 的链路。
- 买 EV 证书：在 [RELEASE.md](RELEASE.md) 补一节「生产签名」即可。

---

## 二、一次性：准备 updater 签名密钥

**这不是代码签名**——而是给 updater 用的 ed25519 密钥对。作用是：发版者的私钥签 `latest.json` 和安装器，已安装的客户端用嵌在 `tauri.conf.json` 里的公钥验证，防止有人在网络中篡改更新包。

### 1. 生成密钥对

```bash
pnpm tauri signer generate -w flaude-updater.key
```

会交互式让你输入密码（就是保护私钥文件的本地密码，不是别的东西——**记下来，忘了就得重新生成并在每台已安装的机器上重装应用**）。

生成后有两个产物：
- `flaude-updater.key` — 私钥（加密后的），千万别提交到仓库。
- `flaude-updater.key.pub` — 公钥，可以放进源码。

### 2. 把公钥填进 tauri.conf.json

打开 [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)，找到 `plugins.updater.pubkey` 这行：

```json
"pubkey": "REPLACE_WITH_OUTPUT_OF_pnpm_tauri_signer_generate"
```

替换成 `.key.pub` 文件里那一串 base64（类似 `dW50cnVzdGVkIGNvbW1lbnQ6IG...`）。

同时把 `endpoints` 里的占位 URL 换成你的仓库地址：

```json
"endpoints": [
  "https://github.com/你的GH用户名/flaude/releases/latest/download/latest.json"
]
```

### 3. 把私钥推到 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加两个：

| 名字 | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `flaude-updater.key` 文件的**全部内容**（cat 出来整个粘贴） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 上一步输入的那个密码 |

### 4. 提交 tauri.conf.json 的公钥改动

```bash
git add src-tauri/tauri.conf.json
git commit -m "chore: configure updater pubkey + GitHub endpoint"
git push
```

**至此首次配置完成**。把 `flaude-updater.key` 私钥文件**备份到你的密码管理器或离线介质**，日后换机器还发版靠它。`.pub` 文件留不留都行，它已经在仓库里了。

---

## 三、每次发版：一条命令

本地打 tag 并推到远端即可。CI 会接手：

```bash
# 先同步所有要发的改动到 master
git checkout master
git pull

# 在 package.json、src-tauri/Cargo.toml、src-tauri/tauri.conf.json 里把版本号
# 从 0.1.0 升到 0.2.0（三个文件都要改）
# 提交：
git commit -am "chore: bump version to 0.2.0"
git push

# 打 tag 并推：
git tag v0.2.0
git push origin v0.2.0
```

推 tag 后 GitHub Actions 自动触发：

1. 在 Windows runner 上跑 `pnpm tauri:build`
2. 产出 `Flaude_0.2.0_x64-setup.exe`（NSIS）和 `Flaude_0.2.0_x64_en-US.msi`
3. 用 `TAURI_SIGNING_PRIVATE_KEY` 签每个安装器，产出 `.sig` 文件
4. 生成 `latest.json`（updater 清单）
5. 创建 GitHub Release，附件一并上传

**跑完**（~10 分钟）：GitHub Releases 页会出现 `v0.2.0`，包含：
- `Flaude_0.2.0_x64-setup.exe` — 这是同事下载的主文件
- `Flaude_0.2.0_x64-setup.exe.sig` — 更新签名
- `Flaude_0.2.0_x64_en-US.msi` — 给偏好 MSI 的企业用户
- `latest.json` — 所有已安装的客户端会自动读这个

### 版本号约定

SemVer。`0.X.Y` 期间：
- **X**：破坏性变更（数据格式不兼容、要求重新登录等） → 在 Release notes 里明确警告
- **Y**：向后兼容的功能或修复

**三个文件必须保持版本号同步**：`package.json`、`src-tauri/Cargo.toml`（两处：`[package]` 和 lock）、`src-tauri/tauri.conf.json`（`version` 字段）。`pnpm version X.Y.Z` 只更 `package.json`，其他两处仍需手动。

### 手动触发（不创建 Release）

仓库 → **Actions → Release → Run workflow**。可以用来验证 CI 流程改动，不会污染 Releases 列表——产物落在 workflow 的 artifacts 里，有效期 90 天。

---

## 四、同事怎么安装 Flaude

### 首次安装

1. 打开 <https://github.com/你的用户名/flaude/releases/latest>
2. 下载 `Flaude_X.Y.Z_x64-setup.exe`
3. 双击运行。Windows SmartScreen 弹窗提示未识别应用：
   - 点 **更多信息（More info）**
   - 点 **仍要运行（Run anyway）**
4. 安装器默认装到 `%LOCALAPPDATA%\Programs\Flaude\`（当前用户，无需管理员）
5. 开始菜单找 Flaude 启动
6. 首次打开，填你给他们的账号密码（见 [server/DEPLOY.md](server/DEPLOY.md) 第 7 步管理员创建用户）

### 后续升级

**基本不用手动**。只要 Flaude 打开过并且网络能到 GitHub：
- 启动 5 秒后自动 ping `latest.json`
- 发现新版时右下角弹一个卡片，三按钮：**立即更新** / **稍后** / **忽略此版本**
- 点「立即更新」→ 下载 → 安装 → 自动重启到新版

如果用户选了「忽略此版本」，Flaude 会记住（`localStorage`），直到再有更新版本才再提示。

### 手动升级（备用路径）

如果自动更新卡了：去 Releases 页下载新的 `-setup.exe` 装一遍即可，装新版会覆盖旧版并保留用户数据（数据在 `%APPDATA%\com.flaude.app\`）。

---

## 五、常见问题

**CI 里 `pnpm tauri:build` 失败，说密钥没配**
→ `TAURI_SIGNING_PRIVATE_KEY` secret 没设或贴错了。进 Settings → Actions → Secrets 核对。

**自动更新一直不触发**
→ 打开 Flaude 的 DevTools（Ctrl+Shift+I，只在 dev 构建开），看控制台有没有 `[updater] check failed: ...`。常见原因：
   - `tauri.conf.json` 的 `endpoints` URL 错了（typo 的仓库名 / 用户名）
   - `pubkey` 没换成真实公钥，校验失败直接被拒
   - 仓库是 private：`latest.json` URL 需要认证，更新会失败。要么把仓库设 public，要么把分发挪到别的 CDN

**用户说 SmartScreen 挡了装不上**
→ 教他们点「更多信息 → 仍要运行」。这是 Windows 对所有未签名应用的默认行为，不是我们的 bug。

**忘了私钥密码**
→ 没有恢复路径。新生成一对密钥，更新 `tauri.conf.json` 的 pubkey，提交、打 tag、发新版——但已经装了老版本 Flaude 的用户**收不到**这个新版的更新（公钥不匹配），他们需要手动去 Releases 下载一次并重装。这是 ed25519 设计，没有 CA 撤销机制。**所以：备好私钥和密码**。

**CI 里把 `latest.json` 写错了**
→ 进 Release 页直接删掉那个 asset 重新上传即可；或者在本地跑下面命令生成正确的，然后上传替换：

```bash
cd src-tauri
# 签名单个文件：
pnpm tauri signer sign -f path/to/installer.exe
# 手工写 latest.json 同 release workflow 里的结构
```

---

## 六、未来改进项（不在本迭代）

- **macOS / Linux 构建**：CI matrix 加 `macos-latest` 和 `ubuntu-latest`，对应产物放进 `latest.json` 的 `darwin-*` / `linux-*` 平台键。
- **真正的代码签名**：见第一节末尾。
- **Delta 更新**：目前每次更新都下完整安装包（~30 MB）。Tauri v2 updater 支持二进制 diff，未来流量敏感时可启用。
- **Beta 渠道**：加一个 `latest-beta.json` + 应用内开关，让愿意尝鲜的人切到 beta 通道。
