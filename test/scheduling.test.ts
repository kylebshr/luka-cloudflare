import { describe, expect, it } from "vitest";
import { DexcomHTTPResponse } from "../src/dexcom";
import {
  dataTTLSeconds,
  decayedRecovery,
  delayUntilNextReading,
  errorQuickRetryLimit,
  errorRetryDelay,
  errorRetryInterval,
  escalatedRecovery,
  honoredRetryAfter,
  maxRecoveryInterval,
  maxRetryAfter,
  overdueCatchupWindow,
  overdueFirstRetryInterval,
  overdueReschedule,
  overdueRetryInterval,
  rateLimitPlan,
  readingInterval,
  readingPropagationBuffer,
  recoveryClearInterval,
  recoveryStartInterval,
  retryAfterMargin,
  retryAfterSpread,
  staleLevel,
  supersededActivityIDs,
  trimReadings,
  unanchoredPollDelay,
} from "../src/scheduling";
import { StaleLevel, type TokenEntry } from "../src/types";

const lastReading = 1_700_000_000_000;
const at = (seconds: number) => lastReading + seconds * 1000;

describe("rate limit rescheduling", () => {
  it("skips to the next reading after a rate limit", () => {
    // Polled 20s after the expected reading and got rate limited: skip the missed reading
    // and aim for the following one, 5 min out.
    expect(delayUntilNextReading(lastReading, at(readingInterval + 20), recoveryStartInterval)).toBe(300);

    // Rate limited 40s *before* a reading is due: don't aim for that imminent reading —
    // skip it and land on the following one (40s + 5m + the buffer).
    expect(delayUntilNextReading(lastReading, at(readingInterval - 40), recoveryStartInterval)).toBe(360);

    // With no prior reading to anchor to, fall back to at least the floor.
    expect(delayUntilNextReading(undefined, at(readingInterval + 20), 600)).toBe(600);
    expect(delayUntilNextReading(undefined, 0)).toBe(readingInterval + readingPropagationBuffer);
  });

  it("caps Retry-After and ignores one that gives nothing to follow", () => {
    const honored = (value?: string) =>
      honoredRetryAfter(new DexcomHTTPResponse(429, undefined, value === undefined ? {} : { "Retry-After": value }));
    expect(honored("600")).toBe(600);
    // A far-future value can't park a session for hours.
    expect(honored("86400")).toBe(maxRetryAfter);

    // No header, an unparseable one, no time in the future, or no response at all.
    expect(honored()).toBeUndefined();
    expect(honored("soon")).toBeUndefined();
    expect(honored("0")).toBeUndefined();
    expect(honored("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    expect(honoredRetryAfter(undefined)).toBeUndefined();
  });
});

describe("overdueReschedule", () => {
  /** A last reading `offset` seconds in the past, found overdue by a boundary poll unless `rechecking`. */
  const overdue = (offset: number, rechecking = false, recovery?: number) =>
    overdueReschedule({
      lastReadingDate: lastReading,
      now: at(offset),
      rechecking,
      recoveryInterval: recovery,
    });

  it("rechecks quickly through the catch-up window", () => {
    // The boundary poll just missed: the first recheck is extra quick.
    const first = overdue(readingInterval + readingPropagationBuffer);
    expect(first).toEqual({ delay: overdueFirstRetryInterval, rechecking: true });

    // A poll that was itself a recheck: the standard cadence from here on.
    const second = overdue(readingInterval + readingPropagationBuffer + overdueFirstRetryInterval, true);
    expect(second).toEqual({ delay: overdueRetryInterval, rechecking: true });

    // Still inside the window a hair before it closes: same standard cadence.
    const late = overdue(readingInterval + overdueCatchupWindow - 1, true);
    expect(late.delay).toBe(overdueRetryInterval);
  });

  it("anchors to reading boundaries past the catch-up window", () => {
    // 7.5 minutes since the last reading: aim for the 10:00 boundary plus the buffer.
    expect(overdue(450, true)).toEqual({ delay: 150 + readingPropagationBuffer, rechecking: false });

    // Deep in a gap, a boundary+buffer poll lands on the next boundary+buffer.
    expect(overdue(10 * readingInterval + readingPropagationBuffer)).toEqual({
      delay: readingInterval,
      rechecking: false,
    });
  });

  it("disables the quick cadence during post-429 recovery", () => {
    // Inside the catch-up window but recovering: aim for the next boundary at least the
    // recovery floor away.
    expect(overdue(readingInterval + 20, false, recoveryStartInterval)).toEqual({
      delay: 280 + readingPropagationBuffer,
      rechecking: false,
    });

    // Even a mostly-decayed floor suppresses the quick cadence.
    expect(overdue(readingInterval + 50, true, 120).delay).toBe(250 + readingPropagationBuffer);

    // Past the window, a boundary sooner than the floor is skipped for the next one.
    expect(overdue(450, false, 240).delay).toBe(450 + readingPropagationBuffer); // 15:00, not 10:00
  });
});

describe("error retries", () => {
  const anchored = { lastReading: { value: 100, trend: "Flat" as const, date: lastReading } };
  const now = at(readingInterval + readingPropagationBuffer);

  it("retries quickly at first, then only at reading boundaries", () => {
    expect(errorRetryDelay({ ...anchored, retryCount: 0 }, now)).toBe(errorRetryInterval);
    expect(errorRetryDelay({ ...anchored, retryCount: errorQuickRetryLimit - 1 }, now)).toBe(errorRetryInterval);
    // A sustained outage: one poll per reading, landing just after each boundary.
    expect(errorRetryDelay({ ...anchored, retryCount: errorQuickRetryLimit }, now)).toBe(readingInterval);
    expect(errorRetryDelay({ ...anchored, retryCount: 50 }, at(readingInterval + 200))).toBe(120);
    // Never had a reading: the reading cadence.
    expect(errorRetryDelay({ retryCount: errorQuickRetryLimit }, now)).toBe(readingInterval + readingPropagationBuffer);
  });

  it("never retries sooner than an active recovery floor", () => {
    expect(errorRetryDelay({ ...anchored, retryCount: 0, recoveryInterval: 180 }, now)).toBe(180);
    expect(errorRetryDelay({ ...anchored, retryCount: errorQuickRetryLimit, recoveryInterval: 600 }, now)).toBe(600);
  });
});

describe("rate limit plan", () => {
  const limited = (retryAfter?: string) =>
    new DexcomHTTPResponse(429, undefined, retryAfter === undefined ? {} : { "Retry-After": retryAfter });
  const healthy = { lastReading: { value: 100, trend: "Flat" as const, date: lastReading } };
  const now = at(readingInterval + readingPropagationBuffer);
  const backoff = { action: "backoff", delay: readingInterval, recovery: recoveryStartInterval };

  it("retries when Retry-After allows, without entering recovery", () => {
    expect(rateLimitPlan(healthy, limited("17"), now, 0)).toEqual({
      action: "retry_after",
      delay: 17 + retryAfterMargin,
    });
    expect(rateLimitPlan(healthy, limited("600"), now, 0)).toEqual({
      action: "retry_after",
      delay: 600 + retryAfterMargin,
    });
    expect(rateLimitPlan(healthy, limited("86400"), now, 0)).toEqual({
      action: "retry_after",
      delay: maxRetryAfter + retryAfterMargin,
    });
  });

  it("spreads retries past the moment Retry-After names", () => {
    expect(rateLimitPlan(healthy, limited("17"), now, 0.5)).toEqual({
      action: "retry_after",
      delay: 17 + retryAfterMargin + retryAfterSpread / 2,
    });
    // A backoff already lands on a reading boundary and isn't spread.
    expect(rateLimitPlan(healthy, limited(), now, 0.5)).toEqual(backoff);
  });

  it("follows Retry-After even while recovering", () => {
    expect(rateLimitPlan({ ...healthy, recoveryInterval: 300 }, limited("17"), now, 0)).toEqual({
      action: "retry_after",
      delay: 17 + retryAfterMargin,
    });
  });

  it("backs off without a usable Retry-After", () => {
    expect(rateLimitPlan(healthy, limited(), now, 0)).toEqual(backoff);
    expect(rateLimitPlan(healthy, undefined, now, 0)).toEqual(backoff);
    expect(rateLimitPlan(healthy, limited("soon"), now, 0)).toEqual(backoff);
    expect(rateLimitPlan(healthy, limited("0"), now, 0)).toEqual(backoff);
  });

  it("escalates the recovery floor on a repeated 429 without a usable Retry-After", () => {
    expect(rateLimitPlan({ ...healthy, recoveryInterval: 300 }, limited(), now, 0)).toEqual({
      action: "backoff",
      delay: 2 * readingInterval,
      recovery: 600,
    });
  });
});

describe("recovery floor", () => {
  it("escalates on repeated 429s up to a cap", () => {
    expect(escalatedRecovery(undefined)).toBe(recoveryStartInterval);
    expect(escalatedRecovery(300)).toBe(600);
    expect(escalatedRecovery(600)).toBe(maxRecoveryInterval);
    expect(escalatedRecovery(maxRecoveryInterval)).toBe(maxRecoveryInterval);
  });

  it("decays toward recoveryClearInterval then clears", () => {
    let floor = decayedRecovery(recoveryStartInterval);
    expect(floor).toBe(300 * 0.6); // 180
    floor = decayedRecovery(floor); // 108
    floor = decayedRecovery(floor); // 64.8
    expect(floor).toBeGreaterThan(recoveryClearInterval);
    expect(decayedRecovery(floor)).toBeUndefined(); // 38.88 -> cleared
    expect(decayedRecovery(undefined)).toBeUndefined();
  });

  it("spaces polls for a session with no reading by the recovery floor", () => {
    expect(unanchoredPollDelay({})).toBe(readingInterval);
    expect(unanchoredPollDelay({ recoveryInterval: 600 })).toBe(600);
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
