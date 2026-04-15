// ─────────────────────────────────────────────────────────────────────────────
//  background.js  –  FactCheck Extension Service Worker
//  Pipeline: Google FactCheck API → DuckDuckGo → ML Model → Wikipedia
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ SECURITY: Never commit a real API key. Move this to a config/env and add it to .gitignore.
const GOOGLE_API_KEY = "AIzaSyCdeQTRmg9ga3l4h68PYZ1SVgi4vjZX_Ys"; // 🔑 Replace with your own key
const GOOGLE_API_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";
const DDG_API_URL = "https://api.duckduckgo.com/";
const WIKI_API_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const ML_API_URL = "http://localhost:8000/predict";

// ── Context menu: right-click selected text ──────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "factcheck-selection",
    title: "FactCheck: \"%s\"",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "factcheck-selection" && info.selectionText) {
    const result = await runPipeline(info.selectionText.trim());
    // Store result and open popup (or notify via content script)
    await chrome.storage.session.set({ lastResult: result, lastQuery: info.selectionText.trim() });
    // Open popup by opening the extension page in a new tab (fallback)
    chrome.action.openPopup().catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  }
});

// ── Message listener from popup.js / content.js ──────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_CLAIM") {
    runPipeline(msg.text)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN PIPELINE  —  routes to article mode or single-claim mode
// ─────────────────────────────────────────────────────────────────────────────
async function runPipeline(text) {
  console.log("[FactCheck] Input received:", text.slice(0, 100));

  const validation = analyzeInput(text);
  if (!validation.valid) {
    return {
      found: false,
      rating: "Invalid Input",
      publisher: "—",
      url: null,
      claimText: text,
      checkedText: text,
      confidence: null,
      source: "Validation",
      error: validation.hint
    };
  }

  // ── Article mode: extract individual claims, check each one ─────────────────
  if (validation.mode === "article") {
    console.log("[FactCheck] 📰 Article Mode — extracting key claims from text...");
    const claims = extractKeyClaimsFromText(text);
    console.log("[FactCheck] Extracted claims:", claims);

    if (claims.length === 0) {
      // Fallback: treat the first sentence as a single claim
      const first = text.split(/[.!?\n]/)[0].trim();
      return runSingleClaimPipeline(first.length > 10 ? first : text.slice(0, 120));
    }

    // Run all extracted claims through the pipeline in parallel
    const settled = await Promise.allSettled(claims.map(c => runSingleClaimPipeline(c)));
    const results = settled
      .filter(r => r.status === "fulfilled")
      .map(r => r.value);

    return { mode: "article", checkedText: text, claimCount: claims.length, results };
  }

  // ── Single claim mode ───────────────────────────────────────────────────────
  return runSingleClaimPipeline(text);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SINGLE CLAIM PIPELINE  —  runs one claim through the full source chain
// ─────────────────────────────────────────────────────────────────────────────
async function runSingleClaimPipeline(text) {
  console.log("[FactCheck] Checking claim:", text.slice(0, 80));

  // Step 1: Google FactCheck (aggregates 100+ fact-checkers incl. Snopes, PolitiFact)
  try {
    const googleResult = await checkGoogle(text);
    if (googleResult) {
      console.log("[FactCheck] ✅ Google API hit");
      return { ...googleResult, checkedText: text };
    } else {
      console.warn("[FactCheck] ⚠️ Google API returned NO matching claims — check API key quota at console.cloud.google.com");
    }
  } catch (e) {
    console.error("[FactCheck] ❌ Google API ERROR:", e.message, "— key may be expired/restricted");
  }

  // Step 2: DuckDuckGo Instant Answer (Wikipedia abstracts — limited coverage)
  console.log("[FactCheck] Trying DuckDuckGo Instant Answer...");
  try {
    const searchResult = await checkDuckDuckGo(text);
    if (searchResult) {
      console.log("[FactCheck] ✅ DuckDuckGo hit");
      return { ...searchResult, checkedText: text };
    } else {
      console.warn("[FactCheck] ⚠️ DuckDuckGo returned nothing");
    }
  } catch (e) {
    console.error("[FactCheck] ❌ DuckDuckGo ERROR:", e.message);
  }

  // Step 3: ML Model
  console.log("[FactCheck] Trying ML model...");
  try {
    const mlResult = await checkML(text);
    return { ...mlResult, checkedText: text };
  } catch (e) {
    console.warn("[FactCheck] ML model failed:", e.message);
  }

  // Step 4: Wikipedia (last resort — context only, no verdict)
  console.log("[FactCheck] Trying Wikipedia as last resort...");
  try {
    const wikiResult = await checkWikipedia(text);
    if (wikiResult) {
      console.log("[FactCheck] ✅ Wikipedia hit");
      return { ...wikiResult, checkedText: text };
    }
  } catch (e) {
    console.warn("[FactCheck] Wikipedia failed:", e.message);
  }

  return {
    found: false,
    rating: "Unavailable",
    publisher: "—",
    url: null,
    claimText: text,
    checkedText: text,
    confidence: null,
    source: "Error",
    error: "All sources unavailable. Is the backend running?"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLAIM EXTRACTOR  —  scores sentences for fact-checkability
// ─────────────────────────────────────────────────────────────────────────────
function extractKeyClaimsFromText(text) {
  // Normalise newlines then split on sentence boundaries
  const raw = text.replace(/\n+/g, " ");
  const sentences = raw.match(/[^.!?]+[.!?]*/g) || [raw];

  const scored = sentences.map(s => {
    const trimmed = s.trim();
    const words = trimmed.split(/\s+/);
    // Skip trivially short, questions, or decorative lines
    if (words.length < 5 || trimmed.length < 25) return { text: trimmed, score: -99 };
    if (trimmed.endsWith("?")) return { text: trimmed, score: -99 };

    let score = 0;

    // Proper nouns (capitalised mid-sentence) — strong signal
    const properNouns = trimmed.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    score += Math.min(properNouns.length, 5) * 2;

    // Numbers / years / percentages — highly verifiable
    const numbers = trimmed.match(/\b\d[\d,.]*\b/g) || [];
    score += Math.min(numbers.length, 4) * 3;

    // Verifiable verbs
    if (/\b(is|was|are|were|has|have|had|said|confirmed|reported|announced|stated|claims?|reveals?|shows?|found|killed|died|born|elected|banned|approved|denied)\b/i.test(trimmed)) score += 2;

    // Attribution phrases (very checkable)
    if (/according to|reported by|as per|statement|claims?/i.test(trimmed)) score += 3;

    // Date patterns
    if (/\b(19|20)\d{2}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(trimmed)) score += 2;

    // Penalise very long sentences (hard to fact-check atomically)
    if (words.length > 40) score -= 2;

    return { text: trimmed, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.text);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 – Google FactCheck Tools API
// ─────────────────────────────────────────────────────────────────────────────
async function checkGoogle(text) {
  const url = `${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}&query=${encodeURIComponent(text)}&languageCode=en`;
  const res = await fetch(url);

  if (!res.ok) throw new Error(`Google API HTTP ${res.status}`);

  const data = await res.json();
  const claims = data.claims;

  if (!claims || claims.length === 0) return null;

  // Relevance check: skip results that don't match the query
  const queryWords = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);

  // Collect all relevant claims, return the best match (highest ratio)
  let bestClaim = null;
  let bestRatio = 0;

  // Lowered threshold: 0.4 → 0.2 so fewer valid claims get filtered out
  const MATCH_THRESHOLD = 0.2;

  for (const claim of claims) {
    const claimLower = (claim.text || "").toLowerCase();
    const matchCount = queryWords.filter(w => claimLower.includes(w)).length;
    const matchRatio = queryWords.length > 0 ? matchCount / queryWords.length : 0;
    console.log(`[FactCheck] Google claim: "${claim.text}" — match: ${(matchRatio * 100).toFixed(0)}% (threshold: ${MATCH_THRESHOLD * 100}%)`);

    if (matchRatio < MATCH_THRESHOLD) continue;

    if (matchRatio > bestRatio) {
      bestRatio = matchRatio;
      const review = claim.claimReview?.[0];
      bestClaim = {
        found: true,
        source: "Google FactCheck",
        claimText: claim.text || text,
        rating: review?.textualRating || "Reviewed",
        publisher: review?.publisher?.name || "Unknown Publisher",
        url: review?.url || null,
        confidence: null
      };
    }
  }

  if (bestClaim) {
    console.log(`[FactCheck] Best Google match ratio: ${(bestRatio * 100).toFixed(0)}%`);
    return bestClaim;
  }

  // Retry with a shorter keyword-only query for harder-to-match claims
  const shortQuery = queryWords.slice(0, 3).join(" ");
  if (shortQuery && shortQuery !== text.toLowerCase()) {
    console.log(`[FactCheck] Google: retrying with shorter query "${shortQuery}"`);
    const url2 = `${GOOGLE_API_URL}?key=${GOOGLE_API_KEY}&query=${encodeURIComponent(shortQuery)}&languageCode=en`;
    try {
      const res2 = await fetch(url2);
      if (res2.ok) {
        const data2 = await res2.json();
        const claims2 = data2.claims || [];
        for (const claim of claims2) {
          const claimLower = (claim.text || "").toLowerCase();
          const matchCount = queryWords.filter(w => claimLower.includes(w)).length;
          const matchRatio = queryWords.length > 0 ? matchCount / queryWords.length : 0;
          console.log(`[FactCheck] Google (short query) claim: "${claim.text}" — match: ${(matchRatio * 100).toFixed(0)}%`);
          if (matchRatio >= MATCH_THRESHOLD) {
            const review = claim.claimReview?.[0];
            return {
              found: true,
              source: "Google FactCheck",
              claimText: claim.text || text,
              rating: review?.textualRating || "Reviewed",
              publisher: review?.publisher?.name || "Unknown Publisher",
              url: review?.url || null,
              confidence: null
            };
          }
        }
      }
    } catch (e2) {
      console.warn("[FactCheck] Google short-query retry failed:", e2.message);
    }
  }

  console.log("[FactCheck] Google results not relevant enough → falling back");
  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 – DuckDuckGo Instant Answer API (free, no key required)
// ─────────────────────────────────────────────────────────────────────────────

// Common verbs and filler to strip when building a search query from a statement
const STRIP_WORDS = new Set([
  "is", "are", "was", "were", "has", "have", "had", "be", "been", "being",
  "will", "would", "could", "should", "may", "might", "shall", "can",
  "did", "does", "do", "shot", "dead", "killed", "died", "born", "lived",
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "from", "by", "with", "not", "no", "its", "their", "his", "her",
  "this", "that", "these", "those", "said", "been", "get", "got", "made",
  "says", "say", "went", "come", "came", "very", "just", "also", "than",
  "more", "most", "some", "any", "all", "both", "each", "few", "many"
]);

// Convert a statement into a clean entity-focused search query
// e.g. "Osama bin laden shot dead in Pakistan" → "Osama bin Laden death Pakistan"
function extractSearchQuery(text) {
  const DEATH_VERBS = ["shot", "killed", "assassinated", "murdered", "executed", "died", "dead", "passed away"];
  const BIRTH_VERBS = ["born", "birthplace", "birth"];
  const FOUNDED_VERBS = ["founded", "created", "established", "started", "built"];
  const LOCATION_PREPS = ["in", "at", "from", "near"];

  const lower = text.toLowerCase();
  const words = text.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

  // Keep words that are: proper nouns (start with capital), numbers, or meaningful topic words
  const kept = words.filter(w => {
    if (w[0] === w[0].toUpperCase() && w.length > 1) return true; // proper noun
    if (/^\d+$/.test(w)) return true;                              // number / year
    if (STRIP_WORDS.has(w.toLowerCase())) return false;
    if (w.length > 5) return true;                                 // longer common words
    return false;
  });

  // Append topic hint based on verb detected in original
  let topicHint = "";
  if (DEATH_VERBS.some(v => lower.includes(v))) topicHint = "death";
  else if (BIRTH_VERBS.some(v => lower.includes(v))) topicHint = "birth";
  else if (FOUNDED_VERBS.some(v => lower.includes(v))) topicHint = "founded history";

  const query = [...new Set([...kept, ...(topicHint ? [topicHint] : [])])].slice(0, 6).join(" ");
  console.log(`[FactCheck] DDG query rewritten: "${text}" → "${query}"`);
  return query || text; // fallback to original if extraction yields nothing
}

async function checkDuckDuckGo(text) {
  const query = extractSearchQuery(text);
  const url = `${DDG_API_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=factcheck_ext`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);

  const data = await res.json();

  const abstract = (data.AbstractText || "").trim();
  const answer = (data.Answer || "").trim();
  const abstractSrc = data.AbstractSource || "DuckDuckGo";
  const abstractURL = data.AbstractURL || null;
  const answerType = data.AnswerType || "";

  console.log(`[FactCheck] DDG abstract (${abstract.length} chars): "${abstract.slice(0, 80)}"`);

  // ── Signal scoring ────────────────────────────────────────────────────────
  const combined = `${abstract} ${answer}`.toLowerCase();
  if (!combined.trim() || combined.length < 30) return null;

  // BUG 9 FIX: Removed duplicate "took place" entry
  const TRUE_SIGNALS = ["confirmed", "did occur", "took place", "was killed", "was shot",
    "is true", "has been verified", "officially", "according to",
    "died in", "was assassinated", "is located", "is the ceo",
    "is the founder", "is the president", "is the prime minister",
    "was found", "has been"];
  const FALSE_SIGNALS = ["false", "hoax", "debunked", "not true", "no evidence",
    "did not", "never happened", "fabricated", "misinformation",
    "misleading", "myth", "was not", "were not", "is not",
    "has not", "have not", "no proof", "unsubstantiated"];
  const MIXED_SIGNALS = ["disputed", "contested", "unclear", "debated",
    "some claim", "allegedly", "reportedly", "unverified",
    "partially", "partly true", "partly false"];

  const trueScore = TRUE_SIGNALS.filter(s => combined.includes(s)).length;
  const falseScore = FALSE_SIGNALS.filter(s => combined.includes(s)).length;
  const mixedScore = MIXED_SIGNALS.filter(s => combined.includes(s)).length;
  const total = trueScore + falseScore + mixedScore;

  console.log(`[FactCheck] DDG signals — T:${trueScore} F:${falseScore} M:${mixedScore}`);

  // ── Cross-check abstract against original claim ───────────────────────────
  // Make sure the abstract is actually about the same topic
  const claimWords = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STRIP_WORDS.has(w));
  const abstractLower = abstract.toLowerCase();
  const topicOverlap = claimWords.filter(w => abstractLower.includes(w)).length;
  const overlapRatio = claimWords.length > 0 ? topicOverlap / claimWords.length : 0;

  console.log(`[FactCheck] DDG topic overlap: ${topicOverlap}/${claimWords.length} (${(overlapRatio * 100).toFixed(0)}%)`);

  // Reject if abstract is completely unrelated to the claim
  if (abstract.length > 0 && overlapRatio < 0.2 && total === 0) {
    console.log("[FactCheck] DDG abstract not relevant to claim — skipping");
    return null;
  }

  // Direct answer (e.g. calculations, definitions)
  if (answer && answerType && overlapRatio > 0.2) {
    return {
      found: true, source: "DuckDuckGo", claimText: answer,
      rating: "Context Found", publisher: "DuckDuckGo Instant Answer",
      url: null, confidence: null,
      ddgMeta: { abstract, trueScore, falseScore, mixedScore, type: "direct_answer" }
    };
  }

  if (abstract.length < 40) return null;

  // Derive rating
  let rating;
  if (total === 0) rating = "Context Found";
  else if (falseScore > trueScore && falseScore > mixedScore) rating = "False";
  else if (trueScore > falseScore && trueScore > mixedScore) rating = "True";
  else rating = "Mixed";

  return {
    found: true, source: "DuckDuckGo",
    claimText: extractBestSentence(abstract, text),
    rating, publisher: abstractSrc, url: abstractURL, confidence: null,
    ddgMeta: { abstract, trueScore, falseScore, mixedScore, type: "abstract" }
  };
}

// Pull the single most relevant sentence from a block of text
function extractBestSentence(text, query) {
  const qWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let best = sentences[0], bestScore = -1;
  for (const s of sentences) {
    const score = qWords.filter(w => s.toLowerCase().includes(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best.trim().slice(0, 250);
}

// Extract readable domain from URL
function extractDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); }
  catch { return url; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 – Wikipedia API (factual grounding)
// ─────────────────────────────────────────────────────────────────────────────
async function checkWikipedia(text) {
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "in", "of", "to", "and", "or", "that", "this", "it", "at", "by", "for", "with", "on", "as", "be", "been", "has", "have", "had", "not", "from", "will", "its", "your", "their", "our", "its", "isn", "don", "doesn", "can", "cant", "wont", "would", "could", "should"]);

  const keywords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));

  // Build progressively shorter search queries
  const queries = [
    keywords.slice(0, 4).join(" "),   // e.g. "blue light phone sleep"
    keywords.slice(0, 2).join(" "),   // e.g. "blue light"
    keywords[0] || ""                 // e.g. "blue"
  ].filter(q => q.length > 2);

  console.log("[FactCheck] Wikipedia keyword queries:", queries);

  for (const query of queries) {
    // Use opensearch — returns titles that directly match the topic
    const openUrl = `${WIKI_SEARCH_URL}?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json&origin=*`;
    const openRes = await fetch(openUrl);
    if (!openRes.ok) continue;

    const [, titles] = await openRes.json(); // opensearch returns [query, titles[], descs[], urls[]]
    console.log("[FactCheck] Wikipedia opensearch titles:", titles);

    if (!titles || titles.length === 0) continue;

    // Try each returned title
    for (const title of titles) {
      const summaryUrl = `${WIKI_API_URL}${encodeURIComponent(title)}`;
      const summaryRes = await fetch(summaryUrl);
      if (!summaryRes.ok) continue;

      const page = await summaryRes.json();
      if (!page.extract || page.type === "disambiguation") continue;
      if (page.extract.length < 100) continue; // skip stub articles

      console.log(`[FactCheck] Wikipedia using: "${page.title}"`);

      return {
        found: true,
        source: "Wikipedia",
        claimText: text,
        rating: "Context Found",
        publisher: "Wikipedia",
        url: page.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        confidence: null,
        wikiSummary: page.extract.slice(0, 300) + (page.extract.length > 300 ? "…" : ""),
        wikiTitle: page.title
      };
    }
  }

  console.log("[FactCheck] Wikipedia: no relevant article found");
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 – Local RoBERTa ML Model (via FastAPI)
// ─────────────────────────────────────────────────────────────────────────────
async function checkML(text) {
  // BUG 3 FIX: Added timeout so a hanging backend doesn't block the Wikipedia fallback
  const res = await fetch(ML_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) throw new Error(`ML API HTTP ${res.status}`);

  const data = await res.json();

  return {
    found: true,
    source: "AI Model (RoBERTa)",
    claimText: text,
    rating: data.prediction,           // "True" | "False" | "Mixed" | "Uncertain"
    confidence: data.confidence,       // 0.0 – 1.0
    probabilities: data.probabilities, // {"False": x, "Mixed": y, "True": z}
    publisher: "RoBERTa (LIAR dataset)",
    url: null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT VALIDATOR  —  classifies input as claim / article / invalid
// ─────────────────────────────────────────────────────────────────────────────
function analyzeInput(text) {
  const wordCount = text.trim().split(/\s+/).length;

  // Too short to be a claim
  if (wordCount < 3) {
    return {
      valid: false,
      reason: "too_short",
      hint: "Please enter a complete claim, headline, or paste an article excerpt to fact-check."
    };
  }

  // Looks like a question — ask them to rephrase
  if (text.trim().endsWith("?")) {
    return {
      valid: false,
      reason: "question",
      hint: "Try rephrasing as a statement.\n\nExample: instead of \"Is TOI the largest newspaper?\"\ntry \"Times of India is the largest English newspaper in the world\""
    };
  }

  // Article / excerpt mode: long text → extract key claims and check each
  if (wordCount > 30) {
    return { valid: true, mode: "article" };
  }

  // Short claim: check directly
  return { valid: true, mode: "claim" };
}