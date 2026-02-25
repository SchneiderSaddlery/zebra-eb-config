(function () {
  'use strict';

  // Configuration
  const CONFIG = {
    allowedHosts: ['sstack.fulfil.io', 'app.sstack.com', 'fulfillment.aws-prod.sstack.com'],
    submitOnEnter: true,
    debugMode: true, // Set to false to disable console logging
    focusCheckInterval: 3000, // ms
    barcodeSymbologies: {
      code128: true,
      ean13: true,
      ean8: true,
      code39: true,
      code93: true,
      upca: true,
      upce: true,
      qrCode: true,
      dataMatrix: true
    }
  };

  // Selectors for scan input fields — matched against live Fulfil.io ERP (2026-02-24)
  // All scan fields are Angular Material inputs with class mat-mdc-input-element.
  // IDs are auto-generated (mat-input-0, mat-input-1) and unstable.
  // No name, aria-label, or data attributes are present.
  const selectors = [
    // Known scan-field placeholders (exact matches from ERP pages)
    'input.mat-mdc-input-element[placeholder="Scan items"]',
    'input.mat-mdc-input-element[placeholder="Enter SKU/UPC"]',
    'input.mat-mdc-input-element[placeholder="Enter location"]',

    // Broader placeholder matches for future scan fields
    'input.mat-mdc-input-element[placeholder*="scan" i]',
    'input.mat-mdc-input-element[placeholder*="sku" i]',
    'input.mat-mdc-input-element[placeholder*="upc" i]',
    'input.mat-mdc-input-element[placeholder*="barcode" i]',
    'input.mat-mdc-input-element[placeholder*="location" i]',
    'input.mat-mdc-input-element[placeholder*="item" i]',

    // Any visible Angular Material text input (covers new pages)
    // Note: Angular Material inputs often omit the type attribute entirely
    // (browser defaults to "text"), so we match the class without type filter
    'input.mat-mdc-input-element:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
  ];

  // Debug logging helper
  function log(message, data = null) {
    if (!CONFIG.debugMode) return;
    const prefix = '[Zebra Scanner Focus]';
    if (data) {
      console.log(prefix, message, data);
    } else {
      console.log(prefix, message);
    }
  }

  // Check if we're on an allowed host
  if (!CONFIG.allowedHosts.includes(location.hostname)) {
    log('Not on allowed host:', location.hostname);
    return;
  }

  log('Script initialized on:', location.hostname);

  let field = null;
  let lastFieldSelector = null;

  // Find the scan input field
  function findField() {
    // If we have a cached field, verify it's still in the DOM and visible
    // Angular re-renders can destroy and recreate elements
    if (field && document.contains(field) && field.isConnected && field.offsetParent !== null) {
      return field;
    }

    // Clear stale reference
    field = null;
    lastFieldSelector = null;

    // Search for field using selectors (ordered by specificity)
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.type !== 'hidden' && el.offsetParent !== null) {
          field = el;
          lastFieldSelector = sel;
          log('Found scan field using selector:', sel);
          log('Field details:', {
            id: el.id,
            placeholder: el.placeholder,
            className: el.className.split(' ').slice(0, 3).join(' ')
          });
          return field;
        }
      } catch (e) {
        log('Error with selector:', { selector: sel, error: e.message });
      }
    }

    log('No scan field found on this page');
    return null;
  }

  // Ensure focus is on the scan field
  function ensureFocus() {
    try {
      const el = findField();

      if (!el) {
        log('Cannot ensure focus: no field found');
        return;
      }

      if (document.activeElement !== el) {
        el.focus();
        log('Focus restored to scan field');
      }
    } catch (e) {
      log('Error in ensureFocus:', e.message);
    }
  }

  // Set up event listeners
  log('Setting up event listeners');

  window.addEventListener('load', function() {
    log('Page loaded');
    ensureFocus();
  }, { once: true });

  document.addEventListener('click', function(e) {
    // Small delay to allow the click event to complete
    setTimeout(ensureFocus, 10);
  }, true);

  document.addEventListener('blur', function(e) {
    // Only refocus if the scan field lost focus
    if (field && e.target === field) {
      log('Scan field lost focus, restoring');
      setTimeout(ensureFocus, 10);
    }
  }, true);

  // Watch for DOM changes
  const observer = new MutationObserver(function() {
    // Debounce the ensureFocus call
    if (observer.timeout) clearTimeout(observer.timeout);
    observer.timeout = setTimeout(ensureFocus, 100);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Periodic focus check
  setInterval(ensureFocus, CONFIG.focusCheckInterval);
  log('Periodic focus check every', CONFIG.focusCheckInterval + 'ms');

  // Enterprise Browser Barcode API integration
  if (typeof EB === 'undefined' || !EB || !EB.Barcode) {
    log('Zebra Enterprise Browser API not available');
    log('Using DataWedge keystroke input mode');
    return;
  }

  log('Zebra Enterprise Browser API detected');
  log('Enabling barcode scanner with symbologies:', CONFIG.barcodeSymbologies);

  // Enable barcode scanning
  EB.Barcode.enable(CONFIG.barcodeSymbologies, function (result) {
    try {
      log('Barcode scan received:', result);

      const el = findField();

      if (!el) {
        log('ERROR: No scan field found to receive barcode data');
        return;
      }

      if (!result || typeof result.data !== 'string') {
        log('ERROR: Invalid barcode data received:', result);
        return;
      }

      // Set the barcode value
      el.value = result.data;
      log('Barcode value set:', result.data);

      // Ensure focus
      el.focus();

      // Trigger input event for frameworks that listen to it
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Submit with Enter key if configured
      if (CONFIG.submitOnEnter) {
        log('Dispatching Enter key events');
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
        el.dispatchEvent(new KeyboardEvent('keypress', {
          key: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
      }

      log('Barcode processing complete');
    } catch (e) {
      log('ERROR in barcode callback:', e.message);
      console.error('Barcode processing error:', e);
    }
  });

  log('Barcode scanner enabled successfully');

  // Expose a global function to manually find and log the scan field
  window.zebraDebugScanField = function() {
    const el = findField();
    if (el) {
      console.log('Current scan field:', el);
      console.log('Field selector:', lastFieldSelector);
      console.log('Is focused:', document.activeElement === el);
      return el;
    } else {
      console.log('No scan field found');
      return null;
    }
  };

  log('Debug helper exposed: window.zebraDebugScanField()');
})();
