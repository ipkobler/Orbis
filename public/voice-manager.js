// K.I.B.I. Voice Manager: pick each agent's voice, upload or record a new one, try voices out, rename and delete clips.
// Server side: /api/voices (server.js + voice-management.js). The page bridge is window.KIBI (index.html).
//
// Any audio the browser can play (wav, mp3, m4a, ogg, webm…) or a microphone recording is decoded here, trimmed to the
// part you select (5–15 s), optionally changed (tone, clean-up), and sent to the orb as a 24 kHz mono 16-bit WAV.
(() => {
  const K = window.KIBI;
  if (!K) return;
  const MIN = 5, MAX = 15, RATE = 24000;
  const SCRIPT = 'Good morning. All systems are online and standing by. I checked the overnight reports, and everything looks steady. Tell me what you would like to work on first, and I will get started right away.';
  const $ = (sel, root = sheet) => root.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pretty = n => String(n).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const fmtS = s => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
  const fmtDate = iso => { try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); } catch { return ''; } };
  const testLine = a => `This is ${K.acronym(a?.label || a?.id || '').replace(/\./g, ' ').trim()}. All systems are online and standing by.`;

  // ---------- styles ----------
  const css = el('style');
  css.textContent = `
#voiceSheet { width: min(700px, 100%); overflow-y: auto; overscroll-behavior: contain; gap: 16px; }
#voiceSheet > * { flex: none; }
.vm-sub { color: var(--dim); font-size: 13px; margin: -6px 0 0; }
.vm-msg { font-size: 13px; line-height: 1.45; border-radius: 10px; padding: 9px 12px; border: 1px solid var(--line); background: var(--void); }
.vm-msg.warn { border-color: color-mix(in srgb, var(--amber) 55%, var(--line)); color: var(--ink); background: color-mix(in srgb, var(--amber) 8%, transparent); }
.vm-msg.err { border-color: color-mix(in srgb, var(--alert) 60%, var(--line)); background: color-mix(in srgb, var(--alert) 9%, transparent); }
.vm-msg.ok { border-color: color-mix(in srgb, #3ee08f 50%, var(--line)); background: color-mix(in srgb, #3ee08f 7%, transparent); }
.vm-msg code { font: 12px var(--f-mono); overflow-wrap: anywhere; }
.vm-msg button { margin-left: 8px; }
.vm-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.vm-tab { display: inline-flex; align-items: center; gap: 8px; font: 600 12px/1 var(--f-display); letter-spacing: .12em; color: var(--dim); background: var(--void); border: 1px solid var(--line); border-radius: 999px; padding: 9px 14px; cursor: pointer; }
.vm-tab i { width: 8px; height: 8px; border-radius: 50%; }
.vm-tab[aria-selected="true"] { color: var(--ink); border-color: var(--vm); box-shadow: 0 0 16px -6px var(--vm) inset; }
.vm-now { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px 14px; align-items: center; padding: 14px; border: 1px solid color-mix(in srgb, var(--vm) 40%, var(--line)); border-radius: 14px;
  background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--vm) 14%, transparent), transparent 60%), var(--void); }
.vm-orb { width: 46px; height: 46px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff8, transparent 40%), radial-gradient(circle, var(--vm), color-mix(in srgb, var(--vm) 30%, #000) 75%);
  box-shadow: 0 0 22px -4px var(--vm); }
.vm-now .lbl { font: 500 10px/1 var(--f-display); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
.vm-now .nm { font: 600 17px/1.25 var(--f-display); letter-spacing: .04em; margin-top: 5px; overflow-wrap: anywhere; }
.vm-now .meta { color: var(--dim); font: 11px/1.4 var(--f-mono); margin-top: 3px; }
.vm-test { grid-column: 1 / -1; display: flex; gap: 8px; }
.vm-test input { flex: 1; min-width: 0; font: 14px var(--f-body); color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; }
.vm-sec { display: grid; gap: 8px; }
.vm-sec > h3 { margin: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; font: 600 11px/1 var(--f-display); letter-spacing: .2em; text-transform: uppercase; color: var(--dim); }
.vm-list { display: grid; gap: 6px; }
.vm-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 9px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--void); }
.vm-row.on { border-color: color-mix(in srgb, var(--vm) 60%, var(--line)); background: color-mix(in srgb, var(--vm) 7%, var(--void)); }
.vm-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); box-sizing: border-box; }
.vm-row.on .vm-dot { border-color: var(--vm); background: radial-gradient(circle, var(--vm) 0 40%, transparent 45%); box-shadow: 0 0 10px -2px var(--vm); }
.vm-row .t { min-width: 0; }
.vm-row .t b { display: block; font: 500 14px/1.3 var(--f-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vm-row .t small { display: block; color: var(--dim); font: 11px/1.4 var(--f-mono); }
.vm-row .t input { width: 100%; box-sizing: border-box; font: 14px var(--f-body); color: var(--ink); background: var(--panel); border: 1px solid var(--vm); border-radius: 8px; padding: 5px 8px; }
.vm-acts { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
.vm-b { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 8px; padding: 6px 9px; cursor: pointer; font: 12px/1 var(--f-body); white-space: nowrap; }
.vm-b:hover:not(:disabled) { border-color: var(--vm); }
.vm-b:disabled { opacity: .45; cursor: default; }
.vm-b.pri { border-color: var(--vm); background: color-mix(in srgb, var(--vm) 22%, var(--panel)); }
.vm-b.danger { color: var(--alert); }
.vm-b.danger.armed { background: var(--alert); color: #fff; border-color: var(--alert); }
.vm-b.busy { position: relative; color: transparent; }
.vm-b.busy::after { content: ''; position: absolute; inset: 0; margin: auto; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ink); border-right-color: transparent; animation: vmspin .7s linear infinite; }
@keyframes vmspin { to { transform: rotate(360deg); } }
.vm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.vm-grid .vm-row { grid-template-columns: 14px minmax(0, 1fr); padding: 8px 9px; }
.vm-grid .vm-row .vm-acts { grid-column: 1 / -1; justify-content: flex-start; }
.vm-grid .vm-dot { width: 12px; height: 12px; }
.vm-empty { color: var(--dim); font-size: 13px; padding: 12px; border: 1px dashed var(--line); border-radius: 12px; text-align: center; }
.vm-add { display: grid; gap: 12px; padding: 14px; border: 1px solid color-mix(in srgb, var(--vm) 45%, var(--line)); border-radius: 14px; background: var(--void); }
.vm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; justify-self: start; }
.vm-seg button { font: 500 11px/1 var(--f-display); letter-spacing: .14em; text-transform: uppercase; padding: 9px 14px; border: 0; background: transparent; color: var(--dim); cursor: pointer; }
.vm-seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--vm) 24%, transparent); color: var(--ink); }
.vm-drop { display: grid; place-items: center; gap: 6px; text-align: center; padding: 22px 14px; border: 1.5px dashed var(--line); border-radius: 12px; color: var(--dim); font-size: 13px; cursor: pointer; }
.vm-drop.over, .vm-drop:hover { border-color: var(--vm); color: var(--ink); }
.vm-drop b { color: var(--ink); font-weight: 500; }
.vm-rec { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: center; }
.vm-recbtn { width: 64px; height: 64px; border-radius: 50%; border: 2px solid var(--alert); background: color-mix(in srgb, var(--alert) 18%, var(--panel)); cursor: pointer; display: grid; place-items: center; }
.vm-recbtn i { width: 22px; height: 22px; border-radius: 50%; background: var(--alert); transition: border-radius .2s, transform .2s; }
.vm-recbtn.on i { border-radius: 5px; transform: scale(.85); }
.vm-recbtn.on { box-shadow: 0 0 0 0 var(--alert); animation: vmpulse 1.4s ease-out infinite; }
@keyframes vmpulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--alert) 60%, transparent); } 100% { box-shadow: 0 0 0 14px transparent; } }
.vm-clock { font: 600 20px/1 var(--f-mono); }
.vm-rec .vm-sub { margin: 8px 0 0; }
.vm-clock small { font-size: 12px; color: var(--dim); }
.vm-level { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 8px; }
.vm-level i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #3ee08f, var(--amber) 75%, var(--alert)); transition: width .06s; }
.vm-script { grid-column: 1 / -1; font-size: 14px; line-height: 1.55; color: var(--ink); border-left: 2px solid var(--vm); padding: 4px 0 4px 12px; }
.vm-script small { display: block; color: var(--dim); font: 10px/1 var(--f-display); letter-spacing: .18em; text-transform: uppercase; margin-bottom: 6px; }
.vm-wave { position: relative; height: 92px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); overflow: hidden; touch-action: none; user-select: none; }
.vm-wave canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.vm-sel { position: absolute; top: 0; bottom: 0; border: 2px solid var(--vm); border-radius: 8px; background: color-mix(in srgb, var(--vm) 12%, transparent); cursor: grab; box-sizing: border-box; }
.vm-sel.bad { border-color: var(--alert); }
.vm-h { position: absolute; top: 0; bottom: 0; width: 16px; cursor: ew-resize; }
.vm-h::after { content: ''; position: absolute; top: 30%; bottom: 30%; left: 6px; width: 4px; border-radius: 2px; background: var(--vm); }
.vm-h.l { left: -9px; } .vm-h.r { right: -9px; }
.vm-head { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; opacity: .8; pointer-events: none; display: none; }
.vm-wmeta { display: flex; justify-content: space-between; gap: 10px; color: var(--dim); font: 11px/1.4 var(--f-mono); flex-wrap: wrap; }
.vm-wmeta .bad { color: var(--alert); }
.vm-fx { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 14px; }
.vm-fx label { display: grid; gap: 6px; font: 500 10px/1.2 var(--f-display); letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
.vm-fx label.chk { display: flex; align-items: center; gap: 8px; letter-spacing: .08em; }
.vm-fx input[type=range] { accent-color: var(--vm); width: 100%; }
.vm-fx output { color: var(--ink); font: 11px var(--f-mono); letter-spacing: 0; text-transform: none; }
.vm-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.vm-form input[type=text], .vm-sec select { font: 14px var(--f-body); color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; min-width: 0; }
.vm-form label.chk { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--ink); }
.vm-form label.chk input { margin-top: 2px; accent-color: var(--vm); }
.vm-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.vm-browser { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: center; grid-column: 2 / -1; }
.vm-browser select { font-size: 13px; padding: 7px 8px; }
@media (max-width: 560px) {
  .vm-row { grid-template-columns: 18px minmax(0, 1fr); }
  .vm-row > .vm-acts { grid-column: 2 / -1; justify-content: flex-start; }
  .vm-browser { grid-template-columns: minmax(0, 1fr) auto; }
  .vm-browser select { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) { .vm-recbtn.on { animation: none; } .vm-b.busy::after { animation-duration: 2s; } }
`;
  document.head.append(css);

  // ---------- the sheet ----------
  const sheet = el('aside', 'sheet'); sheet.id = 'voiceSheet'; sheet.hidden = true; sheet.setAttribute('aria-label', 'Voice Manager');
  sheet.innerHTML = `<h2>Voice Manager <button class="close" type="button" aria-label="Close">×</button></h2>
    <p class="vm-sub">Choose how each agent sounds. Clips need 5–15 seconds of clear speech from one person.</p>
    <div class="vm-msgs"></div>
    <div class="vm-tabs" role="tablist" aria-label="Agent"></div>
    <div class="vm-now"></div>
    <section class="vm-sec vm-mine"></section>
    <section class="vm-sec vm-other"></section>
    <section class="vm-sec vm-builtin"></section>`;
  (document.getElementById('setSheet')?.parentElement || document.body).append(sheet);
  $('.close').addEventListener('click', () => close());
  addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) close(); });

  let data = null, sel = null, adding = null, flash = null, testText = '', loading = null;
  const S = { audio: null, playing: null };         // one sound at a time

  function close() { stopPlay(); stopRecording(true); sheet.hidden = true; }
  async function open(agentId) {
    K.openSheet('voiceSheet');
    sel = agentId || sel || K.current || K.agents[0]?.id;
    render();
    await load();
  }
  document.getElementById('vmOpen')?.addEventListener('click', () => open(K.current));

  async function load() {
    if (K.demo) { data = null; render(); return; }
    loading = fetch('/api/voices', { cache: 'no-store' }).then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(new Error(j.error || r.status))));
    try { data = await loading; } catch (e) { data = null; note('err', `Couldn't load voices: ${e.message}`); }
    loading = null; render();
  }
  function apply(j) { if (j && j.clips) { data = { ...data, agents: j.agents, clips: j.clips }; } }
  async function api(method, url, body, raw) {
    const r = await fetch(url, { method, headers: raw ? { 'Content-Type': 'audio/wav' } : body ? { 'Content-Type': 'application/json' } : {}, body: raw || (body ? JSON.stringify(body) : undefined) });
    const j = await r.json().catch(() => ({}));
    apply(j);
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { json: j });
    return j;
  }
  function note(kind, text, html) { flash = { kind, text, html, at: Date.now() }; renderMsgs(); if (kind === 'ok') setTimeout(() => { if (flash?.kind === 'ok') { flash = null; renderMsgs(); } }, 5000); }

  // ---------- playing and trying ----------
  function stopPlay() {
    if (S.audio) { S.audio.onended = null; S.audio.pause(); if (S.audio._url) URL.revokeObjectURL(S.audio._url); }
    try { S.node?.stop(); } catch {}
    S.audio = null; S.node = null;
    if (S.playing) { S.playing.classList.remove('busy'); S.playing.textContent = S.playing._label; S.playing = null; }
    speechSynthesis?.cancel?.();
  }
  function playingOn(btn) { stopPlay(); if (btn) { btn._label = btn.textContent; S.playing = btn; } }
  function stopLabel(btn) { if (btn) { btn.classList.remove('busy'); btn.textContent = '■ Stop'; } }
  async function playBlob(btn, getBlob) {
    if (S.playing === btn) return stopPlay();
    playingOn(btn); btn.classList.add('busy'); K.stopSpeech();
    try {
      const blob = await getBlob();
      if (S.playing !== btn) return;
      const a = new Audio(URL.createObjectURL(blob)); a._url = a.src; S.audio = a;
      a.onended = () => stopPlay();
      stopLabel(btn); await a.play();
    } catch (e) { stopPlay(); note('err', e.message); }
  }
  const fetchAudio = async (url, init) => { const r = await fetch(url, init); if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); } return r.blob(); };
  const tts = (agent, text, tryVoice) => fetchAudio('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, text: text.slice(0, 600), ...(tryVoice ? { try: tryVoice } : {}) }) });
  function tryOption(btn, opt) {
    const text = (testText || testLine(agentObj())).trim();
    if (opt.source === 'browser') {
      if (S.playing === btn) return stopPlay();
      playingOn(btn); stopLabel(btn); K.stopSpeech();
      if (!K.testBrowserVoice(sel, text, opt.name)) { stopPlay(); note('err', 'This browser has no speech voices.'); return; }
      const t = setInterval(() => { if (!speechSynthesis.speaking) { clearInterval(t); if (S.playing === btn) stopPlay(); } }, 250);
      return;
    }
    playBlob(btn, () => tts(sel, text, opt.current ? null : opt));
  }

  // ---------- choosing ----------
  async function choose(btn, choice) {
    btn.classList.add('busy'); btn.disabled = true;
    try {
      const j = await api('POST', '/api/voices/select', { agent: sel, ...choice });
      note(j.warning ? 'warn' : 'ok', j.warning || `${K.acronym(agentObj()?.label || sel)} now speaks with ${describe(choice).name}.`);
      if (choice.source !== 'browser' && K.engine === 'browser') note('warn', `${describe(choice).name} is picked, but this device is set to use the browser voice for every agent.`);
      K.refresh();
    } catch (e) { note('err', e.message); }
    render();
  }

  // ---------- render ----------
  const agentObj = (id = sel) => K.agents.find(a => a.id === id);
  const choiceOf = id => data?.agents?.[id] || { source: 'default' };
  const svc = () => data?.service || { enabled: false };
  const hasDefault = id => (svc().defaults || []).includes(String(id).toLowerCase());
  function describe(c, id = sel) {
    if (c.source === 'custom') { const clip = data?.clips?.find(x => x.id === c.clipId); return { name: clip ? `“${clip.name}”` : 'a custom clip', meta: clip ? `Your clip · ${fmtS(clip.durationSeconds)} · ${clip.origin === 'recording' ? 'recorded' : 'uploaded'} ${fmtDate(clip.createdAt)}` : '' }; }
    if (c.source === 'builtin') return { name: `${pretty(c.builtin)} (built-in)`, meta: 'Pocket TTS built-in voice' };
    if (c.source === 'browser') return { name: 'Browser voice', meta: K.browserVoiceFor(id) ? `${K.browserVoiceFor(id).replace(/^Microsoft /, '')} · this device` : 'this device' };
    return hasDefault(id) ? { name: 'Default clip', meta: `voices/${id} in the Orbis repo` } : { name: 'Default (browser voice)', meta: 'No clip in the repo for this agent yet' };
  }

  function renderMsgs() {
    const box = $('.vm-msgs'); box.textContent = '';
    const add = (kind, html) => { const d = el('div', 'vm-msg ' + kind); d.innerHTML = html; box.append(d); return d; };
    if (K.demo) { add('warn', 'The Voice Manager works on your server. This is the preview.'); return; }
    if (data) {
      const s = svc();
      if (!s.enabled) add('warn', 'No voice service is connected, so agents use the browser voice. You can still pick browser voices below.');
      else if (!s.ready) add('warn', `Voice service: ${escape(s.error || 'starting')}. You can upload clips now; they're checked once it's ready.`);
      else if (!s.managed) add('warn', 'Rebuild the voice service to use uploaded clips and built-in voices: <code>docker compose up -d --build voice</code>');
      else if (s.sharedFolder === false) add('warn', 'The voice service can’t see the orb’s voice folder, so uploaded clips can’t be used yet. See README → Voice Manager.');
      if (K.engine === 'browser') { const d = add('warn', 'This device is set to the <b>browser voice</b> for every agent (Settings → Agent voices).'); const b = el('button', 'vm-b', 'Use agent voices'); b.type = 'button'; b.addEventListener('click', () => { K.setEngine('clone'); render(); }); d.append(b); }
    }
    if (flash) { const d = add(flash.kind, ''); d.textContent = flash.text; }
  }
  const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    if (sheet.hidden) return;
    const a = agentObj();
    sheet.style.setProperty('--vm', K.agentColor(sel || 'main'));
    renderMsgs();
    // agent tabs
    const tabs = $('.vm-tabs'); tabs.textContent = '';
    for (const x of K.agents) {
      const t = el('button', 'vm-tab'); t.type = 'button'; t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(x.id === sel));
      const d = el('i'); d.style.background = K.agentColor(x.id); d.style.boxShadow = `0 0 8px ${K.agentColor(x.id)}`;
      t.append(d, document.createTextNode(K.acronym(x.label)));
      t.addEventListener('click', () => { if (sel === x.id) return; stopPlay(); stopRecording(true); adding = null; sel = x.id; testText = ''; render(); });
      tabs.append(t);
    }
    const ready = !!data && !K.demo;
    const c = choiceOf(sel), d = describe(c);
    // now speaking
    const now = $('.vm-now'); now.textContent = '';
    const orb = el('div', 'vm-orb');
    const info = el('div'); info.append(el('div', 'lbl', `${K.acronym(a?.label || sel || '')} speaks with`), el('div', 'nm', ready ? d.name : loading ? 'Loading…' : '—'), el('div', 'meta', ready ? d.meta : ''));
    const test = el('div', 'vm-test');
    const inp = el('input'); inp.type = 'text'; inp.maxLength = 300; inp.placeholder = testLine(a); inp.value = testText; inp.setAttribute('aria-label', 'Sentence to test with');
    inp.addEventListener('input', () => { testText = inp.value; });
    const tb = el('button', 'vm-b pri', '▶ Test voice'); tb.type = 'button'; tb.disabled = !ready;
    tb.addEventListener('click', () => {
      const effective = c.source === 'browser' || (c.source === 'default' && !hasDefault(sel)) || !svc().ready || K.engine === 'browser'
        ? { source: 'browser' } : { ...c, current: true };
      tryOption(tb, effective);
    });
    test.append(inp, tb);
    now.append(orb, info, test);

    renderMine(ready, c);
    renderBuiltin(ready, c);
    renderOther(ready, c);
  }

  function row({ on, title, meta, acts, rename }) {
    const r = el('div', 'vm-row' + (on ? ' on' : ''));
    const t = el('div', 't');
    if (rename) { const i = el('input'); i.type = 'text'; i.value = title; i.maxLength = 60; t.append(i); setTimeout(() => { i.focus(); i.select(); }); rename(i); }
    else t.append(el('b', '', title));
    if (meta) t.append(el('small', '', meta));
    const ac = el('div', 'vm-acts'); acts.forEach(x => x && ac.append(x));
    r.append(el('span', 'vm-dot'), t, ac);
    return r;
  }
  function btn(label, fn, cls = '', disabled = false, title = '') {
    const b = el('button', 'vm-b ' + cls, label); b.type = 'button'; b.disabled = disabled; if (title) b.title = title;
    b.addEventListener('click', () => fn(b)); return b;
  }
  function useBtn(on, choice, ready, disabled) {
    return on ? btn('In use', () => {}, 'pri', true) : btn('Use', b => choose(b, choice), '', !ready || disabled);
  }

  let renaming = null;
  function renderMine(ready, c) {
    const box = $('.vm-mine'); box.textContent = '';
    const h = el('h3', '', 'Your clips');
    const addB = btn(adding ? 'Cancel' : '+ Add a voice', () => { stopPlay(); stopRecording(true); adding = adding ? null : { mode: 'upload' }; render(); }, adding ? '' : 'pri', !ready);
    h.append(addB); box.append(h);
    if (adding) box.append(renderAdd());
    const clips = (data?.clips || []).filter(x => x.agent === sel);
    const others = (data?.clips || []).filter(x => x.agent !== sel && x.usedBy?.includes(sel));
    const list = el('div', 'vm-list');
    if (!clips.length && !others.length && !adding) list.append(el('div', 'vm-empty', ready ? 'No clips yet. Add a voice: upload a recording or record one now.' : 'Clips appear here.'));
    for (const clip of [...others, ...clips].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
      const on = c.source === 'custom' && c.clipId === clip.id;
      const elsewhere = (clip.usedBy || []).filter(x => x !== sel).map(x => K.acronym(agentObj(x)?.label || x));
      const meta = `${fmtS(clip.durationSeconds)} · ${clip.origin === 'recording' ? 'recorded' : 'uploaded'} ${fmtDate(clip.createdAt)}${elsewhere.length ? ` · also ${elsewhere.join(', ')}` : ''}`;
      const del = btn('Delete', b => {
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Delete?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.textContent = 'Delete'; } }, 4000); return; }
        b.classList.add('busy');
        api('DELETE', `/api/voices/clips/${clip.id}`).then(j => { note('ok', j.reverted?.length ? `Deleted. ${j.reverted.map(x => K.acronym(agentObj(x)?.label || x)).join(', ')} went back to the default voice.` : 'Clip deleted.'); K.refresh(); }).catch(e => note('err', e.message)).finally(render);
      }, 'danger', !ready);
      const r = row({ on, title: clip.name, meta, rename: renaming === clip.id ? i => {
        const done = save => { if (renaming !== clip.id) return; renaming = null; const v = i.value.trim(); if (save && v && v !== clip.name) api('PATCH', `/api/voices/clips/${clip.id}`, { name: v }).catch(e => note('err', e.message)).finally(render); else render(); };
        i.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        i.addEventListener('blur', () => done(true));
      } : null, acts: [
        btn('▶ Play', b => playBlob(b, () => fetchAudio(`/api/voices/clips/${clip.id}`)), '', !ready, 'Play the clip'),
        btn('Try', b => tryOption(b, { source: 'custom', clipId: clip.id }), '', !ready || !svc().ready, 'Hear the agent speak in this voice'),
        useBtn(on, { source: 'custom', clipId: clip.id }, ready),
        btn('Rename', () => { renaming = clip.id; render(); }, '', !ready),
        del,
      ] });
      list.append(r);
    }
    box.append(list);
  }

  let allBuiltin = false;
  function renderBuiltin(ready, c) {
    const box = $('.vm-builtin'); box.textContent = '';
    const names = svc().builtin || [];
    if (!ready || !names.length) return;
    const inUse = names.indexOf(c.source === 'builtin' ? c.builtin : '');
    const showAll = allBuiltin || inUse >= 8;
    const h = el('h3', '', 'Built-in voices');
    if (names.length > 8) h.append(btn(showAll ? 'Show fewer' : `Show all ${names.length}`, () => { allBuiltin = !showAll; render(); }));
    box.append(h);
    const grid = el('div', 'vm-grid');
    for (const n of showAll ? names : names.slice(0, 8)) {
      const on = c.source === 'builtin' && c.builtin === n;
      grid.append(row({ on, title: pretty(n), acts: [btn('Try', b => tryOption(b, { source: 'builtin', builtin: n }), '', !svc().ready), useBtn(on, { source: 'builtin', builtin: n }, ready, !svc().ready)] }));
    }
    box.append(grid);
  }

  function renderOther(ready, c) {
    const box = $('.vm-other'); box.textContent = '';
    box.append(el('h3', '', 'Other'));
    const list = el('div', 'vm-list');
    const dOn = c.source === 'default';
    const def = hasDefault(sel);
    list.append(row({ on: dOn, title: def ? 'Default clip' : 'Default', meta: def ? `voices/${sel} in the Orbis repo` : 'No clip in the repo for this agent, so this is the browser voice', acts: [
      def ? btn('▶ Play', b => playBlob(b, () => fetchAudio(`/api/voices/sample?agent=${encodeURIComponent(sel)}`)), '', !ready || !svc().ready) : null,
      def ? btn('Try', b => tryOption(b, { source: 'default' }), '', !ready || !svc().ready) : null,
      useBtn(dOn, { source: 'default' }, ready),
    ] }));
    const bOn = c.source === 'browser';
    const br = row({ on: bOn, title: 'Browser voice', meta: 'Spoken by this browser. Each device keeps its own pick.', acts: [useBtn(bOn, { source: 'browser' }, ready)] });
    const names = K.browserVoices();
    if (names.length) {
      const pick = el('div', 'vm-browser');
      const s = el('select'); s.setAttribute('aria-label', 'Browser voice');
      for (const n of names) { const o = el('option', '', n.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' (Natural)')); o.value = n; s.append(o); }
      s.value = K.browserVoiceFor(sel);
      s.addEventListener('change', () => { K.setBrowserVoice(sel, s.value); render(); });
      pick.append(s, btn('Try', b => tryOption(b, { source: 'browser', name: s.value })));
      br.append(pick);
    }
    list.append(br);
    box.append(list);
  }

  // ---------- adding a voice ----------
  let ctx = null;
  const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

  function renderAdd() {
    const box = el('div', 'vm-add');
    const seg = el('div', 'vm-seg');
    for (const [m, label] of [['upload', 'Upload file'], ['record', 'Record']]) {
      const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(adding.mode === m));
      b.addEventListener('click', () => { if (adding.mode === m) return; stopRecording(true); stopPlay(); adding = { mode: m }; render(); });
      seg.append(b);
    }
    box.append(seg);
    if (adding.buffer) { box.append(renderEditor()); return box; }
    if (adding.mode === 'upload') {
      const drop = el('label', 'vm-drop');
      drop.innerHTML = '<b>Drop an audio file here, or tap to choose</b><span>WAV, MP3, M4A, OGG… any length: you pick the 5–15 s to use</span>';
      const f = el('input'); f.type = 'file'; f.accept = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,.flac'; f.hidden = true;
      f.addEventListener('change', () => f.files[0] && loadFile(f.files[0]));
      drop.append(f);
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); const file = e.dataTransfer.files[0]; if (file) loadFile(file); });
      box.append(drop);
      if (adding.busy) drop.querySelector('b').textContent = 'Reading the file…';
    } else box.append(renderRecorder());
    return box;
  }

  async function loadFile(file) {
    if (file.size > 60 * 1024 * 1024) return note('err', 'That file is too large. Use a clip under 60 MB (only 5–15 s of it is kept).');
    adding.busy = true; render();
    try {
      const buf = await audioCtx().decodeAudioData(await file.arrayBuffer());
      setBuffer(buf, file.name.replace(/\.[^.]+$/, ''), 'upload');
    } catch { adding.busy = false; note('err', 'This browser can’t read that file. Try a WAV or MP3.'); render(); }
  }

  function setBuffer(buffer, name, origin) {
    if (buffer.duration < MIN) { note('err', `That's only ${fmtS(buffer.duration)}. A voice clip needs at least ${MIN} seconds of speech.`); adding = { mode: adding.mode }; render(); return; }
    // start at the first sound, take up to 15 s
    const ch = buffer.getChannelData(0); let first = 0; const thr = 0.02;
    for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > thr) { first = i; break; }
    let start = Math.max(0, first / buffer.sampleRate - 0.15);
    if (buffer.duration - start < MIN) start = Math.max(0, buffer.duration - MIN);
    adding = { mode: adding.mode, buffer, origin, name: name || '', start, end: Math.min(buffer.duration, start + MAX), semis: 0, clean: true, rumble: true, use: true, rights: origin === 'recording' };
    flash = null; render();
  }

  // ----- recorder -----
  const R = { stream: null, rec: null, chunks: [], t0: 0, timer: 0, raf: 0, an: null };
  function renderRecorder() {
    const wrap = el('div', 'vm-rec');
    const b = el('button', 'vm-recbtn' + (R.rec ? ' on' : '')); b.type = 'button'; b.append(el('i')); b.setAttribute('aria-label', R.rec ? 'Stop recording' : 'Start recording');
    b.addEventListener('click', () => R.rec ? stopRecording(false) : startRecording());
    const side = el('div');
    const clock = el('div', 'vm-clock'); clock.innerHTML = `<span>0.0</span> <small>/ ${MAX} s · at least ${MIN} s</small>`;
    const lv = el('div', 'vm-level'); lv.append(el('i'));
    side.append(clock, lv, el('div', 'vm-sub', R.rec ? 'Recording… read the lines below at your normal pace.' : 'Use a quiet room and hold the mic at a steady distance.'));
    const sc = el('div', 'vm-script'); sc.innerHTML = '<small>Read this</small>'; sc.append(document.createTextNode(SCRIPT));
    wrap.append(b, side, sc);
    R.ui = { clock: clock.querySelector('span'), level: lv.querySelector('i') };
    return wrap;
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return note('err', 'This browser can’t record audio. Upload a file instead.');
    K.stopSpeech(); stopPlay();
    try { R.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    catch (e) { return note('err', e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this site and try again.' : `Couldn't open the microphone: ${e.message}`); }
    const ac = audioCtx(); if (ac.state !== 'running') await ac.resume().catch(() => {});
    const src = ac.createMediaStreamSource(R.stream); R.an = ac.createAnalyser(); R.an.fftSize = 1024; src.connect(R.an);
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t));
    R.chunks = []; R.rec = new MediaRecorder(R.stream, type ? { mimeType: type } : undefined);
    R.rec.ondataavailable = e => e.data.size && R.chunks.push(e.data);
    R.rec.onstop = async () => {
      const discard = R.discard; const blob = new Blob(R.chunks, { type: R.rec?.mimeType || type || 'audio/webm' });
      cleanupRec();
      if (discard) return;
      try { setBuffer(await audioCtx().decodeAudioData(await blob.arrayBuffer()), `Recording ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, 'recording'); }
      catch { note('err', 'Couldn’t read the recording. Try again, or upload a file.'); render(); }
    };
    R.discard = false; R.rec.start(250); R.t0 = performance.now();
    render();
    const buf = new Float32Array(R.an.fftSize);
    const tick = () => {
      if (!R.rec) return;
      const t = (performance.now() - R.t0) / 1000;
      if (R.ui?.clock) R.ui.clock.textContent = t.toFixed(1);
      R.an.getFloatTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
      if (R.ui?.level) R.ui.level.style.width = Math.min(100, peak * 140) + '%';
      if (t >= MAX + 0.4) return stopRecording(false);        // a little extra; the editor trims to 15 s
      R.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopRecording(discard) {
    if (!R.rec) return;
    const t = (performance.now() - R.t0) / 1000;
    R.discard = discard;
    if (!discard && t < MIN) { R.discard = true; note('err', `That was ${fmtS(t)}. Keep going for at least ${MIN} seconds.`); }
    try { R.rec.stop(); } catch { cleanupRec(); }
  }
  function cleanupRec() { cancelAnimationFrame(R.raf); R.stream?.getTracks().forEach(t => t.stop()); R.stream = null; R.rec = null; R.an = null; if (adding && !adding.buffer) render(); }

  // ----- editor: pick the part to keep, change it, save -----
  function renderEditor() {
    const A = adding, buf = A.buffer, dur = buf.duration;
    const wrap = el('div', 'vm-form');
    const wave = el('div', 'vm-wave'); const cv = el('canvas'); wave.append(cv);
    const box = el('div', 'vm-sel'); const hl = el('div', 'vm-h l'), hr = el('div', 'vm-h r'); box.append(hl, hr);
    const head = el('div', 'vm-head'); wave.append(box, head);
    const meta = el('div', 'vm-wmeta');
    wrap.append(wave, meta);
    const place = () => {
      box.style.left = (A.start / dur * 100) + '%'; box.style.width = ((A.end - A.start) / dur * 100) + '%';
      const len = (A.end - A.start) / Math.pow(2, A.semis / 12);
      box.classList.toggle('bad', len < MIN);
      meta.innerHTML = `<span>Keeping ${fmtS(A.start)} – ${fmtS(A.end)} · <b class="${len < MIN ? 'bad' : ''}">${fmtS(len)}</b>${len < MIN ? ' (needs 5 s)' : ''}</span><span>Drag the box or its edges · file ${fmtS(dur)}</span>`;
      if (saveB) saveB.disabled = len < MIN || !A.rights;
    };
    requestAnimationFrame(() => drawWave(cv, buf));
    // dragging the selection
    let drag = null;
    const xToT = x => { const r = wave.getBoundingClientRect(); return Math.max(0, Math.min(dur, (x - r.left) / r.width * dur)); };
    wave.addEventListener('pointerdown', e => {
      const t = xToT(e.clientX);
      drag = e.target === hl ? 'l' : e.target === hr ? 'r' : e.target === box ? { off: t - A.start } : null;
      if (!drag) { const w = Math.min(MAX, A.end - A.start); A.start = Math.max(0, Math.min(dur - w, t - w / 2)); A.end = A.start + w; place(); return; }
      wave.setPointerCapture(e.pointerId); e.preventDefault();
    });
    wave.addEventListener('pointermove', e => {
      if (!drag) return; const t = xToT(e.clientX);
      if (drag === 'l') A.start = Math.max(Math.max(0, A.end - MAX), Math.min(t, A.end - 1));
      else if (drag === 'r') A.end = Math.min(Math.min(dur, A.start + MAX), Math.max(t, A.start + 1));
      else { const w = A.end - A.start; A.start = Math.max(0, Math.min(dur - w, t - drag.off)); A.end = A.start + w; }
      place();
    });
    const endDrag = () => { drag = null; };
    wave.addEventListener('pointerup', endDrag); wave.addEventListener('pointercancel', endDrag);

    // voice changer
    const fx = el('div', 'vm-fx');
    const tone = el('label'); tone.innerHTML = `<span>Tone · <output></output></span>`;
    const tr = el('input'); tr.type = 'range'; tr.min = -4; tr.max = 4; tr.step = 0.5; tr.value = A.semis; tone.append(tr);
    const tout = tone.querySelector('output');
    const toneText = () => { tout.textContent = A.semis === 0 ? 'unchanged' : `${A.semis > 0 ? 'higher' : 'deeper'} by ${Math.abs(A.semis)} (pace changes too)`; };
    tr.addEventListener('input', () => { A.semis = Number(tr.value); toneText(); place(); });
    toneText();
    const ck = (key, text) => { const l = el('label', 'chk'); const i = el('input'); i.type = 'checkbox'; i.checked = A[key]; i.addEventListener('change', () => { A[key] = i.checked; }); l.append(i, document.createTextNode(text)); return l; };
    fx.append(tone, ck('clean', 'Even out the volume'), ck('rumble', 'Remove low rumble and hum'));
    wrap.append(fx);

    const name = el('input'); name.type = 'text'; name.maxLength = 60; name.placeholder = 'Name this voice'; name.value = A.name; name.addEventListener('input', () => { A.name = name.value; });
    wrap.append(name);
    const use = el('label', 'chk'); const ui = el('input'); ui.type = 'checkbox'; ui.checked = A.use; ui.addEventListener('change', () => { A.use = ui.checked; });
    use.append(ui, document.createTextNode(`Use it for ${K.acronym(agentObj()?.label || sel)} right away`));
    const rights = el('label', 'chk'); const ri = el('input'); ri.type = 'checkbox'; ri.checked = A.rights; ri.addEventListener('change', () => { A.rights = ri.checked; place(); });
    rights.append(ri, document.createTextNode('This is my voice, or I have permission to use this voice.'));
    wrap.append(use, rights);

    const btns = el('div', 'vm-btns');
    const playOrig = btn('▶ Play selection', b => playBuffer(b, () => sliceBuffer(buf, A.start, A.end), head, A));
    const playFx = btn('▶ Preview changes', b => playBuffer(b, () => renderClip(A)));
    var saveB = btn('Save voice', b => saveClip(b), 'pri');
    const again = btn(A.origin === 'recording' ? 'Record again' : 'Choose another file', () => { stopPlay(); adding = { mode: adding.mode }; render(); });
    btns.append(playOrig, playFx, saveB, again);
    wrap.append(btns);
    place();
    return wrap;
  }

  function drawWave(cv, buf) {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / w));
    g.fillStyle = getComputedStyle(sheet).getPropertyValue('--vm') || '#4da3ff'; g.globalAlpha = .75;
    for (let x = 0; x < w; x++) {
      let mn = 0, mx = 0; const s0 = x * step;
      for (let i = s0; i < s0 + step && i < ch.length; i += 4) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const y1 = h / 2 - mx * h * .46, y2 = h / 2 - mn * h * .46;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }
  function sliceBuffer(buf, a, b) {
    const ac = audioCtx(), s0 = Math.floor(a * buf.sampleRate), n = Math.max(1, Math.floor((b - a) * buf.sampleRate));
    const out = ac.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(s0, s0 + n), c);
    return out;
  }
  // the clip as it will be saved: selection → tone → rumble filter → 24 kHz mono → even volume, trimmed to 15 s
  async function renderClip(A) {
    const part = sliceBuffer(A.buffer, A.start, A.end), rate = Math.pow(2, A.semis / 12);
    const len = Math.min(MAX, part.duration / rate);
    const off = new OfflineAudioContext(1, Math.ceil(len * RATE), RATE);
    const src = off.createBufferSource(); src.buffer = part; src.playbackRate.value = rate;
    let node = src;
    if (A.rumble) { const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7; node.connect(hp); node = hp;
      const hum = off.createBiquadFilter(); hum.type = 'notch'; hum.frequency.value = 60; hum.Q.value = 8; node.connect(hum); node = hum; }
    if (A.clean) { const comp = off.createDynamicsCompressor(); comp.threshold.value = -24; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2; node.connect(comp); node = comp; }
    node.connect(off.destination); src.start();
    const out = await off.startRendering();
    if (A.clean) { const d = out.getChannelData(0); let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v)); if (peak > 0.001) { const k = 0.89 / peak; for (let i = 0; i < d.length; i++) d[i] *= k; } }
    return out;
  }
  async function playBuffer(btn, make, head, A) {
    if (S.playing === btn) return stopPlay();
    playingOn(btn); btn.classList.add('busy'); K.stopSpeech();
    try {
      const b = await make(); if (S.playing !== btn) return;
      const ac = audioCtx(); if (ac.state !== 'running') await ac.resume();
      const n = ac.createBufferSource(); n.buffer = b; n.connect(ac.destination); S.node = n;
      n.onended = () => { if (S.node === n) { if (head) head.style.display = 'none'; stopPlay(); } };
      stopLabel(btn); n.start();
      if (head && A) { const t0 = ac.currentTime, dur = A.buffer.duration; head.style.display = 'block';
        const f = () => { if (S.node !== n) { head.style.display = 'none'; return; } head.style.left = ((A.start + ac.currentTime - t0) / dur * 100) + '%'; requestAnimationFrame(f); }; f(); }
    } catch (e) { stopPlay(); note('err', e.message); }
  }
  function wavBytes(buf) {
    const d = buf.getChannelData(0), n = d.length, out = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, d[i])); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }
  async function saveClip(b) {
    const A = adding; if (!A?.buffer) return;
    stopPlay(); b.classList.add('busy'); b.disabled = true;
    try {
      const out = await renderClip(A);
      if (out.duration < MIN - 0.01) throw new Error(`After the changes the clip is ${fmtS(out.duration)}; it needs at least ${MIN} seconds.`);
      const q = new URLSearchParams({ agent: sel, name: A.name.trim() || '', origin: A.origin, activate: A.use ? '1' : '0' });
      const j = await api('POST', `/api/voices/clips?${q}`, null, wavBytes(out));
      adding = null;
      note(j.warning ? 'warn' : 'ok', j.warning || (A.use ? `Saved “${j.clip.name}”. ${K.acronym(agentObj()?.label || sel)} speaks with it now.` : `Saved “${j.clip.name}”.`));
      K.refresh();
    } catch (e) { note('err', e.message); }
    render();
  }

  // re-render when the agent list changes (renames, colours)
  setInterval(() => { if (!sheet.hidden && !adding && !renaming && !S.playing && document.activeElement?.tagName !== 'INPUT') render(); }, 15000);
  window.KIBI.openVoiceManager = open;
})();
