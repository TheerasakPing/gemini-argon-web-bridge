# Gemini Argon Web Bridge

ใช้ Gemini ผ่านเว็บที่ล็อกอินไว้ จาก Terminal หรือ Antigravity พร้อมสตรีมข้อความจากหน้าเว็บ
ทำงานบนเครื่องคุณผ่าน Node.js + Python standard library ไม่มี npm/pip dependencies

**ใช้ได้เฉพาะโมเดลและโควตาที่บัญชีคุณมีสิทธิ์** ชื่อ Argon คือชื่อ bridge ไม่ใช่การยืนยันโมเดล Gemini 4 และไม่ได้ปลดล็อกแพ็กเกจที่เสียเงิน

## ติดตั้งและเปิดด้วยคำสั่งเดียว

ต้องมี **Node.js 20+**, **Python 3.9+**, Chrome/Brave 120+ และล็อกอิน Gemini

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/TheerasakPing/gemini-argon-web-bridge/main/install.sh | sh
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/TheerasakPing/gemini-argon-web-bridge/main/install.ps1).Content))
```

Installer สร้าง token เฉพาะเครื่อง เพิ่มคำสั่ง `argon` เข้า User PATH เปิด background bridge และหน้า Gemini
บน macOS เลือก Brave Beta → Brave → Chrome ตามลำดับถ้าติดตั้งไว้
หากยังเรียก `argon` ไม่ได้ ให้เปิด Terminal ใหม่

**ครั้งแรกทำ 2 ขั้นตอนในเบราว์เซอร์:**

1. ที่ `chrome://extensions` หรือ `brave://extensions` เปิด **Developer mode** → **Load unpacked** → เลือกโฟลเดอร์ `extension` ตาม path ที่ installer แสดง
2. เปิด Gemini ล็อกอิน เลือกโมเดลที่ใช้ได้ และเว้นช่องพิมพ์ว่าง จากนั้นรัน `argon --status`

การโหลด unpacked extension ครั้งแรกยังต้องกดเองในเบราว์เซอร์ คำสั่งติดตั้งไม่เปลี่ยนนโยบายหรือสิทธิ์เบราว์เซอร์ให้

## เปิดใช้งานครั้งถัดไป

```sh
argon --start
```

เปิด bridge และ Gemini ด้วยคำสั่งเดียว แล้วส่งคำถาม:

```sh
argon "อธิบาย SSE พร้อมตัวอย่าง"
argon --new "เริ่มบทสนทนาใหม่"
cat app.py | argon "รีวิวโค้ดนี้"
argon -f notes.md "สรุป"
argon --status
argon --doctor
argon --no-stream "รอคำตอบครบแล้วค่อยแสดง"
argon --json "แสดงผลแบบ JSON"
```

สตรีมเปิดเป็นค่าเริ่มต้น อ่านการเปลี่ยนแปลง DOM ประมาณทุก 100 ms และ flush ข้อความเมื่อพบ whitespace
จึงเป็นข้อความจากหน้าเว็บ ไม่ใช่ token stream โดยตรงจากโมเดล และจะเริ่มได้เมื่อเว็บแสดงเนื้อคำตอบแล้ว
เว็บอาจเปลี่ยนโครงสร้าง DOM จนต้องอัปเดต selector; ใช้ `argon --doctor` ช่วยตรวจ

บน macOS เริ่ม server อัตโนมัติเมื่อ login ได้ด้วย `argon --install-service`
บน Linux/Windows server เปิดแบบ background เมื่อเรียก CLI; การเริ่มอัตโนมัติเมื่อ login ยังไม่มี installer ให้

## Antigravity / MCP

Installer วางสกิล `argon` ที่ `~/.gemini/config/skills/argon/SKILL.md`
เปิด session ใหม่หรือ reload skills ใน Antigravity แล้วใช้ `/argon คำถาม`
การจดจำ slash command ขึ้นกับ agent client ที่ใช้งาน

```sh
argon --mcp-config
```

คำสั่งนี้แสดง configuration สำหรับ MCP client: `ask_gemini`, `argon_status`, `argon_history`
ยังมี OpenAI-compatible endpoint ที่ `http://127.0.0.1:8989/v1/chat/completions` พร้อม streaming
ดูรายละเอียด CLI และ API ใน [SKILL.md](SKILL.md)

## ติดตั้งจาก source / อัปเดต

```sh
git clone https://github.com/TheerasakPing/gemini-argon-web-bridge.git
cd gemini-argon-web-bridge
python3 scripts/install.py
```

อัปเดตโดยรันคำสั่งติดตั้งเดิมอีกครั้ง เก็บ token และประวัติเดิม
จากนั้น Reload extension และรีเฟรช Gemini เพื่อโหลด content script ใหม่
ถ้า server เดิมยังรันอยู่ ให้ restart server เพื่อโหลดโค้ดใหม่

ตัวเลือก installer:

```sh
python3 scripts/install.py --no-start   # ติดตั้งไฟล์อย่างเดียว
python3 scripts/install.py --no-open    # เริ่ม server โดยไม่เปิด browser
python3 scripts/install.py --no-path    # ไม่แก้ shell profile / User PATH
```

ค่าเริ่มต้นติดตั้งที่ `~/.gemini/config/skills/argon` และ launcher ที่ `~/.local/bin`
ตั้ง `ARGON_INSTALL_DIR` เพื่อใช้โฟลเดอร์อื่นได้; ถ้ามี symlink เดิมจะใช้ปลายทางเดิม

## ข้อมูลส่วนตัว

Server ฟังเฉพาะ `127.0.0.1:8989` และใช้ bearer token สำหรับงาน
Installer สร้าง `bridge/token` และ `extension/config.js` ในเครื่อง ไม่รวมไว้ใน repo
`bridge/history.jsonl`, `bridge/queue.json` และ logs อาจมีคำถามและคำตอบ อย่าแชร์โฟลเดอร์ติดตั้งทั้งชุด
ห้ามแชร์ extension ที่ผ่าน installer แล้วโดยไม่ลบ `config.js` เพราะมี token

## ทดสอบ

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

ชุดทดสอบใช้ bridge และ browser fixtures ไม่ต้องล็อกอิน Google
การทดสอบ UI กับ Brave จริงยังต้องมี session และ extension ที่โหลดแล้ว
PTY tests ใช้ได้บน macOS/Linux; Windows จะข้ามส่วน PTY

## ถอนติดตั้ง

ถ้าเคยติดตั้ง launchd ให้รัน `argon --uninstall-service` ก่อน
หยุด process bridge ที่ฟังพอร์ต 8989 จากนั้นลบโฟลเดอร์ติดตั้งและ launcher `~/.local/bin/argon*`
เอาบรรทัด `# argon-web-bridge` ออกจาก shell profile ถ้าต้องการ
การลบโฟลเดอร์ติดตั้งจะลบประวัติคำถามคำตอบด้วย

MIT License
