"use client";

import { useEffect, useState } from "react";
import type { HistoryEntry, HistoryPage, ReportSummary, ReviewSummary, UnreadableSummary } from "../../../../../lib/history";
import type { MutationGate } from "../../../../../lib/write-queue";
import { readJson } from "../../../../../lib/read-response";

const when = (time: number) => new Date(time).toLocaleString();
const labels: Record<string, string> = { baseline: "Starting point", ingest: "Report ingested from GCS", upload: "Report uploaded", correct: "Report corrected", review: "Proofreading" };
function reportText(report: ReportSummary | UnreadableSummary | null) {
  if (report && "unreadable" in report) return "Unreadable report";
  return report ? report.classes.map((entry) => `${entry.id.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())} ${entry.labels?.toLocaleString() ?? "?"}`).join(" · ") : "No report";
}
function reviewText(review: ReviewSummary | UnreadableSummary) { return "unreadable" in review ? "Unreadable review" : `${review.class_verdicts} verdicts · ${review.qc_calls} QC calls · ${review.hand_ids} ids by hand`; }

/* Each point carries its authoritative state, even when the report it refers
 * to is on an older page. Confirmation therefore never guesses from neighbours. */
export default function HistoryPanel({ shortKey, archived, gate, onRestore }: {
  shortKey: string; archived: boolean; gate: MutationGate; onRestore: (point: number) => Promise<void>;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [picked, setPicked] = useState<HistoryEntry | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function load(older?: number) {
    setLoading(true); setError("");
    try {
      const page = await readJson<HistoryPage>(await fetch(`/api/glances/${encodeURIComponent(shortKey)}/versions${older ? `?before=${older}` : ""}`, { cache: "no-store" }));
      setEntries((previous) => older ? [...previous, ...page.entries] : page.entries);
      setBefore(page.next_before);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  }
  useEffect(() => { setPicked(null); void load(); }, [shortKey, gate]);
  async function restore() {
    if (!picked || picked.current || archived || gate) return;
    setError("");
    try { await onRestore(picked.point); setPicked(null); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }
  return <div className="history-panel">
    <p className="panel-note">Proofreading by the same account within ten minutes keeps only its last state, unless another operation or an empty review comes between.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <ol className="history-list">{entries.map((entry) => <li key={entry.point}>
      <button type="button" className={`history-entry ${picked?.point === entry.point ? "active" : ""}`} onClick={() => setPicked(entry)} aria-pressed={picked?.point === entry.point}>
        <strong>{entry.source === "restore" ? `Rolled back to ${when(entry.restored_from_at!)}` : labels[entry.source] ?? entry.source}{entry.current ? " · Current" : ""}</strong>
        <span>{when(entry.started_at)}{entry.source === "review" && entry.ended_at !== entry.started_at ? `–${when(entry.ended_at)}` : ""}</span>
        <span>{entry.author}</span><span>{reportText(entry.state.report)}</span><span>{reviewText(entry.state.review)}</span>
      </button>
    </li>)}</ol>
    {!entries.length && !loading && !error && <p className="panel-note">No history yet.</p>}
    {before !== null && <button className="secondary" type="button" disabled={loading} onClick={() => void load(before)}>Load older</button>}
    {loading && <p className="panel-note">Loading history…</p>}
    {picked && <div className="history-confirm">
      <p>Roll back to {when(picked.ended_at)}. The report becomes {reportText(picked.state.report)}; proofreading becomes {reviewText(picked.state.review)}.</p>
      <p className="panel-note">This is recorded as a new history entry, so it can be undone. Reload any other open tab of this glance afterwards.</p>
      <button className="primary" type="button" disabled={picked.current || archived || !!gate} onClick={() => void restore()}>Roll back</button>
    </div>}
  </div>;
}
