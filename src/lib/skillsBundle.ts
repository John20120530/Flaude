/**
 * Client wrapper for the Worker's `/api/skills/fetch-bundle` endpoint.
 *
 * The Worker walks the GitHub repo's tree starting at the SKILL.md's
 * parent directory, fetches every text file under it (subject to size
 * / depth / extension caps), and returns the SKILL.md plus the
 * auxiliary assets in one shot. The client persists the result locally
 * so subsequent reads from the agent (via `read_skill_asset`) are
 * offline-fast.
 */

import { authGetJson } from './flaudeApi';
import type { SkillAsset } from '@/types';

interface BundleSuccess {
  ok: true;
  name: string;
  description: string;
  body: string;
  assets: SkillAsset[];
  errors?: string[];
  truncated?: boolean;
  fromCache: boolean;
}

interface BundleFailure {
  ok: false;
  error: string;
}

type BundleResponse = BundleSuccess | BundleFailure;

/**
 * Fetch a complete skill bundle (SKILL.md + sibling text files) given
 * the raw.githubusercontent.com URL of the SKILL.md.
 *
 * On success returns `{ok: true, name, description, body, assets,
 * errors?, truncated?}`. On failure returns `{ok: false, error}`.
 *
 * The Worker caches per-rawUrl for 1 hour, so repeated installs of the
 * same skill are nearly free.
 */
export async function fetchSkillBundle(rawUrl: string): Promise<BundleResponse> {
  if (!rawUrl) return { ok: false, error: 'rawUrl is required' };
  const url = `/api/skills/fetch-bundle?rawUrl=${encodeURIComponent(rawUrl)}`;
  try {
    return await authGetJson<BundleResponse>(url);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
