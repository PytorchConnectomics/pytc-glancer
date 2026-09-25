import assert from "node:assert/strict";
import test from "node:test";
import { readJson } from "../lib/read-response";

// A constructed Response carries no url, so name the call the helper reports on.
function answer(body: string, init?: ResponseInit) {
  return Object.defineProperty(new Response(body, init), "url", { value: "https://mind.example/api/glances/key/report" });
}

test("a JSON body reads through unchanged", async () => {
  const body = await readJson<{ dataset: string }>(answer(JSON.stringify({ dataset: "sample" })));
  assert.equal(body.dataset, "sample");
});

test("an API failure surfaces its own detail", async () => {
  await assert.rejects(
    readJson(answer(JSON.stringify({ error: "report_unavailable", detail: "No report uploaded for this glance." }), { status: 404 })),
    /No report uploaded for this glance\./
  );
});

/* The reported bug: a tunnel or edge in front of the Worker answers with its
 * own HTML page, and the panel showed the parser's complaint about '<' rather
 * than the status that explains it. */
test("an HTML page is named, with the status, instead of a parser error", async () => {
  await assert.rejects(
    readJson(answer("<!DOCTYPE html><html><body>Bad gateway</body></html>", { status: 502, statusText: "Bad Gateway" })),
    (error: Error) => {
      assert.match(error.message, /\/api\/glances\/key\/report/);
      assert.match(error.message, /HTTP 502 Bad Gateway/);
      assert.match(error.message, /an HTML page, not JSON\./);
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    }
  );
});

test("a plain-text failure is quoted, so the origin's own message survives", async () => {
  await assert.rejects(
    readJson(answer("URIError: URI malformed", { status: 500 })),
    /"URIError: URI malformed", not JSON\./
  );
});

test("a failure without a detail still names its status", async () => {
  await assert.rejects(readJson(answer(JSON.stringify({ ok: false }), { status: 503 })), /failed \(HTTP 503\)/);
});

test("an empty body is reported as one rather than as a parse failure", async () => {
  await assert.rejects(readJson(answer("", { status: 200 })), /with an empty body\./);
});
