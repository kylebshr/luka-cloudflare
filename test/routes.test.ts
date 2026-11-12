import { env, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  get,
  logID,
  minutes,
  password,
  poll,
  post,
  pushToStart,
  reading,
  seconds,
  start,
  startBody,
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
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

async function expectBare(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBeNull();
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toStrictEqual({ error });
}

describe("routing", () => {
  it("answers the root with plain text", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Download Luka on the App Store.");
  });

  it("serves robots.txt", async () => {
    const response = await get("/robots.txt");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it.each(["/nope", "/activity-count/extra", "/START-LIVE-ACTIVITY"])(
    "answers an unknown path %s with 404",
    async (path) => {
      await expectError(await get(path), 404, "Not found");
    },
  );

  it("answers a known path with the wrong method with 404", async () => {
    await expectError(await get("/start-live-activity"), 404, "Not found");
    await expectError(await post("/", {}), 404, "Not found");
  });

  it("ignores empty path components", async () => {
    expect((await get("/activity-count/")).status).toBe(200);
    expect((await get("//activity-count")).status).toBe(200);
  });
});

describe("GET /activity-count", () => {
  it("returns JSON counts", async () => {
    await start();
    await start({ activityID: "activity-b", pushToken: "bbbbbbbb" });
    await start({ username: "other@example.com" });

    const response = await get("/activity-count", { accept: "*/*" });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe('{"sessions":2,"activities":3,"rateLimited":0}');
  });

  it.each(["text/html", "application/json, text/html;q=0.9", "TEXT/HTML"])(
    "returns the dashboard for Accept: %s",
    async (accept) => {
      await start();
      const response = await get("/activity-count", { accept });
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<div class="value">1</div>');
    },
  );

  it.each(["*/*", "text/*", "application/json"])("returns JSON for Accept: %s", async (accept) => {
    const response = await get("/activity-count", { accept });
    expect(await response.json()).toStrictEqual({ sessions: 0, activities: 0, rateLimited: 0 });
  });
});

describe("GET /glucose-readings", () => {
  const basic = (user: string, secret: string) => ({ authorization: `Basic ${btoa(`${user}:${secret}`)}` });

  beforeEach(async () => {
    up.readings = [
      reading(100, T0 - minutes(25 * 60)),
      reading(110, T0 - minutes(12)),
      reading(120, T0 - minutes(7), "FortyFiveUp"),
      reading(130, T0 - minutes(2), "SingleUp"),
    ];
  });

  it("needs basic auth", async () => {
    await expectError(await get("/glucose-readings"), 401, "Basic authorization required");
    await expectError(
      await get("/glucose-readings", { authorization: "Bearer abc" }),
      401,
      "Basic authorization required",
    );
  });

  it("is 404 without a session, with the wrong password, or before the first poll", async () => {
    await expectError(await get("/glucose-readings", basic(username, password)), 404, "No cached readings");
    await start();
    await expectError(await get("/glucose-readings", basic(username, password)), 404, "No cached readings");
    await poll();
    await expectError(await get("/glucose-readings", basic(username, "wrong")), 404, "No cached readings");
  });

  it("serves the cached readings ascending, with whole-second ISO dates", async () => {
    await start();
    await poll();
    const response = await get("/glucose-readings", basic(username, password));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // Dexcom serves at most 24h, which drops the 25h-old reading.
    expect(await response.text()).toBe(
      JSON.stringify([
        { value: 110, trend: "Flat", date: "2035-12-31T23:48:00Z" },
        { value: 120, trend: "FortyFiveUp", date: "2035-12-31T23:53:00Z" },
        { value: 130, trend: "SingleUp", date: "2035-12-31T23:58:00Z" },
      ]),
    );
  });

  it("filters by minutes and keeps the newest maxCount", async () => {
    await start();
    await poll();
    const values = async (query: string) =>
      ((await (await get(`/glucose-readings${query}`, basic(username, password))).json()) as { value: number }[]).map(
        (r) => r.value,
      );
    expect(await values("?minutes=10")).toEqual([120, 130]);
    expect(await values("?maxCount=2")).toEqual([120, 130]);
    expect(await values("?minutes=15&maxCount=1")).toEqual([130]);
    expect(await values("?minutes=1")).toEqual([]);
    expect(await values("?maxCount=0")).toEqual([]);
    // Unparseable values fall back to the defaults (1440 minutes, 288 readings).
    expect(await values("?minutes=abc&maxCount=1.5")).toHaveLength(3);
  });
});

describe("POST /start-live-activity", () => {
  it("registers with an empty 200", async () => {
    await expectBare(await post("/start-live-activity", startBody()), 200);
    expect(Object.keys((await stored()).tokens)).toEqual(["activity-a"]);
  });

  it("rejects bodies that aren't valid registrations", async () => {
    await expectError(await post("/start-live-activity", ""), 400, "Body must be JSON");
    await expectError(await post("/start-live-activity", "{nope"), 400, "Body must be JSON");
    await expectError(await post("/start-live-activity", "[]"), 400, "Body must be a JSON object");
    await expectError(
      await post("/start-live-activity", startBody({ environment: "staging" })),
      400,
      '"environment" must be one of development, production',
    );
    await expectError(
      await post("/start-live-activity", startBody({ pad: "x".repeat(64 * 1024) })),
      413,
      "Request body too large",
    );
  });

  it("doesn't need a JSON content type", async () => {
    await expectBare(await post("/start-live-activity", startBody(), { "content-type": "text/plain" }), 200);
  });

  it("emits session_start_failed with what it can recover from the request", async () => {
    const { pushToken: _, ...body } = startBody();
    const response = await post("/start-live-activity", body, { "X-Luka-Version": "3.2", "X-Luka-Build": "77" });
    await expectError(response, 400, '"pushToken" is required');
    expect(up.eventsNamed("session_start_failed")).toEqual([
      expect.objectContaining({
        message: "start-live-activity failed",
        user: logID,
        app_version: "3.2",
        app_build: "77",
        error_type: "invalid_request",
        error: 'HttpError: "pushToken" is required',
      }),
    ]);
    expect(up.levels).toContainEqual(["error", "session_start_failed"]);

    await post("/start-live-activity", "{nope");
    expect(up.eventsNamed("session_start_failed")[1]).toMatchObject({
      user: "unknown",
      app_version: "unknown",
      app_build: "unknown",
    });
  });

  it("answers 410 with an empty body for an ended activity", async () => {
    await start();
    await post("/end-live-activity", { username, activityID: "activity-a" });
    await expectBare(await post("/start-live-activity", startBody()), 410);
  });
});

describe("POST /end-live-activity", () => {
  it("ends one activity with an empty 200", async () => {
    await start();
    await expectBare(
      await post("/end-live-activity", { username, activityID: "activity-a", pushToken: "ignored" }),
      200,
    );
  });

  it("needs both fields", async () => {
    await expectError(await post("/end-live-activity", { username }), 400, '"activityID" is required');
  });
});

describe("POST /end-live-activities", () => {
  it("ends everything with an empty 200", async () => {
    await start();
    await expectBare(await post("/end-live-activities", { username }), 200);
    expect(await (await get("/activity-count")).json()).toMatchObject({ sessions: 0 });
  });

  it("needs a username", async () => {
    await expectError(await post("/end-live-activities", { username: 7 }), 400, '"username" must be a string');
  });
});

describe("POST /restart-live-activity", () => {
  const restart = (activityID = "activity-a") => post("/restart-live-activity", { username, activityID });

  it("is 404 without a session", async () => {
    await expectError(await restart(), 404, "No session found");
  });

  it("is 404 without a matching activity", async () => {
    await start();
    await expectError(await restart("activity-z"), 404, "No matching token");
  });

  it("is 422 without push-to-start info", async () => {
    await start({ pushToStartToken: "pts", attributesType: "ReadingAttributes" });
    await expectError(await restart(), 422, "No push-to-start token for this activity");
  });

  it("dismisses the activity, starts a fresh one, and leaves the session as it is", async () => {
    up.readings = [reading(120, T0 - minutes(2))];
    await start(pushToStart);
    await poll();
    up.clear();

    await expectBare(await restart(), 200);

    const [end, startPush] = up.pushes;
    expect(end).toMatchObject({ deviceToken: "aaaaaaaa11111111", aps: { event: "end", "dismissal-date": 0 } });
    expect(end?.aps["content-state"]).toMatchObject({ se: true, tc: 1 });
    expect(startPush).toMatchObject({
      deviceToken: pushToStart.pushToStartToken,
      aps: {
        event: "start",
        "attributes-type": "ReadingAttributes",
        attributes: { name: "Luka" },
        "input-push-token": 1,
        alert: { title: "Luka", body: "Glucose monitoring resumed" },
      },
    });
    expect(startPush?.aps["content-state"]).toMatchObject({ c: { value: 120 }, r: "Restarted", ps: true, tc: 1 });
    expect(up.eventsNamed("push_started")).toEqual([
      expect.objectContaining({ kind: "push_to_start", token_prefix: "ptsptspt", pts_age_s: "0" }),
    ]);

    const after = await stored();
    expect(Object.keys(after.tokens)).toEqual(["activity-a"]);
    expect(after.restartPending).toMatchObject({ source: "debug", sentAt: T0, pushToStartTokenPrefix: "ptsptspt" });
  });
});

describe("POST /client-event", () => {
  const body = (events: unknown[]) => ({ username, systemVersion: "26.1", deviceModel: "iPhone17,1", events });

  it("sanitizes events and stamps server fields", async () => {
    const response = await post(
      "/client-event",
      body([
        {
          name: "app_launch",
          occurredAt: (T0 - seconds(5)) / 1000 + 0.25,
          activityID: "abcdefgh-1234",
          attributes: {
            app_state: "background",
            user: "spoofed",
            message: "spoofed",
            "Bad Key": "x",
            long: "v".repeat(300),
          },
        },
        { name: "Not Snake Case", occurredAt: T0 / 1000 },
        { name: "token_sent", occurredAt: T0 / 1000 },
      ]),
      { "X-Luka-Version": "3.2", "X-Luka-Build": "77" },
    );
    await expectBare(response, 200);

    const events = up.eventsNamed("client_event");
    expect(events).toHaveLength(2);
    expect(events[0]).toStrictEqual({
      event: "client_event",
      app_state: "background",
      long: "v".repeat(200),
      user: logID,
      client_event: "app_launch",
      client_time: "2035-12-31T23:59:55.250Z",
      client_lag_s: "4",
      app_version: "3.2",
      app_build: "77",
      os_version: "26.1",
      device_model: "iPhone17,1",
      activity_prefix: "abcdefgh",
    });
    expect(events[1]).toMatchObject({ client_event: "token_sent", client_lag_s: "0" });
    expect(events[1]).not.toHaveProperty("activity_prefix");
    expect(events[1]).not.toHaveProperty("restart_source");
  });

  it("defaults missing versions and caps a batch at 50 events", async () => {
    const events = Array.from({ length: 60 }, () => ({ name: "app_launch", occurredAt: T0 / 1000 }));
    await post("/client-event", { username, events });
    const emitted = up.eventsNamed("client_event");
    expect(emitted).toHaveLength(50);
    expect(emitted[0]).toMatchObject({
      app_version: "unknown",
      app_build: "unknown",
      os_version: "unknown",
      device_model: "unknown",
    });
  });

  it("stamps how long after a pending restart each event happened", async () => {
    await start(pushToStart);
    await post("/restart-live-activity", { username, activityID: "activity-a" });
    await post("/client-event", body([{ name: "app_launch", occurredAt: (T0 + seconds(12)) / 1000 }]));
    expect(up.eventsNamed("client_event")[0]).toMatchObject({ restart_source: "debug", since_restart_s: "12" });
  });

  it("rejects an undecodable batch", async () => {
    await expectError(
      await post("/client-event", { username, events: [{ name: "x" }] }),
      400,
      '"events[0].occurredAt" is required',
    );
  });
});

describe("HEAD", () => {
  it.each([
    ["/", 200, "text/plain; charset=utf-8"],
    ["/robots.txt", 200, "text/plain; charset=utf-8"],
    ["/activity-count", 200, "application/json; charset=utf-8"],
    ["/glucose-readings", 401, "application/json"],
    ["/nope", 404, "application/json"],
  ])("answers %s like GET, without a body", async (path, status, contentType) => {
    const response = await exports.default.fetch(`https://luka.test${path}`, { method: "HEAD" });
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(await response.text()).toBe("");
  });
});

describe("Durable Object retries", () => {
  /** Makes the next `count` user-session stubs fail every call with `error`. */
  function failingStubs(error: Error, count: number) {
    const getByName = env.USER_SESSION.getByName.bind(env.USER_SESSION);
    let failures = 0;
    return vi.spyOn(env.USER_SESSION, "getByName").mockImplementation((name) => {
      if (failures++ >= count) return getByName(name);
      return { start: async () => Promise.reject(error) } as unknown as ReturnType<typeof getByName>;
    });
  }

  it("retries a retryable failure once with a fresh stub", async () => {
    const spy = failingStubs(
      Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true }),
      1,
    );
    await expectBare(await post("/start-live-activity", startBody()), 200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(Object.keys((await stored()).tokens)).toEqual(["activity-a"]);
  });

  it("gives up after the retry, and doesn't retry other failures", async () => {
    const retryable = Object.assign(new Error("reset"), { retryable: true });
    let spy = failingStubs(retryable, 2);
    await expectError(await post("/start-live-activity", startBody()), 500, "Internal error");
    expect(spy).toHaveBeenCalledTimes(2);

    expect(up.eventsNamed("request_failed")).toEqual([
      expect.objectContaining({ method: "POST", path: "/start-live-activity", error: "Error: reset" }),
    ]);
    expect(up.levels).toContainEqual(["error", "request_failed"]);

    spy.mockRestore();
    spy = failingStubs(new Error("Durable Object storage is unavailable"), 1);
    await expectError(await post("/start-live-activity", startBody()), 500, "Internal error");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
