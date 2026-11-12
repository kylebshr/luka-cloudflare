import { describe, expect, it, vi } from "vitest";
import { ApnsClient, ApnsError, endPush, mintProviderJwt, startPush, updatePush } from "../src/apns";
import type { GlucoseReading } from "../src/types";

// 2026-01-01T12:00:00Z: 1767268800 s since 1970, 788961600 s since 2001 (Swift's reference date).
const NOW = 1_767_268_800_000;
const NOW_REF = 788_961_600;
const minutes = (n: number) => n * 60_000;

const reading = (value: number, ageMinutes: number, trend: GlucoseReading["trend"] = "Flat"): GlucoseReading => ({
  value,
  trend,
  date: NOW - minutes(ageMinutes),
});

describe("updatePush", () => {
  it("encodes a fresh reading like APNSwift with a default JSONEncoder", () => {
    const latest = reading(120, 1);
    const push = updatePush({
      readings: [reading(115, 6), latest],
      latestReading: latest,
      sessionStartDate: NOW - minutes(180),
      tokenStartDate: NOW - minutes(60),
      tokenCount: 2,
      pushToStartAvailable: false,
      now: NOW,
    });

    // Stale date = reading + 15m (later than now + 2m).
    expect(push.expiration).toBe(1_767_268_740 + 900);
    expect(push.payload).toStrictEqual({
      aps: {
        timestamp: 1_767_268_800,
        event: "update",
        "content-state": {
          c: { value: 120, trend: "Flat", date: NOW_REF - 60 },
          h: [
            { t: NOW_REF - 360, v: 115 },
            { t: NOW_REF - 60, v: 120 },
          ],
          sd: NOW_REF - 10_800,
          td: NOW_REF - 3_600,
          tc: 2,
          pd: NOW_REF,
          ps: false,
        },
        "stale-date": 1_767_269_640,
      },
    });
  });

  it("carries a raw alert as plain title and body", () => {
    const latest = reading(190, 0, "SingleUp");
    const push = updatePush({
      readings: [latest],
      latestReading: latest,
      tokenStartDate: NOW,
      tokenCount: 1,
      pushToStartAvailable: true,
      alert: { title: "High Glucose", body: "Now 190 and rising, was 175." },
      now: NOW,
    });
    expect(push.payload.aps.alert).toStrictEqual({ title: "High Glucose", body: "Now 190 and rising, was 175." });
    expect(push.payload.aps["content-state"]).toMatchObject({ ps: true });
    expect(push.payload.aps["content-state"]).not.toHaveProperty("sd");
  });

  it("encodes a stale milestone and floors the stale date to now + 2m", () => {
    const latest = reading(100, 14);
    const push = updatePush({
      readings: [latest],
      latestReading: latest,
      tokenStartDate: NOW,
      tokenCount: 1,
      staleLevel: 2,
      reason: "No new readings",
      pushToStartAvailable: false,
      now: NOW,
    });
    expect(push.expiration).toBe(1_767_268_800 + 120);
    expect(push.payload.aps["stale-date"]).toBe(1_767_268_800 + 120);
    expect(push.payload.aps["content-state"]).toStrictEqual({
      c: { value: 100, trend: "Flat", date: NOW_REF - 840 },
      h: [{ t: NOW_REF - 840, v: 100 }],
      s: 2,
      td: NOW_REF,
      tc: 1,
      pd: NOW_REF,
      r: "No new readings",
      ps: false,
    });
    expect(push.payload.aps).not.toHaveProperty("alert");
    expect(push.payload.aps).not.toHaveProperty("dismissal-date");
  });
});

describe("endPush", () => {
  it("dismisses immediately with dismissal-date 0 and no expiration", () => {
    const push = endPush({ dismiss: true, now: NOW });
    expect(push.expiration).toBeUndefined();
    expect(push.payload).toStrictEqual({
      aps: {
        timestamp: 1_767_268_800,
        event: "end",
        "content-state": { h: [], se: true, pd: NOW_REF },
        "dismissal-date": 0,
      },
    });
  });

  it("omits dismissal-date when not dismissing", () => {
    const push = endPush({
      sessionStartDate: NOW - minutes(420),
      tokenStartDate: NOW - minutes(60),
      tokenCount: 3,
      dismiss: false,
      now: NOW,
    });
    expect(push.payload).toStrictEqual({
      aps: {
        timestamp: 1_767_268_800,
        event: "end",
        "content-state": { h: [], se: true, sd: NOW_REF - 25_200, td: NOW_REF - 3_600, tc: 3, pd: NOW_REF },
      },
    });
  });
});

describe("startPush", () => {
  it("seeds the new activity with the cached reading and honest staleness", () => {
    const latest = reading(130, 6, "FortyFiveUp");
    const push = startPush({
      attributesType: "ReadingAttributes",
      attributes: { range: "threeHours" },
      latestReading: latest,
      readings: [latest],
      sessionStartDate: NOW - minutes(420),
      tokenCount: 1,
      now: NOW,
    });
    expect(push.expiration).toBe(1_767_268_440 + 900);
    expect(push.payload).toStrictEqual({
      aps: {
        timestamp: 1_767_268_800,
        event: "start",
        "content-state": {
          c: { value: 130, trend: "FortyFiveUp", date: NOW_REF - 360 },
          h: [{ t: NOW_REF - 360, v: 130 }],
          se: false,
          s: 1,
          sd: NOW_REF - 25_200,
          td: NOW_REF,
          tc: 1,
          pd: NOW_REF,
          r: "Restarted",
          ps: true,
        },
        "stale-date": 1_767_269_340,
        alert: { title: "Luka", body: "Glucose monitoring resumed" },
        attributes: { range: "threeHours" },
        "attributes-type": "ReadingAttributes",
        "input-push-token": 1,
      },
    });
  });

  it("falls back to minimal content and empty attributes without a cached reading", () => {
    const push = startPush({ attributesType: "ReadingAttributes", readings: [], tokenCount: 1, now: NOW });
    expect(push.expiration).toBe(1_767_268_800 + 900);
    expect(push.payload.aps).toMatchObject({
      "content-state": { h: [], se: false, pd: NOW_REF, r: "Restarted" },
      "stale-date": 1_767_268_800 + 900,
      attributes: {},
    });
    expect(Object.keys(push.payload.aps["content-state"] as object)).toEqual(["h", "se", "pd", "r"]);
  });

  it("leaves a reading under five minutes old unmarked", () => {
    const latest = reading(130, 4);
    const push = startPush({ attributesType: "A", latestReading: latest, readings: [], tokenCount: 1, now: NOW });
    expect(push.payload.aps["content-state"]).not.toHaveProperty("s");
  });
});

describe("ApnsClient", () => {
  type Sent = { url: string; headers: Record<string, string>; body: unknown };

  function mockFetch(...responses: Response[]) {
    const sent: Sent[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      });
      return responses.shift() ?? new Response(null, { status: 200 });
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
  }

  const push = endPush({ dismiss: true, now: NOW });
  const rejection = (status: number, reason: string) => Response.json({ reason }, { status });

  it("posts to the production host with APNSwift's exact headers", async () => {
    const { fetch, sent } = mockFetch();
    const client = new ApnsClient({ getJwt: async () => "jwt-1", fetch });
    const update = updatePush({
      readings: [],
      latestReading: reading(120, 1),
      tokenStartDate: NOW,
      tokenCount: 1,
      pushToStartAvailable: false,
      now: NOW,
    });

    await client.send("production", "abc123", update);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.push.apple.com/3/device/abc123");
    expect(sent[0]?.headers).toStrictEqual({
      "content-type": "application/json",
      "user-agent": "APNS/swift-nio",
      "apns-push-type": "liveactivity",
      "apns-expiration": "1767269640",
      "apns-priority": "10",
      "apns-topic": "com.kylebashour.Glimpse.push-type.liveactivity",
      authorization: "bearer jwt-1",
    });
    expect(sent[0]?.body).toStrictEqual(update.payload);
  });

  it("omits apns-expiration for an end push and uses the development host", async () => {
    const { fetch, sent } = mockFetch();
    await new ApnsClient({ getJwt: async () => "jwt", fetch }).send("development", "def456", push);
    expect(sent[0]?.url).toBe("https://api.development.push.apple.com/3/device/def456");
    expect(sent[0]?.headers).not.toHaveProperty("apns-expiration");
  });

  it.each(["BadDeviceToken", "Unregistered", "ExpiredToken"])("throws %s as an invalid-token error", async (reason) => {
    const { fetch } = mockFetch(rejection(reason === "BadDeviceToken" ? 400 : 410, reason));
    const error = await new ApnsClient({ getJwt: async () => "jwt", fetch })
      .send("production", "abc", push)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApnsError);
    expect(error).toMatchObject({ reason, isInvalidToken: true });
  });

  it("keeps the status and leaves reason unset for a body without one", async () => {
    const { fetch } = mockFetch(new Response("upstream exploded", { status: 503 }));
    const error = await new ApnsClient({ getJwt: async () => "jwt", fetch })
      .send("production", "abc", push)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApnsError);
    expect(error).toMatchObject({ status: 503, reason: undefined, isInvalidToken: false });
  });

  it("retries once with a refreshed token on ExpiredProviderToken", async () => {
    const { fetch, sent } = mockFetch(rejection(403, "ExpiredProviderToken"));
    const getJwt = vi.fn(async (options?: { forceRefresh?: boolean }) => (options?.forceRefresh ? "fresh" : "stale"));

    await new ApnsClient({ getJwt, fetch }).send("production", "abc", push);

    expect(getJwt.mock.calls).toEqual([[], [{ forceRefresh: true }]]);
    expect(sent.map((request) => request.headers.authorization)).toEqual(["bearer stale", "bearer fresh"]);
  });

  it("gives up after the single retry", async () => {
    const { fetch, sent } = mockFetch(rejection(403, "ExpiredProviderToken"), rejection(403, "ExpiredProviderToken"));
    const error = await new ApnsClient({ getJwt: async () => "jwt", fetch })
      .send("production", "abc", push)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, reason: "ExpiredProviderToken" });
    expect(sent).toHaveLength(2);
  });

  it("doesn't retry other provider-token errors", async () => {
    const { fetch, sent } = mockFetch(rejection(403, "InvalidProviderToken"));
    const error = await new ApnsClient({ getJwt: async () => "jwt", fetch })
      .send("production", "abc", push)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, reason: "InvalidProviderToken" });
    expect(sent).toHaveLength(1);
  });
});

describe("mintProviderJwt", () => {
  async function generatePem() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    const base64 = btoa(String.fromCharCode(...der));
    const lines = base64.match(/.{1,64}/g) ?? [];
    return { pem: ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----"].join("\n"), keys };
  }

  const decode = (part: string) =>
    Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

  async function expectValid(jwt: string, publicKey: CryptoKey) {
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toStrictEqual({
      alg: "ES256",
      typ: "JWT",
      kid: "KEY123",
    });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toStrictEqual({ iss: "TEAM456", iat: 1_767_268_800 });
    expect(jwt).not.toMatch(/[=+/]/);
    const raw = decode(signature);
    expect(raw.byteLength).toBe(64);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  }

  it("signs an ES256 token verifiable with the key's public half", async () => {
    const { pem, keys } = await generatePem();
    const jwt = await mintProviderJwt({
      pem: `${pem}\n`,
      keyID: "KEY123",
      teamID: "TEAM456",
      nowSeconds: 1_767_268_800,
    });
    await expectValid(jwt, keys.publicKey);
  });

  it("tolerates literal \\n escapes and a missing trailing newline", async () => {
    const { pem, keys } = await generatePem();
    const escaped = pem.replaceAll("\n", "\\n");
    const jwt = await mintProviderJwt({
      pem: escaped,
      keyID: "KEY123",
      teamID: "TEAM456",
      nowSeconds: 1_767_268_800.9,
    });
    await expectValid(jwt, keys.publicKey);
  });
});
