import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../public/power-sequence.js');
const P = globalThis.KIBIPower;
const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

// the main script's startup & shutdown code, from the sound engine to the end of powerDown()
const flow = page.slice(page.indexOf('// ---------- startup & shutdown sounds ----------'), page.indexOf("$('powerBtn').addEventListener"));
const sfxEngine = flow.slice(0, flow.indexOf('// Browsers only allow sound after a tap'));
const bootFn = flow.slice(flow.indexOf('async function runBoot('), flow.indexOf("$('replayBoot')"));
const shutdownFn = flow.slice(flow.indexOf('async function powerDown('));
// the boot console's CSS
const bootCss = page.slice(page.indexOf('/* ---------- startup & shutdown: K.I.B.I. HUD ---------- */'), page.indexOf('/* shorter screens: fewer blocks */'));

// ---- theme selection ----
test('Light, Dark and System resolve to the theme the console is drawn in', () => {
  assert.equal(P.resolveTheme('light', false), 'light');
  assert.equal(P.resolveTheme('dark', true), 'dark');
  assert.equal(P.resolveTheme('system', true), 'light');
  assert.equal(P.resolveTheme('system', false), 'dark');
  assert.equal(P.resolveTheme('bogus', true), 'light');
  assert.match(page, /const resolved = KIBIPower\.resolveTheme\(chosen, themeQuery\.matches\)/);
});

test('each theme has its own console palette, and the canvas follows theme changes', () => {
  assert.notDeepEqual(P.palette('light').accent, P.palette('dark').accent);
  assert.deepEqual(P.palette('system-unknown'), P.palette('dark'));
  assert.match(page, /dispatchEvent\(new CustomEvent\('kibi-theme'/);
  assert.match(page, /addEventListener\('kibi-theme', hudPalette\)/);
  assert.match(page, /PAL = KIBIPower\.palette\(document\.documentElement\.dataset\.theme\)/);
  assert.doesNotMatch(page, /const R_ = 'rgba\(255,59,77,'/);
});

test('boot and shutdown visuals use semantic theme tokens, with no hard-coded colours', () => {
  assert.match(page, /:root \{[^}]*--boot-accent: #ff4d5e/);
  assert.match(page, /:root\[data-theme="light"\] \{[^}]*--boot-accent: #c62f3e/);
  assert.match(bootCss, /--kibi: var\(--boot-accent\)/);
  assert.match(bootCss, /--kp: color-mix\(in srgb, var\(--panel\) 82%, transparent\)/);
  assert.match(bootCss, /background: radial-gradient\(ellipse 60% 55% at 50% 44%, var\(--void-hi\) 0%, var\(--void\) 42%, var\(--void-lo\) 100%\)/);
  assert.match(bootCss, /\.boot\.off \{ background: var\(--void-lo\)/);
  assert.doesNotMatch(bootCss, /#(?:fff|ff5a6a|01040a|1a0f22|5aa8ff|ff3b4d)\b/i);
});

test('the treatment is restrained: no glitch, CRT collapse or flicker keyframes', () => {
  assert.doesNotMatch(bootCss, /@keyframes (glitch|crt)\b/);
  assert.doesNotMatch(bootCss, /brightness\((?:[2-9]|1\.[5-9])/);
  assert.match(bootCss, /\.kh-name\.reveal \{ animation: nameReveal/);
  assert.match(bootFn, /nm\.classList\.add\('reveal'\)/);
});

// ---- timing and order ----
test('shutdown completes faster than boot, overall and stage by stage', () => {
  const sizes = [{ systems: 6, panels: 8 }, { systems: 10, panels: 12 }, { systems: 16, panels: 14 }];
  for (const n of sizes) assert.ok(P.nominalDuration('shutdown', n) < P.nominalDuration('boot', n), JSON.stringify(n));
  const b = P.TIMING.boot, s = P.TIMING.shutdown;
  assert.ok(s.voom < b.voom);
  assert.ok(s.panel < b.panel);
  assert.ok(s.orbUndraw < b.orbDraw);
  assert.ok(s.rowDrain[0] + s.rowDrain[1] < b.rowLoad[0] + b.rowLoad[1]);
  assert.ok(P.voomPlan('down').dur < P.voomPlan('up').dur);
});

test('the sequences take their timings from KIBIPower.TIMING', () => {
  for (const key of ['intro', 'settle', 'handoff', 'orbDraw', 'speechDelay', 'step', 'panel']) assert.match(flow, new RegExp(`T\\.boot\\.${key}\\b`), key);
  for (const key of ['speechLead', 'orbUndraw', 'handoff', 'hudIn', 'step', 'hold', 'fade', 'dark', 'panel']) assert.match(flow, new RegExp(`T\\.shutdown\\.${key}\\b`), key);
});

test('boot order: rising voom → systems load → orb draws → K.I.R.K. speaks', () => {
  const voom = bootFn.indexOf('sfx.boot()'), rows = bootFn.indexOf('while (i < systems.length)'), orb = bootFn.indexOf('animateOrbDraw(1, T.boot.orbDraw)'), say = bootFn.indexOf('kirkSays(PHRASES.boot');
  assert.ok(voom > 0 && rows > voom, 'voom starts before the systems load');
  assert.ok(orb > 0 && say > orb, 'phrase after the orb is drawn');
  assert.match(bootFn, /kirk\(\)\?\.online\) kirkSays\(PHRASES\.boot, run\)/);
});

test('shutdown order: falling voom and phrase first, then the console powers down', () => {
  const voom = shutdownFn.indexOf('sfx.shutdown()'), say = shutdownFn.indexOf('kirkSays(PHRASES.shutdown'), undraw = shutdownFn.indexOf('animateOrbDraw(0, T.shutdown.orbUndraw)'), dark = shutdownFn.lastIndexOf('goDark();');
  assert.ok(voom > 0 && say > voom && undraw > say && dark > undraw);
});

// ---- sound ----
test('the only sounds are a rising and a falling voom', () => {
  const up = P.voomPlan('up'), down = P.voomPlan('down');
  assert.ok(up.f1 > up.f0 && up.cutoff1 > up.cutoff0, 'up rises');
  assert.ok(down.f1 < down.f0 && down.cutoff1 < down.cutoff0, 'down falls');
  for (const v of [up, down]) { assert.deepEqual([...v.waves].sort(), ['sine', 'triangle']); assert.ok(v.release >= 0.5, 'long, smooth tail'); }
  assert.throws(() => P.voomPlan('sideways'));
  assert.match(sfxEngine, /boot: \(\) => voom\('up'\)/);
  assert.match(sfxEngine, /shutdown: \(\) => voom\('down'\)/);
});

test('no beeps, blips, chimes, ticks or game-like effects remain', () => {
  assert.doesNotMatch(sfxEngine, /'square'|'sawtooth'|createBuffer|PENT\b/);
  assert.doesNotMatch(flow, /sfx\.(blip|tick|complete|lockOn|crtOff|drain|powerOn|powerDown|startHum|stopHum)\b/);
  assert.equal((flow.match(/sfx\.boot\(\)/g) || []).length, 1);
  assert.equal((flow.match(/sfx\.shutdown\(\)/g) || []).length, 1);
});

test('sound is never forced: the setting and silent mode both suppress it', () => {
  assert.equal(P.soundAllowed({ sfxOn: true, silent: false }), true);
  assert.equal(P.soundAllowed({ sfxOn: false, silent: false }), false);
  assert.equal(P.soundAllowed({ sfxOn: true, silent: true }), false);
  assert.equal(P.soundAllowed({ sfxOn: false, silent: true }), false);
  assert.match(sfxEngine, /const soundAllowed = \(\) => KIBIPower\.soundAllowed\(\{ sfxOn, silent: voiceSilenced\(\) \}\)/);
  assert.match(sfxEngine, /const c = ctx\(\); if \(!c \|\| !soundAllowed\(\)\) return false;/);
  assert.match(sfxEngine, /addEventListener\('kibi-voice', e => \{ if \(e\.detail\?\.silent\) sfx\.stop\(\); \}\)/);
  assert.match(sfxEngine, /if \(!sfxOn\) sfx\.stop\(\)/);
  // with sound off there is no "tap to power up" prompt to unlock audio
  assert.match(bootFn, /if \(soundAllowed\(\) && !sfx\.running\(\)\) \{ if \(!\(await waitForPowerTap/);
  // the phrases go through speak(), which returns early in silent mode
  assert.match(page, /function speak\(text, who = agent\) \{\n    if \(voiceSilenced\(\)\) return;/);
});

// ---- the spoken lines ----
test('the approved phrases are exact', () => {
  assert.equal(P.PHRASES.boot, 'Startup Complete. All Systems on-Line.');
  assert.equal(P.PHRASES.shutdown, 'Shutting down All Systems');
  assert.ok(Object.isFrozen(P.PHRASES));
});

test('each phrase is spoken once, by K.I.R.K., at its lifecycle event', () => {
  assert.equal((flow.match(/kirkSays\(PHRASES\.boot, run\)/g) || []).length, 1);
  assert.equal((flow.match(/kirkSays\(PHRASES\.shutdown, run\)/g) || []).length, 1);
  assert.equal((bootFn.match(/kirkSays\(/g) || []).length, 1);
  assert.equal((shutdownFn.match(/kirkSays\(/g) || []).length, 1);
  assert.match(flow, /const kirk = \(\) => agents\.find\(a => a\.id === homeAgent\(\)\)/);
  assert.match(flow, /if \(run !== bootRun\) return false;\n    speak\(text, k\.id\)/);
  assert.doesNotMatch(page, /Startup sequence complete\.|speak\('Shutting down all systems\.'/);
  // boot speaks only from finish(), which its own guard runs once per boot
  assert.match(bootFn, /if \(run !== bootRun \|\| finishing\) return;\n      finishing = true;/);
});

// ---- accessibility ----
test('reduced motion and silent mode behaviour is preserved', () => {
  assert.match(page, /const reduceMotion = matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(page, /\.boot, \.boot \*, \.pwr-on, \.pwr-down \{ animation-duration: \.01s !important/);
  assert.match(flow, /await wait\(reduceMotion \? 20 : T\.boot\.panel\)/);
  assert.match(flow, /await wait\(reduceMotion \? 20 : T\.shutdown\.panel\)/);
  assert.match(bootFn, /await wait\(reduceMotion \? 50 : T\.boot\.handoff\)/);
  assert.match(bootFn, /const fast = reduceMotion \? 0\.4 : 1;/);
  assert.match(shutdownFn, /const fast = reduceMotion \? 0\.4 : 1;/);
});
