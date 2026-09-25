#!/usr/bin/env python3
"""Reduce a published pytc.nogt analysis to the error_report.json the panel reads.

Two schemas are accepted. `pytc.nogt.segment_catalog`, published as
`merge_correction/segments_detailed.json` beside the image, is a per-segment
catalog: for Exp99_32x_2_cerebellum that is 74,385 segments and 128 MB
uncompressed. `pytc.nogt.error_analysis`, published as `error_analysis.json`
beside the segmentation, supersedes it and carries the same per-segment record
under `segment.profile`; see as_catalog. The viewer needs per-class aggregates,
which both already carry in `summary`, so this reduces rather than recomputes.

Two class fields exist and they differ. `segment.class` applies a size overlay
that reassigns tiny instances to `crumbs`; `segment.morphology_class` keeps the
geometric class. `summary.class_counts` is keyed on morphology_class, so this
groups the same way and asserts the counts agree.

Segment ids are capped: one class here holds 62,459 members, and the report has
a 1 MiB ceiling. The largest by volume are kept, which are the ones worth
clicking into.

    scripts/make_error_report.py segments_detailed.json -o error_report.json
    scripts/make_error_report.py gs://bucket/.../segments_detailed.json --stdout
"""

import argparse
import gzip
import json
import subprocess
import sys

MAX_SEGMENT_IDS = 200
MAX_AXONS = 20000
# The panel bins these itself, so it needs the measurements rather than bins.
AXON_CLASSES = ("good_axon_candidate", "broken_axon_candidate", "suspicious_axon_candidate")
AXES = {0: "z", 1: "y", 2: "x", "z": "z", "y": "y", "x": "x", "Z": "z", "Y": "y", "X": "x"}

# Where each class's members sit relative to the screen that admitted them, so
# the panel can put the borderline ones first. The thresholds are the published
# screens' own (REPORT.md): axons are elongated objects with radius <= 0.35 um,
# the bushy screen takes elongation < 3.00, dendrite-like takes thick elongated
# objects above the axon radius cutoff, and a small interior fragment has max
# bbox extent <= 1.50 um with a sphere-equivalent radius in 0.04-0.30 um.
# Each entry returns a distance in that variable's own units; margins are only
# ever compared within one class, so mixing um and elongation across rows is
# fine. A class with no defensible single boundary returns None.
AXON_MARGIN = ("radius below the 0.35 um axon cutoff",
               lambda s: none_or(s.get("radius_um"), lambda v: 0.35 - v))
BOUNDARIES = {
    "good_axon_candidate": AXON_MARGIN,
    "broken_axon_candidate": AXON_MARGIN,
    "suspicious_axon_candidate": AXON_MARGIN,
    "dendrite_like_candidate": ("radius above the 0.35 um axon cutoff",
                                lambda s: none_or(s.get("radius_um"), lambda v: v - 0.35)),
    "bushy_glia_like_candidate": ("elongation below the 3.00 axon cutoff",
                                  lambda s: none_or(s.get("elongation"), lambda v: 3.0 - v)),
    "unclassified": ("distance from the 3.00 elongation cutoff",
                     lambda s: none_or(s.get("elongation"), lambda v: abs(v - 3.0))),
    "small_interior_fragment_candidate": ("nearest of the fragment screen's own bounds, um",
                                          lambda s: fragment_margin(s)),
}


def none_or(value, fn):
    return fn(value) if isinstance(value, (int, float)) else None


def fragment_margin(segment):
    """Distance to the nearest edge of the fragment screen, all in um."""
    distances = []
    box = segment.get("bbox_um_zyx")
    if isinstance(box, list) and len(box) == 3:
        spans = [abs(pair[1] - pair[0]) for pair in box
                 if isinstance(pair, list) and len(pair) == 2]
        if spans:
            distances.append(abs(max(spans) - 1.5))
    radius = segment.get("radius_um")
    if isinstance(radius, (int, float)):
        distances += [abs(radius - 0.04), abs(radius - 0.30)]
    return min(distances) if distances else None


def centroid(segment):
    value = segment.get("centroid_um_zyx")
    if isinstance(value, list) and len(value) == 3 and all(isinstance(v, (int, float)) for v in value):
        return [round(v, 4) for v in value]
    return None
LABELS = {
    "good_axon_candidate": "Through-axon candidate",
    "broken_axon_candidate": "Possible broken axon",
    "suspicious_axon_candidate": "Suspicious axon geometry",
    "dendrite_like_candidate": "Dendrite-like candidate",
    "bushy_glia_like_candidate": "Bushy glia-like candidate",
    "small_interior_fragment_candidate": "Small interior fragment",
    "unclassified": "Unclassified",
    "crumbs": "Crumbs",
}


def load(source):
    if source.startswith("gs://"):
        raw = subprocess.run(["gcloud", "storage", "cat", source],
                             check=True, capture_output=True, timeout=900).stdout
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return json.loads(raw)
    opener = gzip.open if source.endswith(".gz") else open
    with opener(source, "rb") as handle:
        return json.loads(handle.read())


def axon_records(grouped, cap=MAX_AXONS):
    """Per-axon length, radius, and dominant axis for the classification panel.

    Only the three axon screens are carried: the panel clusters axon candidates,
    and the whole catalog would not fit the report's 1 MiB ceiling. Longest
    component length is the measurement the axon screen itself selects on, so
    it is what the histogram should show. When the cap bites, the longest are
    kept, matching the class id cap's "largest first" rule.
    """
    axons = []
    for key in AXON_CLASSES:
        for segment in grouped.get(key, []):
            # dominant_axis is an index into the catalog's ZYX ordering, not a
            # letter; a string form is accepted in case that ever changes.
            axis = AXES.get(segment.get("dominant_axis"))
            axons.append({
                "id": str(segment["id"]),
                "class": key,
                "length_um": rounded(segment.get("longest_component_length_um")
                                     or segment.get("length_um")),
                # Six digits, not four: the radius clusters have an edge at
                # 0.1 um and a 4-digit round moves 0.09998603 across it, which
                # would disagree with the published radius table by one axon.
                "radius_um": rounded(segment.get("radius_um"), 6),
                "axis": axis,
                "continuity": rounded(segment.get("continuity_proxy"), 6),
            })
    axons.sort(key=lambda entry: entry["length_um"] or 0, reverse=True)
    return axons[:cap], len(axons)


def rounded(value, digits=4):
    return round(value, digits) if isinstance(value, (int, float)) else None


ERROR_ANALYSIS_SCHEMA = "pytc.nogt.error_analysis"


def as_catalog(document):
    """Either published schema, in the one shape the rest of this reads.

    `pytc.nogt.error_analysis` is what the pipeline publishes now, beside the
    segmentation rather than beside the image. It embeds the old catalog's
    per-segment record as `segment.profile` and keeps its field names, so this
    is a lift rather than a translation. Four things genuinely differ: the
    class counts moved under a longer key, the bounding box became voxel
    indices, the longest component has to be taken from a list of them, and the
    metadata keys were renamed. A segment_catalog passes straight through.
    """
    if document.get("schema_name") != ERROR_ANALYSIS_SCHEMA:
        return document

    metadata = document.get("metadata", {})
    spacing = (metadata.get("morphology_config") or {}).get("voxel_size_um") or []
    segments, volumes = [], {}
    for entry in document.get("segments", []):
        profile = entry.get("profile")
        if not isinstance(profile, dict):
            continue
        record = dict(profile)
        record["id"] = entry.get("id", profile.get("label"))
        lengths = [v for v in (profile.get("component_lengths_um") or [])
                   if isinstance(v, (int, float))]
        record["longest_component_length_um"] = max(lengths) if lengths else profile.get("length_um")
        box = profile.get("bbox_zyx")
        # The catalog bounded in microns; this schema bounds in voxel indices,
        # and the fragment margin is measured in microns.
        if isinstance(box, list) and len(box) == 3 and len(spacing) == 3:
            record["bbox_um_zyx"] = [[pair[0] * size, pair[1] * size]
                                     for pair, size in zip(box, spacing)]
        key = profile.get("morphology_class")
        if key is not None:
            volumes[key] = volumes.get(key, 0.0) + (profile.get("volume_um3") or 0.0)
        segments.append(record)

    summary = document.get("summary", {})
    return {
        "schema_name": document.get("schema_name"),
        "metadata": {
            "dataset_name": metadata.get("volume"),
            "created_at_utc": metadata.get("completed_at_utc"),
            "segmentation_variant": metadata.get("model"),
        },
        # class_volume_um3 is summed here because this schema reports class
        # counts but not class volumes.
        "summary": {
            "class_counts": summary.get("morphology_class_counts", {}),
            "class_volume_um3": volumes,
            "voxel_size_um": spacing,
        },
        "segments": segments,
    }


def build(catalog, cap=MAX_SEGMENT_IDS, axon_cap=MAX_AXONS):
    catalog = as_catalog(catalog)
    summary = catalog["summary"]
    counts = summary["class_counts"]
    volumes = summary.get("class_volume_um3", {})
    notes = catalog.get("classes", {})
    metadata = catalog.get("metadata", {})

    voxel_size = summary.get("voxel_size_um") or []
    voxel_volume = None
    if len(voxel_size) == 3:
        voxel_volume = voxel_size[0] * voxel_size[1] * voxel_size[2]

    grouped, voxels, seen = {}, {}, {}
    for segment in catalog["segments"]:
        key = segment.get("morphology_class")
        if key is None:
            continue
        voxels[key] = voxels.get(key, 0) + int(segment.get("voxel_count") or 0)
        seen[key] = seen.get(key, 0) + 1
        grouped.setdefault(key, []).append(segment)

    for key, expected in counts.items():
        if seen.get(key, 0) != expected:
            print(f"warning: {key} has {seen.get(key, 0)} segments but summary says {expected}",
                  file=sys.stderr)

    classes = []
    for key, count in counts.items():
        members = sorted(grouped.get(key, []),
                         key=lambda s: s.get("volume_um3") or 0, reverse=True)
        note = (notes.get(key) or "").strip()[:1000] or None
        label, margin = BOUNDARIES.get(key, (None, None))
        classes.append({
            "id": key,
            "label": LABELS.get(key, key.replace("_", " ").capitalize())[:120],
            "labels": count,
            "voxels": voxels.get(key, 0),
            "volume_um3": round(volumes[key], 4) if key in volumes else None,
            "note": note,
            "margin_label": label,
            "segments": [
                {
                    "id": str(s["id"]),
                    "voxels": int(s.get("voxel_count") or 0),
                    "volume_um3": rounded(s.get("volume_um3")),
                    "centroid_um": centroid(s),
                    "radius_um": rounded(s.get("radius_um"), 6),
                    "length_um": rounded(s.get("longest_component_length_um")
                                         or s.get("length_um")),
                    "margin": rounded(margin(s), 6) if margin else None,
                }
                for s in members[:cap]
            ],
        })
    classes.sort(key=lambda entry: entry["voxels"], reverse=True)

    axons, axon_total = axon_records(grouped, axon_cap)

    truncated = [c["id"] for c in classes if c["labels"] > len(c["segments"])]
    notes_text = (
        "Morphology-class shares, not semantic estimates of glia, dendrites, or axons. "
        f"Reduced from {catalog.get('schema_name', 'segment catalog')} "
        f"({len(catalog['segments'])} segments)."
    )
    if truncated:
        notes_text += f" Segment records capped at {cap} per class, largest by volume."
    if axon_total > len(axons):
        notes_text += f" Axon records capped at {axon_cap} of {axon_total}, longest first."

    return {
        "version": 1,
        "dataset": metadata.get("dataset_name"),
        "generated_at": (metadata.get("created_at_utc") or "")[:10] or None,
        "segmentation": metadata.get("segmentation_variant"),
        "voxel_volume_um3": voxel_volume,
        "notes": notes_text[:2000],
        "total_voxels": sum(entry["voxels"] for entry in classes),
        "classes": classes,
        "figures": [],
        "axons": axons,
    }


# The five semantic classes both panels are about, in lib/structures.ts's
# composition order. The ids are the app's own, so a report class and a
# quality-control category are the same thing rather than a guessed pairing.
# The pipeline has published glia as `glia_or_soma`; it folds in here.
SEMANTIC_ORDER = ("blood_vessel", "glia", "dendrite", "axon", "unclassified")
SEMANTIC_ALIASES = {"glia_or_soma": "glia", "vessel": "blood_vessel", "bv": "blood_vessel"}
SEMANTIC_LABELS = {
    "blood_vessel": "Blood vessel",
    "glia": "Glia (incl. soma)",
    "dendrite": "Dendrite candidate",
    "axon": "Axon candidate",
    "unclassified": "Unclassified",
}
SEMANTIC_SCHEMA = "pytc.initial_semantic_segmentation"
# A record's quality is an index into this list, which the report carries once
# as `qualities`; the order is lib/review.ts's CELL_VERDICTS.
QUALITIES = ("complete", "false_split", "false_merge", "unknown")
# The Worker stores reports gzipped and accepts up to 16 MiB of JSON, which
# holds every analysed segment of any volume published so far; this is a guard,
# not a budget.
MAX_REPORT_BYTES = 15 * 1024 * 1024
MAX_SEGMENTS_PER_CLASS = 200000


def semantic_key(value):
    key = SEMANTIC_ALIASES.get(value, value)
    return key if key in SEMANTIC_ORDER else "unclassified"


def starting_quality(morphology):
    """What the pipeline's axon screen already says about completeness.

    Good is complete and broken a false split; nothing else says anything, and
    nothing upstream screens for merges, so a false merge is only ever the
    reader's call. Mirrors pipelineQuality in cell-panel.tsx, which remains the
    fallback for reports that carry no per-segment quality."""
    name = morphology or ""
    if name.startswith("good_"):
        return "complete"
    if name.startswith("broken_"):
        return "false_split"
    return "unknown"


def significant(value, figures=3):
    """A measurement to a few significant figures; exact digits are noise here."""
    if not isinstance(value, (int, float)) or not value:
        return value if isinstance(value, (int, float)) else None
    rounded_value = float(f"{value:.{figures}g}")
    return int(rounded_value) if rounded_value.is_integer() else rounded_value


def compact(record):
    return {key: value for key, value in record.items() if value is not None}


def build_semantic(analysis, semantic=None, max_bytes=MAX_REPORT_BYTES):
    """One report class per semantic class, one record per analyzed segment.

    Each segment's semantic class comes from the analysis itself when the
    pipeline writes it there (`segment.semantic_class`), otherwise from the
    published `pytc.initial_semantic_segmentation` catalog, joined by id. The
    rule is the pipeline's (classify_semantic_candidate) and is not repeated
    here. Class totals cover all foreground: labels below the analysis cutoff
    count toward their class, usually unclassified, but carry no record, since
    they were never measured. Records are the analyzed segments, largest
    first. Every analysed segment is kept; only a volume past the Worker's
    16 MiB ceiling would lose its smallest, and the notes would say how many.
    """
    if analysis.get("schema_name") != ERROR_ANALYSIS_SCHEMA:
        raise SystemExit("semantic classes need a pytc.nogt.error_analysis document")
    if semantic is not None and semantic.get("schema_name") != SEMANTIC_SCHEMA:
        raise SystemExit(f"expected {SEMANTIC_SCHEMA}, got {semantic.get('schema_name')}")
    metadata = analysis.get("metadata", {})
    gates = metadata.get("continuity_config") or {}
    axon_max, dendrite_min = gates.get("axon_max_radius_um"), gates.get("dendrite_min_radius_um")
    spacing = (metadata.get("morphology_config") or {}).get("voxel_size_um") or []
    voxel_volume = spacing[0] * spacing[1] * spacing[2] if len(spacing) == 3 else None

    catalog = {str(s["id"]): s for s in (semantic or {}).get("segments", [])}
    records = {key: [] for key in SEMANTIC_ORDER}
    missing = 0
    for entry in analysis.get("segments", []):
        profile = entry.get("profile") or {}
        sid = str(entry.get("id", profile.get("label")))
        published = entry.get("semantic_class") or (catalog.get(sid) or {}).get("semantic_class")
        if published is None:
            missing += 1
        key = semantic_key(published)
        caliber = (entry.get("continuity") or {}).get("caliber_radius_um")
        margin = None
        if isinstance(caliber, (int, float)):
            if key == "axon" and isinstance(axon_max, (int, float)):
                margin = abs(axon_max - caliber)
            elif key == "dendrite" and isinstance(dendrite_min, (int, float)):
                margin = abs(caliber - dendrite_min)
        lengths = [v for v in (profile.get("component_lengths_um") or []) if isinstance(v, (int, float))]
        morphology = (entry.get("classification") or {}).get("display_class") or profile.get("morphology_class")
        # A record per analysed segment, so each is kept lean: measurements to
        # three significant figures, which is all a reader compares them by,
        # and a centroid to 0.1 um, which is plenty to recentre the viewer.
        # Voxels stay exact, since corrections add and subtract them. An
        # unknown quality is the reader's default anyway.
        # The pipeline's catalog now carries a per-segment `quality` from skeleton
        # ends (complete = every end at the border, a spur, or an axon terminal;
        # false_split = an end site inside the volume). The axon screen is the
        # fallback for catalogs that predate it.
        quality = (entry.get("quality") or (catalog.get(sid) or {}).get("quality")
                   or starting_quality(morphology))
        box = profile.get("centroid_um_zyx")
        records[key].append(compact({
            "id": sid,
            "voxels": int(entry.get("voxel_count") or profile.get("voxel_count") or 0),
            "volume_um3": significant(entry.get("volume_um3", profile.get("volume_um3"))),
            "centroid_um": [round(v, 1) for v in box] if isinstance(box, list) and len(box) == 3 else None,
            "radius_um": significant(profile.get("radius_um")),
            "length_um": significant(max(lengths) if lengths else profile.get("length_um")),
            "margin": significant(margin),
            "quality": None if quality == "unknown" else QUALITIES.index(quality),
        }))
    if semantic is None and missing:
        raise SystemExit(f"{missing} segments carry no semantic_class; pass the semantic catalog")

    # Totals: the catalog's own, which include every sub-cutoff label, or else
    # the analysed segments plus the analysis's excluded remainder.
    totals, labels, assessed = {}, {}, {}
    if semantic is not None:
        for category in semantic.get("summary", {}).get("categories", []):
            key = semantic_key(category.get("class"))
            totals[key] = totals.get(key, 0) + int(category.get("voxel_count") or 0)
            labels[key] = labels.get(key, 0) + int(category.get("segment_count") or 0)
            assessed[key] = category.get("assessment_status") != "not_assessed"
    else:
        for key, members in records.items():
            totals[key] = sum(r["voxels"] for r in members)
            labels[key] = len(members)
        coverage = metadata.get("coverage") or {}
        totals["unclassified"] += int(coverage.get("excluded_voxels") or 0)
        labels["unclassified"] += int(coverage.get("excluded_label_count") or 0)
    for members in records.values():
        members.sort(key=lambda r: r["voxels"], reverse=True)

    def assemble(cap):
        classes = []
        for key in SEMANTIC_ORDER:
            not_assessed = assessed.get(key) is False
            classes.append(compact({
                "id": key,
                "label": SEMANTIC_LABELS[key],
                "labels": labels.get(key, 0),
                "voxels": totals.get(key, 0),
                "volume_um3": rounded(totals.get(key, 0) * voxel_volume) if voxel_volume else None,
                "note": "Not assessed by this run: zero here does not mean absent." if not_assessed else None,
                "margin_label": {"axon": f"caliber from the {axon_max} um axon gate",
                                 "dendrite": f"caliber from the {dendrite_min} um dendrite gate"}.get(key),
                "segments": records[key][:cap],
            }))
        return classes

    cap = MAX_SEGMENTS_PER_CLASS
    classes = assemble(cap)
    while len(json.dumps(classes, separators=(",", ":")).encode()) > max_bytes and cap > 1:
        cap = int(cap * 0.9)
        classes = assemble(cap)
    kept = sum(len(c["segments"]) for c in classes)
    analysed = sum(len(m) for m in records.values())

    notes = ("Semantic classes are geometric candidates from the pipeline, not verified cell types. "
             "Starting quality is the pipeline's end check where the catalog carries one: complete when "
             "every skeleton end is at the border, a surface spur, or an axon terminal; false split when an "
             "end lies inside the volume. Older catalogs fall back to the axon screen. "
             f"{analysed} analysed segments carry records; smaller labels count toward class totals only.")
    if kept < analysed:
        notes += f" Records capped at {cap} per class, largest first ({kept} of {analysed} kept)."
    return {
        "version": 1,
        "dataset": metadata.get("volume"),
        "generated_at": (metadata.get("completed_at_utc") or "")[:10] or None,
        "segmentation": metadata.get("model"),
        "voxel_volume_um3": voxel_volume,
        "notes": notes[:2000],
        "total_voxels": sum(totals.values()),
        "qualities": list(QUALITIES),
        "classes": classes,
        "figures": [],
        "axons": [],
    }


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("catalog", help="segments_detailed.json, .gz, or a gs:// URI")
    parser.add_argument("-o", "--output", default="error_report.json")
    parser.add_argument("--stdout", action="store_true")
    parser.add_argument("--max-segment-ids", type=int, default=MAX_SEGMENT_IDS)
    parser.add_argument("--max-axons", type=int, default=MAX_AXONS,
                        help="per-axon records kept for the classification panel")
    parser.add_argument("--semantic", metavar="CATALOG",
                        help="semantic_segmentation.json to take each segment's semantic class from")
    parser.add_argument("--morphology", action="store_true",
                        help="report the seven morphology classes instead of the five semantic ones")
    args = parser.parse_args()

    document = load(args.catalog)
    if args.morphology or document.get("schema_name") != ERROR_ANALYSIS_SCHEMA:
        report = build(document, args.max_segment_ids, args.max_axons)
    else:
        report = build_semantic(document, load(args.semantic) if args.semantic else None)
    text = json.dumps(report, indent=2)
    if args.stdout:
        print(text)
        return
    with open(args.output, "w") as handle:
        handle.write(text + "\n")
    print(f"wrote {args.output} ({len(text.encode()) / 1024:.1f} KiB, "
          f"{len(report['classes'])} classes, "
          f"{sum(len(c['segments']) for c in report['classes'])} segment records, "
          f"{len(report['axons'])} axons)", file=sys.stderr)


if __name__ == "__main__":
    main()
