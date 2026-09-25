/** Read an API response as JSON, or report what actually came back.
 *
 * Every pytc_glancer API route answers JSON, but the panels do not always get
 * one: a tunnel, proxy, or edge in front of the Worker answers its own error
 * page when the origin is unreachable or slow, and those pages are HTML.
 * Parsing one blindly reported `Unexpected token '<'`, which names the parser
 * rather than the failure and hides the status that would explain it, so read
 * the status first and keep the body only as context.
 */

const MAX_EXCERPT = 160;

function status(response: Response) {
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

/** The request's path, for an error that must say which call failed. */
function where(response: Response) {
  try { return new URL(response.url).pathname; } catch { return "The server"; }
}

/** What arrived instead of JSON: an HTML page is named, anything else quoted. */
function shape(text: string) {
  const body = text.trim();
  if (!body) return "an empty body";
  if (/^<(?:!doctype|html|\?xml)/i.test(body)) return "an HTML page";
  return `"${body.length > MAX_EXCERPT ? `${body.slice(0, MAX_EXCERPT)}…` : body}"`;
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { detail?: string }) | undefined;
  try { body = text.trim() ? JSON.parse(text) as T & { detail?: string } : undefined; }
  catch { throw new Error(`${where(response)} answered ${status(response)} with ${shape(text)}, not JSON.`); }
  // A failure the API itself wrote carries the detail worth showing; anything
  // else at least names its status.
  if (!response.ok) throw new Error(body?.detail ?? `${where(response)} failed (${status(response)}).`);
  if (body === undefined) throw new Error(`${where(response)} answered ${status(response)} with an empty body.`);
  return body;
}
