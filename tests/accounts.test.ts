import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACCOUNT_ID, accountFromSession, accountsFromEnv, authenticate, parseAccounts, sessionValue } from "../lib/accounts";

const ACCOUNTS = [
  { id: "default", label: "PyTorch Connectomics", password: "first-secret" },
  { id: "labb", label: "Lab B", password: "second-secret" }
];

test("account configuration validates every field", () => {
  assert.deepEqual(parseAccounts(undefined), []);
  assert.throws(() => parseAccounts("{}"), /expected an array/);
  assert.throws(() => parseAccounts('[{"id":"Default","password":"x"}]'), /entry \[0\].*id/);
  assert.throws(() => parseAccounts('[{"id":"default"}]'), /entry \[0\].*password/);
  assert.throws(() => parseAccounts('[{"id":"default","password":"x","role":"admin"}]'), /entry \[0\].*unknown field role/);
  assert.throws(() => parseAccounts(JSON.stringify([ACCOUNTS[0], ACCOUNTS[0]])), /entry \[1\].*duplicate/);
  // A label is optional and falls back to the id.
  assert.deepEqual(parseAccounts('[{"id":"labb","password":"second-secret"}]'), [{ id: "labb", label: "labb", password: "second-secret" }]);
});

test("a lone PYTC_GLANCER_PASSWORD stays the default account, and no password leaves the server open", () => {
  assert.deepEqual(accountsFromEnv({}), []);
  const legacy = accountsFromEnv({ PYTC_GLANCER_PASSWORD: "secret" });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].id, DEFAULT_ACCOUNT_ID);
  // Configured accounts win over the single-password form.
  assert.deepEqual(accountsFromEnv({ PYTC_GLANCER_ACCOUNTS: JSON.stringify(ACCOUNTS), PYTC_GLANCER_PASSWORD: "secret" }).map((account) => account.id), ["default", "labb"]);
});

test("a password opens its own account and no other", async () => {
  assert.equal((await authenticate(ACCOUNTS, "default", "first-secret"))?.id, "default");
  assert.equal((await authenticate(ACCOUNTS, "labb", "second-secret"))?.id, "labb");
  // The other account's password is not a way in.
  assert.equal(await authenticate(ACCOUNTS, "default", "second-secret"), null);
  assert.equal(await authenticate(ACCOUNTS, "absent", "first-secret"), null);
  assert.equal(await authenticate(ACCOUNTS, "", "first-secret"), null);
  // With one account the name may be omitted, as it was before accounts.
  assert.equal((await authenticate([ACCOUNTS[0]], "", "first-secret"))?.id, "default");
});

test("a session cookie proves one account, and stops proving it when the password changes", async () => {
  const cookie = await sessionValue(ACCOUNTS[1]);
  assert.equal((await accountFromSession(cookie, ACCOUNTS))?.id, "labb");
  // Relabelling the cookie does not hand over another account's workspace: the
  // digest is over the account's own id and password.
  const forged = `default.${cookie.split(".")[1]}`;
  assert.equal(await accountFromSession(forged, ACCOUNTS), null);
  assert.equal(await accountFromSession(cookie, [{ ...ACCOUNTS[1], password: "rotated" }]), null);
  assert.equal(await accountFromSession("", ACCOUNTS), null);
  assert.equal(await accountFromSession("labb.nonsense", ACCOUNTS), null);
});
