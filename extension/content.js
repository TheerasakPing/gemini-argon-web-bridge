(() => {
  if (globalThis.__argonBridge) return;
  globalThis.__argonBridge = true;
  // A new document gets a new identity even when a reload preserves the same URL.
  const documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let pageUnloaded = false;
  globalThis.addEventListener?.('pagehide', () => { pageUnloaded = true; });
  const conversation = () => {
    const value = globalThis.location;
    if (!value) return '/app'; // Test environments without a Location.
    return `${value.origin}${value.pathname}${value.search}`;
  };
  let current = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const visible = el => {
    if (!el || el.getClientRects().length === 0) return false;
    // Hidden controls can retain layout boxes, including an idle Stop control.
    if (el.checkVisibility && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    for (let node = el; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === 'none' || Number(css.opacity) === 0) return false;
    }
    return true;
  };
  const first = selector => [...document.querySelectorAll(selector)].find(visible);
  const editor = () => first('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]');
  const stop = () => first('button.stop-button, button[data-test-id="stop-button"], button[aria-label*="Stop"], button[aria-label*="หยุด"]');
  const send = () => first('button.send-button, button[data-test-id="send-button"], button[aria-label="Send message"], button[aria-label="ส่งข้อความ"]');
  const model = () => first('[data-test-id="bard-mode-menu-button"], .model-switcher, button[aria-label*="model"]')?.innerText?.trim() || 'Selected in Gemini web (unverified)';
  const answers = () => [...document.querySelectorAll('model-response')].filter(visible);
  // Some Gemini surfaces split one answer into sibling response cards or streamed chunks.
  const responseGroup = lastResponse => {
    if (!lastResponse) return [];
    let group = lastResponse, parent = group.parentElement;
    while (parent && parent !== document.body) {
      const siblings = [...parent.children].filter(el => el.matches?.('model-response') && visible(el));
      if (!siblings.length) break;
      group = parent;
      if (siblings.length > 1) break;
      parent = group.parentElement;
    }
    const cards = typeof group.querySelectorAll === 'function'
      ? [...group.querySelectorAll('model-response')].filter(visible)
      : [lastResponse];
    return cards.length ? cards : [lastResponse];
  };
  // The response card also contains changing thinking/status headings. Streaming those
  // breaks the CLI's append-only prefix. Read every answer body, excluding nested
  // duplicates, so headings, tables and code within the body are still retained.
  const answerText = el => {
    const bodies = [...(el?.querySelectorAll('.model-response-text, message-content, .markdown-main-panel') || [])]
      .filter(node => visible(node) && !node.closest('model-thoughts, model-thoughts-content, thinking-panel, [data-test-id="thinking-content"]'));
    return bodies.filter(node => !bodies.some(other => other !== node && other.contains(node)))
      .map(node => node.innerText || '').filter(Boolean).join('\n\n').trim();
  };
  const draftText = input => (input?.innerText || '').replace(/\r/g,'').trim();
  // Gemini's composer turns each newline into a paragraph, so compare ignoring whitespace layout.
  const squash = text => String(text || '').replace(/\s+/g,' ').trim();
  const replaceAll = (input, text) => {
    input.focus();
    const selection = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertText',false,text)) throw new Error('Browser rejected insertText');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
  };

  // ---- Working indicator: a floating pill with an orbiting ring and moving bar.
  const LABELS = {typing:'กำลังพิมพ์คำถาม', sending:'กำลังส่งไปยัง Gemini', waiting:'รอ Gemini เริ่มตอบ',
    generating:'Gemini กำลังตอบ', finishing:'กำลังรวบรวมคำตอบ', done:'ได้คำตอบแล้ว', error:'เกิดข้อผิดพลาด'};
  const STYLE = `
    :host{all:initial}
    .pill{position:fixed;top:16px;left:50%;z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:10px;
      padding:10px 18px 12px 12px;border-radius:999px;color:#efeaff;background:rgba(21,16,40,.9);
      font:500 13px/1.2 system-ui,-apple-system,"Sukhumvit Set","Noto Sans Thai",sans-serif;
      box-shadow:0 8px 30px rgba(120,80,255,.35),0 0 0 1px rgba(170,140,255,.35);
      opacity:0;transform:translate(-50%,-14px);transition:opacity .25s ease,transform .25s ease}
    .pill.on{opacity:1;transform:translate(-50%,0)}
    .orb{position:relative;width:22px;height:22px;flex:none}
    .orb::before{content:"";position:absolute;inset:0;border-radius:50%;
      background:conic-gradient(#8b5cf6,#22d3ee,#c084fc,#8b5cf6);animation:spin 1.1s linear infinite;
      -webkit-mask:radial-gradient(circle,transparent 6px,#000 7px);mask:radial-gradient(circle,transparent 6px,#000 7px)}
    .orb::after{content:"";position:absolute;inset:8px;border-radius:50%;background:#c4b5fd;animation:pulse 1.2s ease-in-out infinite}
    .dots i{display:inline-block;width:4px;height:4px;margin-left:3px;border-radius:50%;background:#a78bfa;animation:bounce 1s ease-in-out infinite}
    .dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
    .meta{opacity:.6;font-variant-numeric:tabular-nums}
    .bar{position:absolute;left:16px;right:16px;bottom:4px;height:2px;border-radius:2px;overflow:hidden;background:rgba(167,139,250,.18)}
    .bar::after{content:"";position:absolute;inset:0;width:40%;background:linear-gradient(90deg,transparent,#a78bfa,#22d3ee,transparent);animation:slide 1.4s ease-in-out infinite}
    .pill.done .orb::before,.pill.done .orb::after{animation:none;background:#34d399}
    .pill.done .bar::after,.pill.err .bar::after{animation:none;width:100%;background:#34d399}
    .pill.done .dots,.pill.err .dots{display:none}
    .pill.err .orb::before,.pill.err .orb::after{animation:none;background:#f87171}
    .pill.err .bar::after{background:#f87171}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes pulse{0%,100%{transform:scale(.7);opacity:.6}50%{transform:scale(1.1);opacity:1}}
    @keyframes bounce{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-4px);opacity:1}}
    @keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
    .pill{padding:16px 22px 20px 16px;gap:14px;border-radius:22px;
      background:radial-gradient(ellipse at 10% 0,rgba(139,92,246,.32),transparent 65%),rgba(15,12,32,.96);
      border:1px solid rgba(167,139,250,.5);box-shadow:0 12px 48px #07051588,0 0 32px #8b5cf644;
      max-width:calc(100vw - 64px);flex-wrap:wrap;animation:aura 3s ease-in-out infinite}
    .orb{width:36px;height:36px;filter:drop-shadow(0 0 7px #22d3ee88)}
    .orb::before{inset:5px;-webkit-mask:radial-gradient(circle,transparent 8px,#000 9px);
      mask:radial-gradient(circle,transparent 8px,#000 9px)}
    .orb::after{inset:14px;background:#cffafe}
    .orbit{position:absolute;inset:-3px;border:1px solid #22d3ee66;border-top-color:#cffafe;
      border-radius:50%;animation:spin 2s linear infinite}
    .orbit::after{content:"";position:absolute;top:1px;left:7px;width:4px;height:4px;border-radius:50%;
      background:#67e8f9;box-shadow:0 0 9px #22d3ee}
    .orbit.outer{inset:-8px;border-color:#c084fc44;border-left-color:#c084fc;animation:spin 3.5s linear infinite reverse}
    .signal{display:flex;gap:3px;align-items:center;height:24px}
    .signal i{width:3px;height:18px;border-radius:3px;background:linear-gradient(#67e8f9,#a78bfa);
      transform-origin:center;animation:equalize .9s ease-in-out infinite alternate}
    .signal i:nth-child(2n){animation-delay:-.25s}.signal i:nth-child(3n){animation-delay:-.6s}
    .signal i:nth-child(4n){animation-delay:-.4s}
    .pill .bar{height:3px;bottom:7px}
    .pill .bar::after{width:35%;box-shadow:0 0 10px #22d3ee;animation-duration:1s}
    .pill.done,.pill.err{animation:none}
    .pill.done .signal i,.pill.err .signal i{animation:none;transform:scaleY(.2)}
    .pill.done .orbit,.pill.err .orbit{animation:none}
    @keyframes equalize{from{transform:scaleY(.2);opacity:.4}to{transform:scaleY(1);opacity:1}}
    @keyframes aura{0%,100%{box-shadow:0 12px 48px #07051588,0 0 22px #8b5cf644}
      50%{box-shadow:0 12px 48px #07051588,0 0 40px #22d3ee44}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
  function createOverlay() {
    if (typeof document.createElement !== 'function' || !document.documentElement?.appendChild) return null;
    try {
      const host = document.createElement('argon-bridge-overlay');
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = `<style>${STYLE}</style><div class="pill" role="status" aria-live="polite">
        <span class="orb" aria-hidden="true"><i class="orbit"></i><i class="orbit outer"></i></span>
        <span class="label"></span>
        <span class="signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
        <span class="meta"></span><span class="bar"></span></div>`;
      document.documentElement.appendChild(host);
      const pill = root.querySelector('.pill'), label = root.querySelector('.label'), meta = root.querySelector('.meta');
      const startedAt = Date.now(); let chars = 0, ticker = null, closed = false;
      const paint = () => { meta.textContent = `${((Date.now()-startedAt)/1000).toFixed(0)}s${chars ? ` · ${chars} ตัวอักษร` : ''}`; };
      const close = delay => setTimeout(() => {
        closed = true; clearInterval(ticker); pill.classList.remove('on');
        setTimeout(() => host.remove(), 400);
      }, delay);
      requestAnimationFrame(() => pill.classList.add('on'));
      ticker = setInterval(paint, 250);
      return {
        show(phase, length) {
          if (closed) return;
          chars = length || 0; label.textContent = LABELS[phase] || phase; paint();
        },
        finish(ok, message) {
          if (closed) return;
          pill.classList.add(ok ? 'done' : 'err');
          label.textContent = ok ? LABELS.done : `${LABELS.error}: ${String(message || '').slice(0, 80)}`;
          paint(); close(ok ? 1800 : 5000);
        },
      };
    } catch { return null; }
  }

  async function deliver(job, result) {
    current.result = result;
    while (Date.now() < job.deadline + 120000) {
      try { if ((await chrome.runtime.sendMessage({type:'argon:result',id:job.id,documentId,result}))?.accepted) return; } catch { /* Retry after worker wake. */ }
      await sleep(3000);
    }
  }
  async function run(job) {
    if (current?.id === job.id) return;
    if (current && !current.result) throw new Error('Gemini bridge already busy');
    current = {id:job.id,result:null};
    let ownedConversation = conversation(), submitted = false, promotedConversation = false, ownedInput, beforeQueries = new Set();
    const newQueries = () => [...document.querySelectorAll('user-query')].filter(el => !beforeQueries.has(el));
    const queryText = el => {
      const text = el.querySelector?.('.query-text') || el;
      return squash(text.textContent || text.innerText);
    };
    const matchesPrompt = el => queryText(el) === squash(job.prompt);
    const assertOwnership = () => {
      if (pageUnloaded || (job.documentId && job.documentId !== documentId))
        throw new Error('Gemini document reloaded during job; result discarded');
      if (ownedInput && editor() !== ownedInput)
        throw new Error('Gemini conversation composer changed during job; result discarded');
      const queries = submitted ? newQueries() : [];
      if (queries.length > 1 || queries.some(el => queryText(el) && !matchesPrompt(el)))
        throw new Error('Gemini received a different user prompt during job; result discarded');
      const actual = conversation();
      if (actual === ownedConversation) return true;
      // Gemini assigns /app/<id> to a fresh /app chat after the first submission.
      // Accept that transition only once and only while the same composer survives.
      if (submitted && !promotedConversation && /\/app\/?$/.test(ownedConversation) &&
          /\/app\/[^/?]+$/.test(actual) && ownedInput === editor()) {
        // Route assignment and prompt rendering may land in separate DOM updates.
        // While identity is incomplete, do not read or emit any response.
        if (queries.length !== 1 || !matchesPrompt(queries[0])) return false;
        ownedConversation = actual; promotedConversation = true; return true;
      }
      throw new Error('Gemini conversation changed during job; result discarded');
    };
    const options = job.options || {};
    const view = createOverlay();
    let lastPhase = '', lastPartial = '', lastSent = 0, stashedDraft = null;
    const report = (phase, partial = '') => {
      view?.show(phase, partial.length);
      const now = Date.now();
      // Preserve every DOM update for terminal streaming; skip only exact duplicates.
      if (phase === lastPhase && partial === lastPartial) return;
      lastPhase = phase; lastPartial = partial; lastSent = now;
      try { chrome.runtime.sendMessage({type:'argon:progress',id:job.id,documentId,phase,partial})?.catch?.(() => {}); } catch { /* Progress is best-effort. */ }
    };
    let outcome;
    try {
      const input = editor();
      ownedInput = input;
      assertOwnership();
      if (!input) throw new Error('Gemini editor missing; sign in or check DOM selectors');
      if (stop()) throw new Error('Gemini is generating another response');
      if (draftText(input)) {
        if (!options.force) throw new Error('Gemini contains an unsent draft; clear it or use --force to stash and restore it');
        stashedDraft = input.innerText;
      }
      const before = new Set(answers());
      beforeQueries = new Set(document.querySelectorAll('user-query'));
      report('typing');
      replaceAll(input, job.prompt);
      if (squash(input.innerText) !== squash(job.prompt)) throw new Error('Prompt insertion verification failed; inspect draft');
      let button;
      for (let i=0;i<40;i++) { assertOwnership(); button=send(); if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') break; await sleep(250); }
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('Gemini send button unavailable; check account limit');
      report('sending');
      assertOwnership();
      submitted = true;
      button.click();
      report('waiting');
      let sawStop=false, last='', stableSince=Date.now(), found=null;
      const deadline = Math.min(job.deadline-5000,Date.now()+140000);
      while (Date.now()<deadline) {
        await sleep(100);
        if (!assertOwnership()) continue;
        const stopping = Boolean(stop()); sawStop ||= stopping;
        const response = answers().filter(el=>!before.has(el)).at(-1);
        const text = responseGroup(response).filter(el=>!before.has(el)).map(answerText).filter(Boolean).join('\n\n');
        if (text !== last) { last=text; stableSince=Date.now(); }
        report(stopping || text ? 'generating' : 'waiting', text);
        // Require a NEW answer plus stability; absence of Stop alone is insufficient.
        if (text && !stopping && Date.now()-stableSince > (sawStop ? 2500:6000)) { found = text; break; }
      }
      if (found === null) throw new Error('Gemini response timed out or selectors changed; inspect tab before retrying');
      assertOwnership();
      report('finishing', found);
      outcome = {text:found,model:model()};
    } catch (e) { outcome = {error:e.message,model:model()}; }
    if (stashedDraft !== null) {
      try { assertOwnership(); const input = editor(); if (input && !draftText(input)) replaceAll(input, stashedDraft); }
      catch { /* Draft restore is best-effort; the answer is still delivered. */ }
    }
    view?.finish(!outcome.error, outcome.error);
    await deliver(job, outcome);
  }
  chrome.runtime.onMessage.addListener((message,_sender,reply) => {
    if (message.type === 'argon:ping') {
      const input=editor();
      const stopButton = stop();
      const draft = Boolean(input) && !stopButton && Boolean(draftText(input));
      const busy = Boolean(current && !current.result);
      reply({ready:Boolean(input) && !stopButton && !draft && !busy,draft:draft && !busy,generating:Boolean(stopButton),
        jobId:current?.id,documentId,conversation:conversation(),model:model(),title:globalThis.document?.title,
        error:!input ? 'Gemini editor missing; sign in' : stopButton ? 'Gemini is generating' : draft ? 'Unsent draft in Gemini' : ''});
    }
    if (message.type === 'argon:doctor') {
      reply({url:globalThis.location?.href,editor:Boolean(editor()),send:Boolean(send()),stop:Boolean(stop()),
        model:model(),answers:answers().length,draft:Boolean(draftText(editor()))});
    }
    if (message.type === 'argon:run') {
      if (current && current.id !== message.task.id && !current.result) { reply({accepted:false}); return; }
      reply({accepted:true}); void run(message.task);
    }
  });
})();
