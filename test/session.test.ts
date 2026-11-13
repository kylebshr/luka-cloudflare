import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Registry } from "../src/registry";
import {
  accountID,
  advance,
  counts,
  fastTimeouts,
  gate,
  logID,
  minutes,
  poll,
  post,
  pushToStart,
  reading,
  referenceSeconds,
  seconds,
  session,
  sessionID,
  setTime,
  start,
  stored,
  T0,
  Upstreams,
  useClock,
  username,
} from "./helpers";

let up: Upstreams;

beforeEach(() => {
  useClock();
  up = new Upstreams();
  // No reschedule jitter, so error delays are exact.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

const hours = (n: number) => minutes(n * 60);
const ref = referenceSeconds;
const r1 = reading(120, T0 - minutes(2));
const r0 = reading(115, T0 - minutes(7));
const rateLimitedJSON = () => Response.json({ Code: null, Message: "Too many requests" }, { status: 429 });

/** Registers activity-a and runs the first poll (at T0) with r0, r1 available. */
async function startAndPoll(overrides: Record<string, unknown> = {}) {
  up.readings = [r0, r1];
  expect(await start(overrides)).toBe(200);
  await poll();
}

/** Runs the alarm at an exact time, even if the scheduled poll is later. */
async function pollAt(time: number) {
  await runInDurableObject(session(), (_, state) => state.storage.kv.put("nextPollAt", time));
  setTime(time);
  await runDurableObjectAlarm(session());
}

/** Waits (in real time, leaving the fake clock alone) for a background alarm to reach a gated upstream. */
async function until(condition: () => boolean) {
  for (let attempt = 0; !condition(); attempt++) {
    if (attempt === 1000) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("poll cycle", () => {
  it("logs in, polls, and pushes the reading to the activity", async () => {
    await startAndPoll();

    expect(up.dexcomCalls).toEqual([
      "AuthenticatePublisherAccount",
      "LoginPublisherAccountById",
      "ReadPublisherLatestGlucoseValues",
    ]);
    expect(up.pushes).toHaveLength(1);
    const [push] = up.pushes;
    expect(push?.environment).toBe("production");
    expect(push?.deviceToken).toBe("aaaaaaaa11111111");
    expect(push?.headers).toMatchObject({
      "apns-push-type": "liveactivity",
      "apns-topic": "com.kylebashour.Glimpse.push-type.liveactivity",
      "apns-priority": "10",
      "apns-expiration": String((r1.date + minutes(15)) / 1000),
    });
    expect(push?.aps).toStrictEqual({
      timestamp: T0 / 1000,
      event: "update",
      "content-state": {
        c: { value: 120, trend: "Flat", date: ref(r1.date) },
        h: [
          { t: ref(r0.date), v: 115 },
          { t: ref(r1.date), v: 120 },
        ],
        sd: ref(T0),
        td: ref(T0),
        tc: 1,
        pd: ref(T0),
        ps: false,
      },
      "stale-date": (r1.date + minutes(15)) / 1000,
    });

    const { state, nextPollAt } = await stored();
    expect(state).toMatchObject({
      accountID,
      sessionID,
      sessionStartDate: T0,
      lastReading: r1,
      readings: [r0, r1],
      pollInterval: 60,
      retryCount: 0,
    });
    // The next reading is due 5 minutes after r1, plus the propagation buffer.
    expect(nextPollAt).toBe(r1.date + minutes(5) + seconds(20));
    expect((await stored()).alarm).toBe(nextPollAt);

    expect(up.eventsNamed("session_started")).toEqual([
      expect.objectContaining({
        user: logID,
        environment: "production",
        token_prefix: "aaaaaaaa",
        kind: "new",
        token_count: "1",
        pts_prefix: "none",
        pts_changed: "none",
        launched_by_push: "unknown",
      }),
    ]);
    expect(up.eventsNamed("poll")).toEqual([
      expect.objectContaining({
        user: logID,
        outcome: "success",
        status_code: "200",
        endpoint: "readings",
        latency_ms: "0",
        poll_interval: "60",
        recovery_active: "false",
      }),
    ]);
    expect(up.eventsNamed("push_sent")).toEqual([
      expect.objectContaining({
        user: logID,
        environment: "production",
        token_prefix: "aaaaaaaa",
        kind: "update",
        has_alert: "false",
      }),
    ]);
  });

  it("signs pushes with one shared ES256 provider token", async () => {
    await startAndPoll();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb", environment: "development" });
    up.readings.push(reading(125, T0 + minutes(3)));
    await poll();

    const authorizations = new Set(up.pushes.map((push) => push.headers.authorization));
    expect(authorizations.size).toBe(1);
    const [header, claims] = [...authorizations][0]!.replace("bearer ", "").split(".");
    expect(JSON.parse(atob(header!))).toStrictEqual({ alg: "ES256", typ: "JWT", kid: "TESTKEY123" });
    expect(JSON.parse(atob(claims!))).toStrictEqual({ iss: "TESTTEAM45", iat: T0 / 1000 });
    expect(up.pushesTo("bbbbbbbb")[0]?.environment).toBe("development");
  });

  it("reuses the session ID and pushes a new reading with an alert when it crosses the range", async () => {
    await startAndPoll({ preferences: { targetRange: [70, 180], unit: { mgdl: {} } } });
    up.clear();
    const r2 = reading(200, T0 + minutes(3), "SingleUp");
    up.readings.push(r2);
    await poll();

    expect(up.dexcomCalls).toEqual(["ReadPublisherLatestGlucoseValues"]);
    expect(up.pushes[0]?.aps.alert).toStrictEqual({ title: "High Glucose", body: "Now 200 and rising, was 120." });
    expect(up.eventsNamed("push_sent")[0]).toMatchObject({ has_alert: "true" });
    expect((await stored()).state).toMatchObject({ lastReading: r2, readings: [r0, r1, r2] });
  });

  it("rechecks quickly when the reading is late, then settles onto reading boundaries", async () => {
    await startAndPoll();
    up.clear();

    // The boundary poll (5m20s after r1) misses: first recheck in 20s, then every 30s.
    await poll();
    expect((await stored()).nextPollAt).toBe(Date.now() + seconds(20));
    expect((await stored()).state?.pollInterval).toBe(20);
    await poll();
    expect((await stored()).nextPollAt).toBe(Date.now() + seconds(30));

    // Past the catch-up window (2 minutes after the expected reading): the next boundary.
    await pollAt(r1.date + minutes(8));
    expect((await stored()).nextPollAt).toBe(r1.date + minutes(10) + seconds(20));
    expect((await stored()).state?.pollInterval).toBe(300);
    expect(up.pushes.every((push) => push.aps["content-state"].c.value === 120)).toBe(true);
  });

  it("sends each stale milestone once, at 5, 10, and 15 minutes", async () => {
    await startAndPoll();
    up.clear();

    const staleLevels = () => up.pushes.map((push) => [push.aps["content-state"].s, push.aps["content-state"].r]);
    await poll(); // 5m20s
    await poll(); // 5m40s: same milestone, no push
    expect(staleLevels()).toEqual([[1, "No new readings"]]);

    await pollAt(r1.date + minutes(10));
    await pollAt(r1.date + minutes(12));
    await pollAt(r1.date + minutes(15));
    await pollAt(r1.date + minutes(20));
    expect(staleLevels()).toEqual([
      [1, "No new readings"],
      [2, "No new readings"],
      [3, "No new readings"],
    ]);

    // A milestone push keeps the reading's own content and floors the stale date to now + 2m.
    const offline = up.pushes[2]!;
    expect(offline.aps["content-state"]).toMatchObject({ c: { value: 120 }, tc: 1, ps: false });
    expect(offline.aps["stale-date"]).toBe((r1.date + minutes(17)) / 1000);
    expect(up.eventsNamed("push_sent").map((event) => event.kind)).toEqual(["stale", "stale", "stale"]);

    // A fresh reading resets the ladder.
    up.readings.push(reading(130, Date.now()));
    await pollAt(Date.now() + seconds(10));
    expect((await stored()).state?.lastStaleUpdateMinutes).toBeUndefined();
  });

  it("backs off toward the reading cadence while there's never been a reading", async () => {
    await start();
    await poll();
    expect(up.eventsNamed("poll_empty")).toEqual([
      expect.objectContaining({ user: logID, retry_count: "0", minutes_since_last_reading: "unknown" }),
    ]);
    expect(up.eventsNamed("poll")[0]).toMatchObject({ outcome: "empty" });
    let { state, nextPollAt } = await stored();
    expect(nextPollAt).toBe(T0 + seconds(60));
    expect(state?.pollInterval).toBe(120);

    await poll();
    ({ state, nextPollAt } = await stored());
    expect(nextPollAt).toBe(Date.now() + seconds(120));
    expect(state?.pollInterval).toBe(240);
    await poll();
    await poll();
    expect((await stored()).state?.pollInterval).toBe(300);
  });

  it("treats an empty response with a cached reading as an overdue reading", async () => {
    await startAndPoll();
    up.readings = [];
    up.clear();
    await poll();
    expect(up.eventsNamed("poll_empty")[0]).toMatchObject({ minutes_since_last_reading: "5" });
    expect((await stored()).nextPollAt).toBe(Date.now() + seconds(20));
    expect((await stored()).state?.lastReading).toEqual(r1);
  });

  it("pushes a reading to a device that registered since the last poll", async () => {
    await startAndPoll();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    up.clear();
    up.readings.push(reading(125, T0 + minutes(3)));
    await poll();
    expect(up.pushes.map((push) => [push.deviceToken, push.aps["content-state"].tc])).toEqual([
      ["aaaaaaaa11111111", 2],
      ["bbbbbbbb", 2],
    ]);
  });

  it("trims each activity's history to its own duration", async () => {
    up.readings = [reading(100, T0 - hours(3)), r0, r1];
    await start({ duration: 3600 });
    await poll();
    expect(up.pushes[0]?.aps["content-state"].h).toHaveLength(2);
  });
});

describe("rate limits", () => {
  it("backs off past the next reading, escalates on repeats, and counts the user as rate limited", async () => {
    await startAndPoll();
    up.clear();
    up.dexcom.ReadPublisherLatestGlucoseValues = rateLimitedJSON;

    await poll(); // 5m20s after r1
    expect(up.eventsNamed("poll")[0]).toMatchObject({
      outcome: "error",
      status_code: "429",
      endpoint: "ReadPublisherLatestGlucoseValues",
    });
    expect(up.eventsNamed("poll_error")).toEqual([
      expect.objectContaining({
        user: logID,
        error_type: "dexcom",
        status_code: "429",
        error_code: "unknown",
        retry_after: "none",
        retry_after_header: "none",
        retry_count: "0",
        will_end: "false",
      }),
    ]);
    let { state, nextPollAt } = await stored();
    expect(state).toMatchObject({ recoveryInterval: 300, retryCount: 1, pollInterval: 60 });
    // At least the 300s floor, landing on the 10:20 boundary.
    expect(nextPollAt).toBe(r1.date + minutes(10) + seconds(20));
    expect(up.pushes.map((push) => push.aps["content-state"].r)).toEqual(["Rate limited"]);
    expect(await counts()).toEqual({ sessions: 1, activities: 1, rateLimited: 1 });

    await poll();
    ({ state, nextPollAt } = await stored());
    expect(state).toMatchObject({ recoveryInterval: 600, retryCount: 2 });
    expect(nextPollAt).toBe(r1.date + minutes(20) + seconds(20));
    expect(up.eventsNamed("poll")[1]).toMatchObject({ recovery_active: "true" });

    // Recovery: a healthy poll resets retries and relaxes the floor a step.
    delete up.dexcom.ReadPublisherLatestGlucoseValues;
    const fresh = reading(140, Date.now() - seconds(15));
    up.readings.push(fresh);
    await poll();
    ({ state, nextPollAt } = await stored());
    expect(state).toMatchObject({ recoveryInterval: 360, retryCount: 0, pollInterval: 600 });
    expect(nextPollAt).toBe(fresh.date + minutes(5) + seconds(20));
    expect(await counts()).toMatchObject({ rateLimited: 1 });
  });

  it("honors Retry-After on a Cloudflare-style HTML 429", async () => {
    await startAndPoll();
    up.clear();
    up.dexcom.ReadPublisherLatestGlucoseValues = () =>
      new Response("<html><title>429 Too Many Requests</title></html>", {
        status: 429,
        headers: { "Retry-After": "600" },
      });

    await poll();
    expect(up.eventsNamed("poll_error")).toEqual([
      expect.objectContaining({
        error_type: "decoding",
        status_code: "429",
        endpoint: "ReadPublisherLatestGlucoseValues",
        retry_after: "600",
        retry_after_header: "600",
        retry_count: "0",
        will_end: "false",
        body_prefix: "<html><title>429 Too Many Requests</title></html>",
      }),
    ]);
    expect(up.eventsNamed("poll_error")[0]?.error).toMatch(/^The given data was not valid JSON/);
    const { state, nextPollAt } = await stored();
    expect(state?.recoveryInterval).toBe(600);
    expect(nextPollAt).toBe(r1.date + minutes(15) + seconds(20));
  });

  it("retries once on a short Retry-After, then backs off if that is rate limited too", async () => {
    await startAndPoll();
    up.clear();
    const edgeLimited = () =>
      new Response("Too many requests.", {
        status: 429,
        headers: { "Retry-After": "17", "Set-Cookie": "__cf_bm=secret", "CF-Ray": "abc-SJC" },
      });
    up.dexcom.ReadPublisherLatestGlucoseValues = edgeLimited;

    await poll(); // 5m20s after r1
    const limitedAt = Date.now();
    expect(up.eventsNamed("poll_error")).toEqual([
      expect.objectContaining({
        error_type: "decoding",
        status_code: "429",
        retry_after: "17",
        body_prefix: "Too many requests.",
        rate_limit_action: "quick_retry",
        retry_delay_s: "19",
        recovery_interval: "none",
      }),
    ]);
    const headers = JSON.parse(up.eventsNamed("poll_error")[0]?.response_headers ?? "{}");
    expect(headers).toMatchObject({ "retry-after": "17", "cf-ray": "abc-SJC" });
    expect(headers).not.toHaveProperty("set-cookie");
    let { state, nextPollAt } = await stored();
    expect(state).toMatchObject({ rateLimitRetried: true, retryCount: 1 });
    expect(state?.recoveryInterval).toBeUndefined();
    expect(nextPollAt).toBe(limitedAt + seconds(19));
    expect(await counts()).toMatchObject({ rateLimited: 0 });

    // The retry is limited as well: the header's promise didn't hold, so back off.
    await poll();
    expect(up.eventsNamed("poll_error")[1]).toMatchObject({
      rate_limit_action: "backoff",
      recovery_interval: "300",
    });
    ({ state, nextPollAt } = await stored());
    expect(state).toMatchObject({ recoveryInterval: 300, retryCount: 2 });
    expect(state?.rateLimitRetried).toBeUndefined();
    expect(nextPollAt).toBe(r1.date + minutes(15) + seconds(20));
    expect(await counts()).toMatchObject({ rateLimited: 1 });
  });

  it("picks the reading up on the quick retry and stays out of recovery", async () => {
    await startAndPoll();
    up.clear();
    up.dexcom.ReadPublisherLatestGlucoseValues = () =>
      new Response("Too many requests.", { status: 429, headers: { "Retry-After": "17" } });
    await poll();

    delete up.dexcom.ReadPublisherLatestGlucoseValues;
    const fresh = reading(140, r1.date + minutes(5));
    up.readings.push(fresh);
    await poll();
    const { state, nextPollAt } = await stored();
    expect(state).toMatchObject({ retryCount: 0, pollInterval: 60 });
    expect(state?.lastReading).toEqual(fresh);
    expect(state?.recoveryInterval).toBeUndefined();
    expect(state?.rateLimitRetried).toBeUndefined();
    expect(nextPollAt).toBe(fresh.date + minutes(5) + seconds(20));
    expect(up.eventsNamed("poll_scheduled").at(-1)).toMatchObject({ recovery_interval: "none" });
  });

  it("doesn't let the recovery floor's quick-recheck suppression lapse while it's active", async () => {
    await startAndPoll();
    await runInDurableObject(session(), (_, state) => {
      const poll = state.storage.kv.get<Record<string, unknown>>("state")!;
      state.storage.kv.put("state", { ...poll, recoveryInterval: 120 });
    });
    up.clear();
    await poll(); // overdue, but recovering: no 20s recheck
    expect((await stored()).nextPollAt).toBe(r1.date + minutes(10) + seconds(20));
  });
});

describe("errors", () => {
  it("retries a decoding error with backoff, then ends the session past the retry limit", async () => {
    await startAndPoll();
    up.clear();
    up.dexcom.ReadPublisherLatestGlucoseValues = () => new Response("<html>502</html>", { status: 502 });

    await poll();
    expect(up.eventsNamed("poll_error")[0]).toMatchObject({
      error_type: "decoding",
      status_code: "502",
      will_end: "false",
    });
    expect((await stored()).state).toMatchObject({ retryCount: 1, pollInterval: 60 });
    expect((await stored()).nextPollAt).toBe(Date.now() + seconds(60));
    expect(up.pushes[0]?.aps["content-state"].r).toBe("Dexcom error");

    await runInDurableObject(session(), (_, state) => {
      const poll = state.storage.kv.get<Record<string, unknown>>("state")!;
      state.storage.kv.put("state", { ...poll, retryCount: 11 });
    });
    up.clear();
    await poll();
    expect(up.eventsNamed("poll_error")[0]).toMatchObject({ will_end: "true", retry_count: "11" });
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({ user: logID, reason: "tooManyRetries", token_count: "1" }),
    ]);
    expect(up.pushes.map((push) => push.aps.event)).toEqual(["end"]);
    expect((await stored()).state).toBeUndefined();
    expect((await stored()).ended).toMatchObject({ "activity-a": { reason: "tooManyRetries" } });
  });

  it("retries a network error, then ends after the generic retry limit", async () => {
    await startAndPoll();
    up.clear();
    up.dexcom.ReadPublisherLatestGlucoseValues = () => {
      throw new TypeError("Network connection lost.");
    };
    await poll();
    expect(up.eventsNamed("poll")[0]).toMatchObject({ outcome: "error", status_code: "unknown", endpoint: "unknown" });
    expect(up.eventsNamed("poll_error")[0]).toMatchObject({
      error_type: "generic",
      error: "TypeError: Network connection lost.",
      will_end: "false",
    });
    expect(up.pushes[0]?.aps["content-state"].r).toBe("Polling error");

    for (let attempt = 2; attempt <= 6; attempt++) await poll();
    expect((await stored()).state?.retryCount).toBe(6);
    await poll();
    expect(up.eventsNamed("poll_error").at(-1)).toMatchObject({ will_end: "true" });
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ reason: "tooManyRetries" });
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });

  it("ends the session at once when Dexcom rejects the credentials", async () => {
    up.dexcom.AuthenticatePublisherAccount = () =>
      Response.json({ Code: "AccountPasswordInvalid", Message: "Invalid password" }, { status: 500 });
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    await poll();

    expect(up.dexcomCalls).toEqual(["AuthenticatePublisherAccount"]);
    expect(up.eventsNamed("poll")[0]).toMatchObject({ status_code: "500", endpoint: "AuthenticatePublisherAccount" });
    expect(up.eventsNamed("poll_error")).toEqual([
      expect.objectContaining({
        user: logID,
        error_type: "credentials",
        error_code: "AccountPasswordInvalid",
        error: "DexcomError: Invalid password",
        retry_count: "0",
        will_end: "true",
      }),
    ]);
    expect(up.pushes.map((push) => [push.deviceToken, push.aps.event, push.aps["dismissal-date"]])).toEqual([
      ["aaaaaaaa11111111", "end", undefined],
      ["bbbbbbbb", "end", undefined],
    ]);
    expect(up.eventsNamed("push_ended").map((event) => event.reason)).toEqual(["dexcomError", "dexcomError"]);
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({ reason: "dexcomError", token_count: "2" }),
    ]);
    const after = await stored();
    expect(after.state).toBeUndefined();
    expect(after.tokens).toEqual({});
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });

    // The ended activities stay ended; a new one starts a new session.
    expect(await start()).toBe(410);
    expect(up.eventsNamed("session_start_rejected")[0]).toMatchObject({ reason: "dexcomError" });
    expect(await start({ activityID: "activity-c" })).toBe(200);
    expect(up.eventsNamed("session_started").at(-1)).toMatchObject({ kind: "new" });
  });
});

describe("max duration", () => {
  it("ends an expired activity without restarting it and tears the session down without polling", async () => {
    await startAndPoll();
    up.clear();
    await pollAt(T0 + hours(7));

    expect(up.dexcomCalls).toEqual([]);
    expect(up.pushes).toHaveLength(1);
    expect(up.pushes[0]?.aps).toStrictEqual({
      timestamp: (T0 + hours(7)) / 1000,
      event: "end",
      "content-state": { h: [], se: true, sd: ref(T0), td: ref(T0), tc: 0, pd: ref(T0 + hours(7)) },
    });
    expect(up.eventsNamed("push_ended")).toEqual([
      expect.objectContaining({ user: logID, token_prefix: "aaaaaaaa", reason: "max_duration" }),
    ]);
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({ reason: "all_tokens_expired", expired_count: "1", restarted_count: "0" }),
    ]);
    const after = await stored();
    expect(after.state).toBeUndefined();
    expect(after.ended).toMatchObject({ "activity-a": { reason: "max_duration" } });
    expect(after.restartPending).toBeUndefined();
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });

  it("expires one activity and keeps polling for the rest", async () => {
    await startAndPoll();
    setTime(T0 + hours(4));
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    up.readings.push(reading(140, T0 + hours(7) - minutes(1)));
    up.clear();
    await pollAt(T0 + hours(7));

    expect(up.pushes.map((push) => [push.deviceToken, push.aps.event])).toEqual([
      ["aaaaaaaa11111111", "end"],
      ["bbbbbbbb", "update"],
    ]);
    expect(up.pushes[0]?.aps["content-state"].tc).toBe(1);
    expect(Object.keys((await stored()).tokens)).toEqual(["activity-b"]);
  });

  it("restarts via push-to-start and attributes the device's re-registration", async () => {
    await startAndPoll(pushToStart);
    up.clear();
    const expiry = T0 + hours(7);
    await pollAt(expiry);

    const [end, restart] = up.pushes;
    expect(end?.aps["dismissal-date"]).toBe(0);
    expect(restart?.deviceToken).toBe(pushToStart.pushToStartToken);
    expect(restart?.headers["apns-expiration"]).toBe(String((expiry + minutes(2)) / 1000));
    expect(restart?.aps).toStrictEqual({
      timestamp: expiry / 1000,
      event: "start",
      "content-state": {
        c: { value: 120, trend: "Flat", date: ref(r1.date) },
        h: [
          { t: ref(r0.date), v: 115 },
          { t: ref(r1.date), v: 120 },
        ],
        se: false,
        s: 3,
        sd: ref(T0),
        td: ref(expiry),
        tc: 0,
        pd: ref(expiry),
        r: "Restarted",
        ps: true,
      },
      "stale-date": (expiry + minutes(2)) / 1000,
      alert: { title: "Luka", body: "Glucose monitoring resumed" },
      attributes: { name: "Luka" },
      "attributes-type": "ReadingAttributes",
      "input-push-token": 1,
    });
    expect(up.eventsNamed("push_started")).toEqual([
      expect.objectContaining({
        environment: "production",
        token_prefix: "ptsptspt",
        kind: "push_to_start",
        pts_age_s: "25200",
      }),
    ]);
    expect(up.eventsNamed("push_ended")[0]).toMatchObject({ reason: "max_duration_restarted" });
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ restarted_count: "1" });
    expect((await stored()).restartPending).toMatchObject({
      sentAt: expiry,
      source: "max_duration",
      pushToStartTokenUpdatedAt: T0,
    });

    // The device comes back 30s later with the restarted activity.
    advance(seconds(30));
    expect(await start({ ...pushToStart, activityID: "activity-b", pushToken: "cccccccc", pushToStart: true })).toBe(
      200,
    );
    expect(up.eventsNamed("restart_registered")).toEqual([
      expect.objectContaining({
        user: logID,
        environment: "production",
        kind: "new",
        source: "max_duration",
        latency_s: "30",
        pts_prefix_sent: "ptsptspt",
        pts_prefix_now: "ptsptspt",
        launched_by_push: "true",
      }),
    ]);
    expect(up.eventsNamed("session_started").at(-1)).toMatchObject({
      kind: "new",
      pts_changed: "false",
      launched_by_push: "true",
    });
    const after = await stored();
    // The token's age carries over from the activity it replaced.
    expect(after.tokens["activity-b"]?.pushToStartTokenUpdatedAt).toBe(T0);
    expect(after.restartPending).toBeUndefined();

    // Only the first registration is attributed; the old activity stays ended.
    await start({ ...pushToStart, activityID: "activity-c", pushToken: "dddddddd" });
    expect(up.eventsNamed("restart_registered")).toHaveLength(1);
    expect(await start(pushToStart)).toBe(410);
  });

  it("doesn't restart, or leave a marker, when APNs refuses the start push", async () => {
    await startAndPoll(pushToStart);
    up.clear();
    up.apns = (token) =>
      token === pushToStart.pushToStartToken ? Response.json({ reason: "BadDeviceToken" }, { status: 400 }) : undefined;
    await pollAt(T0 + hours(7));
    expect(up.eventsNamed("push_failed")).toEqual([
      expect.objectContaining({ kind: "push_to_start", error_type: "apns", apns_reason: "BadDeviceToken" }),
    ]);
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ restarted_count: "0" });
    expect((await stored()).restartPending).toBeUndefined();
  });
});

describe("registration", () => {
  it("keeps the start date across a push-token rotation", async () => {
    await start(pushToStart);
    setTime(T0 + hours(1));
    expect(await start({ ...pushToStart, pushToken: "rotated0" })).toBe(200);

    const { tokens } = await stored();
    expect(tokens["activity-a"]).toMatchObject({ pushToken: "rotated0", startDate: T0, pushToStartTokenUpdatedAt: T0 });
    expect(up.eventsNamed("session_started")[1]).toMatchObject({
      kind: "token_added",
      token_count: "1",
      token_prefix: "rotated0",
      pts_changed: "false",
    });

    setTime(T0 + hours(2));
    await start({ ...pushToStart, pushToken: "rotated1", pushToStartToken: "newptstoken" });
    expect((await stored()).tokens["activity-a"]?.pushToStartTokenUpdatedAt).toBe(T0 + hours(2));
    expect(up.eventsNamed("session_started")[2]).toMatchObject({ pts_changed: "true", pts_prefix: "newptsto" });
  });

  it("keeps the session's poll state and schedule when a device joins", async () => {
    await startAndPoll();
    const before = await stored();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb", password: "new-password" });
    const after = await stored();
    expect(after.state).toEqual(before.state);
    expect(after.nextPollAt).toBe(before.nextPollAt);
    expect(after.alarm).toBe(before.nextPollAt);
  });

  it("lets a brand-new activity supersede its device's older one, and refuses the older one afterwards", async () => {
    await start({ ...pushToStart, activityID: "old" });
    await start({ activityID: "other-device", pushToken: "eeeeeeee", pushToStartToken: "other-pts" });
    await start({ activityID: "opted-out", pushToken: "ffffffff" });
    await start({ ...pushToStart, activityID: "new", pushToken: "cccccccc" });

    let after = await stored();
    expect(Object.keys(after.tokens).sort()).toEqual(["new", "opted-out", "other-device"]);
    expect(after.ended).toMatchObject({ old: { reason: "superseded" } });
    expect(up.eventsNamed("session_started").at(-1)).toMatchObject({ token_count: "3" });

    // The stale registration of the dismissed activity, arriving after the new one: 410,
    // and the new activity's token survives.
    expect(await start({ ...pushToStart, activityID: "old" })).toBe(410);
    expect(up.eventsNamed("session_start_rejected")).toEqual([
      expect.objectContaining({
        user: logID,
        reason: "superseded",
        activity_prefix: "old",
        token_prefix: "aaaaaaaa",
        launched_by_push: "unknown",
      }),
    ]);
    // A re-registration of a known activity never supersedes a sibling.
    await start({ ...pushToStart, activityID: "other-device", pushToken: "eeeeeeee" });
    after = await stored();
    expect(Object.keys(after.tokens).sort()).toEqual(["new", "opted-out", "other-device"]);
  });
});

describe("APNs rejections", () => {
  it("drops a dead token and keeps pushing to the others", async () => {
    up.apns = (token) =>
      token === "aaaaaaaa11111111" ? Response.json({ reason: "Unregistered" }, { status: 410 }) : undefined;
    up.readings = [r1];
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    await poll();

    expect(up.eventsNamed("push_failed")).toEqual([
      expect.objectContaining({
        user: logID,
        token_prefix: "aaaaaaaa",
        kind: "update",
        error_type: "apns",
        apns_reason: "Unregistered",
        token_removed: "true",
      }),
    ]);
    const after = await stored();
    expect(Object.keys(after.tokens)).toEqual(["activity-b"]);
    expect(after.ended).toMatchObject({ "activity-a": { reason: "apns_rejected" } });
    expect(after.nextPollAt).toBe(r1.date + minutes(5) + seconds(20));
    expect(await counts()).toMatchObject({ activities: 1 });
  });

  it("keeps a token APNs failed for another reason", async () => {
    up.apns = () => new Response("oops", { status: 500 });
    up.readings = [r1];
    await start();
    await poll();
    expect(up.eventsNamed("push_failed")[0]).toMatchObject({ apns_reason: "unknown", token_removed: "false" });
    expect(Object.keys((await stored()).tokens)).toEqual(["activity-a"]);
  });

  it("tears the session down when every token is dead", async () => {
    up.apns = () => Response.json({ reason: "BadDeviceToken" }, { status: 400 });
    up.readings = [r1];
    await start();
    await poll();
    const after = await stored();
    expect(after.state).toBeUndefined();
    expect(after.ended).toMatchObject({ "activity-a": { reason: "apns_rejected" } });
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });
});

describe("ending", () => {
  it("ends one activity, then the session with the last one", async () => {
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });

    await post("/end-live-activity", { username, activityID: "activity-a" });
    expect(Object.keys((await stored()).tokens)).toEqual(["activity-b"]);
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({
        user: logID,
        reason: "client_end",
        session_removed: "false",
        activity_prefix: "activity",
      }),
    ]);

    await post("/end-live-activity", { username, activityID: "activity-b" });
    expect(up.eventsNamed("session_ended")[1]).toMatchObject({ session_removed: "true" });
    const after = await stored();
    expect(after.state).toBeUndefined();
    expect(after.ended).toMatchObject({
      "activity-a": { reason: "client_end" },
      "activity-b": { reason: "client_end" },
    });
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
    expect(up.pushes).toEqual([]);
  });

  it("dismisses every activity when ending all of them", async () => {
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb", environment: "development" });
    await post("/end-live-activities", { username });

    expect(up.pushes.map((push) => [push.environment, push.deviceToken, push.aps])).toEqual([
      [
        "production",
        "aaaaaaaa11111111",
        { timestamp: T0 / 1000, event: "end", "content-state": { h: [], se: true, pd: ref(T0) }, "dismissal-date": 0 },
      ],
      [
        "development",
        "bbbbbbbb",
        { timestamp: T0 / 1000, event: "end", "content-state": { h: [], se: true, pd: ref(T0) }, "dismissal-date": 0 },
      ],
    ]);
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({ user: logID, reason: "client_end_all", session_removed: "true" }),
    ]);
    const after = await stored();
    expect(after.keys.sort()).toEqual(["ended:activity-a", "ended:activity-b", "username"]);
    expect(after.ended["activity-a"]).toEqual({ reason: "client_end_all", expiresAt: T0 + hours(8) });
    expect(await start()).toBe(410);
  });

  it("is harmless for a user without a session", async () => {
    await post("/end-live-activities", { username: "nobody@example.com" });
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ user: "n•••••@example.com", session_removed: "true" });
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });

  it("deletes itself once the tombstones expire", async () => {
    await start();
    await post("/end-live-activities", { username });
    expect((await stored()).alarm).toBe(T0 + hours(8));

    setTime(T0 + hours(8));
    await runDurableObjectAlarm(session());
    const after = await stored();
    expect(after.keys).toEqual([]);
    expect(after.alarm).toBeNull();
    // The activity can register again (as a new session) once its tombstone is gone.
    expect(await start()).toBe(200);
  });
});

describe("requests landing mid-poll", () => {
  it("pushes to a device that registers while Dexcom is being polled, and keeps its token", async () => {
    up.readings = [r1];
    await start();
    const dexcom = gate();
    up.dexcomGate = dexcom.promise;
    const polling = poll();
    await until(() => up.dexcomCalls.length > 0);

    // Pushed out before the cycle started, so a crash mid-poll still retries.
    expect((await stored()).nextPollAt).toBe(T0 + seconds(60));
    expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb" })).toBe(200);
    dexcom.open();
    await polling;

    expect(up.pushes.map((push) => push.deviceToken)).toEqual(["aaaaaaaa11111111", "bbbbbbbb"]);
    const after = await stored();
    expect(Object.keys(after.tokens).sort()).toEqual(["activity-a", "activity-b"]);
    expect(after.state?.lastReading).toEqual(r1);
    expect(after.nextPollAt).toBe(r1.date + minutes(5) + seconds(20));
  });

  it("doesn't resurrect a session ended while Dexcom is being polled", async () => {
    up.readings = [r1];
    await start();
    const dexcom = gate();
    up.dexcomGate = dexcom.promise;
    const polling = poll();
    await until(() => up.dexcomCalls.length > 0);

    await post("/end-live-activities", { username });
    dexcom.open();
    await polling;

    expect(up.pushes.map((push) => push.aps.event)).toEqual(["end"]);
    const after = await stored();
    expect(after.keys.sort()).toEqual(["ended:activity-a", "username"]);
    expect(after.alarm).toBe(T0 + hours(8));
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });

  it("leaves a session started during the pushes alone when the old one ended mid-poll", async () => {
    up.readings = [r1];
    await start();
    const apns = gate();
    up.apnsGate = apns.promise;
    const polling = poll();
    await until(() => up.pushes.length === 1);

    const ending = post("/end-live-activities", { username });
    await until(() => up.pushes.length === 2);
    setTime(T0 + seconds(5));
    expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb" })).toBe(200);
    apns.open();
    await Promise.all([polling, ending]);

    const after = await stored();
    expect(Object.keys(after.tokens)).toEqual(["activity-b"]);
    // The new session's own fresh state, not the old poll's.
    expect(after.state).toEqual({ sessionStartDate: T0 + seconds(5), pollInterval: 60, retryCount: 0 });
    expect(after.nextPollAt).toBe(T0 + seconds(5));
    expect(await counts()).toEqual({ sessions: 1, activities: 1, rateLimited: 0 });
  });

  it("keeps a token that rotated while APNs was rejecting the previous one", async () => {
    up.readings = [r1];
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    up.apns = (token) =>
      token === "aaaaaaaa11111111" ? Response.json({ reason: "ExpiredToken" }, { status: 410 }) : undefined;
    const apns = gate();
    up.apnsGate = apns.promise;
    const polling = poll();
    await until(() => up.pushes.length === 2);

    expect(await start({ pushToken: "rotated0" })).toBe(200);
    apns.open();
    await polling;

    const after = await stored();
    expect(after.tokens["activity-a"]?.pushToken).toBe("rotated0");
    expect(after.ended).toEqual({});
  });

  it("refuses a late registration for an activity the poll just expired", async () => {
    await startAndPoll(pushToStart);
    const apns = gate();
    up.apnsGate = apns.promise;
    const expiring = pollAt(T0 + hours(7));
    await until(() => up.pushes.length === 2);

    // The old activity's token stream re-yields while the end push is in flight.
    expect(await start(pushToStart)).toBe(410);
    apns.open();
    await expiring;
    expect(up.eventsNamed("session_start_rejected")[0]).toMatchObject({ reason: "max_duration" });
  });
});

describe("Registry", () => {
  const registry = () => env.REGISTRY.getByName("global");

  it("sums sessions and drops users that stopped reporting", async () => {
    await registry().report("a", { activities: 2, rateLimited: 1 });
    await registry().report("b", { activities: 1, rateLimited: 0 });
    expect(await registry().counts()).toEqual({ sessions: 2, activities: 3, rateLimited: 1 });

    await registry().report("a", null);
    expect(await registry().counts()).toEqual({ sessions: 1, activities: 1, rateLimited: 0 });

    setTime(T0 + hours(8));
    expect(await registry().counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });

  it("re-reports unchanged counts hourly so a long session's row stays fresh", async () => {
    await startAndPoll();
    for (let hour = 1; hour <= 6; hour++) {
      up.readings.push(reading(120, T0 + hours(hour)));
      await pollAt(T0 + hours(hour) + seconds(30));
    }
    setTime(T0 + hours(8) + minutes(30));
    expect(await registry().counts()).toEqual({ sessions: 1, activities: 1, rateLimited: 0 });
  });

  it("mints one provider token per 30 minutes and refreshes on demand at most once a minute", async () => {
    const first = await registry().apnsJwt();
    expect(first).toEqual({ token: expect.any(String), refreshAt: T0 + minutes(30) });
    expect(await registry().apnsJwt()).toEqual(first);
    expect(await registry().apnsJwt({ forceRefresh: true })).toEqual(first);

    advance(seconds(61));
    const forced = await registry().apnsJwt({ forceRefresh: true });
    expect(forced?.token).not.toBe(first?.token);

    setTime(T0 + minutes(31) + seconds(1));
    const renewed = await registry().apnsJwt();
    expect(renewed?.token).not.toBe(forced?.token);
    expect(renewed?.refreshAt).toBe(T0 + minutes(61) + seconds(1));
  });
});

describe("without APNs configured", () => {
  /** Clears the APNs secrets as the session object sees them, for this test only. */
  async function withoutApns() {
    await runInDurableObject(session(), (instance) => {
      const sessionEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      const saved = { ...sessionEnv };
      delete sessionEnv.PUSH_NOTIFICATION_PEM;
      onTestFinished(() => {
        Object.assign(sessionEnv, saved);
      });
    });
  }

  it("fails update pushes, skips end pushes, and doesn't restart", async () => {
    up.readings = [r0, r1];
    await start(pushToStart);
    await withoutApns();
    await poll();
    expect(up.pushes).toEqual([]);
    expect(up.eventsNamed("push_failed")).toEqual([
      expect.objectContaining({ kind: "update", error_type: "other", error: "APNSNotConfiguredError" }),
    ]);

    await pollAt(T0 + hours(7));
    expect(up.pushes).toEqual([]);
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ reason: "all_tokens_expired", restarted_count: "0" });
    expect((await stored()).restartPending).toBeUndefined();
  });
});

describe("ending mid-poll registrations", () => {
  const rejectCredentials = () =>
    Response.json({ Code: "AccountPasswordInvalid", Message: "Invalid password" }, { status: 500 });

  /** Polls with Dexcom held, runs `during` while it's held, then lets Dexcom answer. */
  async function pollHolding(during: () => Promise<void>) {
    const dexcom = gate();
    up.dexcomGate = dexcom.promise;
    const polling = poll();
    await until(() => up.dexcomCalls.length > 0);
    await during();
    dexcom.open();
    await polling;
  }

  it("ends only the activities it polled for, and keeps the session for a newcomer", async () => {
    up.dexcom.AuthenticatePublisherAccount = rejectCredentials;
    await start();
    await pollHolding(async () => {
      expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb" })).toBe(200);
    });

    expect(up.pushes.map((push) => [push.deviceToken, push.aps.event])).toEqual([["aaaaaaaa11111111", "end"]]);
    expect(up.eventsNamed("session_ended")[0]).toMatchObject({ reason: "dexcomError", token_count: "1" });
    const after = await stored();
    expect(Object.keys(after.tokens)).toEqual(["activity-b"]);
    expect(Object.keys(after.ended)).toEqual(["activity-a"]);
    expect(after.state).toBeDefined();
    // Polls again on the schedule the cycle set before it started.
    expect(after.nextPollAt).toBe(T0 + seconds(60));
    expect(after.alarm).toBe(T0 + seconds(60));
    expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb" })).toBe(200);
    expect(await counts()).toEqual({ sessions: 1, activities: 1, rateLimited: 0 });
  });

  it("ends nothing and retries at once when a registration brought a new password", async () => {
    up.dexcom.AuthenticatePublisherAccount = rejectCredentials;
    up.readings = [r1];
    await start();
    await pollHolding(async () => {
      expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb", password: "corrected" })).toBe(200);
    });

    expect(up.pushes).toEqual([]);
    expect(up.eventsNamed("poll_error")[0]).toMatchObject({ error_type: "credentials", will_end: "false" });
    expect(up.eventsNamed("session_ended")).toEqual([]);
    let after = await stored();
    expect(Object.keys(after.tokens).sort()).toEqual(["activity-a", "activity-b"]);
    expect(after.ended).toEqual({});
    expect(after.nextPollAt).toBe(T0);
    expect(await start({ activityID: "activity-b", pushToken: "bbbbbbbb", password: "corrected" })).toBe(200);

    delete up.dexcom.AuthenticatePublisherAccount;
    await poll();
    expect(up.pushes.map((push) => push.deviceToken)).toEqual(["aaaaaaaa11111111", "bbbbbbbb"]);
    after = await stored();
    expect(after.state?.lastReading).toEqual(r1);
  });
});

describe("restart marker", () => {
  it("attributes a re-registration that lands before APNs answers the start push", async () => {
    await startAndPoll(pushToStart);
    up.clear();
    const apns = gate();
    up.apnsGate = apns.promise;
    up.apnsGateOnly = pushToStart.pushToStartToken;
    const expiring = pollAt(T0 + hours(7));
    await until(() => up.pushes.length === 2);

    expect(await start({ ...pushToStart, activityID: "activity-b", pushToken: "cccccccc", pushToStart: true })).toBe(
      200,
    );
    expect(up.eventsNamed("restart_registered")).toEqual([
      expect.objectContaining({ kind: "new", source: "max_duration", latency_s: "0" }),
    ]);
    apns.open();
    await expiring;
    expect((await stored()).restartPending).toBeUndefined();
  });

  it("removes its marker when the start push fails, so a later start isn't attributed to it", async () => {
    await startAndPoll(pushToStart);
    up.clear();
    up.apns = (token) =>
      token === pushToStart.pushToStartToken ? Response.json({ reason: "BadDeviceToken" }, { status: 400 }) : undefined;
    await pollAt(T0 + hours(7));
    expect((await stored()).restartPending).toBeUndefined();

    advance(hours(1));
    await start({ activityID: "activity-b", pushToken: "cccccccc" });
    expect(up.eventsNamed("restart_registered")).toEqual([]);
  });

  it("removes the debug restart's marker when its start push fails", async () => {
    await start(pushToStart);
    up.apns = (token) => (token === pushToStart.pushToStartToken ? new Response(null, { status: 500 }) : undefined);
    expect((await post("/restart-live-activity", { username, activityID: "activity-a" })).status).toBe(200);
    expect((await stored()).restartPending).toBeUndefined();
  });
});

describe("upstream timeouts", () => {
  it("fails a stalled Dexcom request like a network error and retries", async () => {
    const requested = fastTimeouts();
    await startAndPoll();
    up.clear();
    up.hang.dexcom = true;
    await poll();

    expect(requested).toContain(30_000);
    expect(up.eventsNamed("poll_error")[0]).toMatchObject({ error_type: "generic", will_end: "false" });
    expect(up.eventsNamed("poll_error")[0]?.error).toMatch(/^TimeoutError/);
    expect((await stored()).state?.retryCount).toBe(1);
    expect((await stored()).nextPollAt).toBe(Date.now() + seconds(60));
  });

  it("fails a stalled APNs send as push_failed and keeps polling", async () => {
    const requested = fastTimeouts();
    up.readings = [r1];
    await start();
    up.hang.apns = true;
    await poll();

    expect(requested.filter((ms) => ms === 30_000).length).toBeGreaterThanOrEqual(2);
    expect(up.eventsNamed("push_failed")).toEqual([
      expect.objectContaining({ kind: "update", error_type: "other", error: "TimeoutError" }),
    ]);
    expect((await stored()).nextPollAt).toBe(r1.date + minutes(5) + seconds(20));
  });
});

describe("alarm failures", () => {
  it("still polls again after a cycle throws unexpectedly", async () => {
    up.readings = [r1];
    await start();
    const log = vi.spyOn(console, "log");
    log.mockImplementation((line: { event?: string }) => {
      if (line.event === "poll") throw new Error("boom");
      up.capture("log", line);
    });
    await poll();
    expect(up.eventsNamed("alarm_failed")).toEqual([expect.objectContaining({ user: logID, error: "Error: boom" })]);

    let after = await stored();
    expect(after.nextPollAt).toBe(T0 + seconds(60));
    expect(after.alarm).toBe(T0 + seconds(60));

    log.mockImplementation((line) => up.capture("log", line));
    await poll();
    after = await stored();
    expect(up.pushes).toHaveLength(1);
    expect(after.state?.lastReading).toEqual(r1);
  });

  it("throws when it can't re-arm, so the runtime retries the alarm", async () => {
    await start();
    await runInDurableObject(session(), async (instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockRejectedValue(new Error("storage unavailable"));
      await expect(instance.alarm()).rejects.toThrow("storage unavailable");
    });
  });
});

describe("Registry reports", () => {
  it("land in the order the session made them", async () => {
    const report = Registry.prototype.report;
    const first = gate();
    let calls = 0;
    vi.spyOn(Registry.prototype, "report").mockImplementation(async function (this: Registry, ...args) {
      if (calls++ === 0) await first.promise;
      return report.apply(this, args);
    });

    const a = start();
    await until(() => calls === 1);
    const b = start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    await until(() => up.eventsNamed("session_started").length === 2);
    first.open();
    await Promise.all([a, b]);
    expect(await counts()).toEqual({ sessions: 1, activities: 2, rateLimited: 0 });
  });

  it("retries a failed report on the next change without undoing a newer one", async () => {
    const report = Registry.prototype.report;
    const first = gate();
    let calls = 0;
    vi.spyOn(Registry.prototype, "report").mockImplementation(async function (this: Registry, ...args) {
      if (calls++ === 0) {
        await first.promise;
        throw new Error("Registry unavailable");
      }
      return report.apply(this, args);
    });

    const a = start();
    await until(() => calls === 1);
    const b = start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    await until(() => up.eventsNamed("session_started").length === 2);
    first.open();
    await Promise.all([a, b]);

    const reported = await runInDurableObject(session(), (_, state) => state.storage.kv.get("reported"));
    expect(reported).toMatchObject({ activities: 2 });
    expect(await counts()).toEqual({ sessions: 1, activities: 2, rateLimited: 0 });
  });

  it("re-reports after a failure once something changes", async () => {
    vi.spyOn(Registry.prototype, "report").mockRejectedValueOnce(new Error("Registry unavailable"));
    await start();
    expect(await runInDurableObject(session(), (_, state) => state.storage.kv.get("reported"))).toBeUndefined();
    expect(await counts()).toEqual({ sessions: 0, activities: 0, rateLimited: 0 });

    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    expect(await counts()).toEqual({ sessions: 1, activities: 2, rateLimited: 0 });
  });
});

describe("logging", () => {
  it("logs only structured events, at their levels, without credentials or full tokens", async () => {
    await startAndPoll({ ...pushToStart, preferences: { targetRange: [70, 180], unit: { mgdl: {} } } });
    await start({ activityID: "activity-b", pushToken: "bbbbbbbbcccccccc" });
    up.apns = (token) =>
      token === "bbbbbbbbcccccccc" ? Response.json({ reason: "Unregistered" }, { status: 410 }) : undefined;
    up.readings.push(reading(200, T0 + minutes(3), "DoubleUp"));
    await poll();
    up.dexcom.ReadPublisherLatestGlucoseValues = rateLimitedJSON;
    await poll();
    await pollAt(T0 + hours(7));
    await post("/client-event", { username, events: [{ name: "app_launch", occurredAt: T0 / 1000 }] });
    await post("/glucose-readings", {});

    expect(up.plainLines).toEqual([]);
    const logged = JSON.stringify(up.events);
    for (const secret of [username, "hunter2", "aaaaaaaa11111111", "bbbbbbbbcccccccc", pushToStart.pushToStartToken]) {
      expect(logged).not.toContain(secret);
    }
    expect(up.levels).toEqual(
      expect.arrayContaining([
        ["log", "session_started"],
        ["log", "poll"],
        ["log", "push_sent"],
        ["error", "push_failed"],
        ["warn", "poll_error"],
        ["log", "poll_scheduled"],
        ["log", "push_ended"],
        ["log", "push_started"],
        ["log", "session_ended"],
        ["log", "client_event"],
      ]),
    );
    expect(up.eventsNamed("poll_scheduled")[0]).toMatchObject({
      user: logID,
      message: "Scheduled for 00:03:20 (in 3m 20s)",
      delay_s: "200",
      poll_interval: "60",
      retry_count: "0",
    });
    expect(up.eventsNamed("push_failed")[0]).toMatchObject({
      message: "APNs error: APNs responded 410 Unregistered, removing token",
      token_removed: "true",
    });
  });

  it("ends the session as apns_rejected when every token is dead", async () => {
    up.apns = () => Response.json({ reason: "BadDeviceToken" }, { status: 400 });
    up.readings = [r1];
    await start();
    await poll();
    expect(up.eventsNamed("session_ended")).toEqual([
      expect.objectContaining({
        user: logID,
        reason: "apns_rejected",
        token_count: "1",
        message: "All tokens invalid, removing session",
      }),
    ]);
  });
});
