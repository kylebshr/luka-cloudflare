// Singleton Durable Object: per-user activity counts for /activity-count, and the shared
// APNs provider token.

import { DurableObject } from "cloudflare:workers";
import { mintProviderJwt } from "./apns";
import { dataTTLSeconds } from "./scheduling";
import { apnsKey } from "./secrets";
import type { ActivityCounts } from "./types";

/** One user's contribution to the totals. */
export type SessionCounts = Pick<ActivityCounts, "activities" | "rateLimited">;

/** A provider token and when its holders should ask for a newer one. */
export interface ApnsJwt {
  token: string;
  /** Epoch ms. */
  refreshAt: number;
}

// APNs rejects provider tokens older than an hour and answers TooManyProviderTokenUpdates
// when they change more often than every 20 minutes. One token for the whole deployment,
// replaced every 30 minutes, stays clear of both.
const jwtLifetime = 30 * 60_000;
// An ExpiredProviderToken typically hits many sessions at once, and each asks for a
// forced refresh. Only the first one re-mints; the rest get the token it just made.
const forcedRefreshMinAge = 60_000;

/** How often a session re-reports unchanged counts, so its row never ages out. */
export const reportHeartbeat = 60 * 60_000;

export class Registry extends DurableObject<Env> {
  #jwt: (ApnsJwt & { issuedAt: number }) | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      username TEXT PRIMARY KEY,
      activities INTEGER NOT NULL,
      rate_limited INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  /** Upserts one user's counts, or removes the user when their session is gone. */
  report(username: string, counts: SessionCounts | null): void {
    if (counts === null) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE username = ?", username);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (username, activities, rate_limited, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (username) DO UPDATE SET
         activities = excluded.activities, rate_limited = excluded.rate_limited, updated_at = excluded.updated_at`,
      username,
      counts.activities,
      counts.rateLimited,
      Date.now(),
    );
  }

  /**
   * Totals across users. A row that stopped being refreshed belongs to a session that
   * died without reporting (sessions re-report at least every `reportHeartbeat`), so rows
   * older than the data TTL are dropped.
   */
  counts(): ActivityCounts {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE updated_at <= ?", Date.now() - dataTTLSeconds * 1000);
    const row = this.ctx.storage.sql
      .exec<{ sessions: number; activities: number; rateLimited: number }>(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(activities), 0) AS activities,
                COALESCE(SUM(rate_limited), 0) AS rateLimited FROM sessions`,
      )
      .one();
    return { sessions: row.sessions, activities: row.activities, rateLimited: row.rateLimited };
  }

  /** The shared provider token, or undefined when APNs isn't configured (local dev). */
  async apnsJwt(options: { forceRefresh?: boolean } = {}): Promise<ApnsJwt | undefined> {
    const key = apnsKey(this.env);
    if (!key) return undefined;

    const now = Date.now();
    this.#jwt ??= this.ctx.storage.kv.get("apnsJwt");
    let jwt = this.#jwt;
    const age = jwt ? now - jwt.issuedAt : Infinity;
    if (!jwt || age >= jwtLifetime || (options.forceRefresh && age >= forcedRefreshMinAge)) {
      const token = await mintProviderJwt({ ...key, nowSeconds: now / 1000 });
      jwt = this.#jwt = { token, issuedAt: now, refreshAt: now + jwtLifetime };
      // Persisted so an evicted Registry doesn't mint a new token early.
      this.ctx.storage.kv.put("apnsJwt", jwt);
    }
    return { token: jwt.token, refreshAt: jwt.refreshAt };
  }
}
