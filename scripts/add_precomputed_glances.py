#!/usr/bin/env python3
"""Add glances for Neuroglancer precomputed volumes served over public HTTPS.

The companion to `add_glances.py`, for data this deployment does not host: the
image is someone else's public precomputed volume -- BossDB's microCT release
on S3 -- and the segmentation computed from it sits in a public GCS bucket of
our own. Neither needs `ngauth`, so a layer is `precomputed://s3://...` or
`precomputed://gs://...` and the browser reads it directly.

Datasets are discovered under `--image-root` and paired by name: dataset `X`
takes its image from `<image-root>/X/<image-dir>` and, when one exists, its
segmentation from `<seg-root>/X/<seg-dir>`. A dataset with no segmentation
published yet still gets an image-only glance, which is the honest state of it.

State is derived from each volume's own `info` -- resolution and grid differ
per dataset, and copying one glance's state onto a sibling would misscale it.
The camera is always left to Neuroglancer's auto-fit: these volumes range from
a 2 mm cortical block to a whole hemisphere, so no saved pose transfers.

Re-running is safe: a dataset whose image is already in the study is skipped.

Needs no credentials at all -- both buckets are read anonymously over their
public HTTPS endpoints -- but does need the app running, and the account's
password in the environment file.

Examples:
    scripts/add_precomputed_glances.py --study microct --account labb \\
        --image-root s3://bossdb-open-data/mittone2026 --image-dir microct \\
        --seg-root gs://example-bucket --seg-dir bvmask_hyst --dry-run
    scripts/add_precomputed_glances.py --study microct --account labb \\
        --image-root s3://bossdb-open-data/mittone2026 --image-dir microct \\
        --seg-root gs://example-bucket --seg-dir bvmask_hyst
"""

import argparse
import fnmatch
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import (  # noqa: E402  (path set above)
    DEFAULT_BASE, DEFAULT_ENV, DEFAULT_VIEWER, api, open_session, read_credentials, warn,
)

TIMEOUT = 60


# --- public object access ----------------------------------------------------

def split_uri(uri):
    """`s3://bucket/prefix` or `gs://bucket/prefix` -> (scheme, bucket, prefix)."""
    for scheme in ("s3", "gs"):
        head = f"{scheme}://"
        if uri.startswith(head):
            bucket, _, prefix = uri[len(head):].partition("/")
            if not bucket:
                raise SystemExit(f"{uri}: no bucket in the URI")
            return scheme, bucket, prefix.strip("/")
    raise SystemExit(f"{uri}: expected an s3:// or gs:// URI")


def https_url(uri, *tail):
    """The public HTTPS URL of an object, for reading it here.

    Neuroglancer resolves `s3://` and `gs://` itself, so the layer keeps the
    bucket URI; this is only how this script reads the `info` beside it.
    """
    scheme, bucket, prefix = split_uri(uri)
    key = "/".join(part for part in (prefix, *tail) if part)
    if scheme == "s3":
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    return f"https://storage.googleapis.com/{bucket}/{key}"


def fetch_json(url):
    """Parse a public JSON object, or return None when it is not there."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return None
        raise SystemExit(f"{url}: {error.code} {error.reason}")
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise SystemExit(f"{url}: {error}")


def list_directories(uri):
    """Immediate child directory names under a bucket prefix, read anonymously.

    Both buckets answer an unauthenticated listing; neither needs the
    `storage.objects.list` grant the app deliberately does without, because
    nothing here runs in the Worker.
    """
    scheme, bucket, prefix = split_uri(uri)
    prefix = f"{prefix}/" if prefix else ""
    if scheme == "s3":
        query = urllib.parse.urlencode(
            {"list-type": "2", "delimiter": "/", "prefix": prefix, "max-keys": "1000"})
        url = f"https://{bucket}.s3.amazonaws.com/?{query}"
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            tree = ElementTree.fromstring(response.read())
        namespace = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        found = [node.text for node in tree.findall("s3:CommonPrefixes/s3:Prefix", namespace)]
        if tree.findtext("s3:IsTruncated", "", namespace) == "true":
            warn(f"{uri}: listing truncated at 1000 entries; name datasets with --dataset")
    else:
        query = urllib.parse.urlencode({"delimiter": "/", "prefix": prefix, "maxResults": "1000"})
        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o?{query}"
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            payload = json.load(response)
        found = payload.get("prefixes", [])
        if payload.get("nextPageToken"):
            warn(f"{uri}: listing truncated at 1000 entries; name datasets with --dataset")
    return sorted(name[len(prefix):].rstrip("/") for name in found if name)


# --- state construction ------------------------------------------------------

def mip0(info, uri):
    """The finest scale of a precomputed `info`, as (size, resolution) in x,y,z."""
    try:
        scale = info["scales"][0]
    except (KeyError, IndexError):
        raise SystemExit(f"{uri}: precomputed info carries no scales")
    return scale["size"], scale["resolution"]


def check_alignment(image_uri, image_info, seg_uri, seg_info, tolerance=1e-6):
    """Image and segmentation must cover the same physical box.

    A segmentation is commonly published at a coarser mip than its image, so
    voxel counts differ legitimately; only the extent has to agree.
    """
    image_size, image_resolution = mip0(image_info, image_uri)
    seg_size, seg_resolution = mip0(seg_info, seg_uri)
    for axis, size, resolution, want_size, want_resolution in zip(
            "xyz", seg_size, seg_resolution, image_size, image_resolution):
        got, want = size * resolution, want_size * want_resolution
        if want and abs(got - want) / want > tolerance:
            warn(f"{seg_uri}: {axis} extent {got:.1f} nm != image {want:.1f} nm; "
                 f"layers may not register")


def build_state(image_uri, image_info, seg_uri, seg_info):
    size, resolution = mip0(image_info, image_uri)
    position = [value / 2 for value in size]
    position = [int(p) if p == int(p) else p for p in position]
    layers = [{
        "type": "image",
        "source": f"precomputed://{image_uri}",
        "tab": "source",
        "name": image_uri.rstrip("/").rsplit("/", 1)[-1],
    }]
    if seg_info is not None:
        layers.append({
            "type": "segmentation",
            "source": f"precomputed://{seg_uri}",
            "tab": "segments",
            "segments": [],
            "name": seg_uri.rstrip("/").rsplit("/", 1)[-1],
        })
    return {
        # precomputed `info` counts x, y, z; the state names them in that order.
        "dimensions": {axis: [value * 1e-9, "m"] for axis, value in zip("xyz", resolution)},
        "position": position,
        "layers": layers,
        "showSlices": False,
        "selectedLayer": {"visible": True, "layer": layers[-1]["name"]},
        "layout": "4panel-alt",
        "uiControlVisibility": {},
    }


def volume_uri(source):
    """The bucket URI a layer source names, without its data format or options.

    `precomputed://gs://bucket/path|options` is the same volume as
    `gs://bucket/path`, and the skip test has to see that.
    """
    uri = str(source).split("|", 1)[0].rstrip("/")
    _, separator, tail = uri.partition("://")
    if separator and "://" in tail:
        return tail
    return uri


def existing_images(study):
    """Image volumes already in the study, as bucket URIs."""
    present = set()
    for glance in study.get("glances", []):
        state = glance["state"]
        if isinstance(state, str):
            state = json.loads(state)
        for layer in state.get("layers", []):
            if layer.get("type") == "image" and layer.get("source"):
                present.add(volume_uri(layer["source"]))
    return present


# --- main --------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--study", required=True, help="study slug or id")
    parser.add_argument("--image-root", required=True, metavar="URI",
                        help="bucket prefix holding one directory per dataset, "
                             "e.g. s3://bossdb-open-data/mittone2026")
    parser.add_argument("--image-dir", default="", metavar="DIR",
                        help="image volume directory inside each dataset "
                             "(default: the dataset directory itself)")
    parser.add_argument("--seg-root", default="", metavar="URI",
                        help="bucket prefix holding the segmentations, if any")
    parser.add_argument("--seg-dir", default="", metavar="DIR",
                        help="segmentation volume directory inside each dataset")
    parser.add_argument("--dataset", action="append", default=[], metavar="NAME",
                        help="explicit dataset directory name (repeatable)")
    parser.add_argument("--match", default="*", help="glob over dataset names (default: *)")
    parser.add_argument("--base", default=DEFAULT_BASE, help="running app origin")
    parser.add_argument("--viewer", default=DEFAULT_VIEWER,
                        help="viewer origin; must be in PYTC_GLANCER_VIEWER_ORIGINS")
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a study belongs to "
                             "one account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be created, post nothing")
    args = parser.parse_args()

    if bool(args.seg_root) != bool(args.seg_dir):
        raise SystemExit("--seg-root and --seg-dir are given together, or neither")

    image_root = args.image_root.rstrip("/")
    seg_root = args.seg_root.rstrip("/")
    opener = open_session(args.base, read_credentials(args.env_file, args.account))

    try:
        study = api(opener, args.base, f"/api/studies/{urllib.parse.quote(args.study)}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"study {args.study!r}: {error.code} {error.read().decode()[:200]}")
    print(f"study: {study['title']} ({study['slug']}), "
          f"{len(study.get('glances', []))} existing glance(s)")

    names = args.dataset or [
        name for name in list_directories(image_root) if fnmatch.fnmatch(name, args.match)]
    if not names:
        print(f"no dataset directories under {image_root}")
        return

    present = existing_images(study)
    created = 0
    for name in names:
        image_uri = "/".join(part for part in (image_root, name, args.image_dir) if part)
        if image_uri in present:
            print(f"  = {name} already in study; skipped")
            continue
        image_info = fetch_json(https_url(image_uri, "info"))
        if image_info is None:
            warn(f"{name}: no readable precomputed info at {image_uri}; skipped")
            continue

        seg_uri, seg_info = "", None
        if seg_root:
            seg_uri = "/".join(part for part in (seg_root, name, args.seg_dir) if part)
            seg_info = fetch_json(https_url(seg_uri, "info"))
            if seg_info is None:
                print(f"  · {name}: no {args.seg_dir} published yet; image-only glance")
            else:
                check_alignment(image_uri, image_info, seg_uri, seg_info)

        state = build_state(image_uri, image_info, seg_uri, seg_info)
        size, resolution = mip0(image_info, image_uri)

        if args.dry_run:
            print(f"  + would create {name}")
            print(f"      image    {image_uri} ({image_info.get('data_type')})")
            print(f"      grid     {size} @ {resolution} nm (x,y,z) -> position {state['position']}")
            print(f"      seg      {seg_uri if seg_info is not None else 'none'}")
            continue

        url = args.viewer + "#!" + json.dumps(state, separators=(",", ":"))
        try:
            glance = api(opener, args.base, "/api/glances",
                         {"study_id": study["id"], "url": url, "title": name})
        except urllib.error.HTTPError as error:
            warn(f"{name}: {error.code} {error.read().decode()[:300]}")
            continue
        created += 1
        print(f"  + created pos={glance['position']}  {name}")
        print(f"      {glance['shareable_link']}")

    if not args.dry_run:
        print(f"created {created} glance(s)")


if __name__ == "__main__":
    main()
