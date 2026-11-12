// Integration-test scaffolding: a fake clock, fake upstreams (Dexcom, APNs) behind the
// global `fetch`, captured telemetry (structured console lines), and shortcuts for driving
// the Worker and its Durable Objects.
//
// The clock is pinned years ahead of real time, so the alarms the code under test sets
// never fire on their own; tests run them explicitly with `poll()`.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { vi } from "vitest";
import type { GlucoseReading, PollState, TokenEntry } from "../src/types";

/** 2036-01-01T00:00:00Z */
export const T0 = Date.UTC(2036, 0, 1);
export const seconds = (n: number) => n * 1000;
export const minutes = (n: number) => n * 60_000;
/** Seconds since 2001-01-01, as APNs content-state dates are encoded. */
export const referenceSeconds = (epochMs: number) => epochMs / 1000 - 978_307_200;

export function useClock(now = T0): void {
  vi.useFakeTimers({ toFake: ["Date"], now });
}

export function setTime(epochMs: number): void {
  vi.setSystemTime(epochMs);
}

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

export interface Push {
  environment: "production" | "development";
  deviceToken: string;
  headers: Record<string, string>;
  aps: Record<string, any>;
}

export type Event = Record<string, string>;

/** A promise the test resolves by hand, to hold an upstream response mid-flight. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export const accountID = "11111111-2222-3333-4444-555555555555";
export const sessionID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

/**
 * Fake Dexcom Share and APNs, installed as the global `fetch`, and the telemetry events
 * logged meanwhile (the console is silenced; plain-text lines are dropped).
 */
export class Upstreams {
  /** What the Share readings endpoint serves (it returns them newest first). */
  readings: GlucoseReading[] = [];
  /** Overrides a Dexcom endpoint's response, keyed by the URL's last path component. */
  dexcom: Partial<Record<string, () => Response>> = {};
  /** Overrides APNs' response for a device token; undefined means 200. */
  apns: (deviceToken: string) => Response | undefined = () => undefined;
  /** When set, Dexcom requests wait for it. */
  dexcomGate: Promise<void> | undefined;
  /** When set, APNs requests (only those to `apnsGateOnly`, if set) wait for it. */
  apnsGate: Promise<void> | undefined;
  apnsGateOnly: string | undefined;
  /** Upstreams that never answer: their requests fail only when their signal aborts. */
  hang: { dexcom?: boolean; apns?: boolean } = {};

  readonly dexcomCalls: string[] = [];
  readonly pushes: Push[] = [];
  readonly events: Event[] = [];
  /** The console method each event was logged with, in order. */
  readonly levels: ["log" | "warn" | "error", string][] = [];

  constructor() {
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((line: unknown) => this.capture(level, line));
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname.includes("push.apple.com")) return this.#apns(request, url);
      if (url.hostname.includes("dexcom")) return this.#dexcom(request, url);
      throw new Error(`Unexpected fetch: ${request.url}`);
    });
  }

  async #apns(request: Request, url: URL): Promise<Response> {
    const deviceToken = url.pathname.split("/").at(-1)!;
    this.pushes.push({
      environment: url.hostname.includes("development") ? "development" : "production",
      deviceToken,
      headers: Object.fromEntries(request.headers),
      aps: ((await request.json()) as { aps: Record<string, any> }).aps,
    });
    if (this.apnsGateOnly === undefined || this.apnsGateOnly === deviceToken) await this.apnsGate;
    if (this.hang.apns) await aborted(request.signal);
    return this.apns(deviceToken) ?? new Response(null, { status: 200 });
  }

  async #dexcom(request: Request, url: URL): Promise<Response> {
    const endpoint = url.pathname.split("/").at(-1)!;
    this.dexcomCalls.push(endpoint);
    await this.dexcomGate;
    if (this.hang.dexcom) await aborted(request.signal);
    const override = this.dexcom[endpoint];
    if (override) return override();
    switch (endpoint) {
      case "AuthenticatePublisherAccount":
        return Response.json(accountID);
      case "LoginPublisherAccountById":
        return Response.json(sessionID);
      default: {
        const cutoff = Date.now() - minutes(Number(url.searchParams.get("minutes")));
        return Response.json(
          this.readings
            .filter((reading) => reading.date >= cutoff)
            .sort((a, b) => b.date - a.date)
            .slice(0, Number(url.searchParams.get("maxCount")))
            .map((reading) => ({ WT: `Date(${reading.date})`, Value: reading.value, Trend: reading.trend })),
        );
      }
    }
  }

  /** Console lines that weren't telemetry events. */
  readonly plainLines: unknown[] = [];

  /** Records a console line. */
  capture(level: "log" | "warn" | "error", line: unknown): void {
    if (typeof line !== "object" || line === null || !("event" in line)) {
      this.plainLines.push(line);
      return;
    }
    this.events.push(line as Event);
    this.levels.push([level, (line as Event).event!]);
  }

  eventsNamed(name: string): Event[] {
    return this.events.filter((event) => event.event === name);
  }

  pushesTo(deviceToken: string): Push[] {
    return this.pushes.filter((push) => push.deviceToken === deviceToken);
  }

  /** Forgets everything recorded so far. */
  clear(): void {
    this.dexcomCalls.length = 0;
    this.pushes.length = 0;
    this.events.length = 0;
    this.levels.length = 0;
  }
}

/** Rejects with the signal's reason once it aborts; never resolves. */
export function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
}

/**
 * Makes every `AbortSignal.timeout` fire after 5ms (real time), and returns the
 * timeouts the code asked for.
 */
export function fastTimeouts(): number[] {
  const requested: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    requested.push(ms);
    return timeout(5);
  });
  return requested;
}

export function reading(value: number, date: number, trend: GlucoseReading["trend"] = "Flat"): GlucoseReading {
  return { value, trend, date };
}

// MARK: - Worker

export function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://luka.test${path}`, { headers });
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://luka.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const username = "kyle@example.com";
export const logID = "k•••@example.com";
export const password = "hunter2";

export function startBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pushToken: "aaaaaaaa11111111",
    environment: "production",
    username,
    password,
    accountLocation: "usa",
    duration: 8 * 60 * 60,
    activityID: "activity-a",
    ...overrides,
  };
}

/** Registers an activity and returns the response status. */
export async function start(overrides: Record<string, unknown> = {}): Promise<number> {
  return (await post("/start-live-activity", startBody(overrides))).status;
}

export const pushToStart = {
  pushToStartToken: "ptsptspts0000001",
  attributesType: "ReadingAttributes",
  attributes: { name: "Luka" },
};

// MARK: - Durable Objects

export function session(name = username) {
  return env.USER_SESSION.getByName(name);
}

export interface Stored {
  state?: PollState;
  nextPollAt?: number;
  tokens: Record<string, TokenEntry>;
  ended: Record<string, { reason: string; expiresAt: number }>;
  restartPending?: Record<string, unknown>;
  alarm: number | null;
  keys: string[];
}

export async function stored(name = username): Promise<Stored> {
  return runInDurableObject(session(name), async (_, state) => {
    const kv = state.storage.kv;
    const entries = Array.from(kv.list<any>());
    const byPrefix = (prefix: string) =>
      Object.fromEntries(
        entries.filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]),
      );
    return {
      state: kv.get<PollState>("state"),
      nextPollAt: kv.get<number>("nextPollAt"),
      tokens: byPrefix("tok:"),
      ended: byPrefix("ended:"),
      restartPending: kv.get("restartPending"),
      alarm: await state.storage.getAlarm(),
      keys: entries.map(([key]) => key),
    };
  });
}

/** Moves the clock to the scheduled poll (if it's later) and runs the alarm. */
export async function poll(name = username): Promise<void> {
  const { nextPollAt } = await stored(name);
  if (nextPollAt !== undefined && nextPollAt > Date.now()) setTime(nextPollAt);
  await runDurableObjectAlarm(session(name));
}

export async function counts(): Promise<unknown> {
  return (await get("/activity-count")).json();
}
