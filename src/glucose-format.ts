// Port of `dexcom-swift`'s `GlucoseFormatter` (`value.formatted(.glucose(unit))`).

import type { GlucoseUnit } from "./types";

/**
 * Sentinel the Share API reports for a reading below the sensor's measurable range
 * (40–400 mg/dL). Displayed as "Low".
 */
export const lowestGlucoseValue = 39;

/**
 * Sentinel the Share API reports for a reading above the sensor's measurable range
 * (40–400 mg/dL). Displayed as "Hi".
 */
export const highestGlucoseValue = 401;

export const mmolConversionFactor = 0.0555;

// Foundation's number formatting rounds half-to-even.
const mmolFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  roundingMode: "halfEven",
});

/** Formats a mg/dL reading for display, e.g. `"120"`, `"6.7"`, `"Low"`, `"Hi"`. */
export function formatGlucose(value: number, unit: GlucoseUnit): string {
  // The sentinels aren't real numbers, so they read "Low"/"Hi" regardless of unit. The
  // casing assumes the app applies small caps at display time.
  if (value <= lowestGlucoseValue) return "Low";
  if (value >= highestGlucoseValue) return "Hi";

  switch (unit) {
    case "mgdl":
      return String(value);
    case "mmolL":
      return mmolFormat.format(value * mmolConversionFactor);
  }
}
