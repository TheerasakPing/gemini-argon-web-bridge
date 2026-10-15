#!/usr/bin/env python3
"""Local Gemini web bridge CLI; no third-party Python dependencies."""
import argparse
import json
import os
import plistlib
import re
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8989'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MAX_PROMPT = 100000
SERVICE_LABEL = 'com.argon.bridge'
FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
WAVE = '▁▂▃▄▅▆▇█▇▆▅▄▃▂'
PHASES = {'queued': 'รอคิว', 'claimed': 'รับงานแล้ว', 'typing': 'กำลังพิมพ์คำถาม', 'sending': 'กำลังส่งไปยัง Gemini',
          'waiting': 'รอ Gemini เริ่มตอบ', 'generating': 'Gemini กำลังตอบ', 'finishing': 'กำลังรวบรวมคำตอบ',
          'running': 'กำลังทำงาน'}
_active_job = None


def agy_terminal():
    """Find only an ancestor agy's terminal when its tool captures stdout."""
    if os.name == 'nt' or sys.stdout.isatty():
        return None
    try:
        rows = subprocess.run(
            ['ps', '-axo', 'pid=,ppid=,tty=,comm='], capture_output=True,
            text=True, timeout=2, check=True).stdout.splitlines()
        processes = {}
        for row in rows:
            fields = row.strip().split(None, 3)
            if len(fields) == 4:
                processes[int(fields[0])] = (int(fields[1]), fields[2], fields[3])
        pid = os.getppid()
        for _ in range(32):
            entry = processes.get(pid)
            if not entry:
                break
            parent, tty, command = entry
            if Path(command).name == 'agy' and tty.startswith(('ttys', 'pts/')):
                return '/dev/' + tty
            if parent == pid:
                break
            pid = parent
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


class LiveOutput:
    """Flush captured stdout and mirror live text to the calling agy's TTY."""

    def __init__(self, enabled):
        self.terminal = None
        target = agy_terminal() if enabled else None
        if target:
            try:
                self.terminal = open(target, 'w', encoding='utf-8', buffering=1)
                if not self.terminal.isatty():
                    self.close()
            except OSError as exc:
                print(f'argon: live terminal unavailable: {exc}', file=sys.stderr)

    def write(self, text):
        sys.stdout.write(text)
        sys.stdout.flush()
        if self.terminal:
            # Web output must not inject terminal control sequences.
            safe = ''.join(c for c in text if c in '\n\t' or (ord(c) >= 32 and not 127 <= ord(c) <= 159))
            try:
                self.terminal.write(safe)
                self.terminal.flush()
            except OSError as exc:
                self.close()
                print(f'argon: live terminal disconnected: {exc}', file=sys.stderr)

    def close(self):
        if self.terminal:
            self.terminal.close()
            self.terminal = None


def request(path, payload=None, timeout=5):
    headers = {'Authorization': 'Bearer ' + (ROOT / 'bridge/token').read_text().strip()}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors='replace')[:500]
        raise RuntimeError(f'Bridge HTTP {exc.code}: {detail}') from exc


def health():
    data = request('/health')
    if data.get('service') != 'argon-web-bridge' or data.get('version') != 1:
        raise RuntimeError('Port 8989 is occupied by another service')
    return data


def ensure_server():
    try:
        return health()
    except urllib.error.URLError:
        pass
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js not found in PATH')
    log_path = ROOT / 'bridge/server.log'
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'ab') as log:
        options = {'stdin': subprocess.DEVNULL, 'stdout': log, 'stderr': log, 'cwd': ROOT}
        if os.name == 'nt':
            options['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            options['start_new_session'] = True
        process = subprocess.Popen([node, str(ROOT / 'bridge/server.mjs')], **options)
    for _ in range(50):
        try:
            state = health()
            if process.poll() is None:
                (ROOT / 'bridge/server.pid').write_text(str(process.pid) + '\n')
            return state
        except urllib.error.URLError:
            if process.poll() is not None:
                # A concurrent CLI may have won the bind race, or launchd owns the server.
                time.sleep(0.2)
                try:
                    return health()
                except urllib.error.URLError as exc:
                    raise RuntimeError(f'Server failed to start; inspect {log_path}') from exc
            time.sleep(0.1)
    raise RuntimeError(f'Server startup timed out; inspect {log_path}')


def use_color():
    return 'NO_COLOR' not in os.environ and sys.stderr.isatty()


class Spinner:
    """Single-line animated progress on stderr; silent unless stderr is a terminal."""

    def __init__(self, enabled):
        self.enabled = enabled and sys.stderr.isatty()
        self.tick = 0
        self.dirty = False

    def draw(self, phase, elapsed, chars):
        if not self.enabled:
            return
        frame = FRAMES[self.tick % len(FRAMES)]
        wave = ''.join(WAVE[(self.tick + i) % len(WAVE)] for i in range(8))
        self.tick += 1
        label = PHASES.get(phase, phase)
        extra = f' · {chars} ตัวอักษร' if chars else ''
        text = f'{frame} {wave} {label}… {elapsed:4.1f}s{extra}'
        start, end = ('\x1b[38;5;141m', '\x1b[0m') if use_color() else ('', '')
        sys.stderr.write(f'\r\x1b[2K{start}{text}{end}')
        sys.stderr.flush()
        self.dirty = True

    def clear(self):
        if self.enabled and self.dirty:
            sys.stderr.write('\r\x1b[2K')
            sys.stderr.flush()
            self.dirty = False
        self.enabled = False


def read_stdin(wait):
    stream = sys.stdin
    if stream is None or stream.isatty():
        return ''
    if not wait:
        # An idle inherited pipe must not hang `argon "question"`.
        try:
            ready, _, _ = select.select([stream], [], [], 0.3)
        except (OSError, ValueError):
            return ''
        if not ready:
            return ''
    try:
        stream.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    return stream.read()


def build_prompt(args):
    words = [w for w in args.prompt if w != '-']
    chunks = [' '.join(words).strip()] if words else []
    for name in args.file or []:
        path = Path(name).expanduser()
        try:
            chunks.append(f'--- {path.name} ---\n{path.read_text(encoding="utf-8")}')
        except (OSError, UnicodeDecodeError) as exc:
            raise RuntimeError(f'Cannot read {name}: {exc}') from exc
    piped = read_stdin(wait=not words or '-' in args.prompt).strip()
    if piped:
        chunks.append(piped)
    prompt = '\n\n'.join(c for c in chunks if c)
    if len(prompt) > MAX_PROMPT:
        raise RuntimeError(f'Prompt is {len(prompt)} characters; limit is {MAX_PROMPT}')
    return prompt


def wait_for_job(job_id, timeout, spinner, on_partial=None):
    """Poll a job; tolerate brief server restarts because the queue is persisted."""
    started = time.monotonic()
    deadline = started + timeout
    last_poll, result = 0.0, {}
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now - last_poll >= (0.1 if on_partial else 0.25):
            last_poll = now
            try:
                result = request('/jobs/' + job_id)
            except RuntimeError as exc:
                if 'HTTP 404' in str(exc):
                    raise RuntimeError('Job lost: server restarted before the job was saved') from exc
                raise
            except OSError:
                pass  # Server restarting; keep waiting until the client deadline.
            if on_partial and result.get('partial'):
                on_partial(result['partial'])
            if result.get('status') == 'done':
                return result
            if result.get('status') == 'error':
                raise RuntimeError(result.get('error') or 'Job failed')
        spinner.draw(result.get('phase', 'queued'), now - started, len(result.get('partial') or ''))
        time.sleep(0.1)
    raise RuntimeError(f'Client timeout for job {job_id}; it may still complete. Inspect Gemini before retrying.')


def ask_options(args):
    return {'newChat': bool(args.new), 'force': bool(args.force), 'tab': args.tab or ''}


def cmd_ask(args, state):
    global _active_job
    prompt = build_prompt(args)
    if not prompt:
        raise RuntimeError('provide a prompt, --file, or piped stdin')
    clients = state.get('clients', [])
    can_force = args.force and any(c.get('draft') for c in clients)
    if not state['ready'] and not can_force:
        raise RuntimeError('Extension/Gemini not ready. Load extension, open Gemini, sign in, clear drafts; run argon --status.')
    job = request('/ask', {'prompt': prompt, 'options': ask_options(args)})
    _active_job = job['id']
    spinner = Spinner(not args.json and not args.no_spinner)
    printed = ''
    output = LiveOutput(args.stream and not args.json)

    def on_partial(text):
        nonlocal printed
        if args.json or not args.stream or len(text) <= len(printed) or not text.startswith(printed):
            return
        boundaries = list(re.finditer(r'\s+', text[len(printed):]))
        if not boundaries:
            return
        end = len(printed) + boundaries[-1].end()
        spinner.clear()
        for chunk in re.findall(r'\S*\s+', text[len(printed):end]):
            output.write(chunk)
        printed = text[:end]

    try:
        result = wait_for_job(job['id'], args.timeout, spinner, on_partial if args.stream and not args.json else None)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.stream:
            text = result['text']
            tail = text[len(printed):] if text.startswith(printed) else '\n' + text
            for chunk in re.findall(r'\S*\s+|\S+$', tail):
                output.write(chunk)
            output.write('\n')
        else:
            print(result['text'])
    finally:
        spinner.clear()
        output.close()
        _active_job = None
    return 0


def cmd_tabs(state):
    rows = [(c.get('model', ''), t) for c in state.get('clients', []) for t in c.get('tabs', [])]
    if not rows:
        print('ไม่พบแท็บ Gemini (เปิด gemini.google.com แล้วลองใหม่)')
    for _, tab in rows:
        status = 'กำลังตอบ' if tab.get('generating') else 'พร้อม' if tab.get('ready') else 'ไม่พร้อม'
        print(f"{tab['id']:>8}  {status:<8}  {tab.get('title', '')}")
    return 0


def cmd_history(args):
    query = {'limit': args.history}
    if args.grep:
        query['q'] = args.grep
    items = request('/history?' + urllib.parse.urlencode(query))['items']
    if not items:
        print('ยังไม่มีประวัติ')
    for item in items:
        stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(item['created'] / 1000))
        body = item.get('text') or f"[error] {item.get('error', '')}"
        flat = lambda s, n: ' '.join(str(s).split())[:n]
        print(f"{stamp}  {item.get('ms', 0) / 1000:5.1f}s  Q: {flat(item['prompt'], 60)}\n{'':27}A: {flat(body, 100)}")
    return 0


def cmd_doctor(args):
    job = request('/doctor', {})
    spinner = Spinner(not args.no_spinner)
    try:
        result = wait_for_job(job['id'], min(args.timeout, 60), spinner)
    finally:
        spinner.clear()
    report = json.loads(result['text'])
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    mark = lambda ok: '✓' if ok else '✗'
    print(f"Extension v{report.get('extensionVersion', '?')}")
    checks = report.get('checks') or {}
    if report.get('error'):
        print(f"✗ {report['error']}")
    for key, label in [('editor', 'ช่องพิมพ์ (rich-textarea)'), ('send', 'ปุ่มส่ง (แสดงเฉพาะเมื่อมีข้อความ)'),
                       ('stop', 'ปุ่ม Stop (แสดงเฉพาะตอน Gemini กำลังตอบ)')]:
        if key in checks:
            print(f'{mark(checks[key])} {label}')
    if checks:
        print(f"  โมเดลบนหน้าเว็บ: {checks.get('model')}   คำตอบในหน้า: {checks.get('answers')}   URL: {checks.get('url')}")
    for tab in report.get('tabs', []):
        print(f"  แท็บ {tab['id']}: {tab.get('title')}  ready={tab.get('state', {}).get('ready')}")
    return 0 if checks.get('editor') else 1


def server_pid():
    # Prefer the real listener: server.pid can be stale after launchd or manual restarts.
    try:
        out = subprocess.run(['lsof', '-ti', 'tcp:8989', '-sTCP:LISTEN'], capture_output=True, text=True, timeout=5).stdout
        return int(out.split()[0])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass
    try:
        return int((ROOT / 'bridge/server.pid').read_text().strip())
    except (OSError, ValueError):
        return None


def stop_server():
    try:
        health()
    except (OSError, RuntimeError):
        return
    pid = server_pid()
    if pid is None:
        raise RuntimeError('Server is running but its PID is unknown; stop it manually')
    os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        try:
            health()
        except OSError:
            return
        time.sleep(0.1)
    raise RuntimeError('Server did not stop')


def plist_path():
    return Path.home() / 'Library/LaunchAgents' / f'{SERVICE_LABEL}.plist'


def cmd_install_service():
    if sys.platform != 'darwin':
        raise RuntimeError('--install-service supports macOS launchd only; on Linux create a systemd user unit that runs: '
                           f'node {ROOT / "bridge/server.mjs"}')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js not found in PATH')
    stop_server()
    # launchd agents are often denied chdir/log access on external volumes (EX_CONFIG),
    # so keep the working directory and log on the system volume.
    log_dir = Path.home() / 'Library/Logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log = str(log_dir / 'argon-bridge.log')
    plist = {'Label': SERVICE_LABEL, 'ProgramArguments': [node, str(ROOT / 'bridge/server.mjs')],
             'RunAtLoad': True, 'KeepAlive': True, 'StandardOutPath': log, 'StandardErrorPath': log}
    path = plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'wb') as handle:
        plistlib.dump(plist, handle)
    domain = f'gui/{os.getuid()}'
    subprocess.run(['launchctl', 'bootout', f'{domain}/{SERVICE_LABEL}'], capture_output=True)
    done = subprocess.run(['launchctl', 'bootstrap', domain, str(path)], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f'launchctl bootstrap failed: {done.stderr.strip()}')
    for _ in range(50):
        try:
            health()
            print(f'ติดตั้งแล้ว: {path}\nserver จะเริ่มเองทุกครั้งที่ล็อกอิน (ถอนด้วย argon --uninstall-service)')
            return 0
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f'Service installed but server did not respond; inspect {log}')


def cmd_uninstall_service():
    if sys.platform != 'darwin':
        raise RuntimeError('--uninstall-service supports macOS launchd only')
    subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}/{SERVICE_LABEL}'], capture_output=True)
    path = plist_path()
    if path.exists():
        path.unlink()
    print('ถอนการติดตั้ง service แล้ว (server จะถูกเปิดเองเมื่อรัน argon ครั้งถัดไป)')
    return 0


def cmd_mcp_config():
    entry = {'command': shutil.which('node') or 'node', 'args': [str(ROOT / 'mcp/server.mjs')]}
    print(json.dumps({'mcpServers': {'argon': entry}}, indent=2))
    print(f"\nหรือ: claude mcp add argon -- {entry['command']} {entry['args'][0]}")
    return 0


def open_browser(setup=False):
    urls = ['https://gemini.google.com/']
    if setup:
        urls.insert(0, 'chrome://extensions/')
        print(f'Developer mode → Load unpacked → {ROOT / "extension"}', flush=True)
    if sys.platform == 'darwin':
        apps = ['Brave Browser Beta', 'Brave Browser', 'Google Chrome']
        app = next((name for name in apps if any(
            (base / f'{name}.app').exists() for base in (Path('/Applications'), Path.home() / 'Applications'))), None)
        command = ['open'] + (['-a', app] if app else [])
        for url in urls:
            subprocess.run(command + [url], check=True)
        if setup:
            subprocess.run(['open', str(ROOT / 'extension')], check=True)
    else:
        for url in urls:
            if not webbrowser.open(url):
                print(f'Open in Chrome/Brave: {url}', file=sys.stderr)
        if setup and os.name == 'nt':
            os.startfile(str(ROOT / 'extension'))


def build_parser():
    parser = argparse.ArgumentParser(description='Send prompts to the selected model in your Gemini web tab')
    parser.add_argument('prompt', nargs='*', help="prompt text; '-' inserts piped stdin")
    parser.add_argument('--status', action='store_true', help='Start server if needed and show readiness')
    parser.add_argument('--tabs', action='store_true', help='List open Gemini tabs')
    parser.add_argument('--history', nargs='?', const=20, type=int, metavar='N', help='Show the last N exchanges')
    parser.add_argument('--grep', help='Filter --history by text')
    parser.add_argument('--doctor', action='store_true', help='Check Gemini page selectors through the extension')
    parser.add_argument('--new', '-n', action='store_true', help='Open a fresh Gemini chat before sending')
    parser.add_argument('--file', '-f', action='append', help='Append a text file to the prompt (repeatable)')
    parser.add_argument('--tab', help='Target tab by id or title substring (see --tabs)')
    parser.add_argument('--force', action='store_true', help='Stash and restore an unsent draft in the composer')
    streaming = parser.add_mutually_exclusive_group()
    streaming.add_argument('--stream', dest='stream', action='store_true', help='Print live text from the Gemini page (default)')
    streaming.add_argument('--no-stream', dest='stream', action='store_false', help='Wait for the complete answer before printing')
    parser.set_defaults(stream=None)
    parser.add_argument('--json', action='store_true', help='Print structured job result')
    parser.add_argument('--no-spinner', action='store_true', help='Disable the progress animation')
    parser.add_argument('--timeout', type=float, default=190, help='Client wait in seconds; server job limit is 180s')
    parser.add_argument('--install-service', action='store_true', help='Start the server automatically at login (macOS)')
    parser.add_argument('--uninstall-service', action='store_true', help='Remove the login service')
    parser.add_argument('--mcp-config', action='store_true', help='Print MCP client configuration')
    parser.add_argument('--start', action='store_true', help='Start the bridge and open Gemini in the browser')
    parser.add_argument('--setup', action='store_true', help='Start bridge and open browser extension setup and Gemini')
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if args.stream is None:
        args.stream = os.environ.get('ARGON_STREAM', '1').strip().lower() not in {'0', 'false', 'no', 'off'}
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    if args.mcp_config:
        return cmd_mcp_config()
    if args.install_service:
        return cmd_install_service()
    if args.uninstall_service:
        return cmd_uninstall_service()
    state = ensure_server()
    if args.start or args.setup:
        open_browser(setup=args.setup)
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    if args.status:
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    if args.tabs:
        return cmd_tabs(state)
    if args.history is not None:
        return cmd_history(args)
    if args.doctor:
        return cmd_doctor(args)
    return cmd_ask(args, state)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        if _active_job:
            try:
                request(f'/jobs/{_active_job}/cancel', {})
                print('\nยกเลิกงานที่ยังไม่ถูกส่งแล้ว', file=sys.stderr)
            except (OSError, RuntimeError):
                print('\nInterrupted; submitted job may still complete. Inspect Gemini before retrying.', file=sys.stderr)
        else:
            print('Interrupted.', file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f'argon: {exc}', file=sys.stderr)
        sys.exit(1)
