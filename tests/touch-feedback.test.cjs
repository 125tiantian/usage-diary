// Run with: node --test tests/touch-feedback.test.cjs
// Deterministic event/clock harness; does not claim real-device Safari or haptic QA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../assets/app.js'), 'utf8');

function setup({ reduced = false, vibration = false } = {}) {
  let clock = 0, nextTimer = 0;
  const timers = new Map(), nodes = new Map(), buzzes = [];
  class Target {
    constructor(button = false) {
      this.button = button;
      this.listeners = new Map(); this.dataset = {}; this.style = {};
      this.classes = new Set(); this.attributes = {}; this.animations = [];
      this.classList = {
        add: (...names) => names.forEach(n => this.classes.add(n)),
        remove: (...names) => names.forEach(n => this.classes.delete(n)),
        contains: n => this.classes.has(n),
        toggle: (n, on) => on ? this.classes.add(n) : this.classes.delete(n),
      };
    }
    addEventListener(name, fn, options) {
      const list = this.listeners.get(name) || [];
      list.push({ fn, capture: options === true }); this.listeners.set(name, list);
    }
    emit(name, props = {}) {
      const e = { type: name, target: this, isPrimary: true, isTrusted: true, button: 0,
        pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20, detail: 1,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
      for (const { fn } of [...(this.listeners.get(name) || [])].sort((a, b) => b.capture - a.capture)) {
        fn(e); if (e.stopped) break;
      }
      return e;
    }
    closest(selector) { return selector === 'button' && this.button ? this : null; }
    contains(el) { return el === this; }
    matches(selector) { return selector.split(',').some(s => this.classes.has(s.trim().slice(1))); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 80, bottom: 44 }; }
    animate(frames, options) {
      const a = { frames, options, cancel() { this.cancelled = true; this.oncancel?.(); } };
      this.animations.push(a); return a;
    }
  }
  const document = new Target(), window = new Target(), motion = new Target();
  const buttons = ['5h', 'weekly'].flatMap(target => [-10, -5, -1, 1, 5, 10].map(step => {
    const b = new Target(true); b.dataset = { target, step: String(step) }; b.classes.add('step-btn'); return b;
  }));
  document.readyState = 'loading'; document.documentElement = new Target();
  document.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Target());
    return nodes.get(selector);
  };
  document.querySelectorAll = selector => selector === '.step-btn' ? buttons : [];
  motion.matches = reduced; window.matchMedia = () => motion;
  const context = vm.createContext({ document, window, console, performance: { now: () => clock },
    navigator: vibration ? { vibrate: n => buzzes.push(n) } : {},
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, at: clock + ms }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source + '\nglobalThis.api = { state, handleStep, bindPressFeedback, fireAnim, feedbackAnimations, stepHaptic };', context);
  const tick = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  };
  return { ...context.api, context, document, window, motion, buttons, nodes, buzzes, tick };
}

test('rapid stepping is exact, clamped, and renders real boundary states', () => {
  const h = setup(); h.state.draft5h = 0; h.state.draftWeekly = 20;
  for (let i = 0; i < 31; i++) h.handleStep('5h', 5);
  assert.equal(h.state.draft5h, 100); assert.equal(h.state.draftWeekly, 20);
  assert.equal(h.buttons.find(b => b.dataset.step === '1').attributes['aria-disabled'], 'true');
  assert.equal(h.handleStep('5h', 10), false);
  h.handleStep('5h', -1);
  assert.equal(h.state.draft5h, 99);
  assert.equal(h.buttons.find(b => b.dataset.step === '1').attributes['aria-disabled'], 'false');
  const animations = h.nodes.get('#input-5h-num').animations;
  assert.ok(animations.slice(0, -1).every(a => a.cancelled));
  assert.equal(h.feedbackAnimations.size, 1);
  h.tick(250); assert.equal(h.nodes.get('#step-status').textContent, '5 小时 99%');
});

test('pointer press releases on tap, drag, cancellation, blur, and page hide', () => {
  const h = setup(); h.bindPressFeedback(); const button = h.buttons[3];
  const emit = (name, props) => h.document.emit(name, { target: button, ...props });
  emit('pointerdown'); assert.ok(button.classes.has('is-pressed'));
  assert.equal(h.state.draft5h, 0); // down alone must never change data
  emit('pointerup'); assert.ok(!button.classes.has('is-pressed'));
  assert.ok(!emit('click').prevented);
  emit('pointerdown'); emit('pointermove', { clientY: 35 });
  assert.ok(!button.classes.has('is-pressed'));
  assert.ok(emit('click').prevented); // WebKit compatibility click after drag
  emit('pointerdown'); emit('pointercancel'); assert.ok(!button.classes.has('is-pressed'));
  emit('pointerdown'); h.window.emit('blur'); assert.ok(!button.classes.has('is-pressed'));
  emit('pointerdown'); h.window.emit('pagehide'); assert.ok(!button.classes.has('is-pressed'));
  emit('pointerdown'); emit('pointerup'); assert.ok(!emit('click').prevented);
});

test('focus transfer does not prematurely release a new button; keyboard stays usable', () => {
  const h = setup(); h.bindPressFeedback(); const [previous, next] = h.buttons;
  h.document.emit('pointerdown', { target: next });
  h.document.emit('focusout', { target: previous }); assert.ok(next.classes.has('is-pressed'));
  h.document.emit('pointercancel', { target: next });
  h.document.emit('keydown', { target: next, key: ' ' }); assert.ok(next.classes.has('is-pressed'));
  assert.equal(h.document.documentElement.dataset.input, 'keyboard');
  h.document.emit('keyup', { target: next }); assert.ok(!next.classes.has('is-pressed'));
  assert.ok(!h.document.emit('click', { target: next, detail: 0 }).prevented);
});

test('release outside and multi-touch cancel without blocking the next deliberate tap', () => {
  const h = setup(); h.bindPressFeedback(); const button = h.buttons[3];
  h.document.emit('pointerdown', { target: button });
  h.document.emit('pointerup', { target: button, clientX: 120 });
  assert.ok(h.document.emit('click', { target: button }).prevented);
  h.document.emit('pointerdown', { target: button });
  h.document.emit('pointerdown', { target: button, pointerId: 2, isPrimary: false });
  assert.ok(!button.classes.has('is-pressed'));
  assert.ok(h.document.emit('click', { target: button }).prevented);
});

test('reduced motion cancels active effects while values and announcements still update', () => {
  const h = setup(); h.handleStep('weekly', 5); const a = h.nodes.get('#input-weekly-num').animations[0];
  h.motion.matches = true; h.motion.emit('change'); assert.ok(a.cancelled);
  h.handleStep('weekly', 5); assert.equal(h.state.draftWeekly, 10);
  assert.equal(h.feedbackAnimations.size, 0);
  h.tick(250); assert.equal(h.nodes.get('#step-status').textContent, 'Weekly 10%');
});

test('vibration is capability-gated, throttled, optional, and never fires at bounds', () => {
  const h = setup({ vibration: true }); h.bindPressFeedback();
  h.document.documentElement.dataset.input = 'touch'; const event = { type: 'click', isTrusted: true };
  h.handleStep('5h', 5, event); h.handleStep('5h', 5, event); assert.equal(h.buzzes.length, 1);
  h.tick(60); h.state.draft5h = 100; h.handleStep('5h', 5, event); assert.equal(h.buzzes.length, 1);
  h.nodes.get('#haptic-toggle').checked = false; h.nodes.get('#haptic-toggle').emit('change');
  h.handleStep('5h', -5, event); assert.equal(h.buzzes.length, 1);
  const safari = setup(); safari.document.documentElement.dataset.input = 'touch';
  assert.doesNotThrow(() => safari.handleStep('5h', 5, event));
});

test('replaying legacy save effects cannot be cleared by an earlier timer', () => {
  const h = setup(); const el = h.document.querySelector('#test-animation');
  h.fireAnim(el, 'active', 700); h.tick(500); h.fireAnim(el, 'active', 700);
  h.tick(200); assert.ok(el.classes.has('active'));
  h.tick(500); assert.ok(!el.classes.has('active'));
});
