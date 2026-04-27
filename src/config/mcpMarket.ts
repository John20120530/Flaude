/**
 * Curated MCP Marketplace manifest.
 *
 * Same baked-in design as skillsMarket — list ships with each Flaude
 * release, contents are hand-picked, dynamic registry integration is
 * deferred to v2.
 *
 * Two install paths:
 *   1. **Hosted HTTP endpoint** — user just clicks install, optionally
 *      pastes an auth token, and we hit `addMCPServer` + `connectMCPServer`.
 *      Works for MCPs published as remote services (Anthropic's hosted
 *      ones, paid SaaS adapters, the user's own teammate-hosted server).
 *   2. **Local stdio** — user has to run a command on their own machine
 *      to start the server. Flaude can't spawn stdio MCPs today (the
 *      MCP client only knows HTTP/SSE), so for these we just show the
 *      install instructions and a "copy command" button — no one-click.
 *      Most stdio MCPs from the official `modelcontextprotocol/servers`
 *      repo fall into this bucket.
 *
 * v1 seeds 6 entries: 2 HTTP (one-click) + 4 stdio (instructions only)
 * to demonstrate both flows. Auth handling for OAuth-based MCPs (e.g.
 * Linear, Notion) is deferred — v1 only handles "no auth" or "static
 * bearer token paste".
 */

export type McpEndpointType = 'http' | 'stdio-instructions';
export type McpAuthType = 'none' | 'bearer';

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
   * copies the command from `installInstructions` and runs it locally.
   */
  endpointUrl?: string;
  /**
   * For stdio MCPs — the npm/pip/cargo command the user runs to start
   * the server. Shown verbatim in the marketplace card with a copy
   * button. Markdown supported.
   */
  installInstructions?: string;
  /** Auth requirement for HTTP MCPs. Stdio entries always set 'none'. */
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
      '本地启一个 stdio MCP，先用 npm 装：\n```\nnpm install -g @modelcontextprotocol/server-filesystem\n```\n然后让它服务某个目录：\n```\nmcp-server-filesystem /path/to/your/dir\n```\n**注意**：Flaude 当前 MCP 客户端只支持 HTTP/SSE，不能直接接 stdio。你需要用 `mcp-proxy` 这类工具把 stdio 包成 HTTP，再把 HTTP URL 加到 Flaude。',
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
      '```\nnpm install -g @modelcontextprotocol/server-github\n```\n启动时设置环境变量：\n```\nGITHUB_PERSONAL_ACCESS_TOKEN=<your token> mcp-server-github\n```\n同样要 `mcp-proxy` 包成 HTTP 才能让 Flaude 接。token 在 https://github.com/settings/tokens 生成。',
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
    installInstructions:
      '```\nnpm install -g @modelcontextprotocol/server-postgres\nmcp-server-postgres "postgresql://user:pwd@host/db"\n```\n生产用强烈建议只给只读账号 + 把 server bind 在 localhost。',
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
      '```\nnpm install -g @modelcontextprotocol/server-slack\nSLACK_BOT_TOKEN=<xoxb-...> mcp-server-slack\n```\nbot token 在你的 Slack App 后台 → OAuth & Permissions 拿。',
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
      '```\nnpm install -g @modelcontextprotocol/server-memory\nmcp-server-memory\n```\n数据存在 `~/.config/modelcontextprotocol/memory.json`。',
    authType: 'none',
    tools: ['add_entity', 'add_relation', 'search', 'get_entity'],
    tags: ['memory', 'stdio'],
  },
];
