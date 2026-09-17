// Tests for the TECH-6551 icon-swap block. Run: node test_iconswap.js
//
// The block is EXTRACTED from focus.js rather than copied here: a second copy is the drift this
// repo's rules forbid. It is run against stub location/document/window objects, so no browser.
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/focus.js', 'utf8');
const start = src.indexOf('/* TECH-6551:');
const endMark = '\n  })();';
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.error('FAIL: could not find the TECH-6551 icon-swap block in focus.js');
  process.exit(1);
}
const block = src.slice(start, end + endMark.length);
const run = new Function('location', 'document', 'window', '"use strict";\n' + block);

const BLANK = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22/%3E';

function link(rel, href) {
  return {
    rel: rel,
    href: href,
    getAttribute: function (n) { return n === 'href' ? this.href : this[n]; },
    setAttribute: function (n, v) { if (n === 'href') this.href = v; }
  };
}

function fakeDoc(links, opts) {
  opts = opts || {};
  return {
    readyState: opts.readyState || 'complete',
    querySelectorAll: function (sel) {
      if (opts.throwOnQuery) throw new Error('boom');
      // the block asks for icon links only; mimic that filter
      return links.filter(function (l) {
        return /(^|\s)icon(\s|$)/.test(l.rel) || l.rel === 'apple-touch-icon';
      });
    }
  };
}

let failed = 0;
function check(name, cond) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
  if (!cond) failed++;
}

// 1. Fulfil's sign-in host: icon and apple-touch-icon are swapped, other links untouched
{
  const icon = link('icon', '/static/images/favicon.svg');
  const touch = link('apple-touch-icon', '/static/images/favicon.svg');
  const css = link('stylesheet', '/static/css/style.css');
  run({ hostname: 'canary.auth.fulfil.io' }, fakeDoc([icon, touch, css]), { addEventListener: function () {} });
  check('canary.auth.fulfil.io: icon swapped', icon.href === BLANK);
  check('canary.auth.fulfil.io: apple-touch-icon swapped', touch.href === BLANK);
  check('canary.auth.fulfil.io: stylesheet untouched', css.href === '/static/css/style.css');
}

// 2. The bare auth host is covered too (it has been seen in the fleet)
{
  const icon = link('icon', '/static/images/favicon.svg');
  run({ hostname: 'auth.fulfil.io' }, fakeDoc([icon]), { addEventListener: function () {} });
  check('auth.fulfil.io: icon swapped', icon.href === BLANK);
}

// 3. Hosts that are not the sign-in host are left alone (the race is on the auth session cookie)
{
  for (const host of ['sstack.fulfil.io', 'login.fulfil.io', 'fulfillment.aws-prod.sstack.com', 'evilauth.fulfil.io.example.com']) {
    const icon = link('icon', '/favicon.ico');
    run({ hostname: host }, fakeDoc([icon]), { addEventListener: function () {} });
    check(host + ': icon left alone', icon.href === '/favicon.ico');
  }
}

// 4. Hostile conditions must never throw: the whole point is that a scanner still signs in
{
  let threw = null;
  try {
    run({ hostname: 'canary.auth.fulfil.io' }, fakeDoc([], { throwOnQuery: true }), { addEventListener: function () {} });
  } catch (e) { threw = e; }
  check('querySelectorAll throwing does not escape the block', threw === null);

  threw = null;
  try { run({}, fakeDoc([]), {}); } catch (e) { threw = e; }
  check('missing hostname does not throw', threw === null);

  threw = null;
  try { run({ hostname: 'canary.auth.fulfil.io' }, fakeDoc([]), {}); } catch (e) { threw = e; }
  check('no icon links, no window.addEventListener: no throw', threw === null);
}

// 5. If the page has not finished loading, the block also waits for load (CDP-style injection)
{
  const icon = link('icon', '/static/images/favicon.svg');
  let listener = null;
  run({ hostname: 'canary.auth.fulfil.io' }, fakeDoc([icon], { readyState: 'loading' }),
      { addEventListener: function (ev, fn) { if (ev === 'load') listener = fn; } });
  check('load listener registered while still loading', typeof listener === 'function');
}

// 6. Idempotent: running twice leaves one swapped value, no growth
{
  const icon = link('icon', '/static/images/favicon.svg');
  const doc = fakeDoc([icon]);
  run({ hostname: 'canary.auth.fulfil.io' }, doc, { addEventListener: function () {} });
  run({ hostname: 'canary.auth.fulfil.io' }, doc, { addEventListener: function () {} });
  check('second run is a no-op', icon.href === BLANK);
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
