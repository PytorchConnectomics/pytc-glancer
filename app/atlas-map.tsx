"use client";

import { useMemo, type CSSProperties } from "react";
import { ALLEN_REGIONS, type AtlasDataset } from "../lib/atlas-data";
import { fullViewBox, regionCentre, type Plate, type PlateStructure } from "../lib/atlas-plates";

export interface MapLayers { points: boolean; divisions: boolean; labels: boolean; detail: boolean }

interface Props {
  plate: Plate;
  /** The region the map is currently pointing at, or null for none. */
  focusRegion: string | null;
  datasets: AtlasDataset[];
  selectedId: string | null;
  layers: MapLayers;
  hovered: PlateStructure | null;
  onHover: (structure: PlateStructure | null) => void;
  onSelectRegion: (region: string) => void;
  onSelectDataset: (id: string) => void;
}

/** Structures big enough to read at map scale, so the fine leaf outlines can be
 * hidden without the section falling apart. Threshold is in plate units². */
const DETAIL_AREA = 900;

/** Markers for one region fan out around its centre rather than stacking. */
function fan(count: number, index: number, radius: number) {
  if (count === 1) return [0, 0];
  const spread = Math.min(Math.PI * 1.4, 0.5 * count);
  const angle = -Math.PI / 2 + spread * (index / (count - 1) - 0.5);
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

export default function AtlasMap({
  plate, focusRegion, datasets, selectedId, layers, hovered, onHover, onSelectRegion, onSelectDataset,
}: Props) {
  const [vx, vy, vw, vh] = fullViewBox(plate);
  // Marker and label sizes are given in plate units, so they hold their apparent
  // size whichever plate is shown — the plates differ in extent.
  const unit = vw / 100;

  const drawn = useMemo(
    () => plate.structures.filter((structure) => layers.detail || structure.a >= DETAIL_AREA || structure.region),
    [plate, layers.detail],
  );

  /** Where each region's datasets sit, and the marker cluster for each. */
  const clusters = useMemo(() => {
    const byRegion = new Map<string, AtlasDataset[]>();
    for (const dataset of datasets) {
      if (!plate.structures.some((structure) => structure.region === dataset.region)) continue;
      byRegion.set(dataset.region, [...(byRegion.get(dataset.region) ?? []), dataset]);
    }
    return [...byRegion].flatMap(([region, members]) => {
      const centre = regionCentre(plate, region);
      if (!centre) return [];
      return members.map((dataset, index) => {
        const [dx, dy] = fan(members.length, index, unit * 2.6);
        return { dataset, region, x: centre[0] + dx, y: centre[1] + dy };
      });
    });
  }, [plate, datasets, unit]);

  const labelled = useMemo(() => {
    if (!layers.labels) return [];
    const regions = [...new Set(plate.structures.map((s) => s.region).filter(Boolean) as string[])];
    return regions.flatMap((region) => {
      const centre = regionCentre(plate, region);
      return centre ? [{ region, x: centre[0], y: centre[1] }] : [];
    });
  }, [plate, layers.labels]);

  function fill(structure: PlateStructure) {
    if (structure.region) return ALLEN_REGIONS[structure.region]?.color ?? structure.color;
    return layers.divisions ? structure.color : "#243244";
  }

  function className(structure: PlateStructure) {
    const classes = ["ccf-structure"];
    if (structure.region) classes.push("has-data");
    if (focusRegion && structure.region === focusRegion) classes.push("focused");
    else if (focusRegion) classes.push("dimmed");
    if (hovered?.sid === structure.sid) classes.push("hovered");
    return classes.join(" ");
  }

  function paths(interactive: boolean) {
    return drawn.map((structure) => (
      <path
        key={structure.sid}
        d={structure.d}
        className={className(structure)}
        style={{ "--structure-fill": fill(structure) } as CSSProperties}
        onMouseEnter={interactive ? () => onHover(structure) : undefined}
        onMouseLeave={interactive ? () => onHover(null) : undefined}
        onClick={interactive && structure.region ? () => onSelectRegion(structure.region!) : undefined}
      >
        {interactive && <title>{`${structure.name} (${structure.acr})`}</title>}
      </path>
    ));
  }

  return (
    <svg className="ccf-map" viewBox={`${vx} ${vy} ${vw} ${vh}`} role="img"
         aria-label={`${plate.label} of the Allen Reference Atlas, with catalog regions highlighted`}>
      {/* The P56 coronal atlas annotates one hemisphere. The reflection is drawn
        * first so the interactive half sits on top, and it overlaps the cut edge
        * by a hair so the two stroked midline borders do not read as a seam. It
        * is a real copy rather than a <use>: selectors cannot cross that
        * element's shadow boundary, so a cloned half would lose all its fills. */}
      {plate.midline !== null && (
        <g className="ccf-mirror" aria-hidden="true"
           transform={`translate(${(plate.midline * 2 - 0.6).toFixed(1)},0) scale(-1,1)`}>{paths(false)}</g>
      )}
      <g>{paths(true)}</g>

      {layers.labels && labelled.map(({ region, x, y }) => (
        // Markers fan upwards from the region centre, so labels sit below it.
        <text key={region} className="ccf-label" x={x} y={y + unit * 4.4} textAnchor="middle"
              style={{ fontSize: `${unit * 2.4}px` }}>
          {ALLEN_REGIONS[region]?.acronym ?? region}
        </text>
      ))}

      {layers.points && clusters.map(({ dataset, region, x, y }) => {
        const selected = dataset.id === selectedId;
        return (
          <g key={dataset.id} className={`ccf-mark${selected ? " selected" : ""}`} tabIndex={0} role="button"
             style={{ "--dataset-color": ALLEN_REGIONS[region]?.color ?? "#38d7db" } as CSSProperties}
             aria-label={`Select ${dataset.name}: ${dataset.title}`}
             onClick={() => onSelectDataset(dataset.id)}
             onKeyDown={(event) => {
               if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectDataset(dataset.id); }
             }}>
            <circle className="mark-hit" cx={x} cy={y} r={unit * 2.2} />
            <circle className="mark-ring" cx={x} cy={y} r={unit * 1.35} />
            <circle className="mark-core" cx={x} cy={y} r={unit * 0.7} />
            {selected && (() => {
              // Labels flip to the inside near an edge so a long dataset name is
              // never clipped by the panel.
              const nearRight = x > vx + vw * 0.62;
              return <text className="mark-label" x={x + (nearRight ? -unit * 1.9 : unit * 1.9)} y={y + unit * 0.7}
                           textAnchor={nearRight ? "end" : "start"} style={{ fontSize: `${unit * 2.3}px` }}>
                {dataset.name}
              </text>;
            })()}
          </g>
        );
      })}
    </svg>
  );
}
