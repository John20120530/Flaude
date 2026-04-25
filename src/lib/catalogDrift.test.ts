/**
 * Drift guard between the client model catalog (`src/config/providers.ts`) and
 * the server model registry (`server/src/providers.ts`).
 *
 * The bug we're guarding against: client.providers exposes a model id that
 * the server's `resolveModel()` doesn't recognise. The user picks (or
 * inherits as default) that model, the request hits the server, the server
 * 400s with "unsupported model", and the user sees a broken UI.
 *
 * Failure mode that motivated this: v0.1.6 added `deepseek-v4-pro` and
 * `deepseek-v4-flash` to the client catalog but never updated the server.
 * Nobody noticed for several releases because the per-mode default for
 * chat/code stayed on `deepseek-chat` (server-registered). v0.1.9 made
 * `deepseek-v4-pro` the default for the new Design mode — and the FIRST
 * user who clicked Design hit the 400 immediately.
 *
 * What we assert here:
 *   - Every model id from a *default-enabled* client provider must have a
 *     matching entry in the server's MODEL_INDEX. We deliberately skip
 *     providers shipped as `enabled: false` (e.g. MiniMax pre-Phase-2) —
 *     those are aspirational catalog entries the server hasn't been wired
 *     up for yet, and the user can't reach them without explicit action in
 *     Settings. If/when we flip a provider to enabled-by-default, this test
 *     starts asserting on it automatically — exactly the right gate.
 *   - The reverse direction (server has models the client doesn't expose) is
 *     allowed: it's reasonable to register an upstream model the UI hasn't
 *     surfaced yet, e.g. for staged rollout.
 *
 * Why this test lives in src/lib/ instead of server/: the server has no
 * vitest setup, and writing it here means CI catches drift on every PR
 * without standing up a second test runner.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, DEFAULT_MODEL_BY_MODE } from '@/config/providers';
import { listSupportedModels } from '../../server/src/providers';

describe('client/server catalog drift', () => {
  it('every default-enabled client model id is registered on the server', () => {
    const clientIds = DEFAULT_PROVIDERS.filter((p) => p.enabled).flatMap((p) =>
      p.models.map((m) => m.id),
    );
    const serverIds = new Set(listSupportedModels());
    const missing = clientIds.filter((id) => !serverIds.has(id));
    expect(
      missing,
      `client catalog exposes model ids that server resolveModel() does not ` +
        `recognise: [${missing.join(', ')}]. Add them to server/src/providers.ts ` +
        `MODEL_INDEX so /v1/chat/completions stops returning "unsupported model".`,
    ).toEqual([]);
  });

  it('per-mode default models are server-registered', () => {
    // Defaults are the highest-stakes drift target — a new user with no
    // localStorage hits these on their very first send. A drift here breaks
    // the empty-state experience entirely.
    const serverIds = new Set(listSupportedModels());
    for (const [mode, modelId] of Object.entries(DEFAULT_MODEL_BY_MODE)) {
      expect(
        serverIds.has(modelId as string),
        `DEFAULT_MODEL_BY_MODE['${mode}'] = '${modelId}' is not registered on ` +
          `the server. New users in ${mode} mode would 400 on their first send.`,
      ).toBe(true);
    }
  });
});
