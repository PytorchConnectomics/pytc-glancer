/* One queue orders every whole-record write on the page. The gate is mutable
 * as well as observable: a second click in the same render must see it already
 * closed. Failed refreshes keep it closed until both resources reload. */
export type MutationGate = null | "uploading" | "restoring" | "refresh_failed";
export function createWriteQueue(onGate: (gate: MutationGate) => void) {
  let writes: Promise<unknown> = Promise.resolve();
  let gate: MutationGate = null;
  let generation = 0;
  let uploadPending = false;
  const setGate = (next: MutationGate) => { gate = next; onGate(next); };
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = writes.then(task);
    writes = result.catch(() => undefined);
    return result;
  }
  async function refresh(load: () => Promise<void>) {
    generation += 1;
    try { await load(); }
    catch (error) { setGate("refresh_failed"); throw error; }
  }
  return {
    get gate() { return gate; },
    get generation() { return generation; },
    enqueue,
    save(task: () => Promise<unknown>) { return gate ? null : enqueue(task); },
    mutate(kind: "uploading" | "restoring", write: () => Promise<unknown>, load: () => Promise<void>) {
      if (gate && !(uploadPending && gate === "uploading" && kind === "restoring")) return Promise.reject(new Error("Wait — the page is updating."));
      setGate(kind);
      return enqueue(async () => {
        try { await write(); }
        catch (error) { if (gate !== "refresh_failed") setGate(null); throw error; }
        await refresh(load);
        setGate(null);
      });
    },
    upload(write: () => Promise<unknown>, load: () => Promise<void>) {
      if (gate) return Promise.reject(new Error("Wait — the page is updating."));
      uploadPending = true;
      setGate("uploading");
      return enqueue(async () => {
        /* Upload holds the same updating gate through its own refresh. A
         * queued restore owns the gate once reserved, so the earlier upload
         * must not clear it while handing over the queue. */
        try { await write(); await refresh(load); }
        finally {
          uploadPending = false;
          if (gate === "uploading") setGate(null);
        }
      });
    },
    reload(load: () => Promise<void>) {
      return enqueue(async () => { await refresh(load); setGate(null); });
    }
  };
}
