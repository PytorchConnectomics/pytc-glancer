"use client";

import { useState } from "react";
import { Legend, Pie, buildSlices, integers, percents, type Slice } from "./chart";
import type { Composition, CompositionCategory } from "../../../../../lib/composition";

export type { Composition } from "../../../../../lib/composition";

const UNACCOUNTED = "unaccounted";

function volume(value: number | null) { return value === null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} µm³`; }

/** Slices of foreground, and only of what was actually assessed.
 *
 * The denominator is foreground, not the sum of the slices, so the chart can
 * never quietly renormalise its way to 100%. When the assessed categories fall
 * short of foreground -- a category the run skipped that nonetheless holds
 * voxels -- the remainder is drawn as its own neutral slice instead, because a
 * pie that claims to partition foreground has to actually partition it.
 */
export function sliceComposition(composition: Composition): Slice<CompositionCategory>[] {
  const assessed = composition.categories.filter((entry) => entry.assessed);
  const counted = assessed.reduce((sum, entry) => sum + entry.voxels, 0);
  const groups = assessed.map((entry) => ({ id: entry.id, label: entry.label, value: entry.voxels, members: [entry] }));
  const remainder = composition.foreground_voxels - counted;
  // One voxel of float noise is not a category; a real shortfall is.
  if (remainder > 1) groups.push({ id: UNACCOUNTED, label: "Not accounted for", value: remainder, members: [] });
  return buildSlices(groups, (count) => `Other (${count} categories)`);
}

export default function CompositionPanel({ composition }: { composition: Composition }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tabular, setTabular] = useState(false);
  const slices = sliceComposition(composition);
  const unassessed = composition.categories.filter((entry) => !entry.assessed);
  const crop = composition.total_voxels;
  const shown = slices.find((slice) => slice.id === hovered) ?? slices.find((slice) => slice.id === selected) ?? null;
  const share = (voxels: number) => voxels / (composition.foreground_voxels || 1);
  const objectPath = `gs://${composition.bucket}/${composition.directory}/semantic_summary.json`;

  return <div className="composition">
    <p className="panel-note">
      Foreground composition of <strong>{composition.layer ?? "this segmentation"}</strong>, by voxel count.
      An object that is two things at once counts once, in the first category it matches, reading down this list.
    </p>

    <p className="composition-headline">
      <strong>{crop ? percents.format(composition.foreground_voxels / crop) : "—"}</strong>
      <span>of the crop is foreground — {integers.format(composition.foreground_voxels)} voxels
        {composition.foreground_volume_um3 === null ? "" : `, ${volume(composition.foreground_volume_um3)}`}
        {composition.segment_count === null ? "" : ` across ${integers.format(composition.segment_count)} objects`}.
        Every share below is of that foreground.</span>
    </p>

    <figure className="pie-figure">
      <Pie slices={slices} selected={selected} hovered={hovered} onHover={setHovered} onSelect={setSelected}
        label={`Foreground voxel share by category for ${composition.layer ?? composition.directory}`}
        describe={(slice) => `${slice.label}, ${integers.format(slice.value)} voxels, ${percents.format(slice.share)} of foreground`} />
      <figcaption className="pie-readout" aria-live="polite">
        {shown
          ? <><strong>{percents.format(shown.share)}</strong><span>{shown.label} · {integers.format(shown.value)} voxels</span></>
          : <><strong>{integers.format(composition.foreground_voxels)}</strong><span>foreground voxels</span></>}
      </figcaption>
    </figure>

    <Legend slices={slices} selected={selected} onSelect={setSelected} onHover={setHovered} value={(slice) => percents.format(slice.share)} />

    {/* Not assessed is not zero. A run that never looked for vessels and a
      * volume with no vessels are different claims, and a 0% slice would read
      * as the second. These rows carry no number at all. */}
    {unassessed.length > 0 && <div className="unassessed">
      <h3 className="panel-subheading">Not assessed</h3>
      <ul className="unassessed-list">{unassessed.map((entry) => <li key={entry.id}>
        <span className="unassessed-label">{entry.label}</span><span className="unassessed-value">not assessed</span>
      </li>)}</ul>
      <p className="class-note">This run did not screen for {unassessed.length === 1 ? "this category" : "these categories"}, so they are absent from the chart rather than measured at zero. Their voxels are counted under whichever category did claim them.</p>
    </div>}

    <button className="text-button table-toggle" type="button" aria-expanded={tabular} onClick={() => setTabular(!tabular)}>{tabular ? "Hide table" : "Show table"}</button>
    {tabular && <table className="report-table">
      <caption className="sr-only">Objects, voxels, volume, and share by category</caption>
      <thead><tr><th scope="col">Category</th><th scope="col">Objects</th><th scope="col">Voxels</th><th scope="col">Volume</th><th scope="col">Foreground</th><th scope="col">Crop</th></tr></thead>
      <tbody>{composition.categories.map((entry) => <tr key={entry.id} className={entry.assessed ? "" : "row-unassessed"}>
        <th scope="row">{entry.label}</th>
        {entry.assessed
          ? <>
            <td>{entry.segments === null ? "—" : integers.format(entry.segments)}</td>
            <td>{integers.format(entry.voxels)}</td>
            <td>{volume(entry.volume_um3)}</td>
            <td>{percents.format(share(entry.voxels))}</td>
            <td>{crop ? percents.format(entry.voxels / crop) : "—"}</td>
          </>
          : <td colSpan={5}>not assessed</td>}
      </tr>)}</tbody>
    </table>}

    {composition.large_objects && composition.large_objects.voxels !== null && <p className="class-note">
      {integers.format(composition.large_objects.segment_count)} objects
      {composition.large_objects.threshold_volume_um3 === null ? "" : ` of at least ${composition.large_objects.threshold_volume_um3} µm³`} hold {percents.format(share(composition.large_objects.voxels))} of
      foreground between them, so most of this chart rests on relatively few objects.
    </p>}

    <p className="class-note">
      Categories are geometric hypotheses from the published catalog, not verified cell types. Because a merged object
      counts in the first category it matches, a category high in the list is an upper bound and one below it a lower bound.
      Read from <code>{objectPath}</code>.
    </p>
  </div>;
}
