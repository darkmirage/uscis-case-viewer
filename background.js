// Service worker: keeps a rolling buffer of captures, discovers case receipt
// numbers, and fetches the /cases/{receipt} detail endpoint the page never calls.
const KEY = "captures";
const MAX = 200;
const API = "https://my.uscis.gov/account/case-service/api";

// USCIS receipt numbers: 3-letter service-centre prefix + 10 digits.
const PREFIXES = "IOE|LIN|SRC|EAC|WAC|MSC|NBC|YSC|VSC|TSC|CSC|NSC";
const RECEIPT_RE = new RegExp(`\\b(${PREFIXES})\\d{10}\\b`, "g");
// Separate, non-global copy for validating one string: /g makes .test() stateful
// via lastIndex, so sharing the regex silently drops every other match.
const RECEIPT_ONE = new RegExp(`^(${PREFIXES})\\d{10}$`);

// Writes are serialized through this chain so bursts of parallel captures
// can't clobber each other via read-modify-write races.
let queue = Promise.resolve();

const enqueue = (task) => {
  queue = queue.then(task, task);
  return queue;
};

async function readAll() {
  const data = await chrome.storage.session.get(KEY);
  return data[KEY] || [];
}

async function writeAll(list) {
  await chrome.storage.session.set({ [KEY]: list });
  try {
    await chrome.action.setBadgeText({ text: list.length ? String(list.length) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a6dcc" });
  } catch (_) {
    /* badge is cosmetic */
  }
}

async function addCapture(record, tab) {
  const list = await readAll();
  list.unshift({
    id: `${record.startedAt || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: tab ? tab.id : null,
    ...record,
  });
  await writeAll(list.slice(0, MAX));
}

// --- receipt discovery -----------------------------------------------------

const caseDetailUrl = (receipt) => `${API}/cases/${receipt}`;

// Pull receipt numbers out of every captured URL *and* response body, so cases
// the page only mentioned in a list payload still get picked up.
function discover(list) {
  const found = new Set();
  for (const rec of list) {
    for (const src of [rec.url, rec.body]) {
      if (!src) continue;
      const matches = String(src).match(RECEIPT_RE);
      if (matches) matches.forEach((m) => found.add(m));
    }
  }

  const receipts = [...found].sort();
  // A receipt is "fetched" once we hold a capture for its bare detail URL.
  const have = new Set(
    list
      .map((rec) => {
        const m = /\/case-service\/api\/cases\/([A-Z]{3}\d{10})(?:\?|$)/.exec(rec.url || "");
        return m && m[1];
      })
      .filter(Boolean)
  );

  return { receipts, missing: receipts.filter((r) => !have.has(r)) };
}

// Borrow auth from the most recent genuine page request: the CSRF token and
// XHR marker have to match what the app itself sends.
function donorHeaders(list) {
  const donor =
    list.find(
      (c) =>
        (c.via === "fetch" || c.via === "xhr") &&
        Object.keys(c.requestHeaders || {}).some((k) => /^(x-csrf-token|authorization)$/i.test(k))
    ) || list.find((c) => c.via === "fetch" || c.via === "xhr");

  const headers = Object.assign({}, donor ? donor.requestHeaders : null);
  if (!Object.keys(headers).some((k) => /^accept$/i.test(k))) headers.accept = "application/json";
  if (!Object.keys(headers).some((k) => /^x-requested-with$/i.test(k))) {
    headers["x-requested-with"] = "XMLHttpRequest";
  }
  // A stale ETag would earn us a 304 with an empty body.
  for (const k of Object.keys(headers)) if (/^if-none-match$/i.test(k)) delete headers[k];
  return headers;
}

// Headers the browser refuses to let us set; dropping them keeps replay quiet.
const FORBIDDEN = new Set([
  "host",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

async function request({ url, method, headers, body, via }) {
  const clean = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (FORBIDDEN.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) continue;
    clean[k] = v;
  }

  const started = Date.now();
  const res = await fetch(url, {
    method: method || "GET",
    headers: clean,
    body: body || undefined,
    credentials: "include",
    cache: "no-store",
  });
  const text = await res.text();
  const responseHeaders = {};
  res.headers.forEach((v, k) => (responseHeaders[k] = v));

  return {
    via: via || "replay",
    url,
    method: method || "GET",
    status: res.status,
    statusText: res.statusText,
    requestHeaders: clean,
    requestBody: body || undefined,
    responseHeaders,
    body: text,
    startedAt: started,
    durationMs: Date.now() - started,
  };
}

async function fetchCaseDetails(only) {
  const list = await readAll();
  const { missing } = discover(list);
  const targets = (only && only.length ? only : missing).filter((r) => RECEIPT_ONE.test(r));

  if (!targets.length) return { fetched: [], skipped: true };

  const headers = donorHeaders(list);
  const fetched = [];

  // Sequential on purpose — a burst of parallel calls is what bot detection
  // looks for, and there are only ever a handful of cases.
  for (const receipt of targets) {
    try {
      const record = await request({ url: caseDetailUrl(receipt), headers, via: "auto" });
      await enqueue(() => addCapture(record, null));
      fetched.push({ receipt, status: record.status });
    } catch (err) {
      fetched.push({ receipt, status: 0, error: String((err && err.message) || err) });
    }
  }

  return { fetched };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "capture") {
    enqueue(() => addCapture(msg.record, sender.tab));
    return;
  }

  if (msg.type === "list") {
    readAll().then((list) => sendResponse({ ok: true, list, ...discover(list) }));
    return true;
  }

  if (msg.type === "clear") {
    enqueue(() => writeAll([])).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "fetchCases") {
    fetchCaseDetails(msg.receipts)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "replay") {
    request(msg.request)
      .then((record) => enqueue(() => addCapture(record, null)).then(() => record))
      .then((record) => sendResponse({ ok: true, record }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#1a6dcc" });
});
