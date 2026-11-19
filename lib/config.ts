export interface SourceConfig {
  id: string;
  label: string;
  bucket: string;
  prefix: string;
  ngauth_base: string;
}

export interface AppConfig {
  sources: SourceConfig[];
  viewerOrigins: string[];
  defaultViewerUrl: string;
  publicState: boolean;
  /** tldraw licence key for the Roadmaps canvas; tldraw needs one on a public https host. */
  tldrawLicenseKey: string | null;
}

interface ConfigEnv {
  PYTC_GLANCER_SOURCES?: string;
  PYTC_GLANCER_VIEWER_ORIGINS?: string;
  PYTC_GLANCER_DEFAULT_VIEWER_URL?: string;
  PYTC_GLANCER_PUBLIC_STATE?: string;
  PYTC_GLANCER_TLDRAW_LICENSE_KEY?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

function issue(entry: string, detail: string): never {
  throw new Error(`Invalid PYTC_GLANCER_SOURCES entry ${entry}: ${detail}`);
}

function normalizePrefix(value: unknown, entry: string) {
  if (typeof value !== "string") issue(entry, "prefix must be a string");
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (prefix.length > 512) issue(entry, "prefix exceeds 512 characters");
  if (/[\u0000-\u001f\u007f]/.test(prefix)) issue(entry, "prefix contains a control character");
  const parts = prefix ? prefix.split("/") : [];
  if (parts.some((part) => !part)) issue(entry, "prefix contains an empty // segment");
  if (parts.includes("..")) issue(entry, "prefix contains a .. segment");
  return prefix;
}

function normalizeNgauthBase(value: unknown, entry: string) {
  if (typeof value !== "string") issue(entry, "ngauth_base must be a string");
  let url: URL;
  try { url = new URL(value); } catch { issue(entry, "ngauth_base is not a valid URL"); }
  if (url.protocol !== "https:") issue(entry, "ngauth_base must use https");
  if (!url.hostname) issue(entry, "ngauth_base must have a host");
  if (url.username || url.password) issue(entry, "ngauth_base must not contain userinfo");
  if (url.search || url.hash) issue(entry, "ngauth_base must not contain a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") issue(entry, "ngauth_base path must be empty or /");
  return url.origin;
}

export function parseSources(raw: string | undefined): SourceConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid PYTC_GLANCER_SOURCES JSON"); }
  if (!Array.isArray(parsed)) throw new Error("Invalid PYTC_GLANCER_SOURCES: expected an array");
  const seen = new Set<string>();
  return parsed.map((candidate, index) => {
    const entry = `[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) issue(entry, "expected an object");
    const item = candidate as Record<string, unknown>;
    const allowed = new Set(["id", "label", "bucket", "prefix", "ngauth_base"]);
    const unknown = Object.keys(item).find((key) => !allowed.has(key));
    if (unknown) issue(entry, `unknown field ${unknown}`);
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) issue(entry, "id must match ^[a-z0-9][a-z0-9_-]{0,62}$");
    if (seen.has(item.id)) issue(entry, `duplicate id ${item.id}`);
    seen.add(item.id);
    if (typeof item.label !== "string" || !item.label.trim()) issue(entry, "label must be non-empty");
    if (typeof item.bucket !== "string" || !BUCKET_PATTERN.test(item.bucket) || item.bucket.includes("..") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.bucket)) issue(entry, "bucket is not a valid GCS bucket name");
    return {
      id: item.id,
      label: item.label.trim(),
      bucket: item.bucket,
      prefix: normalizePrefix(item.prefix ?? "", entry),
      ngauth_base: normalizeNgauthBase(item.ngauth_base, entry)
    };
  });
}

function parseViewerOrigin(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error(`${label} must be an https origin with no path, query, fragment, or userinfo: ${value}`);
  return url.origin;
}

export function parseConfig(env: ConfigEnv): AppConfig {
  const viewerValues = (env.PYTC_GLANCER_VIEWER_ORIGINS ?? "https://neuroglancer-demo.appspot.com").split(",").map((value) => value.trim()).filter(Boolean);
  if (!viewerValues.length) throw new Error("PYTC_GLANCER_VIEWER_ORIGINS must contain at least one origin");
  const viewerOrigins = [...new Set(viewerValues.map((value) => parseViewerOrigin(value, "PYTC_GLANCER_VIEWER_ORIGINS")))];
  const defaultRaw = env.PYTC_GLANCER_DEFAULT_VIEWER_URL ?? "https://neuroglancer-demo.appspot.com";
  let defaultUrl: URL;
  try { defaultUrl = new URL(defaultRaw); } catch { throw new Error("PYTC_GLANCER_DEFAULT_VIEWER_URL is not a valid URL"); }
  if (defaultUrl.protocol !== "https:" || defaultUrl.username || defaultUrl.password || defaultUrl.search || defaultUrl.hash) throw new Error("PYTC_GLANCER_DEFAULT_VIEWER_URL must be https with no query, fragment, or userinfo");
  if (!viewerOrigins.includes(defaultUrl.origin)) throw new Error("PYTC_GLANCER_DEFAULT_VIEWER_URL origin is not in PYTC_GLANCER_VIEWER_ORIGINS");
  return { sources: parseSources(env.PYTC_GLANCER_SOURCES), viewerOrigins, defaultViewerUrl: defaultUrl.toString().replace(/\/$/, ""), publicState: env.PYTC_GLANCER_PUBLIC_STATE !== "false", tldrawLicenseKey: env.PYTC_GLANCER_TLDRAW_LICENSE_KEY?.trim() || null };
}
