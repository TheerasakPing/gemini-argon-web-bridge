# แผนสร้าง Argon Agent Harness

สถานะ: ส่งมอบ Rust harness v0.1.0 แบบ experimental; live gate 10 งานยังไม่ผ่าน  
วันที่: 16 ตุลาคม 2026  
ฐานโค้ด: Argon Web Bridge, commit `cd7d562`

## เป้าหมาย

ต่อยอด Argon เป็น coding agent ใน terminal ที่ค้นหาและอ่านโปรเจคตามงาน
เสนอและแก้ patch รันทดสอบ และทำงานหลายรอบผ่าน Gemini Web Bridge เดิม
ผู้ใช้เริ่มจากคำสั่งเดียว และเห็นข้อความตอบ สถานะ tool รายละเอียด action ที่เสนอและผลการทำงาน

ตัวอย่างงานแรกที่ต้องรองรับ:

```sh
argon agent --read-only "ทำความเข้าใจโปรเจคนี้จากสิ่งที่มีตอนนี้ อธิบายโครงสร้างและ flow หลัก พร้อมอ้างไฟล์"
```

ตัวอย่างหลังเพิ่มการแก้โค้ดและรันทดสอบ:

```sh
argon agent --allow-edit --allow-commands "หาสาเหตุ login ไม่ทำงาน แก้ให้ แล้วรัน tests ที่เกี่ยวข้อง"
argon sessions
argon resume SESSION_ID
```

คำสั่งในตัวอย่างใช้งานได้แล้ว; ส่วนที่ระบุ roadmap หรือเกณฑ์ release ยังเป็นงานถัดไป
การทำ harness ไม่เพิ่มสิทธิ์ใช้โมเดลหรือ quota ของบัญชี Gemini

## ขอบเขตรุ่นแรก

- ใช้ Rust สำหรับ agent loop และ local tools; Python CLI เดิมส่งต่อ subcommands ไปยัง binary
- ใช้ Node bridge และ extension เป็นช่องทางส่ง prompt/รับคำตอบ
- เริ่มจาก file tools และอ่านได้อย่างเดียว ก่อนเปิดการแก้ไฟล์
- คำสั่ง `argon "คำถาม"` เดิมยังทำงานแบบ bridge พร้อม auto context
- เข้าสู่ harness ผ่าน `argon agent` อย่างชัดเจน
- หนึ่ง session จองแท็บด้วย lease และเปิด fresh conversation ทุก model turn
- ไม่เพิ่ม cloud backend, vector database, multi-agent หรือ full-screen TUI ในรุ่นแรก
- MCP เดิมคงเป็น interface เรียก bridge; ยังไม่เปิด remote tool ให้แก้เครื่อง

## สิ่งที่ใช้ต่อได้และส่วนที่ต้องเพิ่ม

| ส่วน | ใช้ต่อ | ต้องเพิ่ม |
| --- | --- | --- |
| Python CLI | daemon lifecycle, streaming, auto context | command routing ไป Rust; loop/tools/sessions อยู่ใน Rust |
| Node bridge | authenticated jobs, queue, progress, history | session ownership, tab lease, job reconciliation |
| Extension | auto injection, compose/submit, response extraction | เพิ่ม document/composer/conversation identity validation ในรุ่นทดลองแล้ว; รอ live verification |
| Installer | symlink install, token preservation, launchers | copy package harness ใหม่และ smoke tests |
| Tests | bridge, extension, streaming, installation | protocol, file boundaries, recovery และ task fixtures |

## โครงสร้างที่เสนอ

```text
harness/
  Cargo.toml
  src/
    main.rs                   # CLI และ routing
    agent.rs                  # state machine และ limits
    protocol.rs               # typed actions และ incremental display
    provider.rs               # bridge adapter และ lease
    workspace.rs              # file tools, hashes, approved edits
    command.rs                # argv execution, timeout และ cancel
    session.rs                # durable journal และ resume
  tests/
    bridge_agent.rs           # wrapper เรียก tests/harness.test.mjs
scripts/
  gemini_argon_bridge.py       # CLI เดิมและ routing
```

เพิ่มไฟล์ตามระยะที่ใช้งานจริง ไม่สร้าง module ว่างรอไว้
แยก provider adapter เพื่อให้ loop ทดสอบด้วย fake provider ได้
รุ่นแรกมี Gemini Web provider เพียงตัวเดียว

## Agent loop และ protocol

```text
รับงาน → ตั้ง workspace/session → ส่งข้อมูลเริ่มต้น → รอผลโมเดลครบ
  → ตรวจ protocol → ตรวจ permission → เรียก tool
  → บันทึกผล → ส่งผลกลับโมเดล → ทำรอบถัดไป
  → final / blocked / cancelled / failed
```

เสนอให้คำตอบแต่ละรอบแบ่งเป็น:

1. ข้อความอัปเดตที่แสดงใน terminal ระหว่างหน้าเว็บตอบ
2. action envelope ที่มี delimiter ชัดเจนและ JSON schema แบบ versioned

ตัวอย่างโครงสร้าง action:

```json
{
  "version": 1,
  "nonce": "request-uuid",
  "id": "call_001",
  "action": {"type": "read_file", "path": "src/main.py", "start_line": 1, "end_line": 120}
}
```

- ครอบ JSON ด้วย `<<<ARGON_ACTION>>>` และ `<<<END_ARGON_ACTION>>>`; หนึ่ง typed action ต่อรอบ
- ตรวจชื่อ tool, arguments, types, limits และ duplicate keys อย่างเคร่งครัด
- ประมวลผล envelope เมื่อ bridge ยืนยันคำตอบเสร็จเท่านั้น
- ไม่รัน tool จาก partial streaming หรือ JSON ตัวอย่างในเนื้อหาไฟล์
- parser ยอมรับเฉพาะตำแหน่ง envelope ที่กำหนด ปฏิเสธ action หลายชุดหรือปะปนกำกวม
- malformed output ให้โมเดลแก้ format ได้ไม่เกิน 2 ครั้ง แล้วหยุดพร้อมเหตุผล
- duplicate call ID ที่ arguments เดิมคืนผลบันทึก; arguments ต่างกันให้ error
- tool output มี `status`, `summary`, `data`, `artifacts`, `next_actions`
- ข้อผิดพลาดระบุสาเหตุ วิธีแก้ และเงื่อนไขหยุด ไม่ retry ผลข้างเคียงแบบอัตโนมัติ

Gemini API มี function calling โดยให้ application execute function และส่งผลกลับ
แต่ bridge เว็บนี้ไม่ได้ให้ native function-call objects จึงต้องพิสูจน์ protocol ข้อความเอง
ห้ามถือว่าการรองรับใน API ทำให้หน้าเว็บเชื่อฟัง schema ได้เท่ากัน

อ้างอิง: https://ai.google.dev/gemini-api/docs/function-calling

## Tools และ permission

| Tool | ขอบเขต | รุ่น |
| --- | --- | --- |
| `list_files` | relative paths, จำกัด depth/count | อ่านโปรเจค |
| `search_text` | literal search ใน Rust, จำกัด 2,000 ไฟล์/50 matches และ output | อ่านโปรเจค |
| `read_file` | UTF-8, line range, จำกัดขนาด | อ่านโปรเจค |
| `edit_file` | SHA-256 preimage, exact anchor, preview arguments, atomic write ต่อไฟล์ | แก้ไฟล์ |
| `create_file` | UTF-8 ไฟล์ใหม่, parent ต้องมี, ปฏิเสธ overwrite | แก้ไฟล์ |
| `run_command` | argv array, cwd ภายใน root, timeout, จำกัด output | รันทดสอบ |

กฎ:

- root เป็น working directory ตอนเริ่ม session; model เปลี่ยน root เองไม่ได้
- ใช้ workspace policy เดียวกันสำหรับ discovery, search และ read
- explicit ignore config และ user policy มีผลเหนือ model instructions
- ปิดการอ่าน secrets ตามชื่อ/ชนิดไฟล์ที่กำหนด; ตัวกรองไม่รับประกันตรวจทุก secret
- ปฏิเสธ path traversal, symlink escape และ binary; ทดสอบ Windows paths ด้วย
- `--read-only` ไม่แสดง tools แก้ไฟล์/รัน command และ executor ปฏิเสธซ้ำอีกชั้น
- การอ่าน source เป็น automatic ได้; patch และ command แสดง scope ให้ผู้ใช้อนุมัติใน terminal
- approval ผูกกับ arguments และ hash ของเนื้อหาจริง ไม่ใช่ข้อความสรุปจากโมเดล
- ไม่มี built-in delete/deploy/push/migration tools; command ที่ผู้ใช้อนุมัติยังทำสิ่งเหล่านี้ได้
- ไม่ใช้ `shell=True`; argv แยกจาก OS isolation
  เมื่อเปิด commands ใช้ macOS sandbox เป็นค่าเริ่มต้น ปิด network และจำกัดข้อมูลใน workspace
  พร้อม system runtime prefixes; `--no-sandbox` ต้องเลือกเองและหมายถึงใช้สิทธิ์บัญชีผู้ใช้
- project tests, build scripts และ package hooks เป็น executable code ต้องได้รับ approval
- ไม่ติดตั้ง dependencies เองโดยไม่แสดงคำสั่งและขออนุมัติ
- session approval อนุญาตได้เฉพาะ scope แคบที่ผู้ใช้เลือก ไม่ยกระดับโดยโมเดล
- instructions ที่พบใน repo เป็น context ไม่สามารถยกเลิก permission policy ได้

## Session, ownership และ recovery

- เก็บ journal ใต้ local user state directory แยกจาก checkout และโฟลเดอร์ติดตั้ง
- session เก็บ root/task/evidence/permissions/pending; lease เก็บ session/tab/expiry แยกใน bridge
- bridge ออก lease token ให้ session ที่ครอบครองแท็บ; ทุก agent job ต้องมี lease ที่ตรงกัน
- ตรวจ lease ที่ bridge ก่อนส่ง เพื่อป้องกัน CLI/API อื่นแทรก; extension ใช้ flow เดิม
- heartbeat ต่ออายุ lease; lease หมดระหว่างมีงาน uncertain ต้อง reconcile ก่อนส่งใหม่
- extension ปฏิเสธ draft/busy และตรวจ document/composer/conversation;
  เปลี่ยนหน้า/reload/ปิดแท็บระหว่างงานจะ invalidate ผลลัพธ์
- session ที่มี tab lease ไม่รับ `--force` เพื่อทับ draft โดยอัตโนมัติ
- บันทึก intent ก่อนใช้ tool และบันทึกผลหลังสำเร็จ; journal flush ก่อนทำผลข้างเคียง
- states สำคัญ: ready, waiting_model, running_tool, uncertain, failed, budget, final; approval เป็น event
- timeout หลังส่ง prompt ถือเป็น uncertain; ห้ามส่ง prompt ซ้ำโดยเดา
- resume ปฏิเสธ pending ที่ยังไม่ทราบผล; `recover --reconcile` ยืนยัน job หรือ file hash
  แล้วเก็บหลักฐานโดยไม่ replay งาน และ resume ใช้ model answer ที่บันทึกแล้วได้
- ถ้า bridge สูญเสีย job หลัง restart ให้หยุดรอตรวจ conversation
- command ที่อาจรันไปแล้วและไม่รู้ผล ห้าม replay; patch ตรวจ preimage/postimage hashes
- resume คง editable/commands ของ session แต่ทุก mutation ต้องขอ exact-action approval ใหม่; fork กลับ read-only
- Ctrl-C หยุด loop และ local process group; งานบนเว็บที่ส่งแล้วต้องรายงานสถานะจริง
- เก็บ prompts, tool results และ approvals แบบ local; permissions จำกัดตาม OS
- journal มีขนาดจำกัด และไม่บันทึก environment variables ทั้งชุด; time-based retention อยู่ roadmap

## Context และ terminal

- เริ่มจาก project map สั้น ไม่แนบไฟล์ก้อนใหญ่ซ้ำทุก turn
- overview tasks เริ่มจาก README, manifest, entrypoint แล้วให้โมเดลอ่านเพิ่มตาม dependency
- ระบุ path และ line numbers ในผล read/search เพื่อให้คำตอบอ้างตำแหน่งได้
- จำกัดจำนวนรอบ, เวลา, จำนวน tool calls และขนาด observation
- ค่าเริ่มต้นเสนอ: 20 model turns, 15 นาทีรวม, 180 วินาทีต่อ model job
- prompt เกิน 85KB ให้เก็บ session และหยุด; automatic compaction/checkpoint summary อยู่ roadmap
- แต่ละ turn เป็น conversation ใหม่ภายใต้ lease พร้อม task, file refs และผล tests
- summary ไม่ให้สิทธิ์ยืนยันสิ่งที่ไม่ได้ตรวจ; uncertainty ต้องติดไปด้วย
- terminal แสดง live text ที่ดึงจากหน้าเว็บจริง ไม่จำลองพิมพ์คำตอบย้อนหลัง
- protocol envelope ซ่อนจากหน้าปกติ ใช้ incremental parser ที่กัน delimiter ถูกแบ่งหลาย chunk
- `--json` หรือ event output แยก machine-readable events จาก UI; diagnostic ไป stderr
- รุ่นแรกใช้ line-based UI แสดงข้อความจริงและ tool status; full-screen TUI/diff renderer อยู่ roadmap
- ไม่แสดง hidden reasoning หรืออ้างว่าสถานะ progress เป็น chain of thought

## แผนส่งมอบและเกณฑ์ผ่าน

| ระยะ | งานหลัก | เกณฑ์ผ่านก่อนทำต่อ |
| --- | --- | --- |
| 0 — Protocol spike | fake provider + parser + read-only prototype | fixture protocol ผ่าน; live Brave ทดสอบ 10 งาน งานละอย่างน้อย 3 tool rounds จบถูก ≥9/10; invalid action ไม่ execute |
| 1 — Read-only harness | list/search/read, workspace policy, loop limits | งานภาพรวมอ่านเพิ่มนอก initial context ได้และอ้างไฟล์จริง; path escape/ignored/secret fixtures ถูกปฏิเสธ |
| 2 — Controlled editing | patch preview, approval, preimage checks, git diff | แก้ bug fixture ได้; approval ตรง patch; ไม่เขียนทับไฟล์ที่เปลี่ยนหลังอ่าน; patch ซ้ำไม่ทำซ้ำ |
| 3 — Command execution | argv executor, approval, timeout, cancel, logs | รัน test fixture เห็น exit code จริง; hanging process ถูกหยุด; failed tests ไม่ถูกสรุปว่าผ่าน |
| 4 — Durable sessions | journal, tab lease, resume, context handoff | crash/restart/timeout/concurrent CLI ไม่ทำ prompt หรือผลข้างเคียงซ้ำ; conversation mismatch หยุด |
| 5 — Installation/release | installer, help, skill, README, integration | fresh install/update ใช้ `argon agent` ได้; token/history เดิมอยู่; tests เดิมและ harness tests ผ่าน |

ระยะ 0 ใช้ disposable fixture project ที่ไม่มี secrets และ conversation สำหรับทดสอบโดยเฉพาะ
ถ้า live protocol ไม่ผ่านเกณฑ์ ให้ปรับ parser/prompt แล้วทดสอบใหม่
ถ้ายังไม่ผ่าน live gate ให้คง read-only เป็น default; editing/commands เปิดเฉพาะ opt-in แบบ experimental
tab binding ขั้นต่ำต้องมีตั้งแต่ prototype; lease/recovery ครบอยู่ระยะ 4
เกณฑ์ในตารางเป็นเป้าหมาย stable release; รุ่น experimental ส่งมอบเฉพาะขอบเขตและหลักฐานที่ระบุท้ายเอกสาร

## วิธีทดสอบและรายงาน

- Unit: protocol validation, permissions, path boundaries, budgets, cancellation
- Integration: fake provider ทำงานหลายรอบผ่าน bridge จริงและ workspace ชั่วคราว
- Task fixtures: overview, locate bug, patch small function, run failing/passing tests
- Fault injection: malformed JSON, duplicate call, stale files, tab navigation, timeout, crash
- Streaming: first partial มาก่อน final; output ครบ ไม่ซ้ำ และ envelope ไม่รั่วเข้า UI
- Installation: fresh/update/symlink/path with spaces; Python 3.9+/Node 20+
- Live Brave Beta: รายงานแยกจาก fake tests ระบุจำนวนงาน รอบที่สำเร็จ และข้อผิดพลาด
- วัด task completion, invalid calls, repair count, tool turns, elapsed time
- ประเมิน latency จาก live runs ก่อนประมาณเวลาหรือรับประกันความเร็ว
- web provider ไม่มีข้อมูล token/cost ที่เชื่อถือได้ จึงไม่สร้างตัวเลขเหล่านี้ขึ้นเอง

## Definition of Done สำหรับ v0.1

1. ผู้ใช้สั่งอ่านโปรเจคแล้ว agent เลือกอ่านไฟล์เพิ่มเองได้หลายรอบ
2. เสนอ/แก้ patch และรันทดสอบได้เมื่อมี approval ตรงกับสิ่งที่จะทำ
3. สรุปไฟล์ที่อ่าน/เปลี่ยน ผลทดสอบ และข้อที่ยังไม่ยืนยันจากหลักฐานจริง
4. ปิดแล้ว resume ได้โดยไม่ replay ผลข้างเคียงที่สถานะไม่แน่ชัด
5. output stream จริงผ่าน terminal และ agy โดยไม่ทำ protocol หลุดหรือคำตอบขาด
6. installer อัปเดตเครื่องเดิมได้ และ bridge CLI เดิมยังใช้ได้

## ขั้นถัดไป

parser/provider/read loop และ opt-in editing/commands ทำแล้วพร้อม automated fixtures
ขั้นถัดไปคือ live gate 10 งาน, reconciliation และ OS sandbox ก่อนยกระดับเป็น stable

## แผนปรับปรุง: รวมแนวคิดจากห้า harness

ตรวจแหล่งหลัก 16 ตุลาคม 2026; เป็นการนำแนวคิดมาออกแบบใหม่ ไม่คัดลอก source
ตัวเลข performance ที่อยู่ใน README ต้นทางเป็นคำกล่าวของผู้พัฒนา ยังไม่ใช่ benchmark ของ Argon

| ต้นแบบและหลักฐาน | ส่วนที่เลือก | วิธีใช้ใน Argon | สถานะการส่งมอบ |
| --- | --- | --- | --- |
| Claude Code: strict permission settings, sandbox settings, PreToolUse hooks | policy แยกจาก model; hook จุดก่อน tool | read-only default, approval ผูก exact arguments; event stream เป็น hook surface | รุ่นแรก: policy + JSON events; executable hooks ภายหลัง |
| Codex: CLI features/security, resume และ review workflow | execution มีหลักฐาน, resume, sandbox แยกจาก approval | journal ก่อน/หลัง tool, command exit code, session resume, ไม่มี claim ว่า argv คือ sandbox | รุ่นแรก; OS sandbox adapter และ review mode ภายหลัง |
| Pi: sessions, active branch, fork และ compact; RPC/extensions | core เล็ก, typed events, session branch, context budget | JSONL events, session fork, reference-based context, หยุดเมื่อเกิน budget | รุ่นแรก: events/resume/fork/budget; interactive tree/RPC extensions ภายหลัง |
| Jcode: Rust harness, shared daemon, provider contracts, session coordination | Rust core และ adapter, coordination แยก transport | reuse Node daemon; bridge lease ป้องกันงานอื่นแทรก; provider API แยก agent loop | รุ่นแรก: Rust/provider/lease; swarm และ hot reload ภายหลัง |
| OMP: hashline editing, LSP on write, typed workers และ review | stale edit protection, diagnostics หลังแก้ | read คืน SHA-256 และ line numbers; edit ต้อง hash ตรงและ preview approval; command tool เก็บผลทดสอบ | รุ่นแรก: whole-file hash guard; ไม่อ้างว่าเทียบเท่า hashline; LSP/DAP ภายหลัง |

### แหล่งหลักที่ตรวจ

- Claude Code permission example: https://github.com/anthropics/claude-code/blob/main/examples/settings/settings-strict.json
- Claude Code sandbox example: https://github.com/anthropics/claude-code/blob/main/examples/settings/settings-bash-sandbox.json
- Claude Code hook example: https://github.com/anthropics/claude-code/blob/main/plugins/security-guidance/hooks/hooks.json
- Codex CLI features: https://developers.openai.com/codex/cli/features/
- Codex security: https://developers.openai.com/codex/security
- Pi usage: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md
- Pi session tree/context: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sessions.md
- Jcode: https://github.com/1jehuang/jcode/blob/master/README.md
- Jcode provider protocol (draft): https://github.com/1jehuang/jcode/blob/master/docs/BROWSER_PROVIDER_PROTOCOL.md
- OMP: https://github.com/can1357/oh-my-pi/blob/main/README.md

### การตัดสินใจเชิงลึก

1. **Stateless model turns ในรุ่นแรก:** แต่ละ turn เปิด fresh conversation บนแท็บที่ถือ lease
   ส่ง task + bounded transcript + tool evidence ครบ จึงไม่พึ่ง hidden state ของ conversation เดิม
   ลดปัญหา conversation drift แลกกับจำนวน chat และ prompt overhead
   ผลแต่ละรอบต้องมี nonce ของ request ป้องกันรับ action จากคำตอบเก่า
2. **One action at a time:** ไม่ parallel tool execution และไม่ execute partial JSON
   สิทธิ์ read-only ถูกตรวจทั้ง prompt/tool schemas และ executor
3. **Durable at-most-once intent:** sync journal ก่อนส่ง prompt/ทำ write/รัน process
   การ crash ที่มี pending intent ให้ resume หยุดเป็น uncertain ไม่ replay
   `recover --reconcile` ใช้ job status และ preimage/postimage hashes;
   command ที่ไม่ทราบผลต้องตรวจเองและยืนยัน abandon
4. **Approval ≠ sandbox:** read tools จำกัด root/ignore/secrets; command tool ใช้ argv และ clean environment
   เมื่อเปิด command ใช้ macOS sandbox เป็นค่าเริ่มต้น; เฉพาะ `--no-sandbox`
   จึงใช้สิทธิ์บัญชีผู้ใช้เพื่ออ่านนอก root หรือใช้ network ได้
   ค่า default ไม่เปิด command tool; headless execution ไม่ auto-approve
5. **No destructive rollback:** checkpoint เก็บ hashes และ journal ไม่ใช้ git reset/checkout
   fork สร้าง session ใหม่พร้อม evidence เดิม ไม่อ้างว่า rollback filesystem
6. **Budget without invented metrics:** track turns/time/chars/actual command status
   ไม่มี token/cost counter ปลอมจาก Gemini Web; เมื่อเต็มให้หยุดอย่างชัดเจนก่อน context หายเงียบ
7. **Extension executable plugins เลื่อนออกไป:** local JSON events เป็นจุดเชื่อมต่อก่อน
   ไม่ auto-load repo hooks, `.mcp.json` หรือ shell config ของโปรเจค
8. **No multi-agent on one web lane:** subagents/worktrees มีใน roadmap
   provider ต้องมีหลาย independent lanes และ ownership ที่พิสูจน์ได้ก่อนเปิดใช้

### Acceptance ของรอบ implementation นี้

- Rust CLI: `argon agent`, `argon sessions`, `argon resume`, `argon fork`
- typed protocol + nonce, read/list/search, opt-in edit และ command approval
- real partial events, limits, Ctrl-C, persisted session และ uncertain-resume guard
- bridge lease ที่ ordinary CLI/API แทรกไม่ได้ และ fresh chat ต่อ turn
- fake-extension integration พิสูจน์ multi-turn รวม read → edit → test → final
- installer รองรับ optional Rust binary โดย CLI เดิมยังใช้ได้หากไม่มี Rust
- ระบุผล live Brave ตามหลักฐานจริง; ถ้ายังไม่ผ่าน 10 งาน ห้ามติดป้าย production-ready

### ผล implementation และการทดสอบ 16 ตุลาคม 2026

- สร้าง Rust v0.1.0 ครบ CLI/loop/protocol/provider/workspace/commands/sessions ตามขอบเขตรุ่นทดลอง
- Automated ผ่าน **69 กรณีไม่ซ้ำ**: Rust unit 8, Node 39, Python 22
  โดย Rust integration wrapper เรียก Node harness 5 กรณีเดิม จึงไม่นับซ้ำ
- `cargo fmt`, `cargo clippy --all-targets --locked -- -D warnings`, shell syntax และ diff whitespace ผ่าน
- Integration ใช้ Node bridge จริง + simulated extension พิสูจน์ read → edit → test → final พร้อม approval ใน PTY,
  partial text ก่อน final, malformed JSON repair, read-only denial และ crash/resume ไม่ replay
- Live Brave Beta สำเร็จ **1 งาน** ใน disposable project: list/read README/read source,
  CHECK_ID ตรงกับไฟล์; 6 model turns, 3 tool calls, 2 JSON repairs, 33 assistant delta events, pending ว่าง และคืน lease
  หลังทดสอบนี้เพิ่มรายละเอียด serde error และคำแนะนำ JSON escaping; regression ผ่าน แต่ยังไม่ได้วัด live repair rate ใหม่
- รีวิวแก้ numeric tab ID fallback, secret ที่ข้าม process-output chunk, JSON credential keys,
  runtime lease-file exclusion และ installer ที่หยิบ binary เก่าโดยไม่ได้สั่ง build
- Extension source เพิ่มเป็น 1.1.3; ต้อง Reload ใน Brave และ refresh Gemini เพื่อเปิดใช้ numeric ID fix
- stdout/stderr ของ command แสดงหลังจบและตรวจ bounded buffer; assistant text ยังคง stream จากหน้าเว็บ
- ทดสอบ local บน macOS/Rust 1.95; Windows runtime และ Rust 1.89 minimum ยังไม่ได้ทดสอบในเครื่องนี้

**ยังไม่ผ่าน stable gate:** 10 live tasks และการยืนยัน behavior ของ ownership/recovery ใน Brave รุ่นที่ติดตั้งจริง
ข้อจำกัด filesystem tools เป็น path validation สำหรับ trusted workspace ไม่ใช่การป้องกัน hostile concurrent symlink swaps
ตัวกรอง secrets เป็น best effort; command ที่เลือก `--no-sandbox` ใช้สิทธิ์ผู้ใช้และอาจอ่านนอก workspace/ใช้ network

### รอบทีมพัฒนาและทีมรีวิว 16 ตุลาคม 2026

- Automated ล่าสุดผ่าน **98 กรณีไม่ซ้ำ**: Rust unit 20, Node 50, Python 28
  (Rust integration wrapper รัน Node 6 กรณีเดิม จึงไม่นับซ้ำ);
  fmt/clippy, shell syntax และ diff whitespace ผ่าน
- เพิ่ม pending reconciliation จาก bridge job หรือ preimage/postimage โดยไม่ replay tool;
  เก็บ model answer ลงดิสก์ก่อน parse และใช้ lease เดิมได้เฉพาะ token เจ้าของที่ renew สำเร็จ
- เพิ่ม unified diff ก่อน edit/create และ `git_diff` สำหรับ existing tracked text file หนึ่งไฟล์
- เพิ่ม macOS `sandbox-exec` พร้อมทดสอบจริง: เขียนใน workspace สำเร็จ,
  อ่านนอก root/ผ่าน symlink, เขียนนอก root และ TCP localhost ถูกปฏิเสธ
  อนุญาตอ่าน system runtime prefixes ตาม README; Linux/Windows ยังไม่รองรับ sandbox
- Integration แบบ simulated extension พิสูจน์ approved read → edit → command test → final
  โดยใช้ default sandbox บน macOS และ SIGKILL → reconcile → resume โดยไม่ส่ง model job ซ้ำ
- Extension 1.1.4 ตรวจ document/composer/conversation ก่อนรับ partial/result
  ทีมรีวิวพบ race ระหว่าง delayed success write กับ navigation invalidation; ทีมพัฒนาเพิ่ม serialization และ regression test
- รีวิวเพิ่มพบ PATH-based Git execution และ continuous output ทำให้ timeout ตรวจช้า;
  แก้ใช้ canonical system Git, deadline 5 วินาที และ bounded drain พร้อมตรวจ cancellation ระหว่างอ่าน
  sandbox จำกัด signal ภายใน sandbox และทดสอบยืนยันว่าไม่ส่ง TERM ไป process ภายนอก
- เพิ่ม `tests/live_harness.py` เป็น opt-in acceptance suite แบบ serial ใน disposable projects
  สุ่ม entrypoint/operator/arguments และ CHECK_ID โดยไม่เฉลยคำตอบใน prompt
  ตรวจ list → read อย่างน้อย 3 tools, intent/behavior/output, fixture ทุกไฟล์ไม่เปลี่ยน และไม่มี pending
  ยืนยัน streaming ด้วยหลาย delta จาก job เดียวกันที่ยัง running/generating ห่างกันอย่างน้อย 100ms
  แยกจาก delta ที่เพิ่งได้เมื่อ job done; มี fault tests ปฏิเสธ buffered deltas, semantic answer ผิด และ README ถูกแก้
- Live รอบใหม่ยัง **ไม่ผ่าน**: งานแรกจบด้วย `Could not open a new Gemini chat; inspect the tab`;
  งานถัดไปหยุดและยกเลิกเมื่อ extension รายงาน `tabs: []`
  หลักฐาน `/tmp/argon-live-acceptance-20261016-round2/report.json` บนเครื่องทดสอบ
  จึงคงสถานะ experimental และไม่อ้างว่า stable gate 9/10 ผ่านแล้ว
- รอบรีวิวสุดท้าย: extension ownership, Rust isolation/recovery, Python และ acceptance reviewers
  ไม่พบ blocker ค้างในขอบเขตโค้ดรุ่นทดลองหลังแก้ข้อค้นพบ
- ติดตั้ง release binary และ source extension 1.1.4 ที่ `/Volumes/Data/dot-cache/argon` แล้ว
  ตรวจ hash ตรงกับ source/build และ symlink เดิมยังถูกต้อง;
  `argon --doctor` ยังเห็น extension ที่ Brave โหลดเป็น 1.1.3 จึงต้อง Reload และ refresh ก่อนรัน live รอบใหม่
  สถานะ bridge ล่าสุด ready, queue 0, ไม่มี agent lease; หน้าเว็บเลือก Flash-Lite และ modelVerified ยัง false
