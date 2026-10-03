/* resize.js — PLACEHOLDER / MOCK for the Hilltoppers extension's
   "Fit content" height mode.
   Replace this file with the real resize.js supplied by chrome-extension/
   when it is available. The mock below already implements the contract:
   it measures [data-topping-content] and postMessages the height to the
   parent window, re-measuring whenever the content changes. */

(function () {
  "use strict";

  var SELECTOR = "[data-topping-content]";
  var lastHeight = -1;

  function measure() {
    var el = document.querySelector(SELECTOR);
    if (!el) return;
    var height = Math.ceil(el.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;

    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "hiltoppers:topping-resize", height: height }, "*");
    }
  }

  function start() {
    measure();

    var el = document.querySelector(SELECTOR);
    if (el && typeof MutationObserver === "function") {
      new MutationObserver(measure).observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }

    window.addEventListener("resize", measure);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure).catch(function () {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Expose for manual re-measurement after programmatic updates.
  window.toppingResize = measure;
})();
