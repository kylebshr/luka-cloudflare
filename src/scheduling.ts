// Poll policy: when to poll Dexcom next, how to back off, and stale levels. Pure functions
// and constants.
//
// Units: intervals and delays are seconds; instants are epoch milliseconds.

import type { DexcomHTTPResponse } from "./dexcom";
import { type GlucoseReading, type PollState, StaleLevel, type TokenEntry } from "./types";

// Recheck cadences for a reading that is due but hasn't appeared (the first recheck is
// quicker), and how long past the expected arrival they apply — see overdueReschedule.
export const overdueFirstRetryInterval = 20;
export const overdueRetryInterval = 30;
export const overdueCatchupWindow = 120;
export const readingInterval = 60 * 5;
// Extra wait past an expected reading boundary before polling for it, covering typical
// Share-side propagation delay. At 10s roughly a third of boundary polls missed, and
// every miss spent 1–4 catch-up rechecks of the account's Dexcom read budget — enough
// extra load to re-trigger per-account 429s. 20s keeps the boundary poll reliable so the
// quick rechecks stay the exception.
export const readingPropagationBuffer = 20;
/** When a reading is considered offline. */
export const offlineInterval = 60 * 15;
/** Floor on staleDate so it's never in the past or near-now. */
export const minStaleDateBuffer = 60 * 2;
/** Max lifetime of a Live Activity before the server ends it. */
export const maximumDuration = 60 * 60 * 7;
// A failed poll (network error, Dexcom 5xx, undecodable body) retries on this spacing for
// the first `errorQuickRetryLimit` consecutive failures, then only at reading boundaries:
// a blip is retried within a minute, and a long outage costs one read per reading.
// Failures never end a session — it keeps retrying, showing stale data, until its
// activities reach their max duration. Only rejected credentials end it early.
export const errorRetryInterval = 60;
export const errorQuickRetryLimit = 5;
// After a 429 that says nothing about when to come back, poll no more often than this at
// first, then ease back (recoveryInterval shrinks to recoveryDecay of itself on each
// healthy poll, and clears once it reaches recoveryClearInterval) rather than immediately
// resuming the aggressive overdue cadence. Repeated 429s double the floor instead — see
// escalatedRecovery.
export const recoveryStartInterval = 300;
export const recoveryDecay = 0.6;
export const recoveryClearInterval = 60;
// Ceiling on the escalating recovery floor (see escalatedRecovery). Wide enough to skip
// 1–2 reading boundaries per poll so a drained account budget can rebuild, while still
// refreshing the Live Activity every few minutes.
export const maxRecoveryInterval = 60 * 15;
// Longest server-provided Retry-After we'll honor. The header is authoritative for when
// the limit clears, but a malformed or far-future value shouldn't park a session past the
// point where its Live Activity has any data worth resuming.
export const maxRetryAfter = 60 * 30;
// Added to `Retry-After` so the retry lands just after the limit clears.
export const retryAfterMargin = 2;
// Retries after a `Retry-After` are spread at random over this many further seconds. The
// limit is shared by every session polling from the same data center, so sessions blocked
// together are told to come back at the same instant; retrying in one burst is the kind
// of traffic that starts the next block.
export const retryAfterSpread = 10;

/**
 * Lifetime of everything a session leaves behind (tombstones, the restart marker). A
 * session can't legitimately outlive its tokens' max activity duration (7h), so 8h
 * comfortably exceeds any active session while still letting leftovers expire.
 */
export const dataTTLSeconds = 8 * 60 * 60;

/**
 * Delay until the next reading boundary at least `minimumDelay` out, phase-anchored to
 * the last reading — readings arrive every `readingInterval`, plus
 * `readingPropagationBuffer` for Share-side propagation. Boundaries closer than
 * `minimumDelay` are skipped, so a backed-off poll waits out its whole floor and then
 * lands just after a reading rather than just before one.
 */
export function delayUntilNextReading(lastReadingDate: number | undefined, now: number, minimumDelay = 0): number {
  if (lastReadingDate === undefined) {
    return Math.max(readingInterval + readingPropagationBuffer, minimumDelay);
  }
  const elapsed = (now - lastReadingDate) / 1000;
  const cyclesElapsed = Math.floor(elapsed / readingInterval);
  // Start at the first reading boundary still in the future, then keep skipping
  // boundaries until the wait clears `minimumDelay`.
  let untilNextReading = (cyclesElapsed + 1) * readingInterval - elapsed;
  let delay = untilNextReading + readingPropagationBuffer;
  while (delay < minimumDelay) {
    untilNextReading += readingInterval;
    delay = untilNextReading + readingPropagationBuffer;
  }
  return delay;
}

/**
 * Scheduling decision for a poll that found the last reading overdue (due but not yet
 * available). Late readings usually land within a minute or two of the 5-minute mark
 * (Share-side propagation), so within `overdueCatchupWindow` past the expected arrival,
 * recheck on a quick cadence instead of backing off — extra quick for the first recheck,
 * when the reading is usually just seconds away. Peer Share clients behave the same way
 * (xDrip+ retries in ~10s steps around the expected boundary; Nightscout's share2 bridge
 * polls flat every 2.5 min). Past the window the reading is genuinely missing (sensor
 * gap, phone offline), so aim for each subsequent reading boundary instead —
 * phase-anchored to the last reading, so a resumed stream is picked up seconds after it
 * lands rather than minutes. An active post-429 `recoveryInterval` disables the quick
 * cadence entirely: extra polls are what drew the 429, so a recovering session only
 * polls at reading boundaries at least the floor apart until recovery clears.
 */
export function overdueReschedule(options: {
  lastReadingDate: number;
  now: number;
  /** Whether the poll that found the reading overdue was itself a quick recheck. */
  rechecking: boolean;
  recoveryInterval: number | undefined;
}): { delay: number; rechecking: boolean } {
  const { lastReadingDate, now, rechecking, recoveryInterval } = options;
  const timeSinceLastReading = (now - lastReadingDate) / 1000;
  if (recoveryInterval === undefined && timeSinceLastReading < readingInterval + overdueCatchupWindow) {
    return { delay: rechecking ? overdueRetryInterval : overdueFirstRetryInterval, rechecking: true };
  }
  return { delay: delayUntilNextReading(lastReadingDate, now, recoveryInterval ?? 0), rechecking: false };
}

/**
 * Delay before retrying a failed poll: `errorRetryInterval` for the first
 * `errorQuickRetryLimit` consecutive failures, then the next reading boundary. Never
 * sooner than an active post-429 recovery floor.
 */
export function errorRetryDelay(
  state: Pick<PollState, "retryCount" | "recoveryInterval" | "lastReading">,
  now: number,
): number {
  const floor = Math.max(errorRetryInterval, state.recoveryInterval ?? 0);
  if (state.retryCount < errorQuickRetryLimit) return floor;
  return delayUntilNextReading(state.lastReading?.date, now, floor);
}

/**
 * The `Retry-After` delay to honor from a rate-limited response, capped at
 * `maxRetryAfter`. Undefined when the response gives nothing to follow: no header, an
 * unparseable one, or one that names no time in the future.
 */
export function honoredRetryAfter(httpResponse: DexcomHTTPResponse | undefined): number | undefined {
  const retryAfter = httpResponse?.retryAfter;
  if (retryAfter === undefined || retryAfter <= 0) return undefined;
  return Math.min(retryAfter, maxRetryAfter);
}

/**
 * The post-429 recovery floor after a rate-limited response that carried no usable
 * `Retry-After`. The first 429 starts at `recoveryStartInterval`; a 429 arriving while a
 * floor is already active means the account's budget is still exhausted at the current
 * spacing (Dexcom's limiter refills at roughly the reading cadence, so a drained budget
 * can't absorb even boundary polls), so the floor doubles — capped at
 * `maxRecoveryInterval`, where polls skip 1–2 reading boundaries and the budget rebuilds.
 */
export function escalatedRecovery(current: number | undefined): number {
  const doubled = Math.min((current ?? 0) * 2, maxRecoveryInterval);
  return Math.max(recoveryStartInterval, doubled);
}

/** What to do after a 429: retry when the server's `Retry-After` allows, or back off. */
export type RateLimitPlan =
  | { action: "retry_after"; delay: number }
  | { action: "backoff"; delay: number; recovery: number };

/**
 * The scheduling decision for a rate-limited poll. A 429 that carries a usable
 * `Retry-After` is retried soon after the header says the limit clears (`spread`, a
 * random fraction in [0, 1), places it within `retryAfterSpread`), however many times in
 * a row, leaving the recovery floor as it was. Production 429s arrive on
 * ordinary boundary polls from sessions already at their minimum rate (one read per 5
 * minutes), answered by an edge limiter in a few ms with a plain-text body and a
 * `Retry-After` of seconds: a limit on the source address Workers share, which our
 * polling didn't draw and which slower polling doesn't lift. In a busy data center it
 * blocks close to half of all requests, so a session that backs off can keep landing in
 * a block and go without data for its whole lifetime, while following the header gets it
 * a reading within a minute or two.
 *
 * A 429 without a usable header backs off: it raises the recovery floor and aims for a
 * reading boundary at least that far out, skipping any reading about to land.
 */
export function rateLimitPlan(
  state: Pick<PollState, "recoveryInterval" | "lastReading">,
  httpResponse: DexcomHTTPResponse | undefined,
  now: number,
  spread: number,
): RateLimitPlan {
  const retryAfter = honoredRetryAfter(httpResponse);
  if (retryAfter !== undefined) {
    return { action: "retry_after", delay: retryAfter + retryAfterMargin + spread * retryAfterSpread };
  }
  const recovery = escalatedRecovery(state.recoveryInterval);
  const delay = delayUntilNextReading(state.lastReading?.date, now, recovery);
  return { action: "backoff", delay, recovery };
}

/**
 * Eases the post-rate-limit recovery floor back toward normal polling. Returns the next
 * floor, or undefined once it has shrunk back to (at or below) recoveryClearInterval.
 */
export function decayedRecovery(current: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  const next = current * recoveryDecay;
  return next > recoveryClearInterval ? next : undefined;
}

/**
 * Poll spacing while a session has never seen a reading (fresh sensor, warmup). With no
 * last reading to anchor a boundary to, poll at the sensor's own cadence — anything
 * faster can't return something new. Sessions with an anchor use the overdue path
 * instead. Still respects an active post-429 recovery floor.
 */
export function unanchoredPollDelay(state: Pick<PollState, "recoveryInterval">): number {
  return Math.max(readingInterval, state.recoveryInterval ?? 0);
}

/**
 * Maps the time since the last reading (seconds) to a stale level, matching the milestone
 * thresholds used for stale updates. Undefined while the reading is still fresh
 * (< 5 minutes), which clients render as live.
 */
export function staleLevel(timeSinceLastReading: number): StaleLevel | undefined {
  const minutes = Math.trunc(timeSinceLastReading / 60);
  if (minutes >= 15) return StaleLevel.offline;
  if (minutes >= 10) return StaleLevel.stale;
  if (minutes >= 5) return StaleLevel.warning;
  return undefined;
}

/**
 * Trims readings to the window (seconds) a given activity displays, so APNs payloads
 * don't balloon now that 24h is cached on the server.
 */
export function trimReadings(readings: GlucoseReading[], duration: number, now: number): GlucoseReading[] {
  const cutoff = now - duration * 1000;
  return readings.filter((reading) => reading.date >= cutoff);
}

/**
 * Which existing entries a registration supersedes. A push-to-start token is per-device,
 * so another entry carrying the same one is an older activity on the same device that the
 * one starting now replaced. Only a *brand-new* activity ID may supersede: a
 * re-registration of an activity we already know (token rotation, foreground re-sync, or
 * a stale request for a just-dismissed activity) says nothing about which activity is
 * newest and must never delete a sibling.
 */
export function supersededActivityIDs(
  tokens: readonly TokenEntry[],
  registration: { activityID: string; pushToStartToken: string | undefined; isNewActivity: boolean },
): string[] {
  const { activityID, pushToStartToken, isNewActivity } = registration;
  if (!isNewActivity || pushToStartToken === undefined) return [];
  return tokens
    .filter((token) => token.pushToStartToken === pushToStartToken && token.activityID !== activityID)
    .map((token) => token.activityID);
}
