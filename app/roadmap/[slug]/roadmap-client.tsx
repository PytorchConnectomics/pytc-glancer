"use client";

import { type ComponentType, useEffect, useState } from "react";
import AccountBadge from "../../account-badge";
import type { CanvasProps, SyncState } from "./roadmap-canvas";

const STATE_LABEL: Record<SyncState, string> = {
  loading: "Opening…",
  saved: "All changes saved",
  saving: "Saving…",
  offline: "Not saved: server unreachable, retrying",
  readonly: "Archived: read only",
  plan: "Read-only plan",
};

/* The page around one roadmap: a slim header and the canvas below it.
 *
 * tldraw is a browser-only library of some megabytes, so it is imported after
 * mount rather than at the top of this file: the server render never loads it,
 * and neither does any other page of the app. */
export default function RoadmapClient({ slug }: { slug: string }) {
  const [Canvas, setCanvas] = useState<ComponentType<CanvasProps> | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<SyncState>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void import("./roadmap-canvas")
      .then((module) => { if (live) setCanvas(() => module.default); })
      .catch((value) => { if (live) setError(`The canvas could not be loaded: ${value instanceof Error ? value.message : String(value)}`); });
    return () => { live = false; };
  }, []);

  useEffect(() => { if (title) document.title = `${title} — roadmap`; }, [title]);

  return <main className="roadmap-page">
    <header className="topbar roadmap-bar">
      <a className="brand-lockup" href="/#roadmaps" title="All roadmaps">
        <span className="brand-mark" role="img" aria-label="PyTorch Connectomics" />
        <span><span className="brand-name">{title || "Roadmap"}</span><span className="brand-context">Roadmaps · pytc_glancer</span></span>
      </a>
      <span className={`top-note roadmap-state roadmap-state-${state}`} role="status">{STATE_LABEL[state]}</span>
      <AccountBadge />
    </header>
    {error && <p className="inline-error roadmap-error" role="alert">{error}</p>}
    <div className="roadmap-canvas">
      {Canvas && <Canvas slug={slug} onTitle={setTitle} onState={setState} onError={setError} />}
    </div>
  </main>;
}
