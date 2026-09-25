import type { SourceConfig } from "./config";
import { MetadataOnlyStore } from "./omezarr/store";

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; }
interface CachedToken { identity: string; value: string; expiresAt: number; }
let cachedToken: CachedToken | undefined;

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown) { return base64Url(new TextEncoder().encode(JSON.stringify(value))); }

function pemBytes(pem: string) {
  const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  if (!raw) throw new Error("private_key is not a PKCS#8 PEM key");
  const binary = atob(raw);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.client_email !== "string" || !item.client_email || typeof item.private_key !== "string" || !item.private_key.includes("BEGIN PRIVATE KEY")) return null;
  if (item.token_uri !== undefined && (typeof item.token_uri !== "string" || item.token_uri !== "https://oauth2.googleapis.com/token")) return null;
  return { client_email: item.client_email, private_key: item.private_key, token_uri: item.token_uri as string | undefined };
}

export async function mintAccessToken(account: ServiceAccount, fetcher: typeof fetch = fetch) {
  if (cachedToken?.identity === account.client_email && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({ iss: account.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_only", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const response = await fetcher(account.token_uri ?? "https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token exchange returned no access token.");
  cachedToken = { identity: account.client_email, value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

export async function metadataStoreFor(source: SourceConfig, finalPath: string, account: ServiceAccount, fetcher: typeof fetch = fetch) {
  const accessToken = await mintAccessToken(account, fetcher);
  return new MetadataOnlyStore({ bucket: source.bucket, rootPath: finalPath, accessToken, fetcher });
}

async function cappedBody(response: Response, limit: number, what: string) {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${what} exceeds the ${limit} byte limit.`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error(`${what} exceeds the ${limit} byte limit.`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Read one named object; null when it is absent.
 *
 * Published reports and their figures are named objects, which the Zarr store
 * deliberately refuses: its allowlist exists to keep chunk keys unreachable,
 * and widening it would weaken that guarantee. Callers name the object from a
 * validated dataset reference, never from raw request input.
 *
 * A null account reads anonymously, for deployments that publish reports
 * openly instead of holding a key. That is strictly less capable than the
 * credentialled path -- it reaches only what is already world-readable -- and
 * the caller still confines it to a configured source, so the Worker cannot be
 * turned into a general fetcher either way.
 */
export async function readObject(bucket: string, objectName: string, account: ServiceAccount | null, limit: number, fetcher: typeof fetch = fetch) {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const init = account ? { headers: { Authorization: `Bearer ${await mintAccessToken(account, fetcher)}` } } : {};
  const response = await fetcher(url, init);
  if (response.status === 404) return null;
  // Anonymously, a private object denies rather than 404s; name the fix.
  if (!account && (response.status === 401 || response.status === 403)) {
    throw new Error(`${objectName} is not publicly readable, and GCS_SA_KEY is not configured.`);
  }
  if (!response.ok) throw new Error(`GCS request failed (${response.status}) for ${objectName}`);
  return { bytes: await cappedBody(response, limit, objectName), contentType: response.headers.get("Content-Type") ?? "application/octet-stream" };
}
