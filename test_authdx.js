/* Tests for the TECH-6551 auth diagnostics block (v2).
 *
 * The failure that matters is not "wrong number in a fragment" -- it is this
 * block throwing on a login page and stopping 34 scanners from working. So the
 * hostile cases (no localStorage, no history, fetch that rejects, XHR that
 * throws, no performance API) are the ones worth most here.
 *
 * The second failure that matters is a marker the monitor silently DISCARDS.
 * poll.py whitelists ^ssdx=[0-9.-]{1,64}$ and drops anything else without a
 * trace, so every marker this block can emit is asserted numeric and in-cap.
 *
 * Run: node test_authdx.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Extract the block FROM focus.js. There must be exactly one copy of this code
// in the repo -- a separate test fixture would drift, which is the failure the
// scanner-repo rule exists to prevent.
const FOCUS = fs.readFileSync(path.join(__dirname, 'focus.js'), 'utf8');
const START = FOCUS.indexOf('/* ---');
const END = FOCUS.indexOf('var CONFIG');
if (START === -1 || END === -1 || START > END) {
  console.error('FAIL  cannot locate the diagnostics block in focus.js');
  process.exit(1);
}
const SRC = FOCUS.slice(START, END);
if (!SRC.includes('ssAuthDx')) {
  console.error('FAIL  extracted slice is not the diagnostics block');
  process.exit(1);
}

let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

function makeStore(broken) {
  const m = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error('storage disabled'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('storage disabled'); m.set(k, String(v)); },
    _map: m,
  };
}

// A navigation timing entry, or the absence of one. `nav: null` models a
// browser with no Navigation Timing L2 -- the block must degrade to zeros
// rather than throw.
function makePerf(opts) {
  if (opts.noPerf) return undefined;
  if (opts.perfThrows) {
    return { getEntriesByType: () => { throw new Error('perf blew up'); } };
  }
  const entry = {};
  if (opts.status !== undefined) entry.responseStatus = opts.status;
  if (opts.redirects !== undefined) entry.redirectCount = opts.redirects;
  return { getEntriesByType: (t) => (t === 'navigation' && !opts.noEntry ? [entry] : []) };
}

function makeEnv(opts = {}) {
  const loc = {
    hostname: opts.host ?? 'login.fulfil.io',
    pathname: opts.pathname ?? '/u/login',
    search: opts.search ?? '',
    hash: '',
  };
  const replaced = [];
  const clock = { t: opts.now ?? 1_000_000 };
  const timers = [];
  const win = {
    location: loc,
    history: opts.noHistory ? {} : {
      replaceState: (a, b, url) => { replaced.push(url); loc.hash = url.includes('#') ? '#' + url.split('#')[1] : ''; },
    },
    localStorage: opts.store ?? makeStore(opts.brokenStorage),
    fetch: opts.fetch,
    XMLHttpRequest: opts.XHR,
    performance: makePerf(opts),
  };
  win.top = opts.inIframe ? {} : win;
  win.self = win;
  const ctx = { window: win, location: loc, history: win.history,
                localStorage: win.localStorage, XMLHttpRequest: opts.XHR,
                Promise, JSON, RegExp, Error, console,
                Date: { now: () => clock.t },
                setTimeout: (fn, ms) => { timers.push(fn); return timers.length; } };
  ctx.globalThis = ctx;
  return { ctx, win, loc, replaced, clock, timers };
}

function run(env) {
  vm.createContext(env.ctx);
  vm.runInContext(SRC, env.ctx);
}

function stored(env) {
  try { return JSON.parse(env.win.localStorage._map.get('ssAuthDx') || '{}'); }
  catch (e) { return {}; }
}

function lastTag(env) {
  const url = env.replaced[env.replaced.length - 1] || '';
  return url.includes('#') ? url.split('#')[1] : '';
}

// --- 1. does nothing off an auth host -------------------------------------
let env = makeEnv({ host: 'sstack.fulfil.io', pathname: '/wms/' });
run(env);
check('inert on the WMS host', env.win.localStorage._map.size === 0 && env.replaced.length === 0);

env = makeEnv({ host: 'schneidersaddlery.github.io', pathname: '/zebra-eb-config/' });
run(env);
check('inert on the kiosk launcher', env.win.localStorage._map.size === 0);

// --- 2. runs on each auth host, and stamps WHICH one ----------------------
// v1 could not do this. Fragments leak across origins through redirect chains,
// so the host FK reports a marker on is not the origin that wrote it.
for (const [host, code] of [['login.fulfil.io', 1], ['canary.auth.fulfil.io', 2],
                            ['auth.fulfil.io', 3]]) {
  env = makeEnv({ host, pathname: '/login' });
  run(env);
  check(`active on ${host}`, stored(env).n === 1, JSON.stringify(stored(env)));
  check(`origin stamped as ${code} for ${host}`, stored(env).o === code, lastTag(env));
}
env = makeEnv({ host: 'newauth.fulfil.io', pathname: '/login' });
run(env);
check('an unknown auth host stamps origin 9', stored(env).o === 9, lastTag(env));

// --- 3. code presence is a BOOLEAN, the value never stored -----------------
env = makeEnv({ search: '?code=SUPERSECRET123&state=abcdef' });
run(env);
const raw = env.win.localStorage._map.get('ssAuthDx') || '';
check('code recorded as a flag', stored(env).code === 1);
check('the code VALUE never reaches storage', !raw.includes('SUPERSECRET123'), raw);
check('the state VALUE never reaches storage', !raw.includes('abcdef'), raw);
// The credential lives in the QUERY, which was already in the URL and which FK
// already reports with or without this block. We must NOT strip it -- Auth0
// needs `state` to complete the login -- so the real requirements are: the
// query survives byte-for-byte, and OUR fragment adds nothing sensitive.
{
  const url = env.replaced.join('');
  const frag = url.includes('#') ? url.split('#')[1] : '';
  check('our fragment carries no credential',
        !frag.includes('SUPERSECRET123') && !frag.includes('abcdef'), frag);
  check('the query is preserved byte-for-byte (Auth0 needs `state`)',
        url.startsWith('/u/login?code=SUPERSECRET123&state=abcdef#'), url);
}

// --- 4. the DOCUMENT's own HTTP status. This is the whole point of v2. -----
// v1 hooked fetch/XHR only and came back EMPTY on a confirmed live bounce,
// because the failing callback is a top-level document navigation that those
// hooks are structurally blind to.
env = makeEnv({ pathname: '/login', status: 403, redirects: 0 });
run(env);
check('document responseStatus is captured', stored(env).ds === 403, lastTag(env));
check('a 4xx document status reaches the marker', /^ssdx=2\.1\.1\.1\.0\.403\.0\.0$/.test(lastTag(env)),
      lastTag(env));

// A followed 302 shows as 200 with redirectCount >= 1, NOT as status 302.
// That combination on a login page is the proof the callback bounced.
env = makeEnv({ pathname: '/login', status: 200, redirects: 2 });
run(env);
check('redirectCount is captured', stored(env).rc === 2, lastTag(env));
check('a bounced callback reads 200 + redirects', /\.200\.2\.0$/.test(lastTag(env)), lastTag(env));

// --- 5. the status arrives late ------------------------------------------
// responseStatus is populated when response headers land. If it was not ready
// at injection, one late re-read recovers it -- losing this datum is the exact
// failure v2 exists to fix, so it must not depend on timing luck.
{
  const late = makeEnv({ pathname: '/login', status: 0, redirects: 0 });
  run(late);
  check('nothing to report yet', stored(late).ds === 0, lastTag(late));
  check('a late re-read was scheduled', late.timers.length === 1, String(late.timers.length));
  // headers have now landed
  late.win.performance = makePerf({ status: 502, redirects: 1 });
  late.timers[0]();
  check('the late status is picked up', stored(late).ds === 502, lastTag(late));
  check('the late status reaches the marker', /\.502\.1\.0$/.test(lastTag(late)), lastTag(late));
}
{
  const ready = makeEnv({ pathname: '/login', status: 200, redirects: 0 });
  run(ready);
  check('no re-read scheduled when the status is already known',
        ready.timers.length === 0, String(ready.timers.length));
}

// --- 6. per-attempt counter ----------------------------------------------
// v1's counter was cumulative and never reset: it read 513 and stayed 513
// across six samples while the device sat parked, so it could never answer
// "how many tries for THIS login" -- which is Ryan's entire complaint.
{
  const store = makeStore(false);
  const opts = { store, pathname: '/login', now: 1_000_000 };
  let e1 = makeEnv(opts); run(e1);
  let e2 = makeEnv({ ...opts, now: 1_010_000 }); run(e2);   // +10s
  let e3 = makeEnv({ ...opts, now: 1_020_000 }); run(e3);   // +10s
  check('page loads accumulate', stored(e3).n === 3, JSON.stringify(stored(e3)));
  check('attempts accumulate inside one login', stored(e3).a === 3, JSON.stringify(stored(e3)));

  // A fresh OAuth transaction resets the attempt count but not the total.
  const e4 = makeEnv({ ...opts, pathname: '/authorize', now: 1_030_000 }); run(e4);
  check('/authorize starts a new attempt', stored(e4).a === 1, JSON.stringify(stored(e4)));
  check('the cumulative count survives the reset', stored(e4).n === 4, JSON.stringify(stored(e4)));

  // So does a long quiet gap -- the device sat parked and somebody came back.
  const e5 = makeEnv({ ...opts, now: 1_030_000 + 6 * 60 * 1000 }); run(e5);
  check('a 6-minute gap starts a new attempt', stored(e5).a === 1, JSON.stringify(stored(e5)));
  const e6 = makeEnv({ ...opts, now: 1_030_000 + 6 * 60 * 1000 + 30_000 }); run(e6);
  check('a 30-second gap does NOT', stored(e6).a === 2, JSON.stringify(stored(e6)));
}

// --- 7. a v1 record upgrades without mixing semantics ---------------------
{
  const store = makeStore(false);
  store.setItem('ssAuthDx', JSON.stringify({ v: 1, n: 513, s: [400, 400], code: 1 }));
  const e = makeEnv({ store, pathname: '/login' });
  run(e);
  const s = stored(e);
  check('v1 cumulative count carries over', s.n === 514, JSON.stringify(s));
  check('v1 statuses are discarded, not mixed', (s.s || []).length === 0, JSON.stringify(s));
  check('the record is stamped v2', s.v === 2, JSON.stringify(s));
}

// --- 8. failing statuses are captured, successes ignored -------------------
let noted = null;
env = makeEnv({
  fetch: function () { return Promise.resolve({ status: 400 }); },
});
run(env);
env.ctx.window.fetch('https://canary.auth.fulfil.io/authorize');
setTimeout(() => {
  check('a 400 from fetch is recorded', (stored(env).s || []).includes(400),
        JSON.stringify(stored(env)));

  // --- 9. a 200 must NOT be recorded --------------------------------------
  const env2 = makeEnv({ fetch: function () { return Promise.resolve({ status: 200 }); } });
  run(env2);
  env2.ctx.window.fetch('https://x');
  setTimeout(() => {
    check('a 200 is ignored', (stored(env2).s || []).length === 0,
          JSON.stringify(stored(env2)));

    // --- 10. a REJECTING fetch must not break the caller ------------------
    const env3 = makeEnv({ fetch: function () { return Promise.reject(new Error('offline')); } });
    run(env3);
    let callerSaw = null;
    env3.ctx.window.fetch('https://x').catch((e) => { callerSaw = e.message; });
    setTimeout(() => {
      check('caller still receives a rejection', callerSaw === 'offline', String(callerSaw));

      // --- 11. hostile environments must not throw ------------------------
      const hostile = [
        ['no localStorage at all', { brokenStorage: true }],
        ['no history.replaceState', { noHistory: true }],
        ['inside an iframe', { inIframe: true }],
        ['fetch throws synchronously', { fetch: function () { throw new Error('boom'); } }],
        ['XHR prototype missing send', { XHR: function () {} }],
        ['no performance API', { noPerf: true }],
        ['performance.getEntriesByType throws', { perfThrows: true }],
        ['no navigation timing entry', { noEntry: true }],
      ];
      for (const [name, opts] of hostile) {
        let threw = null;
        try { run(makeEnv(opts)); } catch (e) { threw = e.message; }
        check(`survives: ${name}`, threw === null, threw || '');
      }
      // Degrading must still produce a usable marker, not a broken one.
      const degraded = makeEnv({ noPerf: true, pathname: '/login' });
      run(degraded);
      check('no performance API still yields zeros, not junk',
            /^ssdx=2\.1\.1\.1\.0\.0\.0\.0$/.test(lastTag(degraded)), lastTag(degraded));

      // --- 12. never rewrites the URL mid-transaction ---------------------
      const envA = makeEnv({ host: 'canary.auth.fulfil.io', pathname: '/authorize',
                             search: '?code=X&state=Y' });
      run(envA);
      check('no URL rewrite on /authorize', envA.replaced.length === 0,
            envA.replaced.join(','));

      const envB = makeEnv({ host: 'canary.auth.fulfil.io', pathname: '/login' });
      run(envB);
      check('URL rewritten on the login form', envB.replaced.length === 1,
            envB.replaced.join(','));
      check('fragment shape is ssdx=2.origin.attempt.loads.code.docStatus.redirects.statuses',
            /^ssdx=2\.2\.1\.1\.0\.0\.0\.0$/.test(lastTag(envB)), lastTag(envB));

      // --- 13. every marker survives the monitor's whitelist --------------
      // poll.py drops a non-matching fragment SILENTLY. A marker that is one
      // character too long, or carries one letter, is indistinguishable from
      // "the scanner never reached an auth page".
      const DX_RE = /^ssdx=[0-9.-]{1,64}$/;
      const worst = makeEnv({ host: 'canary.auth.fulfil.io', pathname: '/login',
                              status: 599, redirects: 99,
                              fetch: function () { return Promise.resolve({ status: 599 }); } });
      // drive the cumulative count and the status list to their caps
      worst.win.localStorage.setItem('ssAuthDx', JSON.stringify({
        v: 2, n: 999998, a: 9999, s: [599, 599, 599, 599, 599, 599], o: 2, t: 1,
      }));
      run(worst);
      for (let i = 0; i < 10; i++) worst.ctx.window.fetch('https://x');
      setTimeout(() => {
        const tags = worst.replaced.map((u) => (u.includes('#') ? u.split('#')[1] : ''));
        check('worst-case marker still matches the monitor whitelist',
              tags.length > 0 && tags.every((t) => DX_RE.test(t)),
              tags[tags.length - 1]);
        check('worst-case marker stays within the 64-char cap',
              tags.every((t) => t.replace('ssdx=', '').length <= 64),
              String(Math.max(...tags.map((t) => t.replace('ssdx=', '').length))));
        check('statuses are capped at 6',
              (stored(worst).s || []).length <= 6, JSON.stringify(stored(worst).s));

        console.log('');
        console.log(fails ? `${fails} FAILED` : 'all passed');
        process.exit(fails ? 1 : 0);
      }, 10);
    }, 10);
  }, 10);
}, 10);
