#!/usr/bin/env python3
"""Put a second segmentation variant on a glance, as another layer tab.

The pipeline segments one volume more than once -- `mip1_eb2` and `mip1_eb8`
are two such runs under `lab/project` -- and reading one against the other is a
matter of carrying both on the same glance, as two Neuroglancer layer tabs over
the one image.

    scripts/add_seg_layer.py --variant mip1_eb8 --glance <short_key> --dry-run
    scripts/add_seg_layer.py --variant mip1_eb8 --glance <short_key>
    scripts/add_seg_layer.py --variant mip1_eb8 --study project-exp96

For each glance it takes the dataset from the image layer, looks for
`<variant>/<dataset>_seg*` beside the directories the glance already points at,
checks that the new segmentation covers the same physical box as the image, and
appends the layer through the running app's API.

The layer arrives unloaded, so a link already shared opens exactly as it did.
Tick it in *Saved state -> What to load*, or in Neuroglancer's own layer bar,
to draw it; `--visible` adds it loaded instead. Where the variant's directory
carries the same name as the segmentation already on the glance, the new layer
is suffixed with the variant, because Neuroglancer needs distinct layer names.

Re-running is safe: a glance already carrying the variant is reported and
skipped. Requires `gcloud` authenticated with read access to the bucket, and
the app running.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import (  # noqa: E402  (path set above)
    DEFAULT_BASE, DEFAULT_ENV, NotFound, api, check_alignment, list_prefix,
    open_session, read_credentials, read_image_metadata, warn,
)


def patch_glance(opener, base, key, state):
    """PATCH the stored state. `api` speaks GET and POST only."""
    request = urllib.request.Request(
        f"{base}/api/glances/{urllib.parse.quote(key)}", method="PATCH",
        data=json.dumps({"state": state}).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(opener.open(request))

SOURCE_RE = re.compile(r"^(?:zarr://)?gs\+ngauth\+(https://[^/\s|]+)/([^/]+)/(.+?)(?:\|[^|]*)?$")


def layer_source(layer):
    source = layer.get("source")
    if isinstance(source, list):
        source = source[0] if source else None
    if isinstance(source, dict):
        source = source.get("url")
    return source if isinstance(source, str) else None


def parsed_layers(state):
    """(layer, host, bucket, path) for every gs+ngauth layer in a state."""
    for layer in state.get("layers", []):
        match = SOURCE_RE.match((layer_source(layer) or "").strip())
        if match:
            host, bucket, path = match.groups()
            yield layer, host, bucket, path.rstrip("/")


def variant_roots(state, variant):
    """Where `<variant>/` would sit, judged from the paths the glance uses.

    A dataset's directories are siblings under one experiment prefix --
    `<exp>/image/<dataset>.zarr` beside `<exp>/<variant>/<dataset>_seg*` --
    so the variant root is each existing layer's grandparent plus the variant
    name. Candidates are tried in order and the first that lists wins, which
    keeps this working when only some of a glance's layers have moved.
    """
    roots = []
    for _, _, _, path in parsed_layers(state):
        parts = path.split("/")
        if len(parts) < 2:
            continue
        candidate = "/".join(parts[:-2] + [variant])
        if candidate not in roots:
            roots.append(candidate)
    return roots


def listing(uri):
    """Directory names under a prefix; an empty list when it does not exist.

    An expired credential reads as an empty bucket otherwise, and the caller
    would report the variant as missing rather than as unreadable.
    """
    try:
        return list_prefix(uri)
    except NotFound:
        return []
    except RuntimeError as error:
        if re.search(r"auth|credential|permission|denied", str(error), re.I):
            raise SystemExit(f"cannot list {uri}: {error}\nRun `gcloud auth login` and retry.")
        raise


def find_segmentation(bucket, roots, dataset, marker):
    """The variant's `<dataset><marker>*` directory, and the root holding it."""
    tried = []
    for root in roots:
        names = listing(f"gs://{bucket}/{root}")
        if not names:
            tried.append(root)
            continue
        found = sorted(n for n in names if n.startswith(dataset + marker) and not n.endswith(".zarr"))
        if not found:
            tried.append(f"{root} (no {dataset}{marker}*)")
            continue
        if len(found) > 1:
            raise RuntimeError(f"ambiguous segmentations under {root}: {found}; narrow with --seg-marker")
        return root, found[0]
    raise RuntimeError(f"no {dataset}{marker}* found; looked under {', '.join(tried) or '(nothing)'}")


def image_of(state):
    """(host, bucket, parent path, dataset) of the glance's image layer."""
    for layer, host, bucket, path in parsed_layers(state):
        if layer.get("type") == "image" and path.endswith(".zarr"):
            parent, leaf = path.rsplit("/", 1)
            return host, bucket, parent, leaf[: -len(".zarr")]
    raise RuntimeError("no gs+ngauth OME-Zarr image layer, so it names no dataset")


def unique_name(state, preferred, variant):
    taken = {layer.get("name") for layer in state.get("layers", [])}
    return preferred if preferred not in taken else f"{preferred}_{variant}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--variant", required=True, help="variant directory name, e.g. mip1_eb8")
    parser.add_argument("--glance", action="append", default=[], help="short_key (repeatable; default every glance of the chosen studies)")
    parser.add_argument("--study", action="append", default=[], help="slug or id (repeatable; default all)")
    parser.add_argument("--seg-marker", default="_seg", help="what a segmentation directory adds to the dataset name")
    parser.add_argument("--name", help="layer name to use instead of the directory's own")
    parser.add_argument("--visible", action="store_true", help="add the layer loaded rather than unloaded")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a glance belongs to "
                             "one account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    opener = open_session(args.base, read_credentials(args.env_file, args.account))
    slugs = args.study or [s["slug"] for s in api(opener, args.base, "/api/studies?include_archived=1")]
    wanted = set(args.glance)

    seen, changed = set(), 0
    for slug in slugs:
        study = api(opener, args.base, f"/api/studies/{urllib.parse.quote(slug)}?include_archived=1")
        glances = [g for g in study["glances"] if not wanted or g["short_key"] in wanted]
        if not glances:
            continue
        print(f"\nstudy: {study['title']}")
        for glance in glances:
            seen.add(glance["short_key"])
            title = glance["title"] or glance["short_key"]
            state = json.loads(glance["state"])
            try:
                host, bucket, image_parent, dataset = image_of(state)
                root, seg = find_segmentation(bucket, variant_roots(state, args.variant), dataset, args.seg_marker)
            except RuntimeError as error:
                warn(f"{title}: {error}; skipped")
                continue

            source = f"gs+ngauth+{host}/{bucket}/{root}/{seg}/|neuroglancer-precomputed:"
            if any(path == f"{root}/{seg}" for _, _, _, path in parsed_layers(state)):
                print(f"  = {title}: already carries {args.variant}/{seg}")
                continue

            try:
                scale, shape = read_image_metadata(f"gs://{bucket}/{image_parent}", dataset)
                check_alignment(f"gs://{bucket}/{root}", dataset, seg, scale, shape)
            except (RuntimeError, KeyError, ValueError) as error:
                warn(f"{title}: extent unverified ({error})")

            layer = {"type": "segmentation", "source": source, "tab": "segments", "segments": [],
                     "name": args.name or unique_name(state, seg, args.variant)}
            if not args.visible:
                layer["visible"] = False
            state["layers"] = state.get("layers", []) + [layer]
            print(f"  + {title}")
            print(f"      segmentation -> {root}/{seg}")
            print(f"      layer name    {layer['name']}{'' if args.visible else '  (unloaded)'}")
            if args.dry_run:
                changed += 1
                continue
            try:
                patch_glance(opener, args.base, glance["short_key"], state)
                changed += 1
            except urllib.error.HTTPError as error:
                warn(f"{title}: {error.code} {error.read().decode()[:200]}")

    for key in sorted(wanted - seen):
        warn(f"{key}: no such glance in the studies searched")
    print(f"\n{'would add' if args.dry_run else 'added'} {changed} layer(s)")


if __name__ == "__main__":
    main()
