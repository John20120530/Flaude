/**
 * Minimal D1Database shim backed by better-sqlite3.
 *
 * Only covers the subset of the D1 API that the sync code actually calls:
 *   DB.prepare(sql).bind(...args).first<T>()     — single row, null if none
 *   DB.prepare(sql).bind(...args).all<T>()       — { results: T[] }
 *   DB.prepare(sql).bind(...args).run()          — { meta: { changes } }
 *   DB.batch(statements)                          — implicit transaction
 *
 * It's NOT a drop-in for every D1 feature (no raw(), no first(col-name), no
 * first(undefined)). If a test fails with "X is not a function", add the
 * missing bit here — but resist the urge to add things that aren't actually
 * exercised. The goal is a tight fake we can trust, not a D1 compatibility
 * layer.
 *
 * One subtle invariant: D1's `bind` returns a *new* prepared statement — it
 * does NOT mutate in place. sync.ts chains `.prepare(sql).bind(...)`, so we
 * must preserve that "every call returns a fresh object with the bound
 * params" shape or consecutive .bind()s would clobber each other in the
 * batch array.
 */
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import Database from 'better-sqlite3';

type Bindable = string | number | boolean | null | Uint8Array;

// better-sqlite3 only accepts these primitive types for parameters. Normalize
// boolean/undefined here rather than at every call site.
function coerce(v: unknown): Bindable | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Bindable;
}

// We expose this so tests can close() in afterAll if they want — but most
// use isolated per-test DBs so teardown is implicit.
export interface TestD1 extends D1Database {
  raw: Database.Database;
}

export function createTestD1(): TestD1 {
  const db = new Database(':memory:');
  // Match D1's default behaviour for FK cascades.
  db.pragma('foreign_keys = ON');

  function makePrepared(
    sql: string,
    params: Bindable[] = [],
  ): D1PreparedStatement {
    // The D1 type for PreparedStatement is extensive (raw, first with colName,
    // etc.) — we only implement what sync.ts/auth.ts/middleware.ts call. Cast
    // through `unknown` to silence the "missing properties" checker.
    const stmt = {
      bind(...args: unknown[]): D1PreparedStatement {
        return makePrepared(sql, args.map(coerce) as Bindable[]);
      },

      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = db.prepare(sql).get(...params);
        return (row ?? null) as T | null;
      },

      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rows = db.prepare(sql).all(...params) as T[];
        return {
          results: rows,
          success: true,
          meta: { duration: 0 } as D1Result<T>['meta'],
        };
      },

      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const info = db.prepare(sql).run(...params);
        return {
          results: [],
          success: true,
          meta: {
            duration: 0,
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid),
          } as D1Result<T>['meta'],
        };
      },

      // D1 supports a second form of first() that plucks a single column, plus
      // raw() and various others — none of which our server touches. Leave
      // them undefined; the cast below silences TS.
    };
    return stmt as unknown as D1PreparedStatement;
  }

  // The `_type` marker prop in the D1 type isn't something we can satisfy
  // structurally; cast through `unknown` to bridge.
  const d1 = {
    prepare(sql: string): D1PreparedStatement {
      return makePrepared(sql);
    },

    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      // D1's batch() runs all statements in an implicit transaction that
      // rolls back if any fails. Mirror that with better-sqlite3's
      // transaction API so ON CONFLICT guards and LWW WHERE-filtered UPSERTs
      // get the same commit/rollback semantics our server relies on.
      const txn = db.transaction((stmts: D1PreparedStatement[]) => {
        return stmts.map(
          (s) => (s as unknown as { run(): Promise<D1Result<T>> }).run(),
        );
      });
      // Each stmt's .run() returns a Promise (our fakes are async). We
      // unwrap them before committing; since better-sqlite3 is synchronous
      // under the hood, .run() resolves on the next tick but the DB write
      // has already happened. Awaiting here just settles the promises.
      const pendingResults = txn(statements) as unknown as Promise<D1Result<T>>[];
      return Promise.all(pendingResults);
    },

    async dump(): Promise<ArrayBuffer> {
      throw new Error('dump() not implemented in test shim');
    },

    async exec(_sql: string): Promise<D1Result<Record<string, unknown>>> {
      throw new Error('exec() not implemented in test shim — use prepare()');
    },

    withSession<T>(
      _callback: (session: D1Database) => Promise<T> | T,
    ): Promise<T> {
      throw new Error('withSession() not implemented in test shim');
    },

    raw: db,
  };

  return d1 as unknown as TestD1;
}
