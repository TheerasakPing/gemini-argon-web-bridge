importScripts('config.js');
const BASE = 'http://127.0.0.1:8989';
const GEMINI = 'https://gemini.google.com/*';
const JSON_HEADERS = {'Content-Type':'application/json'};
let polling = false, streaming = false;
const auth = {Authorization: `Bearer ${ARGON_TOKEN}`};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, options = {}) {
  const response = await fetch(BASE + path, {...options, headers:{...auth, ...options.headers}, signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  return response.json();
}
const post = (path, body) => api(path, {method:'POST', headers:JSON_HEADERS, body:JSON.stringify(body)});
const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const saved = await chrome.storage.local.get('clientId');
  if (!saved.clientId) await chrome.storage.local.set({clientId:crypto.randomUUID()});
  await chrome.alarms.create('argon-poll', {periodInMinutes:0.5});
})();
async function ping(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, {type:'argon:ping'}); }
  catch {
    await chrome.scripting.executeScript({target:{tabId}, files:['content.js']});
    return chrome.tabs.sendMessage(tabId, {type:'argon:ping'});
  }
}
// Chrome storage has no compare-and-swap. Serialize every owner/outbox mutation so
// a delayed write cannot resurrect a result after navigation invalidated it.
let ownerMutation = Promise.resolve();
const withOwner = action => {
  const next = ownerMutation.then(action);
  ownerMutation = next.catch(() => {});
  return next;
};
async function flush() { return withOwner(async () => {
  const {outbox = {}} = await chrome.storage.local.get('outbox');
  for (const [id, result] of Object.entries(outbox)) {
    try {
      await post(`/jobs/${id}/response`, result);
    } catch (e) {
      if (!/HTTP (404|409)/.test(e.message)) throw e;
    }
    // Re-read to preserve newly added results while the request was in flight.
    const latest = (await chrome.storage.local.get('outbox')).outbox || {};
    delete latest[id]; await chrome.storage.local.set({outbox:latest});
    const {active} = await chrome.storage.local.get('active');
    if (active?.id === id) await chrome.storage.local.remove(['active', 'job']);
  }
}); }
async function invalidateActive(message, expectedId, expectedTab) { return withOwner(async () => {
  const {active,outbox = {}} = await chrome.storage.local.get(['active','outbox']);
  if (!active || (expectedId && active.id !== expectedId) ||
      (expectedTab !== undefined && active.tabId !== expectedTab)) return;
  active.invalid = true;
  outbox[active.id] = {claimToken:active.claimToken,error:message};
  await chrome.storage.local.set({active,outbox});
}); }
const ownsDocument = (active, message, sender) => active && !active.invalid &&
  active.id === message.id && active.tabId === sender.tab?.id &&
  active.documentId === message.documentId;
const matchTab = (tabs, wanted) => {
  if (/^\d+$/.test(wanted)) return tabs.find(t => String(t.id) === wanted);
  const needle = wanted.toLowerCase();
  return tabs.find(t => String(t.id) === wanted) || tabs.find(t => (t.title || '').toLowerCase().includes(needle));
};
async function openNewChat(tabId) {
  let cancelWait;
  const completed = new Promise(resolve => {
    let timer;
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    cancelWait = done;
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(done, 15000);
  });
  try { await chrome.tabs.update(tabId, {url:'https://gemini.google.com/app'}); }
  catch (error) { cancelWait(); throw error; }
  await completed;
  for (let i = 0; i < 30; i++) {
    try { if ((await ping(tabId)).ready) return true; } catch { /* Content script is still loading. */ }
    await sleep(500);
  }
  return false;
}
async function runDoctor(task, {sorted, states}) {
  const report = {extensionVersion:chrome.runtime.getManifest().version, tabs:sorted.map(t => ({id:t.id, title:t.title, active:t.active, state:states.get(t.id)}))};
  if (!sorted.length) report.error = 'No Gemini tab open';
  else {
    try { report.checks = await chrome.tabs.sendMessage(sorted[0].id, {type:'argon:doctor'}); }
    catch (e) { report.error = e.message; }
  }
  await post(`/jobs/${task.id}/response`, {claimToken:task.claimToken, text:JSON.stringify(report)});
}
async function dispatch(task, ctx) {
  const {active, tabs, states} = ctx;
  const fail = message => post(`/jobs/${task.id}/response`, {claimToken:task.claimToken, error:message});
  if (task.kind === 'doctor') return runDoctor(task, ctx);
  if (active && active.id === task.id) {
    // Already dispatched. A missing jobId means the page reloaded and lost the job.
    if (states.get(active.tabId)?.jobId !== task.id || states.get(active.tabId)?.documentId !== active.documentId) {
      await fail('Page reloaded during job; inspect Gemini before retrying');
      await withOwner(() => chrome.storage.local.remove(['active', 'job']));
    }
    return;
  }
  const wanted = task.options?.tab;
  const target = wanted ? matchTab(tabs, wanted) : ctx.tab;
  if (!target) return fail(wanted ? `No Gemini tab matches "${wanted}"` : 'No ready Gemini tab');
  const state = states.get(target.id);
  if (!(state?.ready || (state?.draft && task.options?.force))) return fail(`Gemini tab not ready: ${state?.error || 'busy'}`);
  if (task.options?.newChat && !(await openNewChat(target.id))) return fail('Could not open a new Gemini chat; inspect the tab');
  const owner = await ping(target.id);
  if (!owner.documentId || !(owner.ready || (owner.draft && task.options?.force)))
    return fail('Gemini document changed before dispatch; inspect the tab');
  await withOwner(() => chrome.storage.local.set({active:{id:task.id, tabId:target.id, documentId:owner.documentId, claimToken:task.claimToken, startedAt:Date.now()}}));
  const accepted = await chrome.tabs.sendMessage(target.id, {type:'argon:run', task:{id:task.id, documentId:owner.documentId,
    prompt:task.prompt, deadline:task.deadline, options:task.options}});
  if (!accepted?.accepted) await invalidateActive('Gemini refused job dispatch; inspect the tab', task.id);
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    await initialized; await flush();
    const {clientId, active} = await chrome.storage.local.get(['clientId','active']);
    const tabs = await chrome.tabs.query({url:GEMINI});
    const sorted = [...tabs].sort((a,b) => Number(b.active)-Number(a.active));
    const states = new Map();
    for (const t of sorted) {
      try { states.set(t.id, await ping(t.id)); } catch (e) { states.set(t.id, {ready:false, error:e.message}); }
    }
    if (active && !active.invalid && (states.get(active.tabId)?.documentId !== active.documentId ||
        states.get(active.tabId)?.jobId !== active.id)) {
      await invalidateActive('Gemini document reloaded or assigned tab closed during job; result discarded', active.id);
      await flush();
      return;
    }
    let tab, state = {ready:false, error:'Open gemini.google.com and sign in'};
    if (active) {
      tab = tabs.find(t => t.id === active.tabId);
      state = tab ? states.get(tab.id) : {ready:false, error:'Assigned Gemini tab closed; job will not be resubmitted'};
    } else if (sorted.length) {
      tab = sorted.find(t => states.get(t.id)?.ready) || sorted.find(t => states.get(t.id)?.draft);
      state = states.get((tab || sorted[0]).id);
    }
    const summary = sorted.slice(0, 8).map(t => ({id:t.id, title:(t.title || '').slice(0, 40),
      ready:Boolean(states.get(t.id)?.ready), generating:Boolean(states.get(t.id)?.generating)}));
    const query = new URLSearchParams({client:clientId, ready:state.ready ? '1':'0', draft:state.draft ? '1':'0',
      error:state.error || '', model:state.model || '', tabs:JSON.stringify(summary)});
    const {task} = await api(`/api/pending_task?${query}`);
    if (task) await dispatch(task, {active, tab, tabs, sorted, states, state});
    else if (active && !(await api(`/jobs/${active.id}`).catch(() => null))?.status?.match(/queued|running/)) {
      await withOwner(() => chrome.storage.local.remove(['active', 'job']));
    }
    await chrome.storage.local.set({status:{connected:true, ...state, tabs:summary, checkedAt:Date.now()}});
  } catch (e) { await chrome.storage.local.set({status:{connected:false, ready:false, error:e.message, checkedAt:Date.now()}}); }
  finally { polling = false; }
}
async function stream() {
  if (streaming) return;
  streaming = true;
  try {
    await initialized;
    // EventSource is unavailable in extension service workers. Parse SSE via fetch.
    const response = await fetch(BASE+'/events', {headers:auth,signal:AbortSignal.timeout(55000)});
    if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const {value,done} = await reader.read(); if (done) break;
      buffer += decoder.decode(value,{stream:true});
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0,end); buffer = buffer.slice(end+2);
        if (event.includes('event: pending')) void poll();
      }
    }
  } catch { /* Alarm/polling remains the durable fallback when SSE disconnects. */ }
  finally { streaming = false; }
}
chrome.runtime.onMessage.addListener((message,sender,reply) => {
  if (message.type === 'argon:result') {
    (async () => {
      await initialized;
      const accepted = await withOwner(async () => {
        const {active,outbox = {}} = await chrome.storage.local.get(['active','outbox']);
        if (!ownsDocument(active, message, sender)) return false;
        outbox[message.id] = {...message.result,claimToken:active.claimToken};
        await chrome.storage.local.set({outbox});
        return true;
      });
      reply({accepted}); if (accepted) void poll();
    })().catch(e => reply({accepted:false,error:e.message}));
    return true;
  }
  if (message.type === 'argon:progress') {
    (async () => {
      const partial = typeof message.partial === 'string' ? message.partial : '';
      const ok = await withOwner(async () => {
        const {active} = await chrome.storage.local.get('active');
        if (!ownsDocument(active, message, sender)) return false;
        await chrome.storage.local.set({job:{id:message.id, phase:message.phase, chars:partial.length, startedAt:active.startedAt, updatedAt:Date.now()}});
        await post(`/jobs/${message.id}/progress`, {claimToken:active.claimToken, phase:message.phase, partial}).catch(() => {});
        return true;
      });
      reply({ok});
    })().catch(e => reply({ok:false,error:e.message}));
    return true;
  }
  if (message.type === 'argon:refresh') { poll().then(() => reply({ok:true})); return true; }
  if (message.type === 'argon:reload') { reply({ok:true}); setTimeout(() => chrome.runtime.reload(), 100); }
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'argon-poll') { void poll(); void stream(); } });
chrome.tabs.onUpdated.addListener((id,info,tab) => {
  // Gemini moves a fresh /app chat to /app/<id> after submit, and that URL change also reports 'loading'.
  // A Gemini URL change is that promotion, so it must not cancel the job. Reloads and navigation away
  // from Gemini still invalidate here.
  if (info.status === 'loading' && !(info.url && info.url.startsWith('https://gemini.google.com/')))
    void invalidateActive('Gemini page navigated or reloaded during job; result discarded', undefined, id);
  if (info.status === 'complete' && tab.url?.startsWith('https://gemini.google.com/')) void poll();
});
chrome.tabs.onRemoved.addListener(id => {
  void invalidateActive('Assigned Gemini tab closed during job; result discarded', undefined, id);
});
chrome.runtime.onStartup.addListener(() => { void poll(); void stream(); });
chrome.runtime.onInstalled.addListener(() => { void poll(); void stream(); });
setInterval(() => { void poll(); void stream(); },5000);
void poll(); void stream();
