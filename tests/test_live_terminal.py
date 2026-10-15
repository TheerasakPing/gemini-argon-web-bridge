import contextlib
import importlib.util
import io
import os
from pathlib import Path
try:
    import pty
except ImportError:
    pty = None
import select
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'bridge', Path(__file__).resolve().parents[1] / 'scripts/gemini_argon_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class LiveTerminalTests(unittest.TestCase):
    def test_whitespace_chunks_flush_before_completion_and_keep_tail(self):
        writes = []
        args = bridge.build_parser().parse_args(['hello', '--stream', '--no-spinner'])

        def wait(job, timeout, spinner, on_partial):
            on_partial('หนึ่ง')
            self.assertEqual(writes, [])
            on_partial('หนึ่ง สอง\tสาม\nสี่')
            self.assertEqual(writes, ['หนึ่ง ', 'สอง\t', 'สาม\n'])
            on_partial('หนึ่ง สอง\tสาม\nสี่')
            self.assertEqual(len(writes), 3, 'Duplicate snapshots must not repeat output')
            return {'text': 'หนึ่ง สอง\tสาม\nสี่ ห้า', 'status': 'done'}

        with patch.object(bridge, 'LiveOutput') as output, \
                patch.object(bridge, 'build_prompt', return_value='hello'), \
                patch.object(bridge, 'request', return_value={'id': 'test'}), \
                patch.object(bridge, 'wait_for_job', side_effect=wait):
            output.return_value.write.side_effect = writes.append
            bridge.cmd_ask(args, {'ready': True})
        self.assertEqual(writes, ['หนึ่ง ', 'สอง\t', 'สาม\n', 'สี่ ', 'ห้า', '\n'])
        self.assertEqual(''.join(writes), 'หนึ่ง สอง\tสาม\nสี่ ห้า\n')

    def test_only_ancestor_agy_terminal_is_selected(self):
        rows = '20 10 ?? shell\n10 1 ttys012 /path/agy\n99 1 ttys099 agy\n'
        with patch.object(bridge.os, 'getppid', return_value=20), \
                patch.object(bridge.subprocess, 'run', return_value=type('Result', (), {'stdout': rows})()), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(bridge.agy_terminal(), '/dev/ttys012')

    def test_unrelated_agy_is_never_selected(self):
        rows = '20 1 ?? shell\n99 1 ttys099 agy\n'
        with patch.object(bridge.os, 'getppid', return_value=20), \
                patch.object(bridge.subprocess, 'run', return_value=type('Result', (), {'stdout': rows})()), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(bridge.agy_terminal())

    @unittest.skipIf(pty is None, 'PTY requires macOS or Linux')
    def test_partial_reaches_real_pty_before_job_completes(self):
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        captured = io.StringIO()
        args = bridge.build_parser().parse_args(['hello', '--stream', '--no-spinner'])

        def wait(job, timeout, spinner, on_partial):
            on_partial('first ')
            ready, _, _ = select.select([master], [], [], 1)
            self.assertTrue(ready, 'TTY output was delayed until job completion')
            self.assertEqual(os.read(master, 4096), b'first ')
            self.assertEqual(captured.getvalue(), 'first ')
            on_partial('first second')
            return {'text': 'first second final', 'status': 'done'}

        with contextlib.redirect_stdout(captured), \
                patch.object(bridge, 'agy_terminal', return_value=os.ttyname(slave)), \
                patch.object(bridge, 'build_prompt', return_value='hello'), \
                patch.object(bridge, 'request', return_value={'id': 'test'}), \
                patch.object(bridge, 'wait_for_job', side_effect=wait):
            bridge.cmd_ask(args, {'ready': True})
        self.assertEqual(captured.getvalue(), 'first second final\n')
        self.assertEqual(os.read(master, 4096).replace(b'\r\n', b'\n'), b'second final\n')

    def test_buffered_and_json_never_mirror_to_terminal(self):
        for flags in (['--no-stream'], ['--json', '--stream']):
            args = bridge.build_parser().parse_args(['hello', *flags])
            with contextlib.redirect_stdout(io.StringIO()), \
                    patch.object(bridge, 'agy_terminal') as discover, \
                    patch.object(bridge, 'build_prompt', return_value='hello'), \
                    patch.object(bridge, 'request', return_value={'id': 'test'}), \
                    patch.object(bridge, 'wait_for_job', return_value={'text': 'answer'}):
                bridge.cmd_ask(args, {'ready': True})
                discover.assert_not_called()


if __name__ == '__main__':
    unittest.main()
