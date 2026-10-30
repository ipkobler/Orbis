(() => {
  const key = 'kora.voice.preference';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'chip'; button.setAttribute('aria-label', 'Toggle silent mode'); const settings = document.getElementById('setBtn'); if (settings) settings.before(button); else document.body.append(button);
  let silent = sessionStorage.getItem(key) === 'silent';
  const render = () => { button.textContent = silent ? 'Voice: silent' : 'Voice: on'; button.setAttribute('aria-pressed', String(silent)); };
  const update = async action => { await fetch('/api/voice/state', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }); };
  button.addEventListener('click', async () => { silent = !silent; sessionStorage.setItem(key, silent ? 'silent' : 'enabled'); render(); window.dispatchEvent(new CustomEvent('kora-voice', { detail: { silent } })); try { await update(silent ? 'disable' : 'enable'); } catch {} });
  render();
})();
