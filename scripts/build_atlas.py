#!/usr/bin/env python3
"""Vendor Allen Reference Atlas plates for the Volumes tab.

The Volumes map draws real anatomy rather than a schematic, so this script pulls
annotated plate geometry from the Allen Brain Atlas API, simplifies it, and
writes it into `public/atlas/`. Run it when the plate selection changes; the app
itself never calls brain-map.org.

    python3 scripts/build_atlas.py

Two Allen atlases were compared before settling on these sources:

  * `atlas=1` "Mouse, P56, Coronal" (used here). Bezier outlines, ~113 KB per
    plate, and the full modern ontology down to cortical layers, hippocampal
    strata (CA1so/sp/sr/slm) and barrel cortex (SSp-bfd).
  * `atlas=602630314` "Mouse, Adult, 3D Coronal" (rejected). The CCFv3-registered
    atlas, but each plate is a 6.2 MB polyline dump — 574k vertices — and it
    resolves *less* structure than the P56 atlas at the levels this map uses.

No single coronal plate contains every region the catalog files datasets under:
the regions occupy disjoint anterior-posterior bands. Three plates cover all
eight, and a midline sagittal plate serves as the whole-brain locator.

Allen Institute data is used under its Terms of Use; see ATTRIBUTION below.
"""
import json
import math
import re
import urllib.request
from pathlib import Path

API = "http://api.brain-map.org/api/v2"
OUT = Path(__file__).resolve().parent.parent / "public" / "atlas"
CACHE = Path("/tmp/pytc_glancer-atlas-cache")

ATTRIBUTION = ("Allen Reference Atlas — Mouse Brain, Allen Institute for Brain Science. "
               "Available from atlas.brain-map.org.")

# The catalog's region keys (lib/atlas-data.ts) resolved onto CCF structures. A
# structure belongs to a region when that region's acronym is one of its
# ancestors, so `visual` covers every VISp layer without naming them.
REGION_CCF = {
    "visual": ["VISp"],
    "somatosensory": ["SSp"],
    "hippocampus": ["HPF"],
    "thalamus": ["TH"],
    "cerebellum": ["CB"],
    "striatum": ["STR"],
    "amygdala": ["BLA", "LA", "CEA", "MEA", "COA", "PA"],
    "auditory": ["CN"],
}

# The twelve major divisions of grey matter, plus fibre tracts and ventricles.
# Every drawn structure is filled with its division's colour, so the map reads as
# anatomy at a glance and as ontology on hover.
DIVISIONS = ["Isocortex", "OLF", "HPF", "CTXsp", "STR", "PAL",
             "TH", "HY", "MB", "P", "MY", "CB", "fiber tracts", "VS"]

PLATES = [
    {"id": "coronal-250", "image": 100960273, "section": 250, "orientation": "coronal",
     "label": "Coronal §250", "note": "Striatum, barrel cortex and amygdala."},
    {"id": "coronal-326", "image": 100960069, "section": 326, "orientation": "coronal",
     "label": "Coronal §326", "note": "Visual cortex, hippocampus and thalamus."},
    {"id": "coronal-409", "image": 100960212, "section": 409, "orientation": "coronal",
     "label": "Coronal §409", "note": "Cerebellum and cochlear nuclei."},
    {"id": "sagittal-145", "image": 100883869, "section": 145, "orientation": "sagittal",
     "label": "Sagittal §145", "note": "Whole-brain locator: all twelve divisions."},
]


def fetch(url, path):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / path
    if not target.exists():
        print(f"  downloading {path}")
        urllib.request.urlretrieve(url, target)
    return target.read_text()


def structures():
    raw = fetch(f"{API}/data/query.json?criteria=model::Structure,rma::criteria,"
                f"[graph_id$eq1],rma::options[num_rows$eqall]", "structures.json")
    return {s["id"]: s for s in json.loads(raw)["msg"]}


# --- path geometry ----------------------------------------------------------
# Allen `d` strings use M/m, L/l, H/h, V/v, C/c, S/s and Z. Scaling is linear, so
# every coordinate — absolute or relative — is simply multiplied through.
ARITY = {"m": 2, "l": 2, "h": 1, "v": 1, "c": 6, "s": 4, "q": 4, "t": 2, "a": 7, "z": 0}
TOKEN = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)")


def parse_d(d):
    """[(command, [numbers]), ...] in document order.

    A command letter may be followed by several coordinate runs; each run is one
    segment. Per the SVG grammar a repeated run after `M`/`m` is an implicit
    lineto, which is why the command is rewritten after the first group."""
    tokens = [(m.group(1), m.group(2)) for m in TOKEN.finditer(d)]
    out, index = [], 0
    command = None
    while index < len(tokens):
        letter, number = tokens[index]
        if letter:
            command = letter
            index += 1
            if command in "Zz":
                out.append((command, []))
                command = None
            continue
        if command is None:
            index += 1  # A number with no command in scope is malformed; skip it.
            continue
        arity = ARITY[command.lower()]
        numbers = []
        while len(numbers) < arity and index < len(tokens) and tokens[index][1] is not None:
            numbers.append(float(tokens[index][1]))
            index += 1
        if len(numbers) < arity:
            break
        out.append((command, numbers))
        if command == "M":
            command = "L"
        elif command == "m":
            command = "l"
    return out


def scale_d(segments, scale, precision=1):
    """Re-emit a path with the atlas transform baked in and coordinates rounded."""
    def fmt(value):
        text = f"{value * scale:.{precision}f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"
    parts = []
    for command, numbers in segments:
        parts.append(command + ",".join(fmt(n) for n in numbers))
    return "".join(parts).replace(",-", "-")


def flatten(segments, steps=6):
    """Absolute polygon rings, with curves subdivided — used for area/centroid."""
    rings, ring = [], []
    x = y = start_x = start_y = 0.0

    def cubic(x0, y0, points):
        x1, y1, x2, y2, x3, y3 = points
        for i in range(1, steps + 1):
            t = i / steps
            u = 1 - t
            ring.append((u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3,
                         u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3))
        return x3, y3

    previous_control = None
    for command, numbers in segments:
        upper = command.upper()
        relative = command.islower()
        if upper == "Z":
            if len(ring) > 2:
                rings.append(ring)
            ring, x, y = [], start_x, start_y
            previous_control = None
            continue
        if upper == "M":
            if len(ring) > 2:
                rings.append(ring)
            x, y = (x + numbers[0], y + numbers[1]) if relative else (numbers[0], numbers[1])
            start_x, start_y, ring = x, y, [(x, y)]
            previous_control = None
        elif upper in ("L", "H", "V"):
            if upper == "H":
                x = x + numbers[0] if relative else numbers[0]
            elif upper == "V":
                y = y + numbers[0] if relative else numbers[0]
            else:
                x, y = (x + numbers[0], y + numbers[1]) if relative else (numbers[0], numbers[1])
            ring.append((x, y))
            previous_control = None
        elif upper in ("C", "S"):
            if upper == "C":
                points = [x + n if i % 2 == 0 else y + n for i, n in enumerate(numbers)] if relative else list(numbers)
            else:
                # `S` mirrors the previous curve's second control point.
                tail = [x + n if i % 2 == 0 else y + n for i, n in enumerate(numbers)] if relative else list(numbers)
                cx, cy = (2 * x - previous_control[0], 2 * y - previous_control[1]) if previous_control else (x, y)
                points = [cx, cy] + tail
            previous_control = (points[2], points[3])
            x, y = cubic(x, y, points)
    if len(ring) > 2:
        rings.append(ring)
    return rings


def ring_area(ring):
    return sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring))) / 2


def ring_centroid(ring):
    total = sx = sy = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i - 1]
        x1, y1 = ring[i]
        cross = x0 * y1 - x1 * y0
        total += cross
        sx += (x0 + x1) * cross
        sy += (y0 + y1) * cross
    return (sx / (3 * total), sy / (3 * total)) if total else ring[0]


def build(plate, ontology, by_acronym):
    svg = fetch(f"{API}/svg_download/{plate['image']}?groups=28&downsample=4", f"{plate['id']}.svg")
    scale = float(re.search(r"scale\(([\d.]+)\)", svg).group(1))

    division_ids = {by_acronym[a]["id"]: a for a in DIVISIONS if a in by_acronym}
    region_ids = {by_acronym[a]["id"]: region for region, acronyms in REGION_CCF.items()
                  for a in acronyms if a in by_acronym}

    grouped = {}
    for match in re.finditer(r"<path\b([^>]*?)/>", svg, re.S):
        attributes = match.group(1)
        sid = re.search(r'structure_id="(\d+)"', attributes)
        d = re.search(r'\sd="(.*?)"', attributes, re.S)
        if not (sid and d) or int(sid.group(1)) not in ontology:
            continue
        grouped.setdefault(int(sid.group(1)), []).append(" ".join(d.group(1).split()))

    structures_out, bounds = [], [math.inf, math.inf, -math.inf, -math.inf]
    for sid, paths in grouped.items():
        record = ontology[sid]
        lineage = [int(p) for p in record["structure_id_path"].strip("/").split("/")]
        segments = [parse_d(d) for d in paths]
        rings = [r for s in segments for r in flatten(s)]
        if not rings:
            continue
        areas = [abs(ring_area(r)) for r in rings]
        largest = rings[areas.index(max(areas))]
        cx, cy = ring_centroid(largest)
        for ring in rings:
            for px, py in ring:
                bounds = [min(bounds[0], px), min(bounds[1], py), max(bounds[2], px), max(bounds[3], py)]
        structures_out.append({
            "sid": sid,
            "acr": record["acronym"],
            "name": record["name"],
            "color": "#" + record["color_hex_triplet"],
            "division": next((division_ids[a] for a in lineage if a in division_ids), None),
            "region": next((region_ids[a] for a in lineage if a in region_ids), None),
            "d": "".join(scale_d(s, scale) for s in segments),
            "c": [round(cx * scale, 1), round(cy * scale, 1)],
            "a": round(sum(areas) * scale * scale),
        })

    x0, y0, x1, y1 = [v * scale for v in bounds]
    pad = (x1 - x0) * 0.02
    document = {
        "id": plate["id"], "label": plate["label"], "note": plate["note"],
        "orientation": plate["orientation"], "section": plate["section"],
        "atlasImageId": plate["image"],
        "viewBox": [round(x0 - pad, 1), round(y0 - pad, 1), round(x1 - x0 + 2 * pad, 1), round(y1 - y0 + 2 * pad, 1)],
        # The P56 coronal atlas annotates one hemisphere; the app reflects it
        # about the midline so the section reads as a whole brain.
        "midline": round(x0, 1) if plate["orientation"] == "coronal" else None,
        "attribution": ATTRIBUTION,
        "structures": sorted(structures_out, key=lambda s: -s["a"]),
    }
    return document


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("fetching ontology")
    ontology = structures()
    by_acronym = {s["acronym"]: s for s in ontology.values()}

    manifest = {"attribution": ATTRIBUTION,
                "source": "Allen Brain Atlas API (atlas=1 coronal, atlas=2 sagittal)",
                "plates": []}
    for plate in PLATES:
        print(f"building {plate['id']}")
        document = build(plate, ontology, by_acronym)
        path = OUT / f"{plate['id']}.json"
        path.write_text(json.dumps(document, separators=(",", ":")))
        regions = sorted({s["region"] for s in document["structures"] if s["region"]})
        manifest["plates"].append({
            "id": plate["id"], "label": plate["label"], "note": plate["note"],
            "orientation": plate["orientation"], "section": plate["section"],
            "file": f"/atlas/{plate['id']}.json", "regions": regions,
        })
        print(f"  {len(document['structures'])} structures, {path.stat().st_size // 1024} KB, regions {regions}")

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {OUT}/manifest.json")


if __name__ == "__main__":
    main()
