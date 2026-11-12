import { describe, expect, it } from "vitest";
import { alertFor } from "../src/alerts";
import { formatGlucose } from "../src/glucose-format";
import type { GlucoseReading, LiveActivityPreferences, TrendDirection } from "../src/types";

describe("formatGlucose", () => {
  it("formats mg/dL as whole numbers", () => {
    expect(formatGlucose(40, "mgdl")).toBe("40");
    expect(formatGlucose(120, "mgdl")).toBe("120");
    expect(formatGlucose(400, "mgdl")).toBe("400");
  });

  it("converts to mmol/L with one decimal, rounding half-to-even like Foundation", () => {
    // Expected values produced by the Swift GlucoseFormatter.
    const swift: [number, string][] = [
      [40, "2.2"],
      [54, "3.0"],
      [70, "3.9"],
      [99, "5.5"],
      [100, "5.6"],
      [109, "6.0"],
      [120, "6.7"],
      [180, "10.0"],
      [181, "10.0"],
      [300, "16.6"],
      [400, "22.2"],
    ];
    for (const [value, text] of swift) {
      expect(formatGlucose(value, "mmolL"), `${value}`).toBe(text);
    }
  });

  it("shows the out-of-range sentinels as Low and Hi in any unit", () => {
    for (const unit of ["mgdl", "mmolL"] as const) {
      expect(formatGlucose(39, unit)).toBe("Low");
      expect(formatGlucose(0, unit)).toBe("Low");
      expect(formatGlucose(401, unit)).toBe("Hi");
    }
  });
});

describe("alertFor", () => {
  const reading = (value: number, trend: TrendDirection = "Flat"): GlucoseReading => ({ value, trend, date: 0 });
  const preferences: LiveActivityPreferences = { targetRange: [70, 180], unit: "mgdl" };

  it("requires a previous reading, preferences, and alerts enabled", () => {
    expect(alertFor(reading(200), undefined, preferences)).toBeUndefined();
    expect(alertFor(reading(200), reading(150), undefined)).toBeUndefined();
    expect(alertFor(reading(200), reading(150), { ...preferences, alertsEnabled: false })).toBeUndefined();
    expect(alertFor(reading(200), reading(150), { ...preferences, alertsEnabled: true })).toBeDefined();
  });

  it("stays quiet while the range status is unchanged and the trend isn't rapid", () => {
    expect(alertFor(reading(120, "SingleUp"), reading(110), preferences)).toBeUndefined();
    expect(alertFor(reading(220), reading(200), preferences)).toBeUndefined();
  });

  it("alerts when leaving the range high", () => {
    expect(alertFor(reading(181, "FortyFiveUp"), reading(180), preferences)).toEqual({
      title: "High Glucose",
      body: "Now 181 and rising slowly, was 180.",
    });
  });

  it("alerts when leaving the range low", () => {
    expect(alertFor(reading(69, "SingleDown"), reading(70), preferences)).toEqual({
      title: "Low Glucose",
      body: "Now 69 and falling, was 70.",
    });
  });

  it("alerts when coming back in range", () => {
    expect(alertFor(reading(150, "Flat"), reading(190), preferences)).toEqual({
      title: "Back in Range",
      body: "Now 150 and stable, was 190.",
    });
  });

  it("alerts on rapid trends even without a range change", () => {
    expect(alertFor(reading(250, "DoubleUp"), reading(220), preferences)?.body).toBe(
      "Now 250 and rising quickly, was 220.",
    );
    expect(alertFor(reading(120, "DoubleDown"), reading(150), preferences)).toEqual({
      title: "Back in Range",
      body: "Now 120 and falling quickly, was 150.",
    });
  });

  it("formats values in the preferred unit", () => {
    expect(alertFor(reading(200, "SingleUp"), reading(170), { ...preferences, unit: "mmolL" })?.body).toBe(
      "Now 11.1 and rising, was 9.4.",
    );
    expect(alertFor(reading(39, "SingleDown"), reading(75), preferences)?.body).toBe("Now Low and falling, was 75.");
  });

  it("falls back to a range-appropriate adjective for non-directional trends", () => {
    expect(alertFor(reading(200, "NotComputable"), reading(150), preferences)?.body).toBe(
      "Now 200 and rising, was 150.",
    );
    expect(alertFor(reading(60, "None"), reading(80), preferences)?.body).toBe("Now 60 and falling, was 80.");
    expect(alertFor(reading(100, "RateOutOfRange"), reading(200), preferences)?.body).toBe(
      "Now 100 and steady, was 200.",
    );
  });
});
