/**
 * Curated Skills Marketplace manifest.
 *
 * v1 design choices:
 *   - **MIT/Apache only.** Anthropic's own `anthropics/skills` repo is
 *     proprietary-licensed (LICENSE.txt explicitly forbids "retain
 *     copies of these materials outside the Services") — we may NOT
 *     install those into Flaude. We aggregate exclusively from
 *     community SKILL.md collections published under permissive
 *     licenses (verified MIT/Apache for every entry below).
 *   - **Static + baked-in.** The list ships with each Flaude release.
 *     Refreshing the catalog requires a new Flaude version. Trade-off
 *     accepted because curating ~10 high-quality entries beats serving
 *     500 mostly-junk auto-scraped ones.
 *   - **Lazy content fetch.** We store a raw GitHub URL per entry; the
 *     SKILL.md body is downloaded on-demand when the user clicks
 *     "preview" or "install". Keeps the bundle small.
 *   - **Attribution per entry.** Publisher / source URL / license shown
 *     in every card; the installed Skill carries an attribution footer
 *     so when the user later edits it they remember where it came from.
 *
 * To add a new entry: append a SkillsMarketEntry below.
 *   1. Verify the upstream repo's license is MIT/Apache (or other
 *      OSI-approved permissive). Anthropic's "Proprietary" license is
 *      DISQUALIFYING — do not include those.
 *   2. Verify SKILL.md exists at the rawUrl path with valid frontmatter
 *      (`name`, `description` minimum).
 *   3. Keep `id` stable across releases (used to detect "already
 *      installed" state in the UI).
 */

import type { WorkMode } from '@/types';

export interface SkillsMarketEntry {
  /**
   * Stable id — `<publisher-slug>/<skill-slug>`. Used as the foreign
   * key on installed Skills so we can detect upgrades / "already
   * installed" state without hashing content.
   */
  id: string;
  /** Display name shown in the marketplace card. */
  title: string;
  /** Short blurb, 1-2 sentences max. Hand-curated for clarity. */
  description: string;
  /** Publisher / author display name (GitHub username or org). */
  publisher: string;
  /** Where to find more about the publisher (homepage / GitHub profile). */
  publisherUrl?: string;
  /** Human-readable source path, e.g. "scdenney/open-science-skills · GitHub". */
  source: string;
  /** Browser-viewable URL to the skill's source page. */
  sourceUrl: string;
  /** raw.githubusercontent.com URL for the SKILL.md content. */
  rawUrl: string;
  /** SPDX-style license string. ALWAYS verified before adding. */
  license: string;
  /** Which Flaude modes this skill is relevant in. Empty = all modes. */
  modes: WorkMode[];
  /** Free-form tags shown as chips in the UI. */
  tags?: string[];
}

/**
 * v1 seed: 8 entries from 5 different community publishers, all MIT.
 * Spread across domains: code review (Java), workflow (handoff), repo
 * ops (GitHub audits + community), research (hypothesis building),
 * ProdOps (engineering + design review).
 *
 * NB: Anthropic-published skills are deliberately absent — their LICENSE
 * forbids redistribution outside Anthropic Services. Users who want
 * those should view them on GitHub and write their own equivalents.
 */
export const SKILLS_MARKET: SkillsMarketEntry[] = [
  {
    id: 'nxd1184/java-clean-code',
    title: 'Java Clean Code',
    description:
      '写 / 审 / 重构 Java 代码（Spring Boot / Quarkus / 纯 Java）时给出 idiomatic 反馈：SOLID、DRY、SRP、code-smell、TDD setup。',
    publisher: '@nxd1184',
    publisherUrl: 'https://github.com/nxd1184',
    source: 'nxd1184/java-clean-code-skill · GitHub',
    sourceUrl: 'https://github.com/nxd1184/java-clean-code-skill',
    rawUrl:
      'https://raw.githubusercontent.com/nxd1184/java-clean-code-skill/HEAD/.claude/skills/java-clean-code/SKILL.md',
    license: 'MIT',
    modes: ['code'],
    tags: ['java', 'code-review'],
  },
  {
    id: 'thenguyenvn90/session-handoff',
    title: 'Session Handoff',
    description:
      '在 `/clear` 之前生成结构化 session 总结：决策记录、改动、文件清单、运行态、验证步骤、未决问题——让接班的 agent 能直接读懂上下文。',
    publisher: '@thenguyenvn90',
    publisherUrl: 'https://github.com/thenguyenvn90',
    source: 'thenguyenvn90/claude-session-handoff · GitHub',
    sourceUrl: 'https://github.com/thenguyenvn90/claude-session-handoff',
    rawUrl:
      'https://raw.githubusercontent.com/thenguyenvn90/claude-session-handoff/HEAD/SKILL.md',
    license: 'MIT',
    modes: ['code', 'chat'],
    tags: ['workflow', 'memory'],
  },
  {
    id: 'avalonreset/github-audit',
    title: 'GitHub Repository Audit',
    description:
      '从 README、metadata、合规、社区健康、发版维护、SEO 六维度给 GitHub 仓库打 0-100 分。支持单仓审计、远端审计、整个 portfolio 批量审计。',
    publisher: '@avalonreset',
    publisherUrl: 'https://github.com/avalonreset',
    source: 'avalonreset/claude-github · GitHub',
    sourceUrl: 'https://github.com/avalonreset/claude-github',
    rawUrl:
      'https://raw.githubusercontent.com/avalonreset/claude-github/HEAD/skills/github-audit/SKILL.md',
    license: 'MIT',
    modes: ['code', 'chat'],
    tags: ['github', 'audit'],
  },
  {
    id: 'avalonreset/github-community',
    title: 'GitHub Community Health',
    description:
      'GitHub 仓库的社区健康文件（CONTRIBUTING / CODE_OF_CONDUCT / issue templates / PR templates）一键检查 + 生成。',
    publisher: '@avalonreset',
    publisherUrl: 'https://github.com/avalonreset',
    source: 'avalonreset/claude-github · GitHub',
    sourceUrl: 'https://github.com/avalonreset/claude-github',
    rawUrl:
      'https://raw.githubusercontent.com/avalonreset/claude-github/HEAD/skills/github-community/SKILL.md',
    license: 'MIT',
    modes: ['code', 'chat'],
    tags: ['github', 'community'],
  },
  {
    id: 'scdenney/hypothesis-building',
    title: 'Causal Hypothesis Architect',
    description:
      '科研写作辅助：把理论概念转成可证伪的、基于 counterfactual 的假设；指定 estimand + SESOI + 三层级（概念 / 操作化 / 统计）。适合 pre-analysis plan。',
    publisher: '@scdenney',
    publisherUrl: 'https://github.com/scdenney',
    source: 'scdenney/open-science-skills · GitHub',
    sourceUrl: 'https://github.com/scdenney/open-science-skills',
    rawUrl:
      'https://raw.githubusercontent.com/scdenney/open-science-skills/HEAD/plugin/skills/hypothesis-building/SKILL.md',
    license: 'MIT',
    modes: ['chat'],
    tags: ['research', 'science'],
  },
  {
    id: 'scdenney/conjoint-design',
    title: 'Conjoint Experiment Design',
    description:
      'Conjoint 实验（社会科学常用的偏好测量法）的设计 / 清洗 / 诊断 helper：属性平衡、属性间正交、随机化检验等。',
    publisher: '@scdenney',
    publisherUrl: 'https://github.com/scdenney',
    source: 'scdenney/open-science-skills · GitHub',
    sourceUrl: 'https://github.com/scdenney/open-science-skills',
    rawUrl:
      'https://raw.githubusercontent.com/scdenney/open-science-skills/HEAD/plugin/skills/conjoint-design/SKILL.md',
    license: 'MIT',
    modes: ['chat'],
    tags: ['research', 'survey'],
  },
  {
    id: 'ronaldolaj/prodops-engineering',
    title: 'ProdOps Engineering',
    description:
      'TDD（Red-Green-Refactor）、结构化 code review、系统化 debugging（假设驱动）、生产事故响应（SEV1-4 triage）。注：description 是葡萄牙语。',
    publisher: '@ronaldolaj',
    publisherUrl: 'https://github.com/ronaldolaj',
    source: 'ronaldolaj/prodops-kit · GitHub',
    sourceUrl: 'https://github.com/ronaldolaj/prodops-kit',
    rawUrl:
      'https://raw.githubusercontent.com/ronaldolaj/prodops-kit/HEAD/.claude/skills/prodops-engineering/SKILL.md',
    license: 'MIT',
    modes: ['code'],
    tags: ['engineering', 'tdd'],
  },
  {
    id: 'ronaldolaj/prodops-design-review',
    title: 'ProdOps Design Review',
    description:
      '产品 / 系统设计 review 的结构化模板：明确假设、衡量风险、列 trade-offs、生成具体的反馈。description 葡萄牙语。',
    publisher: '@ronaldolaj',
    publisherUrl: 'https://github.com/ronaldolaj',
    source: 'ronaldolaj/prodops-kit · GitHub',
    sourceUrl: 'https://github.com/ronaldolaj/prodops-kit',
    rawUrl:
      'https://raw.githubusercontent.com/ronaldolaj/prodops-kit/HEAD/.claude/skills/prodops-design-review/SKILL.md',
    license: 'MIT',
    modes: ['code', 'chat'],
    tags: ['design', 'review'],
  },
];
