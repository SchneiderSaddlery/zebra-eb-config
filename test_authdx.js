/* Tests for the TECH-6551 auth diagnostics block.
 *
 * The failure that matters is not "wrong number in a fragment" -- it is this
 * block throwing on a login page and stopping 34 scanners from working. So the
 * hostile cases (no localStorage, no history, fetch that rejects, XHR that
 * throws) are the ones worth most here.
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

function makeEnv(opts = {}) {
  const loc = {
    hostname: opts.host ?? 'login.fulfil.io',
    pathname: opts.pathname ?? '/u/login',
    search: opts.search ?? '',
    hash: '',
  };
  const replaced = [];
  const win = {
    location: loc,
    history: opts.noHistory ? {} : {
      replaceState: (a, b, url) => { replaced.push(url); loc.hash = url.includes('#') ? '#' + url.split('#')[1] : ''; },
    },
    localStorage: makeStore(opts.brokenStorage),
    fetch: opts.fetch,
    XMLHttpRequest: opts.XHR,
  };
  win.top = opts.inIframe ? {} : win;
  win.self = win;
  const ctx = { window: win, location: loc, history: win.history,
                localStorage: win.localStorage, XMLHttpRequest: opts.XHR,
                Promise, JSON, RegExp, Error, console };
  ctx.globalThis = ctx;
  return { ctx, win, loc, replaced };
}

function run(env) {
  vm.createContext(env.ctx);
  vm.runInContext(SRC, env.ctx);
}

function stored(env) {
  try { return JSON.parse(env.win.localStorage._map.get('ssAuthDx') || '{}'); }
  catch (e) { return {}; }
}

// --- 1. does nothing off an auth host -------------------------------------
let env = makeEnv({ host: 'sstack.fulfil.io', pathname: '/wms/' });
run(env);
check('inert on the WMS host', env.win.localStorage._map.size === 0 && env.replaced.length === 0);

env = makeEnv({ host: 'schneidersaddlery.github.io', pathname: '/zebra-eb-config/' });
run(env);
check('inert on the kiosk launcher', env.win.localStorage._map.size === 0);

// --- 2. runs on each auth host --------------------------------------------
for (const host of ['login.fulfil.io', 'canary.auth.fulfil.io', 'auth.fulfil.io']) {
  env = makeEnv({ host, pathname: '/login' });
  run(env);
  check(`active on ${host}`, stored(env).n === 1, JSON.stringify(stored(env)));
}

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

// --- 4. attempts accumulate across reloads (same storage) ------------------
env = makeEnv();
run(env);
run(env);
run(env);
check('page loads accumulate', stored(env).n === 3, JSON.stringify(stored(env)));

// --- 5. failing statuses are captured, successes ignored -------------------
let noted = null;
env = makeEnv({
  fetch: function () { return Promise.resolve({ status: 400 }); },
});
run(env);
env.ctx.window.fetch('https://canary.auth.fulfil.io/authorize');
setTimeout(() => {
  check('a 400 from fetch is recorded', (stored(env).s || []).includes(400),
        JSON.stringify(stored(env)));

  // --- 6. a 200 must NOT be recorded --------------------------------------
  const env2 = makeEnv({ fetch: function () { return Promise.resolve({ status: 200 }); } });
  run(env2);
  env2.ctx.window.fetch('https://x');
  setTimeout(() => {
    check('a 200 is ignored', (stored(env2).s || []).length === 0,
          JSON.stringify(stored(env2)));

    // --- 7. a REJECTING fetch must not break the caller -------------------
    const env3 = makeEnv({ fetch: function () { return Promise.reject(new Error('offline')); } });
    run(env3);
    let callerSaw = null;
    env3.ctx.window.fetch('https://x').catch((e) => { callerSaw = e.message; });
    setTimeout(() => {
      check('caller still receives a rejection', callerSaw === 'offline', String(callerSaw));

      // --- 8. hostile environments must not throw -------------------------
      const hostile = [
        ['no localStorage at all', { brokenStorage: true }],
        ['no history.replaceState', { noHistory: true }],
        ['inside an iframe', { inIframe: true }],
        ['fetch throws synchronously', { fetch: function () { throw new Error('boom'); } }],
        ['XHR prototype missing send', { XHR: function () {} }],
      ];
      for (const [name, opts] of hostile) {
        let threw = null;
        try { run(makeEnv(opts)); } catch (e) { threw = e.message; }
        check(`survives: ${name}`, threw === null, threw || '');
      }

      // --- 9. never rewrites the URL mid-transaction ----------------------
      const envA = makeEnv({ host: 'canary.auth.fulfil.io', pathname: '/authorize',
                             search: '?code=X&state=Y' });
      run(envA);
      check('no URL rewrite on /authorize', envA.replaced.length === 0,
            envA.replaced.join(','));

      const envB = makeEnv({ host: 'canary.auth.fulfil.io', pathname: '/login' });
      run(envB);
      check('URL rewritten on the login form', envB.replaced.length === 1,
            envB.replaced.join(','));
      check('fragment shape is ssdx=v.n.code.statuses',
            /#ssdx=1\.1\.0\.0$/.test(envB.replaced[0] || ''), envB.replaced[0]);

      console.log('');
      console.log(fails ? `${fails} FAILED` : 'all passed');
      process.exit(fails ? 1 : 0);
    }, 10);
  }, 10);
}, 10);
