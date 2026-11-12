import { afterEach, expect, it, vi } from "vitest";
import { emit } from "../src/telemetry";

afterEach(() => {
  vi.restoreAllMocks();
});

it("logs one structured line per event, at the requested level", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  emit("poll", { user: "k•••@example.com", outcome: "success" });
  emit("push_failed", { message: "APNs error", event: "spoofed" }, "error");

  expect(log.mock.calls).toEqual([[{ user: "k•••@example.com", outcome: "success", event: "poll" }]]);
  // The event name always wins over an attribute of the same key.
  expect(error.mock.calls).toEqual([[{ message: "APNs error", event: "push_failed" }]]);
});
