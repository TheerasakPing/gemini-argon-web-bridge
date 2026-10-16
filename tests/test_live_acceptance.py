"""Fault tests for the opt-in live gate; never contact Gemini or the bridge."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "live_acceptance", Path(__file__).with_name("live_harness.py"))
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


class AcceptanceGateTests(unittest.TestCase):
    def run_fixture(self, *, buffered=False, wrong_facts=False, mutate=False,
                    split_jobs=False, tab=None, final_stream='default'):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results"

            def fake_process(argv, *, cwd, stdout, stderr):
                if tab is not None:
                    self.assertEqual(argv[argv.index("--tab") + 1], str(tab))
                else:
                    self.assertNotIn("--tab", argv)
                project = Path(cwd)
                source_path = next(project.glob("calc_*.py"))
                source = source_path.read_text()
                marker = re.search(r'CHECK_ID = "([^"]+)"', source)[1]
                operator = re.search(r"return a ([*-]) b", source)[1]
                left, right = map(int, re.search(r"print\(add\((\d+), (\d+)\)\)", source).groups())
                value = left - right if operator == "-" else left * right
                if wrong_facts:
                    value += 1
                final = (f"{marker}\nFACTS: entry={source_path.name}; intent=sum; "
                         f"actual={operator}; output={value}")
                calls = {
                    "z_list": {"action": {"type": "list_files"}, "result": {"status": "success"}},
                    "a_read": {"action": {"type": "read_file", "path": "README.md"},
                               "result": {"status": "success"}},
                    "b_read": {"action": {"type": "read_file", "path": source_path.name},
                               "result": {"status": "success"}},
                }
                # Intentionally choose IDs whose lexical order differs from execution.
                state = {"status": "final", "turns": 4, "pending": None, "calls": calls,
                         "transcript": [{"kind": "tool_result", **call}
                                        for call in calls.values()]}
                state_path = Path(argv[argv.index("--state-dir") + 1]) / "fixture"
                state_path.mkdir(parents=True)
                (state_path / "state.json").write_text(json.dumps(state))
                stream_events = {
                    'default': [
                        (1, final[:8], 'assistant_delta'),
                        (51, final[8:24], 'assistant_delta'),
                        (151, final[24:], 'assistant_delta'),
                    ],
                    'buffered': [],
                    'tool_only': [(1, 'Reading source', 'assistant_delta')],
                    'tail_missing': [
                        (1, final[:8], 'assistant_delta'),
                        (51, final[8:-8], 'assistant_delta'),
                    ],
                    'duplicate': [
                        (1, final[:8], 'assistant_delta'),
                        (51, final[8:], 'assistant_delta'),
                        (151, final[-8:], 'assistant_delta'),
                    ],
                    'reset_exact': [
                        (1, 'Wrong source', 'assistant_delta'),
                        (51, final[:24], 'assistant_reset'),
                        (151, final[24:], 'assistant_delta'),
                    ],
                    'reset_incomplete': [
                        (1, 'Wrong source', 'assistant_delta'),
                        (51, final[:24], 'assistant_reset'),
                        (151, final[24:-8], 'assistant_delta'),
                    ],
                    'stale_only': [(1, 'Reading source', 'assistant_delta')],
                }[final_stream]
                for at_ms, text, event_type in stream_events:
                    stdout.write(json.dumps({
                        "event": event_type, "at_ms": at_ms,
                        "data": {"text": text, "job_status": "done" if buffered else "running",
                                 "job_phase": "generating",
                                 "job_id": f"job-{at_ms}" if split_jobs else "job-one"},
                    }) + "\n")
                if final_stream == 'stale_only':
                    stdout.write(json.dumps({
                        'event': 'tool_result', 'at_ms': 150,
                        'data': {'status': 'success'},
                    }) + '\n')
                stdout.write(json.dumps({
                    "event": "final", "at_ms": 201, "data": {"text": final},
                }) + "\n")
                if mutate:
                    (project / "README.md").write_text("unexpected mutation")
                self.assertNotIn(f"output={left - right}", argv[2])
                self.assertNotIn(f"output={left * right}", argv[2])

                class Process:
                    def wait(self, timeout):
                        return 0

                return Process()

            arguments = ["live_harness.py", "--binary", sys.executable, "--count", "1",
                         "--output", str(output)]
            if tab is not None:
                arguments.extend(["--tab", str(tab)])
            with patch.object(sys, "argv", arguments), \
                    patch.object(live, "health", return_value={"ready": True}), \
                    patch.object(live.subprocess, "Popen", side_effect=fake_process), \
                    contextlib.redirect_stdout(io.StringIO()):
                code = live.main()
            report = json.loads((output / "report.json").read_text())[0]
            return code, report

    def test_accepts_live_evidence_without_relying_on_call_id_sort_order(self):
        code, report = self.run_fixture()
        self.assertEqual(code, 0)
        self.assertTrue(report["passed"])
        self.assertTrue(report["streaming_verified"])
        self.assertTrue(report["final_stream"]["verified"])
        self.assertTrue(report["final_stream"]["complete"])

    def test_forwards_explicit_tab_without_changing_acceptance(self):
        code, report = self.run_fixture(tab=1869336121)
        self.assertEqual(code, 0)
        self.assertTrue(report["passed"])

    def test_rejects_buffered_deltas_even_when_emitted_before_final(self):
        code, report = self.run_fixture(buffered=True)
        self.assertEqual(code, 1)
        self.assertFalse(report["streaming_verified"])

    def test_rejects_wrong_semantics_with_correct_marker_and_reads(self):
        code, report = self.run_fixture(wrong_facts=True)
        self.assertEqual(code, 1)
        self.assertFalse(report["facts_correct"])

    def test_rejects_one_buffered_chunk_per_job_across_multiple_turns(self):
        code, report = self.run_fixture(split_jobs=True)
        self.assertEqual(code, 1)
        self.assertFalse(report["streaming_verified"])

    def test_final_stream_must_reconstruct_exact_final_text(self):
        for mode in ('buffered', 'tool_only', 'tail_missing', 'duplicate',
                     'reset_incomplete'):
            with self.subTest(mode=mode):
                code, report = self.run_fixture(final_stream=mode)
                self.assertEqual(code, 1)
                self.assertFalse(report["final_stream"]["verified"])

    def test_final_stream_accepts_reset_as_replacement(self):
        code, report = self.run_fixture(final_stream='reset_exact')
        self.assertEqual(code, 0)
        self.assertTrue(report["passed"])
        self.assertEqual(report["final_stream"]["resets"], 1)

    def test_final_stream_ignores_deltas_before_last_tool_barrier(self):
        code, report = self.run_fixture(final_stream='stale_only')
        self.assertEqual(code, 1)
        self.assertEqual(report["final_stream"]["reason"],
                         'missing_or_ambiguous_final_job')

    def test_rejects_readme_mutation_even_when_source_is_unchanged(self):
        code, report = self.run_fixture(mutate=True)
        self.assertEqual(code, 1)
        self.assertFalse(report["fixture_unchanged"])


if __name__ == "__main__":
    unittest.main()
