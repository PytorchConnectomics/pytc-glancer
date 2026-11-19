#!/usr/bin/env python3
"""Push each project's roadmap plan to pytc_glancer.

A workbench project may keep `projects/<name>/roadmap/roadmap.md`. The file is
prose for people plus one fenced JSON block, ```rdash-roadmap, listing the
project's tasks: lane, status, owner and what each task needs first. This reads
that block from every project and stores it as the plan of the roadmap whose
address is the project's name in lowercase (`yale-dLGN-26` -> `yale-dlgn-26`),
creating the roadmap the first time.

The push goes one way. The canvas draws a box per task and keeps its text and
colour in step with the plan; where boxes sit and whatever people draw around
them stays as they left it. Pushing an unchanged plan changes nothing.

    scripts/sync_roadmaps.py ~/dw-os/research/pytc-jam --dry-run
    scripts/sync_roadmaps.py ~/dw-os/research/pytc-jam
    scripts/sync_roadmaps.py ~/dw-os/research/pytc-jam --project yale-dLGN-26 --base http://127.0.0.1:3112

Requires the app running. Signs in with the account in the app's env file, as
the other scripts here do.
"""

import argparse
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_glances import DEFAULT_BASE, DEFAULT_ENV, open_session, read_credentials, warn  # noqa: E402

FENCE = re.compile(r"^```rdash-roadmap[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")


def read_plan(path):
    """The plan in one roadmap.md, or raise ValueError saying what is wrong."""
    with open(path, encoding="utf-8") as handle:
        blocks = FENCE.findall(handle.read())
    if not blocks:
        raise ValueError("no ```rdash-roadmap block")
    if len(blocks) > 1:
        raise ValueError("more than one ```rdash-roadmap block")
    try:
        plan = json.loads(blocks[0])
    except json.JSONDecodeError as error:
        raise ValueError(f"the rdash-roadmap block is not valid JSON: {error}")
    if not isinstance(plan, dict):
        raise ValueError("the rdash-roadmap block must be a JSON object")
    return plan


def put_plan(opener, base, slug, plan):
    request = urllib.request.Request(
        f"{base}/api/roadmaps/{slug}/plan", method="PUT",
        data=json.dumps(plan).encode(), headers={"Content-Type": "application/json"})
    try:
        return json.load(opener.open(request))
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            detail = json.loads(body).get("detail", body)
        except json.JSONDecodeError:
            detail = body[:200]
        raise ValueError(f"HTTP {error.code}: {detail}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("workbench", help="a workbench checkout holding projects/<name>/roadmap/roadmap.md")
    parser.add_argument("--project", action="append", help="only this project (repeatable)")
    parser.add_argument("--base", default=DEFAULT_BASE, help=f"app address (default {DEFAULT_BASE})")
    parser.add_argument("--env", default=DEFAULT_ENV, help="the app's env file, for the sign-in")
    parser.add_argument("--account", default="", help="account to sign in as (default: the first configured)")
    parser.add_argument("--dry-run", action="store_true", help="read and report, push nothing")
    args = parser.parse_args()

    paths = sorted(glob.glob(os.path.join(os.path.expanduser(args.workbench), "projects", "*", "roadmap", "roadmap.md")))
    if args.project:
        paths = [path for path in paths if os.path.basename(os.path.dirname(os.path.dirname(path))) in args.project]
    if not paths:
        raise SystemExit("no projects/<name>/roadmap/roadmap.md found")

    opener = None if args.dry_run else open_session(args.base, read_credentials(args.env, args.account))
    failed = 0
    for path in paths:
        project = os.path.basename(os.path.dirname(os.path.dirname(path)))
        slug = project.lower()
        try:
            if not SLUG.match(slug):
                raise ValueError("the project name does not make a roadmap address (lowercase letters, digits, hyphens)")
            plan = read_plan(path)
            tasks = len(plan.get("nodes", []))
            if args.dry_run:
                print(f"{project}: {tasks} tasks, would push to /roadmap/{slug}")
                continue
            answer = put_plan(opener, args.base, slug, plan)
            state = "created" if answer["created"] else "updated" if answer["changed"] else "unchanged"
            print(f"{project}: {answer['tasks']} tasks, {state} ({args.base}/roadmap/{slug}, plan {answer['plan_rev']})")
        except ValueError as error:
            failed += 1
            warn(f"{project}: {error}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
