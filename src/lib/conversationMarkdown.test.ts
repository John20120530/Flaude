import { describe, it, expect } from 'vitest';
import type { Conversation, Message, ToolCall } from '@/types';
import type { Artifact } from '@/lib/artifacts';
import {
  buildConversationMarkdown,
  sanitizeFilename,
} from './conversationMarkdown';

const msg = (over: Partial<Message> = {}): Message => ({
  id: over.id ?? 'm' + Math.random().toString(36).slice(2, 7),
  role: over.role ?? 'user',
  content: over.content ?? '',
  createdAt: over.createdAt ?? 1_700_000_000_000,
  reasoning: over.reasoning,
  toolCalls: over.toolCalls,
  attachments: over.attachments,
  modelId: over.modelId,
  tokensIn: over.tokensIn,
  tokensOut: over.tokensOut,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: over.id ?? 'c1',
  title: over.title ?? '测试对话',
  mode: over.mode ?? 'chat',
  modelId: over.modelId ?? 'deepseek-v3',
  messages: over.messages ?? [],
  createdAt: over.createdAt ?? 1_700_000_000_000,
  updatedAt: over.updatedAt ?? 1_700_000_000_000,
  summary: over.summary,
  summaryMessageCount: over.summaryMessageCount,
  summarizedAt: over.summarizedAt,
  projectId: over.projectId,
});

// Fixed clock so tests can pin the footer timestamp without fighting Date.
const FIXED_NOW = () => 1_700_003_600_000;

describe('buildConversationMarkdown', () => {
  it('renders the title as an H1', () => {
    const md = buildConversationMarkdown(
      conv({ title: '如何学 Rust' }),
      { now: FIXED_NOW }
    );
    expect(md).toMatch(/^# 如何学 Rust\n/);
  });

  it('falls back to placeholder when title is empty', () => {
    const md = buildConversationMarkdown(conv({ title: '' }), { now: FIXED_NOW });
    expect(md).toContain('# 未命名对话');
  });

  it('includes metadata table with mode, model, timestamps, and count', () => {
    const md = buildConversationMarkdown(
      conv({
        mode: 'code',
        modelId: 'qwen-max',
        messages: [msg(), msg()],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('| 模式 | code |');
    expect(md).toContain('| 模型 | qwen-max |');
    expect(md).toContain('| 消息数 | 2 |');
    expect(md).toMatch(/\| 创建 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \|/);
  });

  it('includes project name when provided', () => {
    const md = buildConversationMarkdown(conv(), {
      projectName: '个人网站',
      now: FIXED_NOW,
    });
    expect(md).toContain('| 项目 | 个人网站 |');
  });

  it('omits project row when not provided', () => {
    const md = buildConversationMarkdown(conv(), { now: FIXED_NOW });
    expect(md).not.toContain('| 项目 |');
  });

  it('labels messages with Chinese role headings', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'user', content: 'hi' }),
          msg({ role: 'assistant', content: 'hello' }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('### 👤 用户');
    expect(md).toContain('### 🤖 Flaude');
  });

  it('preserves message content verbatim', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [msg({ role: 'user', content: 'I prefer pnpm over npm' })],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('I prefer pnpm over npm');
  });

  it('renders reasoning inside a collapsible <details> block', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({
            role: 'assistant',
            content: 'answer',
            reasoning: '先检查输入，再分情况处理。',
          }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('<details>');
    expect(md).toContain('推理过程');
    expect(md).toContain('先检查输入，再分情况处理。');
    expect(md).toContain('</details>');
  });

  it('drops reasoning when includeReasoning is false', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'assistant', content: 'a', reasoning: 'thinking' }),
        ],
      }),
      { includeReasoning: false, now: FIXED_NOW }
    );
    expect(md).not.toContain('推理过程');
    expect(md).not.toContain('thinking');
  });

  it('includes the M6 summary block when present', () => {
    const md = buildConversationMarkdown(
      conv({
        summary: '## 用户偏好\n- 喜欢 pnpm',
        summaryMessageCount: 8,
        summarizedAt: 1_700_001_000_000,
        messages: [msg()],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('## 📚 已归档摘要');
    expect(md).toContain('最早的 **8** 条消息');
    expect(md).toContain('喜欢 pnpm');
  });

  it('does not emit the summary section when summary is empty', () => {
    const md = buildConversationMarkdown(
      conv({ summary: '', summaryMessageCount: 0, messages: [msg()] }),
      { now: FIXED_NOW }
    );
    expect(md).not.toContain('📚 已归档摘要');
  });

  it('inlines artifacts as fenced code blocks', () => {
    const artifact: Artifact = {
      id: 'login-form',
      type: 'html',
      title: '登录表单',
      content: '<form>hello</form>',
      createdAt: 1_700_000_000_000,
    };
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({
            role: 'assistant',
            content: '这是登录表单：\n\n[[ARTIFACT:login-form]]\n\n请查看。',
          }),
        ],
      }),
      { artifacts: { 'login-form': artifact }, now: FIXED_NOW }
    );
    expect(md).toContain('📦 Artifact: 登录表单');
    expect(md).toContain('```html');
    expect(md).toContain('<form>hello</form>');
    expect(md).not.toContain('[[ARTIFACT:login-form]]');
  });

  it('warns about missing artifacts instead of silently dropping them', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'assistant', content: '[[ARTIFACT:gone]]' }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toMatch(/缺失的 artifact.+gone/);
  });

  it('renders tool calls with args JSON and result in a <details> block', () => {
    const tc: ToolCall = {
      id: 'tc1',
      name: 'fs_read_file',
      arguments: { path: 'src/main.ts' },
      result: 'file contents here',
      status: 'success',
    };
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'assistant', content: '读取文件', toolCalls: [tc] }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('<code>fs_read_file</code>');
    expect(md).toContain('"path": "src/main.ts"');
    expect(md).toContain('file contents here');
    expect(md).toContain('✓');
  });

  it('uses the tool-role message content as the tool result when toolCalls.result is missing', () => {
    const callId = 'call-xyz';
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({
            role: 'assistant',
            content: '调用工具',
            toolCalls: [
              {
                id: callId,
                name: 'shell_exec',
                arguments: { cmd: 'ls' },
                status: 'success',
              },
            ],
          }),
          msg({
            role: 'tool',
            content: 'total 4\ndrwx ...',
            toolCalls: [
              {
                id: callId,
                name: 'shell_exec',
                arguments: {},
                status: 'success',
              },
            ],
          }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('total 4');
    // The raw tool-role message must NOT appear as its own ### section.
    expect(md).not.toContain('### 🔧 工具');
  });

  it('truncates extremely long tool results', () => {
    const huge = 'x'.repeat(10_000);
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({
            role: 'assistant',
            content: 'a',
            toolCalls: [
              {
                id: 't',
                name: 'shell_exec',
                arguments: {},
                result: huge,
                status: 'success',
              },
            ],
          }),
        ],
      }),
      { toolResultCap: 500, now: FIXED_NOW }
    );
    expect(md).toContain('已截断');
    // Body shouldn't contain the full 10k — allow some slack for boilerplate.
    expect(md.length).toBeLessThan(huge.length);
  });

  it('shows attachment names in a compact line', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({
            content: '看附件',
            attachments: [
              {
                id: 'a1',
                name: 'spec.pdf',
                mimeType: 'application/pdf',
                size: 2048,
              },
            ],
          }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('📎 附件');
    expect(md).toContain('spec.pdf');
    expect(md).toContain('application/pdf');
  });

  it('shows the assistant model in the sub-line when available', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'assistant', content: 'a', modelId: 'deepseek-v4-pro' }),
        ],
      }),
      { now: FIXED_NOW }
    );
    expect(md).toContain('模型: deepseek-v4-pro');
  });

  it('preserves message order', () => {
    const md = buildConversationMarkdown(
      conv({
        messages: [
          msg({ role: 'user', content: 'FIRST' }),
          msg({ role: 'assistant', content: 'SECOND' }),
          msg({ role: 'user', content: 'THIRD' }),
        ],
      }),
      { now: FIXED_NOW }
    );
    const i1 = md.indexOf('FIRST');
    const i2 = md.indexOf('SECOND');
    const i3 = md.indexOf('THIRD');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it('ends with an export footer using the injected clock', () => {
    const md = buildConversationMarkdown(conv(), { now: FIXED_NOW });
    // 1_700_003_600_000 is the pinned clock; we just check the pattern
    // rather than exact value (timezone-dependent formatting).
    expect(md).toMatch(/\*导出自 Flaude · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\*\n$/);
  });
});

describe('sanitizeFilename', () => {
  it('strips Windows-forbidden characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('preserves CJK and normal letters', () => {
    expect(sanitizeFilename('学习 Rust 笔记')).toBe('学习_Rust_笔记');
  });

  it('collapses runs of whitespace and underscores', () => {
    expect(sanitizeFilename('a    b___c')).toBe('a_b_c');
  });

  it('trims leading/trailing dots and underscores', () => {
    expect(sanitizeFilename('...hello...')).toBe('hello');
    expect(sanitizeFilename('___foo___')).toBe('foo');
  });

  it('falls back when sanitized result is empty', () => {
    expect(sanitizeFilename('///')).toBe('conversation');
    expect(sanitizeFilename('')).toBe('conversation');
    expect(sanitizeFilename('...')).toBe('conversation');
  });

  it('caps length to avoid OS path limits', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(80);
  });

  it('accepts a custom fallback', () => {
    expect(sanitizeFilename('', 'chat')).toBe('chat');
  });
});
