#!/usr/bin/env python3
"""Install the bridge using only Node.js and the Python standard library."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1]
FILES = (
    'SKILL.md', 'bridge/server.mjs', 'mcp/server.mjs',
    'scripts/gemini_argon_bridge.py', 'scripts/install.py',
    'extension/manifest.json', 'extension/background.js', 'extension/content.js',
    'extension/popup.html', 'extension/popup.js',
    'bin/argon.cmd', 'bin/argon.ps1',
)


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
    path.chmod(0o600)


def install(*, home, destination, bin_dir, update_path=True, harness_binary=None):
    skill = home / '.gemini/config/skills/argon'
    # Existing symlinks are respected, including installations on another volume.
    destination = destination.resolve()
    if skill.exists() and skill.resolve() != destination:
        raise RuntimeError(f'Existing skill at {skill}; choose that directory as ARGON_INSTALL_DIR.')
    if skill.is_symlink() and skill.resolve() != destination:
        raise RuntimeError(f'Existing symlink at {skill} points elsewhere.')
    destination.mkdir(parents=True, exist_ok=True)
    if skill.resolve() != destination:
        skill.parent.mkdir(parents=True, exist_ok=True)
        # Directory junctions need no developer mode on Windows.
        if os.name == 'nt':
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(skill), str(destination)], check=True)
        else:
            skill.symlink_to(destination, target_is_directory=True)
    for name in FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if (SOURCE / name).resolve() != target.resolve():
            shutil.copy2(SOURCE / name, target)
    binary_name = 'argon-harness.exe' if os.name == 'nt' else 'argon-harness'
    if harness_binary is not None:
        harness_target = destination / 'bin' / binary_name
        harness_target.parent.mkdir(parents=True, exist_ok=True)
        # Replace atomically so an already running process can finish on its old binary.
        pending = harness_target.with_suffix('.pending')
        shutil.copy2(harness_binary, pending)
        pending.replace(harness_target)

    token_file = destination / 'bridge/token'
    if token_file.exists():
        token = token_file.read_text(encoding='utf-8').strip()
        if len(token) < 32 or any(c.isspace() for c in token):
            raise RuntimeError('Existing bridge/token is invalid; fix it before reinstalling.')
    else:
        token = secrets.token_hex(32)
    write_private(token_file, token + '\n')
    write_private(destination / 'extension/config.js', 'const ARGON_TOKEN = ' + json.dumps(token) + ';\n')
    bin_dir.mkdir(parents=True, exist_ok=True)
    python = shlex.quote(sys.executable)
    cli = shlex.quote(str(destination / 'scripts/gemini_argon_bridge.py'))
    launcher = bin_dir / 'argon'
    launcher.write_text(f'#!/bin/sh\nexec {python} {cli} "$@"\n', encoding='utf-8')
    launcher.chmod(0o755)
    for name in ('argon.cmd', 'argon.ps1'):
        target = bin_dir / name
        if (SOURCE / 'bin' / name).resolve() != target.resolve():
            shutil.copy2(SOURCE / 'bin' / name, target)
    if update_path:
        if os.name == 'nt':
            import winreg
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                try:
                    current, _ = winreg.QueryValueEx(key, 'Path')
                except FileNotFoundError:
                    current = ''
                if str(bin_dir).casefold() not in [p.casefold() for p in current.split(';')]:
                    winreg.SetValueEx(key, 'Path', 0, winreg.REG_EXPAND_SZ, str(bin_dir) + ';' + current)
            # Notify Explorer so newly opened terminals inherit the user PATH.
            import ctypes
            ctypes.windll.user32.SendMessageTimeoutW(0xffff, 0x1a, 0, ctypes.c_wchar_p('Environment'), 2, 1000, None)
        else:
            shell_name = Path(os.environ.get('SHELL', '/bin/sh')).name
            profile = home / ('.zshrc' if shell_name == 'zsh' else '.bashrc' if shell_name == 'bash' else '.profile')
            line = 'export PATH=' + shlex.quote(str(bin_dir)) + ':\"$PATH\" # argon-web-bridge'
            existing = profile.read_text(encoding='utf-8') if profile.exists() else ''
            if line not in existing.splitlines():
                with profile.open('a', encoding='utf-8') as handle:
                    handle.write('\n' + line + '\n')
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-start', action='store_true', help='Install files without starting the bridge or opening the browser')
    parser.add_argument('--no-open', action='store_true', help='Start the bridge without opening browser windows')
    parser.add_argument('--no-path', action='store_true', help='Do not change shell profiles or user PATH')
    parser.add_argument('--with-harness', action='store_true', help='Build and install the experimental Rust agent (requires Cargo)')
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        raise RuntimeError('Python 3.9+ is required.')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 20+ is required.')
    major = int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
    if major < 20:
        raise RuntimeError('Node.js 20+ is required.')
    harness_binary = None
    if args.with_harness:
        cargo = shutil.which('cargo')
        if not cargo:
            raise RuntimeError('Cargo is required for --with-harness. Install Rust first.')
        manifest = SOURCE / 'harness/Cargo.toml'
        if not manifest.is_file():
            raise RuntimeError('Rust harness source is missing; install from a full repository checkout.')
        subprocess.run([cargo, 'build', '--release', '--locked', '--manifest-path', str(manifest)], check=True)
        binary_name = 'argon-harness.exe' if os.name == 'nt' else 'argon-harness'
        harness_binary = SOURCE / 'harness/target/release' / binary_name
    home = Path.home()
    destination = Path(os.environ.get('ARGON_INSTALL_DIR', str(home / '.gemini/config/skills/argon'))).expanduser()
    root = install(home=home, destination=destination, bin_dir=home / '.local/bin',
                   update_path=not args.no_path, harness_binary=harness_binary)
    print(f'Installed: {root}\nExtension: {root / "extension"}', flush=True)
    print('Command: argon --start (open a new terminal if PATH is not refreshed)', flush=True)
    if not args.no_start:
        command = '--status' if args.no_open else '--setup'
        subprocess.run([sys.executable, str(root / 'scripts/gemini_argon_bridge.py'), command], check=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f'Install failed: {exc}', file=sys.stderr)
        sys.exit(1)
