#!/usr/bin/env python3
"""Plan baked-correction migration by default; apply one reviewed plan atomically.

Planning changes no report or review. Listing history may cache baseline summaries.
Fresh GCS bases are unverified: pipeline drift can be mistaken for human edits.
"""
import argparse
import json
import http.client
import os
from pathlib import Path
import shlex
import sys
import time
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_report import DEFAULT_BASE, DEFAULT_ENV, api, eval_root, open_session, read_credentials, resolve


class MissingHistoricalReport(Exception):
    """An absent historical body only skips the glance being planned."""


def historical_report(opener, base, route, point):
    try:
        return api(opener, base, route + f"/versions/{point}/report")["body"]
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        raise MissingHistoricalReport from error


def choose_base(opener, base, glance, base_file=None, first_page=None):
    """Stop at the newest eligible report, comparing JSON content, not row ids."""
    if base_file:
        return {"kind": "file", "detail": str(base_file)}, Path(base_file).read_text()
    route = f"/api/glances/{glance['short_key']}"
    before = None
    current = None
    while True:
        page = first_page if first_page is not None else api(opener, base, route + "/versions" + (f"?before={before}" if before else ""))
        first_page = None
        if current is None and page["entries"]:
            point = page["entries"][0]["state"]["report_version"]
            if point is not None:
                current = historical_report(opener, base, route, point)
        for entry in page["entries"]:
            if entry["source"] not in ("ingest", "upload") or "report" not in entry["kinds"]:
                continue
            point = entry["state"]["report_version"]
            candidate = historical_report(opener, base, route, point)
            if current is not None and json.loads(candidate) == json.loads(current):
                return None
            return {"kind": "history", "detail": str(point)}, candidate
        before = page.get("next_before")
        if before is None:
            break
    state = glance["state"]
    if isinstance(state, str):
        state = json.loads(state)
    root, _ = eval_root(state)
    report, origin = resolve(state, root, 200, 20000)
    return {"kind": "gcs", "detail": f"unverified: {root}/{origin}"}, json.dumps(report, separators=(",", ":"))


def plan_glance(opener, base, account, glance, directory, base_file=None):
    key = glance["short_key"]
    route = f"/api/glances/{key}"
    # History describes stored state, unlike report GET which can fall back to
    # GCS. A restore-to-absence has a version id but a null report summary.
    page = api(opener, base, route + "/versions")
    if not page["entries"] or page["entries"][0]["state"]["report"] is None:
        print(f"{key}: skipped (no stored report)")
        return None
    try:
        selected = choose_base(opener, base, glance, base_file, first_page=page)
    except MissingHistoricalReport:
        print(f"{key}: skipped (historical report unavailable)")
        return None
    if selected is None:
        print(f"{key}: nothing to unbake (newest pipeline report matches current)")
        return None
    provenance, pipeline = selected
    try:
        result = api(opener, base, route + "/unbake", {"pipeline": pipeline, "base": provenance})
    except urllib.error.HTTPError as error:
        if error.code != 409:
            raise
        detail = json.loads(error.read())
        if detail.get("error") != "no_report":
            raise
        print(f"{key}: skipped (no stored report)")
        return None
    plan = {"key": key, "base_url": base.rstrip("/"), "account": account, "base": provenance, "pipeline": pipeline, "result": result}
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"unbake_{key}_{time.time_ns()}.json"
    path.write_text(json.dumps(plan, indent=2) + "\n")
    print(f"{key}: {provenance['kind']} ({provenance['detail']}); {'clean' if result['clean'] else 'view differences'}; "
          f"{len(result['derived'])} derived, {len(result['cannot_express'])} cannot express")
    for edit in result["derived"]:
        print(f"  {edit['id']}: {edit['from']} -> {edit['to']}")
    for segment in result["cannot_express"]:
        print(f"  cannot express: {segment}")
    print(json.dumps(result["difference"], indent=2))
    command = ["python3", "scripts/unbake_corrections.py", "--glance", key, "--base", base, "--account", account, "--apply", str(path)]
    print("Review this plan, then: " + shlex.join(command) + (" --accept" if not result["clean"] else ""))
    return path


def apply_plan(opener, base, account, key, path, accept=False):
    plan = json.loads(Path(path).read_text())
    if (plan["key"], plan["base_url"], plan["account"]) != (key, base.rstrip("/"), account):
        raise SystemExit("plan key, base URL, or account does not match this invocation")
    result = plan["result"]
    payload = {"pipeline": plan["pipeline"], "base": plan["base"], "apply": True,
               "derived_at": result["derived_at"], "expect": result["state"], "expect_outcome": result["outcome"]}
    if accept:
        payload["accept"] = True
    try:
        response = api(opener, base, f"/api/glances/{key}/unbake", payload)
    except urllib.error.HTTPError as error:
        detail = error.read().decode()
        if error.code == 409:
            try:
                no_report = json.loads(detail).get("error") == "no_report"
            except (ValueError, AttributeError):
                no_report = False
            if no_report:
                print(f"{key}: skipped (no stored report)")
                return None
            if "needs_acceptance" in detail:
                raise SystemExit("view would change — review the differences and rerun with --accept") from error
            raise SystemExit("glance or candidate changed since the plan — re-plan") from error
        raise SystemExit(f"apply failed: {error.code} {detail}") from error
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise SystemExit("Apply completion is uncertain. Check the glance's History panel (or GET …/versions) "
                         "for the ingest point before retrying. If it committed, this plan will return 409 changed.") from error
    print(json.dumps(response, indent=2))
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--glance", action="append", help="glance key (repeat for several)")
    group.add_argument("--all", action="store_true")
    parser.add_argument("--base-file", help="explicit pipeline JSON for one glance")
    parser.add_argument("--apply", metavar="PLAN_FILE")
    parser.add_argument("--accept", action="store_true", help="acknowledge the plan's visible differences")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--env-file", default=DEFAULT_ENV)
    parser.add_argument("--account", default="")
    parser.add_argument("--plan-dir", default="~/.local/share/pytc_glancer/backups")
    args = parser.parse_args()
    if (args.base_file or args.apply) and (args.all or len(args.glance) != 1):
        parser.error("--base-file and --apply require exactly one --glance")
    if args.accept and not args.apply:
        parser.error("--accept requires --apply")
    credentials = read_credentials(args.env_file, args.account)
    account = credentials[0]
    base = args.base.rstrip("/")
    opener = open_session(base, credentials)
    if args.apply:
        apply_plan(opener, base, account, args.glance[0], args.apply, args.accept)
        return
    print("Planning changes no report or review; listing versions may cache baseline summaries.")
    wanted = set(args.glance or [])
    found = set()
    for study in api(opener, base, "/api/studies"):
        full = api(opener, base, f"/api/studies/{study['slug']}?include_archived=1")
        for glance in full["glances"]:
            if args.all or glance["short_key"] in wanted:
                found.add(glance["short_key"])
                plan_glance(opener, base, account, glance, Path(args.plan_dir).expanduser(), args.base_file)
    if wanted - found:
        raise SystemExit("glances not found: " + ", ".join(sorted(wanted - found)))


if __name__ == "__main__":
    main()
