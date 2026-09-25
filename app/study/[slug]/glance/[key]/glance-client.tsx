"use client";

import { FormEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import HistoryPanel from "./history-panel";
import { createWriteQueue, type MutationGate } from "../../../../../lib/write-queue";
import CellPanel from "./cell-panel";
import ProofreadPanel from "./proofread-panel";
import ReportPanel, { type ErrorReport, type Selection } from "./report-panel";
import { mergeEdits } from "../../../../../lib/edits";
import EditStatusLine from "./edit-status";
import { emptyReview, type GlanceReview } from "../../../../../lib/review";
import { readJson as read } from "../../../../../lib/read-response";

interface Glance { id: string; short_key: string; short_name: string | null; title: string | null; url_base: string; state: string; source_path: string | null; position: number; archived_at: number | null; created_at: number; updated_at: number; shareable_link: string; }
interface Study { id: string; title: string; slug: string; description: string | null; archived_at: number | null; glances: Glance[]; }
interface NeuroglancerLayer { type?: string; name?: string; source?: unknown; segments?: string[]; visible?: boolean; }
interface NeuroglancerState { layers?: NeuroglancerLayer[]; selectedLayer?: { visible?: boolean; layer?: string }; [key: string]: unknown; }

function when(value: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }
function glanceName(glance: Glance) {
  if (glance.title) return glance.title;
  if (glance.source_path) return glance.source_path.split("/").filter(Boolean).at(-1) ?? "Untitled glance";
  try { const first = (JSON.parse(glance.state) as NeuroglancerState).layers?.[0]?.name; if (first) return first; } catch { /* use fallback */ }
  return "Untitled glance";
}
function layerDataset(source: unknown) {
  const raw = typeof source === "string" ? source : (source as { url?: string } | null)?.url;
  return typeof raw === "string" ? raw.replace(/\|[^|]*$/, "").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "" : "";
}

/* One icon per panel function, in the rail at the top of the right panel.
 * Drawn inline rather than pulled from an icon package: four glyphs do not
 * justify a dependency, and these inherit the panel's text colour directly. */
const GLYPHS: Record<string, ReactNode> = {
  history: <><path d="M3 11a9 9 0 1 1 2 7" /><path d="M3 4v7h7M12 7v5l3 2" /></>,
  details: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.6" /></>,
  config: <><path d="M4 6h9" /><path d="M17.5 6H20" /><circle cx="15.2" cy="6" r="2.1" /><path d="M4 12h3.3" /><path d="M11.8 12H20" /><circle cx="9.5" cy="12" r="2.1" /><path d="M4 18h9" /><path d="M17.5 18H20" /><circle cx="15.2" cy="18" r="2.1" /></>,
  figures: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><circle cx="8.5" cy="10" r="1.6" /><path d="M4 17l4.8-4.8 4 4 3-2.6L20 17" /></>,
  semantic: <><path d="M12 3a9 9 0 1 0 9 9h-9z" /><path d="M14.4 2.6A9 9 0 0 1 21.4 9.6h-7z" /></>,
  quality: <><circle cx="8.6" cy="9" r="4.2" /><circle cx="8.6" cy="9" r="1.2" /><path d="M12.4 10.9c2.4 1 3.9 2.8 4.6 5.4" /><path d="M21 13.2c-2.6.2-4.6 1.4-6 3.6" /><path d="M6 13.6c-.9 2-1.6 3.7-2 5.1" /></>
};

/* Order is the order of work: see what the volume is made of, read and correct
 * the report's semantic classes, then check each structure's segments for
 * completeness, and the glance's own settings and figures behind them. */
const TABS = [
  { id: "details", label: "Glance details" },
  { id: "semantic", label: "Semantic classes" },
  { id: "quality", label: "Quality control" },
  { id: "history", label: "History" },
  { id: "config", label: "Saved state" },
  { id: "figures", label: "Study figures" }
] as const;
const REPORT_TABS = new Set(["semantic", "figures", "quality"]);
const REVIEW_TABS = new Set(["semantic", "quality"]);
type TabId = (typeof TABS)[number]["id"];

function Icon({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[name]}</svg>;
}

export default function GlanceClient({ slug, shortKey }: { slug: string; shortKey: string }) {
  const [study, setStudy] = useState<Study | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabId>("details");
  const [report, setReport] = useState<ErrorReport | null>(null);
  const [reportError, setReportError] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<GlanceReview | null>(null);
  const [reviewError, setReviewError] = useState("");

  /* Every mutation joins one queue. The synchronous gate stops new verdicts
   * while upload or rollback changes both loaded resources. */
  const [gate, setGate] = useState<MutationGate>(null);
  const writes = useRef<ReturnType<typeof createWriteQueue> | null>(null);
  if (!writes.current) writes.current = createWriteQueue(setGate);
  const queue = writes.current;

  const loadStudy = useCallback(async () => {
    setStudy(await read<Study>(await fetch(`/api/studies/${encodeURIComponent(slug)}?include_archived=1`, { cache: "no-store" })));
  }, [slug]);

  useEffect(() => {
    void loadStudy().catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [loadStudy]);

  const glance = study?.glances.find((entry) => entry.short_key === shortKey) ?? null;
  const baseState = useMemo<NeuroglancerState | null>(() => { try { return glance ? JSON.parse(glance.state) as NeuroglancerState : null; } catch { return null; } }, [glance]);

  /* Edits go to the stored glance, so they change what every link to it opens.
   * Reloading the study afterwards is what refreshes the viewer: baseState is
   * derived from glance.state, and viewerUrl from baseState. */
  async function patchGlance(body: Record<string, unknown>) {
    setSaving(true);
    setError("");
    try {
      await read(await fetch(`/api/glances/${encodeURIComponent(shortKey)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      await loadStudy();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setSaving(false); }
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    await patchGlance({ title: title || null });
  }

  /* Publish the refreshed pair together. A half-refreshed page cannot safely
   * submit another whole review, so either failure keeps the gate closed. */
  async function refreshBoth() {
    const generation = queue.generation;
    const [nextReport, nextReview] = await Promise.all([
      fetch(`/api/glances/${encodeURIComponent(shortKey)}/report?raw=1`, { cache: "no-store" }).then(async (response) => {
        /* No stored or published report is a valid restored state. Other
         * failures must keep the mutation gate closed. */
        if (response.status === 404) return null;
        return read<ErrorReport>(response);
      }),
      fetch(`/api/glances/${encodeURIComponent(shortKey)}/review`, { cache: "no-store" }).then((response) => read<GlanceReview>(response))
    ]);
    if (generation !== queue.generation) return;
    setReport(nextReport); setReview(nextReview); setReportLoading(false);
    setReportError(nextReport ? "" : "No report for this glance.");
    setSelected(null);  setReviewError("");
  }

  async function uploadReport(file: File) {
    if (queue.gate) return;
    setUploading(true); setReportError("");
    try {
      await queue.upload(async () => read(await fetch(`/api/glances/${encodeURIComponent(shortKey)}/report?source=upload`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: await file.text() })), refreshBoth);
    } catch (value) { setReportError(value instanceof Error ? value.message : String(value)); }
    finally { setUploading(false); }
  }

  async function restoreTo(point: number) {
    await queue.mutate("restoring", async () => read(await fetch(`/api/glances/${encodeURIComponent(shortKey)}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ point }) })), refreshBoth);
  }

  async function setLayerLoaded(index: number, load: boolean) {
    if (!baseState) return;
    await patchGlance({ state: { ...baseState, layers: (baseState.layers ?? []).map((layer, position) => position === index ? { ...layer, visible: load } : layer) } });
  }

  // The report and the review are keyed to this glance, so a different one drops both.
  useEffect(() => { setReport(null); setReportError(""); setSelected(null); setReview(null); setReviewError("");  }, [shortKey]);

  useEffect(() => {
    if (queue.gate || !REPORT_TABS.has(tab) || report || reportError || reportLoading || !glance) return;
    const generation = queue.generation;
    setReportLoading(true);
    void fetch(`/api/glances/${encodeURIComponent(shortKey)}/report?raw=1`, { cache: "no-store" })
      .then((response) => read<ErrorReport>(response)).then((next) => { if (generation === queue.generation) setReport(next); })
      .catch((value) => { if (generation === queue.generation) setReportError(value instanceof Error ? value.message : String(value)); })
      .finally(() => { if (generation === queue.generation) setReportLoading(false); });
  }, [tab, report, reportError, reportLoading, glance, shortKey]);

  /* Verdicts are stored per glance, so a reader who closes the tab, or opens
   * the shared link on another machine, resumes where they left off. An
   * unreviewed glance answers the empty record rather than a 404. */
  useEffect(() => {
    if (queue.gate || !REVIEW_TABS.has(tab) || review || !glance) return;
    const generation = queue.generation;
    void fetch(`/api/glances/${encodeURIComponent(shortKey)}/review`, { cache: "no-store" })
      .then((response) => read<GlanceReview>(response)).then((next) => { if (generation === queue.generation) setReview(next); })
      .catch((value) => { if (generation !== queue.generation) return; setReview(emptyReview()); setReviewError(value instanceof Error ? value.message : String(value)); });
  }, [tab, review, glance, shortKey]);

  function saveReview(next: GlanceReview) {
    if (queue.gate || uploading) return;
    setReview(next);
    setReviewError("");
    void queue.save(() => fetch(`/api/glances/${encodeURIComponent(shortKey)}/review`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
      .then((response) => read(response)))?.catch((value) => setReviewError(value instanceof Error ? value.message : String(value)));
  }

  const merged = useMemo(() => report && review ? mergeEdits(report, review.class_review) : null, [report, review]);

  /* A glance can carry two segmentations of the same volume -- one layer per
   * pipeline variant. A report describes exactly one of them, and its segment
   * ids name different objects in the other, so a selection drives the layer
   * the report names and leaves any sibling exactly as stored. */
  const segmentationIndex = useMemo(() => {
    const layers = baseState?.layers ?? [];
    const named = report?.segmentation ? layers.findIndex((layer) => layer.type === "segmentation" && layer.name === report.segmentation) : -1;
    return named >= 0 ? named : layers.findIndex((layer) => layer.type === "segmentation");
  }, [baseState, report?.segmentation]);
  const segmentationName = (baseState?.layers ?? [])[segmentationIndex]?.name ?? null;
  const [reviewClass, setReviewClass] = useState<string | null>(null);

  /* A centroid arrives in microns, but Neuroglancer's `position` counts voxels
   * of the state's own dimensions, which are metres per voxel in z, y, x
   * order -- the same order the catalog reports a centroid in. */
  function positionFor(centroid: [number, number, number] | null | undefined) {
    const dimensions = baseState?.dimensions as Record<string, [number, string]> | undefined;
    if (!centroid || !dimensions) return null;
    const scales = ["z", "y", "x"].map((axis) => dimensions[axis]?.[0]);
    if (scales.some((scale) => typeof scale !== "number" || !scale)) return null;
    return centroid.map((micron, axis) => (micron * 1e-6) / (scales[axis] as number));
  }

  /* Neuroglancer is cross-origin, so the panel cannot drive a live viewer; it
   * navigates the frame to a fresh state instead. The fragment never reaches
   * the viewer's server, so a long segment list costs nothing on the wire. */
  const viewerUrl = useMemo(() => {
    if (!glance || !baseState) return "";
    let state: NeuroglancerState = baseState;
    if (selected?.segments.length) {
      state = { ...baseState, layers: (baseState.layers ?? []).map((layer, index) => index === segmentationIndex ? { ...layer, segments: selected.segments } : layer) };
      if (segmentationName) state.selectedLayer = { visible: true, layer: segmentationName };
      const position = positionFor(selected.centroid_um);
      if (position) state.position = position;
    }
    return `${glance.url_base}#!${encodeURIComponent(JSON.stringify(state))}`;
  }, [glance, baseState, selected, segmentationIndex, segmentationName]);

  async function copy(link: string, event: MouseEvent) { event.preventDefault(); try { await navigator.clipboard.writeText(link); } catch { setError("The browser refused clipboard access."); } }

  const heading = glance ? glanceName(glance) : "Glance";

  return <main className="viewer-shell">
    <header className="topbar viewer-topbar">
      <a className="brand-lockup" href="/"><span className="brand-mark" role="img" aria-label="PyTorch Connectomics" /><span><span className="brand-name">pytc_glancer</span><span className="brand-context">PyTorch Connectomics</span></span></a>
      <span className="viewer-title">{heading}</span>
      <a className="back-link" href={`/study/${encodeURIComponent(slug)}`}>← {study?.title ?? "Study"}</a>
    </header>

    {error && <p className="inline-error" role="alert">{error}</p>}

    <div className="viewer-body">
      <section className="viewer-frame" aria-label="Neuroglancer viewer">
        {viewerUrl
          ? <iframe key={selected ? `${selected.id}:${selected.segments.length}` : "all"} src={viewerUrl} title={`Neuroglancer view of ${heading}`} allow="fullscreen" referrerPolicy="no-referrer" />
          : <div className="empty-panel"><p>{error ? "Glance unavailable" : glance && !baseState ? "This glance's stored state is not readable." : "Loading viewer…"}</p></div>}
      </section>

      <aside className="side-panel" aria-label="Glance tools">
        <nav className="icon-rail" aria-label="Panel sections">
          {TABS.map((entry) => <button key={entry.id} type="button" className={`rail-button ${tab === entry.id ? "active" : ""}`}
            aria-pressed={tab === entry.id} title={entry.label}
            onClick={() => { if (REVIEW_TABS.has(tab) && tab !== entry.id) setSelected(null); setTab(entry.id); }}>
            <Icon name={entry.id} /><span className="sr-only">{entry.label}</span>
          </button>)}
        </nav>

        <div className="panel-body">
          <h2 className="panel-heading">{TABS.find((entry) => entry.id === tab)?.label}</h2>

          {gate && <p className="panel-note" role="status">{gate === "refresh_failed" ? "Reload needed" : "Wait — the page is updating"}
            {gate === "refresh_failed" && <button className="secondary" type="button" onClick={() => void queue.reload(refreshBoth).catch((value) => setReviewError(String(value)))}>Reload</button>}
          </p>}
          {tab === "history" && <HistoryPanel shortKey={shortKey} archived={!!study?.archived_at} gate={gate} onRestore={restoreTo} />}
          {tab === "details" && (glance ? <div className="detail-stack">
            <dl className="detail-list">
              <div><dt>Position</dt><dd>{glance.position}{glance.archived_at ? " · archived" : ""}</dd></div>
              <div><dt>Created</dt><dd>{when(glance.created_at)}</dd></div>
              <div><dt>Updated</dt><dd>{when(glance.updated_at)}</dd></div>
            </dl>
            <h3 className="panel-subheading">Layers</h3>
            <ul className="layer-list">{(baseState?.layers ?? []).map((layer, index) => <li key={`${layer.name}-${index}`}>
              <span className="layer-kind">{layer.type ?? "layer"}</span>
              <span className="layer-name">{layer.name ?? layerDataset(layer.source)}</span>
            </li>)}</ul>
            <div className="panel-actions">
              <a className="secondary" href={glance.shareable_link} target="_blank" rel="noreferrer">Open in Neuroglancer</a>
              <button className="secondary" type="button" onClick={(event) => void copy(glance.shareable_link, event)}>Copy link</button>
            </div>
          </div> : <p className="panel-note">Loading glance…</p>)}

          {tab === "config" && (glance && baseState ? <div className="config-stack">
            <form className="form-stack" onSubmit={(event) => void saveName(event)}>
              <label>Name
                {/* Uncontrolled and re-seeded per glance, matching the study rename form. */}
                <input key={glance.id} name="title" maxLength={200} defaultValue={glance.title ?? ""}
                  disabled={saving || !!glance.archived_at} placeholder={glanceName(glance)} />
              </label>
              <button className="primary" type="submit" disabled={saving || !!glance.archived_at}>
                {saving ? "Saving…" : "Save name"}
              </button>
            </form>

            <h3 className="panel-subheading">What to load</h3>
            {(baseState.layers ?? []).length ? <ul className="layer-toggle-list">
              {(baseState.layers ?? []).map((layer, index) => <li key={`${layer.name}-${index}`}>
                <label className="switch">
                  <input type="checkbox" checked={layer.visible !== false} disabled={saving || !!glance.archived_at}
                    onChange={(event) => void setLayerLoaded(index, event.target.checked)} />
                  <span className="layer-toggle-text">
                    <span className="layer-name">{layer.name ?? layerDataset(layer.source)}</span>
                    <span className="layer-kind">{layer.type ?? "layer"}</span>
                  </span>
                </label>
              </li>)}
            </ul> : <p className="panel-note">This glance has no layers.</p>}

            <p className="panel-note">
              {glance.archived_at
                ? "This glance is archived. Unarchive it from the study page to make changes."
                : "Saved to the glance, so every link to it opens with these settings."}
            </p>
          </div> : <p className="panel-note">Loading glance…</p>)}

          {tab === "quality" && (reportLoading ? <p className="panel-note">Loading the error report…</p>
            : review ? <CellPanel readOnly={!!gate || uploading || !!study?.archived_at} report={merged?.report ?? report} merged={merged} source={report} review={review} onReviewChange={saveReview} onSelect={setSelected} saveError={reviewError} />
            : <p className="panel-note">Loading the review…</p>)}

          {tab === "figures" && (reportLoading ? <p className="panel-note">Loading published figures…</p>
            : reportError ? <p className="panel-note">{reportError}</p>
            : report?.figures.length ? <div className="figure-stack">{report.figures.map((figure) => <figure key={figure.index}>
                <img src={`/api/glances/${encodeURIComponent(shortKey)}/report/figures/${figure.index}`} alt={figure.caption ?? figure.label} loading="lazy" />
                <figcaption>{figure.label}{figure.caption ? ` — ${figure.caption}` : ""}</figcaption>
              </figure>)}</div>
            : <p className="panel-note">The published report for this dataset lists no figures.</p>)}

          {tab === "semantic" && <>
            {reportLoading ? <p className="panel-note">Loading the error report…</p>
              : reportError ? <p className="panel-note">{reportError}</p>
              : report ? <>
                {/* The pie picks the class the stepper below walks, so reading the
                  * report and editing its overlay are one pass. */}
                <ReportPanel report={merged?.report ?? report} selected={reviewClass} onSelect={setSelected} onPickClass={setReviewClass} />
                <h3 className="panel-subheading">Proofread</h3>
                {review && merged && <EditStatusLine merged={merged} review={review} onChange={saveReview} readOnly={!!gate || uploading || !!study?.archived_at} />}
                {review ? <ProofreadPanel readOnly={!!gate || uploading || !!study?.archived_at} report={report} classId={reviewClass} onClassChange={setReviewClass} onSelect={setSelected}
                  review={review} onReviewChange={saveReview} merged={merged ?? undefined} saveError={reviewError} />
                  : <p className="panel-note">Loading the review…</p>}
              </>
              : <p className="panel-note">No error report for this glance yet.</p>}
            {!reportLoading && <div className="report-upload">
              <label className="secondary upload-button">
                {uploading ? "Uploading…" : report ? "Replace report" : "Upload report"}
                <input type="file" accept="application/json,.json" disabled={uploading || !!gate || !!study?.archived_at}
                  onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadReport(file); }} />
              </label>
              <span className="panel-note">Generate with <code>scripts/make_error_report.py</code>.</span>
            </div>}
          </>}
        </div>
      </aside>
    </div>
  </main>;
}
