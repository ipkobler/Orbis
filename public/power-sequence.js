// K.O.R.A. startup and shutdown: the shared rules for both sequences.
// The page loads this as a plain script (window.KORAPower); the tests import it in Node (globalThis.KORAPower).
// Everything here is pure data or pure functions, so the timing, sound, wording and theme rules can be tested
// without a browser.
(function (root) {
  // What K.I.R.K. says. Exact approved wording: don't change the case or punctuation.
  const PHRASES = Object.freeze({
    boot: 'Startup Complete. All Systems on-Line.',
    shutdown: 'Shutting down All Systems',
  });

  // Milliseconds unless noted. Shutdown is deliberately quicker than boot at every stage.
  const TIMING = Object.freeze({
    boot: Object.freeze({
      voom: 2.4,              // seconds: the rising "voom"
      intro: 420,             // pause after "Boot sequence active"
      rowLoad: [150, 80],     // per system: base + random spread while it loads to 62 %
      rowFinish: [90, 70],    // per system: from 62 % to done
      step: 30,               // gap between systems
      settle: 750,            // "All systems nominal" hold before the hand-over
      handoff: 420,           // boot console fade → first panel
      panel: 210,             // each console panel powering on
      orbDraw: 2600,          // the orb drawing itself in
      speechDelay: 450,       // K.I.R.K. speaks after the orb is drawn
    }),
    shutdown: Object.freeze({
      voom: 1.4,              // seconds: the falling "voom"
      speechLead: 700,        // the phrase starts, the console begins powering down under it
      orbUndraw: 900,
      panel: 70,
      handoff: 120,
      hudIn: 200,
      rowDrain: [70, 40],
      step: 15,
      hold: 350,              // "All systems offline" hold
      fade: 350,
      dark: 500,              // console fades to the standby screen
    }),
  });

  const avg = ([base, spread]) => base + spread / 2;
  // the nominal running time of a sequence, without the typed headings (same text in both) and with no skipping
  function nominalDuration(mode, { systems = 10, panels = 12 } = {}) {
    const t = TIMING[mode];
    if (mode === 'boot') return t.intro + systems * (avg(t.rowLoad) + avg(t.rowFinish) + t.step) + t.settle + t.handoff + panels * t.panel + t.orbDraw;
    if (mode === 'shutdown') return t.speechLead + t.orbUndraw + panels * t.panel + t.handoff + t.hudIn + systems * (avg(t.rowDrain) + t.step) + t.hold + t.fade + t.dark;
    throw new Error('unknown sequence: ' + mode);
  }

  // The only sounds in either sequence: one smooth swept tone. Sine and triangle partials through a gently
  // opening (or closing) low-pass filter, soft attack and long release. No beeps, chimes, clicks or blips.
  function voomPlan(direction) {
    if (direction === 'up') return Object.freeze({ direction, dur: TIMING.boot.voom, f0: 55, f1: 220, cutoff0: 180, cutoff1: 1800, attack: 0.6, release: 0.9, gain: 0.22, waves: ['sine', 'triangle'], detune: 7 });
    if (direction === 'down') return Object.freeze({ direction, dur: TIMING.shutdown.voom, f0: 220, f1: 50, cutoff0: 1800, cutoff1: 160, attack: 0.08, release: 0.7, gain: 0.2, waves: ['sine', 'triangle'], detune: -7 });
    throw new Error('voom direction must be up or down');
  }

  // Sound plays only when the "Startup & shutdown sounds" setting is on and the console isn't in silent mode.
  const soundAllowed = ({ sfxOn, silent }) => !!sfxOn && !silent;

  // Light, Dark or System → the theme actually shown
  function resolveTheme(mode, prefersLight) {
    const chosen = ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
    return chosen === 'system' ? (prefersLight ? 'light' : 'dark') : chosen;
  }

  // Canvas colours for the boot console, matching the CSS tokens of each theme. RGB triples.
  const PALETTES = Object.freeze({
    dark: Object.freeze({ accent: [255, 77, 94], accent2: [255, 154, 77], accent3: [255, 199, 90], ok: [62, 224, 143], ice: [127, 212, 255], line: [90, 168, 255], ink: [226, 236, 244], dim: [142, 163, 198], globeFrom: [170, 215, 255], globeTo: [255, 105, 80], glow: 1 }),
    light: Object.freeze({ accent: [198, 47, 62], accent2: [180, 86, 28], accent3: [138, 97, 0], ok: [21, 122, 71], ice: [42, 106, 163], line: [61, 104, 150], ink: [16, 35, 61], dim: [71, 98, 127], globeFrom: [42, 106, 163], globeTo: [198, 47, 62], glow: 0 }),
  });
  const palette = theme => PALETTES[theme === 'light' ? 'light' : 'dark'];

  root.KORAPower = Object.freeze({ PHRASES, TIMING, nominalDuration, voomPlan, soundAllowed, resolveTheme, palette });
})(typeof window !== 'undefined' ? window : globalThis);
