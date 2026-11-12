import { expect, it } from "vitest";
import { dashboardHtml } from "../src/dashboard";

it("renders each count", () => {
  const html = dashboardHtml({ sessions: 12, activities: 34, rateLimited: 5 });

  expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n')).toBe(true);
  expect(html.endsWith("</body>\n</html>")).toBe(true);
  for (const [label, value] of [
    ["Sessions", "12"],
    ["Live Activities", "34"],
    ["Rate limited", "5"],
  ]) {
    expect(html).toContain(label);
    expect(html).toContain(`>${value}<`);
  }
});

it("lays tiles out exactly as the Swift template did", () => {
  const html = dashboardHtml({ sessions: 1234, activities: 0, rateLimited: 0 });
  expect(html).toContain(
    [
      '    <div class="tiles">',
      '        <div class="tile">',
      '          <div class="label">Sessions</div>',
      '          <div class="value">1,234</div>',
      '          <div class="hint">Dexcom accounts being polled</div>',
      "        </div>",
      '        <div class="tile">',
    ].join("\n"),
  );
  expect(html).toContain(
    '          <div class="hint">Sessions backing off from Dexcom</div>\n        </div>\n    </div>\n',
  );
});
