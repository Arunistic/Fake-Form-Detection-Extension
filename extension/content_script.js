// =========================================================
// FAKE FORM DETECTION - CONTENT SCRIPT (FIXED)
// - Captures clicks in capture phase to detect non-submit buttons
// - Safe Browsing check via service worker
// - JS .submit() override
// - fetch()/XHR interception + replay on "Proceed anyway"
// - Report is safe in cross-origin iframes
// =========================================================

console.log("FFD: content_script loaded (fixed)");
// Track last clicked button (for re-trigger on proceed)
// ---------------- CLICK INTERCEPTION ----------------
document.addEventListener("click", (ev) => {
  if (window.__ffd_skipNextClick) {
    window.__ffd_skipNextClick = false;
    return;
}

  try {
    if (ev.button !== 0) return;
    if (ev.defaultPrevented) return;
    if (__ffd_modal_open) return;

    let el = ev.target;
    let buttonEl = null;

    for (let node = el; node && node !== document; node = node.parentNode) {
      if (!node.tagName) continue;
      const tag = node.tagName.toLowerCase();

      if (tag === "button" ||
          (tag === "input" && (node.type === "submit" || node.type === "button")) ||
          node.getAttribute("role") === "button") {
        buttonEl = node;
        break;
      }
    }

    if (!buttonEl) return;

    const form = buttonEl.form || (buttonEl.closest && buttonEl.closest("form"));
    if (!form) return;

    // ⭐ NEW: if the page/form has been marked to bypass interception, allow the click to go through
    if (form.__ffd_disableInterception) {
      // small debug log so we can see the bypass in action
      console.log("FFD: bypassing interception for form (disable flag set)");
      return;
    }

    const info = analyzeForm(form);
    if (!info.hasPassword) return;

    const heuristics = evaluateFormRisk(info);
    if (heuristics.length > 0) {
      // block the click before page's JS executes
      try {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      } catch (e) { /* ignore */ }

      showWarningModal(form, heuristics, info);
      return;
    }
  } catch (e) {
    console.warn("FFD: capture click handler error", e);
  }
}, true);

// ----------------- globals -----------------
const __ffd_pendingAjax = [];
let __ffd_modal_open = false;

// ----------------- Safe Browsing -----------------
function safeBrowsingCheck(url) {
  try { url = new URL(url, location.href).href; } catch {}

  return new Promise((resolve) => {
    // If extension API missing (iframe, invalid context)
    if (!chrome?.runtime?.sendMessage) {
      return resolve({ status: "unknown", error: "runtime_unavailable" });
    }

    try {
      chrome.runtime.sendMessage({ type: "safeBrowseCheck", url }, (resp) => {
        if (chrome.runtime.lastError) {
          return resolve({ status: "unknown", error: chrome.runtime.lastError.message });
        }
        resolve(resp || { status: "unknown" });
      });
    } catch (e) {
      resolve({ status: "unknown", error: "sendMessage_failed" });
    }
  });
}


// ----------------- utils: analyze & evaluate -----------------
function analyzeForm(form) {
  const action = form.getAttribute("action") || location.href;
  const method = (form.getAttribute("method") || "GET").toUpperCase();
  const inputs = Array.from(form.querySelectorAll("input, textarea, select, button"))
    .map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "", hidden: el.type === "hidden" || el.offsetParent === null }));
  const hasPassword = inputs.some(i => (i.type || "").toLowerCase() === "password");
  const pageDomain = location.hostname.replace(/^www\./i, "").toLowerCase();
  let actionDomain = "";
  try { actionDomain = new URL(action, location.href).hostname.replace(/^www\./i, "").toLowerCase(); } catch (e) {}
  const isHTTPS = location.protocol === "https:";
  const brand = (typeof looksLikeBrand === "function") ? looksLikeBrand(document) : null;
  return { action, method, inputs, hasPassword, pageDomain, actionDomain, isHTTPS, brand, pageTitle: document.title || "" };
}

function evaluateFormRisk(info, sb = { status: "unknown" }) {
  const reasons = [];
  if (!info.hasPassword) return reasons;
  if (sb.status === "unsafe") reasons.push("Safe Browsing: URL flagged as unsafe.");
  if (info.actionDomain && info.actionDomain !== info.pageDomain) reasons.push(`Form posts to a different domain: ${info.actionDomain}`);
  if (!info.isHTTPS) reasons.push("Page is not HTTPS.");
  const hiddenCount = info.inputs.filter(i => i.hidden).length;
  if (hiddenCount >= 2) reasons.push(`Form contains ${hiddenCount} hidden inputs (possible exfiltration).`);
  if (info.brand && !info.pageDomain.includes(info.brand)) reasons.push(`Page appears to impersonate ${info.brand} but domain is ${info.pageDomain}.`);
  return Array.from(new Set(reasons));
}

// ----------------- attach handlers -----------------
function attachFormHandler(form) {
  if (!form || form.__ffd_hooked) return;
  form.__ffd_hooked = true;

  // override JS form.submit()
  if (!form.__ffd_submitPatched) {
    form.__ffd_submitPatched = true;
    const origSubmit = form.submit;
    form.submit = function () {
      try {
        // If the page/form has been allowed to bypass interception (user chose "Proceed anyway"),
        // call the original native submit immediately.
        if (form.__ffd_disableInterception) {
          return origSubmit.call(form);
        }

        const info = analyzeForm(form);
        const reasons = evaluateFormRisk(info);
        if (reasons.length > 0) {
          showWarningModal(form, reasons, info);
          return;
        }
      } catch (e) {
        console.warn("FFD: form.submit hook error", e);
      }
      return origSubmit.call(form);
    };
  }

  // normal submit listener (user-initiated submissions)
  form.addEventListener("submit", async (ev) => {
    try {
      const info = analyzeForm(form);
      const sb = await safeBrowsingCheck(info.action);
      const reasons = evaluateFormRisk(info, sb);
      if (reasons.length > 0) {
        ev.preventDefault();
        ev.stopPropagation();
        showWarningModal(form, reasons, info);
      }
    } catch (e) {
      console.warn("FFD: submit listener error", e);
    }
  }, { capture: true, passive: false });
}

// ----------------- capture-phase click interception -----------------
// This intercepts clicks on buttons (including type="button") before page JS runs.
document.addEventListener("click", function (ev) {
  try {
    if (ev.defaultPrevented) return;
    // Only intercept primary button clicks
    if (ev.button !== 0) return;

    // If modal already open, don't intercept further
    if (__ffd_modal_open) {
      // If modal open, we don't block
      return;
    }

    // find the nearest clickable element: button or input[type=submit] or element with role=button
    let el = ev.target;
    // walk up to find button-like control
    let buttonEl = null;
    for (let node = el; node && node !== document; node = node.parentNode) {
      if (!node.tagName) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "button") { buttonEl = node; break; }
      if (tag === "input" && (node.type === "submit" || node.type === "button")) { buttonEl = node; break; }
      // treat elements with role=button as buttons
      if (node.getAttribute && node.getAttribute("role") === "button") { buttonEl = node; break; }
    }

    // if no button found, nothing to do here
    if (!buttonEl) return;

    // find associated form
    const form = buttonEl.form || buttonEl.closest && buttonEl.closest("form");
    if (!form) return;

    // run analysis & heuristics
    const info = analyzeForm(form);
    // If no password field, ignore
    if (!info.hasPassword) return;

    // Do Safe Browsing check synchronously? We need to avoid blocking UI. We'll do heuristics first.
    const heuristics = evaluateFormRisk(info, { status: "unknown" });
    if (heuristics.length > 0) {
      // block the click before page's JS executes
      try {
        ev.preventDefault();
        ev.stopPropagation();
        // stopImmediatePropagation is helpful to prevent other listeners on same element
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      } catch (e) { /* ignore */ }

      showWarningModal(form, heuristics, info);
      return;
    }
    // If heuristics didn't detect anything, allow click — fetch/XHR override will catch exfiltration later
  } catch (e) {
    console.warn("FFD: capture click handler error", e);
  }
}, true); // capture phase

// ----------------- AJAX / fetch / XHR detection -----------------
function extractCredentialsFromBody(body) {
  try {
    const patt = /(pass|pwd|password|user|email|u_name|uname)/i;
    if (typeof body === "string") { if (patt.test(body)) return body; return null; }
    if (body instanceof URLSearchParams) { const s = body.toString(); if (patt.test(s)) return s; return null; }
    if (body instanceof FormData) { let s=""; for (const [k,v] of body.entries()) s += `${k}=${v}&`; if (patt.test(s)) return s; return null; }
    if (typeof body === "object" && body !== null) { const s = JSON.stringify(body); if (patt.test(s)) return s; return null; }
  } catch (e) { console.warn("FFD: extractCreds error", e); }
  return null;
}

function triggerAjaxWarning(details) {
  try {
    showWarningModal(document.forms[0] || document.body, ["Possible credential exfiltration detected via JavaScript (AJAX)."], details);
  } catch (e) { console.warn("FFD: triggerAjaxWarning failed", e); }
}

// fetch override
(function(){
  const origFetch = window.fetch;
  window.fetch = function(input, init = {}) {
    try {
      const method = (init && init.method) ? init.method.toUpperCase() : (typeof input === "string" ? "GET" : (input && input.method) || "GET");
      if (method === "POST") {
        const creds = extractCredentialsFromBody(init.body);
        if (creds) {
          __ffd_pendingAjax.push({ type: "fetch", url: typeof input === "string" ? input : (input && input.url), init });
          triggerAjaxWarning({ type: "fetch", url: typeof input === "string" ? input : (input && input.url), body: creds });
          return new Promise(() => {}); // block until user decision
        }
      }
    } catch (e) { console.warn("FFD: fetch inspect error", e); }
    return origFetch.apply(this, arguments);
  };
})();

// XHR override
(function(){
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    try { this._ffd_method = method; this._ffd_url = url; this._ffd_headers = []; } catch(e){}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    try { if (!this._ffd_headers) this._ffd_headers = []; this._ffd_headers.push([k, v]); } catch(e){}
    return origSetHeader.call(this, k, v);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      const method = (this._ffd_method || "GET").toUpperCase();
      if (method === "POST") {
        const creds = extractCredentialsFromBody(body);
        if (creds) {
          __ffd_pendingAjax.push({ type: "xhr", method: this._ffd_method, url: this._ffd_url, headers: (this._ffd_headers || []), body });
          triggerAjaxWarning({ type: "xhr", url: this._ffd_url, body: creds });
          return; // block until user decision
        }
      }
    } catch (e) { console.warn("FFD: XHR.inspect error", e); }
    return origSend.call(this, body);
  };
})();

// ----------------- modal UI (robust, iframe-safe) -----------------
function showWarningModal(form, reasons, formInfo) {
  try {
    if (__ffd_modal_open) return;
    __ffd_modal_open = true;

    const overlay = document.createElement("div");
    overlay.id = "__ffd_modal";
    overlay.style = `position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:2147483647;`;

    const box = document.createElement("div");
    box.style = "background:white;padding:18px;border-radius:10px;max-width:720px;width:90%;font-family:Arial, sans-serif;box-shadow:0 6px 30px rgba(0,0,0,0.3);";

    const title = document.createElement("h2");
    title.textContent = "Security warning — suspicious login activity";
    title.style = "margin:0 0 8px 0;font-size:16px;";
    box.appendChild(title);

    const p = document.createElement("p");
    p.textContent = "This page appears to be sending credentials in a suspicious way. Please review and choose an action.";
    box.appendChild(p);

    const ul = document.createElement("ul");
    for (const r of reasons) { const li = document.createElement("li"); li.textContent = r; ul.appendChild(li); }
    box.appendChild(ul);

    const debugPre = document.createElement("pre");
    debugPre.style = "background:#f7f7f7;padding:8px;border-radius:6px;max-height:120px;overflow:auto;";
    try { debugPre.textContent = JSON.stringify(formInfo, null, 2); } catch(e) { debugPre.textContent = String(formInfo); }
    box.appendChild(debugPre);

    const btns = document.createElement("div");
    btns.style = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";

    // Report
    const reportBtn = document.createElement("button");
    reportBtn.textContent = "Report";
    reportBtn.style = "padding:8px 12px;background:#2b90d9;color:#fff;border:none;border-radius:6px;cursor:pointer;";
    reportBtn.onclick = () => {
      try {
        if (chrome?.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: "reportPhish", payload: { pageUrl: location.href, reasons, formInfo } }, () => console.info("FFD: Report sent"));
        } else {
          console.warn("FFD: chrome.runtime not available in this frame — report skipped");
        }
      } catch (e) {
        console.warn("FFD: report failed", e);
      }
    };
    btns.appendChild(reportBtn);

    // Cancel
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style = "padding:8px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer;";
    cancelBtn.onclick = () => {
      try { overlay.remove(); } catch(e) {}
      __ffd_modal_open = false;
    };
    btns.appendChild(cancelBtn);

// Proceed anyway
const proceedBtn = document.createElement("button");
proceedBtn.textContent = "Proceed anyway";
proceedBtn.style = "padding:8px 12px;border-radius:6px;background:#d9534f;color:#fff;border:none;cursor:pointer;";
proceedBtn.onclick = () => {
  overlay.remove();
  __ffd_modal_open = false;

  form.__ffd_disableInterception = true;

  // ⭐ Restore last clicked button
  if (window.__ffd_lastClickedButton) {
    const btn = window.__ffd_lastClickedButton;

    // ⭐ Re-fire the EXACT user click properly
    const evt = new MouseEvent("click", {
      view: window,
      bubbles: true,
      cancelable: true,
      button: 0
    });

    console.info("FFD: Replay original button click");
    btn.dispatchEvent(evt);
    return;
  }

  // Fallback: natural submit (if no button)
  console.info("FFD: fallback native submit()");
  form.submit();
};


btns.appendChild(proceedBtn);


box.appendChild(btns);
overlay.appendChild(box);
(document.body || document.documentElement).appendChild(overlay);

} catch (e) {
    console.error("FFD: showWarningModal error", e);
    __ffd_modal_open = false;
}
}

// ----------------- scan & observe -----------------
function initFormScanner() {
  try {
    Array.from(document.forms).forEach(attachFormHandler);
  } catch (e) { console.warn("FFD: initFormScanner error", e); }
}

setTimeout(initFormScanner, 600);

new MutationObserver(() => setTimeout(initFormScanner, 250))
  .observe(document.documentElement || document, { childList: true, subtree: true });

// Export minimal helpers for debugging (within content script context)
window.__ffd = window.__ffd || {};
window.__ffd.analyzeForm = analyzeForm;
window.__ffd.evaluateFormRisk = evaluateFormRisk;
window.__ffd.initFormScanner = initFormScanner;
window.__ffd.safeBrowsingCheck = safeBrowsingCheck;

console.log("FFD: content_script ready");
