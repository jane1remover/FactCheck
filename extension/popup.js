// ─────────────────────────────────────────────────────────────────────────────
//  popup.js  –  FactCheck Extension Popup Logic
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const claimInput    = $("claimInput");
const checkBtn      = $("checkBtn");
const clearBtn      = $("clearBtn");
const ocrInput      = $("ocrInput");
const loading       = $("loading");
const loadingText   = $("loadingText");
const errorCard     = $("errorCard");
const resultCard    = $("resultCard");
const verdictBadge  = $("verdictBadge");
const sourceTag     = $("sourceTag");
const claimText     = $("claimText");
const publisherVal  = $("publisherVal");
const confidenceRow = $("confidenceRow");
const confidenceBar = $("confidenceBar");
const confidenceVal = $("confidenceVal");
const resultLink    = $("resultLink");
const backendStatus = $("backendStatus");

// ── Check backend health on open ──────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      backendStatus.textContent = "✓ ML backend online";
      backendStatus.className = "backend-status backend-ok";
    } else throw new Error();
  } catch {
    backendStatus.textContent = "✗ ML backend offline";
    backendStatus.className = "backend-status backend-err";
  }
})();

// ── Restore last result from session ─────────────────────────────────────────
chrome.storage.session.get(["lastResult", "lastQuery"], ({ lastResult, lastQuery }) => {
  if (lastResult && lastQuery) {
    claimInput.value = lastQuery;
    if (lastResult?.mode === "article") {
      renderArticleResult(lastResult, lastQuery);
    } else {
      renderResult(lastResult, lastQuery);
    }
  }
});

// ── Events ────────────────────────────────────────────────────────────────────
checkBtn.addEventListener("click", () => {
  const text = claimInput.value.trim();
  if (!text) { showError("Please enter a claim to fact-check."); return; }
  submitClaim(text);
});

claimInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) checkBtn.click();
});

clearBtn.addEventListener("click", () => {
  claimInput.value = "";
  hideAll();
  chrome.storage.session.remove(["lastResult", "lastQuery"]);
});

// ── OCR via Tesseract.js ──────────────────────────────────────────────────────
ocrInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showLoading("Running OCR on image…");
  try {
    const worker = await Tesseract.createWorker("eng");
    const { data: { text } } = await worker.recognize(file);
    await worker.terminate();
    const extracted = text.trim();
    if (!extracted) { showError("Could not extract text from image. Try a clearer screenshot."); return; }
    claimInput.value = extracted;
    submitClaim(extracted);
  } catch (err) {
    showError("OCR failed: " + err.message);
  } finally {
    ocrInput.value = "";
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Core: send to background.js pipeline
// ─────────────────────────────────────────────────────────────────────────────
function submitClaim(text) {
  hideAll();
  showLoading("Checking Google FactCheck API…");
  checkBtn.disabled = true;

  let phase = 0;
  const phases = [
    "Checking Google FactCheck API…",
    "Checking DuckDuckGo for context…",
    "Running RoBERTa ML model…",
    "Analyzing claim…"
  ];
  const phaseInterval = setInterval(() => {
    phase = (phase + 1) % phases.length;
    loadingText.textContent = phases[phase];
  }, 1800);

  chrome.runtime.sendMessage({ type: "CHECK_CLAIM", text }, (response) => {
    clearInterval(phaseInterval);
    checkBtn.disabled = false;
    loading.classList.remove("visible");

    if (chrome.runtime.lastError) {
      showError("Extension error: " + chrome.runtime.lastError.message);
      return;
    }
    if (!response?.success) {
      showError(response?.error || "Unknown error occurred.");
      return;
    }

    chrome.storage.session.set({ lastResult: response.result, lastQuery: text });
    if (response.result?.mode === "article") {
      renderArticleResult(response.result, text);
    } else {
      renderResult(response.result, text);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Render result — now takes userQuery separately to detect semantic mismatch
// ─────────────────────────────────────────────────────────────────────────────
function renderResult(r, userQuery) {
  hideAll();
  resultCard.classList.add("visible");

  // BUG 2 FIX: Clean up ALL dynamically-created boxes on every re-render
  ["wikiSummaryBox", "semanticWarningBox", "mlDisclaimerBox", "ddgBox"].forEach(id => {
    const el = $(id);
    if (el) el.remove();
  });

  const rating           = r.rating || "Uncertain";
  const normalizedRating = normalizeRating(rating);

  // ── Verdict badge ──
  verdictBadge.textContent = ratingEmoji(normalizedRating) + " " + rating;
  verdictBadge.className   = "verdict-badge verdict-" + normalizedRating;

  // ── Source tag ──
  sourceTag.textContent = r.source || "AI Model";

  // ── Claim text: show what was ACTUALLY verified ──
  // For Google results, claimText is the fact-checker's claim (may differ from user input)
  // For ML results, claimText IS the user input
  const verifiedClaim = (r.claimText || r.checkedText || "").trim();
  const displayText   = verifiedClaim.slice(0, 200) + (verifiedClaim.length > 200 ? "…" : "");
  claimText.textContent = displayText;

  // ── Semantic mismatch warning (Google only) ──────────────────────────────
  // If the claim Google actually checked is meaningfully different from what the
  // user typed, show a yellow warning box so the user isn't misled.
  if (r.source === "Google FactCheck" && userQuery) {
    const userWords     = tokenize(userQuery);
    const verifiedWords = tokenize(verifiedClaim);
    const overlap       = userWords.filter(w => verifiedWords.includes(w)).length;
    const similarity    = userWords.length > 0 ? overlap / userWords.length : 1;

    // Show warning if less than 60% of user's words appear in the verified claim
    if (similarity < 0.6) {
      const box = document.createElement("div");
      box.id = "semanticWarningBox";
      Object.assign(box.style, {
        marginTop: "10px",
        padding: "9px 12px",
        background: "rgba(245,158,11,0.08)",
        border: "1px solid rgba(245,158,11,0.35)",
        borderRadius: "8px",
        fontSize: "11px",
        color: "#f59e0b",
        lineHeight: "1.6"
      });
      box.innerHTML =
        `⚠️ <strong>Note:</strong> This verdict is for a <em>related</em> claim, ` +
        `not your exact wording. Always read the full fact-check before concluding.`;
      resultCard.appendChild(box);
    }
  }

  // ── ML model disclaimer ───────────────────────────────────────────────────
  // Always shown for ML results so user knows it's probabilistic
  // BUG 2 FIX: Use unique id "mlDisclaimerBox" (was incorrectly "semanticWarningBox")
  if (r.source === "AI Model (RoBERTa)") {
    const box = document.createElement("div");
    box.id = "mlDisclaimerBox";
    Object.assign(box.style, {
      marginTop: "10px",
      padding: "9px 12px",
      background: "rgba(136,136,187,0.08)",
      border: "1px solid rgba(136,136,187,0.3)",
      borderRadius: "8px",
      fontSize: "11px",
      color: "#8888bb",
      lineHeight: "1.6"
    });
    const conf = r.confidence ? Math.round(r.confidence * 100) : "?";
    box.innerHTML =
      `🤖 <strong>AI estimate only</strong> (${conf}% confidence). ` +
      `No verified fact-check found. This model has ~44% accuracy — treat as a signal, not a verdict.`;
    resultCard.appendChild(box);
  }

  // ── DuckDuckGo metadata display ──────────────────────────────────────────────
  if (r.source === "DuckDuckGo" && r.ddgMeta) {
    const { abstract, trueScore, falseScore, mixedScore, type } = r.ddgMeta;
    const total = trueScore + falseScore + mixedScore || 1;
    const box = document.createElement("div");
    box.id = "ddgBox";
    Object.assign(box.style, {
      marginTop: "10px", padding: "9px 12px",
      background: "rgba(91,91,255,0.07)",
      border: "1px solid rgba(91,91,255,0.25)",
      borderRadius: "8px", fontSize: "11px",
      color: "#8888bb", lineHeight: "1.7"
    });

    if (type === "direct_answer") {
      box.innerHTML = `🦆 <strong style="color:var(--text)">DuckDuckGo direct answer</strong>`;
    } else {
      const pctTrue  = Math.round(trueScore  / total * 100);
      const pctFalse = Math.round(falseScore / total * 100);
      const pctMixed = Math.round(mixedScore / total * 100);
      box.innerHTML =
        `🦆 <strong style="color:var(--text)">Web context signals</strong><br>` +
        `<span style="color:#22c55e">✔ ${pctTrue}% confirming</span> &nbsp;` +
        `<span style="color:#ef4444">✘ ${pctFalse}% contradicting</span> &nbsp;` +
        `<span style="color:#f59e0b">~ ${pctMixed}% mixed</span>`;
    }
    resultCard.appendChild(box);
  }

  // ── Publisher ──
  publisherVal.textContent = r.publisher || "—";

  // ── Wikipedia summary ──
  if (r.source === "Wikipedia" && r.wikiSummary) {
    const box = document.createElement("div");
    box.id = "wikiSummaryBox";
    Object.assign(box.style, {
      marginTop: "10px", padding: "10px",
      background: "rgba(255,255,255,0.04)",
      border: "1px solid var(--border)",
      borderRadius: "8px", fontSize: "11px",
      color: "var(--muted)", lineHeight: "1.6"
    });
    box.innerHTML = `<span style="color:var(--text);font-weight:600">📖 ${r.wikiTitle}</span><br>${r.wikiSummary}`;
    resultCard.appendChild(box);
  }

  // ── Confidence bar (ML only) ──
  if (r.confidence !== null && r.confidence !== undefined) {
    confidenceRow.style.display = "flex";
    const pct = Math.round(r.confidence * 100);
    confidenceBar.style.width = pct + "%";
    confidenceVal.textContent  = pct + "%";
    const colors = { True: "#22c55e", False: "#ef4444", Mixed: "#f59e0b", Uncertain: "#8888bb" };
    confidenceBar.style.background = colors[normalizedRating] || "#5b5bff";
  } else {
    confidenceRow.style.display = "none";
  }

  // ── Source link ──
  if (r.url) {
    resultLink.href         = r.url;
    resultLink.style.display = "inline-block";
  } else {
    resultLink.style.display = "none";
  }

  // ── Validation / error note ──
  if (r.error) {
    errorCard.style.whiteSpace  = "pre-wrap";
    errorCard.textContent       = (r.source === "Validation" ? "💡 " : "⚠ ") + r.error;
    errorCard.style.color       = r.source === "Validation" ? "#f59e0b" : "#f87171";
    errorCard.style.borderColor = r.source === "Validation" ? "rgba(245,158,11,0.3)" : "rgba(239,68,68,0.3)";
    errorCard.style.background  = r.source === "Validation" ? "rgba(245,158,11,0.08)" : "rgba(239,68,68,0.08)";
    errorCard.classList.add("visible");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Render article mode — stacked mini-cards, one per extracted claim
// ─────────────────────────────────────────────────────────────────────────────
function renderArticleResult(data, userQuery) {
  hideAll();
  const container = $("articleResultCard");
  container.innerHTML = "";
  container.classList.add("visible");

  const count = (data.results || []).length;

  // Header
  const header = document.createElement("div");
  header.className = "article-header";
  header.innerHTML =
    `📰 <strong style="color:var(--text)">${count} claim${count !== 1 ? "s" : ""} extracted</strong>` +
    ` <span style="color:var(--muted)">from article</span>`;
  container.appendChild(header);

  if (!data.results || data.results.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--muted);font-size:12px;padding:10px 0";
    empty.textContent = "No verifiable claims could be extracted from this text.";
    container.appendChild(empty);
    return;
  }

  data.results.forEach(r => {
    const rating     = r.rating || "Uncertain";
    const normalized = normalizeRating(rating);
    const conf       = r.confidence != null ? ` · ${Math.round(r.confidence * 100)}%` : "";
    const claim      = (r.claimText || r.checkedText || "").slice(0, 200);

    const card = document.createElement("div");
    card.className = "mini-claim-card";
    card.innerHTML = `
      <div class="mini-verdict-row">
        <span class="verdict-badge verdict-${normalized}" style="font-size:11px;padding:4px 10px">
          ${ratingEmoji(normalized)} ${rating}
        </span>
        <span class="source-tag" style="font-size:9px">${r.source || "AI"}${conf}</span>
      </div>
      <div class="mini-claim-text">&ldquo;${claim}&rdquo;</div>
      <div class="mini-publisher">${r.publisher || "\u2014"}</div>
      ${r.url ? `<a href="${r.url}" target="_blank" class="result-link" style="margin-top:6px;font-size:10px">&rarr; View source &nearr;</a>` : ""}
    `;
    container.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Tokenise text into meaningful lowercase words (strips stop words)
// BUG 10 FIX: Removed duplicate "been" entries (appeared 3×)
const STOP = new Set(["the","a","an","is","are","was","were","in","of","to","and","or","that",
  "this","it","at","by","for","with","on","as","be","been","has","have","had","not","from",
  "will","its","he","she","they","his","her","their","into","about"]);

function tokenize(text) {
  return (text || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
}

function normalizeRating(rating) {
  const r = (rating || "").toLowerCase();
  if (["true", "mostly true", "correct", "accurate", "confirmed"].some(s => r.includes(s))) return "True";
  if (["false", "fake", "incorrect", "wrong", "pants on fire", "no evidence"].some(s => r.includes(s))) return "False";
  if (["mixed", "half", "partially", "misleading", "mostly false", "barely true", "uncertain"].some(s => r.includes(s))) return "Mixed";
  if (r.includes("invalid")) return "Uncertain";
  return "Uncertain";
}

function ratingEmoji(normalized) {
  return { True: "✅", False: "❌", Mixed: "⚠️", Uncertain: "❓" }[normalized] || "❓";
}

function showLoading(msg) {
  hideAll();
  loadingText.textContent = msg;
  loading.classList.add("visible");
}

function showError(msg) {
  hideAll();
  // BUG 7 FIX: Reset inline styles that renderResult() may have applied (e.g. yellow validation styling)
  errorCard.removeAttribute("style");
  errorCard.style.whiteSpace = "pre-wrap";
  errorCard.textContent = "⚠ " + msg;
  errorCard.classList.add("visible");
}

function hideAll() {
  loading.classList.remove("visible");
  errorCard.classList.remove("visible");
  resultCard.classList.remove("visible");
  $("articleResultCard").classList.remove("visible");
}