(() => {
  const key = 'kibi.voice.preference';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'chip'; button.setAttribute('aria-label', 'Toggle silent mode'); button.style.position = 'fixed'; button.style.right = '16px'; button.style.bottom = '16px'; button.style.zIndex = '20'; document.body.append(button);
  let silent = sessionStorage.getItem(key) === 'silent';
  const render = () => { button.textContent = silent ? 'Voice: silent' : 'Voice: on'; button.setAttribute('aria-pressed', String(silent)); };
  const update = async action => { await fetch('/api/voice/state', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }); };
  button.addEventListener('click', async () => { silent = !silent; sessionStorage.setItem(key, silent ? 'silent' : 'enabled'); await update(silent ? 'disable' : 'enable'); if (silent && window.speechSynthesis) window.speechSynthesis.cancel(); render(); });
  render();
})();
