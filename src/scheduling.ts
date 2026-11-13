// Poll policy: when to poll Dexcom next, how to back off, and stale levels. Pure functions
// and constants ported from the Vapor server's `LiveActivityScheduler`.
//
// Units: intervals and delays are seconds; instants are epoch milliseconds.

import type { DexcomHTTPResponse } from "./dexcom";
import { type GlucoseReading, type PollState, StaleLevel, type TokenEntry } from "./types";

// Baseline floor on poll spacing for healthy sessions, and the point below which a
// post-429 recovery floor clears. Overdue rechecks use the quicker overdueRetryInterval
// cadence instead — see overdueReschedule.
export const minInterval = 60;
export const maxInterval = 60;
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
export const backoff = 2.0;
export const errorBackoff = 3;
export const decodingErrorRetryLimit = 10;
export const genericErrorRetryLimit = 6;
// After a rate limit (429), poll no more often than this at first, then ease back toward
// minInterval (recoveryInterval shrinks to recoveryDecay of itself on each healthy poll)
// rather than immediately resuming the aggressive overdue cadence. Repeated 429s double
// the floor instead — see escalatedRecovery.
export const recoveryStartInterval = 300;
export const recoveryDecay = 0.6;
// On a 429, never reschedule sooner than this. A reading about to land would just get
// rate-limited again, so skip it and aim for a later one — at least ~4 minutes out.
export const rateLimitMinDelay = 60 * 4;
// Ceiling on the escalating recovery floor (see escalatedRecovery). Wide enough to skip
// 1–2 reading boundaries per poll so a drained account budget can rebuild, while still
// refreshing the Live Activity every few minutes.
export const maxRecoveryInterval = 60 * 15;
// Longest server-provided Retry-After we'll honor. The header is authoritative for when
// the limit clears, but a malformed or far-future value shouldn't park a session past the
// point where its Live Activity has any data worth resuming.
export const maxRetryAfter = 60 * 30;
// A 429 carrying a `Retry-After` no longer than this gets one quick retry before the long
// backoff. Production 429s arrive on ordinary boundary polls from sessions already at
// their minimum rate (one read per 5 minutes), answered by an edge limiter in a few ms
// with a plain-text body and a `Retry-After` of seconds — a transient limit our polling
// didn't draw, where waiting out the header costs seconds and the long backoff costs a
// whole reading.
export const quickRetryMaxRetryAfter = 60;
// Added to `Retry-After` on a quick retry so it lands just after the limit clears.
export const quickRetryMargin = 2;
// Small random spread added to error reschedules. A cohort synchronized by a shared event
// (a Dexcom outage erroring many sessions at once) computes its next delay from a shared
// "now" and would otherwise re-poll in lockstep until fresh readings re-anchor each
// member. Overdue rechecks don't need it — they're phase-anchored to each session's own
// reading time.
export const rescheduleJitterMax = 15;

/**
 * Lifetime of everything a session leaves behind (tombstones, the restart marker). A
 * session can't legitimately outlive its tokens' max activity duration (7h), so 8h
 * comfortably exceeds any active session while still letting leftovers expire.
 */
export const dataTTLSeconds = 8 * 60 * 60;

/**
 * Adds a small random delay so cohorts of sessions rescheduled at the same moment drift
 * apart instead of staying synchronized.
 */
export function jittered(delay: number, random: () => number = Math.random): number {
  return delay + random() * rescheduleJitterMax;
}

/**
 * Delay until the next reading boundary at least `minimumDelay` out, phase-anchored to
 * the last reading — readings arrive every `readingInterval`, plus
 * `readingPropagationBuffer` for Share-side propagation. Boundaries closer than
 * `minimumDelay` are skipped: the rate-limit path relies on this so a retry never lands
 * just before a reading and re-triggers the 429.
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
  previousPollInterval: number;
  recoveryInterval: number | undefined;
}): { delay: number; pollInterval: number } {
  const { lastReadingDate, now, previousPollInterval, recoveryInterval } = options;
  const timeSinceLastReading = (now - lastReadingDate) / 1000;
  if (recoveryInterval === undefined && timeSinceLastReading < readingInterval + overdueCatchupWindow) {
    // Catch-up rechecks are the only polls scheduled with a sub-minute spacing, so a
    // larger previous spacing means this poll wasn't one — it's the boundary poll
    // itself, and its miss is the first recheck opportunity.
    const isFirstRecheck = previousPollInterval > overdueRetryInterval;
    const cadence = isFirstRecheck ? overdueFirstRetryInterval : overdueRetryInterval;
    return { delay: cadence, pollInterval: cadence };
  }
  const delay = delayUntilNextReading(lastReadingDate, now, recoveryInterval ?? 0);
  return { delay, pollInterval: readingInterval };
}

/**
 * The `Retry-After` delay to honor from a rate-limited response, capped at
 * `maxRetryAfter`. Returns 0 when the response carried no usable header, so callers can
 * take `max` with their own floors.
 */
export function honoredRetryAfter(httpResponse: DexcomHTTPResponse | undefined): number {
  return Math.min(httpResponse?.retryAfter ?? 0, maxRetryAfter);
}

/**
 * The post-429 recovery floor after a rate-limited response. The first 429 starts at
 * `recoveryStartInterval`; a 429 arriving while a floor is already active means the
 * account's budget is still exhausted at the current spacing (Dexcom's limiter refills at
 * roughly the reading cadence, so a drained budget can't absorb even boundary polls), so
 * the floor doubles — capped at `maxRecoveryInterval`, where polls skip 1–2 reading
 * boundaries and the budget rebuilds. A server-provided `Retry-After` longer than all of
 * that wins outright.
 */
export function escalatedRecovery(current: number | undefined, retryAfter: number): number {
  const doubled = Math.min((current ?? 0) * 2, maxRecoveryInterval);
  return Math.max(recoveryStartInterval, retryAfter, doubled);
}

/** What to do after a 429: retry once on the server's short `Retry-After`, or back off. */
export type RateLimitPlan =
  | { action: "quick_retry"; delay: number }
  | { action: "backoff"; delay: number; recovery: number };

/**
 * The scheduling decision for a rate-limited poll. A healthy session whose 429 carries a
 * short `Retry-After` (at most `quickRetryMaxRetryAfter`) retries once, right after the
 * header says the limit clears — jittered, since a shared-egress limit hits many sessions
 * at the same instant — without entering recovery. Everything else backs off: a 429 with
 * no or a long `Retry-After`, one that arrives while recovering, or one that follows a
 * quick retry (the header's promise didn't hold). Backing off raises the recovery floor
 * and aims for a reading boundary at least that far out (never sooner than
 * `rateLimitMinDelay`), skipping any reading about to land.
 */
export function rateLimitPlan(
  state: Pick<PollState, "recoveryInterval" | "rateLimitRetried" | "lastReading">,
  httpResponse: DexcomHTTPResponse | undefined,
  now: number,
  random: () => number = Math.random,
): RateLimitPlan {
  const retryAfter = httpResponse?.retryAfter;
  if (
    retryAfter !== undefined &&
    retryAfter <= quickRetryMaxRetryAfter &&
    state.recoveryInterval === undefined &&
    !state.rateLimitRetried
  ) {
    return { action: "quick_retry", delay: jittered(retryAfter + quickRetryMargin, random) };
  }
  const recovery = escalatedRecovery(state.recoveryInterval, honoredRetryAfter(httpResponse));
  const delay = delayUntilNextReading(state.lastReading?.date, now, Math.max(rateLimitMinDelay, recovery));
  return { action: "backoff", delay, recovery };
}

/**
 * Eases the post-rate-limit recovery floor back toward normal polling. Returns the next
 * floor, or undefined once it has shrunk back to (at or below) minInterval.
 */
export function decayedRecovery(current: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  const next = current * recoveryDecay;
  return next > minInterval ? next : undefined;
}

/**
 * Minimum spacing between polls, raised to the recovery floor while easing back from a
 * rate limit so we don't immediately resume the aggressive overdue cadence.
 */
export function pollFloor(state: Pick<PollState, "recoveryInterval">): number {
  return Math.max(minInterval, state.recoveryInterval ?? 0);
}

/**
 * Upper bound on poll spacing while a session has never seen a reading (fresh sensor,
 * warmup). With no last reading to anchor a boundary to, the backoff grows toward
 * `readingInterval` (≈5 min) rather than pinning at `maxInterval` (60s) — polls faster
 * than the sensor's cadence can't return anything new. Sessions with an anchor use the
 * overdue path instead. Still respects an active post-429 recovery floor.
 */
export function overduePollCap(state: Pick<PollState, "recoveryInterval">): number {
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
