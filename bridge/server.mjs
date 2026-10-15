import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';

const PHASES = new Set(['claimed', 'typing', 'sending', 'waiting', 'generating', 'finishing']);
const MAX_PROMPT = 100000;
const MAX_QUEUE = 50;
const HISTORY_ROTATE_BYTES = 5 * 1024 * 1024;

const cleanOptions = o => ({
  newChat: o?.newChat === true,
  force: o?.force === true,
  tab: typeof o?.tab === 'string' ? o.tab.trim().slice(0, 100) : '',
});
const parseTabs = raw => {
  try {
    const list = JSON.parse(String(raw || '').slice(0, 4000));
    if (!Array.isArray(list)) return [];
    return list.slice(0, 20).map(t => ({ id: Number(t?.id) || 0, title: String(t?.title || '').slice(0, 80),
      ready: Boolean(t?.ready), generating: Boolean(t?.generating) }));
  } catch { return []; }
};
const flatten = messages => {
  const textOf = c => typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
  const items = messages.filter(m => m && typeof m === 'object')
    .map(m => ({ role: String(m.role || 'user'), text: textOf(m.content).trim() })).filter(m => m.text);
  return items.length === 1 ? items[0].text : items.map(m => `${m.role}: ${m.text}`).join('\n\n');
};

export function createBridge({ token, timeoutMs = 180000, dataDir = null } = {}) {
  if (!token) throw new Error('Bridge token is required');
  const jobs = new Map(), streams = new Set(), clients = new Map();
  const queueFile = dataDir && join(dataDir, 'queue.json');
  const historyFile = dataDir && join(dataDir, 'history.jsonl');
  const leaseFile = dataDir && join(dataDir, 'agent-lease.json');
  let lease = null;
  if (leaseFile && existsSync(leaseFile)) {
    try { lease = JSON.parse(readFileSync(leaseFile, 'utf8')); } catch { /* Invalid lease is not usable. */ }
  }
  const final = j => ['done', 'error'].includes(j.status);
  const publicJob = j => ({ ...j, claimToken: undefined });
  const notify = () => { for (const s of streams) s.write('event: pending\ndata: {}\n\n'); };
  const liveClients = () => [...clients.values()].filter(c => Date.now() - c.seen < 65000);
  const openJobs = () => [...jobs.values()].filter(j => !final(j));
  const saveLease = () => {
    if (!leaseFile) return;
    writeFileSync(leaseFile + '.tmp', JSON.stringify(lease), {mode:0o600});
    renameSync(leaseFile + '.tmp', leaseFile);
  };
  const currentLease = () => {
    if (lease && lease.expires < Date.now() && !openJobs().length) { lease = null; saveLease(); }
    return lease;
  };

  const persist = () => {
    if (!queueFile) return;
    try {
      writeFileSync(queueFile + '.tmp', JSON.stringify(openJobs()), { mode: 0o600 });
      renameSync(queueFile + '.tmp', queueFile);
    } catch (e) { console.error('Bridge: cannot persist queue:', e.message); }
  };
  const record = j => {
    if (!historyFile) return;
    try {
      if (existsSync(historyFile) && statSync(historyFile).size > HISTORY_ROTATE_BYTES) renameSync(historyFile, historyFile + '.1');
      appendFileSync(historyFile, JSON.stringify({ id: j.id, kind: j.kind, created: j.created, finished: j.finished,
        ms: j.finished - j.created, prompt: j.prompt, text: j.text, error: j.error, model: j.model, status: j.status }) + '\n', { mode: 0o600 });
    } catch (e) { console.error('Bridge: cannot write history:', e.message); }
  };
  const finish = (j, patch) => {
    Object.assign(j, patch, { finished: Date.now() });
    j.phase = j.status;
    record(j); persist(); notify();
  };
  const enqueue = (prompt, options, kind = 'prompt') => {
    const job = { id: randomUUID(), kind, prompt, options, status: 'queued', phase: 'queued', partial: '',
      created: Date.now(), deadline: Date.now() + timeoutMs };
    jobs.set(job.id, job); persist(); notify();
    return job;
  };
  const sweep = () => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (!final(j) && now > j.deadline) {
        finish(j, { status: 'error', error: 'Job timed out; delivery may have occurred. Inspect Gemini before retrying.' });
      }
      if (final(j) && now - j.finished > 600000) jobs.delete(id);
    }
    for (const [id, c] of clients) if (now - c.seen > 120000) clients.delete(id);
  };
  // The extension sends monotonic progress snapshots; poll fast so CLI output stays continuous.
  const waitJob = (job, tick, aborted) => new Promise(done => {
    const timer = setInterval(() => {
      sweep(); tick?.();
      if (final(job) || aborted()) { clearInterval(timer); done(); }
    }, 25);
  });

  if (queueFile && existsSync(queueFile)) {
    try {
      for (const j of JSON.parse(readFileSync(queueFile, 'utf8'))) {
        if (!j?.id || typeof j.prompt !== 'string' || !['queued', 'running'].includes(j.status)) continue;
        j.options = cleanOptions(j.options); j.partial = ''; jobs.set(j.id, j);
        if (j.status === 'running') finish(j, { status: 'error', error: 'Server restarted during job; inspect Gemini before retrying.' });
        else if (Date.now() > j.deadline) finish(j, { status: 'error', error: 'Job expired while the server was down.' });
      }
    } catch (e) { console.error('Bridge: cannot restore queue:', e.message); }
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) return json(403, {error:'Invalid host'});
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(403, {error:'Origin denied'});
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Argon-Lease');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    sweep();
    if (req.method === 'GET' && url.pathname === '/health') {
      const live = liveClients();
      return json(200, { service:'argon-web-bridge', version:1, agentProtocol:1, agentLeased:Boolean(currentLease()), server:'ready', extensionConnected:live.length > 0,
        ready:live.some(c => c.ready), queue:openJobs().length,
        clients:live.map(c => ({ready:c.ready, draft:c.draft, error:c.error, model:c.model, tabs:c.tabs})), modelVerified:false });
    }
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, {error:'Unauthorized'});
    try {
      const body = async () => {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), {status:415});
        let data = ''; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw Object.assign(new Error('Body too large'), {status:413}); data += chunk; }
        try {
          const parsed = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
          return parsed;
        } catch { throw Object.assign(new Error('Invalid JSON object'), {status:400}); }
      };
      if (req.method === 'POST' && url.pathname === '/agent/lease') {
        const b = await body();
        const held = currentLease();
        if (b.action === 'acquire') {
          if (typeof b.session !== 'string' || !/^[\w-]{1,80}$/.test(b.session) || !Number.isSafeInteger(b.tab) || b.tab <= 0) return json(400, {error:'Valid session and tab required'});
          if (held || openJobs().length) return json(409, {error:'Bridge is reserved or has unfinished jobs'});
          const tabs = liveClients().flatMap(c => c.tabs || []);
          if (!tabs.some(t => t.id === b.tab && t.ready)) return json(409, {error:'Requested Gemini tab is not ready'});
          lease = {session:b.session, tab:b.tab, token:randomUUID(), expires:Date.now()+1800000}; saveLease();
          return json(200, lease);
        }
        if (!held || req.headers['x-argon-lease'] !== held.token) return json(409, {error:'Agent lease lost'});
        if (b.action === 'renew') { lease.expires = Date.now()+1800000; saveLease(); return json(200, {ok:true, tab:lease.tab}); }
        if (b.action === 'release') {
          if (openJobs().length) return json(409, {error:'Unfinished job: inspect Gemini before releasing lease'});
          lease = null; saveLease(); return json(200, {ok:true});
        }
        return json(400, {error:'Unknown lease action'});
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {'Content-Type':'text/event-stream', Connection:'keep-alive'});
        res.write('event: pending\ndata: {}\n\n'); streams.add(res);
        req.on('close', () => streams.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/pending_task') {
        const client = url.searchParams.get('client');
        if (!client || client.length > 100) return json(400, {error:'client required'});
        const ready = url.searchParams.get('ready') === '1', draft = url.searchParams.get('draft') === '1';
        clients.set(client, {seen:Date.now(), ready, draft, error:(url.searchParams.get('error') || '').slice(0,300),
          model:(url.searchParams.get('model') || '').slice(0,100), tabs:parseTabs(url.searchParams.get('tabs'))});
        const running = [...jobs.values()].find(j => j.status === 'running');
        if (running) return json(200, {task:running.client === client ? running : null});
        const head = [...jobs.values()].find(j => j.status === 'queued');
        const runnable = head && (head.kind === 'doctor' || ready || (draft && head.options.force));
        if (runnable) { head.status = 'running'; head.phase = 'claimed'; head.client = client; head.claimToken = randomUUID(); persist(); }
        return json(200, {task:runnable ? head : null});
      }
      if (req.method === 'GET' && url.pathname === '/history') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const needle = (url.searchParams.get('q') || '').toLowerCase();
        let items = [];
        if (historyFile && existsSync(historyFile)) {
          items = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
        if (needle) items = items.filter(i => `${i.prompt}\n${i.text || ''}`.toLowerCase().includes(needle));
        return json(200, {items:items.slice(-limit)});
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return json(200, {object:'list', data:[{id:'gemini-web', object:'model', owned_by:'argon-bridge'}]});
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (currentLease()) return json(409, {error:'Bridge reserved by an agent session'});
        const b = await body();
        const prompt = Array.isArray(b.messages) ? flatten(b.messages) : '';
        const err = (status, message, type) => json(status, {error:{message, type}});
        if (!prompt || prompt.length > MAX_PROMPT) return err(400, `messages must contain 1–${MAX_PROMPT} characters of text`, 'invalid_request_error');
        if (!liveClients().some(c => c.ready || (c.draft && b.argon_force === true))) return err(503, 'Gemini tab is not ready', 'bridge_unavailable');
        if (openJobs().length >= MAX_QUEUE) return err(429, 'Queue full', 'rate_limit_error');
        const job = enqueue(prompt, cleanOptions({newChat:b.argon_new_chat, force:b.argon_force, tab:b.argon_tab}));
        const id = 'chatcmpl-' + job.id, created = Math.floor(Date.now() / 1000);
        const model = typeof b.model === 'string' ? b.model.slice(0, 100) : 'gemini-web';
        const chunk = (delta, reason = null) => `data: ${JSON.stringify({id, object:'chat.completion.chunk', created, model, choices:[{index:0, delta, finish_reason:reason}]})}\n\n`;
        if (b.stream === true) {
          let closed = false, sent = 0;
          res.writeHead(200, {'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive'});
          res.write(chunk({role:'assistant'}));
          req.on('close', () => { closed = true; });
          await waitJob(job, () => {
            const t = job.partial || '';
            if (!closed && t.length > sent) { res.write(chunk({content:t.slice(sent)})); sent = t.length; }
          }, () => closed);
          if (closed) return;
          if (job.status === 'done') {
            const t = job.text || '';
            if (t.length > sent) res.write(chunk({content:t.slice(sent)}));
            res.write(chunk({}, 'stop'));
          } else res.write(`data: ${JSON.stringify({error:{message:job.error, type:'bridge_error'}})}\n\n`);
          res.write('data: [DONE]\n\n'); return res.end();
        }
        await waitJob(job, null, () => res.destroyed);
        if (job.status !== 'done') return err(502, job.error || 'Request failed', 'bridge_error');
        return json(200, {id, object:'chat.completion', created, model,
          choices:[{index:0, message:{role:'assistant', content:job.text}, finish_reason:'stop'}],
          usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0}});
      }
      if (req.method === 'POST' && (url.pathname === '/ask' || url.pathname === '/doctor')) {
        const b = await body();
        const held = currentLease();
        if (held && (req.headers['x-argon-lease'] !== held.token || url.pathname !== '/ask' || b.options?.tab !== String(held.tab) || b.options?.force === true || b.options?.newChat !== true)) {
          return json(409, {error:'Bridge reserved: valid agent lease, exact tab and fresh chat required'});
        }
        if (!held && req.headers['x-argon-lease']) return json(409, {error:'Agent lease lost'});
        const isDoctor = url.pathname === '/doctor';
        if (!isDoctor && (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > MAX_PROMPT)) {
          return json(400, {error:`prompt must be 1–${MAX_PROMPT} characters`});
        }
        if (b.options !== undefined && (typeof b.options !== 'object' || b.options === null || Array.isArray(b.options))) {
          return json(400, {error:'options must be an object'});
        }
        if (openJobs().length >= MAX_QUEUE) return json(429, {error:'Queue full'});
        const job = enqueue(isDoctor ? '(doctor)' : b.prompt, cleanOptions(b.options), isDoctor ? 'doctor' : 'prompt');
        return json(202, publicJob(job));
      }
      const match = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(response|progress|cancel))?$/);
      if (match) {
        const job = jobs.get(match[1]), action = match[2];
        if (!job) return json(404, {error:'Unknown job (server may have restarted)'});
        if (req.method === 'GET' && !action) return json(200, publicJob(job));
        if (req.method === 'POST' && action === 'cancel') {
          const held = currentLease();
          if (held && req.headers['x-argon-lease'] !== held.token) return json(409, {error:'Bridge reserved by an agent session'});
          if (final(job)) return json(200, {cancelled:false, status:job.status});
          if (job.status === 'running') return json(409, {error:'Job already running in Gemini; it cannot be recalled'});
          finish(job, {status:'error', error:'Cancelled before delivery'});
          return json(200, {cancelled:true});
        }
        if (req.method === 'POST' && action === 'progress') {
          const b = await body();
          if (job.status !== 'running' || !job.claimToken || b.claimToken !== job.claimToken) return json(409, {error:'Invalid job claim'});
          if (PHASES.has(b.phase)) job.phase = b.phase;
          if (typeof b.partial === 'string') job.partial = b.partial.slice(0, 200000);
          return json(200, {ok:true});
        }
        if (req.method === 'POST' && action === 'response') {
          const b = await body();
          if (!job.claimToken || b.claimToken !== job.claimToken) return json(409, {error:'Invalid job claim'});
          if (final(job)) return json(200, {accepted:true, status:job.status});
          if (!(typeof b.text === 'string' && b.text.trim()) && !(typeof b.error === 'string' && b.error.trim())) return json(400, {error:'text or error required'});
          finish(job, {status:b.error ? 'error' : 'done', text:b.text, error:b.error, model:b.model});
          return json(200, {accepted:true, status:job.status});
        }
      }
      json(404, {error:'Not found'});
    } catch (e) { if (!res.headersSent) json(e.status || 500, {error:e.status ? e.message : 'Internal bridge error'}); else res.end(); }
  });
  const timer = setInterval(() => { sweep(); for (const s of streams) s.write(': heartbeat\n\n'); }, 15000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const token = readFileSync(join(here, 'token'), 'utf8').trim();
  const server = createBridge({token, dataDir: here});
  server.on('error', e => { console.error(`Bridge: ${e.message}`); process.exit(1); });
  server.listen(8989, '127.0.0.1', () => console.log('argon-web-bridge listening on 127.0.0.1:8989'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); process.exit(0); });
}
