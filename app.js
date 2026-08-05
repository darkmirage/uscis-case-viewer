// Shared UI for popup.html and viewer.html.
const $ = (id) => document.getElementById(id);
const listEl = $("list");
const countEl = $("count");
const noticeEl = $("notice");
const revealEl = $("reveal");
const casesEl = $("cases");

const F = globalThis.USCISFmt; // shared with the in-page panel, see format.js

let captures = [];
let receipts = [];
let missing = [];
let autoFetchDone = false;
const expanded = new Set();
const activeTab = new Map();

const detailUrl = (r) => `https://my.uscis.gov/account/case-service/api/cases/${r}`;

const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no response" });
    });
  });

const notify = (text, isError) => {
  noticeEl.textContent = text || "";
  noticeEl.style.color = isError ? "var(--err)" : "var(--muted)";
};

const escapeHtml = F.escapeHtml;
const shortPath = F.shortPath;
const timeOf = F.timeOf;
const headerBlock = (headers) => F.headerBlock(headers, revealEl.checked);

const TABS = [
  ["body", "Response"],
  ["respHeaders", "Response headers"],
  ["reqHeaders", "Request headers"],
  ["curl", "cURL"],
];

function tabContent(rec, tab) {
  if (tab === "respHeaders") return escapeHtml(headerBlock(rec.responseHeaders));
  if (tab === "reqHeaders") return escapeHtml(headerBlock(rec.requestHeaders));
  if (tab === "curl") return escapeHtml(F.toCurl(rec, revealEl.checked));
  return F.bodyHtml(rec.body);
}

async function fetchCases(only) {
  const target = only ? [only] : missing;
  if (!target.length) return notify("Nothing new to fetch.");
  notify(`Fetching /cases/${target.length === 1 ? target[0] : `… (${target.length})`}`);

  const res = await send({ type: "fetchCases", receipts: target });
  if (!res.ok) return notify(`Failed: ${res.error}`, true);

  const summary = (res.fetched || []).map((f) => `${f.receipt} → ${f.status || "ERR"}`).join(", ");
  const anyBad = (res.fetched || []).some((f) => !f.status || f.status >= 400);
  notify(summary || "Nothing fetched.", anyBad);
  await load();
}

function renderCases() {
  if (!casesEl) return;
  casesEl.textContent = "";
  if (!receipts.length) return;

  const label = document.createElement("span");
  label.className = "cases-label";
  label.textContent = `${receipts.length} case${receipts.length > 1 ? "s" : ""} detected:`;
  casesEl.appendChild(label);

  for (const r of receipts) {
    const done = captures.find((c) => c.url === detailUrl(r));
    const chip = document.createElement("button");
    chip.className = `chip${done ? (done.status < 400 ? " done" : " bad") : ""}`;
    chip.textContent = done ? `${r} · ${done.status}` : r;
    chip.title = done
      ? "Show the /cases detail response"
      : "Fetch /cases/" + r + " (the page never calls this one)";
    chip.addEventListener("click", async () => {
      if (!done) return fetchCases(r);
      expanded.add(done.id);
      render();
      const el = [...document.querySelectorAll(".entry")].find((e) =>
        e.querySelector(".path").title.endsWith(r)
      );
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    casesEl.appendChild(chip);
  }

  if (missing.length) {
    const all = document.createElement("button");
    all.className = "chip action";
    all.textContent = `Fetch ${missing.length} missing`;
    all.addEventListener("click", () => fetchCases());
    casesEl.appendChild(all);
  }
}

function render() {
  countEl.textContent = captures.length ? `${captures.length} captured` : "";
  listEl.textContent = "";

  if (!captures.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML =
      "Nothing captured yet.<br />Open <b>my.uscis.gov</b>, sign in, and load your case page —<br />" +
      "every <code>case-service/api</code> call will show up here.<br /><br />" +
      "<small>Already had the tab open? Reload it so the hook installs.</small>";
    listEl.appendChild(empty);
    return;
  }

  for (const rec of captures) {
    const entry = document.createElement("div");
    entry.className = "entry";

    const head = document.createElement("div");
    head.className = "entry-head";
    head.innerHTML =
      `<span class="method">${escapeHtml(rec.method || "GET")}</span>` +
      `<span class="status ${rec.status >= 200 && rec.status < 400 ? "ok" : "bad"}">${rec.status || "ERR"}</span>` +
      `<span class="path" title="${escapeHtml(rec.url)}">${escapeHtml(shortPath(rec.url))}</span>` +
      `<span class="meta">${escapeHtml(rec.via)} · ${rec.durationMs ?? "?"}ms · ${escapeHtml(timeOf(rec.startedAt))}</span>`;
    head.addEventListener("click", () => {
      expanded.has(rec.id) ? expanded.delete(rec.id) : expanded.add(rec.id);
      render();
    });
    entry.appendChild(head);

    if (expanded.has(rec.id)) {
      const current = activeTab.get(rec.id) || "body";
      const body = document.createElement("div");
      body.className = "entry-body";

      const tabs = document.createElement("div");
      tabs.className = "tabs";
      for (const [key, label] of TABS) {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("aria-selected", String(key === current));
        b.addEventListener("click", () => {
          activeTab.set(rec.id, key);
          render();
        });
        tabs.appendChild(b);
      }
      body.appendChild(tabs);

      const pre = document.createElement("pre");
      pre.innerHTML = tabContent(rec, current);
      body.appendChild(pre);

      const actions = document.createElement("div");
      actions.className = "row-actions";

      const copy = document.createElement("button");
      copy.textContent = "Copy this view";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(pre.textContent);
        notify("Copied to clipboard.");
      });
      actions.appendChild(copy);

      const replay = document.createElement("button");
      replay.textContent = "Replay request";
      replay.addEventListener("click", async () => {
        notify("Replaying…");
        const res = await send({
          type: "replay",
          request: {
            url: rec.url,
            method: rec.method,
            headers: rec.requestHeaders,
            body: rec.requestBody,
          },
        });
        if (!res.ok) return notify(`Replay failed: ${res.error}`, true);
        notify(`Replayed → ${res.record.status}`);
        await load();
      });
      actions.appendChild(replay);

      body.appendChild(actions);
      entry.appendChild(body);
    }

    listEl.appendChild(entry);
  }
}

async function load() {
  const res = await send({ type: "list" });
  captures = res.ok ? res.list : [];
  receipts = (res.ok && res.receipts) || [];
  missing = (res.ok && res.missing) || [];
  renderCases();
  render();

  // Once per open: pull the /cases/{receipt} detail the page never asks for.
  if (!autoFetchDone && missing.length && captures.length) {
    autoFetchDone = true;
    await fetchCases();
  }
}

// --- toolbar ---------------------------------------------------------------
$("refresh").addEventListener("click", () => {
  notify("");
  load();
});

$("clear").addEventListener("click", async () => {
  await send({ type: "clear" });
  expanded.clear();
  notify("Cleared.");
  load();
});

$("download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(captures, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "uscis-case-api-captures.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

if ($("openTab")) {
  $("openTab").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
    window.close();
  });
}

revealEl.addEventListener("change", render);

$("manualGo").addEventListener("click", async () => {
  const url = $("manualUrl").value.trim();
  if (!/^https:\/\/my\.uscis\.gov\//.test(url)) {
    return notify("URL must be on https://my.uscis.gov/", true);
  }
  // Reuse the auth headers from the most recent real page request, so the
  // manual call carries the same bearer token the app was using.
  const donor = captures.find((c) => c.requestHeaders && c.requestHeaders.Authorization) ||
    captures.find((c) => Object.keys(c.requestHeaders || {}).some((k) => /^authorization$/i.test(k))) ||
    captures[0];

  notify("Requesting…");
  const res = await send({
    type: "replay",
    request: { url, method: "GET", headers: donor ? donor.requestHeaders : { Accept: "application/json" } },
  });
  if (!res.ok) return notify(`Request failed: ${res.error}`, true);
  expanded.clear();
  notify(
    res.record.status === 401 || res.record.status === 403
      ? `${res.record.status} — load a case page in the USCIS tab first so a fresh token gets captured.`
      : `Done → ${res.record.status}`,
    res.record.status >= 400
  );
  await load();
  if (captures[0]) {
    expanded.add(captures[0].id);
    render();
  }
});

load();
