// The alert attached to a reading update when glucose crosses the target range or moves
// rapidly. Port of `LiveActivityScheduler.alert(for:lastReading:preferences:)`.

import { formatGlucose } from "./glucose-format";
import type { GlucoseReading, LiveActivityPreferences, TrendDirection } from "./types";

// Non-directional trends have no adjective; the alert text falls back to one that fits
// the range it's in.
const trendAdjectives: Record<TrendDirection, string | undefined> = {
  Flat: "stable",
  FortyFiveUp: "rising slowly",
  SingleUp: "rising",
  DoubleUp: "rising quickly",
  FortyFiveDown: "falling slowly",
  SingleDown: "falling",
  DoubleDown: "falling quickly",
  None: undefined,
  NotComputable: undefined,
  RateOutOfRange: undefined,
};

export interface Alert {
  title: string;
  body: string;
}

/**
 * An alert for `reading` when it entered or left the target range since `lastReading`,
 * or is trending rapidly (double arrow). Undefined when there's no previous reading,
 * no preferences, alerts are off, or nothing alert-worthy happened.
 */
export function alertFor(
  reading: GlucoseReading,
  lastReading: GlucoseReading | undefined,
  preferences: LiveActivityPreferences | undefined,
): Alert | undefined {
  if (!lastReading || !preferences || !(preferences.alertsEnabled ?? true)) return undefined;

  const [lower, upper] = preferences.targetRange;
  const inRange = (value: number) => lower <= value && value <= upper;
  const isRapidTrend = reading.trend === "DoubleDown" || reading.trend === "DoubleUp";
  const didEnterOrLeaveTargetRange = inRange(reading.value) !== inRange(lastReading.value);

  if (!isRapidTrend && !didEnterOrLeaveTargetRange) return undefined;

  const value = formatGlucose(reading.value, preferences.unit);
  const lastValue = formatGlucose(lastReading.value, preferences.unit);
  const adjective = trendAdjectives[reading.trend];

  if (reading.value > upper) {
    return { title: "High Glucose", body: `Now ${value} and ${adjective ?? "rising"}, was ${lastValue}.` };
  }
  if (reading.value < lower) {
    return { title: "Low Glucose", body: `Now ${value} and ${adjective ?? "falling"}, was ${lastValue}.` };
  }
  return { title: "Back in Range", body: `Now ${value} and ${adjective ?? "steady"}, was ${lastValue}.` };
}
