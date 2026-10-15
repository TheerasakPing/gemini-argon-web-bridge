import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'installer', Path(__file__).resolve().parents[1] / 'scripts/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_clean_install_pairs_token_and_extension_and_keeps_existing_data_on_update(self):
        with tempfile.TemporaryDirectory(prefix='argon install ') as directory:
            home = Path(directory)
            root = home / '.gemini/config/skills/argon'
            bin_dir = home / '.local/bin'
            installer.install(home=home, destination=root, bin_dir=bin_dir, update_path=False)
            first = (root / 'bridge/token').read_text().strip()
            self.assertEqual(len(first), 64)
            config = (root / 'extension/config.js').read_text()
            self.assertEqual(json.loads(config.split(' = ', 1)[1].rstrip(';\n')), first)
            history = root / 'bridge/history.jsonl'
            history.write_text('keep private history\n')
            installer.install(home=home, destination=root, bin_dir=bin_dir, update_path=False)
            self.assertEqual((root / 'bridge/token').read_text().strip(), first)
            self.assertEqual(history.read_text(), 'keep private history\n')
            self.assertTrue((bin_dir / 'argon').stat().st_mode & 0o111)
            self.assertTrue((root / 'bin/argon.cmd').exists())
            self.assertFalse((home / '.zshrc').exists())
            if os.name != 'nt':
                self.assertEqual((root / 'bridge/token').stat().st_mode & 0o777, 0o600)

    @unittest.skipIf(os.name == 'nt', 'POSIX launcher smoke test')
    def test_installer_command_and_launcher_work_with_spaces_in_home(self):
        with tempfile.TemporaryDirectory(prefix='argon home ') as directory:
            env = {**os.environ, 'HOME': directory}
            env.pop('ARGON_INSTALL_DIR', None)
            result = subprocess.run([sys.executable, str(installer.SOURCE / 'scripts/install.py'),
                                     '--no-start', '--no-path'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            launcher = Path(directory) / '.local/bin/argon'
            result = subprocess.run([str(launcher), '--mcp-config'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(Path(directory) / '.gemini/config/skills/argon/mcp/server.mjs'), result.stdout)

    def test_each_install_has_a_unique_token(self):
        with tempfile.TemporaryDirectory() as directory:
            tokens = []
            for name in ('one', 'two'):
                home = Path(directory) / name
                root = home / '.gemini/config/skills/argon'
                installer.install(home=home, destination=root, bin_dir=home / '.local/bin', update_path=False)
                tokens.append((root / 'bridge/token').read_text())
            self.assertNotEqual(*tokens)

    def test_conflicting_skill_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            skill = home / '.gemini/config/skills/argon'
            skill.mkdir(parents=True)
            marker = skill / 'existing.txt'
            marker.write_text('keep')
            with self.assertRaisesRegex(RuntimeError, 'Existing skill'):
                installer.install(home=home, destination=home / 'other', bin_dir=home / '.local/bin')
            self.assertEqual(marker.read_text(), 'keep')
            self.assertFalse((home / 'other').exists())

    @unittest.skipIf(installer.os.name == 'nt', 'Avoid changing the real Windows user PATH in tests')
    def test_path_entry_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            root = home / '.gemini/config/skills/argon'
            for _ in range(2):
                installer.install(home=home, destination=root, bin_dir=home / '.local/bin')
            if installer.os.name != 'nt':
                profiles = list(home.glob('.*rc')) + list(home.glob('.profile'))
                self.assertEqual(len(profiles), 1)
                self.assertEqual(profiles[0].read_text().count('# argon-web-bridge'), 1)

    @unittest.skipIf(installer.os.name == 'nt', 'Unix symlink case')
    def test_existing_symlink_install_uses_original_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            target = home / 'external volume/argon'
            target.mkdir(parents=True)
            skill = home / '.gemini/config/skills/argon'
            skill.parent.mkdir(parents=True)
            skill.symlink_to(target, target_is_directory=True)
            installer.install(home=home, destination=skill, bin_dir=home / '.local/bin', update_path=False)
            self.assertTrue(skill.is_symlink())
            self.assertTrue((target / 'bridge/server.mjs').exists())


if __name__ == '__main__':
    unittest.main()
