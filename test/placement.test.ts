import { describe, expect, it } from "vitest";
import { hintedLocation, hintedShare, sessionLocationHint } from "../src/placement";

describe("sessionLocationHint", () => {
  it("hints a fixed share of usernames, the same way every time", () => {
    const usernames = Array.from({ length: 5000 }, (_, index) => `user${index}@example.com`);
    const hinted = usernames.filter((username) => sessionLocationHint(username) !== undefined);
    expect(hinted.length / usernames.length).toBeCloseTo(hintedShare, 1);
    for (const username of hinted) expect(sessionLocationHint(username)).toBe(hintedLocation);
  });
});
