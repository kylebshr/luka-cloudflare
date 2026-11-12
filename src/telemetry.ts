// Telemetry: each event is one structured log line. Workers Logs indexes every field, and
// Workers Observability exports logs (and traces) over OpenTelemetry to the destinations
// named in wrangler.jsonc. Event names and attributes are the queryable schema; `message`
// is the human-readable line for `wrangler tail`.

export type Level = "log" | "warn" | "error";

export function emit(event: string, attributes: Record<string, string> = {}, level: Level = "log"): void {
  console[level]({ ...attributes, event });
}
