# Architecture

Luka's Live Activity backend on Cloudflare Workers. It registers Live Activities, polls
Dexcom Share once per user, and fans APNs Live Activity pushes out to every device.

It replaces a Vapor server (`../luka-vapor`) and is compatible with it for the iOS app:
same routes, request bodies, success and status contract, and APNs payloads. The app
only branches on 410 from `start-live-activity`, 404 from `/glucose-readings`, and 2xx
vs non-2xx elsewhere, and never reads an error body. Error bodies are this service's own.

## Pieces

| Piece | File | Role |
|---|---|---|
| Worker | `src/index.ts` | Stateless HTTP router. Validates requests, forwards to Durable Objects. |
| `UserSession` DO | `src/session.ts` | One per Dexcom username (`getByName(username)`). Owns that user's credentials, poll state, device tokens, tombstones, and the poll alarm. |
| `Registry` DO | `src/registry.ts` | Singleton (`getByName("global")`). Per-user counts for `/activity-count`, and the shared APNs provider JWT. |
| Dexcom client | `src/dexcom.ts` | Share API client (port of `dexcom-swift`). |
| Poll policy | `src/scheduling.ts` | Pure functions and constants: when to poll next, backoff, stale levels, supersede rule. |
| APNs | `src/apns.ts` | JWT signing, HTTP/2 sends via `fetch`, Live Activity payload builders. |
| Alerts | `src/alerts.ts` | Out-of-range / rapid-trend alert text for reading updates. |
| Telemetry | `src/telemetry.ts` | `emit`: one structured log line per event. |
| Secrets | `src/secrets.ts` | Optional secrets, typed. |
| Requests | `src/requests.ts` | Body validation, error responses, client-event sanitizer, email redaction. |
| Dashboard | `src/dashboard.ts` | HTML for `/activity-count`. |
| Formatting | `src/glucose-format.ts` | Glucose value formatting for alert text. |

## Routes

| Route | Handling |
|---|---|
| `GET /` | `Download Luka on the App Store.` |
| `GET /robots.txt` | Disallow everything. |
| `GET /activity-count` | Registry counts as JSON; the HTML dashboard when `Accept` lists exactly `text/html`. |
| `GET /glucose-readings` | Basic auth → `UserSession.readings`. 401 without auth; 404 for no session, wrong password, or nothing cached. |
| `POST /start-live-activity` | `UserSession.start` → 200, or 410 for an ended activity. Failures emit `session_start_failed`. |
| `POST /end-live-activity` | `UserSession.endActivity`. |
| `POST /end-live-activities` | `UserSession.endAll`. |
| `POST /restart-live-activity` | `UserSession.debugRestart` → 200, 404, or 422. |
| `POST /client-event` | Sanitized `client_event` rows, stamped from `UserSession.peekRestartPending`. |

### Errors

Every error is `{"error": "<message>"}` with its status:

| Status | When |
|---|---|
| 400 | Body isn't a JSON object, or a field is missing or has the wrong type/value (`"activityID" is required`, `"duration" must be a number`) |
| 401 | `/glucose-readings` without basic auth |
| 404 | Unknown route or method; `/glucose-readings` with nothing to serve; restart with no session or no matching activity |
| 413 | Body over 64 KB |
| 422 | Restart of an activity without push-to-start info |
| 500 | Anything unexpected (logged as `request_failed`) |

Successes have empty bodies except the `GET` routes; 410 from `start-live-activity` is
empty too. The `Content-Type` of a request isn't checked. `HEAD` is answered like `GET`, without the body. A Durable Object call that fails with a
`retryable` error (e.g. the object was reset by a deploy) is retried once with a fresh
stub, since the app doesn't retry a failed registration and every call is safe to repeat.

## Why a Durable Object per user

Each user's session is a single-writer object with its own alarm:

- **Scheduling** is the DO alarm. There is no global scheduler, schedule set, shard
  config, or claim step — a session wakes itself when its next poll is due.
- **Concurrency**: storage uses the synchronous KV API, so only network awaits (Dexcom,
  APNs, the Registry) yield. Every request handler is atomic apart from its pushes; the
  poll is the one long-running flow, and requests interleave with it at its awaits. The
  rules that keep that safe are under *Interleaving* below.

## `UserSession` storage keys

| Key | Value |
|---|---|
| `username` | The Dexcom username (the DO can't recover its name inside an alarm). |
| `cred` | `Cred` — written by every registration. |
| `state` | `PollState` — created by the first registration, then written only by the poll. |
| `tok:<activityID>` | `TokenEntry` |
| `ended:<activityID>` | `{ reason, expiresAt }` — tombstone; an ended activity can never re-register (410). |
| `restartPending` | `RestartPending & { expiresAt }` — written just before a push-to-start send (removed if it fails), taken by the next registration. |
| `nextPollAt` | Epoch ms of the next due poll. |
| `reported` | Last `{ activities, rateLimited, at }` sent to the Registry. |

A session **exists** when `cred` and `state` are both present. Teardown deletes `cred`,
`state`, `nextPollAt`, and every `tok:`. Tombstones and the restart marker outlive the
session and expire after 8 hours.

The single alarm serves both polling and expiry: it is always set to the earliest of
`nextPollAt` (while a session exists) and the next tombstone/marker expiry. When nothing
is left, the DO deletes all storage.

## Poll cycle (alarm)

1. Purge expired tombstones / restart marker.
2. If a session exists and `nextPollAt` is due, push `nextPollAt` out 60s and re-arm (so a
   crash mid-cycle still retries), then:
   1. **Expire** tokens at 7h: remove and tombstone them first, then send each an end push
      (dismissing it when it will be restarted) and, if it opted in, a push-to-start
      restart. If no tokens remain, the session is torn down before those pushes, so the
      restarted activity's registration starts a new session; no Dexcom read is spent.
   2. **Poll Dexcom** with the stored session ID; sort readings ascending. Every
      upstream request has a timeout (Dexcom and APNs 30s), and a timeout
      fails like a network error.
   3. **Handle the result** per `scheduling.ts`: fan out a new reading; reschedule and
      send stale milestones (5/10/15 min) when nothing is new; back off on errors (429
      recovery floor and `Retry-After`, decoding/generic retries with jitter); end the
      activities after too many retries, or at once when Dexcom rejects the credentials
      (retrying a bad password risks locking the user's Dexcom account) — unless a
      registration during the poll changed the password, in which case it re-polls
      immediately with the new one.
   4. **Persist** `state` and `nextPollAt` once, at the end.
3. Report counts to the Registry if they changed; set the alarm.

A failed cycle is logged, not thrown, and the alarm is re-armed regardless. Only a
failure to re-arm is thrown, so the runtime's alarm retry takes over.

### Interleaving

- The poll writes only `state` and `nextPollAt`. Token removals are targeted deletes plus
  tombstones; it never writes back token entries it loaded.
- Tokens are re-read after the Dexcom await, so a device that registered mid-poll gets
  this cycle's push.
- Every teardown bumps an in-memory epoch. After each await the poll checks that the
  epoch is unchanged and the session still exists before writing, so an
  `end-live-activities` landing mid-poll is never resurrected, and a session started
  after it never gets the old poll's state.
- Removals the poll makes up front (expiry, ending the activities) happen before any
  await, so a registration racing them sees the tombstone and gets 410.
- Ending the activities after an error covers only those registered when Dexcom was
  polled. A device that registered during the call keeps the session alive, and the next
  poll (already set a minute out) serves it.
- The restart marker is written before the push-to-start send, so a device that
  re-registers before APNs answers is still attributed. A failed send removes the marker
  only if it's still the one it wrote.
- A token APNs rejects as dead is only dropped if the stored entry still carries the
  rejected push token; a rotation registered during the send replaced it and is kept.
- `end-live-activities` tombstones and tears down synchronously, then sends its end
  pushes.

## Registry

- `report(username, counts | null)`: upsert/delete one user's `{ activities, rateLimited }`
  in a SQLite table. Sessions report when their counts change and at least hourly; rows
  not refreshed within 8h are pruned (a session that died without reporting). A session
  chains its reports on one in-memory promise so they land in order. A failed report
  reverts the session's `reported` record (unless a newer report replaced it), so the
  next change retries it.
- `counts()`: `{ sessions, activities, rateLimited }`.
- `apnsJwt({ forceRefresh })`: an ES256 provider token minted at most once per 30 minutes
  and persisted, returned with its `refreshAt`; undefined when APNs isn't configured. One
  shared token for the deployment keeps APNs from seeing frequent provider-token changes
  (`TooManyProviderTokenUpdates`). A forced refresh (after `ExpiredProviderToken`)
  re-mints only if the token is over a minute old, so a burst of sessions refreshing at
  once mints one token. Sessions cache it in memory until `refreshAt`.

## Telemetry

Every event is one structured log line, `console.<level>({ ...attributes, event })`, with
a human-readable `message` where one helps. Each occurrence logs exactly once; there are
no separate plain-text lines. Workers Logs indexes every field, and Workers Observability
keeps logs and automatic traces (`observability` in `wrangler.jsonc`, full sampling,
persisted) and exports both over OpenTelemetry to Grafana Cloud. A destination is
created in the Cloudflare dashboard, where it holds the OTLP endpoint and credentials, and
its name is listed under `observability.logs.destinations` (`grafana-logs`) or
`observability.traces.destinations` (`grafana-traces`). The Worker itself has no exporter
code and no telemetry secrets.

Logs never carry a full username (`user` is the redacted `k•••@example.com` form), a
password, or a full token (`token_prefix` / `pts_prefix` / `activity_prefix` are 8
characters).

| Event | Level | When |
|---|---|---|
| `session_started` | log | A registration (`kind`: `new` / `token_added`) |
| `session_start_rejected` | log | 410 for an ended activity |
| `session_start_failed` | error | The start route failed |
| `tokens_superseded` | log | A new activity replaced its device's older ones |
| `restart_registered` | log | First registration after a push-to-start restart |
| `session_ended` | log | `client_end`, `client_end_all`, `all_tokens_expired`, `apns_rejected` (every token dead), `dexcomError`, `tooManyRetries` |
| `poll` | log | Every Dexcom poll (`outcome`, `status_code`, `endpoint`, …) |
| `poll_empty` | warn | Dexcom returned no readings |
| `poll_error` | warn, or error when `will_end` | A failed poll (`error_type`: `credentials`, `dexcom`, `decoding`, `generic`) |
| `poll_scheduled` | log | The next poll was set (`delay_s`, `poll_interval`, `retry_count`) |
| `push_sent` | log | APNs accepted an update (`kind`: `update` / `stale`) |
| `push_failed` | error | A push failed (`kind`: `update` / `stale` / `push_to_start`) |
| `push_ended` | log | An activity was ended at its max duration or by a poll failure |
| `push_started` | log | APNs accepted a push-to-start restart |
| `debug_restart` / `debug_restart_rejected` | log / warn | `POST /restart-live-activity` |
| `readings_served` | log | `GET /glucose-readings` answered |
| `client_event` | log | One sanitized client observation |
| `alarm_failed` | error | A poll cycle threw unexpectedly |
| `registry_report_failed` | error | Reporting counts to the Registry failed |
| `request_failed` | error | A route threw an unexpected error (answered 500) |

Names and attributes shared with the Vapor server keep its schema. `poll_error` has one
new `error_type`, `credentials`. Type-name attributes (`error_type` on
`session_start_failed`, `error` on `push_failed`) carry the TypeScript error names
(`HttpError`, `ApnsError`, `TypeError`, …), except `APNSNotConfiguredError`.

## Configuration

Secrets, all optional: `PUSH_NOTIFICATION_PEM` (APNs `.p8` contents),
`PUSH_NOTIFICATION_ID` (key ID), `TEAM_IDENTIFIER`. Locally they come from `.dev.vars`
(see `.dev.vars.example`). They're typed as optional in `src/secrets.ts` rather than
generated by `wrangler types`, which would type them as always set. Without them APNs is
a no-op: update pushes fail as `push_failed` `error_type: "other"`, end pushes are
skipped, and push-to-start restarts don't happen.

`env.staging` in `wrangler.jsonc` deploys the same code as `luka-staging`, a separate
Worker whose Durable Objects (and so all session state) are its own. It inherits
`migrations` and `observability`; `durable_objects` isn't inherited, so its bindings are
repeated there. Secrets are set per environment.

## Dexcom egress

Workers have no dedicated egress IP. Dexcom Share sits behind Cloudflare, and
Worker-to-Cloudflare-zone subrequests all present the same shared source address, so
per-IP rate limiting cannot be managed by spreading load across IPs the way the Fly
deployment did. Watch the 429 rate on `poll` events (`status_code == "429"`).

## Tests

`test/routes.test.ts` and `test/session.test.ts` run in the Workers runtime against the
real Durable Objects, with Dexcom and APNs faked behind the global `fetch`, telemetry
captured from the console, and the clock pinned years ahead so alarms only run when a
test runs them (`test/helpers.ts`).
The other test files cover the pure modules.
