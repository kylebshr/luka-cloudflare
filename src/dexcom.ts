// Dexcom Share API client. A port of `dexcom-swift`'s `DexcomClient` with the same wire
// behavior (URLs, app IDs, headers, bodies, error taxonomy), except that it re-logs in
// only when the session expired rather than after any failure.

import type { AccountLocation, GlucoseReading, TrendDirection } from "./types";

const baseURLs: Record<AccountLocation, string> = {
  usa: "https://share2.dexcom.com/ShareWebServices/Services",
  apac: "https://share.dexcom.jp/ShareWebServices/Services",
  worldwide: "https://shareous1.dexcom.com/ShareWebServices/Services",
};

const appIDs: Record<AccountLocation, string> = {
  usa: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  apac: "d8665ade-9673-4e27-9ff6-92db4ce13d13",
  worldwide: "d89443d2-327c-4a6f-89e5-496bbb0317db",
};

const loginEndpoint = "General/LoginPublisherAccountById";
const authenticateEndpoint = "General/AuthenticatePublisherAccount";
const readingsEndpoint = "Publisher/ReadPublisherLatestGlucoseValues";

/** A stalled Share request shouldn't hold a user's poll; it fails like a network error. */
const requestTimeout = 30_000;

/** Seconds. The longest window the Share API serves. */
export const maxGlucoseDuration = 24 * 60 * 60;
/** One reading per 5 minutes across `maxGlucoseDuration`. */
export const maxGlucoseCount = maxGlucoseDuration / 60 / 5;

const trendDirections: ReadonlySet<string> = new Set<TrendDirection>([
  "None",
  "DoubleUp",
  "SingleUp",
  "FortyFiveUp",
  "Flat",
  "FortyFiveDown",
  "SingleDown",
  "DoubleDown",
  "NotComputable",
  "RateOutOfRange",
]);

const errorCodes = [
  "SessionIdNotFound",
  "SessionNotValid",
  "AccountPasswordInvalid",
  "SSO_AuthenticateMaxAttemptsExceeed",
  "InvalidArgument",
] as const;
export type DexcomErrorCode = (typeof errorCodes)[number];

// MARK: - Errors

/** Metadata from the HTTP response that produced an error. */
export class DexcomHTTPResponse {
  /** All response header fields, keyed by lowercased header name. */
  readonly headers: Record<string, string>;

  constructor(
    readonly statusCode: number,
    readonly url?: string,
    headers: Record<string, string> = {},
  ) {
    this.headers = {};
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] ??= value;
    }
  }

  static from(response: Response, requestURL: string): DexcomHTTPResponse {
    // A fetched response always has a URL; a hand-built one (tests) doesn't.
    return new DexcomHTTPResponse(response.status, response.url || requestURL, Object.fromEntries(response.headers));
  }

  /** The value of a header field, matched case-insensitively. */
  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   * Seconds from the `Retry-After` header, if present. Supports both the delay-seconds
   * and HTTP-date forms; the HTTP-date form is converted to a delay relative to now.
   */
  get retryAfter(): number | undefined {
    const value = this.header("Retry-After");
    if (value === undefined) return undefined;

    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
      return Math.max(0, Number(value));
    }

    const date = parseHTTPDate(value);
    if (date !== undefined) {
      return Math.max(0, (date - Date.now()) / 1000);
    }

    return undefined;
  }
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses `EEE, dd MMM yyyy HH:mm:ss GMT` (IMF-fixdate) to epoch ms. */
function parseHTTPDate(value: string): number | undefined {
  const match = /^[A-Z][a-z]{2}, (\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|UTC)$/.exec(value);
  if (!match) return undefined;
  const [, day, month, year, hour, minute, second] = match;
  const monthIndex = months.indexOf(month ?? "");
  if (monthIndex < 0) return undefined;
  return Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
}

/** An error response from Dexcom whose body decoded as Dexcom's JSON error shape. */
export class DexcomError extends Error {
  override readonly name = "DexcomError";

  constructor(
    readonly code: DexcomErrorCode | undefined,
    message: string | undefined,
    /** The HTTP response that carried this error, including headers such as `Retry-After`. */
    readonly httpResponse?: DexcomHTTPResponse,
  ) {
    super(message ?? "");
  }
}

function hasCode(error: unknown, codes: readonly DexcomErrorCode[]): boolean {
  return error instanceof DexcomError && error.code !== undefined && codes.includes(error.code);
}

/** The session ID is unknown or expired; logging in again fixes it. */
function isExpiredSessionError(error: unknown): boolean {
  return hasCode(error, ["SessionIdNotFound", "SessionNotValid"]);
}

/**
 * Dexcom rejected the credentials themselves. Retrying can't help and risks locking the
 * user's Dexcom account, so the session should end immediately.
 */
export function isCredentialError(error: unknown): boolean {
  return hasCode(error, ["AccountPasswordInvalid", "SSO_AuthenticateMaxAttemptsExceeed"]);
}

/** A response that decoded as neither the expected payload nor a `DexcomError`. */
export class DexcomDecodingError extends Error {
  override readonly name = "DexcomDecodingError";
  readonly statusCode: number;
  readonly url: string | undefined;

  constructor(
    readonly errorDescription: string,
    /** The raw response body (e.g. a Cloudflare HTML error page). */
    readonly body: string,
    readonly httpResponse: DexcomHTTPResponse,
  ) {
    super(errorDescription);
    this.statusCode = httpResponse.statusCode;
    this.url = httpResponse.url;
  }
}

/** The last path component of a URL, e.g. `ReadPublisherLatestGlucoseValues`. */
export function lastPathComponent(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  return new URL(url).pathname.split("/").filter(Boolean).at(-1);
}

// MARK: - Decoding

class DecodingFailure extends Error {}

function decodeUUID(json: unknown): string {
  if (typeof json !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(json)) {
    throw new DecodingFailure("Expected a UUID string");
  }
  // Swift's `UUID.uuidString` is uppercase, so that's what goes back on the wire.
  return json.toUpperCase();
}

function decodeReadings(json: unknown): GlucoseReading[] {
  if (!Array.isArray(json)) throw new DecodingFailure("Expected an array of readings");
  return json.map((item: unknown, index) => {
    const { Value: value, Trend: trend, WT: wt } = isObject(item) ? item : {};
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new DecodingFailure(`Reading ${index}: expected an integer Value`);
    }
    if (typeof trend !== "string" || !trendDirections.has(trend)) {
      throw new DecodingFailure(`Reading ${index}: invalid Trend`);
    }
    if (typeof wt !== "string") throw new DecodingFailure(`Reading ${index}: expected a WT string`);
    return { value, trend: trend as TrendDirection, date: parseWT(wt) };
  });
}

/**
 * `WT` looks like `Date(1714000000000)`: epoch ms wrapped in non-digits. Like the Swift
 * client, only the ends are trimmed, and anything unparseable becomes the epoch (0).
 */
function parseWT(wt: string): number {
  const digits = wt.replace(/^\D+|\D+$/g, "");
  const ms = digits === "" ? NaN : Number(digits);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Decodes Dexcom's `{ Code, Message }` error body, or undefined if it isn't one. */
function decodeDexcomError(json: unknown, httpResponse: DexcomHTTPResponse): DexcomError | undefined {
  if (!isObject(json)) return undefined;
  const { Code: code, Message: message } = json;
  const validCode = code == null || (typeof code === "string" && (errorCodes as readonly string[]).includes(code));
  const validMessage = message == null || typeof message === "string";
  if (!validCode || !validMessage) return undefined;
  return new DexcomError((code ?? undefined) as DexcomErrorCode | undefined, message ?? undefined, httpResponse);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MARK: - Client

export type Fetcher = (request: Request) => Promise<Response>;

export interface DexcomClientOptions {
  username: string;
  password: string;
  accountID?: string;
  sessionID?: string;
  accountLocation: AccountLocation;
  /** Defaults to the global `fetch`. */
  fetch?: Fetcher;
}

export class DexcomClient {
  readonly #username: string;
  readonly #password: string;
  readonly #location: AccountLocation;
  readonly #fetch: Fetcher;
  #accountID: string | undefined;
  #sessionID: string | undefined;

  constructor(options: DexcomClientOptions) {
    this.#username = options.username;
    this.#password = options.password;
    this.#location = options.accountLocation;
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#accountID = options.accountID?.toUpperCase();
    this.#sessionID = options.sessionID?.toUpperCase();
  }

  /** Uppercase. Reflects a fresh login even when the call that logged in later threw. */
  get accountID(): string | undefined {
    return this.#accountID;
  }

  /** Uppercase. Reflects a fresh login even when the call that logged in later threw. */
  get sessionID(): string | undefined {
    return this.#sessionID;
  }

  /**
   * Readings from the last `duration` seconds, in the order Dexcom returns them (newest
   * first). Reuses the existing session if there is one, logging in again and retrying
   * once only if Dexcom says that session expired. Any other failure (429, 5xx, network
   * error, ...) propagates without further requests: re-authenticating against an
   * account or IP that's already rate limited only amplifies the limit.
   */
  async getGlucoseReadings(duration = maxGlucoseDuration, maxCount = maxGlucoseCount): Promise<GlucoseReading[]> {
    if (this.#sessionID !== undefined) {
      try {
        return await this.#readGlucose(this.#sessionID, duration, maxCount);
      } catch (error) {
        if (!isExpiredSessionError(error)) throw error;
      }
    }
    const sessionID = await this.createSession();
    return await this.#readGlucose(sessionID, duration, maxCount);
  }

  /** Authenticates, then logs in. Returns the new session ID. */
  async createSession(): Promise<string> {
    this.#accountID = await this.#post(
      authenticateEndpoint,
      { accountName: this.#username, password: this.#password, applicationId: appIDs[this.#location] },
      decodeUUID,
    );
    this.#sessionID = await this.#post(
      loginEndpoint,
      { accountId: this.#accountID, password: this.#password, applicationId: appIDs[this.#location] },
      decodeUUID,
    );
    return this.#sessionID;
  }

  #readGlucose(sessionID: string, duration: number, maxCount: number): Promise<GlucoseReading[]> {
    const params = new URLSearchParams({
      sessionId: sessionID,
      minutes: String(Math.trunc(duration / 60)),
      maxCount: String(maxCount),
    });
    return this.#post(`${readingsEndpoint}?${params}`, undefined, decodeReadings);
  }

  /**
   * Posts to a Share endpoint and decodes the body. The status code is deliberately not
   * checked: a body that decodes is a success, one that decodes as Dexcom's error shape
   * is a `DexcomError`, and anything else is a `DexcomDecodingError`.
   */
  async #post<T>(endpoint: string, body: object | undefined, decode: (json: unknown) => T): Promise<T> {
    const url = `${baseURLs[this.#location]}/${endpoint}`;
    const response = await this.#fetch(
      new Request(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeout),
      }),
    );
    const text = await response.text();

    let json: unknown;
    try {
      json = JSON.parse(text);
      return decode(json);
    } catch (error) {
      const httpResponse = DexcomHTTPResponse.from(response, url);
      const dexcomError = decodeDexcomError(json, httpResponse);
      if (dexcomError) throw dexcomError;
      const message = error instanceof Error ? error.message : String(error);
      const description = error instanceof SyntaxError ? `The given data was not valid JSON. ${message}` : message;
      throw new DexcomDecodingError(description, text, httpResponse);
    }
  }
}
