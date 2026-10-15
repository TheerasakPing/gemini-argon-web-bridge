#!/usr/bin/env python3
"""Opt-in, serial Gemini Web acceptance suite using disposable non-secret projects.

Never runs as part of unit tests or CI. Requires the user's connected Gemini tab.
No mutation approvals are automated; this suite exercises read-only agent tasks.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import uuid


def health():
    with urllib.request.urlopen('http://127.0.0.1:8989/health', timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--count', type=int, default=10, choices=range(1, 11))
    parser.add_argument('--start-case', type=int, default=1)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = args.output or Path(tempfile.mkdtemp(prefix='argon-live-acceptance-'))
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    results = []
    questions = [
        'อธิบายหน้าที่โปรเจคและ entrypoint',
        'หาข้อผิดพลาดในฟังก์ชัน add โดยไม่แก้ไฟล์',
        'ระบุวิธีรันโปรเจคจาก README',
        'อธิบาย input/output ของฟังก์ชัน add',
        'แยกเจตนาตาม README กับ behavior จริงของ source',
        'เสนอกรณีทดสอบฟังก์ชัน add แต่ยังไม่สร้างไฟล์หรือรัน',
        'อธิบายโครงสร้างโปรเจคพร้อมตำแหน่งไฟล์',
        'ระบุการเปลี่ยนแปลงขั้นต่ำเพื่อให้ตรง README โดยไม่แก้ไฟล์',
        'อธิบายค่าคงที่และฟังก์ชันที่มีใน source',
        'สรุปสิ่งที่ยืนยันจากไฟล์และสิ่งที่ยังไม่ได้รันทดสอบ',
    ]
    print(json.dumps({'output': str(output)}, ensure_ascii=False), flush=True)
    for index in range(args.start_case, args.start_case + args.count):
        status = health()
        if status.get('queue') or status.get('agentLeased') or not status.get('ready'):
            print(json.dumps({'blocked': 'Bridge/tab unavailable; no new task submitted',
                              'completed': len(results)}, ensure_ascii=False), flush=True)
            break
        case = output / f'case-{index:02d}'
        project = case / 'project'
        project.mkdir(parents=True)
        marker = f'CHECK_{index:02d}_{uuid.uuid4().hex[:10]}'
        seed = uuid.uuid4().int
        entrypoint = f'calc_{uuid.uuid4().hex[:6]}.py'
        left, right = seed % 83 + 12, (seed // 83) % 7 + 2
        operator = '-' if seed % 2 else '*'
        expected_output = left - right if operator == '-' else left * right
        original = {
            'README.md': (
                f'# Arithmetic fixture\nEntrypoint: {entrypoint}\nRun: python3 {entrypoint}\n'
                'Intent: add(a, b) returns the sum of two numbers.\n'),
            entrypoint: (
                f'CHECK_ID = "{marker}"\n\ndef add(a, b):\n    return a {operator} b\n'
                f'\nif __name__ == "__main__":\n    print(add({left}, {right}))\n'),
        }
        for name, content in original.items():
            (project / name).write_text(content, encoding='utf-8')
        prompt = (
            questions[(index - 1) % len(questions)] +
            ' ในโปรเจค fixture นี้ ต้องใช้ list_files ก่อน แล้วใช้ read_file อ่าน README.md และไฟล์ entrypoint '
            'แยกกันให้ครบก่อน final (อย่างน้อย 3 tool calls) '
            'คำตอบสุดท้ายระบุ CHECK_ID จริงจาก source และอ้าง README.md กับ entrypoint '
            'ห้ามเดาค่า CHECK_ID ห้ามแก้ไฟล์หรือรัน command '
            'ก่อน control envelope ให้เขียนคำอธิบายความคืบหน้าจากหลักฐาน 4-6 ประโยค '
            'ปิดท้ายคำตอบใน final.text ด้วยรูปแบบ FACTS: entry=<ชื่อไฟล์>; '
            'intent=<คำนามผลลัพธ์ที่ README บอกว่า add คืนค่า เช่น sum/product ไม่ใช่ชื่อฟังก์ชัน>; actual=<เครื่องหมาย operator จริง>; '
            'output=<จำนวนเต็มที่โปรแกรมจะพิมพ์> โดยอนุมานค่าทั้งหมดจากไฟล์ '
            'ตอบกระชับ ใช้ JSON escaping ให้ถูกต้อง'
        )
        started = time.monotonic()
        with (case / 'stdout.jsonl').open('w') as out, (case / 'stderr.txt').open('w') as err:
            process = subprocess.Popen(
                [str(args.binary.resolve()), 'agent', prompt, '--read-only', '--json',
                 '--max-turns', '10', '--max-seconds', '240',
                 '--state-dir', str(case / 'sessions')],
                cwd=project, stdout=out, stderr=err)
            try:
                code = process.wait(timeout=265)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                code = -1
        states = list((case / 'sessions').glob('*/state.json'))
        state = json.loads(states[0].read_text()) if states else {}
        events = []
        for line in (case / 'stdout.jsonl').read_text().splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        final = next((e['data']['text'] for e in reversed(events) if e['event'] == 'final'), '')
        calls = list(state.get('calls', {}).values())
        successes = [c for c in calls if c.get('result', {}).get('status') == 'success']
        read_paths = {c['action']['path'] for c in successes if c['action']['type'] == 'read_file'}
        tool_history = [entry for entry in state.get('transcript', [])
                        if entry.get('kind') == 'tool_result']
        listed_files = bool(tool_history and
                            tool_history[0]['action']['type'] == 'list_files' and
                            tool_history[0]['result']['status'] == 'success')
        partials = [e for e in events if e['event'] == 'assistant_delta']
        before_final = any(e.get('at_ms', 0) < next(
            (f.get('at_ms', 0) for f in events if f['event'] == 'final'), 0) for e in partials)
        facts = dict(re.findall(r'\b(entry|intent|actual|output)\s*=\s*([^;\s`]+)', final))
        facts_correct = facts == {
            'entry': entrypoint, 'intent': 'sum', 'actual': operator,
            'output': str(expected_output),
        }
        fixture_unchanged = ({
            str(path.relative_to(project)): path.read_text(encoding='utf-8')
            for path in project.rglob('*') if path.is_file()
        } == original)
        generating_partials = [
            event for event in partials
            if event['data'].get('job_status') == 'running'
            and event['data'].get('job_phase') == 'generating'
            and event['data'].get('text')
        ]
        partials_by_job = {}
        for event in generating_partials:
            job_id = event['data'].get('job_id')
            if job_id:
                partials_by_job.setdefault(job_id, []).append(event)
        streamed_jobs = [
            job_id for job_id, samples in partials_by_job.items()
            if len(samples) >= 2 and samples[-1]['at_ms'] - samples[0]['at_ms'] >= 100
        ]
        streaming_verified = bool(streamed_jobs)
        passed = (code == 0 and state.get('status') == 'final' and marker in final
                  and {'README.md', entrypoint} <= read_paths and len(successes) >= 3
                  and before_final and not state.get('pending')
                  and facts_correct and fixture_unchanged and listed_files
                  and streaming_verified)
        result = {
            'case': index, 'passed': passed, 'exit_code': code,
            'status': state.get('status'), 'turns': state.get('turns'),
            'successful_tools': len(successes), 'read_paths': sorted(read_paths),
            'marker_correct': marker in final, 'partial_before_final': before_final,
            'facts_correct': facts_correct, 'fixture_unchanged': fixture_unchanged,
            'listed_files_first': listed_files,
            'streaming_verified': streaming_verified,
            'generating_partial_events': len(generating_partials),
            'streamed_jobs': streamed_jobs,
            'partial_events': len(partials),
            'repairs': sum(e['event'] == 'protocol_error' for e in events),
            'elapsed_seconds': round(time.monotonic() - started, 2),
        }
        results.append(result)
        (output / 'report.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if not passed:
            print(json.dumps({'blocked': 'Failed run requires inspection before another submission',
                              'completed': len(results)}, ensure_ascii=False), flush=True)
            break
    passed = sum(r['passed'] for r in results)
    print(json.dumps({'passed': passed, 'completed': len(results),
                      'gate_met': len(results) == 10 and passed >= 9}), flush=True)
    return 0 if len(results) == args.count and passed >= max(1, args.count - 1) else 1


if __name__ == '__main__':
    raise SystemExit(main())
