(function () {
  'use strict';
  var CONFIG = {
    allowedHosts: ['sstack.fulfil.io', 'fulfillment.aws-prod.sstack.com', 'sstack-sandbox.fulfil.app', 'store-replenishment.aws-prod.sstack.com'],
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
    if (location.hostname === 'fulfillment.aws-prod.sstack.com') {
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
