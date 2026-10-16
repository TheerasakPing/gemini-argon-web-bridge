import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'dispatch_bridge', Path(__file__).resolve().parents[1] / 'scripts/gemini_argon_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class HarnessDispatchTests(unittest.TestCase):
    def test_recover_inspection_routes_without_starting_server(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'bin' / ('argon-harness.exe' if os.name == 'nt' else 'argon-harness')
            binary.parent.mkdir()
            binary.write_bytes(b'fixture')
            with patch.object(bridge, 'ROOT', root), \
                    patch.object(bridge.sys, 'argv', ['argon', 'recover', 'session-id', '--json']), \
                    patch.object(bridge, 'ensure_server') as start, \
                    patch.object(bridge.subprocess, 'call', return_value=0) as call:
                self.assertEqual(bridge.main(), 0)
                start.assert_not_called()
                self.assertEqual(call.call_args.args[0], [str(binary), 'recover', 'session-id', '--json'])

    def test_dispatch_preserves_arguments_and_install_root(self):
        with tempfile.TemporaryDirectory(prefix='argon binary ') as directory:
            root = Path(directory)
            binary = root / 'bin' / ('argon-harness.exe' if os.name == 'nt' else 'argon-harness')
            binary.parent.mkdir()
            binary.write_bytes(b'fixture')
            with patch.object(bridge, 'ROOT', root), \
                    patch.object(bridge.sys, 'argv', ['argon', 'agent', 'คำถามมีช่องว่าง']), \
                    patch.object(bridge, 'ensure_server', return_value={'agentProtocol': 1}), \
                    patch.object(bridge, 'agy_terminal', return_value=None), \
                    patch.object(bridge.subprocess, 'call', return_value=0) as call:
                self.assertEqual(bridge.main(), 0)
            self.assertEqual(call.call_args.args[0], [str(binary), 'agent', 'คำถามมีช่องว่าง'])
            self.assertEqual(call.call_args.kwargs['env']['ARGON_ROOT'], str(root))

    def test_json_dispatch_never_discovers_or_mirrors_terminal(self):
        with patch.object(bridge, 'agy_terminal') as discover, \
                patch.object(bridge.subprocess, 'Popen') as piped, \
                patch.object(bridge.subprocess, 'call', return_value=7) as call:
            self.assertEqual(bridge.run_harness(['harness', 'agent', '--json', 'task'], {}), 7)
            discover.assert_not_called()
            piped.assert_not_called()
            call.assert_called_once_with(['harness', 'agent', '--json', 'task'], env={})

    def test_mirrored_cancellation_kills_and_reaps_child(self):
        with patch.object(bridge, 'LiveOutput') as output, \
                patch.object(bridge.subprocess, 'Popen') as spawn, \
                patch.object(bridge.os, 'read', side_effect=KeyboardInterrupt):
            child = spawn.return_value
            child.wait.side_effect = [bridge.subprocess.TimeoutExpired('harness', 0.25), 0]
            with self.assertRaises(KeyboardInterrupt):
                bridge.run_harness(['harness', 'agent', 'task'], {})
            self.assertEqual(spawn.call_args.kwargs, {'env': {}, 'stdout': bridge.subprocess.PIPE})
            child.kill.assert_called_once_with()
            self.assertEqual(child.wait.call_count, 2)
            self.assertEqual(child.wait.call_args_list[0].kwargs, {'timeout': 0.25})
            child.stdout.close.assert_called_once_with()
            output.return_value.close.assert_called_once_with()

    def test_mirrored_cancellation_allows_child_cleanup(self):
        with patch.object(bridge, 'LiveOutput'), \
                patch.object(bridge.subprocess, 'Popen') as spawn, \
                patch.object(bridge.os, 'read', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                bridge.run_harness(['harness', 'agent', 'task'], {})
            spawn.return_value.kill.assert_not_called()
            spawn.return_value.wait.assert_called_once_with(timeout=0.25)

    def test_missing_binary_and_old_bridge_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(bridge, 'ROOT', root), \
                    patch.object(bridge.sys, 'argv', ['argon', 'agent', 'task']):
                with self.assertRaisesRegex(RuntimeError, 'not installed'):
                    bridge.main()
                binary = root / 'bin' / ('argon-harness.exe' if os.name == 'nt' else 'argon-harness')
                binary.parent.mkdir()
                binary.write_bytes(b'fixture')
                with patch.object(bridge, 'ensure_server', return_value={}):
                    with self.assertRaisesRegex(RuntimeError, 'needs restart'):
                        bridge.main()
