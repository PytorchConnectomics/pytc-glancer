import assert from "node:assert/strict";
import test from "node:test";
import { mintAccessToken, parseServiceAccount } from "../lib/gcs";

function pem(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

test("service-account JWT is RS256-signed and exchanged without google-auth-library", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateKey = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const account = parseServiceAccount(JSON.stringify({ client_email: "metadata-test@example.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token" }));
  assert.ok(account);
  const token = await mintAccessToken(account, async (input, init) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(body.get("assertion")?.split(".").length, 3);
    return new Response(JSON.stringify({ access_token: "fixture-access-token", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(token, "fixture-access-token");
});
