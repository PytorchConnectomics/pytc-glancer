import type { AppConfig } from "./config";

export interface NeuroglancerState { layers: unknown[]; [key: string]: unknown; }

export function shortKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function validateState(value: unknown): NeuroglancerState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).layers)) throw new Error("state must be an object with a layers array.");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw new Error("state must be at most 1 MiB when serialized.");
  return value as NeuroglancerState;
}

export function validateUrlBase(raw: string, config: AppConfig) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("url_base is not a valid URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("url_base must be https with no query, fragment, or userinfo.");
  if (!config.viewerOrigins.includes(url.origin)) throw new Error("url_base origin is not allowlisted.");
  return url.toString().replace(/\/$/, "");
}

export function shareableLink(urlBase: string, appOrigin: string, key: string, name?: string | null) {
  return `${urlBase}#!${appOrigin}/ng/${key}${name ? `/${name}` : ""}`;
}

export function publicOrigin(request: Request) {
  const url = new URL(request.url);
  // Behind the Cloudflare tunnel, TLS terminates at Cloudflare and cloudflared
  // forwards plain HTTP to loopback, so request.url carries the http scheme
  // even though the browser reached the app over https. Emitting that scheme
  // into a shareable link makes the external https viewer fetch an http state
  // URL, which the browser blocks as mixed content. Loopback keeps its real
  // scheme so local development over http still works. This mirrors the
  // loopback test the login cookie uses to decide its Secure flag.
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return url.origin;
  return `https://${url.host}`;
}

export async function parseNeuroglancerUrl(input: string, appOrigin: string, db: D1Database, config: AppConfig) {
  const separator = input.indexOf("#!");
  if (separator < 1) throw new Error("Neuroglancer URL must contain a #! state fragment.");
  const urlBase = validateUrlBase(input.slice(0, separator), config);
  const fragment = input.slice(separator + 2);
  if (!fragment) throw new Error("Neuroglancer state fragment is empty.");

  const candidates = [fragment];
  try { const decoded = decodeURIComponent(fragment); if (decoded !== fragment) candidates.push(decoded); } catch { /* invalid percent encoding is handled below */ }
  for (const candidate of candidates) {
    try { return { urlBase, state: validateState(JSON.parse(candidate)) }; } catch (error) { if (error instanceof Error && error.message.includes("layers array")) throw error; }
  }

  let stateUrl: URL;
  try { stateUrl = new URL(candidates.at(-1)!); } catch { throw new Error("State fragment is neither inline JSON nor a valid state URL."); }
  if (stateUrl.origin !== appOrigin || stateUrl.search || stateUrl.hash) throw new Error("Remote state URLs are not supported; only this pytc_glancer origin may be imported.");
  const match = /^\/ng\/([a-z2-7]{32})(?:\/[a-z0-9-]+)?$/.exec(stateUrl.pathname);
  if (!match) throw new Error("State URL must match this app's /ng/<short_key> route.");
  const row = await db.prepare("SELECT state FROM glances WHERE short_key = ?").bind(match[1]).first<{ state: string }>();
  if (!row) throw new Error("The imported pytc_glancer state does not exist.");
  return { urlBase, state: validateState(JSON.parse(row.state)) };
}
