/**
 * Curated MCP Marketplace manifest.
 *
 * Same baked-in design as skillsMarket — list ships with each Flaude
 * release, contents are hand-picked, dynamic registry integration is
 * deferred to v2.
 *
 * Three install paths:
 *   1. **Hosted HTTP endpoint** (`endpointType: 'http'`) — user clicks
 *      install, optionally pastes an auth token, and we hit
 *      `addMCPServer` + `connectMCPServer`. Works for MCPs published as
 *      remote services. Web + Tauri.
 *   2. **Stdio one-click on Tauri** (`endpointType: 'stdio-instructions'`
 *      WITH `stdioCommand` set) — Flaude spawns the npm/pip/etc command
 *      itself via the `mcp_stdio_*` IPC commands (see
 *      `src-tauri/src/mcp_stdio.rs`), pipes JSON-RPC over stdin/stdout,
 *      and registers tools just like HTTP. Desktop only — the web build
 *      falls through to path #3.
 *   3. **Stdio instructions only** (no `stdioCommand`) — show install
 *      command + copy button. User runs it themselves and either uses
 *      `mcp-proxy` to expose HTTP, or stays in path #2 territory. This
 *      is what the web build sees for every stdio entry.
 *
 * v1.1 update: 5 stdio entries now ship `stdioCommand` so the desktop app
 * can install them with one click. Web visitors still get instructions.
 */

export type McpEndpointType = 'http' | 'stdio-instructions';
export type McpAuthType = 'none' | 'bearer';

/**
 * Structured spawn config for stdio MCPs that support one-click install on
 * Tauri. When present alongside `endpointType: 'stdio-instructions'`, the
 * desktop app skips the "copy command and run it yourself" flow and
 * directly spawns the child process via `mcp_stdio_spawn`.
 *
 * Designed to serialize 1:1 into `MCPStdioConfig` in the store. Env var
 * placeholders (e.g. `${GITHUB_PERSONAL_ACCESS_TOKEN}`) are NOT
 * substituted — the install UI prompts the user for token-style auth and
 * sets the real values into `env` before spawn.
 */
export interface McpStdioCommand {
  /** Executable. Usually `npx` for Node MCPs; could be `python`, `uvx`, etc. */
  command: string;
  /** CLI args (e.g. ["-y", "@modelcontextprotocol/server-memory"]). */
  args: string[];
  /**
   * Environment variable names the server requires. Listed here so the
   * install UI knows to ask the user for them. Values come in via the
   * normal token-paste field and get merged into the spawn `env`.
   *
   * Example: `["GITHUB_PERSONAL_ACCESS_TOKEN"]` for the github MCP.
   */
  envKeys?: string[];
}

export interface McpMarketEntry {
  /** Stable id, `<publisher-slug>/<server-slug>`. Used to detect "installed" state. */
  id: string;
  /** Display name. */
  title: string;
  /** Short blurb, 1-2 sentences. */
  description: string;
  /** Publisher / org name. */
  publisher: string;
  publisherUrl?: string;
  /** Human-readable source path. */
  source: string;
  /** Browser-viewable URL to the server's home / README. */
  sourceUrl: string;
  /** SPDX license string. */
  license: string;
  endpointType: McpEndpointType;
  /**
   * For `endpointType: 'http'` — the MCP HTTP URL. Required.
   * For `endpointType: 'stdio-instructions'` — leave blank; the user
   * copies the command from `installInstructions` and runs it locally,
   * OR (on Tauri) we spawn `stdioCommand` directly.
   */
  endpointUrl?: string;
  /**
   * For stdio MCPs — the npm/pip/cargo command the user runs to start
   * the server. Shown verbatim in the marketplace card with a copy
   * button. Markdown supported. Used as the FALLBACK for web visitors
   * even when `stdioCommand` is also set.
   */
  installInstructions?: string;
  /**
   * Optional structured spawn config. When present + running on Tauri,
   * the install button spawns the child directly via `mcp_stdio_spawn`
   * instead of just copying the command for the user to run.
   */
  stdioCommand?: McpStdioCommand;
  /** Auth requirement. For stdio with `envKeys`, the token field becomes the env value paste. */
  authType: McpAuthType;
  /** Where to get a bearer token (e.g. "https://github.com/settings/tokens"). */
  authHelpUrl?: string;
  /** Tool names the server is known to expose. Optional, just for the card preview. */
  tools?: string[];
  tags?: string[];
}

export const MCP_MARKET: McpMarketEntry[] = [
  // ----- HTTP / one-click installable ------------------------------------
  {
    id: 'flaude/mcp-echo-demo',
    title: 'Echo demo (Flaude hosted)',
    description:
      '一个最小的演示用 MCP server，只暴露一个 `echo` 工具回显输入字符串。装上立即能用，方便确认 MCP 链路是通的。',
    publisher: 'Flaude',
    publisherUrl: 'https://github.com/John20120530/Flaude',
    source: 'Flaude 内置示例',
    sourceUrl: 'https://github.com/John20120530/Flaude',
    license: 'MIT',
    endpointType: 'http',
    endpointUrl: 'https://api.flaude.net/mcp/echo',
    authType: 'none',
    tools: ['echo'],
    tags: ['demo', 'official'],
  },

  // ----- Stdio / instructions-only ---------------------------------------
  {
    id: 'modelcontextprotocol/filesystem',
    title: 'Filesystem',
    description:
      '把本地某个目录当作 MCP 资源源暴露：列文件、读文件、写文件、watch。常用作 Claude Desktop 的本地编辑助手。',
    publisher: 'modelcontextprotocol',
    publisherUrl: 'https://github.com/modelcontextprotocol',
    source: 'modelcontextprotocol/servers · GitHub',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    license: 'MIT',
    endpointType: 'stdio-instructions',
    installInstructions:
      '桌面版可以一键安装（自动 `npx -y @modelcontextprotocol/server-filesystem` 并把 stdio 接进 Flaude）。需要 Node.js 装在系统 PATH 里。\n\n网页版只能看说明，需要本地跑：\n```\nnpx -y @modelcontextprotocol/server-filesystem /path/to/your/dir\n```\n再用 `mcp-proxy` 包成 HTTP 才能让网页 Flaude 接。',
    stdioCommand: {
      command: 'npx',
      // The trailing dot tells the server to expose the cwd of npx, which
      // doesn't help us — but the server requires *some* directory arg.
      // We point at the user's home as a safe default; advanced users can
      // edit `stdioConfig.args` in Settings to pin a specific path.
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    },
    authType: 'none',
    tools: ['list', 'read', 'write', 'watch'],
    tags: ['filesystem', 'stdio'],
  },
  {
    id: 'modelcontextprotocol/github',
    title: 'GitHub',
    description:
      '通过 MCP 操作 GitHub：列仓库、读 issue / PR / commit、创建 issue、push 到分支等。',
    publisher: 'modelcontextprotocol',
    publisherUrl: 'https://github.com/modelcontextprotocol',
    source: 'modelcontextprotocol/servers · GitHub',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    license: 'MIT',
    endpointType: 'stdio-instructions',
    installInstructions:
      '桌面版可以一键安装。粘贴 PAT（在 https://github.com/settings/tokens 生成，勾选 `repo` + `read:org`）后 Flaude 自动 `npx -y @modelcontextprotocol/server-github`。\n\n网页版需要本地跑：\n```\nGITHUB_PERSONAL_ACCESS_TOKEN=<token> npx -y @modelcontextprotocol/server-github\n```',
    stdioCommand: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    },
    authType: 'bearer',
    authHelpUrl: 'https://github.com/settings/tokens',
    tools: ['list_repos', 'get_issue', 'create_issue', 'list_pulls', 'merge_pull'],
    tags: ['github', 'stdio'],
  },
  {
    id: 'modelcontextprotocol/postgres',
    title: 'Postgres',
    description: '让 MCP 客户端按结构化方式查询 / 写入 Postgres 数据库（SELECT/INSERT/UPDATE/DDL）。',
    publisher: 'modelcontextprotocol',
    publisherUrl: 'https://github.com/modelcontextprotocol',
    source: 'modelcontextprotocol/servers · GitHub',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    license: 'MIT',
    endpointType: 'stdio-instructions',
    // No stdioCommand — we don't bake the connection string into the
    // manifest because every user has a different DB. UI guides them to
    // add manually via the MCP servers section after editing args.
    installInstructions:
      '桌面版需要一个连接串 ARG，一键装暂不支持（每人 DB 不同）。手动跑：\n```\nnpx -y @modelcontextprotocol/server-postgres "postgresql://user:pwd@host/db"\n```\n生产用强烈建议只给只读账号 + 把 server bind 在 localhost。',
    authType: 'none',
    tools: ['query', 'list_tables', 'describe_table'],
    tags: ['database', 'stdio'],
  },
  {
    id: 'modelcontextprotocol/slack',
    title: 'Slack',
    description: '读 / 发 Slack 消息、列频道、查用户。需要 Slack workspace 的 bot token。',
    publisher: 'modelcontextprotocol',
    publisherUrl: 'https://github.com/modelcontextprotocol',
    source: 'modelcontextprotocol/servers · GitHub',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    license: 'MIT',
    endpointType: 'stdio-instructions',
    installInstructions:
      '桌面版可以一键安装。粘贴 Slack Bot Token（`xoxb-...`，在你的 Slack App 后台 → OAuth & Permissions 拿）后 Flaude 自动 `npx -y @modelcontextprotocol/server-slack`。\n\n网页版需要本地跑：\n```\nSLACK_BOT_TOKEN=<xoxb-...> npx -y @modelcontextprotocol/server-slack\n```',
    stdioCommand: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      envKeys: ['SLACK_BOT_TOKEN'],
    },
    authType: 'bearer',
    authHelpUrl: 'https://api.slack.com/apps',
    tools: ['list_channels', 'post_message', 'list_users', 'get_thread'],
    tags: ['communication', 'stdio'],
  },
  {
    id: 'modelcontextprotocol/memory',
    title: 'Memory (knowledge graph)',
    description: '把对话里的关键事实存到一个本地知识图谱里，跨会话查询 / 关联。',
    publisher: 'modelcontextprotocol',
    publisherUrl: 'https://github.com/modelcontextprotocol',
    source: 'modelcontextprotocol/servers · GitHub',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    license: 'MIT',
    endpointType: 'stdio-instructions',
    installInstructions:
      '桌面版可以一键安装（自动 `npx -y @modelcontextprotocol/server-memory`）。数据存在 `~/.config/modelcontextprotocol/memory.json`。\n\n网页版需要本地跑：\n```\nnpx -y @modelcontextprotocol/server-memory\n```',
    stdioCommand: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    authType: 'none',
    tools: ['add_entity', 'add_relation', 'search', 'get_entity'],
    tags: ['memory', 'stdio'],
  },
];
