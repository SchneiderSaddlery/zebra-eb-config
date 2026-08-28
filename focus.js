(function () {
  'use strict';
  /* -------------------------------------------------------------------------
   * TECH-6551 auth diagnostics. PILOT BLOCK -- v2.
   *
   * Why this exists: the scanner sometimes gets a valid OAuth code and still
   * lands back on a login page (SS27, 2026-08-20 10:01 -> bounced, 25 min).
   * Every screenshot of that state shows a CLEAN login page -- Fulfil renders
   * no error at all -- so the reason lives in the HTTP responses and nothing
   * outside the WebView can see it. This block watches those responses.
   *
   * How the data gets out, with no collector service: FK's heartbeat reports
   * 'currentPageUrl' INCLUDING the fragment (proven -- SS3 reports
   * 'sstack.fulfil.io/wms/#/customer/batch/790221'), and the auth monitor
   * already reads that field every 3 minutes. So we stamp a short fragment and
   * the existing poller picks it up.
   *
   * ---- WHAT CHANGED IN v2, AND WHY -----------------------------------------
   * v1 ran on SS23 for three days and its statuses field was EMPTY on a real,
   * confirmed bounce (ssdx=1.513.0.0). That is the finding, not a bug: the
   * fetch/XHR hooks are structurally blind to a top-level DOCUMENT navigation,
   * which is what the failing callback almost certainly is. v2 fixes three
   * things the live pilot exposed:
   *
   *   1. THE DOCUMENT'S OWN HTTP STATUS is now read, from
   *      performance.getEntriesByType('navigation')[0].responseStatus, plus
   *      .redirectCount. These TC21s run Chrome 150, far past the Chrome 109
   *      that shipped responseStatus.
   *      NOTE, and this matters when reading the data: the browser FOLLOWS a
   *      302 transparently, so a redirected callback shows up as
   *      responseStatus 200 with redirectCount >= 1 -- NOT as status 302. A
   *      login page arriving with redirectCount > 0 is therefore the proof
   *      that the callback bounced rather than errored, and a 4xx/5xx in that
   *      field is the error we have never once observed.
   *
   *   2. A PER-ATTEMPT COUNTER. v1's counter was cumulative and never reset --
   *      it read 513 and stayed 513 across six samples while the device sat
   *      parked, so it could never answer "how many tries for THIS login".
   *      'attempt' now resets when an OAuth transaction starts (/authorize) or
   *      after ATTEMPT_GAP_MS of quiet. The cumulative count is kept too.
   *
   *   3. THE ORIGIN IS STAMPED INTO THE MARKER. Fragments leak across origins
   *      through redirect chains -- v1 showed n=22 on canary.auth/authorize and
   *      n=513 on canary.auth/login three minutes later, because the 22 was
   *      almost certainly written on login.fulfil.io (separate origin, separate
   *      localStorage) and carried along the redirect. A marker's host is not
   *      trustworthy; the origin field is.
   *
   * Marker: ssdx=2.<origin>.<attempt>.<loads>.<code>.<docStatus>.<redirects>.<statuses>
   *   origin    1 login.fulfil.io  2 canary.auth.fulfil.io  3 auth.fulfil.io  9 other
   *   attempt   loads since this OAuth attempt began, on this origin
   *   loads     cumulative loads on this origin (v1's field, kept)
   *   code      1 if this load carried ?code=
   *   docStatus navigation responseStatus, 0 if unavailable
   *   redirects navigation redirectCount, 0 if unavailable
   *   statuses  dash-joined fetch/XHR statuses >= 400, or 0
   *
   * !! EVERY FIELD MUST BE NUMERIC. The monitor whitelists the marker with
   *    ^ssdx=[0-9.-]{1,64}$ and DISCARDS anything else, because a fragment is
   *    otherwise free-form app state and storing it wholesale would log
   *    customer data. A letter anywhere in here makes the marker invisible,
   *    silently. Keep this whole block ASCII too -- focus.js already carries
   *    one mojibake scar from a non-ASCII character making the FK round trip.
   *
   * Safety rules this block obeys, in order of importance:
   *   1. It NEVER throws. Everything is wrapped; any failure returns quietly.
   *      A bug here would stop 34 scanners logging in, which is far worse than
   *      no diagnostics.
   *   2. It NEVER records 'code' or 'state' VALUES -- only booleans and HTTP
   *      status numbers. Those query params are live credentials.
   *   3. It NEVER navigates, never reloads, never touches the DOM, and only
   *      rewrites the fragment once the OAuth transaction is already over
   *      (i.e. on a login FORM page, never on /authorize or a callback).
   *   4. It runs ONLY on Fulfil auth hosts and returns immediately elsewhere,
   *      before the main focus.js logic is reached.
   *
   * Kill switch: localStorage.ssAuthDxOff = '1' disables it on that device.
   * ---------------------------------------------------------------------- */
  (function () {
    'use strict';
    try {
      if (window.top !== window.self) return;        // never inside an iframe

      var h = (location.hostname || '').toLowerCase();
      if (h.indexOf('fulfil') === -1) return;
      if (h.indexOf('auth') === -1 && h.indexOf('login.') !== 0) return;

      try { if (localStorage.getItem('ssAuthDxOff') === '1') return; } catch (e) { return; }

      var KEY = 'ssAuthDx';
      var VER = 2;
      var MAX_STATUSES = 6;
      var MAX_TAG = 64;                              // the monitor's whitelist cap
      // Quiet gap after which the next load is a NEW login attempt rather than
      // another try at the current one. The monitor polls every 3 min, so this
      // has to be comfortably longer than a human's retry cadence.
      var ATTEMPT_GAP_MS = 5 * 60 * 1000;

      // Numeric because the marker must stay [0-9.-]. 9 = an auth host we have
      // not seen before, which is itself worth knowing.
      function originCode() {
        if (h === 'login.fulfil.io') return 1;
        if (h === 'canary.auth.fulfil.io') return 2;
        if (h === 'auth.fulfil.io') return 3;
        return 9;
      }

      function now() {
        try { return Date.now ? Date.now() : 0; } catch (e) { return 0; }
      }

      function load() {
        try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
        catch (e) { return {}; }
      }
      function save(o) {
        try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
      }

      function onAuthorize() {
        return (location.pathname || '').toLowerCase().indexOf('/authorize') !== -1;
      }

      // Only once the transaction is over. Rewriting the URL mid-flow could
      // disturb the very thing we are trying to observe.
      function onLoginForm() {
        var p = (location.pathname || '').toLowerCase();
        return p.indexOf('/login') !== -1 || p.indexOf('/signin') !== -1;
      }

      // The document's OWN response, which fetch/XHR hooks cannot see. This is
      // the whole reason v2 exists.
      function navTiming() {
        var out = { status: 0, redirects: 0 };
        try {
          var perf = window.performance;
          if (!perf || !perf.getEntriesByType) return out;
          var entries = perf.getEntriesByType('navigation');
          var n = entries && entries[0];
          if (!n) return out;
          if (typeof n.responseStatus === 'number') out.status = n.responseStatus;
          if (typeof n.redirectCount === 'number') out.redirects = n.redirectCount;
        } catch (e) {}
        return out;
      }

      function tagFor(o) {
        var s = (o.s || []).join('-') || '0';
        var head = VER + '.' + (o.o || 0) + '.' + (o.a || 0) + '.' + (o.n || 0) +
                   '.' + (o.code || 0) + '.' + (o.ds || 0) + '.' + (o.rc || 0);
        // A marker over the cap fails the monitor's whitelist and vanishes
        // without trace, so shed the least important field rather than lose
        // the whole reading.
        if ((head + '.' + s).length > MAX_TAG) s = '0';
        return 'ssdx=' + head + '.' + s;
      }

      function publish(o) {
        try {
          if (!onLoginForm()) return;
          if (!window.history || !history.replaceState) return;
          var tag = tagFor(o);
          if (location.hash === '#' + tag) return;
          history.replaceState(null, '',
                               location.pathname + (location.search || '') + '#' + tag);
        } catch (e) {}
      }

      // Only failures are interesting; a 200 stream would drown the signal.
      function note(status) {
        try {
          if (!status || status < 400) return;
          var o = load();
          o.v = VER;
          o.s = o.s || [];
          if (o.s.length < MAX_STATUSES) o.s.push(status);
          save(o);
          publish(o);
        } catch (e) {}
      }

      var st = load();
      var t = now();

      // A version bump invalidates the old counters rather than silently
      // mixing v1 and v2 semantics in one record. The cumulative count is the
      // one field whose meaning did not change, so it carries over.
      if (st.v !== VER) st = { n: st.n || 0 };

      var quiet = (st.t && t) ? (t - st.t) > ATTEMPT_GAP_MS : false;
      var fresh = onAuthorize() || !st.a || quiet;

      st.v = VER;
      st.o = originCode();
      st.t = t;
      st.n = (st.n || 0) + 1;                        // cumulative, this origin
      st.a = fresh ? 1 : (st.a || 0) + 1;            // loads in THIS attempt
      st.s = fresh ? [] : (st.s || []);
      // Presence only. The VALUES are short-lived credentials and never stored.
      st.code = /[?&]code=/.test(location.search || '') ? 1 : 0;

      var nav = navTiming();
      st.ds = nav.status;
      st.rc = nav.redirects;

      save(st);
      publish(st);

      // responseStatus is populated once response headers land. It normally
      // already is by the time injected script runs, but if it was not, one
      // late re-read is cheap and a missing status is exactly the datum we
      // cannot afford to lose. typeof guard: setTimeout may be absent.
      if (!st.ds && typeof setTimeout !== 'undefined') {
        setTimeout(function () {
          try {
            var later = navTiming();
            if (!later.status && !later.redirects) return;
            var o = load();
            o.ds = later.status;
            o.rc = later.redirects;
            save(o);
            publish(o);
          } catch (e) {}
        }, 1500);
      }

      if (window.fetch && !window.__ssDxFetch) {
        window.__ssDxFetch = true;
        var origFetch = window.fetch;
        window.fetch = function () {
          var p;
          try {
            p = origFetch.apply(this, arguments);
          } catch (e) {
            note(0);
            throw e;
          }
          try {
            // Observe a COPY of the chain. The caller still gets 'p' untouched,
            // so their error handling is unchanged and we add no unhandled
            // rejection (this branch handles both outcomes).
            p.then(function (r) { try { note(r && r.status); } catch (e) {} },
                   function () {});
          } catch (e) {}
          return p;
        };
      }

      if (window.XMLHttpRequest && XMLHttpRequest.prototype && !window.__ssDxXhr) {
        window.__ssDxXhr = true;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
          try {
            this.addEventListener('loadend', function () {
              try { note(this.status); } catch (e) {}
            });
          } catch (e) {}
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {
      /* Diagnostics must never be the reason a scanner cannot log in. */
    }
  })();

  var CONFIG = {
    allowedHosts: ['sstack.fulfil.io', 'fulfillment.aws-prod.sstack.com', 'fulfillment.aws-dev.sstack.com', 'sstack-sandbox.fulfil.app', 'store-replenishment.aws-prod.sstack.com'],
    debugMode: true,
    focusCheckInterval: 3000
  };

  function log(message, data) {
    if (!CONFIG.debugMode) return;
    var prefix = '[Zebra Scanner Focus]';
    if (data) { console.log(prefix, message, data); } else { console.log(prefix, message); }
  }

  if (!CONFIG.allowedHosts.includes(location.hostname)) {
    log('Not on allowed host:', location.hostname);
    return;
  }

  log('Script initialized on:', location.href);

  // Timeline CSS removed â€” replaced by custom Attach Photo button on all WMS pages

  // Scanner Enter key: detect rapid keystroke input (barcode scan) and dispatch Enter when it stops
  (function() {
    var scanBuffer = '';
    var scanTimeout = null;
    var SCAN_CHAR_THRESHOLD = 4;
    var SCAN_DEBOUNCE_MS = 80;

    document.addEventListener('keypress', function(e) {
      // Ignore Enter/Tab keys themselves
      if (e.key === 'Enter' || e.key === 'Tab') return;
      // Only track when focused on an input
      var active = document.activeElement;
      if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) return;

      scanBuffer += e.key;
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(function() {
        if (scanBuffer.length >= SCAN_CHAR_THRESHOLD) {
          log('Scan detected (' + scanBuffer.length + ' chars), dispatching Enter');
          var enterDown = new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true});
          var enterPress = new KeyboardEvent('keypress', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true});
          var enterUp = new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true});
          active.dispatchEvent(enterDown);
          active.dispatchEvent(enterPress);
          active.dispatchEvent(enterUp);
        }
        scanBuffer = '';
      }, SCAN_DEBOUNCE_MS);
    }, true);
  })();

  // WMS Reference field guard: if Fulfil focuses Reference on page load, blur it and scroll back up
  // Skip on list/browse pages (e.g. /receiving/supplier/all) â€” no scan field there
  // EXCEPTION: never blur #product_barcode_input â€” that IS the WMS scan field, not Reference.
  if (location.pathname.includes('/wms/') && !location.hash.includes('/all') && !/^#\/receiving\/supplier\/[a-z]/i.test(location.hash)) {
    var refGuardInterval = setInterval(function() {
      var active = document.activeElement;
      if (active && active.classList.contains('ff-textfield-input') && active.id !== 'product_barcode_input') {
        log('Blurring Reference field focused by Fulfil');
        active.blur();
        window.scrollTo(0, 0);
      }
      var scanBar = document.querySelector('input#product_barcode_input') || document.querySelector('input.MuiInput-input');
      if (scanBar) {
        clearInterval(refGuardInterval);
        scanBar.focus();
        log('Scan bar found, Reference guard complete');
      }
    }, 200);
    setTimeout(function() { clearInterval(refGuardInterval); }, 10000);
  }

  // Tab leak fix: force window.open to navigate current tab instead of spawning new tabs
  try {
    var origOpen = window.open;
    window.open = function(url, name, features) {
      if (url) {
        log('window.open intercepted, navigating in same tab:', url);
        window.location.href = url;
      }
      return window;
    };
  } catch (e) { log('window.open override failed:', e.message); }

  // Tab leak fix part 2: intercept <a target="_blank"> and form target=_blank clicks
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (a && a.href) {
      log('anchor target=_blank intercepted, navigating in same tab:', a.href);
      e.preventDefault();
      e.stopPropagation();
      window.location.href = a.href;
    }
  }, true);

  // Context-aware selector: pick the right scan field based on URL
  function getSelectors() {
    var path = location.pathname;
    var hash = location.hash;

    // Search/list pages - Fulfil renders tree views with .main-tree-view + .ff-tree-table-wrapper.
    // DOM-based detection catches V1 ERP search pages and any future tree view without URL maintenance.
    if (document.querySelector('.main-tree-view, .ff-tree-table-wrapper')) {
      return [];
    }

    // Store Replenishment â€” no autofocus on this app (scan-Enter still fires globally)
    if (location.hostname === 'store-replenishment.aws-prod.sstack.com') {
      return [];
    }

    // Label printing page â€” autofocus interferes with the print UI
    if (path === '/label-printing' || path.indexOf('/label-printing/') === 0) {
      return [];
    }

    // WMS list/browse pages â€” don't autofocus, let user use search bar
    if (hash.includes('/all') || hash === '#/receiving' || hash === '#/receiving/' ||
        hash === '#/customer' || hash === '#/customer/' ||
        hash === '#/receiving/supplier' || hash === '#/receiving/supplier/' ||
        /^#\/receiving\/supplier\/[a-z]/i.test(hash)) {
      return [];
    }

    // Custom Apps â€” Stock Movements: /from-location
    if (path === '/from-location' || path === '/from-location/') {
      return [
        'input.mat-mdc-input-element[formcontrolname="fromLocation"]',
        'input.mat-mdc-input-element[placeholder="Enter location"]'
      ];
    }

    // Custom Apps ï¿½ Stock Movements: /to-location
    if (path === '/to-location' || path === '/to-location/') {
      return [
        'input.mat-mdc-input-element[formcontrolname="toLocation"]',
        'input.mat-mdc-input-element[placeholder="Enter location"]'
      ];
    }

    // WMS app (/wms/) â€” Fulfil's product_barcode_input scan field IS an ff-textfield-input
    // (the broad ff-textfield-input exclusion would skip the real scan field). Target the
    // scan input by ID, then fall back to legacy MUI shapes for older WMS pages.
    if (path.includes('/wms/')) {
      return [
        'input#product_barcode_input',
        'input.MuiInput-input',
        'input.mat-mdc-input-element'
      ];
    }

    // V1 ERP client (/client/) ï¿½ multiple fields per page, use context
    if (hash.includes('stock.inventory')) {
      return [
        'input.ff-textfield-input[placeholder="Select product"]',
        'input.ff-textfield-input[placeholder="Select location"]'
      ];
    }
    if (hash.includes('product.product')) {
      return [
        'input.ff-textfield-input[placeholder="Search variants"]'
      ];
    }
    if (hash.includes('stock.shipment.out') || hash.includes('stock.shipment.in')) {
      return [
        'input.ff-textfield-input[placeholder="Select tracking number"]',
        'input.ff-textfield-input[name="reference"]'
      ];
    }

    // Custom Apps fallback ï¿½ try mat-mdc inputs, then generic text inputs
    if (location.hostname === 'fulfillment.aws-prod.sstack.com' ||
        location.hostname === 'fulfillment.aws-dev.sstack.com') {
      return [
        'input.mat-mdc-input-element',
        'input[type="text"]:not([readonly])',
        'input:not([type]):not([readonly])'
      ];
    }

    // V1 fallback ï¿½ global search
    return [
      'input.ff-autocomplete-input-field[name="ff-global-search"]'
    ];
  }

  var field = null;
  var lastFieldSelector = null;
  var lastNotFound = false;

  function findField() {
    if (field && document.contains(field) && field.isConnected && field.offsetParent !== null) {
      return field;
    }
    field = null;
    lastFieldSelector = null;
    var selectors = getSelectors();
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) {
          field = el;
          lastFieldSelector = selectors[i];
          lastNotFound = false;
          log('Found scan field:', selectors[i]);
          return field;
        }
      } catch (e) { log('Error with selector:', selectors[i]); }
    }
    if (!lastNotFound) {
      log('No scan field found on:', location.pathname + location.hash);
      lastNotFound = true;
    }
    return null;
  }

  // Input-awareness guard: don't steal focus from other input fields
  function isUserInOtherInput() {
    var active = document.activeElement;
    if (!active) return false;
    var tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // If the user is already in the scan field, that's fine
      if (active === field) return false;
      // User is in a different input ï¿½ don't steal focus
      log('User is in another input, skipping focus steal:', active.getAttribute('formcontrolname') || active.placeholder || active.name || active.type);
      return true;
    }
    if (active.isContentEditable) return true;
    return false;
  }

  function ensureFocus() {
    try {
      var el = findField();
      if (!el) return;
      if (isUserInOtherInput()) return;
      if (document.activeElement !== el) {
        el.focus();
        log('Focus restored to scan field');
      }
    } catch (e) { log('Error in ensureFocus:', e.message); }
  }

  window.addEventListener('load', function () { ensureFocus(); }, { once: true });

  document.addEventListener('click', function () {
    setTimeout(ensureFocus, 300);
  }, true);

  document.addEventListener('blur', function (e) {
    if (field && e.target === field) { setTimeout(ensureFocus, 300); }
  }, true);

  // SPA navigation ï¿½ hash changes don't reload, so reset and refocus
  window.addEventListener('hashchange', function () {
    log('Hash changed:', location.hash);
    field = null;
    lastFieldSelector = null;
    setTimeout(ensureFocus, 500);
  });

  var observer = new MutationObserver(function () {
    if (observer.timeout) clearTimeout(observer.timeout);
    observer.timeout = setTimeout(ensureFocus, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(ensureFocus, CONFIG.focusCheckInterval);
  log('Using DataWedge keystroke input mode');

  // === Attach Photo button (all WMS pages) ===
  // Injects a camera/attach button on every WMS page with a resource context.
  // Replaces the native timeline's attach function â€” works on all pages including
  // Putaway view where Fulfil doesn't render the timeline at narrow viewport.
  (function() {
    if (!location.pathname.includes('/wms/')) return;

    var BUTTON_ID = 'ss-attach-photo-btn';

    function getAuthHeader() {
      var raw = localStorage.getItem('ngStorage-sessionId') || '';
      return 'Session ' + raw.replace(/^"|"$/g, '');
    }

    function getContext() {
      try { return JSON.parse(localStorage.getItem('ngStorage-context') || '{}'); }
      catch (e) { return {}; }
    }

    // Detect the current resource (model + ID) from the URL hash
    function getResource() {
      var hash = location.hash;
      var patterns = [
        { re: /#\/receiving\/supplier\/(\d+)/, model: 'stock.shipment.in' },
        { re: /#\/receiving\/internal\/(\d+)/, model: 'stock.shipment.internal' },
        { re: /#\/customer\/shipment\/(\d+)/, model: 'stock.shipment.out' },
        { re: /#\/customer\/(\d+)/, model: 'stock.shipment.out' },
        { re: /#\/inventory\/(\d+)/, model: 'stock.inventory' },
        { re: /#\/production\/(\d+)/, model: 'production' }
      ];
      for (var i = 0; i < patterns.length; i++) {
        var match = hash.match(patterns[i].re);
        if (match) {
          return { model: patterns[i].model, id: parseInt(match[1]), ref: patterns[i].model + ',' + match[1] };
        }
      }
      return null;
    }

    function rpc(method, params) {
      var headers = { 'Content-Type': 'application/json' };
      try { headers['Authorization'] = getAuthHeader(); } catch(e) {}
      return fetch(location.origin + '/', {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({ method: method, params: params })
      }).then(function(r) {
        if (!r.ok) {
          return r.text().then(function(t) { throw new Error(r.status + ': ' + t.substring(0, 200)); });
        }
        return r.json();
      });
    }

    function showToast(msg, isError) {
      var toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:8px;color:white;font-size:14px;font-weight:bold;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.3);' + (isError ? 'background:#d32f2f;' : 'background:#388e3c;');
      toast.textContent = msg;
      document.body.appendChild(toast);
      setTimeout(function() { toast.remove(); }, 4000);
    }

    function setButtonState(btn, state) {
      if (state === 'uploading') {
        btn.disabled = true;
        btn.textContent = 'Uploading...';
        btn.style.opacity = '0.6';
      } else {
        btn.disabled = false;
        btn.textContent = 'Attach Photo';
        btn.style.opacity = '1';
      }
    }

    function uploadPhoto(file, btn) {
      var resource = getResource();
      if (!resource) {
        showToast('Cannot determine what to attach to', true);
        return;
      }

      log('Uploading: ' + file.name + ' â†’ ' + resource.ref);
      setButtonState(btn, 'uploading');

      rpc('model.nereid.static.file.get_temp_file_s3_args', [file.name, getContext()])
      .then(function(resp) {
        if (resp.error) throw new Error(resp.error.message || 'Failed to get upload URL');
        var s3 = resp.result;
        var postUrl = s3.post_args.url;
        var fields = s3.post_args.fields;
        var getUrl = s3.get_url;
        log('S3 presigned ready');

        var fd = new FormData();
        Object.keys(fields).forEach(function(k) { fd.append(k, fields[k]); });
        fd.append('file', file, file.name);

        return fetch(postUrl, { method: 'POST', body: fd })
        .then(function(r) {
          if (!r.ok && r.status !== 204) throw new Error('S3 upload failed: ' + r.status);
          log('S3 upload complete');
          return rpc('model.ir.attachment.add_attachment_from_url', [
            file.name, getUrl, resource.ref, getContext()
          ]);
        });
      })
      .then(function(resp) {
        if (resp.error) throw new Error(resp.error.message || 'Failed to register attachment');
        log('Photo attached to ' + resource.ref);
        showToast('Photo attached');
        setButtonState(btn, 'ready');
      })
      .catch(function(err) {
        log('Upload failed: ' + err.message);
        showToast('Upload failed: ' + err.message, true);
        setButtonState(btn, 'ready');
      });
    }

    function injectButton() {
      if (document.getElementById(BUTTON_ID)) return;
      if (!getResource()) return;

      // Find injection point: look for primary action button or header area
      var anchor = null;
      var allBtns = document.querySelectorAll('button.ff-button-primary, button.ff-button-default');
      // Prefer "Done", "Start receiving", or "Open in ERP" as anchor
      var preferredLabels = ['Done', 'Start receiving', 'Open in ERP'];
      for (var p = 0; p < preferredLabels.length; p++) {
        allBtns.forEach(function(b) {
          if (!anchor && b.textContent.trim() === preferredLabels[p]) anchor = b;
        });
        if (anchor) break;
      }
      // Fallback: use first primary button
      if (!anchor && allBtns.length > 0) anchor = allBtns[0];
      if (!anchor) return;

      var btn = document.createElement('button');
      btn.id = BUTTON_ID;
      btn.className = 'ff-button ff-button-default ff-button-variant-outlined';
      btn.style.cssText = 'margin-left:8px;padding:6px 16px;cursor:pointer;';
      btn.textContent = 'Attach Photo';

      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        input.click();
      });

      input.addEventListener('change', function() {
        if (input.files && input.files.length > 0) {
          uploadPhoto(input.files[0], btn);
          input.value = '';
        }
      });

      anchor.parentElement.insertBefore(btn, anchor);
      anchor.parentElement.appendChild(input);
      log('Attach Photo button injected on ' + location.hash.substring(0, 40));
    }

    // Watch for page changes and inject
    var attachObserver = new MutationObserver(function() {
      if (attachObserver._debounce) clearTimeout(attachObserver._debounce);
      attachObserver._debounce = setTimeout(injectButton, 500);
    });
    attachObserver.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('hashchange', function() {
      setTimeout(function() {
        var old = document.getElementById(BUTTON_ID);
        if (old) old.remove();
        // Also remove any orphaned file inputs
        var oldInput = document.querySelector('input[capture="environment"]');
        if (oldInput) oldInput.remove();
        setTimeout(injectButton, 1000);
      }, 500);
    });

    setTimeout(injectButton, 2000);
    log('Attach Photo module loaded (all WMS pages)');
  })();
})();
