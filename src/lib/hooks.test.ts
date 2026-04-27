import { describe, expect, it } from 'vitest';
import {
  formatHookOutputForAgent,
  interpolateCommand,
  matchTool,
  shellQuote,
} from './hooks';

describe('matchTool', () => {
  it('returns false for empty / undefined matcher', () => {
    expect(matchTool('', 'fs_write_file')).toBe(false);
    expect(matchTool(undefined, 'fs_write_file')).toBe(false);
  });

  it('returns true for the wildcard "*"', () => {
    expect(matchTool('*', 'fs_write_file')).toBe(true);
    expect(matchTool('*', 'shell_exec')).toBe(true);
    expect(matchTool(' * ', 'anything')).toBe(true);
  });

  it('exact-matches a single tool name', () => {
    expect(matchTool('fs_write_file', 'fs_write_file')).toBe(true);
    expect(matchTool('fs_write_file', 'fs_read_file')).toBe(false);
    expect(matchTool('fs_write_file', 'fs_write_file_extra')).toBe(false);
  });

  it('matches any of pipe-separated alternatives', () => {
    expect(matchTool('fs_write_file|shell_exec', 'fs_write_file')).toBe(true);
    expect(matchTool('fs_write_file|shell_exec', 'shell_exec')).toBe(true);
    expect(matchTool('fs_write_file|shell_exec', 'fs_read_file')).toBe(false);
  });

  it('tolerates whitespace around alternatives', () => {
    expect(matchTool(' fs_write_file | shell_exec ', 'shell_exec')).toBe(true);
  });
});

describe('shellQuote', () => {
  describe('posix (sh -c)', () => {
    it('wraps simple values in single quotes', () => {
      expect(shellQuote('hello', 'posix')).toBe(`'hello'`);
    });

    it('escapes embedded single quotes via the standard \'\\\'\' trick', () => {
      // Input: it's
      // Expected: 'it'\''s'
      expect(shellQuote(`it's`, 'posix')).toBe(`'it'\\''s'`);
    });

    it('preserves whitespace, backslashes, dollars, backticks unchanged inside single quotes', () => {
      expect(shellQuote('a $b `c\\d', 'posix')).toBe(`'a $b \`c\\d'`);
    });
  });

  describe('windows (cmd /c)', () => {
    it('wraps simple values in double quotes', () => {
      expect(shellQuote('hello', 'windows')).toBe(`"hello"`);
    });

    it('doubles internal double quotes (cmd-style)', () => {
      expect(shellQuote(`a "b" c`, 'windows')).toBe(`"a ""b"" c"`);
    });

    it('strips newlines (cmd parsing breaks on them inside quoted args)', () => {
      expect(shellQuote('line1\nline2', 'windows')).toBe(`"line1 line2"`);
    });

    it('handles paths with spaces', () => {
      expect(shellQuote('C:\\Program Files\\node\\node.exe', 'windows')).toBe(
        `"C:\\Program Files\\node\\node.exe"`,
      );
    });
  });
});

describe('interpolateCommand', () => {
  const vars = {
    tool: 'fs_write_file',
    workspace: '/Users/me/project',
    file: 'src/foo.ts',
    argsJson: '{"path":"src/foo.ts"}',
  };

  it('substitutes $FLAUDE_TOOL with the tool name (shell-quoted)', () => {
    expect(interpolateCommand('echo $FLAUDE_TOOL', vars, 'posix')).toBe(
      `echo 'fs_write_file'`,
    );
  });

  it('substitutes $FLAUDE_FILE for fs_write_file', () => {
    expect(interpolateCommand('prettier --write $FLAUDE_FILE', vars, 'posix')).toBe(
      `prettier --write 'src/foo.ts'`,
    );
  });

  it('substitutes $FLAUDE_WORKSPACE', () => {
    expect(interpolateCommand('cd $FLAUDE_WORKSPACE', vars, 'posix')).toBe(
      `cd '/Users/me/project'`,
    );
  });

  it('substitutes $FLAUDE_ARGS_JSON safely (single-quoted)', () => {
    const out = interpolateCommand('echo $FLAUDE_ARGS_JSON', vars, 'posix');
    // JSON contains a double-quote — under single-quote shell rule it's
    // preserved verbatim, no escaping needed.
    expect(out).toBe(`echo '{"path":"src/foo.ts"}'`);
  });

  it('uses windows quoting on the windows platform', () => {
    expect(interpolateCommand('echo $FLAUDE_FILE', vars, 'windows')).toBe(
      `echo "src/foo.ts"`,
    );
  });

  it('substitutes multiple occurrences', () => {
    expect(interpolateCommand('$FLAUDE_TOOL: $FLAUDE_FILE', vars, 'posix')).toBe(
      `'fs_write_file': 'src/foo.ts'`,
    );
  });

  it('leaves unknown $FLAUDE_* variables alone (typo-friendly)', () => {
    expect(interpolateCommand('echo $FLAUDE_BANANA', vars, 'posix')).toBe(
      'echo $FLAUDE_BANANA',
    );
  });

  it('leaves non-$FLAUDE_ variables alone (e.g. $HOME, $PATH)', () => {
    expect(interpolateCommand('echo $HOME $FLAUDE_TOOL', vars, 'posix')).toBe(
      `echo $HOME 'fs_write_file'`,
    );
  });

  it('substitutes is case-insensitive on the variable name', () => {
    // The regex captures any \w+; lookup uses .toUpperCase() on the captured name.
    expect(interpolateCommand('$FLAUDE_tool', vars, 'posix')).toBe(`'fs_write_file'`);
  });

  it('handles empty values without producing unquoted holes', () => {
    const emptyFile = { ...vars, file: '' };
    expect(interpolateCommand('check $FLAUDE_FILE', emptyFile, 'posix')).toBe(
      `check ''`,
    );
  });

  it('shell-quotes paths with spaces', () => {
    const spaced = { ...vars, file: 'src/has space.ts' };
    expect(interpolateCommand('cat $FLAUDE_FILE', spaced, 'posix')).toBe(
      `cat 'src/has space.ts'`,
    );
  });

  it("shell-quotes paths with single quotes (apostrophes)", () => {
    const apos = { ...vars, file: "it's.ts" };
    expect(interpolateCommand('cat $FLAUDE_FILE', apos, 'posix')).toBe(
      `cat 'it'\\''s.ts'`,
    );
  });
});

describe('formatHookOutputForAgent', () => {
  it('reports spawn errors clearly', () => {
    const out = formatHookOutputForAgent('typecheck', {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: 'shell not found',
    });
    expect(out).toContain('typecheck');
    expect(out).toContain('shell not found');
  });

  it('includes exit code and timeout status', () => {
    const out = formatHookOutputForAgent('typecheck', {
      code: 1,
      stdout: '',
      stderr: 'TypeScript error',
      timedOut: false,
    });
    expect(out).toContain('exit 1');
    expect(out).toContain('TypeScript error');
  });

  it('flags timeouts in the header', () => {
    const out = formatHookOutputForAgent('long-task', {
      code: 124,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    expect(out).toContain('timed out');
  });

  it('includes both stdout and stderr when both are present', () => {
    const out = formatHookOutputForAgent('h', {
      code: 0,
      stdout: 'OUT',
      stderr: 'ERR',
      timedOut: false,
    });
    expect(out).toContain('OUT');
    expect(out).toContain('ERR');
  });

  it('omits empty stdout/stderr sections', () => {
    const out = formatHookOutputForAgent('h', {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    expect(out).not.toContain('stdout:');
    expect(out).not.toContain('stderr:');
  });

  it('truncates very long output', () => {
    const long = 'x'.repeat(10_000);
    const out = formatHookOutputForAgent('h', {
      code: 0,
      stdout: long,
      stderr: '',
      timedOut: false,
    });
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('已截断');
  });
});
