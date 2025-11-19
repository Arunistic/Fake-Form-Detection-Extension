// service_worker.js
// MV3 background worker for Safe Browsing + storing phishing reports

const SAFE_BROWSING_API_KEY = "YOUR_API_KEY_HERE";
const SAFE_BROWSING_ENDPOINT =
  `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${SAFE_BROWSING_API_KEY}`;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24hrs

async function queryGoogleSafeBrowsing(url) {
  try { new URL(url); } catch { return { status: "unknown", error: "invalid_url" }; }

  const payload = {
    client: { clientId: "ffd-extension", clientVersion: "1.0" },
    threatInfo: {
      threatTypes: ["SOCIAL_ENGINEERING", "MALWARE", "UNWANTED_SOFTWARE"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url }]
    }
  };

  try {
    const resp = await fetch(SAFE_BROWSING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      return { status: "unknown", error: `http_${resp.status}` };
    }

    const json = await resp.json().catch(() => null);
    if (json && json.matches && json.matches.length) {
      return { status: "unsafe", matches: json.matches };
    }
    return { status: "safe", matches: [] };
  } catch (e) {
    return { status: "unknown", error: String(e) };
  }
}

// ---- CACHE HELPERS ----
async function readCache(key) {
  const obj = await chrome.storage.local.get(key);
  if (!obj || !obj[key]) return null;

  const entry = obj[key];
  if (Date.now() - entry.ts < CACHE_TTL_MS) return entry;

  await chrome.storage.local.remove(key);
  return null;
}

async function writeCache(key, data) {
  const obj = {}; obj[key] = { ...data, ts: Date.now() };
  await chrome.storage.local.set(obj);
}

// ---- MESSAGE HANDLERS ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "safeBrowseCheck") return false;

  (async () => {
    const url = msg.url;
    const cacheKey = "sb:" + url;

    const cached = await readCache(cacheKey);
    if (cached) return sendResponse({ ...cached, fromCache: true });

    const result = await queryGoogleSafeBrowsing(url);

    if (result.status !== "unknown")
      await writeCache(cacheKey, result);

    sendResponse(result);
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "reportPhish") return false;

  (async () => {
    const prev = (await chrome.storage.local.get("reports")).reports || [];
    prev.push({ ts: Date.now(), payload: msg.payload });
    await chrome.storage.local.set({ reports: prev });
    sendResponse({ ok: true });
  })();

  return true;
});
