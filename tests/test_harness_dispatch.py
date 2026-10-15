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
    def test_dispatch_preserves_arguments_and_install_root(self):
        with tempfile.TemporaryDirectory(prefix='argon binary ') as directory:
            root = Path(directory)
            binary = root / 'bin' / ('argon-harness.exe' if os.name == 'nt' else 'argon-harness')
            binary.parent.mkdir()
            binary.write_bytes(b'fixture')
            with patch.object(bridge, 'ROOT', root), \
                    patch.object(bridge.sys, 'argv', ['argon', 'agent', 'คำถามมีช่องว่าง']), \
                    patch.object(bridge, 'ensure_server', return_value={'agentProtocol': 1}), \
                    patch.object(bridge.subprocess, 'call', return_value=0) as call:
                self.assertEqual(bridge.main(), 0)
            self.assertEqual(call.call_args.args[0], [str(binary), 'agent', 'คำถามมีช่องว่าง'])
            self.assertEqual(call.call_args.kwargs['env']['ARGON_ROOT'], str(root))

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
