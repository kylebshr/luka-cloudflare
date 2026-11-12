// Request parsing and validation, error responses, and small text helpers for logging.

import type {
  AccountLocation,
  ClientEvent,
  ClientEventRequest,
  EndLiveActivitiesRequest,
  EndLiveActivityRequest,
  GlucoseUnit,
  JSONValue,
  LiveActivityPreferences,
  PushEnvironment,
  RestartLiveActivityRequest,
  StartLiveActivityRequest,
} from "./types";

// MARK: - Errors

/** An error the router answers with `status` and `{"error": message}`. */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The response for a thrown error: its own status and message, or a 500 for anything unexpected. */
export function errorResponse(error: unknown): Response {
  const { status, message } = error instanceof HttpError ? error : { status: 500, message: "Internal error" };
  return Response.json({ error: message }, { status });
}

// MARK: - Body

/** Abuse protection; real request bodies are a few kilobytes at most. */
const maxBodyBytes = 64 * 1024;

type Json = Record<string, unknown>;

/** Reads a JSON object body: 413 when too large, 400 when not a JSON object. */
export async function readJsonObject(request: Request): Promise<Json> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBodyBytes) throw new HttpError(413, "Request body too large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (!isObject(body)) throw new HttpError(400, "Body must be a JSON object");
  return body;
}

// MARK: - Validation

/** Validates one value; `name` is its path in the body, for the error message. */
type Check<T> = (value: unknown, name: string) => T;

function invalid(name: string, expected: string): HttpError {
  return new HttpError(400, `"${name}" must be ${expected}`);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(object: Json, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function path(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/** A required field; absent and `null` are both missing. */
function required<T>(object: Json, key: string, check: Check<T>, parent = ""): T {
  const value = own(object, key);
  if (value === undefined || value === null) throw new HttpError(400, `"${path(parent, key)}" is required`);
  return check(value, path(parent, key));
}

/** An optional field; absent and `null` both decode to undefined. */
function optional<T>(object: Json, key: string, check: Check<T>, parent = ""): T | undefined {
  const value = own(object, key);
  return value === undefined || value === null ? undefined : check(value, path(parent, key));
}

const string: Check<string> = (value, name) => {
  if (typeof value !== "string") throw invalid(name, "a string");
  return value;
};

const number: Check<number> = (value, name) => {
  if (typeof value !== "number") throw invalid(name, "a number");
  return value;
};

const boolean: Check<boolean> = (value, name) => {
  if (typeof value !== "boolean") throw invalid(name, "a boolean");
  return value;
};

const integer: Check<number> = (value, name) => {
  if (!Number.isSafeInteger(value)) throw invalid(name, "an integer");
  return value as number;
};

const object: Check<Json> = (value, name) => {
  if (!isObject(value)) throw invalid(name, "an object");
  return value;
};

function oneOf<T extends string>(values: readonly T[]): Check<T> {
  return (value, name) => {
    if (!values.includes(value as T)) throw invalid(name, `one of ${values.join(", ")}`);
    return value as T;
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stored uppercase, as Dexcom's own IDs are. */
const uuid: Check<string> = (value, name) => {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw invalid(name, "a UUID");
  return value.toUpperCase();
};

/** Swift `ClosedRange<Int>`: `[lower, upper]` with lower ≤ upper. */
const range: Check<[number, number]> = (value, name) => {
  if (!Array.isArray(value) || value.length !== 2) throw invalid(name, "[lower, upper]");
  const [lower, upper] = value.map((bound, index) => integer(bound, `${name}[${index}]`)) as [number, number];
  if (lower > upper) throw invalid(name, "[lower, upper] with lower ≤ upper");
  return [lower, upper];
};

const glucoseUnits: readonly GlucoseUnit[] = ["mgdl", "mmolL"];

/** The app's unit enum as Swift encodes it: exactly one known case key, e.g. `{"mgdl":{}}`. */
const glucoseUnit: Check<GlucoseUnit> = (value, name) => {
  const cases = isObject(value) ? Object.entries(value) : [];
  const [unit, payload] = cases[0] ?? [];
  if (cases.length !== 1 || !glucoseUnits.includes(unit as GlucoseUnit) || !isObject(payload)) {
    throw invalid(name, `{"mgdl":{}} or {"mmolL":{}}`);
  }
  return unit as GlucoseUnit;
};

const preferences: Check<LiveActivityPreferences> = (value, name) => {
  const fields = object(value, name);
  return withoutUndefined({
    targetRange: required(fields, "targetRange", range, name),
    unit: required(fields, "unit", glucoseUnit, name),
    alertsEnabled: optional(fields, "alertsEnabled", boolean, name),
  });
};

const stringMap: Check<Record<string, string>> = (value, name) => {
  const fields = object(value, name);
  return Object.fromEntries(Object.keys(fields).map((key) => [key, string(fields[key], path(name, key))]));
};

const json: Check<JSONValue> = (value) => value as JSONValue;

function withoutUndefined<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

export function decodeStartLiveActivityRequest(body: Json): StartLiveActivityRequest {
  return withoutUndefined({
    pushToken: required(body, "pushToken", string),
    environment: required(body, "environment", oneOf<PushEnvironment>(["development", "production"])),
    username: required(body, "username", string),
    password: required(body, "password", string),
    accountID: optional(body, "accountID", uuid),
    sessionID: optional(body, "sessionID", uuid),
    accountLocation: required(body, "accountLocation", oneOf<AccountLocation>(["usa", "apac", "worldwide"])),
    duration: required(body, "duration", number),
    preferences: optional(body, "preferences", preferences),
    activityID: required(body, "activityID", string),
    pushToStartToken: optional(body, "pushToStartToken", string),
    attributesType: optional(body, "attributesType", string),
    attributes: optional(body, "attributes", json),
    pushToStart: optional(body, "pushToStart", boolean),
  });
}

export function decodeEndLiveActivityRequest(body: Json): EndLiveActivityRequest {
  return { username: required(body, "username", string), activityID: required(body, "activityID", string) };
}

export function decodeEndLiveActivitiesRequest(body: Json): EndLiveActivitiesRequest {
  return { username: required(body, "username", string) };
}

export function decodeRestartLiveActivityRequest(body: Json): RestartLiveActivityRequest {
  return { username: required(body, "username", string), activityID: required(body, "activityID", string) };
}

const clientEvent: Check<ClientEvent> = (value, name) => {
  const fields = object(value, name);
  return withoutUndefined({
    name: required(fields, "name", string, name),
    occurredAt: required(fields, "occurredAt", number, name),
    activityID: optional(fields, "activityID", string, name),
    attributes: optional(fields, "attributes", stringMap, name),
  });
};

const clientEvents: Check<ClientEvent[]> = (value, name) => {
  if (!Array.isArray(value)) throw invalid(name, "an array");
  return value.map((event, index) => clientEvent(event, `${name}[${index}]`));
};

export function decodeClientEventRequest(body: Json): ClientEventRequest {
  return withoutUndefined({
    username: required(body, "username", string),
    systemVersion: optional(body, "systemVersion", string),
    deviceModel: optional(body, "deviceModel", string),
    events: required(body, "events", clientEvents),
  });
}

// MARK: - Logging helpers

/** Redacts an email for logging: "kyle@example.com" → "k•••@example.com". */
export function redactedEmailLogID(username: string): string {
  const at = username.indexOf("@");
  if (at <= 0 || at === username.length - 1) return username.slice(0, 4);
  return `${username[0]}${"•".repeat(at - 1)}${username.slice(at)}`;
}

/** Bounds and cleans untrusted client event data before it becomes log fields. */
export const ClientEventSanitizer = {
  maxEvents: 50,
  maxAttributes: 16,
  maxValueLength: 200,
  /** Fields the server stamps itself; a client must not be able to spoof them. */
  reservedKeys: new Set([
    "event",
    "message",
    "user",
    "client_event",
    "client_time",
    "client_lag_s",
    "activity_prefix",
    "app_version",
    "app_build",
    "os_version",
    "device_model",
    "restart_source",
    "since_restart_s",
  ]) as ReadonlySet<string>,

  /** Lowercase snake_case, 1–40 characters. Anything else is dropped. */
  name(raw: string): string | undefined {
    return /^[a-z0-9_]{1,40}$/.test(raw) ? raw : undefined;
  },

  /** Keeps at most `maxAttributes` well-formed keys, truncates values, drops reserved keys. */
  attributes(raw: Record<string, string> | undefined): Record<string, string> {
    const clean: Record<string, string> = {};
    const entries = Object.entries(raw ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [key, value] of entries) {
      if (Object.keys(clean).length >= this.maxAttributes) break;
      if (!/^[a-z0-9_]{1,32}$/.test(key) || this.reservedKeys.has(key)) continue;
      clean[key] = value.slice(0, this.maxValueLength);
    }
    return clean;
  },
};

// MARK: - Headers

/** Credentials from an `Authorization: Basic …` header. */
export function basicAuthorization(headers: Headers): { username: string; password: string } | undefined {
  const token = /^basic\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  if (token === undefined) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(token), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
