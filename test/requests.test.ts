import { describe, expect, it } from "vitest";
import {
  basicAuthorization,
  ClientEventSanitizer,
  decodeClientEventRequest,
  decodeEndLiveActivitiesRequest,
  decodeEndLiveActivityRequest,
  decodeRestartLiveActivityRequest,
  decodeStartLiveActivityRequest,
  errorResponse,
  HttpError,
  readJsonObject,
  redactedEmailLogID,
} from "../src/requests";

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("https://luka.example/start-live-activity", { method: "POST", headers, body });
}

function failure(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected an HttpError");
}

async function asyncFailure(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error instanceof HttpError) return error;
  throw new Error(`expected an HttpError, got ${String(error)}`);
}

describe("readJsonObject", () => {
  it("parses a JSON object whatever the content type says", async () => {
    await expect(readJsonObject(post('{"a":1}', { "content-type": "application/json" }))).resolves.toStrictEqual({
      a: 1,
    });
    await expect(readJsonObject(post('{"a":1}', { "content-type": "text/plain" }))).resolves.toStrictEqual({ a: 1 });
    await expect(readJsonObject(post('{"a":1}'))).resolves.toStrictEqual({ a: 1 });
  });

  it.each([
    ["an empty body", "", "Body must be JSON"],
    ["malformed JSON", "{nope", "Body must be JSON"],
    ["an array", "[1]", "Body must be a JSON object"],
    ["null", "null", "Body must be a JSON object"],
  ])("rejects %s with 400", async (_, body, message) => {
    expect(await asyncFailure(readJsonObject(post(body)))).toMatchObject({ status: 400, message });
  });

  it("rejects a body over 64KB with 413", async () => {
    const error = await asyncFailure(readJsonObject(post(JSON.stringify({ a: "x".repeat(64 * 1024) }))));
    expect(error).toMatchObject({ status: 413, message: "Request body too large" });
  });
});

describe("errorResponse", () => {
  it("renders an HttpError's status and message", async () => {
    const response = errorResponse(new HttpError(404, "No matching token"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toStrictEqual({ error: "No matching token" });
  });

  it("hides unexpected errors behind a 500", async () => {
    const response = errorResponse(new Error("storage exploded"));
    expect(response.status).toBe(500);
    expect(await response.json()).toStrictEqual({ error: "Internal error" });
  });
});

describe("decodeStartLiveActivityRequest", () => {
  const minimal = {
    pushToken: "abc123",
    environment: "production",
    username: "kyle@example.com",
    password: "hunter2",
    accountLocation: "usa",
    duration: 28_800,
    activityID: "activity-1",
  };

  it("decodes the required fields and ignores unknown keys", () => {
    expect(decodeStartLiveActivityRequest({ ...minimal, somethingNew: true })).toStrictEqual(minimal);
  });

  it("treats null optionals as absent", () => {
    const body = {
      ...minimal,
      accountID: null,
      sessionID: null,
      preferences: null,
      pushToStartToken: null,
      attributesType: null,
      attributes: null,
      pushToStart: null,
    };
    expect(decodeStartLiveActivityRequest(body)).toStrictEqual(minimal);
  });

  it("decodes every optional field in its Swift wire shape", () => {
    const decoded = decodeStartLiveActivityRequest({
      ...minimal,
      accountID: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      sessionID: "11111111-2222-3333-4444-555555555555",
      preferences: { targetRange: [70, 180], unit: { mmolL: {} }, alertsEnabled: false },
      pushToStartToken: "pts",
      attributesType: "ReadingAttributes",
      attributes: { range: "threeHours", nested: [1, 2.5, null, { a: true }] },
      pushToStart: true,
    });
    expect(decoded).toStrictEqual({
      ...minimal,
      accountID: "6F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B",
      sessionID: "11111111-2222-3333-4444-555555555555",
      preferences: { targetRange: [70, 180], unit: "mmolL", alertsEnabled: false },
      pushToStartToken: "pts",
      attributesType: "ReadingAttributes",
      attributes: { range: "threeHours", nested: [1, 2.5, null, { a: true }] },
      pushToStart: true,
    });
  });

  it("omits alertsEnabled when absent", () => {
    const decoded = decodeStartLiveActivityRequest({
      ...minimal,
      preferences: { targetRange: [70, 180], unit: { mgdl: {} } },
    });
    expect(decoded.preferences).toStrictEqual({ targetRange: [70, 180], unit: "mgdl" });
  });

  const unit = { mgdl: {} };
  it.each<[string, Record<string, unknown>, string]>([
    ["a missing required key", { activityID: undefined }, '"activityID" is required'],
    ["a null required key", { username: null }, '"username" is required'],
    ["a wrong-typed required key", { duration: "8h" }, '"duration" must be a number'],
    ["a wrong-typed optional key", { pushToStart: "yes" }, '"pushToStart" must be a boolean'],
    ["an unknown environment", { environment: "staging" }, '"environment" must be one of development, production'],
    ["an unknown account location", { accountLocation: "eu" }, '"accountLocation" must be one of usa, apac, worldwide'],
    ["an invalid UUID", { accountID: "not-a-uuid" }, '"accountID" must be a UUID'],
    ["a non-object preferences", { preferences: [] }, '"preferences" must be an object'],
    ["a missing target range", { preferences: { unit } }, '"preferences.targetRange" is required'],
    [
      "an inverted target range",
      { preferences: { targetRange: [180, 70], unit } },
      '"preferences.targetRange" must be [lower, upper] with lower ≤ upper',
    ],
    [
      "a one-element target range",
      { preferences: { targetRange: [70], unit } },
      '"preferences.targetRange" must be [lower, upper]',
    ],
    [
      "a fractional target bound",
      { preferences: { targetRange: [70.5, 180], unit } },
      '"preferences.targetRange[0]" must be an integer',
    ],
    [
      "a unit as a bare string",
      { preferences: { targetRange: [70, 180], unit: "mgdl" } },
      '"preferences.unit" must be',
    ],
    [
      "a unit with two cases",
      { preferences: { targetRange: [70, 180], unit: { mgdl: {}, mmolL: {} } } },
      '"preferences.unit" must be',
    ],
    [
      "a unit with no known case",
      { preferences: { targetRange: [70, 180], unit: { mg: {} } } },
      '"preferences.unit" must be',
    ],
    [
      "a unit case that isn't an object",
      { preferences: { targetRange: [70, 180], unit: { mgdl: 1 } } },
      '"preferences.unit" must be',
    ],
  ])("rejects %s with 400", (_, override, message) => {
    const body = JSON.parse(JSON.stringify({ ...minimal, ...override }));
    const error = failure(() => decodeStartLiveActivityRequest(body));
    expect(error.status).toBe(400);
    expect(error.message).toContain(message);
  });

  it("ignores inherited properties", () => {
    expect(failure(() => decodeEndLiveActivitiesRequest({ constructor: 1 } as never)).message).toBe(
      '"username" is required',
    );
  });
});

describe("other request bodies", () => {
  it("decodes end and restart requests, ignoring extra keys", () => {
    const body = { username: "u", activityID: "a", pushToken: "ignored" };
    expect(decodeEndLiveActivityRequest(body)).toStrictEqual({ username: "u", activityID: "a" });
    expect(decodeRestartLiveActivityRequest(body)).toStrictEqual({ username: "u", activityID: "a" });
    expect(decodeEndLiveActivitiesRequest(body)).toStrictEqual({ username: "u" });
    expect(failure(() => decodeEndLiveActivityRequest({ username: "u" })).status).toBe(400);
  });

  it("decodes a client event batch", () => {
    const decoded = decodeClientEventRequest({
      username: "u",
      systemVersion: "26.1",
      deviceModel: null,
      events: [
        { name: "activity_observed", occurredAt: 1_767_268_800.25, activityID: "a", attributes: { k: "v" } },
        { name: "token_received", occurredAt: 1_767_268_801 },
      ],
    });
    expect(decoded).toStrictEqual({
      username: "u",
      systemVersion: "26.1",
      events: [
        { name: "activity_observed", occurredAt: 1_767_268_800.25, activityID: "a", attributes: { k: "v" } },
        { name: "token_received", occurredAt: 1_767_268_801 },
      ],
    });
  });

  it("locates a bad event by index", () => {
    const error = failure(() =>
      decodeClientEventRequest({ username: "u", events: [{ name: "a", occurredAt: 1 }, { name: "b" }] }),
    );
    expect(error.message).toBe('"events[1].occurredAt" is required');
  });

  it("rejects non-string attribute values", () => {
    const error = failure(() =>
      decodeClientEventRequest({ username: "u", events: [{ name: "a", occurredAt: 1, attributes: { n: 1 } }] }),
    );
    expect(error.message).toBe('"events[0].attributes.n" must be a string');
  });
});

describe("redactedEmailLogID", () => {
  it.each([
    ["kyle@example.com", "k•••@example.com"],
    ["k@example.com", "k@example.com"],
    ["no-at-sign", "no-a"],
    ["@example.com", "@exa"],
    ["kyle@", "kyle"],
    ["a@b@c", "a@b@c"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(redactedEmailLogID(input)).toBe(expected);
  });
});

describe("ClientEventSanitizer", () => {
  it("bounds names to lowercase snake_case of 1–40 characters", () => {
    expect(ClientEventSanitizer.name("activity_observed")).toBe("activity_observed");
    expect(ClientEventSanitizer.name("Activity Observed")).toBeUndefined();
    expect(ClientEventSanitizer.name("")).toBeUndefined();
    expect(ClientEventSanitizer.name("a".repeat(40))).toBe("a".repeat(40));
    expect(ClientEventSanitizer.name("a".repeat(41))).toBeUndefined();
    expect(ClientEventSanitizer.name("café")).toBeUndefined();
    expect(ClientEventSanitizer.name("token_2")).toBe("token_2");
  });

  it("drops reserved and malformed keys and truncates values", () => {
    const clean = ClientEventSanitizer.attributes({
      push_to_start: "true",
      user: "spoofed",
      event: "spoofed",
      message: "spoofed",
      "Bad Key": "x",
      long: "v".repeat(500),
    });
    expect(clean).toStrictEqual({ push_to_start: "true", long: "v".repeat(ClientEventSanitizer.maxValueLength) });
  });

  it("keeps the first 16 keys in sorted order", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
    const clean = ClientEventSanitizer.attributes(many);
    expect(Object.keys(clean)).toHaveLength(ClientEventSanitizer.maxAttributes);
    expect(Object.keys(clean)).toEqual(Object.keys(many).sort().slice(0, 16));
    expect(ClientEventSanitizer.attributes(undefined)).toStrictEqual({});
  });

  it("limits keys to 32 characters", () => {
    expect(ClientEventSanitizer.attributes({ ["a".repeat(32)]: "v", ["b".repeat(33)]: "v" })).toStrictEqual({
      ["a".repeat(32)]: "v",
    });
  });
});

describe("basicAuthorization", () => {
  const headers = (authorization: string) => new Headers({ authorization });

  it("decodes username and password", () => {
    expect(basicAuthorization(headers(`Basic ${btoa("kyle@example.com:pa:ss")}`))).toStrictEqual({
      username: "kyle@example.com",
      password: "pa:ss",
    });
    expect(basicAuthorization(headers(`basic ${btoa("u:")}`))).toStrictEqual({ username: "u", password: "" });
  });

  it("decodes UTF-8 credentials", () => {
    const token = btoa(String.fromCharCode(...new TextEncoder().encode("jörg:pässword")));
    expect(basicAuthorization(headers(`Basic ${token}`))).toStrictEqual({ username: "jörg", password: "pässword" });
  });

  it.each([
    ["no header", undefined],
    ["another scheme", `Bearer ${btoa("u:p")}`],
    ["no colon", `Basic ${btoa("user")}`],
    ["invalid base64", "Basic !!!!"],
    ["extra parts", `Basic ${btoa("u:p")} extra`],
  ])("rejects %s", (_, value) => {
    expect(basicAuthorization(value === undefined ? new Headers() : headers(value))).toBeUndefined();
  });
});
