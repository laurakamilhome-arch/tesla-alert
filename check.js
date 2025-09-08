
// check.js — Tesla Used Model 3 alert (DE) with cookie + browser-like headers
// Runs on GitHub Actions (Node 20, native fetch). No npm installs needed.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID.");
  process.exit(1);
}

// ---- config (you can tweak later) ----
const REFERER_URL = "https://www.tesla.com/de_DE/inventory/used/m3?arrangeby=plh&range=0";
const TARGET_PRICE_EUR = 29000;
const MIN_RANGE_KM = 600;

// Build the Tesla API URL (v4) with DE-wide search, price low→high
function buildApiUrl() {
  const queryObj = {
    model: "m3",
    condition: "used",
    options: {},
    arrangeby: "plh",       // price low→high
    order: "asc",
    market: "DE",
    language: "de",
    super_region: "eu",
    zip: "10115",            // Berlin zip, but range=0 makes it nationwide
    range: 0,
    region: "DE"
  };
  const params = new URLSearchParams();
  params.set("query", JSON.stringify(queryObj));
  params.set("offset", "0");
  params.set("count", "50");
  params.set("outsideSearch", "false");
  params.set("outsideOffset", "0");
  return `https://www.tesla.com/inventory/api/v4/inventory-results?${params.toString()}`;
}

const API_URL = buildApiUrl();

// A realistic desktop Chrome UA helps avoid 403
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Grab cookies from the referer page (some Tesla edges want a cookie)
async function getTeslaCookies() {
  const res = await fetch(REFERER_URL, {
    headers: {
      "user-agent": UA,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      "pragma": "no-cache"
    }
  });

  // Native fetch in Node 20 supports getSetCookie(); fall back to nothing if unavailable.
  let cookies = "";
  try {
    const arr =
      (typeof res.headers.getSetCookie === "function" && res.headers.getSetCookie()) ||
      [];
    cookies = arr.map(c => c.split(";")[0]).join("; ");
  } catch (_) {
    // ignore; not all environments expose Set-Cookie
  }
  return cookies; // may be empty — still okay
}

function numberFrom(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pick(obj, path) {
  return path.reduce((o, k) => (o ? o[k] : undefined), obj);
}

// Try common fields Tesla uses for price/range
function extractPrice(item) {
  const keys = ["PurchasePrice", "Price", "TotalPrice", "TotalPriceAndFees"];
  for (const k of keys) {
    const n = numberFrom(item?.[k]);
    if (typeof n === "number") return n;
  }
  return null;
}

function extractRangeKm(item) {
  const paths = [
    ["Range"],
    ["WLTPRange"],
    ["BatteryRange"],
    ["EUCombinedRange"],
    ["Spec", "Range"],
    ["Spec", "WLTPRange"],
    ["Spec", "EUCombinedRange"],
    ["Spec", "wltp_range"],
    ["Spec", "range"]
  ];
  for (const p of paths) {
    const n = numberFrom(pick(item, p));
    if (typeof n === "number") return n;
  }
  // Fallback: infer by trim text (rough WLTP estimates)
  const trim = (item?.TrimName || item?.Trim || item?.SpecName || "").toLowerCase();
  if (/\b(long\s*range|maximale\s*reichweite|lr)\b/.test(trim)) return 620;
  if (/performance/.test(trim)) return 560;
  if (/\b(standard\s*range|rear[-\s]*wheel|heckantrieb)\b/.test(trim)) return 490;
  return null;
}

function itemUrl(item) {
  const href = item?.PrcUrl || item?.PermaLink || item?.WebUrl || item?.permalink;
  if (href) return /^https?:/.test(href) ? href : `https://www.tesla.com${href}`;
  const vin = item?.VIN || item?.Vin || item?.vin || "";
  return `${REFERER_URL}#${vin || "result"}`;
}

function fmtEUR(n) {
  try {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
  } catch {
    return `${n} €`;
  }
}

function summarize(item, price, rangeKm) {
  const year = item?.Year || item?.year || "";
  const trim = item?.TrimName || item?.Trim || item?.SpecName || "";
  const odom = numberFrom(item?.Odometer ?? item?.Mileage ?? item?.Km);
  const odoTxt = odom ? ` • ${Math.round(odom)} km` : "";
  const line1 = `🚗 ${year ? year + " " : ""}Tesla Model 3 ${trim}`.trim();
  const line2 = `${fmtEUR(price)} • Reichweite ~${Math.round(rangeKm)} km${odoTxt}`;
  return `${line1}\n${line2}\n${itemUrl(item)}`;
}

async function sendTelegram(text) {
  const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(tgUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });
  if (!res.ok) console.error("Telegram send failed:", await res.text());
}

(async () => {
  try {
    const cookie = await getTeslaCookies();

    const res = await fetch(API_URL, {
      headers: {
        "user-agent": UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": REFERER_URL,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        ...(cookie ? { cookie } : {})
      }
    });

    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      await sendTelegram("⚠️ Tesla checker failed: HTTP 403 (blocked). Retrying later.");
      console.error("Tesla API 403. Body snippet:", body.slice(0, 400));
      process.exit(1);
    }
    if (!res.ok) throw new Error(`Tesla API HTTP ${res.status}`);

    const data = await res.json();
    const results = data?.results || data?.Results || [];

    const matches = [];
    for (const item of results) {
      const price = extractPrice(item);
      const rangeKm = extractRangeKm(item);
      if (price == null || rangeKm == null) continue;
      if (price < TARGET_PRICE_EUR && rangeKm > MIN_RANGE_KM) {
        matches.push({ item, price, rangeKm });
      }
    }

    if (matches.length === 0) {
      console.log("No matching vehicles today.");
      return;
    }

    for (const m of matches) {
      await sendTelegram(summarize(m.item, m.price, m.rangeKm));
      await new Promise(r => setTimeout(r, 400)); // polite delay
    }
  } catch (err) {
    console.error("Checker error:", err);
    try { await sendTelegram(`⚠️ Tesla checker failed: ${String(err)}`); } catch {}
    process.exit(1);
  }
})();
