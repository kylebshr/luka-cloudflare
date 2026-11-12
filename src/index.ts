// Stateless HTTP router: validates requests and forwards them to the user's `UserSession`
// or the `Registry`. Routes, request bodies, and success statuses are the iOS app's
// contract; error bodies are `{"error": message}`.

import { dashboardHtml } from "./dashboard";
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
} from "./requests";
import { emit } from "./telemetry";
import type { GlucoseReading } from "./types";

export { Registry } from "./registry";
export { UserSession } from "./session";

type Handler = (request: Request, env: Env) => Promise<Response> | Response;

const routes: Record<string, Handler> = {
  "GET /": () => text("Download Luka on the App Store."),
  "GET /robots.txt": () => text("User-agent: *\nDisallow: /\n"),
  "GET /activity-count": activityCount,
  "GET /glucose-readings": glucoseReadings,
  "POST /start-live-activity": startLiveActivity,
  "POST /end-live-activity": endLiveActivity,
  "POST /end-live-activities": endLiveActivities,
  "POST /restart-live-activity": restartLiveActivity,
  "POST /client-event": clientEvent,
};

export default {
  async fetch(request, env): Promise<Response> {
    const response = await respond(request, env);
    // HEAD gets the GET route's status and headers without the body.
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
} satisfies ExportedHandler<Env>;

async function respond(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  // Empty path components don't count: `/activity-count/` matches.
  const path = `/${pathname.split("/").filter(Boolean).join("/")}`;
  const method = request.method === "HEAD" ? "GET" : request.method;
  const handler = routes[`${method} ${path}`];
  if (!handler) return errorResponse(new HttpError(404, "Not found"));
  try {
    return await handler(request, env);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      emit(
        "request_failed",
        { message: "Unexpected error", method: request.method, path, error: String(error) },
        "error",
      );
    }
    return errorResponse(error);
  }
}

// MARK: - Routes

/**
 * Unauthenticated status: users being polled, running Live Activities (one per device
 * token), and users backing off from a Dexcom rate limit. Browsers get a dashboard.
 */
async function activityCount(request: Request, env: Env): Promise<Response> {
  const counts = await retrying(() => registry(env).counts());
  if (acceptsHtml(request.headers.get("accept"))) {
    return new Response(dashboardHtml(counts), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return json(counts);
}

// The app treats 404 as "no cached readings yet" and falls back to Dexcom directly.
async function glucoseReadings(request: Request, env: Env): Promise<Response> {
  const auth = basicAuthorization(request.headers);
  if (!auth) return errorResponse(new HttpError(401, "Basic authorization required"));

  const query = new URL(request.url).searchParams;
  const minutes = intParameter(query, "minutes") ?? 1440;
  const maxCount = intParameter(query, "maxCount") ?? 288;
  const readings = await retrying(() => session(env, auth.username).readings(auth.password, minutes, maxCount));
  if (!readings) return errorResponse(new HttpError(404, "No cached readings"));
  return json(readings.map(({ value, trend, date }: GlucoseReading) => ({ value, trend, date: iso8601(date) })));
}

async function startLiveActivity(request: Request, env: Env): Promise<Response> {
  const raw = request.clone();
  try {
    const body = decodeStartLiveActivityRequest(await readJsonObject(request));
    const result = await retrying(() => session(env, body.username).start(body));
    return new Response(null, { status: result === "gone" ? 410 : 200 });
  } catch (error) {
    // Without this, a registration that never got updates would be indistinguishable
    // from one the app never sent.
    const username = await usernameFrom(raw);
    emit(
      "session_start_failed",
      {
        message: "start-live-activity failed",
        user: username === "" ? "unknown" : redactedEmailLogID(username),
        app_version: request.headers.get("X-Luka-Version") ?? "unknown",
        app_build: request.headers.get("X-Luka-Build") ?? "unknown",
        error_type: error instanceof HttpError ? "invalid_request" : "internal",
        error: String(error).slice(0, 300),
      },
      "error",
    );
    throw error;
  }
}

async function endLiveActivity(request: Request, env: Env): Promise<Response> {
  const body = decodeEndLiveActivityRequest(await readJsonObject(request));
  await retrying(() => session(env, body.username).endActivity(body.username, body.activityID));
  return ok();
}

async function endLiveActivities(request: Request, env: Env): Promise<Response> {
  const body = decodeEndLiveActivitiesRequest(await readJsonObject(request));
  await retrying(() => session(env, body.username).endAll(body.username));
  return ok();
}

/** Debug: the max-duration push-to-start restart, on demand. */
async function restartLiveActivity(request: Request, env: Env): Promise<Response> {
  const body = decodeRestartLiveActivityRequest(await readJsonObject(request));
  switch (await retrying(() => session(env, body.username).debugRestart(body.username, body.activityID))) {
    case "noSession":
      throw new HttpError(404, "No session found");
    case "noToken":
      throw new HttpError(404, "No matching token");
    case "noPushToStart":
      throw new HttpError(422, "No push-to-start token for this activity");
    case "ok":
      return ok();
  }
}

/**
 * Client-side lifecycle observations (activity appeared, token arrived, send failed, …),
 * stamped with the device's own clock, as `client_event` rows next to the server's events.
 * If a restart push is pending, each row also says how long after it the observation was.
 */
async function clientEvent(request: Request, env: Env): Promise<Response> {
  const body = decodeClientEventRequest(await readJsonObject(request));
  const now = Date.now();
  const logID = redactedEmailLogID(body.username);
  const pending = await retrying(() => session(env, body.username).peekRestartPending()).catch(() => undefined);
  const stamps = {
    user: logID,
    app_version: request.headers.get("X-Luka-Version") ?? "unknown",
    app_build: request.headers.get("X-Luka-Build") ?? "unknown",
    os_version: body.systemVersion ?? "unknown",
    device_model: body.deviceModel ?? "unknown",
  };

  for (const event of body.events.slice(0, ClientEventSanitizer.maxEvents)) {
    const name = ClientEventSanitizer.name(event.name);
    if (name === undefined) continue;
    const occurredAt = event.occurredAt * 1000;
    emit("client_event", {
      ...ClientEventSanitizer.attributes(event.attributes),
      ...stamps,
      client_event: name,
      client_time: isValidDate(occurredAt) ? new Date(occurredAt).toISOString() : "invalid",
      client_lag_s: String(Math.trunc((now - occurredAt) / 1000)),
      ...(event.activityID !== undefined && { activity_prefix: event.activityID.slice(0, 8) }),
      ...(pending && {
        restart_source: pending.source,
        since_restart_s: String(Math.trunc((occurredAt - pending.sentAt) / 1000)),
      }),
    });
  }
  return ok();
}

// MARK: - Helpers

/**
 * Calls a Durable Object, and once more if the runtime marks the failure retryable (e.g.
 * the object was reset by a deploy). The app doesn't retry a failed registration, and
 * every RPC here is safe to repeat (a debug restart at worst re-sends its pushes). `call`
 * must get a fresh stub: one that threw may be broken.
 */
async function retrying<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if ((error as { retryable?: unknown } | undefined)?.retryable !== true) throw error;
    return await call();
  }
}

function session(env: Env, username: string) {
  return env.USER_SESSION.getByName(username);
}

function registry(env: Env) {
  return env.REGISTRY.getByName("global");
}

/** Success without a body. */
function ok(): Response {
  return new Response(null, { status: 200 });
}

function text(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Whether the Accept header lists exactly `text/html`. Wildcards don't count: curl's
 * default `*\/*` must keep getting JSON.
 */
function acceptsHtml(accept: string | null): boolean {
  return (accept ?? "").split(",").some((range) => range.split(";")[0]?.trim().toLowerCase() === "text/html");
}

/** An integer query parameter; undefined if absent or invalid. */
function intParameter(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || !/^[+-]?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Whole seconds, UTC, e.g. `2026-11-12T10:00:00Z`: the app decodes with Foundation's
 * `.iso8601` strategy, which rejects fractional seconds.
 */
function iso8601(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function isValidDate(epochMs: number): boolean {
  return !Number.isNaN(new Date(epochMs).getTime());
}

/** The body's `username`, if it's JSON with a string there; "" otherwise. */
async function usernameFrom(request: Request): Promise<string> {
  try {
    const body: unknown = JSON.parse(await request.text());
    if (typeof body === "object" && body !== null && "username" in body && typeof body.username === "string") {
      return body.username;
    }
  } catch {
    // Not JSON: the failure event says "unknown".
  }
  return "";
}
