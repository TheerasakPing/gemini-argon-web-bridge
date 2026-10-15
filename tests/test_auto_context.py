import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'auto_bridge', Path(__file__).resolve().parents[1] / 'scripts/gemini_argon_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AutoContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cwd = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.cwd)
        self.addCleanup(self.temp.cleanup)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def prompt(self, *flags, stdin=''):
        args = bridge.build_parser().parse_args(list(flags))
        with patch.object(bridge, 'read_stdin', return_value=stdin), \
                patch.dict(os.environ, {'ARGON_AUTO_CONTEXT': '1'}), \
                contextlib.redirect_stderr(io.StringIO()), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = bridge.build_prompt(args)
        self.assertEqual(stdout.getvalue(), '')
        return result

    def test_thai_overview_defaults_to_readme_manifest_and_entrypoint(self):
        self.write('README.md', 'Project overview')
        self.write('package.json', '{"scripts": {"start": "node src/index.ts"}}')
        self.write('src/index.ts', 'console.log("entry")')
        result = self.prompt('ทำความเข้าใจโปรเจคนี้จากสิ่งที่มีตอนนี้')
        for text in ('Project overview', 'package.json', 'src/index.ts', 'partial'):
            self.assertIn(text, result)

    def test_disable_and_explicit_inputs_override_auto(self):
        self.write('README.md', 'AUTO_ONLY')
        self.write('notes.txt', 'EXPLICIT_ONLY')
        self.assertEqual(self.prompt('hello', '--no-auto'), 'hello')
        self.assertNotIn('AUTO_ONLY', self.prompt('hello', '-f', 'notes.txt'))
        self.assertNotIn('AUTO_ONLY', self.prompt('hello', stdin='piped'))
        self.assertIn('AUTO_ONLY', self.prompt('hello', '--auto', stdin='piped'))
        self.assertEqual(self.prompt(), '')

    def test_env_can_disable_default(self):
        self.write('README.md', 'AUTO_ONLY')
        with patch.object(bridge, 'read_stdin', return_value=''), \
                patch.dict(os.environ, {'ARGON_AUTO_CONTEXT': '0'}):
            self.assertEqual(bridge.build_prompt(bridge.build_parser().parse_args(['hello'])), 'hello')

    def test_relevant_filename_wins_over_generic_files(self):
        for i in range(20):
            self.write(f'a{i}.py', 'unrelated')
        self.write('src/login.py', 'LOGIN_IMPLEMENTATION')
        self.assertIn('LOGIN_IMPLEMENTATION', self.prompt('fix login'))

    def test_gitignore_and_sensitive_files_excluded(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.write('.gitignore', 'ignored.py\n')
        for name in ('ignored.py', '.env', 'secrets.json', 'extension/config.js',
                     'bridge/history.jsonl', 'node_modules/a.js'):
            self.write(name, 'DO_NOT_SEND')
        self.write('settings.py', 'api_key = "' + 'x' * 32 + '"')
        self.write('README.md', 'SAFE')
        result = self.prompt('overview')
        self.assertIn('SAFE', result)
        self.assertNotIn('DO_NOT_SEND', result)
        self.assertNotIn('settings.py', result)

    def test_binary_symlink_and_large_files_excluded(self):
        self.write('README.md', 'SAFE')
        self.write('huge.py', 'x' * 256001)
        (self.root / 'binary.py').write_bytes(b'abc\0def')
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / 'external.py'
            target.write_text('EXTERNAL')
            (self.root / 'link.py').symlink_to(target)
            result = self.prompt('overview')
        for name in ('huge.py', 'binary.py', 'link.py', 'EXTERNAL'):
            self.assertNotIn(name, result)

    def test_context_budget_and_truncation(self):
        for i in range(20):
            self.write(f'file{i}.py', 'x' * 10000)
        result = self.prompt('overview')
        self.assertLessEqual(len(result), len('overview\n\n') + bridge.AUTO_MAX_CHARS)
        self.assertLessEqual(result.count('\n--- '), bridge.AUTO_MAX_FILES)
        self.assertIn('[truncated]', result)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertLessEqual(len(bridge.automatic_context('overview', 500)), 500)

    def test_home_directory_is_not_scanned(self):
        self.write('README.md', 'DO_NOT_SEND')
        with patch.object(bridge.Path, 'home', return_value=self.root):
            self.assertEqual(self.prompt('overview'), 'overview')


if __name__ == '__main__':
    unittest.main()
