// Shared data model. All instants are epoch **milliseconds** (number) internally; the
// wire formats (ISO-8601 for /glucose-readings, reference-date seconds for APNs
// content-state) are produced at the edges only.

export type PushEnvironment = "development" | "production";
export type AccountLocation = "usa" | "apac" | "worldwide";
export type GlucoseUnit = "mgdl" | "mmolL";

export type TrendDirection =
  | "None"
  | "DoubleUp"
  | "SingleUp"
  | "FortyFiveUp"
  | "Flat"
  | "FortyFiveDown"
  | "SingleDown"
  | "DoubleDown"
  | "NotComputable"
  | "RateOutOfRange";

export interface GlucoseReading {
  value: number;
  trend: TrendDirection;
  /** Epoch ms. */
  date: number;
}

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface LiveActivityPreferences {
  /** Inclusive [lower, upper], mg/dL. */
  targetRange: [number, number];
  unit: GlucoseUnit;
  /** Absent means alerts enabled. */
  alertsEnabled?: boolean;
}

/** One per Live Activity (keyed by `activityID`) in a user's session. */
export interface TokenEntry {
  pushToken: string;
  environment: PushEnvironment;
  preferences?: LiveActivityPreferences;
  /** When the activity started; preserved across push-token rotations. Epoch ms. */
  startDate: number;
  /** Seconds of history this activity displays. */
  duration: number;
  activityID: string;
  pushToStartToken?: string;
  attributesType?: string;
  attributes?: JSONValue;
  /** When the client last sent a different push-to-start token. Epoch ms. */
  pushToStartTokenUpdatedAt?: number;
}

/** Route-owned credentials. */
export interface Cred {
  password: string;
  accountLocation: AccountLocation;
}

/** Poller-owned state: written by the poll loop only, after session creation. */
export interface PollState {
  accountID?: string;
  sessionID?: string;
  sessionStartDate?: number;
  lastReading?: GlucoseReading;
  /** Ascending by date, up to 24h. */
  readings?: GlucoseReading[];
  /** Consecutive failed polls; any response Dexcom answers with readings clears it. */
  retryCount: number;
  /** Set while the last poll scheduled a quick recheck for an overdue reading. */
  rechecking?: boolean;
  lastStaleUpdateMinutes?: number;
  /** Seconds. Present only while easing back from a 429. */
  recoveryInterval?: number;
  /** Set when a 429 was answered with a quick `Retry-After` retry; cleared by the next healthy poll. */
  rateLimitRetried?: boolean;
}

export interface RestartPending {
  sentAt: number;
  pushToStartTokenPrefix: string;
  pushToStartTokenUpdatedAt?: number;
  environment: PushEnvironment;
  /** `max_duration` or `debug`. */
  source: string;
}

export interface ActivityCounts {
  sessions: number;
  activities: number;
  rateLimited: number;
}

// Validated request bodies (see requests.ts).

export interface StartLiveActivityRequest {
  pushToken: string;
  environment: PushEnvironment;
  username: string;
  password: string;
  accountID?: string;
  sessionID?: string;
  accountLocation: AccountLocation;
  duration: number;
  preferences?: LiveActivityPreferences;
  activityID: string;
  pushToStartToken?: string;
  attributesType?: string;
  attributes?: JSONValue;
  pushToStart?: boolean;
}

export interface EndLiveActivityRequest {
  username: string;
  activityID: string;
}

export interface EndLiveActivitiesRequest {
  username: string;
}

export interface RestartLiveActivityRequest {
  username: string;
  activityID: string;
}

export interface ClientEvent {
  name: string;
  /** Seconds since 1970 on the device clock. */
  occurredAt: number;
  activityID?: string;
  attributes?: Record<string, string>;
}

export interface ClientEventRequest {
  username: string;
  systemVersion?: string;
  deviceModel?: string;
  events: ClientEvent[];
}

/** Content-state `s` values. */
export const StaleLevel = { fresh: 0, warning: 1, stale: 2, offline: 3 } as const;
export type StaleLevel = (typeof StaleLevel)[keyof typeof StaleLevel];
