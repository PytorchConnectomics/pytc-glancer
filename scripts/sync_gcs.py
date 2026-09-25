#!/usr/bin/env python3
"""Check GCS for new image volumes and segmentations, and update the studies.

The pipeline publishes into the bucket on its own schedule: an experiment gains
an image volume, a segmentation variant is recomputed, a dataset that had no
segmentation finally gets one. pytc_glancer learns none of this by itself, and
noticing by hand means listing every experiment prefix and reading it against
every study. This walks the bucket, compares it with what the app holds, and
closes the gap:

  * an experiment prefix with no study            -> study created
  * an image and segmentation with no glance      -> glance created
  * a segmentation variant missing from a glance  -> layer added, unloaded
  * an image whose segmentation is not published  -> reported, picked up later
  * a volume that has left the bucket             -> reported, never deleted

Nothing is deleted or repointed here: `relink_glances.py` owns moves and a
person owns removals. This only ever adds, so an unattended run cannot lose
work, and a link already shared keeps opening as it did -- a segmentation
arriving later is added as an unloaded layer.

The local record (default ~/.config/pytc_glancer/gcs_sync.json) is what makes a
scheduled run readable: it holds the inventory the previous run saw, so this
one reports what is *new* rather than listing the bucket again, and it keeps a
short history of what each run did. It is a record, not an authority -- what
the app holds is always re-read from the app, so losing the record costs the
history and duplicates nothing.

Examples:
    scripts/sync_gcs.py --dry-run                  # what has changed
    scripts/sync_gcs.py                            # bring the studies up to date
    scripts/sync_gcs.py --experiment exp107      # one experiment
    scripts/sync_gcs.py --quiet                    # silent unless something changed

    (each also takes the required --bucket, --root, and --ngauth)

Requires `gcloud` authenticated with read access to the bucket, and the app
running with the account's password readable in the environment file.
"""

import argparse
import fnmatch
import json
import os
import re
import sys
import urllib.error
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import (  # noqa: E402  (path set above)
    DEFAULT_BASE, DEFAULT_ENV, DEFAULT_IMAGE_DIR,
    DEFAULT_VIEWER, NotFound, api, build_state, camera_from, check_alignment, gcloud,
    image_dataset, open_session, read_credentials, read_image_metadata, warn,
)
from add_seg_layer import parsed_layers, patch_glance, unique_name  # noqa: E402

DEFAULT_TITLE = "project {experiment}"
DEFAULT_RECORD = os.path.expanduser("~/.config/pytc_glancer/gcs_sync.json")
DEFAULT_MARKER = "_seg"
DEFAULT_PREFER = "mip1_eb2"
ROOT_DIR = "."          # segmentations sitting directly under the experiment
RUN_HISTORY = 50
LIST_LIMIT = 8          # names printed before a summary line takes over


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(title):
    """The app's own slug rule, mirrored so a study can be looked up before it exists."""
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", title.lower()))


# A variant is keyed `<directory>` or `<directory>:<suffix>`; see group_segmentations.
def variant_dir(variant):
    return variant.split(":", 1)[0]


def variant_label(variant):
    return "(root)" + variant[1:] if variant_dir(variant) == ROOT_DIR else variant


def variant_tag(variant):
    """A layer-name suffix, for the rare glance that needs one."""
    return variant.replace(ROOT_DIR, "root", 1).replace(":", "_").strip("_")


def prefix_of(experiment_prefix, variant):
    directory = variant_dir(variant)
    return experiment_prefix if directory == ROOT_DIR else f"{experiment_prefix}/{directory}"


def report(label, items):
    if not items:
        return
    shown = sorted(items)[:LIST_LIMIT]
    rest = len(items) - len(shown)
    print(f"{label}: {', '.join(shown)}" + (f", and {rest} more" if rest else ""))


# --- bucket scan -------------------------------------------------------------

def list_dirs(uri):
    """Directory names directly under a prefix, files excluded.

    Directories only, because a bucket keeps loose files beside them --
    `exp108/seg` holds `*_seg_abiss_*.h5` and nothing else -- and a file is
    never a volume. An unreadable prefix is fatal rather than empty: an expired
    credential otherwise reads as a bucket that lost its contents, and
    reporting what is new is this script's whole job.
    """
    try:
        out = gcloud("ls", uri.rstrip("/") + "/")
    except NotFound:
        return []
    except RuntimeError as error:
        if re.search(r"auth|credential|permission|denied", str(error), re.I):
            raise SystemExit(f"cannot list {uri}: {error}\nRun `gcloud auth login` and retry.")
        raise
    names = []
    for line in out.splitlines():
        line = line.strip()
        if line.endswith("/"):
            leaf = line.rstrip("/").rsplit("/", 1)[-1]
            if leaf:
                names.append(leaf)
    return names


def group_segmentations(dataset, directory, names):
    """Variant keys for the `<dataset><marker>*` directories in one place.

    The pipeline publishes derived segmentations beside the one they came from
    -- `..._seg_abiss_mt0600` and `..._seg_abiss_mt0600_nogt_adapted_strict`
    share a directory -- and neither replaces the other. When every candidate
    extends the shortest, that shortest one is the directory's segmentation and
    each longer one becomes a variant of its own, keyed `<directory>:<suffix>`,
    so a glance can carry both as separate layers. Names that merely collide
    are left alone: choosing between them is a person's call, not a scheduled
    run's.
    """
    ordered = sorted(names, key=lambda name: (len(name), name))
    base = ordered[0]
    if not all(name.startswith(base) for name in ordered):
        warn(f"{dataset}: unrelated segmentations {ordered} under "
             f"{variant_label(directory)}; all ignored")
        return {}
    keyed = {directory: base}
    for name in ordered[1:]:
        keyed[f"{directory}:{name[len(base):].strip('_')}"] = name
    return keyed


def scan_experiment(bucket, prefix, image_dir, marker):
    """What one experiment prefix carries: image volumes and segmentations.

    Layouts differ between experiments and none of them is wrong. exp96 and
    exp99 keep images under `image/` and segmentations under `mip1_eb2/` and
    its siblings; exp108 adds one segmentation directly under the experiment
    prefix; exp71 keeps every segmentation there. So the images directory is
    used when it exists, the experiment prefix itself counts as a variant, and
    every other directory under it is a candidate variant.

    Returns (image_prefix, images, segmentations), the last mapping a dataset
    name to {variant key: segmentation directory name}.
    """
    children = list_dirs(f"gs://{bucket}/{prefix}")
    image_prefix = f"{prefix}/{image_dir}" if image_dir and image_dir in children else prefix
    listing = children if image_prefix == prefix else list_dirs(f"gs://{bucket}/{image_prefix}")
    images = sorted(name[: -len(".zarr")] for name in listing if name.endswith(".zarr"))

    places = {ROOT_DIR: children}
    for child in children:
        # A segmentation directory is not a variant directory, and neither is a
        # volume; either would otherwise cost a listing of its own.
        if child == image_dir or child.endswith(".zarr") or marker in child:
            continue
        places[child] = list_dirs(f"gs://{bucket}/{prefix}/{child}")

    candidates = {}
    for directory, names in places.items():
        for name in names:
            if marker not in name or name.endswith(".zarr"):
                continue
            dataset = name.split(marker, 1)[0]
            candidates.setdefault(dataset, {}).setdefault(directory, []).append(name)

    segmentations = {}
    for dataset, by_directory in candidates.items():
        for directory, names in by_directory.items():
            segmentations.setdefault(dataset, {}).update(
                group_segmentations(dataset, directory, names))
        if not segmentations.get(dataset):
            segmentations.pop(dataset, None)
    return image_prefix, images, segmentations


def choose_primary(by_variant, prefer):
    """Which variant supplies a new glance's first segmentation layer.

    The preference list decides, so one variant leads across a study. Failing
    that a lone variant is unambiguous; anything else is a choice this script
    should not make silently.
    """
    for wanted in prefer:
        if wanted in by_variant:
            return wanted
    if len(by_variant) == 1:
        return next(iter(by_variant))
    return None


# --- local record ------------------------------------------------------------

def load_record(path):
    try:
        with open(path) as handle:
            record = json.load(handle)
    except FileNotFoundError:
        return {"version": 1, "scopes": {}}
    except (OSError, ValueError) as error:
        raise SystemExit(f"{path}: unreadable record ({error}); move it aside to start fresh")
    record.setdefault("scopes", {})
    return record


def save_record(path, record):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temporary = f"{path}.tmp"
    with open(temporary, "w") as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)     # an interrupted run leaves the old record intact


def scope_of(record, bucket, root):
    """Per bucket-and-root state, so one file can follow several buckets."""
    scope = record["scopes"].setdefault(f"{bucket}/{root}".rstrip("/"),
                                        {"datasets": {}, "runs": []})
    scope.setdefault("datasets", {})
    scope.setdefault("runs", [])
    return scope


# --- app side ----------------------------------------------------------------

def study_for(opener, base, studies, title, slug, create, dry_run, summary):
    """The study for one experiment, created when it is missing and wanted."""
    if slug in studies:
        return studies[slug]
    if not create:
        return None
    if dry_run:
        # A study that does not exist yet still has to stand in for one, or the
        # preview would stop here and never say which glances would follow.
        print(f"  + would create study {slug} ({title})")
        summary["studies"] += 1
        return {"id": None, "slug": slug, "title": title, "archived_at": None, "glances": []}
    try:
        study = api(opener, base, "/api/studies", {"title": title})
    except urllib.error.HTTPError as error:
        warn(f"study {slug}: {error.code} {error.read().decode()[:200]}")
        return None
    if study["slug"] != slug:
        # The app resolves slug collisions itself; follow what it allocated
        # rather than the name predicted here.
        warn(f"study created as {study['slug']}, not the expected {slug}")
    studies[study["slug"]] = study
    summary["studies"] += 1
    print(f"  + created study {study['slug']} ({title})")
    return study


def glances_by_dataset(study):
    """Dataset name -> (glance, state), for the glances that name a dataset."""
    found = {}
    for glance in study.get("glances", []):
        state = glance["state"]
        if isinstance(state, str):
            state = json.loads(state)
        name = image_dataset(state)
        if name:
            found[name] = (glance, state)
    return found


def layer_paths(state):
    return {path for _, _, _, path in parsed_layers(state)}


def ngauth_of(state, fallback):
    """The host a glance already authenticates through, so a new layer matches it."""
    for _, host, _, _ in parsed_layers(state):
        return host
    return fallback


def seg_layer(ngauth, bucket, path, seg, state, variant):
    """An unloaded segmentation layer: shared links open exactly as they did."""
    return {"type": "segmentation",
            "source": f"gs+ngauth+{ngauth}/{bucket}/{path}/{seg}/|neuroglancer-precomputed:",
            "tab": "segments", "segments": [],
            "name": unique_name(state, seg, variant_tag(variant)),
            "visible": False}


# --- main --------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--root", required=True,
                        help="prefix holding the experiment directories")
    parser.add_argument("--experiment", action="append", default=[], metavar="NAME",
                        help="experiment directory to check (repeatable; default: all)")
    parser.add_argument("--match", default="*", help="glob over experiment names (default: *)")
    parser.add_argument("--dataset", action="append", default=[], metavar="NAME",
                        help="restrict to these datasets (repeatable)")
    parser.add_argument("--image-dir", default=DEFAULT_IMAGE_DIR, metavar="DIR",
                        help=f"images directory inside an experiment (default: "
                             f"{DEFAULT_IMAGE_DIR}; the experiment prefix itself when absent)")
    parser.add_argument("--seg-marker", default=DEFAULT_MARKER,
                        help=f"what a segmentation directory adds to the dataset name "
                             f"(default: {DEFAULT_MARKER})")
    parser.add_argument("--prefer", action="append", default=[], metavar="VARIANT",
                        help=f"variant for a new glance's first segmentation, in order "
                             f"(default: {DEFAULT_PREFER})")
    parser.add_argument("--no-extra-layers", action="store_true",
                        help="carry only the preferred variant, not the others")
    parser.add_argument("--no-create-studies", action="store_true",
                        help="leave an experiment alone when it has no study yet")
    parser.add_argument("--study-title", default=DEFAULT_TITLE, metavar="TEMPLATE",
                        help=f"title for a created study; {{experiment}} is substituted "
                             f"(default: {DEFAULT_TITLE!r})")
    parser.add_argument("--ngauth", required=True, help="ngauth broker origin for the bucket")
    parser.add_argument("--viewer", default=DEFAULT_VIEWER,
                        help="viewer origin; must be in PYTC_GLANCER_VIEWER_ORIGINS")
    parser.add_argument("--base", default=DEFAULT_BASE, help="running app origin")
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a study belongs to one "
                             "account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--record", default=DEFAULT_RECORD, metavar="PATH",
                        help=f"local record of what the bucket held (default: {DEFAULT_RECORD})")
    parser.add_argument("--no-record", action="store_true", help="read and write no record")
    parser.add_argument("--no-camera", action="store_true",
                        help="always let Neuroglancer auto-fit new glances")
    parser.add_argument("--quiet", action="store_true",
                        help="print only changes; say nothing when there are none")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change, write nothing")
    return parser.parse_args()


def add_layers(opener, args, dataset, glance, state, image_prefix, prefix,
               by_variant, summary):
    """Put the variants the bucket now carries onto a glance that exists."""
    present = layer_paths(state)
    host = ngauth_of(state, args.ngauth)
    added, carried = [], []
    for variant in sorted(by_variant):
        seg = by_variant[variant]
        path = prefix_of(prefix, variant)
        if f"{path}/{seg}" in present:
            carried.append(variant)
            continue
        try:
            scale, shape = read_image_metadata(f"gs://{args.bucket}/{image_prefix}", dataset)
            check_alignment(f"gs://{args.bucket}/{path}", dataset, seg, scale, shape)
        except (RuntimeError, KeyError, ValueError) as error:
            warn(f"{dataset}: extent unverified ({error})")
        state["layers"] = state.get("layers", []) + [
            seg_layer(host, args.bucket, path, seg, state, variant)]
        added.append(variant)
    if not added:
        return carried
    print(f"  + {dataset}: {len(added)} layer(s) -> "
          f"{', '.join(f'{variant_label(v)}/{by_variant[v]}' for v in added)}")
    summary["layers"] += len(added)
    if args.dry_run:
        return carried + added
    try:
        patch_glance(opener, args.base, glance["short_key"], state)
    except urllib.error.HTTPError as error:
        warn(f"{dataset}: {error.code} {error.read().decode()[:200]}")
        summary["layers"] -= len(added)
        return carried
    return carried + added


def create_glance(opener, args, full, dataset, image_prefix, prefix, by_variant,
                  camera, reference_xy, summary):
    """Create the glance for a dataset the study does not carry yet."""
    primary = choose_primary(by_variant, args.prefer or [DEFAULT_PREFER])
    if not primary:
        warn(f"{dataset}: segmentations under "
             f"{sorted(variant_label(v) for v in by_variant)}; name one with --prefer; skipped")
        return None, []
    try:
        scale, shape = read_image_metadata(f"gs://{args.bucket}/{image_prefix}", dataset)
    except Exception as error:
        warn(f"{dataset}: {error}; skipped")
        return None, []
    primary_prefix = prefix_of(prefix, primary)
    check_alignment(f"gs://{args.bucket}/{primary_prefix}", dataset,
                    by_variant[primary], scale, shape)

    if camera and reference_xy and tuple(shape[1:3]) != reference_xy:
        warn(f"{dataset}: XY {tuple(shape[1:3])} differs from the study's {reference_xy}; "
             f"auto-fitting instead of copying the camera")
        camera = {}
    state = build_state(args.ngauth, args.bucket, image_prefix, primary_prefix,
                        dataset, by_variant[primary], scale, shape, camera)
    carried = [primary]
    if not args.no_extra_layers:
        for variant in sorted(set(by_variant) - {primary}):
            seg, path = by_variant[variant], prefix_of(prefix, variant)
            check_alignment(f"gs://{args.bucket}/{path}", dataset, seg, scale, shape)
            state["layers"].append(
                seg_layer(args.ngauth, args.bucket, path, seg, state, variant))
            carried.append(variant)

    print(f"  + {dataset}: glance carrying {', '.join(map(variant_label, carried))}")
    summary["glances"] += 1
    if args.dry_run:
        return None, carried
    url = args.viewer + "#!" + json.dumps(state, separators=(",", ":"))
    try:
        created = api(opener, args.base, "/api/glances",
                      {"study_id": full["id"], "url": url,
                       "title": dataset.split("_", 1)[1] if "_" in dataset else dataset})
    except urllib.error.HTTPError as error:
        warn(f"{dataset}: {error.code} {error.read().decode()[:300]}")
        summary["glances"] -= 1
        return None, []
    print(f"      {created['shareable_link']}")
    return created["short_key"], carried


def main():
    args = parse_args()
    wanted_datasets = set(args.dataset)
    started = now_iso()
    record = {"version": 1, "scopes": {}} if args.no_record else load_record(args.record)
    scope = scope_of(record, args.bucket, args.root)
    known = scope["datasets"]
    last_run = scope["runs"][-1]["at"] if scope["runs"] else None

    opener = open_session(args.base, read_credentials(args.env_file, args.account))
    studies = {s["slug"]: s for s in api(opener, args.base, "/api/studies?include_archived=1")}

    def say(*text):
        if not args.quiet:
            print(*text)

    say(f"checking gs://{args.bucket}/{args.root} against {len(studies)} study(ies)"
        + (f"; last checked {last_run}" if last_run else "; no previous record"))

    experiments = args.experiment or [
        name for name in sorted(list_dirs(f"gs://{args.bucket}/{args.root}"))
        if fnmatch.fnmatch(name, args.match)]

    summary = {"studies": 0, "glances": 0, "layers": 0}
    seen_keys, new_images, new_segs, waiting, orphans = set(), [], [], [], []

    for experiment in experiments:
        prefix = f"{args.root}/{experiment}".strip("/")
        image_prefix, images, segmentations = scan_experiment(
            args.bucket, prefix, args.image_dir, args.seg_marker)
        datasets = sorted(set(images) | set(segmentations))
        if wanted_datasets:
            datasets = [name for name in datasets if name in wanted_datasets]
        if not datasets:
            say(f"\n{experiment}: nothing under {prefix}")
            continue

        # Record first, act second: what the bucket gained is worth reporting
        # even where the app cannot be brought up to date for it yet.
        actionable = []
        for dataset in datasets:
            key = f"{experiment}/{dataset}"
            seen_keys.add(key)
            entry = known.setdefault(key, {"first_seen": started})
            entry.pop("missing_since", None)
            entry["last_seen"] = started
            entry["experiment"] = experiment
            has_image = dataset in images
            entry["image"] = f"{image_prefix}/{dataset}.zarr" if has_image else None
            by_variant = segmentations.get(dataset, {})
            before = entry.get("segmentations") or {}
            entry["segmentations"] = {variant: f"{prefix_of(prefix, variant)}/{seg}"
                                      for variant, seg in by_variant.items()}

            # A new image volume is one line, not one per segmentation it
            # arrived with; a segmentation is news when its dataset was already
            # known, or when no image has been published for it.
            brand_new = entry["first_seen"] == started
            if has_image and brand_new:
                new_images.append(key)
            for variant in sorted(set(entry["segmentations"]) - set(before)):
                if not (brand_new and has_image):
                    new_segs.append(f"{key} [{variant_label(variant)}]")

            if not has_image:
                orphans.append(key)
            elif not by_variant:
                waiting.append(key)
            else:
                actionable.append((dataset, by_variant))

        say(f"\n{experiment}: {len(images)} image volume(s), {len(actionable)} segmented")
        title = args.study_title.format(experiment=experiment)
        slug = slugify(title)
        study = study_for(opener, args.base, studies, title, slug,
                          not args.no_create_studies and bool(actionable),
                          args.dry_run, summary)
        if not study:
            if actionable:
                say(f"  = no study {slug}; {len(actionable)} dataset(s) left alone")
            continue
        if study.get("archived_at"):
            warn(f"{experiment}: study {slug} is archived; unarchive it to add glances")
            continue

        full = study if study["id"] is None else api(
            opener, args.base,
            f"/api/studies/{urllib.parse.quote(study['slug'])}?include_archived=1")
        existing = glances_by_dataset(full)
        say(f"  study {full['slug']}: {len(existing)} glance(s)")
        camera, reference_xy = camera_from(full, f"gs://{args.bucket}/{image_prefix}",
                                           not args.no_camera)

        for dataset, by_variant in actionable:
            entry = known[f"{experiment}/{dataset}"]
            entry["study"] = full["slug"]
            if dataset in existing:
                glance, state = existing[dataset]
                entry["glance"] = glance["short_key"]
                if args.no_extra_layers:
                    continue
                entry["layers"] = sorted(add_layers(
                    opener, args, dataset, glance, state, image_prefix, prefix,
                    by_variant, summary))
                continue
            key, carried = create_glance(opener, args, full, dataset, image_prefix, prefix,
                                         by_variant, camera, reference_xy, summary)
            if carried:
                entry["layers"] = sorted(carried)
            if key:
                entry["glance"] = key

    # A volume can leave the bucket -- a re-run under another name, a cleanup --
    # and the glance pointing at it keeps answering until someone looks. Say so
    # once, and leave both the glance and the record entry alone. Only a full
    # sweep may conclude this; a filtered run simply did not look.
    gone = []
    if not args.experiment and args.match == "*" and not wanted_datasets:
        for key, entry in known.items():
            if key in seen_keys or entry.get("missing_since"):
                continue
            entry["missing_since"] = started
            gone.append(key)

    changed = summary["studies"] + summary["glances"] + summary["layers"]
    if changed or new_images or new_segs or gone or not args.quiet:
        print()
        report("new image volume(s)", new_images)
        report("new segmentation(s)", new_segs)
        report("awaiting segmentation", waiting)
        report("segmentation with no image volume", orphans)
        report("no longer in the bucket", gone)
        print(f"{'would create' if args.dry_run else 'created'} {summary['studies']} study(ies) "
              f"and {summary['glances']} glance(s), "
              f"{'would add' if args.dry_run else 'added'} {summary['layers']} layer(s)")

    if args.no_record or args.dry_run:
        say("record not written" + (" (dry run)" if args.dry_run else ""))
        return
    scope["runs"] = (scope["runs"] + [{
        "at": started,
        "finished": now_iso(),
        "datasets": len(seen_keys),
        "new_images": sorted(new_images),
        "new_segmentations": sorted(new_segs),
        "missing": sorted(gone),
        "created_studies": summary["studies"],
        "created_glances": summary["glances"],
        "added_layers": summary["layers"],
    }])[-RUN_HISTORY:]
    save_record(args.record, record)
    say(f"record: {args.record}")


if __name__ == "__main__":
    main()
