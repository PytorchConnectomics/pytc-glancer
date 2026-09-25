#!/usr/bin/env python3
"""Refresh a glance's error report in pytc_glancer from what GCS now carries.

The evaluation pipeline republishes its artifacts to the bucket; pytc_glancer
stores the report itself, in D1, so a republished analysis has to be pulled
down and pushed in. This does that in one step, and picks the right source:

  1. `<prefix>/<dataset>_nogt_eval/error_report.json` if the pipeline already
     publishes the panel's own format -- pushed as-is.
  2. otherwise `<segmentation layer>/error_analysis.json`, the pipeline's
     current output, reduced through make_error_report.py first.
  3. otherwise `<prefix>/<dataset>_nogt_eval/merge_correction/segments_detailed.json`,
     the older catalog, reduced the same way.

The dataset, bucket, and prefix come from the glance's own image layer, the
same derivation the Worker uses, so there is nothing to keep in step by hand.

    scripts/push_report.py --glance ifs5w7wcsueti76lhijkmzkbnxquvg4e --dry-run
    scripts/push_report.py --glance ifs5w7wcsueti76lhijkmzkbnxquvg4e
    scripts/push_report.py --glance <key> --report /tmp/error_report.json

Requires `gcloud` authenticated with read access to the bucket, and the app
running. Run `gcloud auth login` first if a fetch fails on credentials.
"""

import argparse
import gzip
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import (  # noqa: E402  (path set above)
    DEFAULT_BASE, DEFAULT_ENV, NotFound, api, gcloud, open_session, read_credentials, warn,
)
from make_error_report import ERROR_ANALYSIS_SCHEMA, build, build_semantic, load  # noqa: E402

EVAL_SUFFIX = "_nogt_eval"
REPORT_OBJECT = "error_report.json"
CATALOG_OBJECT = "merge_correction/segments_detailed.json"
ANALYSIS_OBJECT = "error_analysis.json"
SEMANTIC_OBJECT = "semantic_segmentation.json"
SOURCE_PATTERN = re.compile(r"^(?:zarr://)?gs\+ngauth\+https://[^/\s|]+/([^|\s]+)")


def eval_root(state):
    """`gs://bucket/prefix/<dataset>_nogt_eval` for a glance's image layer."""
    for layer in state.get("layers", []):
        if layer.get("type") != "image":
            continue
        source = layer.get("source")
        if isinstance(source, dict):
            source = source.get("url")
        match = SOURCE_PATTERN.match((source or "").strip())
        if not match:
            continue
        parts = [p for p in match.group(1).rstrip("/").split("/") if p]
        dataset = parts[-1][:-len(".zarr")] if parts[-1].endswith(".zarr") else parts[-1]
        return "gs://" + "/".join(parts[:-1] + [dataset + EVAL_SUFFIX]), dataset
    raise SystemExit("that glance has no gs+ngauth image layer, so it names no dataset")


def fetch(uri):
    """Object bytes, or None when the object is simply not there.

    Bytes rather than text: the pipeline stores these objects gzipped, and
    `gcloud storage cat` hands back what is stored."""
    try:
        return gcloud("cat", uri, timeout=900, binary=True)
    except NotFound:
        return None
    except RuntimeError as error:
        if "reauthentication" in str(error).lower() or "auth" in str(error).lower():
            raise SystemExit(f"cannot read {uri}: {error}\nRun `gcloud auth login` and retry.")
        raise


def seg_roots(state):
    """Each segmentation layer's own directory, in the state's own order."""
    roots = []
    for layer in state.get("layers", []):
        if layer.get("type") != "segmentation":
            continue
        source = layer.get("source")
        if isinstance(source, dict):
            source = source.get("url")
        match = SOURCE_PATTERN.match((source or "").strip())
        if match:
            roots.append("gs://" + match.group(1).rstrip("/"))
    return roots


def decode(raw):
    return json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)


def semantic_report(analysis, directory):
    """The five-class report for an analysis, named after its own layer.

    The semantic class is read from the analysis when the pipeline writes it
    per segment, and otherwise joined from the catalog it publishes beside the
    analysis. `segmentation` is set to the layer's directory name, which is
    the name the glance gives that layer, so the viewer drives the layer the
    ids belong to even on a glance that carries two variants."""
    semantic = None
    if not any("semantic_class" in s for s in analysis.get("segments", [])[:50]):
        uri = f"{directory}/{SEMANTIC_OBJECT}"
        raw = fetch(uri)
        if raw is None:
            raise SystemExit(f"{ANALYSIS_OBJECT} carries no semantic_class and there is no {uri}")
        print(f"  joining {uri}")
        semantic = decode(raw)
    report = build_semantic(analysis, semantic)
    model = report.get("segmentation")
    report["segmentation"] = directory.rstrip("/").rsplit("/", 1)[-1]
    if model:
        report["notes"] = f"{report['notes']} Model: {model}."[:2000]
    return report


def resolve(state, root, cap, axon_cap):
    """The first analysis the bucket actually carries, reduced if it needs it.

    Three conventions are in play. A published `error_report.json` beside the
    image is the panel's own format and wins outright. Otherwise the pipeline's
    own output is reduced: `error_analysis.json`, which it now writes inside the
    segmentation directory, or the older `segments_detailed.json` catalog beside
    the image. Searching rather than guessing means a dataset on either
    convention resolves without a flag.
    """
    candidates = [(f"{root}/{REPORT_OBJECT}", REPORT_OBJECT, False)]
    candidates += [(f"{seg}/{ANALYSIS_OBJECT}", ANALYSIS_OBJECT, True) for seg in seg_roots(state)]
    candidates.append((f"{root}/{CATALOG_OBJECT}", CATALOG_OBJECT, True))

    for uri, name, reduce_it in candidates:
        raw = fetch(uri)
        if raw is None:
            print(f"  no {uri}")
            continue
        print(f"  using {uri}")
        document = decode(raw)
        if name == ANALYSIS_OBJECT and document.get("schema_name") == ERROR_ANALYSIS_SCHEMA:
            return semantic_report(document, uri.rsplit("/", 1)[0]), name
        return (build(document, cap, axon_cap) if reduce_it else document), name
    raise SystemExit("no published analysis found for this glance")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--glance", required=True, help="glance short key")
    parser.add_argument("--study", help="study slug or id (defaults to searching every study)")
    parser.add_argument("--report", help="skip GCS and push this local error_report.json")
    parser.add_argument("--base", default=DEFAULT_BASE, help="running app origin")
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="", metavar="ID",
                        help="pytc_glancer account to sign in as; a glance belongs to "
                             "one account (default: the first in PYTC_GLANCER_ACCOUNTS)")
    parser.add_argument("--max-segment-ids", type=int, default=200)
    parser.add_argument("--max-axons", type=int, default=20000)
    parser.add_argument("--dry-run", action="store_true", help="fetch and summarize, push nothing")
    args = parser.parse_args()

    opener = open_session(args.base, read_credentials(args.env_file, args.account))

    studies = [{"slug": args.study}] if args.study else api(opener, args.base, "/api/studies")
    glance = None
    for study in studies:
        try:
            full = api(opener, args.base, f"/api/studies/{study['slug']}?include_archived=1")
        except urllib.error.HTTPError as error:
            raise SystemExit(f"study {study['slug']!r}: {error.code}")
        glance = next((g for g in full["glances"] if g["short_key"] == args.glance), None)
        if glance:
            print(f"glance: {glance.get('title') or args.glance} in {full['title']}")
            break
    if not glance:
        raise SystemExit(f"no glance {args.glance!r} in {'that study' if args.study else 'any study'}")

    state = glance["state"]
    if isinstance(state, str):
        state = json.loads(state)

    if args.report:
        with open(args.report) as handle:
            report = json.load(handle)
        origin = args.report
    else:
        root, dataset = eval_root(state)
        print(f"dataset: {dataset}")
        report, origin = resolve(state, root, args.max_segment_ids, args.max_axons)

    body = json.dumps(report, separators=(",", ":"))
    print(f"  {len(report.get('classes', []))} classes, "
          f"{sum(len(c.get('segments', [])) for c in report.get('classes', []))} segment records, "
          f"{len(report.get('axons', []))} axons, {len(body.encode()) / 1024:.1f} KiB "
          f"(source: {origin})")
    if args.dry_run:
        print("dry run; nothing pushed")
        return

    request = urllib.request.Request(
        f"{args.base}/api/glances/{args.glance}/report?source={'upload' if args.report else 'ingest'}", method="PUT",
        data=body.encode(), headers={"Content-Type": "application/json"})
    try:
        result = json.load(opener.open(request))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"push failed: {error.code} {error.read().decode()[:300]}")
    print(f"stored {result['bytes']} bytes in D1")
    edits = result.get("edits", {})
    print(f"edits: {edits.get('applied', 0)} applied, {edits.get('agrees', 0)} agree, "
          f"{edits.get('inactive_total', 0)} inactive")

    # Read it back through the app so a stored-but-unreadable report cannot
    # pass silently: the GET re-validates against the same schema.
    check = api(opener, args.base, f"/api/glances/{args.glance}/report?raw=1")
    if check.get("source") != "pytc_glancer":
        warn(f"the app is still serving a {check.get('source')} report")
    print(f"verified: {len(check['classes'])} classes, {len(check.get('axons', []))} axons")


if __name__ == "__main__":
    main()
