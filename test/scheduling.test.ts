import { describe, expect, it } from "vitest";
import { DexcomHTTPResponse } from "../src/dexcom";
import {
  dataTTLSeconds,
  decayedRecovery,
  delayUntilNextReading,
  escalatedRecovery,
  honoredRetryAfter,
  maxRecoveryInterval,
  maxRetryAfter,
  minInterval,
  overdueCatchupWindow,
  overdueFirstRetryInterval,
  overduePollCap,
  overdueReschedule,
  overdueRetryInterval,
  pollFloor,
  quickRetryMargin,
  quickRetryMaxRetryAfter,
  rateLimitMinDelay,
  rateLimitPlan,
  readingInterval,
  readingPropagationBuffer,
  recoveryStartInterval,
  staleLevel,
  supersededActivityIDs,
  trimReadings,
} from "../src/scheduling";
import { StaleLevel, type TokenEntry } from "../src/types";

const lastReading = 1_700_000_000_000;
const at = (seconds: number) => lastReading + seconds * 1000;

describe("rate limit rescheduling", () => {
  it("skips to the next reading after a rate limit", () => {
    // Polled 20s after the expected reading and got rate limited: skip the missed reading
    // and aim for the following one, ~5 min out.
    const overdueDelay = delayUntilNextReading(lastReading, at(readingInterval + 20), rateLimitMinDelay);
    expect(overdueDelay).toBeGreaterThanOrEqual(280);
    expect(overdueDelay).toBeLessThanOrEqual(320);

    // Rate limited 40s *before* a reading is due: don't aim for that imminent reading (it'd
    // just re-trigger the 429) — skip it and land on the following one.
    const beforeDueDelay = delayUntilNextReading(lastReading, at(readingInterval - 40), rateLimitMinDelay);
    expect(beforeDueDelay).toBeGreaterThanOrEqual(rateLimitMinDelay);
    expect(beforeDueDelay).toBeGreaterThanOrEqual(340); // ~6 min: 40s to the skipped reading + 5m + buffer
    expect(beforeDueDelay).toBeLessThanOrEqual(380);

    // With no prior reading to anchor to, fall back to at least the floor.
    expect(delayUntilNextReading(undefined, at(readingInterval + 20), rateLimitMinDelay)).toBeGreaterThanOrEqual(
      rateLimitMinDelay,
    );
    expect(delayUntilNextReading(undefined, 0)).toBe(readingInterval + readingPropagationBuffer);
  });

  it("extends the floor with Retry-After", () => {
    // Dexcom asked for a 10-minute wait — longer than rateLimitMinDelay, so the header
    // wins and the reschedule lands on the first reading boundary past it.
    const retryAfter = honoredRetryAfter(new DexcomHTTPResponse(429, undefined, { "Retry-After": "600" }));
    expect(retryAfter).toBe(600);

    const delay = delayUntilNextReading(lastReading, at(readingInterval + 20), Math.max(rateLimitMinDelay, retryAfter));
    expect(delay).toBeGreaterThanOrEqual(600);
    expect(delay).toBeLessThanOrEqual(600 + readingInterval);

    // A shorter Retry-After than our own floor doesn't shrink the backoff.
    const short = honoredRetryAfter(new DexcomHTTPResponse(429, undefined, { "Retry-After": "30" }));
    expect(Math.max(rateLimitMinDelay, short)).toBe(rateLimitMinDelay);
  });

  it("caps Retry-After and falls back to 0", () => {
    // A far-future value can't park a session for hours.
    expect(honoredRetryAfter(new DexcomHTTPResponse(429, undefined, { "Retry-After": "86400" }))).toBe(maxRetryAfter);

    // No header, unparseable header, or no response at all: contribute nothing.
    expect(honoredRetryAfter(new DexcomHTTPResponse(429))).toBe(0);
    expect(honoredRetryAfter(new DexcomHTTPResponse(429, undefined, { "Retry-After": "soon" }))).toBe(0);
    expect(honoredRetryAfter(undefined)).toBe(0);
  });
});

describe("overdueReschedule", () => {
  /** A last reading `offset` seconds in the past; `previous` defaults to a boundary poll's spacing. */
  const overdue = (offset: number, previous = minInterval, recovery?: number) =>
    overdueReschedule({
      lastReadingDate: lastReading,
      now: at(offset),
      previousPollInterval: previous,
      recoveryInterval: recovery,
    });

  it("rechecks quickly through the catch-up window", () => {
    // The boundary poll just missed: the first recheck is extra quick.
    const first = overdue(readingInterval + readingPropagationBuffer);
    expect(first).toEqual({ delay: overdueFirstRetryInterval, pollInterval: overdueFirstRetryInterval });

    // A poll scheduled by a catch-up recheck: the standard cadence from here on.
    const second = overdue(
      readingInterval + readingPropagationBuffer + overdueFirstRetryInterval,
      overdueFirstRetryInterval,
    );
    expect(second.delay).toBe(overdueRetryInterval);

    // Still inside the window a hair before it closes: same standard cadence.
    const late = overdue(readingInterval + overdueCatchupWindow - 1, overdueRetryInterval);
    expect(late.delay).toBe(overdueRetryInterval);
  });

  it("anchors to reading boundaries past the catch-up window", () => {
    // 7.5 minutes since the last reading: aim for the 10:00 boundary plus the buffer.
    expect(overdue(450)).toEqual({ delay: 150 + readingPropagationBuffer, pollInterval: readingInterval });

    // Deep in a gap, a boundary+buffer poll lands on the next boundary+buffer.
    expect(overdue(10 * readingInterval + readingPropagationBuffer)).toEqual({
      delay: readingInterval,
      pollInterval: readingInterval,
    });
  });

  it("disables the quick cadence during post-429 recovery", () => {
    // Inside the catch-up window but recovering: aim for the next boundary at least the
    // recovery floor away.
    expect(overdue(readingInterval + 20, minInterval, recoveryStartInterval)).toEqual({
      delay: 280 + readingPropagationBuffer,
      pollInterval: readingInterval,
    });

    // Even a mostly-decayed floor suppresses the quick cadence.
    expect(overdue(readingInterval + 50, overdueRetryInterval, 120).delay).toBe(250 + readingPropagationBuffer);

    // Past the window, a boundary sooner than the floor is skipped for the next one.
    expect(overdue(450, minInterval, 240).delay).toBe(450 + readingPropagationBuffer); // 15:00, not 10:00
  });
});

describe("rate limit plan", () => {
  const limited = (retryAfter?: string) =>
    new DexcomHTTPResponse(429, undefined, retryAfter === undefined ? {} : { "Retry-After": retryAfter });
  const healthy = { lastReading: { value: 100, trend: "Flat" as const, date: lastReading } };
  const now = at(readingInterval + readingPropagationBuffer);
  const backoff = { action: "backoff", delay: readingInterval, recovery: recoveryStartInterval };

  it("retries once on a short Retry-After, without entering recovery", () => {
    expect(rateLimitPlan(healthy, limited("17"), now)).toEqual({
      action: "quick_retry",
      delay: 17 + quickRetryMargin,
    });
    expect(rateLimitPlan(healthy, limited(String(quickRetryMaxRetryAfter)), now).action).toBe("quick_retry");
  });

  it("backs off without a usable or short Retry-After", () => {
    expect(rateLimitPlan(healthy, limited(), now)).toEqual(backoff);
    expect(rateLimitPlan(healthy, undefined, now)).toEqual(backoff);
    expect(rateLimitPlan(healthy, limited("soon"), now)).toEqual(backoff);
    expect(rateLimitPlan(healthy, limited(String(quickRetryMaxRetryAfter + 1)), now)).toEqual(backoff);
  });

  it("backs off when the quick retry was rate limited too", () => {
    expect(rateLimitPlan({ ...healthy, rateLimitRetried: true }, limited("17"), now)).toEqual(backoff);
  });

  it("escalates instead of retrying while recovering", () => {
    expect(rateLimitPlan({ ...healthy, recoveryInterval: 300 }, limited("17"), now)).toEqual({
      action: "backoff",
      delay: 2 * readingInterval,
      recovery: 600,
    });
  });
});

describe("recovery floor", () => {
  it("escalates on repeated 429s up to a cap", () => {
    expect(escalatedRecovery(undefined, 30)).toBe(recoveryStartInterval);
    expect(escalatedRecovery(300, 0)).toBe(600);
    expect(escalatedRecovery(600, 0)).toBe(maxRecoveryInterval);
    expect(escalatedRecovery(maxRecoveryInterval, 0)).toBe(maxRecoveryInterval);
    // A server-provided Retry-After longer than the escalated floor wins outright.
    expect(escalatedRecovery(300, 1200)).toBe(1200);
  });

  it("decays toward minInterval then clears", () => {
    let floor = decayedRecovery(recoveryStartInterval);
    expect(floor).toBe(300 * 0.6); // 180
    floor = decayedRecovery(floor); // 108
    floor = decayedRecovery(floor); // 64.8
    expect(floor).toBeGreaterThan(minInterval);
    expect(decayedRecovery(floor)).toBeUndefined(); // 38.88 -> cleared
    expect(decayedRecovery(undefined)).toBeUndefined();
  });

  it("raises the poll floor and cap while recovering", () => {
    expect(pollFloor({})).toBe(minInterval);
    expect(pollFloor({ recoveryInterval: 180 })).toBe(180);
    expect(overduePollCap({})).toBe(readingInterval);
    expect(overduePollCap({ recoveryInterval: 600 })).toBe(600);
  });
});

describe("helpers", () => {
  it("maps time since the last reading to stale levels", () => {
    expect(staleLevel(299)).toBeUndefined();
    expect(staleLevel(300)).toBe(StaleLevel.warning);
    expect(staleLevel(599)).toBe(StaleLevel.warning);
    expect(staleLevel(600)).toBe(StaleLevel.stale);
    expect(staleLevel(900)).toBe(StaleLevel.offline);
  });

  it("trims readings to an activity's window", () => {
    const now = at(3600);
    const readings = [at(0), at(1800), at(3600)].map((date) => ({ value: 100, trend: "Flat" as const, date }));
    expect(trimReadings(readings, 1800, now).map((r) => r.date)).toEqual([at(1800), at(3600)]);
  });

  it("keeps leftovers for 8 hours", () => {
    expect(dataTTLSeconds).toBe(8 * 60 * 60);
  });
});

describe("supersededActivityIDs", () => {
  const entry = (activityID: string, pushToStartToken?: string): TokenEntry => ({
    pushToken: activityID,
    environment: "production",
    startDate: 0,
    duration: 3600,
    activityID,
    pushToStartToken,
  });
  const tokens = [entry("old-same-device", "device-A"), entry("other-device", "device-B"), entry("opted-out")];

  it("lets only a brand-new activity supersede its device's older activities", () => {
    // A new activity on device A replaces device A's older one and nothing else.
    expect(
      supersededActivityIDs(tokens, { activityID: "new", pushToStartToken: "device-A", isNewActivity: true }),
    ).toEqual(["old-same-device"]);

    // A re-registration of a known activity must never delete a sibling — this was the
    // path that starved a freshly started activity of updates.
    expect(
      supersededActivityIDs(tokens, {
        activityID: "old-same-device",
        pushToStartToken: "device-A",
        isNewActivity: false,
      }),
    ).toEqual([]);
    expect(
      supersededActivityIDs(tokens, { activityID: "new", pushToStartToken: "device-A", isNewActivity: false }),
    ).toEqual([]);

    // Opted-out clients (no push-to-start token) never match anything.
    expect(
      supersededActivityIDs(tokens, { activityID: "new", pushToStartToken: undefined, isNewActivity: true }),
    ).toEqual([]);
  });
});
