#!/usr/bin/env python3
"""Add Neuroglancer glances to a pytc_glancer study from OME-Zarr volumes in GCS.

Discovers `<name>.zarr` images under a bucket prefix, pairs each with its
`<name>_seg_*` precomputed segmentation, derives the viewer state from the
volume's *own* OME-Zarr metadata, and posts it through the running app's API.

Images and segmentations live in sibling directories under one experiment
prefix -- `<prefix>/image/<name>.zarr` beside `<prefix>/mip1_eb2/<name>_seg_*`
-- so `--image-dir` and `--seg-dir` say where each is. A bucket that keeps both
in one directory is `--seg-dir` equal to `--image-dir`.

Deriving per-volume rather than copying an existing state matters: sibling
datasets in one study routinely differ in voxel size (the Exp99 cerebellum
set mixes 12.5/5.078 nm and 22.22/9.028 nm), and segmentation thresholds are
per-dataset (mt0600, mt0650, mt0590, mt0585 -- not a shared pattern).

Camera pose is copied from the study's first existing glance so a study looks
consistent. `crossSectionScale` and `projectionScale` are in canonical voxel
units, so this is only equivalent when volumes share XY voxel counts; the
script checks that and drops the camera (letting Neuroglancer auto-fit) when
they differ. Pass --no-camera to always auto-fit.

Re-running is safe: volumes already present in the study are skipped.

Requires `gcloud` authenticated with read access to the bucket, and the app
running locally. Path-based creation in the app needs GCS_SA_KEY; this script
does not, because it builds state itself and uses the URL-import route.

Examples:
    scripts/add_glances.py --prefix lab/project/exp99 --study project-exp99 \\
        --match 'Exp99_*cerebellum*'
    scripts/add_glances.py --prefix lab/project/exp99 --study project-exp99 \\
        --dataset Exp99_32x_1_cerebellum
    scripts/add_glances.py --prefix lab/project/exp96 --study project-exp96 \\
        --match 'Exp96_*' --dry-run
"""

import argparse
import fnmatch
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_IMAGE_DIR = "image"
DEFAULT_SEG_DIR = "mip1_eb2"
DEFAULT_BASE = "http://127.0.0.1:3100"
DEFAULT_VIEWER = "https://neuroglancer-demo.appspot.com"
DEFAULT_ENV = os.path.expanduser("~/.config/pytc_glancer/pytc_glancer.env")

CAMERA_KEYS = ("crossSectionScale", "projectionOrientation", "projectionScale")


def warn(message):
    print(f"  ! {message}", file=sys.stderr)


class NotFound(RuntimeError):
    """A GCS object does not exist."""


def gcloud(*args, timeout=180, binary=False):
    """Run a gcloud storage command. `binary` keeps bytes, for gzipped objects."""
    result = subprocess.run(
        ["gcloud", "storage", *args], capture_output=True, text=not binary, timeout=timeout
    )
    if result.returncode:
        stderr = result.stderr.decode("utf-8", "replace") if binary else result.stderr
        stderr = stderr.strip()
        if "matched no objects" in stderr:
            raise NotFound(args[-1])
        raise RuntimeError(f"gcloud storage {' '.join(args)}: {stderr}")
    return result.stdout


def cat_json(uri):
    return json.loads(gcloud("cat", uri))


# --- discovery ---------------------------------------------------------------

def list_prefix(root):
    names = []
    for line in gcloud("ls", root + "/").splitlines():
        line = line.strip().rstrip("/")
        if line and line != root:
            names.append(line.rsplit("/", 1)[-1])
    return names


def pair_datasets(image_names, seg_names, wanted, match, seg_marker):
    """Pair each `<name>.zarr` image with its unique `<name><seg_marker>*` segmentation."""
    images = [n[: -len(".zarr")] for n in image_names if n.endswith(".zarr")]
    directories = set(seg_names)
    selected = []
    for image in sorted(images):
        if wanted and image not in wanted:
            continue
        if not wanted and not fnmatch.fnmatch(image, match):
            continue
        segs = sorted(
            d for d in directories
            if d.startswith(image + seg_marker) and not d.endswith(".zarr")
        )
        if not segs:
            warn(f"{image}: no '{image}{seg_marker}*' segmentation found; skipped")
            continue
        if len(segs) > 1:
            warn(f"{image}: ambiguous segmentations {segs}; "
                 f"re-run with --dataset and one --seg-marker; skipped")
            continue
        selected.append((image, segs[0]))
    for name in sorted(wanted - {image for image, _ in selected}):
        warn(f"{name}: requested but no matching '{name}.zarr' in the bucket")
    return selected


# --- state construction ------------------------------------------------------

def read_image_metadata(root, image):
    try:
        attrs = cat_json(f"{root}/{image}.zarr/.zattrs")
    except NotFound:
        raise RuntimeError(
            f"no OME-Zarr metadata at {image}.zarr/.zattrs "
            f"(empty prefix, incomplete upload, or zarr v3)") from None
    multiscale = attrs["multiscales"][0]
    axes = [a["name"] for a in multiscale["axes"]]
    units = {a["name"]: a.get("unit") for a in multiscale["axes"]}
    if axes != ["z", "y", "x"]:
        raise RuntimeError(f"{image}: expected z,y,x axes, got {axes}")
    bad = {n: u for n, u in units.items() if u != "nanometer"}
    if bad:
        raise RuntimeError(f"{image}: expected nanometer units, got {bad}")
    scale = multiscale["datasets"][0]["coordinateTransformations"][0]["scale"]
    try:
        shape = cat_json(f"{root}/{image}.zarr/0/.zarray")["shape"]
    except NotFound:
        raise RuntimeError(f"{image}.zarr/0/.zarray is missing") from None
    return scale, shape


def check_alignment(seg_root, image, seg, scale, shape, tolerance=1e-6):
    """Image and segmentation must cover the same physical box.

    The segmentation commonly sits at a coarser mip than the image, so voxel
    counts differ; only the physical extent has to agree.
    """
    try:
        info = cat_json(f"{seg_root}/{seg}/info")
    except (NotFound, RuntimeError, ValueError) as error:
        warn(f"{seg}: could not read precomputed info ({error}); extent unverified")
        return
    level = info["scales"][0]
    # precomputed `info` is x,y,z; OME-Zarr here is z,y,x
    seg_extent = [s * r for s, r in zip(level["size"], level["resolution"])]
    image_extent = [n * s for n, s in zip(reversed(shape), reversed(scale))]
    for axis, got, want in zip("xyz", seg_extent, image_extent):
        if want and abs(got - want) / want > tolerance:
            warn(f"{seg}: {axis} extent {got:.1f} nm != image {want:.1f} nm; "
                 f"layers may not register")


def build_state(ngauth, bucket, image_prefix, seg_prefix, image, seg, scale, shape, camera):
    image_source = f"gs+ngauth+{ngauth}/{bucket}/{image_prefix}"
    seg_source = f"gs+ngauth+{ngauth}/{bucket}/{seg_prefix}"
    position = [s / 2 for s in shape]
    position = [int(p) if p == int(p) else p for p in position]
    state = {
        "dimensions": {n: [scale[i] * 1e-9, "m"] for i, n in enumerate("zyx")},
        "position": position,
    }
    state.update(camera)
    state.update({
        "layers": [
            {"type": "image", "source": f"{image_source}/{image}.zarr/|zarr2:",
             "tab": "source", "name": f"{image}.zarr"},
            {"type": "segmentation", "source": f"{seg_source}/{seg}/|neuroglancer-precomputed:",
             "tab": "segments", "segments": [], "name": seg},
        ],
        "showSlices": False,
        "selectedLayer": {"visible": True, "layer": seg},
        "layout": "4panel-alt",
        "uiControlVisibility": {},
    })
    return state


def image_dataset(state):
    """Bare dataset name of a state's image layer, or None."""
    for layer in state.get("layers", []):
        if layer.get("type") == "image":
            match = re.search(r"/([^/]+)\.zarr/", layer.get("source", ""))
            if match:
                return match.group(1)
    return None


def camera_from(study, image_root, use_camera):
    """Reuse the first existing glance's camera, plus its XY voxel counts.

    Returns (camera, reference_xy). The XY counts come from the reference
    volume's own metadata rather than from its `position`, because a
    hand-navigated glance is not parked at the volume centre. reference_xy is
    None when it cannot be determined, in which case the camera is copied
    unconditionally -- a study normally holds sibling volumes.
    """
    if not use_camera:
        return {}, None
    for glance in study.get("glances", []):
        state = glance["state"]
        if isinstance(state, str):
            state = json.loads(state)
        camera = {k: state[k] for k in CAMERA_KEYS if k in state}
        if not camera:
            continue
        reference = image_dataset(state)
        if not reference:
            return camera, None
        try:
            _, shape = read_image_metadata(image_root, reference)
        except Exception as error:
            warn(f"{reference}: cannot size the reference volume ({error}); "
                 f"copying its camera unchecked")
            return camera, None
        return camera, tuple(shape[1:3])
    return {}, None


# --- app session -------------------------------------------------------------

def read_credentials(path, account=""):
    """Sign-in credentials for one account, from the app's environment file.

    A study belongs to the account that created it, so which account a script
    signs in as decides which studies it can even see. Passwords live in
    `PYTC_GLANCER_ACCOUNTS`; `PYTC_GLANCER_PASSWORD` is the pre-account form and
    opens the default workspace. Naming no account means the first configured
    one, which is the workspace these scripts have always written to.

    Returns `(account_id, password)`. The id is sent with the sign-in because a
    deployment with several accounts cannot infer which workspace is meant.
    """
    accounts, password = [], ""
    try:
        with open(path) as handle:
            for line in handle:
                if line.startswith("PYTC_GLANCER_ACCOUNTS="):
                    try:
                        accounts = json.loads(line.split("=", 1)[1].strip())
                    except json.JSONDecodeError:
                        raise SystemExit(f"{path}: PYTC_GLANCER_ACCOUNTS is not valid JSON")
                elif line.startswith("PYTC_GLANCER_PASSWORD="):
                    password = line.split("=", 1)[1].strip()
    except FileNotFoundError:
        warn(f"{path} not found; assuming the app has no password set")
        return "", ""

    if account:
        for entry in accounts:
            if entry.get("id") == account:
                return account, entry.get("password", "")
        known = ", ".join(entry.get("id", "?") for entry in accounts) or "none"
        raise SystemExit(f"{path}: no account {account!r} in PYTC_GLANCER_ACCOUNTS (has: {known})")
    if accounts:
        return accounts[0].get("id", ""), accounts[0].get("password", "")
    return "", password


def open_session(base, credentials):
    """Sign in and return an opener carrying the session cookie."""
    account, password = credentials
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    if not password:
        return opener
    opener.open(urllib.request.Request(
        f"{base}/__login", method="POST",
        data=urllib.parse.urlencode(
            {"account": account, "password": password, "next": "/"}).encode()))
    if not any(c.name == "pytc_glancer_session" for c in jar):
        raise SystemExit(f"login as {account or 'the default account'} failed: "
                         f"check the password in the env file")
    return opener


def api(opener, base, path, payload=None):
    request = urllib.request.Request(
        f"{base}{path}",
        method="POST" if payload is not None else "GET",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"} if payload is not None else {})
    return json.load(opener.open(request))


def existing_images(study):
    """Image layer sources already in the study, as bare dataset names."""
    present = set()
    for glance in study.get("glances", []):
        state = glance["state"]
        if isinstance(state, str):
            state = json.loads(state)
        name = image_dataset(state)
        if name:
            present.add(name)
    return present


# --- main --------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--study", required=True, help="study slug or id")
    parser.add_argument("--dataset", action="append", default=[], metavar="NAME",
                        help="explicit image name, without .zarr (repeatable)")
    parser.add_argument("--match", default="*", help="glob over image names (default: *)")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", required=True,
                        help="experiment prefix in the bucket, e.g. lab/project/exp96")
    parser.add_argument("--image-dir", default=DEFAULT_IMAGE_DIR, metavar="DIR",
                        help=f"images directory under the prefix "
                             f"(default: {DEFAULT_IMAGE_DIR}; '' for the prefix itself)")
    parser.add_argument("--seg-dir", default=DEFAULT_SEG_DIR, metavar="DIR",
                        help=f"segmentations directory under the prefix "
                             f"(default: {DEFAULT_SEG_DIR})")
    parser.add_argument("--seg-marker", default="_seg_",
                        help="separator between image name and segmentation suffix")
    parser.add_argument("--ngauth", required=True, help="ngauth broker origin for the bucket")
    parser.add_argument("--base", default=DEFAULT_BASE, help="running app origin")
    parser.add_argument("--viewer", default=DEFAULT_VIEWER,
                        help="viewer origin; must be in PYTC_GLANCER_VIEWER_ORIGINS")
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a study belongs to "
                             "one account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--no-camera", action="store_true",
                        help="always let Neuroglancer auto-fit")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be created, post nothing")
    args = parser.parse_args()

    image_prefix = "/".join(p for p in (args.prefix, args.image_dir) if p)
    seg_prefix = "/".join(p for p in (args.prefix, args.seg_dir) if p)
    image_root = f"gs://{args.bucket}/{image_prefix}"
    seg_root = f"gs://{args.bucket}/{seg_prefix}"
    opener = open_session(args.base, read_credentials(args.env_file, args.account))

    try:
        study = api(opener, args.base, f"/api/studies/{urllib.parse.quote(args.study)}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"study {args.study!r}: {error.code} {error.read().decode()[:200]}")

    print(f"study: {study['title']} ({study['slug']}), "
          f"{len(study.get('glances', []))} existing glance(s)")

    image_names = list_prefix(image_root)
    seg_names = image_names if seg_prefix == image_prefix else list_prefix(seg_root)
    pairs = pair_datasets(image_names, seg_names, set(args.dataset),
                          args.match, args.seg_marker)
    present = existing_images(study)
    pending = [(i, s) for i, s in pairs if i not in present]
    for image, _ in pairs:
        if image in present:
            print(f"  = {image} already in study; skipped")
    if not pending:
        print("nothing to add")
        return

    camera, reference_xy = camera_from(study, image_root, not args.no_camera)
    created = 0
    for image, seg in pending:
        try:
            scale, shape = read_image_metadata(image_root, image)
        except Exception as error:
            warn(f"{image}: {error}; skipped")
            continue
        check_alignment(seg_root, image, seg, scale, shape)

        this_camera = camera
        if camera and reference_xy and tuple(shape[1:3]) != reference_xy:
            warn(f"{image}: XY {tuple(shape[1:3])} differs from the study's "
                 f"{reference_xy}; auto-fitting instead of copying the camera")
            this_camera = {}

        state = build_state(args.ngauth, args.bucket, image_prefix, seg_prefix,
                            image, seg, scale, shape, this_camera)
        title = image.split("_", 1)[1] if "_" in image else image

        if args.dry_run:
            print(f"  + would create {title}")
            print(f"      dims     {[round(scale[i], 6) for i in range(3)]} nm (z,y,x)")
            print(f"      shape    {shape} -> position {state['position']}")
            print(f"      seg      {seg}")
            print(f"      camera   {'copied' if this_camera else 'auto-fit'}")
            continue

        url = args.viewer + "#!" + json.dumps(state, separators=(",", ":"))
        try:
            glance = api(opener, args.base, "/api/glances",
                         {"study_id": study["id"], "url": url, "title": title})
        except urllib.error.HTTPError as error:
            warn(f"{title}: {error.code} {error.read().decode()[:300]}")
            continue
        created += 1
        print(f"  + created pos={glance['position']}  {title}")
        print(f"      {glance['shareable_link']}")

    if not args.dry_run:
        print(f"created {created} glance(s)")


if __name__ == "__main__":
    main()
