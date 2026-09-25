export type ErrorCode = "no_report" | "changed" | "outcome_changed" | "needs_acceptance" | "gone" | "no_such_point" | "already_current" | "unauthorized" | "not_found" | "conflict" | "archived" | "invalid_request" | "no_sources_configured" | "source_unavailable" | "report_unavailable" | "composition_unavailable" | "review_unreadable" | "internal_error";

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: result });
}

export function failure(code: ErrorCode, detail: string, status: number) { return json({ error: code, detail }, status, { "Cache-Control": "no-store" }); }

export async function bodyObject(request: Request) {
  let value: unknown;
  try { value = await request.json(); } catch { throw new Error("Body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function rejectUnknown(body: Record<string, unknown>, allowed: string[]) {
  const field = Object.keys(body).find((key) => !allowed.includes(key));
  if (field) throw new Error(`Unknown field: ${field}`);
}
