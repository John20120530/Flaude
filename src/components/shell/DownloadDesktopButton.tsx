/**
 * TopBar affordance shown only to web-version users that steers them toward
 * the Windows desktop build. Rationale: the browser can do Chat fine, but
 * Code mode's file I/O, background shells and MCP wiring all live in the
 * Tauri native side — so we make the "upgrade to desktop" path obvious
 * without nagging desktop users (who never see this button).
 *
 * Click: opens the GitHub Releases "latest" page in a new tab — we don't
 * deep-link to the .exe because the filename embeds the version. GitHub's
 * redirect is reliable. Hover: native `title` tooltip explains *why* the
 * user would want the desktop version. Stays consistent with the other
 * TopBar buttons, which all use `title` rather than a custom popover.
 */

import { Download } from 'lucide-react';
import { isTauri } from '@/lib/tauri';

const RELEASES_URL = 'https://github.com/John20120530/Flaude/releases/latest';

export default function DownloadDesktopButton() {
  if (isTauri()) return null;
  return (
    <a
      href={RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-ghost flex items-center gap-1.5 text-xs px-2"
      title="要想使用 Code 的全部功能（读写本地文件、运行本地命令等）需要下载客户端"
      aria-label="下载桌面版"
    >
      <Download className="w-3.5 h-3.5" />
      <span>下载桌面版</span>
    </a>
  );
}
