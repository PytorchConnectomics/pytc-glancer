import assert from "node:assert/strict";
import test from "node:test";
import { createWriteQueue, type MutationGate } from "../lib/write-queue";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a mutation waits for a pending review PUT and immediately refuses another edit", async () => {
  const queue = createWriteQueue(() => {}), put = deferred(), post = deferred(), events: string[] = [];
  const save = queue.save(async () => { events.push("PUT"); await put.promise; });
  await tick();
  const correction = queue.mutate("uploading", async () => { events.push("POST correct"); await post.promise; }, async () => { events.push("GET both"); });
  assert.equal(queue.gate, "uploading");
  assert.equal(queue.save(async () => { events.push("forbidden"); }), null);
  assert.deepEqual(events, ["PUT"]);
  put.resolve(); await save; await tick();
  assert.deepEqual(events, ["PUT", "POST correct"]);
  post.resolve(); await correction;
  assert.deepEqual(events, ["PUT", "POST correct", "GET both"]);
  assert.equal(queue.gate, null);
});

test("restore waits for an upload and its refetch without losing its gate", async () => {
  const queue = createWriteQueue(() => {}), upload = deferred(), refresh = deferred(), events: string[] = [];
  const uploading = queue.upload(async () => { events.push("upload"); await upload.promise; }, async () => { events.push("upload refresh"); await refresh.promise; });
  await tick();
  const restoring = queue.mutate("restoring", async () => { events.push("restore"); }, async () => { events.push("restore refresh"); });
  upload.resolve(); await tick();
  assert.deepEqual(events, ["upload", "upload refresh"]);
  assert.equal(queue.gate, "restoring");
  refresh.resolve(); await uploading; await restoring;
  assert.deepEqual(events, ["upload", "upload refresh", "restore", "restore refresh"]);
  assert.equal(queue.gate, null);
});

test("a GET started before restore cannot replace the refreshed state", async () => {
  const queue = createWriteQueue(() => {}), stale = deferred<string>();
  let report = "old";
  const generation = queue.generation;
  const get = stale.promise.then((value) => { if (generation === queue.generation) report = value; });
  await queue.mutate("restoring", async () => {}, async () => { report = "restored"; });
  stale.resolve("stale"); await get;
  assert.equal(report, "restored");
});

test("refresh failure keeps edits refused until both Reload fetches succeed", async () => {
  const gates: MutationGate[] = [], queue = createWriteQueue((gate) => gates.push(gate));
  await assert.rejects(queue.mutate("restoring", async () => {}, async () => { throw new Error("review fetch failed"); }));
  assert.equal(queue.gate, "refresh_failed");
  assert.equal(queue.save(async () => assert.fail("must not edit stale state")), null);
  const report = deferred(), review = deferred();
  const reload = queue.reload(async () => { await Promise.all([report.promise, review.promise]); });
  report.resolve(); await tick();
  assert.equal(queue.gate, "refresh_failed");
  review.resolve(); await reload;
  assert.equal(queue.gate, null);
  assert.deepEqual(gates, ["restoring", "refresh_failed", null]);
});

test("failed POST releases the gate and does not refresh", async () => {
  const queue = createWriteQueue(() => {});
  await assert.rejects(queue.mutate("uploading", async () => { throw new Error("invalid"); }, async () => assert.fail("must not refresh")));
  assert.equal(queue.gate, null);
  await queue.save(async () => {});
});

test("upload holds the mutation gate through refresh and refuses review edits", async () => {
  const queue = createWriteQueue(() => {}), write = deferred(), load = deferred();
  const upload = queue.upload(() => write.promise, () => load.promise);
  assert.equal(queue.save(async () => assert.fail("must not edit while uploading")), null);
  write.resolve(); await tick();
  assert.equal(queue.gate, "uploading");
  load.resolve(); await upload;
  assert.equal(queue.gate, null);
});
