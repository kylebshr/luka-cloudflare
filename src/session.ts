// One Durable Object per Dexcom username: credentials, poll state, device tokens,
// tombstones, and the poll alarm. Port of the Vapor server's `LiveActivityScheduler` and
// the stateful halves of its routes. See docs/architecture.md for the storage layout.

import { DurableObject } from "cloudflare:workers";
import { alertFor } from "./alerts";
import {
  ApnsClient,
  ApnsError,
  type EndPushInput,
  endPush,
  type LiveActivityPush,
  startPush,
  updatePush,
} from "./apns";
import {
  DexcomClient,
  DexcomDecodingError,
  DexcomError,
  type DexcomHTTPResponse,
  isCredentialError,
  lastPathComponent,
} from "./dexcom";
import { type ApnsJwt, reportHeartbeat, type SessionCounts } from "./registry";
import { redactedEmailLogID } from "./requests";
import {
  backoff,
  dataTTLSeconds,
  decayedRecovery,
  decodingErrorRetryLimit,
  errorBackoff,
  genericErrorRetryLimit,
  maxInterval,
  maximumDuration,
  minInterval,
  overduePollCap,
  overdueReschedule,
  pollFloor,
  type RateLimitPlan,
  rateLimitPlan,
  readingInterval,
  readingPropagationBuffer,
  staleLevel,
  supersededActivityIDs,
  trimReadings,
} from "./scheduling";
import { apnsKey } from "./secrets";
import { emit } from "./telemetry";
import {
  type Cred,
  type GlucoseReading,
  type PollState,
  type PushEnvironment,
  type RestartPending,
  StaleLevel,
  type StartLiveActivityRequest,
  type TokenEntry,
} from "./types";

export type StartResult = "ok" | "gone";
export type DebugRestartResult = "ok" | "noSession" | "noToken" | "noPushToStart";

interface Tombstone {
  reason: string;
  expiresAt: number;
}

type StoredRestartPending = RestartPending & { expiresAt: number };

const tokenPrefix = "tok:";
const endedPrefix = "ended:";

/** How far a poll cycle pushes `nextPollAt` out before it starts, so a crash still retries. */
const crashRetryDelay = 60_000;

const milestoneMinutes: Record<StaleLevel, number> = {
  [StaleLevel.fresh]: 0,
  [StaleLevel.warning]: 5,
  [StaleLevel.stale]: 10,
  [StaleLevel.offline]: 15,
};

/** Why the poll ended the activities. Values are the Vapor server's, which queries use. */
type EndReason = "dexcomError" | "tooManyRetries";

class ApnsNotConfiguredError extends Error {
  // The Vapor server's type name, which `push_failed` events carry.
  override readonly name = "APNSNotConfiguredError";

  constructor() {
    super("APNs is not configured (missing PUSH_NOTIFICATION_PEM/ID or TEAM_IDENTIFIER)");
  }
}

type PollResult = { readings: GlucoseReading[] } | { error: unknown };

/** A new reading for the poll state: the latest one and the full cached history. */
interface ReadingUpdate {
  reading: GlucoseReading;
  readings: GlucoseReading[];
}

/** One alarm-driven poll. `state` is a working copy, persisted only at the end. */
interface Cycle {
  epoch: number;
  /** When the cycle started. */
  now: number;
  logID: string;
  state: PollState;
  /** The password the poll used. */
  password: string;
  /** The activities registered when Dexcom was polled. */
  activityIDs: string[];
  /** Set once the cycle has decided when to poll next. */
  nextPollAt?: number;
}

export class UserSession extends DurableObject<Env> {
  /**
   * Bumped by every teardown. Requests run between the poll's network awaits, so after
   * each await the poll compares this to the value it started with: a mismatch means the
   * session it was polling is gone (and possibly replaced), and the poll must not write.
   * In memory is enough — an evicted object takes its in-flight poll with it.
   */
  #epoch = 0;
  /** The Registry report in flight; each report waits for the previous one, so they land in order. */
  #reporting: Promise<void> = Promise.resolve();
  #apns: ApnsClient | undefined;
  #jwt: ApnsJwt | undefined;

  // MARK: - RPC

  /** `POST /start-live-activity`: registers (or re-registers) one activity's token. */
  start(request: StartLiveActivityRequest): Promise<StartResult> {
    return this.#mutate(async () => {
      const now = Date.now();
      const logID = redactedEmailLogID(request.username);
      const launchedByPush = request.pushToStart === undefined ? "unknown" : String(request.pushToStart);

      // An activity that already ended (max duration, client end, APNs rejection,
      // superseded) never comes back. The app can still send a registration for it — on a
      // wake it observes the just-dismissed activity next to the new one and its token
      // stream re-yields — and that stale registration must not displace the new
      // activity's token. 410 tells the client to stop tracking it.
      const endedReason = this.#endedReason(request.activityID);
      if (endedReason !== undefined) {
        emit("session_start_rejected", {
          message: `Rejected registration for ended activity (${endedReason})`,
          user: logID,
          reason: endedReason,
          activity_prefix: prefix8(request.activityID),
          token_prefix: prefix8(request.pushToken),
          launched_by_push: launchedByPush,
        });
        return "gone";
      }

      const isNewSession = !this.#exists();
      const existingTokens = this.#tokens();
      const existingToken = existingTokens.find((token) => token.activityID === request.activityID);

      // If a push-to-start restart was just sent for this user, this registration is the
      // device coming back from it. Taking the marker means exactly one registration is
      // attributed to each restart.
      const pendingRestart = this.#restartPending();
      this.ctx.storage.kv.delete("restartPending");

      // Push-to-start token bookkeeping: which token the device currently advertises,
      // whether it differs from the last registration of this activity, and when it last
      // changed. A device whose restarts stopped landing after its token rotated shows up
      // as a token that never changes while `push_started` keeps targeting it.
      const ptsPrefix = request.pushToStartToken === undefined ? "none" : prefix8(request.pushToStartToken);
      let ptsChanged: "true" | "false" | "none";
      let pushToStartTokenUpdatedAt: number;
      if (existingToken) {
        const unchanged = existingToken.pushToStartToken === request.pushToStartToken;
        ptsChanged = unchanged ? "false" : "true";
        pushToStartTokenUpdatedAt = unchanged
          ? (existingToken.pushToStartTokenUpdatedAt ?? existingToken.startDate)
          : now;
      } else if (pendingRestart?.pushToStartTokenPrefix === ptsPrefix) {
        // A fresh activity after a restart carrying the same token: keep the token's
        // original age rather than resetting it on every 7-hour cycle.
        ptsChanged = "false";
        pushToStartTokenUpdatedAt = pendingRestart.pushToStartTokenUpdatedAt ?? pendingRestart.sentAt;
      } else {
        ptsChanged = "none";
        pushToStartTokenUpdatedAt = now;
      }

      const kv = this.ctx.storage.kv;
      kv.put("username", request.username);
      kv.put<Cred>("cred", { password: request.password, accountLocation: request.accountLocation });
      kv.put<TokenEntry>(tokenPrefix + request.activityID, {
        pushToken: request.pushToken,
        environment: request.environment,
        preferences: request.preferences,
        // A push-token rotation (same activity ID) keeps the activity's original start,
        // so its lifetime doesn't reset on every refresh.
        startDate: existingToken?.startDate ?? now,
        duration: request.duration,
        activityID: request.activityID,
        // Taken from this call verbatim, so a client opts out of restarts by omitting them.
        pushToStartToken: request.pushToStartToken,
        attributesType: request.attributesType,
        attributes: request.attributes,
        pushToStartTokenUpdatedAt,
      });

      // A brand-new activity on a device replaces whatever that device was running: drop
      // its older entries sharing the push-to-start token so pushes stop going to
      // activities that no longer exist.
      const superseded = supersededActivityIDs(existingTokens, {
        activityID: request.activityID,
        pushToStartToken: request.pushToStartToken,
        isNewActivity: existingToken === undefined,
      });
      for (const activityID of superseded) this.#removeToken(activityID, "superseded");
      if (superseded.length > 0) {
        emit("tokens_superseded", {
          message: `Removed ${superseded.length} stale token(s) with same push-to-start token`,
          user: logID,
          superseded_count: String(superseded.length),
        });
      }

      const tokenCount = this.#tokens().length;
      if (isNewSession) {
        kv.put<PollState>("state", {
          accountID: request.accountID,
          sessionID: request.sessionID,
          sessionStartDate: now,
          pollInterval: minInterval,
          retryCount: 0,
        });
        kv.put("nextPollAt", now);
      }
      emit("session_started", {
        message: isNewSession
          ? "Started new Live Activity session"
          : `Added token to existing session (${tokenCount} tokens)`,
        user: logID,
        environment: request.environment,
        token_prefix: prefix8(request.pushToken),
        kind: isNewSession ? "new" : "token_added",
        token_count: String(tokenCount),
        pts_prefix: ptsPrefix,
        pts_changed: ptsChanged,
        launched_by_push: launchedByPush,
      });

      if (pendingRestart) {
        const latency = Math.trunc((now - pendingRestart.sentAt) / 1000);
        // `push_started` says APNs accepted the start push; this says the device actually
        // relaunched and came back. A `push_started` without one is a dropped restart.
        emit("restart_registered", {
          message: `Re-registered ${latency}s after push-to-start restart`,
          user: logID,
          environment: request.environment,
          kind: isNewSession ? "new" : "token_added",
          source: pendingRestart.source,
          latency_s: String(latency),
          pts_prefix_sent: pendingRestart.pushToStartTokenPrefix,
          pts_prefix_now: ptsPrefix,
          launched_by_push: launchedByPush,
        });
      }
      return "ok";
    });
  }

  /** `POST /end-live-activity`: removes one activity, and the session with its last one. */
  endActivity(username: string, activityID: string): Promise<void> {
    return this.#mutate(async () => {
      const logID = redactedEmailLogID(username);
      // Keyed by the stable activity ID: the push token may have rotated since the client
      // last saw it. The tombstone rejects a late registration racing this call.
      this.#removeToken(activityID, "client_end");
      const removed = this.#tokens().length === 0;
      if (removed) this.#teardown();

      emit("session_ended", {
        message: removed ? "Ended last token, removed session" : "Removed token",
        user: logID,
        reason: "client_end",
        session_removed: String(removed),
        activity_prefix: prefix8(activityID),
      });
    });
  }

  /** `POST /end-live-activities`: dismisses every activity and removes the session. */
  endAll(username: string): Promise<void> {
    return this.#mutate(async () => {
      const logID = redactedEmailLogID(username);
      const tokens = this.#tokens();
      for (const token of tokens) this.#setTombstone(token.activityID, "client_end_all");
      this.#teardown();

      // Without an end push the activities would linger on-device until their own stale
      // date; dismiss clears them now.
      await Promise.all(tokens.map((token) => this.#sendEnd(token.environment, token.pushToken, { dismiss: true })));

      emit("session_ended", {
        message: "Ended all sessions",
        user: logID,
        reason: "client_end_all",
        session_removed: "true",
      });
    });
  }

  /**
   * `POST /restart-live-activity` (debug): the max-duration restart on demand — dismiss
   * the activity, start a fresh one via push-to-start. The session is left as it is; the
   * app re-registers the new activity just as after a real restart.
   */
  debugRestart(username: string, activityID: string): Promise<DebugRestartResult> {
    return this.#mutate(async () => {
      const logID = redactedEmailLogID(username);
      const state = this.ctx.storage.kv.get<PollState>("state");
      if (!state || !this.#exists()) {
        emit(
          "debug_restart_rejected",
          { message: "No session found to restart", user: logID, reason: "no_session" },
          "warn",
        );
        return "noSession";
      }
      const tokens = this.#tokens();
      const token = tokens.find((entry) => entry.activityID === activityID);
      const rejected = (reason: string, message: string) =>
        emit("debug_restart_rejected", { message, user: logID, reason, activity_prefix: prefix8(activityID) }, "warn");
      if (!token) {
        rejected("no_token", "No matching token to restart");
        return "noToken";
      }
      if (!canRestartViaPushToStart(token)) {
        rejected("no_push_to_start", "Token has no push-to-start info");
        return "noPushToStart";
      }

      emit("debug_restart", {
        message: "Debug restart via push-to-start",
        user: logID,
        activity_prefix: prefix8(activityID),
      });
      await this.#sendEnd(token.environment, token.pushToken, {
        sessionStartDate: state.sessionStartDate,
        tokenStartDate: token.startDate,
        tokenCount: tokens.length,
        dismiss: true,
      });
      await this.#restartViaPushToStart(token, {
        state,
        tokenCount: tokens.length,
        now: Date.now(),
        source: "debug",
        logID,
      });
      return "ok";
    });
  }

  /**
   * `GET /glucose-readings`: the cached readings from the last `minutes`, ascending, at
   * most the newest `maxCount`. Undefined when there's no session, the password doesn't
   * match, or nothing is cached yet.
   */
  readings(password: string, minutes: number, maxCount: number): GlucoseReading[] | undefined {
    const cred = this.ctx.storage.kv.get<Cred>("cred");
    const cached = this.ctx.storage.kv.get<PollState>("state")?.readings;
    if (!cred || cred.password !== password || !cached?.length) return undefined;

    const cutoff = Date.now() - minutes * 60_000;
    const filtered = cached.filter((reading) => reading.date >= cutoff).sort((a, b) => a.date - b.date);
    const served = maxCount > 0 ? filtered.slice(-maxCount) : [];
    emit("readings_served", {
      message: `Served ${served.length} cached readings`,
      user: this.#logID(),
      count: String(served.length),
    });
    return served;
  }

  /** The pending restart marker, without consuming it (for `client_event` stamping). */
  peekRestartPending(): RestartPending | undefined {
    const pending = this.#restartPending();
    if (!pending) return undefined;
    const { expiresAt: _, ...marker } = pending;
    return marker;
  }

  // MARK: - Alarm

  /**
   * Polls when due and expires leftovers. A failed cycle is logged, not thrown: the alarm
   * is re-armed either way (and `nextPollAt` was pushed out first, so the poll retries).
   * Only a failure to re-arm is thrown, so the runtime's alarm retry takes over.
   */
  override async alarm(): Promise<void> {
    try {
      this.#purgeExpired();
      const due = this.ctx.storage.kv.get<number>("nextPollAt");
      if (this.#exists() && due !== undefined && due <= Date.now()) {
        this.ctx.storage.kv.put("nextPollAt", Date.now() + crashRetryDelay);
        await this.#armAlarm();
        await this.#pollCycle();
      }
    } catch (error) {
      emit("alarm_failed", { message: "Error processing session", user: this.#logID(), error: String(error) }, "error");
    }
    await this.#settle();
  }

  async #pollCycle(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const username = kv.get<string>("username");
    const cred = kv.get<Cred>("cred");
    const pollState = kv.get<PollState>("state");
    // The caller checked the session exists; this narrows the types.
    if (username === undefined || cred === undefined || pollState === undefined) return;
    const cycle: Cycle = {
      epoch: this.#epoch,
      now: Date.now(),
      logID: redactedEmailLogID(username),
      state: pollState,
      password: cred.password,
      activityIDs: [],
    };
    const { now, logID, state } = cycle;

    // 1. Expire activities at their max duration. This runs before the Dexcom poll so a
    // session whose tokens all expired tears down without spending a Dexcom read. The
    // removals (and tombstones) are written before any await, so a registration landing
    // mid-cycle sees them.
    const tokens = this.#tokens();
    const expired = tokens.filter((token) => now - token.startDate >= maximumDuration * 1000);
    if (expired.length > 0) {
      const remaining = tokens.length - expired.length;
      for (const token of expired) this.#removeToken(token.activityID, "max_duration");
      // Torn down up front, so the restarted activity's registration starts a new session.
      if (remaining === 0) this.#teardown();

      const restarted = await Promise.all(expired.map((token) => this.#expire(token, remaining, cycle)));

      if (remaining === 0) {
        // The normal end of a 7-hour cycle. With `restarted_count` > 0 the device is
        // expected to re-register within seconds (`restart_registered`).
        emit("session_ended", {
          message: "All tokens expired, removing session",
          user: logID,
          reason: "all_tokens_expired",
          expired_count: String(expired.length),
          restarted_count: String(restarted.filter(Boolean).length),
        });
        return;
      }
      if (!this.#isCurrent(cycle)) return;
    }

    // 2. Poll Dexcom.
    cycle.activityIDs = this.#tokens().map((token) => token.activityID);
    const client = new DexcomClient({
      username,
      password: cred.password,
      accountID: state.accountID,
      sessionID: state.sessionID,
      accountLocation: cred.accountLocation,
    });
    const pollStart = Date.now();
    let result: PollResult;
    try {
      result = { readings: (await client.getGlucoseReadings()).sort((a, b) => a.date - b.date) };
    } catch (error) {
      result = { error };
    }

    // One event per poll: the denominator that turns 429 counts into a rate.
    emit("poll", {
      user: logID,
      ...pollOutcome(result),
      latency_ms: String(Date.now() - pollStart),
      poll_interval: String(Math.trunc(state.pollInterval)),
      recovery_active: String(state.recoveryInterval !== undefined),
    });

    if (!this.#isCurrent(cycle)) return;
    state.accountID = client.accountID;
    state.sessionID = client.sessionID;

    // 3. Push, decide the next poll, persist.
    await this.#handlePoll(cycle, result);
    if (cycle.nextPollAt !== undefined) this.#persist(cycle);
  }

  async #handlePoll(cycle: Cycle, result: PollResult): Promise<void> {
    const { state, logID, now } = cycle;

    if ("readings" in result) {
      const { readings } = result;
      const latestReading = readings.at(-1);
      const { lastReading } = state;
      if (!latestReading) {
        const minutesSince = lastReading ? String(Math.trunc((now - lastReading.date) / 60_000)) : "unknown";
        emit(
          "poll_empty",
          {
            message: "No readings available",
            user: logID,
            retry_count: String(state.retryCount),
            minutes_since_last_reading: minutesSince,
          },
          "warn",
        );
        if (lastReading) {
          // An empty response with a cached reading is the same state as one containing
          // only already-seen values: the next reading is due and hasn't appeared.
          await this.#rescheduleWithoutNewReading(cycle, lastReading);
        } else {
          // Nothing to anchor a reading boundary to (fresh sensor, warmup): grow the
          // spacing toward the reading cadence.
          this.#reschedule(cycle, {
            pollInterval: Math.min(state.pollInterval * backoff, overduePollCap(state)),
            delay: Math.max(state.pollInterval, pollFloor(state)),
            resetRetries: true,
          });
        }
        return;
      }
      if (lastReading && latestReading.date <= lastReading.date) {
        await this.#rescheduleWithoutNewReading(cycle, lastReading);
        return;
      }
      await this.#fanOutUpdate(cycle, readings, latestReading);
      return;
    }

    const { error } = result;
    const retryCount = String(state.retryCount);

    if (isCredentialError(error) && this.ctx.storage.kv.get<Cred>("cred")?.password !== cycle.password) {
      // A registration during the poll brought a different password: try it right away.
      emit(
        "poll_error",
        {
          message: "Dexcom rejected the credentials, retrying with updated ones",
          user: logID,
          error_type: "credentials",
          error_code: (error as DexcomError).code ?? "unknown",
          error: String(error),
          retry_count: retryCount,
          will_end: "false",
        },
        "warn",
      );
      cycle.nextPollAt = Date.now();
    } else if (isCredentialError(error)) {
      // Retrying a rejected password can lock the user's Dexcom account.
      emit(
        "poll_error",
        {
          message: "Ending all tokens due to rejected Dexcom credentials",
          user: logID,
          error_type: "credentials",
          error_code: (error as DexcomError).code ?? "unknown",
          error: String(error),
          retry_count: retryCount,
          will_end: "true",
        },
        "error",
      );
      await this.#endAllTokens(cycle, "dexcomError");
    } else if (error instanceof DexcomError && error.httpResponse?.statusCode === 429) {
      // A rate limit whose body decoded as a Dexcom JSON error (app-level limiting, vs.
      // the edge limiter's plain-text and HTML bodies that surface as DexcomDecodingError).
      // Handle it the same way rather than retrying on the normal cadence and ending
      // after a few attempts.
      const plan = rateLimitPlan(state, error.httpResponse, Date.now());
      emit(
        "poll_error",
        {
          message: "Rate limited by Dexcom",
          user: logID,
          error_type: "dexcom",
          status_code: "429",
          endpoint: lastPathComponent(error.httpResponse.url) ?? "unknown",
          error_code: error.code ?? "unknown",
          error: error.message,
          ...retryAfterAttributes(error.httpResponse),
          ...rateLimitAttributes(plan, error.httpResponse),
          retry_count: retryCount,
          will_end: "false",
        },
        "warn",
      );
      this.#rescheduleAfterRateLimit(cycle, plan);
      await this.#sendStaleUpdatesIfNeeded(cycle, "Rate limited");
    } else if (error instanceof DexcomDecodingError) {
      const willEnd = state.pollInterval >= maxInterval && state.retryCount > decodingErrorRetryLimit;
      const ending = willEnd ? ", done retrying, ending all tokens" : "";
      const plan =
        error.statusCode === 429 && !willEnd ? rateLimitPlan(state, error.httpResponse, Date.now()) : undefined;
      emit(
        "poll_error",
        {
          message: `DexcomDecodingError status: ${error.statusCode}${ending}`,
          user: logID,
          error_type: "decoding",
          status_code: String(error.statusCode),
          // Which endpoint failed: ReadPublisherLatestGlucoseValues (readings),
          // AuthenticatePublisherAccount (auth), or LoginPublisherAccountById (login).
          endpoint: lastPathComponent(error.url) ?? "unknown",
          error: error.errorDescription,
          // Whether Dexcom sent Retry-After at all, and how we parsed it.
          ...retryAfterAttributes(error.httpResponse),
          ...(plan && rateLimitAttributes(plan, error.httpResponse)),
          retry_count: retryCount,
          will_end: String(willEnd),
          // On a 429, plain text ("Too many requests.") or a Cloudflare HTML error page
          // here means the edge limiter answered; a Dexcom JSON FaultException means
          // app-level limiting.
          body_prefix: error.body.slice(0, 200),
        },
        willEnd ? "error" : "warn",
      );
      if (willEnd) {
        await this.#endAllTokens(cycle, "tooManyRetries");
        return;
      }
      if (plan) {
        this.#rescheduleAfterRateLimit(cycle, plan);
      } else {
        this.#rescheduleAfterError(cycle);
      }
      await this.#sendStaleUpdatesIfNeeded(cycle, error.statusCode === 429 ? "Rate limited" : "Dexcom error");
    } else {
      const willEnd = state.pollInterval >= maxInterval && state.retryCount >= genericErrorRetryLimit;
      emit(
        "poll_error",
        {
          message: `Error polling for session${willEnd ? ", done retrying, ending all tokens" : ""}`,
          user: logID,
          error_type: "generic",
          error: String(error),
          retry_count: retryCount,
          will_end: String(willEnd),
        },
        willEnd ? "error" : "warn",
      );
      if (willEnd) {
        await this.#endAllTokens(cycle, "tooManyRetries");
        return;
      }
      this.#rescheduleAfterError(cycle);
      await this.#sendStaleUpdatesIfNeeded(cycle, "Polling error");
    }
  }

  // MARK: - Scheduling

  /**
   * After a poll that produced nothing newer than the cached reading: send any due stale
   * milestone, then wait for the next expected reading or recheck on the overdue cadence.
   */
  async #rescheduleWithoutNewReading(cycle: Cycle, lastReading: GlucoseReading): Promise<void> {
    const { state, now } = cycle;
    await this.#sendStaleUpdatesIfNeeded(cycle, "No new readings");

    if ((now - lastReading.date) / 1000 >= readingInterval) {
      const { delay, pollInterval } = overdueReschedule({
        lastReadingDate: lastReading.date,
        now,
        previousPollInterval: state.pollInterval,
        recoveryInterval: state.recoveryInterval,
      });
      this.#reschedule(cycle, { pollInterval, delay, resetRetries: false });
    } else {
      this.#scheduleForNextReading(cycle, lastReading.date);
    }
  }

  #scheduleForNextReading(cycle: Cycle, readingDate: number, update?: ReadingUpdate): void {
    const delay = readingInterval - (cycle.now - readingDate) / 1000 + readingPropagationBuffer;
    this.#reschedule(cycle, { pollInterval: pollFloor(cycle.state), delay, resetRetries: true, update });
  }

  /**
   * After a 429, applies the `rateLimitPlan`: either one quick retry on the server's short
   * `Retry-After`, leaving the session out of recovery, or a backoff to a reading boundary
   * at least the recovery floor out. Once the limit clears, the floor eases polling back
   * in instead of resuming the aggressive overdue cadence.
   */
  #rescheduleAfterRateLimit(cycle: Cycle, plan: RateLimitPlan): void {
    const { state } = cycle;
    const pollInterval = Math.min(state.pollInterval * errorBackoff, maxInterval);
    if (plan.action === "quick_retry") {
      state.rateLimitRetried = true;
    } else {
      state.recoveryInterval = plan.recovery;
      delete state.rateLimitRetried;
    }
    state.retryCount += 1;
    this.#reschedule(cycle, { pollInterval, delay: plan.delay, resetRetries: false });
  }

  #rescheduleAfterError(cycle: Cycle): void {
    const { state } = cycle;
    const delay = state.pollInterval;
    state.retryCount += 1;
    this.#reschedule(cycle, {
      pollInterval: Math.min(state.pollInterval * errorBackoff, maxInterval),
      delay,
      resetRetries: false,
    });
  }

  #reschedule(
    cycle: Cycle,
    options: {
      pollInterval: number;
      /** Seconds from now. */
      delay: number;
      /** A healthy (non-error) poll: clear the retry count and relax the 429 recovery floor a step. */
      resetRetries: boolean;
      update?: ReadingUpdate;
    },
  ): void {
    const { state } = cycle;
    state.pollInterval = options.pollInterval;
    if (options.update) {
      state.lastReading = options.update.reading;
      state.readings = options.update.readings;
    }
    if (options.resetRetries) {
      state.retryCount = 0;
      state.recoveryInterval = decayedRecovery(state.recoveryInterval);
      delete state.rateLimitRetried;
    }
    cycle.nextPollAt = Date.now() + options.delay * 1000;
  }

  /** Writes the cycle's state and next poll, unless the session ended meanwhile. */
  #persist(cycle: Cycle): void {
    if (!this.#isCurrent(cycle) || cycle.nextPollAt === undefined) return;
    this.ctx.storage.kv.put("state", cycle.state);
    this.ctx.storage.kv.put("nextPollAt", cycle.nextPollAt);
    const delay = Math.max(0, Math.round((cycle.nextPollAt - Date.now()) / 1000));
    const time = new Date(cycle.nextPollAt).toISOString().slice(11, 19);
    emit("poll_scheduled", {
      message: `Scheduled for ${time} (in ${Math.floor(delay / 60)}m ${delay % 60}s)`,
      user: cycle.logID,
      delay_s: String(delay),
      poll_interval: String(Math.trunc(cycle.state.pollInterval)),
      recovery_interval: secondsAttribute(cycle.state.recoveryInterval),
      retry_count: String(cycle.state.retryCount),
    });
  }

  // MARK: - Pushes

  /** Pushes a new reading to every activity, dropping tokens APNs says are dead. */
  async #fanOutUpdate(cycle: Cycle, readings: GlucoseReading[], latestReading: GlucoseReading): Promise<void> {
    const { state, logID } = cycle;
    // Read now, after the Dexcom await, so a device that registered mid-poll gets this push.
    const tokens = this.#tokens();

    const rejected = await Promise.all(
      tokens.map((token) => this.#sendReadingUpdate(cycle, token, readings, latestReading, tokens.length)),
    );
    if (!this.#isCurrent(cycle)) return;

    // An Unregistered/ExpiredToken can mean the activity ended, but also that its update
    // token rotated and this push used the previous one. Restarting via push-to-start
    // could spawn a duplicate next to an activity that never went away, so the token is
    // only dropped. A rotation that re-registered during the sends replaced the entry, so
    // it's left alone.
    tokens.forEach((token, index) => {
      const current = this.ctx.storage.kv.get<TokenEntry>(tokenPrefix + token.activityID);
      if (rejected[index] && current?.pushToken === token.pushToken) {
        this.#removeToken(token.activityID, "apns_rejected");
      }
    });

    if (this.#tokens().length === 0) {
      emit("session_ended", {
        message: "All tokens invalid, removing session",
        user: logID,
        reason: "apns_rejected",
        token_count: String(tokens.length),
      });
      this.#teardown();
      return;
    }

    // A fresh reading landed: the next run of staleness starts from the 5m milestone.
    state.lastStaleUpdateMinutes = undefined;
    this.#scheduleForNextReading(cycle, latestReading.date, { reading: latestReading, readings });
  }

  /** Sends one reading update. Resolves true if APNs rejected the token as dead. */
  async #sendReadingUpdate(
    cycle: Cycle,
    token: TokenEntry,
    readings: GlucoseReading[],
    latestReading: GlucoseReading,
    tokenCount: number,
  ): Promise<boolean> {
    const { state, logID } = cycle;
    const alert = alertFor(latestReading, state.lastReading, token.preferences);
    const prefix = prefix8(token.pushToken);
    const attributes = { user: logID, environment: token.environment, token_prefix: prefix, kind: "update" };
    try {
      await this.#send(
        token.environment,
        token.pushToken,
        updatePush({
          readings: trimReadings(readings, token.duration, cycle.now),
          latestReading,
          sessionStartDate: state.sessionStartDate,
          tokenStartDate: token.startDate,
          tokenCount,
          pushToStartAvailable: token.pushToStartToken !== undefined,
          alert,
          now: Date.now(),
        }),
      );
      emit("push_sent", { message: "Sent push", ...attributes, has_alert: String(alert !== undefined) });
      return false;
    } catch (error) {
      if (error instanceof ApnsError) {
        emit(
          "push_failed",
          {
            message: `APNs error: ${error.message}${error.isInvalidToken ? ", removing token" : ""}`,
            ...attributes,
            error_type: "apns",
            apns_reason: error.reason ?? "unknown",
            token_removed: String(error.isInvalidToken),
          },
          "error",
        );
        return error.isInvalidToken;
      }
      emit(
        "push_failed",
        {
          message: `Unexpected error sending push: ${error}`,
          ...attributes,
          error_type: "other",
          error: errorName(error),
        },
        "error",
      );
      return false;
    }
  }

  /** Sends the stale milestone (5, 10, 15 minutes without a reading) once per milestone. */
  async #sendStaleUpdatesIfNeeded(cycle: Cycle, reason: string): Promise<void> {
    const { state, logID, now } = cycle;
    const { lastReading } = state;
    if (!lastReading) return;
    const timeSinceLastReading = (now - lastReading.date) / 1000;
    if (timeSinceLastReading < readingInterval) return;
    const level = staleLevel(timeSinceLastReading);
    if (level === undefined) return;
    const milestone = milestoneMinutes[level];
    if (state.lastStaleUpdateMinutes === milestone) return;

    state.lastStaleUpdateMinutes = milestone;

    const readings = state.readings ?? [lastReading];
    const tokens = this.#tokens();
    await Promise.all(
      tokens.map(async (token) => {
        const prefix = prefix8(token.pushToken);
        const attributes = { user: logID, environment: token.environment, token_prefix: prefix, kind: "stale" };
        try {
          await this.#send(
            token.environment,
            token.pushToken,
            updatePush({
              readings: trimReadings(readings, token.duration, now),
              latestReading: lastReading,
              sessionStartDate: state.sessionStartDate,
              tokenStartDate: token.startDate,
              tokenCount: tokens.length,
              staleLevel: level,
              reason,
              pushToStartAvailable: token.pushToStartToken !== undefined,
              now: Date.now(),
            }),
          );
          emit("push_sent", { message: `Sent stale update push at ${milestone} minutes`, ...attributes });
        } catch (error) {
          const apnsReason = error instanceof ApnsError ? error.reason : undefined;
          emit(
            "push_failed",
            {
              message: `Error sending stale update at ${milestone} minutes: ${error}`,
              ...attributes,
              error_type: apnsReason === undefined ? "other" : "apns",
              apns_reason: apnsReason ?? "",
              error: errorName(error),
            },
            "error",
          );
        }
      }),
    );
  }

  /** Ends one activity at its max duration, restarting it via push-to-start if it opted in. */
  async #expire(token: TokenEntry, tokenCount: number, cycle: Cycle): Promise<boolean> {
    const { state, logID, now } = cycle;
    const willRestart = canRestartViaPushToStart(token);
    await this.#sendEnd(token.environment, token.pushToken, {
      sessionStartDate: state.sessionStartDate,
      tokenStartDate: token.startDate,
      tokenCount,
      dismiss: willRestart,
    });
    const restarted = await this.#restartViaPushToStart(token, {
      state,
      tokenCount,
      now,
      source: "max_duration",
      logID,
    });
    emit("push_ended", {
      message: `Reached max duration${willRestart ? ", restarting via push-to-start" : ""}`,
      user: logID,
      environment: token.environment,
      token_prefix: prefix8(token.pushToken),
      reason: willRestart ? "max_duration_restarted" : "max_duration",
    });
    return restarted;
  }

  /**
   * Ends the activities that were registered when the poll started, and the session with
   * them. A device that registered during the Dexcom call isn't part of the failure: it
   * keeps the session alive, and the next poll (already scheduled a minute out) serves it.
   */
  async #endAllTokens(cycle: Cycle, reason: EndReason): Promise<void> {
    const { state, logID } = cycle;
    // Current entries, so a token that rotated during the poll gets the end push.
    const tokens = cycle.activityIDs
      .map((activityID) => this.ctx.storage.kv.get<TokenEntry>(tokenPrefix + activityID))
      .filter((token) => token !== undefined);
    for (const token of tokens) this.#removeToken(token.activityID, reason);
    if (this.#tokens().length === 0) this.#teardown();

    await Promise.all(
      tokens.map(async (token) => {
        await this.#sendEnd(token.environment, token.pushToken, {
          sessionStartDate: state.sessionStartDate,
          tokenStartDate: token.startDate,
          tokenCount: tokens.length,
          dismiss: false,
        });
        emit("push_ended", {
          user: logID,
          environment: token.environment,
          token_prefix: prefix8(token.pushToken),
          reason,
        });
      }),
    );

    emit("session_ended", {
      message: `Session ended (${tokens.length} tokens): ${reason}`,
      user: logID,
      reason,
      token_count: String(tokens.length),
    });
  }

  /**
   * Starts a fresh activity on the token's device, seeded with the cached readings so it
   * renders real data until the restarted session's first push. The app observes it,
   * captures its update token, and re-registers. Leaves the marker that `start` consumes
   * to report `restart_registered`. Resolves whether APNs accepted the push.
   */
  async #restartViaPushToStart(
    token: TokenEntry,
    context: {
      state: PollState;
      tokenCount: number;
      now: number;
      source: "max_duration" | "debug";
      logID: string;
    },
  ): Promise<boolean> {
    const { pushToStartToken, attributesType, attributes } = token;
    if (pushToStartToken === undefined || attributesType === undefined || attributes === undefined) return false;
    const { state, now, logID } = context;
    const prefix = prefix8(pushToStartToken);
    const event = { user: logID, environment: token.environment, token_prefix: prefix, kind: "push_to_start" };
    const apns = this.#apnsClient();
    if (!apns) {
      const error = new ApnsNotConfiguredError();
      emit(
        "push_failed",
        { message: "Push-to-start skipped: APNs not configured", ...event, error_type: "other", error: error.name },
        "error",
      );
      return false;
    }

    const pushToStartTokenUpdatedAt = token.pushToStartTokenUpdatedAt ?? token.startDate;
    const seed = state.readings ?? (state.lastReading ? [state.lastReading] : []);
    // Written before the send: a device can relaunch and re-register before APNs answers,
    // and that registration must find the marker.
    const marker: StoredRestartPending = {
      sentAt: now,
      pushToStartTokenPrefix: prefix,
      pushToStartTokenUpdatedAt,
      environment: token.environment,
      source: context.source,
      // Lives as long as an activity could, so a device that only registers the restarted
      // activity when the user next opens the app is still attributed, with the real latency.
      expiresAt: now + dataTTLSeconds * 1000,
    };
    this.ctx.storage.kv.put("restartPending", marker);
    try {
      await apns.send(
        token.environment,
        pushToStartToken,
        startPush({
          attributesType,
          attributes,
          latestReading: state.lastReading,
          readings: trimReadings(seed, token.duration, now),
          sessionStartDate: state.sessionStartDate,
          tokenCount: context.tokenCount,
          now,
        }),
      );
    } catch (error) {
      const failure: Record<string, string> =
        error instanceof ApnsError
          ? {
              message: `Push-to-start failed: ${error.message}`,
              error_type: "apns",
              apns_reason: error.reason ?? "unknown",
            }
          : {
              message: `Unexpected error sending push-to-start: ${error}`,
              error_type: "other",
              error: errorName(error),
            };
      emit("push_failed", { ...event, ...failure }, "error");
      // Unless it was already taken, or replaced by another restart's.
      if (JSON.stringify(this.ctx.storage.kv.get("restartPending")) === JSON.stringify(marker)) {
        this.ctx.storage.kv.delete("restartPending");
      }
      return false;
    }

    // Only says APNs accepted the push; `restart_registered` says the device acted on it.
    // `pts_age_s` is how long ago the client last changed this push-to-start token — a
    // stale token is one candidate for restarts APNs accepts but the device never honors.
    const ptsAge = Math.trunc((now - pushToStartTokenUpdatedAt) / 1000);
    emit("push_started", { message: "Sent push-to-start", ...event, pts_age_s: String(ptsAge) });
    return true;
  }

  /** Sends an end push, best effort: failures and an unconfigured APNs are ignored. */
  async #sendEnd(environment: PushEnvironment, pushToken: string, input: Omit<EndPushInput, "now">): Promise<void> {
    try {
      await this.#apnsClient()?.send(environment, pushToken, endPush({ ...input, now: Date.now() }));
    } catch {
      // The activity still ends on-device at its stale date.
    }
  }

  async #send(environment: PushEnvironment, pushToken: string, push: LiveActivityPush): Promise<void> {
    const apns = this.#apnsClient();
    if (!apns) throw new ApnsNotConfiguredError();
    await apns.send(environment, pushToken, push);
  }

  #apnsClient(): ApnsClient | undefined {
    if (!apnsKey(this.env)) return undefined;
    this.#apns ??= new ApnsClient({ getJwt: (options) => this.#providerToken(options?.forceRefresh ?? false) });
    return this.#apns;
  }

  /** The deployment's shared APNs provider token, cached until the Registry replaces it. */
  async #providerToken(forceRefresh: boolean): Promise<string> {
    if (forceRefresh || !this.#jwt || Date.now() >= this.#jwt.refreshAt) {
      this.#jwt = await this.env.REGISTRY.getByName("global").apnsJwt({ forceRefresh });
    }
    if (!this.#jwt) throw new ApnsNotConfiguredError();
    return this.#jwt.token;
  }

  // MARK: - Storage

  /** A session exists while it has credentials and poll state. */
  #exists(): boolean {
    const kv = this.ctx.storage.kv;
    return kv.get("cred") !== undefined && kv.get("state") !== undefined;
  }

  #tokens(): TokenEntry[] {
    return Array.from(this.ctx.storage.kv.list<TokenEntry>({ prefix: tokenPrefix }), ([, token]) => token);
  }

  #isCurrent(cycle: Cycle): boolean {
    return this.#epoch === cycle.epoch && this.#exists();
  }

  #logID(): string {
    return redactedEmailLogID(this.ctx.storage.kv.get<string>("username") ?? "");
  }

  /** Drops one activity's token and tombstones it so it can never re-register. */
  #removeToken(activityID: string, reason: string): void {
    this.#setTombstone(activityID, reason);
    this.ctx.storage.kv.delete(tokenPrefix + activityID);
  }

  #setTombstone(activityID: string, reason: string): void {
    this.ctx.storage.kv.put<Tombstone>(endedPrefix + activityID, {
      reason,
      expiresAt: Date.now() + dataTTLSeconds * 1000,
    });
  }

  #endedReason(activityID: string): string | undefined {
    const tombstone = this.ctx.storage.kv.get<Tombstone>(endedPrefix + activityID);
    return tombstone && tombstone.expiresAt > Date.now() ? tombstone.reason : undefined;
  }

  #restartPending(): StoredRestartPending | undefined {
    const pending = this.ctx.storage.kv.get<StoredRestartPending>("restartPending");
    return pending && pending.expiresAt > Date.now() ? pending : undefined;
  }

  /** Removes the session (credentials, state, tokens). Tombstones and the restart marker stay. */
  #teardown(): void {
    this.#epoch += 1;
    const kv = this.ctx.storage.kv;
    for (const token of this.#tokens()) kv.delete(tokenPrefix + token.activityID);
    kv.delete("cred");
    kv.delete("state");
    kv.delete("nextPollAt");
  }

  #purgeExpired(): void {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    for (const [key, tombstone] of kv.list<Tombstone>({ prefix: endedPrefix })) {
      if (tombstone.expiresAt <= now) kv.delete(key);
    }
    if (kv.get<StoredRestartPending>("restartPending") && !this.#restartPending()) kv.delete("restartPending");
  }

  // MARK: - Bookkeeping

  async #mutate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      await this.#settle();
    }
  }

  /** After any change: report counts to the Registry, then re-arm the alarm or clean up. */
  async #settle(): Promise<void> {
    await this.#report();
    await this.#armAlarm();
  }

  /** Reports this user's counts when they changed (or hourly, to keep the row fresh). */
  async #report(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const username = kv.get<string>("username");
    if (username === undefined) return;
    const counts: SessionCounts | null = this.#exists()
      ? {
          activities: this.#tokens().length,
          rateLimited: kv.get<PollState>("state")?.recoveryInterval === undefined ? 0 : 1,
        }
      : null;
    const reported = kv.get<SessionCounts & { at: number }>("reported");
    const now = Date.now();
    if (counts === null ? reported === undefined : isFreshReport(reported, counts, now)) return;

    // Recorded before the await, so an interleaved request doesn't report the same change.
    const recorded = counts === null ? undefined : { ...counts, at: now };
    if (recorded) kv.put("reported", recorded);
    else kv.delete("reported");
    this.#reporting = this.#reporting.then(async () => {
      try {
        await this.env.REGISTRY.getByName("global").report(username, counts);
      } catch (error) {
        const user = redactedEmailLogID(username);
        emit("registry_report_failed", { message: "Failed to report counts", user, error: String(error) }, "error");
        // Undo the record so the next change retries, unless a newer report replaced it.
        if (JSON.stringify(kv.get("reported")) !== JSON.stringify(recorded)) return;
        if (reported) kv.put("reported", reported);
        else kv.delete("reported");
      }
    });
    await this.#reporting;
  }

  /**
   * One alarm serves polling and expiry: the earliest of the next poll and the next
   * tombstone / restart-marker expiry. With none of those left, the object deletes itself.
   */
  async #armAlarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times: number[] = [];
    const nextPollAt = kv.get<number>("nextPollAt");
    if (this.#exists() && nextPollAt !== undefined) times.push(nextPollAt);
    for (const [, tombstone] of kv.list<Tombstone>({ prefix: endedPrefix })) times.push(tombstone.expiresAt);
    const pending = kv.get<StoredRestartPending>("restartPending");
    if (pending) times.push(pending.expiresAt);

    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...times));
    }
  }
}

// MARK: - Helpers

function canRestartViaPushToStart(token: TokenEntry): boolean {
  // All three are needed to recreate the activity on-device: a start push with missing
  // attributes would fail to decode into the activity's ActivityAttributes.
  return token.pushToStartToken !== undefined && token.attributesType !== undefined && token.attributes !== undefined;
}

function isFreshReport(
  reported: (SessionCounts & { at: number }) | undefined,
  counts: SessionCounts,
  now: number,
): boolean {
  return (
    reported !== undefined &&
    reported.activities === counts.activities &&
    reported.rateLimited === counts.rateLimited &&
    now - reported.at < reportHeartbeat
  );
}

function prefix8(text: string): string {
  return text.slice(0, 8);
}

/** The error's type name, like Swift's `String(describing: type(of: error))`. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function pollOutcome(result: PollResult): Record<string, string> {
  if ("readings" in result) {
    return { outcome: result.readings.length === 0 ? "empty" : "success", status_code: "200", endpoint: "readings" };
  }
  const { error } = result;
  const httpResponse =
    error instanceof DexcomDecodingError || error instanceof DexcomError ? error.httpResponse : undefined;
  return {
    outcome: "error",
    status_code: httpResponse ? String(httpResponse.statusCode) : "unknown",
    endpoint: lastPathComponent(httpResponse?.url) ?? "unknown",
  };
}

/** Whole seconds, or "none". */
function secondsAttribute(seconds: number | undefined): string {
  return seconds === undefined ? "none" : String(Math.trunc(seconds));
}

/**
 * What a 429 led to, plus the response's headers: the only evidence of which limiter
 * answered (edge vs. app, per-IP vs. per-account). Cookies are left out.
 */
function rateLimitAttributes(plan: RateLimitPlan, httpResponse: DexcomHTTPResponse): Record<string, string> {
  const { "set-cookie": _, ...headers } = httpResponse.headers;
  return {
    rate_limit_action: plan.action,
    retry_delay_s: String(Math.round(plan.delay)),
    recovery_interval: secondsAttribute(plan.action === "backoff" ? plan.recovery : undefined),
    response_headers: JSON.stringify(headers).slice(0, 1000),
  };
}

function retryAfterAttributes(httpResponse: DexcomHTTPResponse | undefined): Record<string, string> {
  const retryAfter = httpResponse?.retryAfter;
  return {
    retry_after: secondsAttribute(retryAfter),
    retry_after_header: httpResponse?.header("Retry-After") ?? "none",
  };
}
