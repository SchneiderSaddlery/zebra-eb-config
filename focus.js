(function () {
  'use strict';
  var CONFIG = {
    allowedHosts: ['sstack.fulfil.io', 'fulfillment.aws-prod.sstack.com'],
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

  // Context-aware selector: pick the right scan field based on URL
  function getSelectors() {
    var path = location.pathname;
    var hash = location.hash;

    // Custom Apps — Stock Movements: /from-location
    if (path === '/from-location' || path === '/from-location/') {
      return [
        'input.mat-mdc-input-element[formcontrolname="fromLocation"]',
        'input.mat-mdc-input-element[placeholder="Enter location"]'
      ];
    }

    // Custom Apps — Stock Movements: /to-location
    if (path === '/to-location' || path === '/to-location/') {
      return [
        'input.mat-mdc-input-element[formcontrolname="toLocation"]',
        'input.mat-mdc-input-element[placeholder="Enter location"]'
      ];
    }

    // WMS app (/wms/) — try known classes, then any visible text input
    if (path.includes('/wms/')) {
      return [
        'input.ff-textfield-input',
        'input.mat-mdc-input-element',
        'input[type="text"]:not([readonly])',
        'input:not([type]):not([readonly])'
      ];
    }

    // V1 ERP client (/client/) — multiple fields per page, use context
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

    // Custom Apps fallback — try mat-mdc inputs, then generic text inputs
    if (location.hostname === 'fulfillment.aws-prod.sstack.com') {
      return [
        'input.mat-mdc-input-element',
        'input[type="text"]:not([readonly])',
        'input:not([type]):not([readonly])'
      ];
    }

    // V1 fallback — global search
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
      // User is in a different input — don't steal focus
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

  // SPA navigation — hash changes don't reload, so reset and refocus
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
})();
