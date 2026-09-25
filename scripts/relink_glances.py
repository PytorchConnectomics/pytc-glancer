#!/usr/bin/env python3
"""Repoint glance layers after a bucket reorganisation.

Finds each layer's dataset directory wherever it now lives under a search root,
verifies the new location actually resolves, and patches the glance state
through the running app's API.

Matching is by directory leaf name, not by rewriting a known prefix, so this
survives a reorg whose shape nobody predicted. A move from

    lab/project/clip_percentile_1_99/<dataset>.zarr
    lab/project/clip_percentile_1_99/<dataset>_seg_abiss_*

to

    lab/project/<exp>/image/<dataset>.zarr
    lab/project/<exp>/mip1_eb2/<dataset>_seg_abiss_*

and needed no rules here beyond `--prefer mip1_eb2`, which breaks ties when a
dataset name appears under several variant folders.

Only `gs+ngauth+` layers in the named bucket are touched; layers pointing at
another bucket or scheme are left alone.

    scripts/relink_glances.py --bucket my-bucket --search-root lab/project --dry-run
    scripts/relink_glances.py --bucket my-bucket --search-root lab/project --study project-exp99 --prefer mip1_eb2
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import open_session, read_credentials  # noqa: E402  (path set above)

DEFAULT_BASE = "http://127.0.0.1:3100"
DEFAULT_ENV = os.path.expanduser("~/.config/pytc_glancer/pytc_glancer.env")
SOURCE_RE = re.compile(r"^(zarr://)?gs\+ngauth\+(https://[^/\s|]+)/([^/]+)/(.+?)(\|[^|]*)?$")


def warn(message):
    print(f"  ! {message}", file=sys.stderr)


def gcloud(*args, timeout=300):
    result = subprocess.run(["gcloud", "storage", *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        stderr = result.stderr.strip()
        if "matched no objects" in stderr:
            return ""
        raise RuntimeError(f"gcloud storage {' '.join(args)}: {stderr}")
    return result.stdout


def list_dirs(bucket, prefix):
    out = gcloud("ls", f"gs://{bucket}/{prefix}/")
    return [line.strip().rstrip("/").split(f"gs://{bucket}/", 1)[-1]
            for line in out.splitlines() if line.strip().endswith("/")]


def index_datasets(bucket, root, depth):
    """Map every directory leaf name under root to the paths that carry it."""
    index, frontier = {}, [root]
    for _ in range(depth):
        nxt = []
        for prefix in frontier:
            for path in list_dirs(bucket, prefix):
                index.setdefault(path.rsplit("/", 1)[-1], []).append(path)
                nxt.append(path)
        frontier = nxt
    return index


def resolve(leaf, index, prefer):
    candidates = index.get(leaf, [])
    if len(candidates) > 1 and prefer:
        narrowed = [c for c in candidates if any(p in c for p in prefer)]
        if narrowed:
            candidates = narrowed
    return candidates


# --- verification ------------------------------------------------------------

def cat_json(bucket, path):
    raw = gcloud("cat", f"gs://{bucket}/{path}")
    return json.loads(raw) if raw else None


def image_extent(bucket, path):
    attrs = cat_json(bucket, f"{path}/.zattrs")
    if not attrs:
        raise RuntimeError(f"{path}/.zattrs is missing")
    ms = attrs["multiscales"][0]
    axes = [a["name"] for a in ms["axes"]]
    scale = ms["datasets"][0]["coordinateTransformations"][0]["scale"]
    shape = (cat_json(bucket, f"{path}/0/.zarray") or {}).get("shape")
    if not shape:
        raise RuntimeError(f"{path}/0/.zarray is missing")
    order = {name: i for i, name in enumerate(axes)}
    return {a: shape[order[a]] * scale[order[a]] for a in "zyx"}


def seg_extent(bucket, path):
    info = cat_json(bucket, f"{path}/info")
    if not info:
        raise RuntimeError(f"{path}/info is missing")
    level = info["scales"][0]
    return dict(zip("xyz", (s * r for s, r in zip(level["size"], level["resolution"]))))


def check_pair(bucket, image_path, seg_path, tolerance=1e-6):
    try:
        image, seg = image_extent(bucket, image_path), seg_extent(bucket, seg_path)
    except Exception as error:
        warn(f"extent unverified: {error}")
        return
    for axis in "xyz":
        want, got = image[axis], seg[axis]
        if want and abs(got - want) / want > tolerance:
            warn(f"{axis} extent {got:.1f} nm in segmentation vs {want:.1f} nm in image; "
                 f"layers may not register")


# --- app session -------------------------------------------------------------

def api(opener, base, path, payload=None, method=None):
    request = urllib.request.Request(
        f"{base}{path}", method=method or ("POST" if payload is not None else "GET"),
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"} if payload is not None else {})
    return json.load(opener.open(request))


# --- main --------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--study", action="append", default=[], help="slug or id (repeatable; default all)")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--search-root", required=True)
    parser.add_argument("--depth", type=int, default=3)
    parser.add_argument("--prefer", action="append", default=[], help="substring preferred when a name is ambiguous")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a glance belongs to "
                             "one account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    opener = open_session(args.base, read_credentials(args.env_file, args.account))
    slugs = args.study or [s["slug"] for s in api(opener, args.base, "/api/studies?include_archived=1")]

    print(f"indexing gs://{args.bucket}/{args.search_root} (depth {args.depth})…")
    index = index_datasets(args.bucket, args.search_root, args.depth)
    print(f"  {len(index)} directory names")

    changed = 0
    for slug in slugs:
        study = api(opener, args.base, f"/api/studies/{urllib.parse.quote(slug)}?include_archived=1")
        print(f"\nstudy: {study['title']}")
        for glance in study["glances"]:
            state = json.loads(glance["state"])
            title = glance["title"] or glance["short_key"]
            rewrites, paths, skip = {}, {}, False
            for layer in state.get("layers", []):
                raw = layer.get("source")
                raw = raw if isinstance(raw, str) else (raw or {}).get("url")
                match = SOURCE_RE.match(raw or "")
                if not match or match.group(3) != args.bucket:
                    continue
                scheme, host, _, path, suffix = match.groups()
                path = path.rstrip("/")
                leaf = path.rsplit("/", 1)[-1]
                found = resolve(leaf, index, args.prefer)
                if not found:
                    warn(f"{title}: {leaf} not found under {args.search_root}; glance skipped")
                    skip = True
                    break
                if len(found) > 1:
                    warn(f"{title}: {leaf} is ambiguous {found}; use --prefer; glance skipped")
                    skip = True
                    break
                if found[0] == path:
                    continue
                rewrites[id(layer)] = f"{scheme or ''}gs+ngauth+{host}/{args.bucket}/{found[0]}/{suffix or ''}"
                paths[layer.get("type")] = found[0]
            if skip or not rewrites:
                if not skip:
                    print(f"  = {title}: already current")
                continue

            if "image" in paths and "segmentation" in paths:
                check_pair(args.bucket, paths["image"], paths["segmentation"])

            for layer in state.get("layers", []):
                if id(layer) in rewrites:
                    layer["source"] = rewrites[id(layer)]
            print(f"  + {title}")
            for kind, path in paths.items():
                print(f"      {kind:13} -> {path}")
            if args.dry_run:
                changed += 1
                continue
            try:
                api(opener, args.base, f"/api/glances/{glance['short_key']}", {"state": state}, method="PATCH")
                changed += 1
            except urllib.error.HTTPError as error:
                warn(f"{title}: {error.code} {error.read().decode()[:200]}")

    print(f"\n{'would update' if args.dry_run else 'updated'} {changed} glance(s)")


if __name__ == "__main__":
    main()
