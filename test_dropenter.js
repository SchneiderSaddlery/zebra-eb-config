// Tests for the TECH-6927 drop/paste Enter block. Run: node test_dropenter.js
//
// The block is EXTRACTED from focus.js rather than copied here (same rule as test_iconswap.js).
// It runs against a stub document, scan field and timer, so no browser.
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/focus.js', 'utf8');
const start = src.indexOf('/* TECH-6927:');
const endMark = '\n  })();';
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.error('FAIL: could not find the TECH-6927 drop/paste Enter block in focus.js');
  process.exit(1);
}
const block = src.slice(start, end + endMark.length);
const run = new Function('document', 'findField', 'log', 'setTimeout', 'KeyboardEvent',
  '"use strict";\n' + block);

let failed = 0;
function check(name, cond) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
  if (!cond) failed++;
}

function FakeKeyboardEvent(type, init) {
  this.type = type;
  this.key = init.key;
  this.keyCode = init.keyCode;
  this.bubbles = init.bubbles;
}

function input(value) {
  return {
    value: value,
    isConnected: true,
    events: [],
    dispatchEvent: function (ev) { this.events.push(ev); return true; }
  };
}

// Load the block once per case; hand back the captured input listener and the pending timers.
function setup(scanField) {
  let listener = null, capture = null;
  const timers = [];
  run({ addEventListener: function (type, fn, useCapture) {
          if (type === 'input') { listener = fn; capture = useCapture; }
        } },
      function () { return scanField; },
      function () {},
      function (fn, ms) { timers.push({ fn: fn, ms: ms }); },
      FakeKeyboardEvent);
  return { listener: listener, capture: capture, flush: function () { timers.splice(0).forEach(function (t) { t.fn(); }); }, timers: timers };
}

function fire(env, target, inputType, isTrusted) {
  env.listener({ target: target, inputType: inputType, isTrusted: isTrusted !== false });
}

function isEnterTriplet(events) {
  return events.length === 3 &&
    events.map(function (e) { return e.type; }).join(',') === 'keydown,keypress,keyup' &&
    events.every(function (e) { return e.key === 'Enter' && e.keyCode === 13 && e.bubbles === true; });
}

// 1. The fix: a location dragged into the scan field gets Enter, after a short delay
{
  const scan = input('A-01-02');
  const env = setup(scan);
  check('input listener registered in capture phase', typeof env.listener === 'function' && env.capture === true);
  fire(env, scan, 'insertFromDrop');
  check('nothing dispatched before the timer runs', scan.events.length === 0);
  check('timer delay is short (50-300 ms)', env.timers.length === 1 && env.timers[0].ms >= 50 && env.timers[0].ms <= 300);
  env.flush();
  check('drop into scan field dispatches keydown/keypress/keyup Enter', isEnterTriplet(scan.events));
}

// 2. Paste into the scan field (keyboard clipboard, if a unit ever has the menu) behaves the same
{
  const scan = input('A-01-02');
  const env = setup(scan);
  fire(env, scan, 'insertFromPaste');
  env.flush();
  check('paste into scan field dispatches Enter', isEnterTriplet(scan.events));
}

// 3. Typing is left to the scan-burst detector and to the user
{
  const scan = input('A');
  const env = setup(scan);
  fire(env, scan, 'insertText');
  fire(env, scan, 'deleteContentBackward');
  env.flush();
  check('typed input dispatches nothing', scan.events.length === 0);
}

// 4. Our own synthetic events (or any script's) never trigger it
{
  const scan = input('A-01-02');
  const env = setup(scan);
  fire(env, scan, 'insertFromDrop', false);
  env.flush();
  check('untrusted drop dispatches nothing', scan.events.length === 0);
}

// 5. Only the current scan field: a drop into Reference, notes, etc. is left alone
{
  const scan = input('');
  const other = input('A-01-02');
  const env = setup(scan);
  fire(env, other, 'insertFromDrop');
  env.flush();
  check('drop into another field dispatches nothing', other.events.length === 0 && scan.events.length === 0);
}

// 6. No scan field on this page (list pages, label printing, store replenishment)
{
  const box = input('A-01-02');
  const env = setup(null);
  fire(env, box, 'insertFromDrop');
  env.flush();
  check('no scan field on page: nothing dispatched', box.events.length === 0);
}

// 7. Empty or whitespace-only result: nothing to submit
{
  const scan = input('   ');
  const env = setup(scan);
  fire(env, scan, 'insertFromDrop');
  env.flush();
  check('whitespace-only value dispatches nothing', scan.events.length === 0);
}

// 8. Field gone before the timer (Fulfil re-rendered or navigated): do not dispatch to a dead node
{
  const scan = input('A-01-02');
  const env = setup(scan);
  fire(env, scan, 'insertFromDrop');
  scan.isConnected = false;
  env.flush();
  check('detached field gets nothing', scan.events.length === 0);
}

// 9. Hostile events must never throw out of the listener
{
  const scan = input('A-01-02');
  const env = setup(scan);
  let threw = null;
  try { env.listener({ inputType: 'insertFromDrop', isTrusted: true }); env.flush(); } catch (e) { threw = e; }
  check('event with no target does not throw', threw === null);
  threw = null;
  const odd = { value: null, isConnected: true, dispatchEvent: function () { throw new Error('boom'); } };
  const env2 = setup(odd);
  try { fire(env2, odd, 'insertFromDrop'); env2.flush(); } catch (e) { threw = e; }
  check('null value does not throw', threw === null);
  threw = null;
  const bad = input('A-01-02');
  bad.dispatchEvent = function () { throw new Error('boom'); };
  const env3 = setup(bad);
  try { fire(env3, bad, 'insertFromDrop'); env3.flush(); } catch (e) { threw = e; }
  check('dispatchEvent throwing does not escape the timer', threw === null);
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
