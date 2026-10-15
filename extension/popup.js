const PHASES = {claimed:'รับงานแล้ว', typing:'กำลังพิมพ์คำถาม', sending:'กำลังส่งไปยัง Gemini', waiting:'รอ Gemini เริ่มตอบ',
  generating:'Gemini กำลังตอบ', finishing:'กำลังรวบรวมคำตอบ'};
const $ = id => document.getElementById(id);
function setState(el, text, cls) { el.textContent = text; el.className = cls || ''; }
function render({status, job}) {
  const busy = Boolean(job);
  document.body.className = busy ? 'busy' : 'idle';
  if (!status) { $('sub').textContent = 'กำลังเริ่ม Extension'; return; }
  setState($('server'), status.connected ? 'เชื่อมต่อแล้ว' : 'ยังไม่เชื่อมต่อ', status.connected ? 'ok' : 'bad');
  setState($('gemini'), busy ? 'กำลังทำงาน' : status.ready ? 'พร้อมรับงาน' : 'ยังไม่พร้อม', busy ? 'warn' : status.ready ? 'ok' : 'bad');
  $('model').textContent = status.model || 'ไม่ทราบ';
  $('tabs').textContent = String(status.tabs?.length ?? 0);
  $('sub').textContent = busy ? 'กำลังประมวลผลงาน' : status.ready ? 'พร้อมใช้งาน' : 'รอการตั้งค่า';
  $('error').textContent = busy ? '' : status.error || '';
  if (busy) {
    $('phase').textContent = PHASES[job.phase] || job.phase;
    const secs = Math.max(0, Math.round((Date.now() - (job.startedAt || Date.now())) / 1000));
    $('elapsed').textContent = `${secs}s${job.chars ? ` · ${job.chars} ตัวอักษร` : ''}`;
  }
}
async function tick() { render(await chrome.storage.local.get(['status', 'job'])); }
async function refresh() {
  try { await chrome.runtime.sendMessage({type:'argon:refresh'}); await tick(); }
  catch (e) { $('error').textContent = e.message; }
}
$('refresh').addEventListener('click', refresh);
$('reload').addEventListener('click', () => chrome.runtime.sendMessage({type:'argon:reload'}));
setInterval(tick, 500);
setInterval(refresh, 4000);
void refresh();
