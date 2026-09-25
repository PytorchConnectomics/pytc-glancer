"""No server or GCS access: all requests and pipeline resolution are mocked."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from scripts import unbake_corrections as migrate


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.glance = {"short_key": "key", "state": {}}
        self.result = {"derived_at": 42, "state": "state", "outcome": "outcome", "clean": True,
                       "derived": [{"id": "1", "from": "glia", "to": "axon"}], "cannot_express": [], "difference": {}}

    def test_file_precedence_preserves_text(self):
        path = self.directory / "pipeline.json"
        path.write_text('{ "classes": [] }\n')
        with patch.object(migrate, "api") as api:
            base, body = migrate.choose_base(None, "url", self.glance, path)
        api.assert_not_called()
        self.assertEqual(base["kind"], "file")
        self.assertEqual(body, path.read_text())

    def test_newest_equal_content_skips_without_trying_older(self):
        page = {"entries": [{"source": "restore", "kinds": ["report", "review"], "state": {"report_version": 10}},
                            {"source": "ingest", "kinds": ["report"], "state": {"report_version": 8}},
                            {"source": "upload", "kinds": ["report"], "state": {"report_version": 1}}], "next_before": None}
        with patch.object(migrate, "api", side_effect=[page, {"body": '{"a":1,"b":2}'}, {"body": '{ "b":2, "a":1 }'}]) as api, patch.object(migrate, "resolve") as resolve:
            self.assertIsNone(migrate.choose_base(None, "url", self.glance))
        self.assertEqual(api.call_count, 3)
        resolve.assert_not_called()

    def test_paged_history_uses_newest_eligible_report(self):
        page = {"entries": [{"source": "correct", "kinds": ["report"], "state": {"report_version": 10}}], "next_before": 9}
        second = {"entries": [{"source": "review", "kinds": ["review"], "state": {"report_version": 8}},
                              {"source": "upload", "kinds": ["report"], "state": {"report_version": 8}}], "next_before": None}
        with patch.object(migrate, "api", side_effect=[page, {"body": '{"a":1}'}, second, {"body": '{"a":2}'}]):
            base, body = migrate.choose_base(None, "url", self.glance)
        self.assertEqual(base, {"kind": "history", "detail": "8"})
        self.assertEqual(json.loads(body), {"a": 2})

    def test_no_eligible_history_fetches_unverified_gcs(self):
        page = {"entries": [{"source": s, "kinds": ["report"], "state": {"report_version": 10}} for s in ("baseline", "correct", "restore")], "next_before": None}
        with patch.object(migrate, "api", side_effect=[page, {"body": '{}'}]), patch.object(migrate, "eval_root", return_value=("gs://mock/root", "sample")), patch.object(migrate, "resolve", return_value=({"classes": []}, "error_report.json")) as resolve:
            base, body = migrate.choose_base(None, "url", self.glance)
        resolve.assert_called_once()
        self.assertEqual(base["kind"], "gcs")
        self.assertIn("unverified", base["detail"])

    def make_plan(self):
        with patch.object(migrate, "choose_base", return_value=({"kind": "file", "detail": "test"}, '{ "classes": [] }\n')), patch.object(migrate, "api", side_effect=[{"entries": [{"state": {"report": {}}}]}, self.result]) as api, contextlib.redirect_stdout(io.StringIO()):
            path = migrate.plan_glance(None, "url", "account", self.glance, self.directory)
        self.assertNotIn("apply", api.call_args.args[3])
        return path

    def test_plan_file_and_apply_tokens_exact_text_and_accept(self):
        path = self.make_plan()
        for accept in (False, True):
            with patch.object(migrate, "api", return_value={"applied": True}) as api, contextlib.redirect_stdout(io.StringIO()):
                migrate.apply_plan(None, "url", "account", "key", path, accept)
            payload = api.call_args.args[3]
            self.assertEqual(payload["pipeline"], '{ "classes": [] }\n')
            self.assertEqual(payload["derived_at"], 42)
            self.assertEqual(payload["expect"], "state")
            self.assertEqual(payload["expect_outcome"], "outcome")
            self.assertEqual("accept" in payload, accept)

    def test_mismatched_plan_refuses_before_request(self):
        path = self.make_plan()
        for base, account, key in [("other", "account", "key"), ("url", "other", "key"), ("url", "account", "other")]:
            with patch.object(migrate, "api") as api, self.assertRaises(SystemExit):
                migrate.apply_plan(None, base, account, key, path)
            api.assert_not_called()

    def test_conflict_messages(self):
        path = self.make_plan()
        for code, message in [("changed", "re-plan"), ("needs_acceptance", "--accept")]:
            error = urllib.error.HTTPError("url", 409, "Conflict", {}, io.BytesIO(code.encode()))
            with patch.object(migrate, "api", side_effect=error), self.assertRaisesRegex(SystemExit, message):
                migrate.apply_plan(None, "url", "account", "key", path)

    def test_all_skips_reportless_first_and_plans_remaining(self):
        for entries in ([], [{"state": {"report_version": None, "report": None}}],
                        [{"source": "restore", "state": {"report_version": 9, "report": None}}]):
            with self.subTest(entries=entries):
                output = io.StringIO()
                glances = [{"short_key": key, "state": {}} for key in ("absent", "second", "third")]
                def request(opener, base, route, *args):
                    if route == "/api/studies":
                        return [{"slug": "study"}]
                    if route.startswith("/api/studies/"):
                        return {"glances": glances}
                    if route.endswith("/versions"):
                        return {"entries": entries if "/absent/" in route else [{"state": {"report": {}}}]}
                    self.assertTrue(route.endswith("/unbake"))
                    return self.result
                with patch.object(migrate, "api", side_effect=request), patch.object(migrate, "read_credentials", return_value=("account", "password")), patch.object(migrate, "open_session"), patch.object(migrate, "choose_base", return_value=({"kind": "file", "detail": "mock"}, "{}")) as choose, patch.object(migrate.sys, "argv", ["unbake", "--all", "--base", "https://mock.invalid", "--plan-dir", str(self.directory)]), contextlib.redirect_stdout(output):
                    migrate.main()
                self.assertIn("absent: skipped (no stored report)", output.getvalue())
                self.assertEqual([call.args[2]["short_key"] for call in choose.call_args_list], ["second", "third"])
                self.assertIn("second: file", output.getvalue())
                self.assertIn("third: file", output.getvalue())
                self.assertFalse(list(self.directory.glob("unbake_absent*")))

    def test_planning_missing_historical_body_and_no_report_conflict_skip(self):
        page = {"entries": [{"source": "restore", "state": {"report_version": 9, "report": {}}}]}
        for status, body in [(404, {"error": "no_such_point"}), (409, {"error": "no_report"})]:
            error = urllib.error.HTTPError("url", status, "missing", {}, io.BytesIO(json.dumps(body).encode()))
            pipeline = self.directory / "pipeline.json"
            pipeline.write_text("{}")
            with patch.object(migrate, "api", side_effect=[page, error]), contextlib.redirect_stdout(io.StringIO()) as output:
                result = migrate.plan_glance(None, "url", "account", self.glance, self.directory, pipeline if status == 409 else None)
            self.assertIsNone(result)
            self.assertIn("key: skipped", output.getvalue())
            self.assertFalse(list(self.directory.glob("unbake_*")))

    def test_other_planning_conflicts_are_not_skipped(self):
        error = urllib.error.HTTPError("url", 409, "changed", {}, io.BytesIO(b'{"error":"changed"}'))
        with patch.object(migrate, "api", side_effect=[{"entries": [{"state": {"report": {}}}]}, error]), patch.object(migrate, "choose_base", return_value=({"kind": "file"}, "{}")), self.assertRaises(urllib.error.HTTPError):
            migrate.plan_glance(None, "url", "account", self.glance, self.directory)

    def test_apply_no_report_skips(self):
        path = self.make_plan()
        error = urllib.error.HTTPError("url", 409, "missing", {}, io.BytesIO(b'{"error":"no_report"}'))
        with patch.object(migrate, "api", side_effect=error), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertIsNone(migrate.apply_plan(None, "url", "account", "key", path))
        self.assertIn("key: skipped (no stored report)", output.getvalue())

    def test_lost_response_requires_history_check(self):
        path = self.make_plan()
        with patch.object(migrate, "api", side_effect=urllib.error.URLError("lost response")), self.assertRaisesRegex(SystemExit, "History panel.*before retrying"):
            migrate.apply_plan(None, "url", "account", "key", path)


if __name__ == "__main__":
    unittest.main()
