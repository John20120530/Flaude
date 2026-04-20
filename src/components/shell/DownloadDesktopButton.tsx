/**
 * TopBar affordance shown only to web-version users that steers them toward
 * the Windows desktop build. Rationale: the browser can do Chat fine, but
 * Code mode's file I/O, background shells and MCP wiring all live in the
 * Tauri native side — so we make the "upgrade to desktop" path obvious
 * without nagging desktop users (who never see this button).
 *
 * On mount we probe GitHub's releases API for the latest MSI asset and
 * point the button straight at it, so one click triggers the download.
 * The initial href is the generic /releases/latest page — used as the
 * fallback if the API call fails (offline, rate limit, network block) so
 * the button never dead-ends. Hover: native `title` tooltip explains *why*
 * the user would want the desktop version.
 */

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { isTauri } from '@/lib/tauri';

const RELEASES_URL = 'https://github.com/John20120530/Flaude/releases/latest';
const LATEST_API = 'https://api.github.com/repos/John20120530/Flaude/releases/latest';

interface Asset {
  name: string;
  browser_download_url: string;
}

export default function DownloadDesktopButton() {
  const [href, setHref] = useState<string>(RELEASES_URL);

  useEffect(() => {
    if (isTauri()) return;
    let cancelled = false;
    fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { assets?: Asset[] } | null) => {
        if (cancelled || !data?.assets) return;
        const msi = data.assets.find((a) => a.name.endsWith('.msi'));
        if (msi) setHref(msi.browser_download_url);
      })
      .catch(() => {
        /* keep fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isTauri()) return null;
  return (
    <a
      href={href}
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
