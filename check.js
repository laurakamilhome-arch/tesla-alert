// check.js — runs on GitHub Actions (Node 20). No installs needed.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID.");
  process.exit(1);
}

function buildUrl() {
  // Tesla used Model 3, Germany-wide, price low->high
  const queryObj = {
    model: "m3",
    condition: "used",
    options: {},
    arrangeby: "plh",       // price low → high
    order: "asc",
    market: "DE",
    language: "de",
    super_region: "eu",
    zip: "10115",           // Berlin zip (broad search)
    range: 0,               // 0 = nationwide
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

const url = buildUrl();

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
  return null;
}

function itemUrl(item) {
  const href = item?.PrcUrl || item?.PermaLink || item?.WebUrl || item?.permalink;
  if (href) return /^https?:/.test(href) ? href : `https://www.tesla.com${href}`;
  const vin = item?.VIN || item?.Vin || item?.vin || "";
  return `https://www.tesla.com/de_DE/inventory/used/m3?arrangeby=plh&range=0#${vin || "result"}`;
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
  await fetch(tgUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });
}

(async () => {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (TeslaFinderBot)",
        "accept": "application/json"
      }
    });
    if (!res.ok) throw new Error(`Tesla API HTTP ${res.status}`);
    const data = await res.json();

    const results = data?.results || data?.Results || [];
    const matches = [];

    for (const item of results) {
      const price = extractPrice(item);
      const rangeKm = extractRangeKm(item);
      if (price == null || rangeKm == null) continue;
      if (price < 29000 && rangeKm > 600) {
        matches.push({ item, price, rangeKm });
      }
    }

    if (matches.length === 0) {
      console.log("No matching vehicles today.");
      return;
    }

    for (const m of matches) {
      await sendTelegram(summarize(m.item, m.price, m.rangeKm));
      await new Promise(r => setTimeout(r, 400));
    }
  } catch (err) {
    console.error("Checker error:", err);
    try { await sendTelegram(`⚠️ Tesla checker failed: ${String(err)}`); } catch {}
    process.exit(1);
  }
})();
