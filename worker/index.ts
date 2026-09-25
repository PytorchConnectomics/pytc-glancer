/** Cloudflare Worker entry point for pytc_glancer. */
import handler from "vinext/server/app-router-entry";
import { handleApi } from "../lib/api";
import { parseConfig } from "../lib/config";
import { syncSources } from "../lib/sources";
import { failure, json } from "../lib/http";
import { parseServiceAccount } from "../lib/gcs";
import { DEFAULT_ACTOR, accountFromSession, accountsFromEnv, actorOf, authenticate, sessionValue, type Account } from "../lib/accounts";
import { env as workerEnv } from "cloudflare:workers";

interface Env extends Cloudflare.Env {}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const SESSION_COOKIE = "pytc_glancer_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const LOGIN_PATH = "/__login";
const LOGOUT_PATH = "/__logout";
const startupConfig = parseConfig(workerEnv);
/* Accounts are read once, like the rest of the configuration: adding one is an
 * operator action followed by a restart, not something a request can change. */
const startupAccounts = accountsFromEnv(workerEnv);
if (startupConfig.sources.length && !parseServiceAccount(workerEnv.GCS_SA_KEY)) {
  console.warn("pytc_glancer: GCS_SA_KEY is missing or unparseable; OME-Zarr path creation is unavailable, but URL import remains enabled.");
}

function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] as string);
}

function safeNext(value: string | null) { return value && value.startsWith("/") && !value.startsWith("//") ? value : "/"; }

function cookieHeader(url: URL, value: string, maxAge: number) {
  const secure = url.hostname === "127.0.0.1" || url.hostname === "localhost" ? "" : " Secure;";
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly;${secure} SameSite=Lax`;
}

function loginPage(next: string, accounts: Account[], error?: string, suppliedAccount = "") {
  // With one account configured the name has nowhere to vary, so the form stays
  // the single password field it was. With several, the name is asked for
  // rather than offered as a list: an unauthenticated visitor learns nothing
  // about which groups have a workspace here.
  const accountField = accounts.length === 1 ? "" : `
    <label for="account">Account</label>
    <input id="account" name="account" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${escapeHtml(suppliedAccount)}" autofocus required>`;
  // The logo is inlined as a data URI rather than fetched from /favicon.svg: this
  // page is served to unauthenticated visitors, and the gate would answer 401 to
  // the image request.
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>pytc_glancer</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7f5;
    color: #17201d; font-family: ui-sans-serif, system-ui, Arial, Helvetica, sans-serif; }
  main { width: min(22rem, calc(100vw - 2.5rem)); background: #fff; border: 1px solid #e2e6e3;
    border-radius: 14px; padding: 1.75rem; box-shadow: 0 1px 2px rgba(24,32,29,.05), 0 2px 8px rgba(24,32,29,.03); }
  .brain { width: 2.25rem; height: 2.25rem; background: url("data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTIyIDE5LjI3MjdDMjIgMjAuNzc5IDIwLjc3OSAyMiAxOS4yNzI3IDIySDE0LjcyNzNDMTMuMjIxIDIyIDEyIDIwLjc3OSAxMiAxOS4yNzI3VjEySDE5LjI3MjdDMjAuNzc5IDEyIDIyIDEzLjIyMSAyMiAxNC43MjczVjE5LjI3MjdaIiBmaWxsPSIjNjhDNEZGIi8+CjxwYXRoIGQ9Ik0yMCAyQzIxLjEwNDYgMiAyMiAyLjg5NTQzIDIyIDRWN0MyMiA4LjEwNDU3IDIxLjEwNDYgOSAyMCA5SDE3QzE1Ljg5NTQgOSAxNSA4LjEwNDU3IDE1IDdWNEMxNSAyLjg5NTQzIDE1Ljg5NTQgMiAxNyAySDIwWiIgZmlsbD0iIzBDNzlEOCIvPgo8cGF0aCBkPSJNNyAxNUM4LjEwNDU3IDE1IDkgMTUuODk1NCA5IDE3VjIwQzkgMjEuMTA0NiA4LjEwNDU3IDIyIDcgMjJINEMyLjg5NTQzIDIyIDIgMjEuMTA0NiAyIDIwVjE3QzIgMTUuODk1NCAyLjg5NTQzIDE1IDQgMTVIN1oiIGZpbGw9IiMwQzc5RDgiLz4KPHBhdGggZD0iTTEyIDEySDQuNzI3MjdDMy4yMjEwNCAxMiAyIDEwLjc3OSAyIDkuMjcyNzNWNC43MjcyN0MyIDMuMjIxMDQgMy4yMjEwNCAyIDQuNzI3MjcgMkg5LjI3MjczQzEwLjc3OSAyIDEyIDMuMjIxMDQgMTIgNC43MjcyN1YxMloiIGZpbGw9IiMyRTlFRkYiLz4KPC9zdmc+Cg==") center / contain no-repeat; }
  h1 { font-size: 1.05rem; margin: .85rem 0 .3rem; }
  .org { color: #6f7874; font-size: .72rem; font-weight: 650; letter-spacing: .015em; margin: 0 0 .5rem; }
  p { margin: 0; color: #6f7874; font-size: .85rem; line-height: 1.45; }
  form { margin-top: 1.35rem; display: grid; gap: .6rem; }
  label { font-size: .78rem; color: #6f7874; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; font-size: .95rem; color: #17201d;
    background: #fff; border: 1px solid #d3d9d5; border-radius: 8px; }
  input:focus-visible { outline: 2px solid #2f67c7; outline-offset: 1px; border-color: #2f67c7; }
  button { padding: .6rem .7rem; font-size: .9rem; font-weight: 600; color: #fff; background: #17201d;
    border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { background: #29332f; }
  .error { margin-top: .9rem; padding: .55rem .7rem; border-radius: 8px; font-size: .82rem;
    color: #8a2b20; background: #fdeeeb; border: 1px solid #f6d6d0; }
</style>
</head>
<body>
<main>
  <div class="brain" role="img" aria-label="PyTorch Connectomics"></div>
  <h1>pytc_glancer</h1>
  <p class="org">PyTorch Connectomics</p>
  <p>${accounts.length === 1 ? "This workspace is private. Enter the shared password to continue." : "Each account has its own studies. Sign in to open yours."}</p>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="${LOGIN_PATH}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">${accountField}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"${accounts.length === 1 ? " autofocus" : ""} required>
    <button type="submit">Open workspace</button>
  </form>
</main>
</body>
</html>`, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Either the account this request acts as, or the response that asks for one. */
async function gate(request: Request, url: URL, accounts: Account[]): Promise<{ account: Account } | { challenge: Response }> {
  if (url.pathname === LOGOUT_PATH) {
    return { challenge: new Response(null, { status: 303, headers: { Location: LOGIN_PATH, "Cache-Control": "no-store", "Set-Cookie": cookieHeader(url, "", 0) } }) };
  }
  if (url.pathname === LOGIN_PATH) {
    if (request.method !== "POST") return { challenge: loginPage(safeNext(url.searchParams.get("next")), accounts) };
    const form = await request.formData();
    const next = safeNext(String(form.get("next") ?? "/"));
    const suppliedAccount = String(form.get("account") ?? "");
    const account = await authenticate(accounts, suppliedAccount, String(form.get("password") ?? ""));
    // One message for a wrong name and for a wrong password: the form answers
    // whether these two together open a workspace, and nothing else.
    if (!account) return { challenge: loginPage(next, accounts, accounts.length === 1 ? "That password is not right." : "That account and password do not match.", suppliedAccount) };
    return { challenge: new Response(null, { status: 303, headers: { Location: next, "Cache-Control": "no-store", "Set-Cookie": cookieHeader(url, await sessionValue(account), SESSION_MAX_AGE) } }) };
  }
  const account = await accountFromSession(readCookie(request, SESSION_COOKIE), accounts);
  if (account) return { account };
  if (request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html")) return { challenge: loginPage(`${url.pathname}${url.search}`, accounts) };
  return { challenge: new Response(JSON.stringify({ error: "unauthorized", detail: "Sign in to this account to continue." }), { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) };
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const config = startupConfig;
    const publicState = config.publicState && url.pathname.startsWith("/ng/");
    /* An open server (no account configured) still acts as an account, so a
     * local checkout reads the same studies the deployment does rather than an
     * unowned set that would become invisible the day a password is set. */
    let actor = DEFAULT_ACTOR;
    if (startupAccounts.length && !publicState) {
      const result = await gate(request, url, startupAccounts);
      if ("challenge" in result) return result.challenge;
      actor = actorOf(result.account);
    }
    if (url.pathname.startsWith("/api/")) {
      // Inside the try with the dispatch: the panels read every /api/ answer as
      // JSON, and a throw here would otherwise leave the runtime to answer with
      // an error page of its own.
      try {
        await syncSources(env.DB, config, env.PYTC_GLANCER_SOURCES ?? "");
        return await handleApi(request, env.DB, config, actor, env.GCS_SA_KEY);
      } catch (error) {
        console.error("pytc_glancer: unhandled API error", error);
        return failure("internal_error", error instanceof Error ? error.message : String(error), 500);
      }
    }
    if (url.pathname.startsWith("/ng/")) {
      const match = /^\/ng\/([a-z2-7]{32})(?:\/[a-z0-9-]+)?$/.exec(url.pathname);
      if (!match || (request.method !== "GET" && request.method !== "OPTIONS")) return failure("not_found", "No such glance.", 404);
      const origin = request.headers.get("Origin");
      const cors = new Headers({ "Cache-Control": "no-store", "Vary": "Origin" });
      if (origin && config.viewerOrigins.includes(origin)) cors.set("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") { cors.set("Access-Control-Allow-Methods", "GET, OPTIONS"); return new Response(null, { status: 204, headers: cors }); }
      const row = await env.DB.prepare("SELECT state FROM glances WHERE short_key=?").bind(match[1]).first<{ state: string }>();
      if (!row) return failure("not_found", "No such glance.", 404);
      return json(JSON.parse(row.state), 200, cors);
    }
    return handler.fetch(request, env, ctx);
  }
};

export default worker;
