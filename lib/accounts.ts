/* Accounts: who a session belongs to, and which studies it may see.
 *
 * pytc_glancer is shared by groups that must not read each other's work, so a
 * study belongs to exactly one account and every study-scoped query carries
 * the account of the request. Sign-in is still a password rather than an
 * identity provider: the unit is the group, not the person, which is what the
 * deployment can enforce today. `deploy/README.md` records the case for moving
 * to real identities once uploads need attribution. */

export interface Account {
  id: string;
  label: string;
  password: string;
}

/** The account a request acts as. Carries no secret, so it can travel into the
 *  API layer and be logged without leaking a password. */
export interface Actor {
  id: string;
  label: string;
}

/* The account that owns everything created before accounts existed: the
 * pre-account studies are this account's, and the 0003 migration backfills them to
 * this id. A single-password deployment and an open local server both keep
 * reading that same workspace. */
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_ACCOUNT_LABEL = "PyTorch Connectomics";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function issue(entry: string, detail: string): never {
  throw new Error(`Invalid PYTC_GLANCER_ACCOUNTS entry ${entry}: ${detail}`);
}

export function parseAccounts(raw: string | undefined): Account[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid PYTC_GLANCER_ACCOUNTS JSON"); }
  if (!Array.isArray(parsed)) throw new Error("Invalid PYTC_GLANCER_ACCOUNTS: expected an array");
  const seen = new Set<string>();
  return parsed.map((candidate, index) => {
    const entry = `[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) issue(entry, "expected an object");
    const item = candidate as Record<string, unknown>;
    const allowed = new Set(["id", "label", "password"]);
    const unknown = Object.keys(item).find((key) => !allowed.has(key));
    if (unknown) issue(entry, `unknown field ${unknown}`);
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) issue(entry, "id must match ^[a-z0-9][a-z0-9_-]{0,62}$");
    if (seen.has(item.id)) issue(entry, `duplicate id ${item.id}`);
    seen.add(item.id);
    if (item.label !== undefined && (typeof item.label !== "string" || !item.label.trim())) issue(entry, "label must be non-empty");
    if (typeof item.password !== "string" || !item.password) issue(entry, "password must be a non-empty string");
    return { id: item.id, label: (item.label as string | undefined)?.trim() || item.id, password: item.password };
  });
}

interface AccountEnv {
  PYTC_GLANCER_ACCOUNTS?: string;
  PYTC_GLANCER_PASSWORD?: string;
}

/** The configured accounts, or the single legacy account when only
 *  `PYTC_GLANCER_PASSWORD` is set. Empty means an open server: no gate, and
 *  every request acts as the default account. */
export function accountsFromEnv(env: AccountEnv): Account[] {
  const configured = parseAccounts(env.PYTC_GLANCER_ACCOUNTS);
  if (configured.length) return configured;
  if (env.PYTC_GLANCER_PASSWORD) return [{ id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL, password: env.PYTC_GLANCER_PASSWORD }];
  return [];
}

export function actorOf(account: Account): Actor { return { id: account.id, label: account.label }; }

export const DEFAULT_ACTOR: Actor = { id: DEFAULT_ACCOUNT_ID, label: DEFAULT_ACCOUNT_LABEL };

export function constantTimeEquals(supplied: string, expected: string) {
  const left = new TextEncoder().encode(supplied);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/* The account id rides in the cookie beside the digest, because the gate has
 * to know which account's secret to verify against before it can trust
 * anything. The id is not the credential: a forged id simply fails the digest
 * comparison for the account it names. */
export async function sessionToken(account: Account) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pytc_glancer:${account.id}:${account.password}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sessionValue(account: Account) { return `${account.id}.${await sessionToken(account)}`; }

/** The account a cookie proves, or null. Changing an account's password
 *  invalidates its existing sessions and no one else's. */
export async function accountFromSession(cookie: string, accounts: Account[]) {
  const separator = cookie.indexOf(".");
  if (separator === -1) return null;
  const id = cookie.slice(0, separator);
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) return null;
  return constantTimeEquals(cookie.slice(separator + 1), await sessionToken(account)) ? account : null;
}

/** The account a sign-in submission proves, or null.
 *
 * An unknown account still pays for a comparison, so a wrong name and a wrong
 * password cost the same and the form cannot be used to enumerate accounts.
 * With exactly one account configured the name may be omitted, which keeps a
 * single-password deployment's login unchanged. */
export async function authenticate(accounts: Account[], submittedId: string, password: string) {
  const id = submittedId.trim().toLowerCase();
  const named = id ? accounts.find((candidate) => candidate.id === id) : accounts.length === 1 ? accounts[0] : undefined;
  const target = named ?? accounts[0];
  const matched = target ? constantTimeEquals(password, target.password) : constantTimeEquals(password, "");
  return named && matched ? named : null;
}
