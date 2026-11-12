import { describe, expect, it } from "vitest";
import {
  DexcomClient,
  type DexcomClientOptions,
  DexcomDecodingError,
  DexcomError,
  DexcomHTTPResponse,
  isCredentialError,
  lastPathComponent,
} from "../src/dexcom";

const base = "https://share2.dexcom.com/ShareWebServices/Services";
const usaAppID = "d89443d2-327c-4a6f-89e5-496bbb0317db";
const accountID = "aaaaaaaa-1111-2222-3333-444444444444";
const sessionID = "bbbbbbbb-5555-6666-7777-888888888888";

const readingsJSON = [
  { WT: "Date(1714000300000)", ST: "Date(1714000300000)", DT: "Date(1714000300000-0400)", Value: 120, Trend: "Flat" },
  {
    WT: "Date(1714000000000)",
    ST: "Date(1714000000000)",
    DT: "Date(1714000000000-0400)",
    Value: 115,
    Trend: "FortyFiveUp",
  },
];

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A fetch that records requests and answers from `respond`, keyed by endpoint name. */
function mockFetch(respond: (endpoint: string, call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (request: Request) => {
    const call = { url: request.url, method: request.method, headers: request.headers, body: await request.text() };
    calls.push(call);
    return respond(lastPathComponent(request.url)!, call);
  };
  return { calls, fetch, endpoints: () => calls.map((c) => lastPathComponent(c.url)) };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A healthy Share API: auth and login succeed, readings succeed for `validSession`. */
const healthy =
  (validSession = sessionID.toUpperCase()) =>
  (endpoint: string, call: Call) => {
    switch (endpoint) {
      case "AuthenticatePublisherAccount":
        return json(accountID);
      case "LoginPublisherAccountById":
        return json(sessionID);
      default:
        return new URL(call.url).searchParams.get("sessionId") === validSession
          ? json(readingsJSON)
          : json({ Code: "SessionIdNotFound", Message: "Session ID not found" }, 500);
    }
  };

const client = (fetch: DexcomClientOptions["fetch"], options: Partial<DexcomClientOptions> = {}) =>
  new DexcomClient({ username: "kyle@example.com", password: "hunter2", accountLocation: "usa", fetch, ...options });

describe("DexcomClient", () => {
  it("logs in when there's no session, then reads glucose", async () => {
    const mock = mockFetch(healthy());
    const dexcom = client(mock.fetch);

    const readings = await dexcom.getGlucoseReadings();

    expect(readings).toEqual([
      { value: 120, trend: "Flat", date: 1714000300000 },
      { value: 115, trend: "FortyFiveUp", date: 1714000000000 },
    ]);
    expect(dexcom.accountID).toBe(accountID.toUpperCase());
    expect(dexcom.sessionID).toBe(sessionID.toUpperCase());

    const [auth, login, read] = mock.calls;
    expect(auth!.url).toBe(`${base}/General/AuthenticatePublisherAccount`);
    expect(JSON.parse(auth!.body)).toEqual({
      accountName: "kyle@example.com",
      password: "hunter2",
      applicationId: usaAppID,
    });
    expect(login!.url).toBe(`${base}/General/LoginPublisherAccountById`);
    // Swift encodes UUIDs uppercase.
    expect(JSON.parse(login!.body)).toEqual({
      accountId: accountID.toUpperCase(),
      password: "hunter2",
      applicationId: usaAppID,
    });
    expect(read!.url).toBe(
      `${base}/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionID.toUpperCase()}&minutes=1440&maxCount=288`,
    );
    expect(read!.body).toBe("");

    for (const call of mock.calls) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("Accept")).toBe("application/json");
      expect(call.headers.get("Content-Type")).toBe("application/json");
      expect(call.headers.get("User-Agent")).toBe("Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0");
    }
  });

  it("reuses an existing session, sending its ID uppercase", async () => {
    const mock = mockFetch(healthy());
    const dexcom = client(mock.fetch, { accountID, sessionID });

    expect(await dexcom.getGlucoseReadings(10 * 60, 1)).toHaveLength(2);
    expect(mock.endpoints()).toEqual(["ReadPublisherLatestGlucoseValues"]);
    expect(new URL(mock.calls[0]!.url).searchParams.get("minutes")).toBe("10");
    expect(new URL(mock.calls[0]!.url).searchParams.get("maxCount")).toBe("1");
  });

  it("logs in again and retries once when the session ID isn't found", async () => {
    const mock = mockFetch(healthy());
    const dexcom = client(mock.fetch, { accountID, sessionID: "cccccccc-0000-0000-0000-000000000000" });

    expect(await dexcom.getGlucoseReadings()).toHaveLength(2);
    expect(mock.endpoints()).toEqual([
      "ReadPublisherLatestGlucoseValues",
      "AuthenticatePublisherAccount",
      "LoginPublisherAccountById",
      "ReadPublisherLatestGlucoseValues",
    ]);
    expect(dexcom.sessionID).toBe(sessionID.toUpperCase());
  });

  it("uses the APAC host and app ID", async () => {
    const mock = mockFetch(healthy());
    await client(mock.fetch, { accountLocation: "apac" }).getGlucoseReadings();

    expect(mock.calls[0]!.url).toBe(
      "https://share.dexcom.jp/ShareWebServices/Services/General/AuthenticatePublisherAccount",
    );
    expect(JSON.parse(mock.calls[0]!.body).applicationId).toBe("d8665ade-9673-4e27-9ff6-92db4ce13d13");
  });

  it("uses the worldwide host with the US app ID", async () => {
    const mock = mockFetch(healthy());
    await client(mock.fetch, { accountLocation: "worldwide" }).getGlucoseReadings();

    expect(mock.calls[0]!.url).toBe(
      "https://shareous1.dexcom.com/ShareWebServices/Services/General/AuthenticatePublisherAccount",
    );
    expect(JSON.parse(mock.calls[0]!.body).applicationId).toBe(usaAppID);
  });

  it("surfaces Dexcom JSON errors as DexcomError", async () => {
    const mock = mockFetch(() =>
      json(
        {
          Code: "AccountPasswordInvalid",
          Message: "Bad password",
          SubCode: "<OnlineException>",
          TypeName: "FaultException",
        },
        500,
      ),
    );
    const error = await client(mock.fetch)
      .getGlucoseReadings()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DexcomError);
    const dexcomError = error as DexcomError;
    expect(dexcomError.code).toBe("AccountPasswordInvalid");
    expect(dexcomError.message).toBe("Bad password");
    expect(dexcomError.httpResponse?.statusCode).toBe(500);
    expect(lastPathComponent(dexcomError.httpResponse?.url)).toBe("AuthenticatePublisherAccount");
  });

  it("surfaces a JSON 429 as DexcomError with Retry-After", async () => {
    const mock = mockFetch(() => json({ Code: "SSO_AuthenticateMaxAttemptsExceeed" }, 429, { "Retry-After": "120" }));
    const error = (await client(mock.fetch)
      .getGlucoseReadings()
      .catch((e: unknown) => e)) as DexcomError;

    expect(error).toBeInstanceOf(DexcomError);
    expect(error.code).toBe("SSO_AuthenticateMaxAttemptsExceeed");
    expect(error.httpResponse?.statusCode).toBe(429);
    expect(error.httpResponse?.retryAfter).toBe(120);
  });

  it("re-logs in when Dexcom reports the session not valid", async () => {
    // Reads with anything but the freshly issued session fail with SessionNotValid.
    const expired = mockFetch((endpoint, call) =>
      endpoint === "ReadPublisherLatestGlucoseValues" && !call.url.includes(sessionID.toUpperCase())
        ? json({ Code: "SessionNotValid", Message: "Session not active or timed out" }, 500)
        : healthy()(endpoint, call),
    );
    const dexcom = client(expired.fetch, { accountID, sessionID: "cccccccc-0000-0000-0000-000000000000" });

    expect(await dexcom.getGlucoseReadings()).toHaveLength(2);
    expect(expired.endpoints()).toEqual([
      "ReadPublisherLatestGlucoseValues",
      "AuthenticatePublisherAccount",
      "LoginPublisherAccountById",
      "ReadPublisherLatestGlucoseValues",
    ]);
  });

  it("surfaces an HTML 429 on readings without re-authenticating", async () => {
    const html = "<!DOCTYPE html><html><title>Access denied | Cloudflare</title></html>";
    const mock = mockFetch(
      () => new Response(html, { status: 429, headers: { "Content-Type": "text/html", "Retry-After": "120" } }),
    );
    const dexcom = client(mock.fetch, { accountID, sessionID });
    const error = (await dexcom.getGlucoseReadings().catch((e: unknown) => e)) as DexcomDecodingError;

    expect(error).toBeInstanceOf(DexcomDecodingError);
    expect(error.statusCode).toBe(429);
    expect(error.body).toBe(html);
    expect(error.errorDescription).toContain("not valid JSON");
    expect(error.httpResponse.retryAfter).toBe(120);
    expect(error.httpResponse.header("retry-after")).toBe("120");
    expect(mock.endpoints()).toEqual(["ReadPublisherLatestGlucoseValues"]);
    expect(lastPathComponent(error.url)).toBe("ReadPublisherLatestGlucoseValues");
  });

  it("propagates other read failures with an existing session without extra requests", async () => {
    const failures: [string, () => Response][] = [
      ["JSON 429", () => json({ Code: "SSO_AuthenticateMaxAttemptsExceeed" }, 429)],
      ["other Dexcom error", () => json({ Code: "InvalidArgument", Message: "Bad maxCount" }, 500)],
      ["5xx", () => new Response("Bad gateway", { status: 502 })],
      [
        "network error",
        () => {
          throw new TypeError("Network connection lost.");
        },
      ],
    ];
    for (const [name, respond] of failures) {
      const mock = mockFetch(respond);
      const dexcom = client(mock.fetch, { accountID, sessionID });
      await expect(dexcom.getGlucoseReadings(), name).rejects.toBeDefined();
      expect(mock.endpoints(), name).toEqual(["ReadPublisherLatestGlucoseValues"]);
      expect(dexcom.sessionID, name).toBe(sessionID.toUpperCase());
    }
  });

  it("keeps IDs obtained before a later step failed", async () => {
    const mock = mockFetch((endpoint) =>
      endpoint === "AuthenticatePublisherAccount" ? json(accountID) : new Response("Bad gateway", { status: 502 }),
    );
    const dexcom = client(mock.fetch);

    await expect(dexcom.getGlucoseReadings()).rejects.toBeInstanceOf(DexcomDecodingError);
    expect(dexcom.accountID).toBe(accountID.toUpperCase());
    expect(dexcom.sessionID).toBeUndefined();
  });

  it("rejects malformed payloads", async () => {
    const respondWith = (readings: unknown) =>
      mockFetch((endpoint) =>
        endpoint === "ReadPublisherLatestGlucoseValues"
          ? json(readings)
          : json(endpoint.startsWith("Auth") ? accountID : sessionID),
      ).fetch;

    for (const bad of [
      [{ WT: "Date(1)", Value: 120.5, Trend: "Flat" }],
      [{ WT: "Date(1)", Value: 120, Trend: 4 }],
      [{ WT: "Date(1)", Value: 120, Trend: "Sideways" }],
      [{ Value: 120, Trend: "Flat" }],
      "not a list",
    ]) {
      await expect(client(respondWith(bad)).getGlucoseReadings()).rejects.toBeInstanceOf(DexcomDecodingError);
    }

    // An object (rather than a list) decodes as Dexcom's error shape, like the Swift client.
    await expect(client(respondWith({})).getGlucoseReadings()).rejects.toBeInstanceOf(DexcomError);
    // ...unless its Code is one the client doesn't know.
    await expect(client(respondWith({ Code: "Nope" })).getGlucoseReadings()).rejects.toBeInstanceOf(
      DexcomDecodingError,
    );
    // A non-UUID login response is a decoding error too.
    const badLogin = mockFetch(() => json("not-a-uuid")).fetch;
    await expect(client(badLogin).getGlucoseReadings()).rejects.toBeInstanceOf(DexcomDecodingError);
  });

  it("parses WT by trimming non-digits from the ends only", async () => {
    const mock = mockFetch((endpoint) =>
      endpoint === "ReadPublisherLatestGlucoseValues"
        ? json([
            { WT: "/Date(1714000000000)/", Value: 100, Trend: "None" },
            { WT: "Date(1714000000000-0400)", Value: 100, Trend: "None" },
            { WT: "Date()", Value: 100, Trend: "None" },
          ])
        : json(endpoint.startsWith("Auth") ? accountID : sessionID),
    );
    const readings = await client(mock.fetch).getGlucoseReadings();
    expect(readings.map((r) => r.date)).toEqual([1714000000000, 0, 0]);
  });
});

describe("isCredentialError", () => {
  it("matches only Dexcom's credential rejections", () => {
    expect(isCredentialError(new DexcomError("AccountPasswordInvalid", "Bad password"))).toBe(true);
    expect(isCredentialError(new DexcomError("SSO_AuthenticateMaxAttemptsExceeed", undefined))).toBe(true);
    expect(isCredentialError(new DexcomError("SessionNotValid", undefined))).toBe(false);
    expect(isCredentialError(new DexcomError(undefined, undefined))).toBe(false);
    expect(isCredentialError(new Error("AccountPasswordInvalid"))).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
  });

  it("classifies a bad-password login failure", async () => {
    const mock = mockFetch(() => json({ Code: "AccountPasswordInvalid", Message: "Bad password" }, 500));
    const error = await client(mock.fetch)
      .getGlucoseReadings()
      .catch((e: unknown) => e);
    expect(isCredentialError(error)).toBe(true);
    expect(mock.endpoints()).toEqual(["AuthenticatePublisherAccount"]);
  });
});

describe("DexcomHTTPResponse", () => {
  it("lowercases header names, keeping the first of duplicates", () => {
    const response = new DexcomHTTPResponse(429, undefined, { "Retry-After": "5", "X-Thing": "a", "retry-after": "9" });
    expect(response.headers).toEqual({ "retry-after": "5", "x-thing": "a" });
    expect(response.header("RETRY-AFTER")).toBe("5");
  });

  it("parses Retry-After seconds", () => {
    const retryAfter = (value: string) => new DexcomHTTPResponse(429, undefined, { "Retry-After": value }).retryAfter;
    expect(retryAfter("120")).toBe(120);
    expect(retryAfter("1.5")).toBe(1.5);
    expect(retryAfter("-5")).toBe(0);
    expect(retryAfter("")).toBeUndefined();
    expect(retryAfter("soon")).toBeUndefined();
    expect(new DexcomHTTPResponse(429).retryAfter).toBeUndefined();
  });

  it("parses Retry-After HTTP dates relative to now", () => {
    const retryAfter = (value: string) => new DexcomHTTPResponse(429, undefined, { "Retry-After": value }).retryAfter;
    const inTenMinutes = new Date(Date.now() + 600_000).toUTCString();
    expect(retryAfter(inTenMinutes)).toBeGreaterThan(590);
    expect(retryAfter(inTenMinutes)).toBeLessThanOrEqual(600);
    expect(retryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(0);
  });
});

describe("lastPathComponent", () => {
  it("returns the endpoint name, ignoring the query", () => {
    expect(lastPathComponent(`${base}/Publisher/ReadPublisherLatestGlucoseValues?sessionId=x`)).toBe(
      "ReadPublisherLatestGlucoseValues",
    );
    expect(lastPathComponent(undefined)).toBeUndefined();
  });
});
