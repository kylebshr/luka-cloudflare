// APNs Live Activity pushes: provider-token signing, payload builders, and the HTTP send.
// Payloads and headers reproduce what APNSwift 6 produced for the Vapor server.

import type { Alert } from "./alerts";
import { minStaleDateBuffer, offlineInterval, staleLevel } from "./scheduling";
import type { GlucoseReading, JSONValue, PushEnvironment, StaleLevel } from "./types";

const appBundleID = "com.kylebashour.Glimpse";
const topic = `${appBundleID}.push-type.liveactivity`;

/** A stalled APNs connection shouldn't hold a user's poll. */
const sendTimeout = 30_000;

const hosts: Record<PushEnvironment, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.development.push.apple.com",
};

// MARK: - Provider token

export interface ProviderJwtOptions {
  /** Contents of the `.p8` key (PKCS#8 PEM). Literal `\n` escapes are tolerated. */
  pem: string;
  keyID: string;
  teamID: string;
  nowSeconds: number;
}

/** Mints an ES256 provider token. The result goes in the header as `bearer <jwt>`. */
export async function mintProviderJwt({ pem, keyID, teamID, nowSeconds }: ProviderJwtOptions): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const header = base64url(utf8(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keyID })));
  const claims = base64url(utf8(JSON.stringify({ iss: teamID, iat: Math.floor(nowSeconds) })));
  const signingInput = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is already the raw r||s form JWS requires.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replaceAll("\\n", "\n")
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// MARK: - Payloads

/** A Live Activity push, ready to send: the `apns-expiration` header and the JSON body. */
export interface LiveActivityPush {
  /** Epoch seconds; no `apns-expiration` header when absent. */
  expiration?: number;
  payload: { aps: Record<string, unknown> };
}

/**
 * Content-state as the iOS app decodes it with a default `JSONDecoder`: dates are seconds
 * since 2001-01-01 (`timeIntervalSinceReferenceDate`), absent fields are omitted.
 */
interface ContentState {
  c?: { value: number; trend: string; date: number };
  h: { t: number; v: number }[];
  se?: boolean;
  s?: StaleLevel;
  sd?: number;
  td?: number;
  tc?: number;
  pd?: number;
  r?: string;
  ps?: boolean;
}

interface ContentStateInput {
  current?: GlucoseReading;
  history: GlucoseReading[];
  sessionExpired?: boolean;
  staleLevel?: StaleLevel;
  sessionStartDate?: number;
  tokenStartDate?: number;
  tokenCount?: number;
  pushDate?: number;
  reason?: string;
  pushToStartAvailable?: boolean;
}

const referenceDateOffset = 978_307_200;

/** Epoch ms → Swift `Date`'s default Codable form. */
function referenceSeconds(epochMs: number): number {
  return epochMs / 1000 - referenceDateOffset;
}

function optionalDate(epochMs: number | undefined): number | undefined {
  return epochMs === undefined ? undefined : referenceSeconds(epochMs);
}

function contentState(input: ContentStateInput): ContentState {
  const { current } = input;
  return withoutUndefined({
    c: current && { value: current.value, trend: current.trend, date: referenceSeconds(current.date) },
    h: input.history.map((reading) => ({ t: referenceSeconds(reading.date), v: reading.value })),
    se: input.sessionExpired,
    s: input.staleLevel,
    sd: optionalDate(input.sessionStartDate),
    td: optionalDate(input.tokenStartDate),
    tc: input.tokenCount,
    pd: optionalDate(input.pushDate),
    r: input.reason,
    ps: input.pushToStartAvailable,
  });
}

function withoutUndefined<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

function epochSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

/** The reading's offline-at instant, floored to a small buffer past `now`. Epoch seconds. */
function staleDate(reading: GlucoseReading, now: number): number {
  return epochSeconds(Math.max(reading.date + offlineInterval * 1000, now + minStaleDateBuffer * 1000));
}

export interface UpdatePushInput {
  /** History to display, already trimmed to the activity's duration. */
  readings: GlucoseReading[];
  latestReading: GlucoseReading;
  sessionStartDate?: number;
  tokenStartDate: number;
  tokenCount: number;
  /** Set for stale-milestone pushes; absent for a fresh reading. */
  staleLevel?: StaleLevel;
  reason?: string;
  pushToStartAvailable: boolean;
  alert?: Alert;
  now: number;
}

/** A reading update or stale milestone (`sendActivityPush` in the Vapor server). */
export function updatePush(input: UpdatePushInput): LiveActivityPush {
  const stale = staleDate(input.latestReading, input.now);
  return {
    // Matching the stale date means APNs drops the push once the OS would show it stale anyway.
    expiration: stale,
    payload: {
      aps: withoutUndefined({
        timestamp: epochSeconds(input.now),
        event: "update",
        "content-state": contentState({
          current: input.latestReading,
          history: input.readings,
          staleLevel: input.staleLevel,
          sessionStartDate: input.sessionStartDate,
          tokenStartDate: input.tokenStartDate,
          tokenCount: input.tokenCount,
          pushDate: input.now,
          reason: input.reason,
          pushToStartAvailable: input.pushToStartAvailable,
        }),
        "stale-date": stale,
        alert: input.alert && { title: input.alert.title, body: input.alert.body },
      }),
    },
  };
}

export interface EndPushInput {
  sessionStartDate?: number;
  tokenStartDate?: number;
  tokenCount?: number;
  /** Remove the activity from the lock screen now rather than letting the system linger it. */
  dismiss: boolean;
  now: number;
}

/** Ends an activity (`sendEndEvent` in the Vapor server). */
export function endPush(input: EndPushInput): LiveActivityPush {
  return {
    payload: {
      aps: withoutUndefined({
        timestamp: epochSeconds(input.now),
        event: "end",
        "content-state": contentState({
          history: [],
          sessionExpired: true,
          sessionStartDate: input.sessionStartDate,
          tokenStartDate: input.tokenStartDate,
          tokenCount: input.tokenCount,
          pushDate: input.now,
        }),
        "dismissal-date": input.dismiss ? 0 : undefined,
      }),
    },
  };
}

export interface StartPushInput {
  attributesType: string;
  attributes?: JSONValue;
  /** The last cached reading, to seed the new activity; absent if none is cached. */
  latestReading?: GlucoseReading;
  readings: GlucoseReading[];
  sessionStartDate?: number;
  tokenCount: number;
  now: number;
}

/** Push-to-start restart of a fresh activity (`sendStartEvent` in the Vapor server). */
export function startPush(input: StartPushInput): LiveActivityPush {
  const { latestReading, now } = input;
  const state = latestReading
    ? contentState({
        current: latestReading,
        history: input.readings,
        sessionExpired: false,
        staleLevel: staleLevel((now - latestReading.date) / 1000),
        sessionStartDate: input.sessionStartDate,
        tokenStartDate: now,
        tokenCount: input.tokenCount,
        pushDate: now,
        reason: "Restarted",
        pushToStartAvailable: true,
      })
    : contentState({ history: [], sessionExpired: false, pushDate: now, reason: "Restarted" });
  const stale = latestReading ? staleDate(latestReading, now) : epochSeconds(now + offlineInterval * 1000);

  return {
    // A real expiration (not immediate) lets APNs store and retry the start push if the
    // device is briefly unreachable; otherwise one missed delivery means no restart.
    expiration: stale,
    payload: {
      aps: {
        timestamp: epochSeconds(now),
        event: "start",
        "content-state": state,
        "stale-date": stale,
        alert: { title: "Luka", body: "Glucose monitoring resumed" },
        attributes: input.attributes ?? {},
        "attributes-type": input.attributesType,
        // iOS 18+: wake the app with an update token for the new activity.
        "input-push-token": 1,
      },
    },
  };
}

// MARK: - Client

/** APNs refused the push. `reason` is APNs' reason string, absent if the body had none. */
export class ApnsError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
  ) {
    super(`APNs responded ${status}${reason ? ` ${reason}` : ""}`);
    this.name = "ApnsError";
  }

  /** The device token is dead and should be dropped. */
  get isInvalidToken(): boolean {
    return this.reason === "BadDeviceToken" || this.reason === "Unregistered" || this.reason === "ExpiredToken";
  }
}

export interface ApnsClientOptions {
  /** The current provider token; `forceRefresh` asks for a newly minted one. */
  getJwt: (options?: { forceRefresh?: boolean }) => Promise<string>;
  fetch?: typeof fetch;
}

export class ApnsClient {
  private readonly getJwt: ApnsClientOptions["getJwt"];
  private readonly fetch: typeof fetch;

  constructor(options: ApnsClientOptions) {
    this.getJwt = options.getJwt;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Sends one push to an activity's update token (or a push-to-start token for `startPush`).
   * Throws `ApnsError` when APNs refuses it, after one retry with a fresh provider token if
   * APNs reports the current one expired.
   */
  async send(environment: PushEnvironment, deviceToken: string, push: LiveActivityPush): Promise<void> {
    try {
      await this.attempt(environment, deviceToken, push, await this.getJwt());
    } catch (error) {
      if (!(error instanceof ApnsError && error.reason === "ExpiredProviderToken")) throw error;
      await this.attempt(environment, deviceToken, push, await this.getJwt({ forceRefresh: true }));
    }
  }

  private async attempt(
    environment: PushEnvironment,
    deviceToken: string,
    push: LiveActivityPush,
    jwt: string,
  ): Promise<void> {
    const response = await this.fetch(`${hosts[environment]}/3/device/${deviceToken}`, {
      method: "POST",
      headers: requestHeaders(push, jwt),
      body: JSON.stringify(push.payload),
      signal: AbortSignal.timeout(sendTimeout),
    });
    if (response.status === 200) return;
    throw new ApnsError(response.status, await errorReason(response));
  }
}

function requestHeaders(push: LiveActivityPush, jwt: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "APNS/swift-nio",
    "apns-push-type": "liveactivity",
    ...(push.expiration !== undefined && { "apns-expiration": String(push.expiration) }),
    "apns-priority": "10",
    "apns-topic": topic,
    authorization: `bearer ${jwt}`,
  };
}

async function errorReason(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string") {
      return body.reason;
    }
  } catch {
    // Empty or non-JSON body: the error carries the status alone.
  }
  return undefined;
}
