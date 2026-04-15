// ─────────────────────────────────────────────────────────────────────────────
//  content.js  –  FactCheck Extension Content Script
//  Handles: screenshot OCR, selection highlight badge
// ─────────────────────────────────────────────────────────────────────────────

// ── Floating badge on text selection ─────────────────────────────────────────
let badge = null;

document.addEventListener("mouseup", () => {
  const selected = window.getSelection()?.toString().trim();
  if (selected && selected.length > 10) {
    showSelectionBadge(selected);
  } else {
    removeBadge();
  }
});

document.addEventListener("mousedown", (e) => {
  if (badge && !badge.contains(e.target)) removeBadge();
});

function showSelectionBadge(text) {
  removeBadge();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const rect  = range.getBoundingClientRect();

  badge = document.createElement("div");
  badge.id = "factcheck-badge";
  badge.innerHTML = `
    <span style="font-size:12px;font-family:sans-serif;font-weight:600;letter-spacing:.3px">
      🔍 FactCheck this
    </span>`;
  // BUG 1 FIX: position:fixed uses viewport coords — don't add scrollY
  Object.assign(badge.style, {
    position: "fixed",
    top: `${rect.top - 36}px`,
    left: `${rect.left + rect.width / 2 - 60}px`,
    background: "#1a1a2e",
    color: "#e0e0ff",
    border: "1px solid #4a4aff",
    borderRadius: "8px",
    padding: "5px 12px",
    cursor: "pointer",
    zIndex: "2147483647",
    boxShadow: "0 4px 16px rgba(74,74,255,0.35)",
    userSelect: "none",
    transition: "opacity 0.15s"
  });

  badge.addEventListener("click", () => {
    // BUG 11 FIX: Show visual feedback immediately — popup can't auto-open from content script
    badge.innerHTML = `<span style="font-size:12px;font-family:sans-serif">⏳ Checking…</span>`;
    badge.style.cursor = "default";
    badge.style.opacity = "0.8";

    chrome.runtime.sendMessage({ type: "CHECK_CLAIM", text }, (res) => {
      if (res?.success) {
        chrome.storage.session.set({ lastResult: res.result, lastQuery: text });
        badge.innerHTML = `<span style="font-size:12px;font-family:sans-serif">✅ Done — open extension</span>`;
      } else {
        badge.innerHTML = `<span style="font-size:12px;font-family:sans-serif">❌ Failed</span>`;
      }
      setTimeout(removeBadge, 2500);
    });
  });

  document.body.appendChild(badge);
}

function removeBadge() {
  if (badge) { badge.remove(); badge = null; }
}

// ── OCR: listen for screenshot data from popup ────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OCR_RESULT") {
    // OCR text extracted in popup → sent back to pipeline
    chrome.runtime.sendMessage({ type: "CHECK_CLAIM", text: msg.text }, sendResponse);
    return true;
  }
});
