// In-page results drawer. Lives in the isolated world and renders inside a
// shadow root, so USCIS's stylesheets can't reach it and it can't disturb their
// layout. Docked bottom-right; collapse state persists across page loads.
//
// Shows /cases/{receipt} only — one case at a time, selected by tab.
(() => {
  if (window.top !== window) return; // top frame only — no drawer inside iframes

  const TAG = "__USCIS_API_VIEWER__";
  const HOST_ID = "uscis-case-viewer-host";
  const F = globalThis.USCISFmt;

  if (document.getElementById(HOST_ID)) return;

  let captures = [];
  let receipts = [];
  let missing = [];
  let codes = { label: () => "" };
  let open = true;
  let reveal = false;
  let autoFetchDone = false;
  let busy = false;
  let hoistedApplicant = "";
  let activeCase = "";
  let showRaw = false;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false, error: "no response" });
        });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });

  const detailUrl = (r) => `https://my.uscis.gov/account/case-service/api/cases/${r}`;
  const statusUrl = (r) => `https://my.uscis.gov/account/case-service/api/case_status/${r}`;

  const statusRecord = (receipt) => {
    const url = statusUrl(receipt);
    return captures.find((c) => c.url === url || String(c.url || "").startsWith(`${url}?`));
  };

  const responseValue = (rec) => {
    if (!rec) return null;
    try {
      return JSON.parse(rec.body);
    } catch (_) {
      return rec.body || null;
    }
  };

  // Keep the two independently returned USCIS payloads separate so copied JSON
  // remains faithful to each endpoint while still being useful as one artifact.
  const combinedBody = (detail, status) =>
    JSON.stringify(
      {
        cases: responseValue(detail),
        case_status: responseValue(status),
      },
      null,
      2
    );

  // A successful load needs no announcement — "200" means nothing to a reader
  // who isn't debugging. Only failures get surfaced, in plain language, with the
  // HTTP code left on hover for when it is actually being debugged.
  const problem = (status) => {
    if (status >= 200 && status < 400) return "";
    if (!status) return "Couldn't reach USCIS";
    if (status === 401 || status === 403) return "Signed out — reload the page";
    if (status === 404) return "No details available";
    if (status === 429) return "Too many requests — try again shortly";
    if (status >= 500) return "USCIS server error";
    return "Couldn't load this case";
  };

  // --- shell ---------------------------------------------------------------
  const host = document.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #e6e8ea;
      }
      .pill {
        display: none; align-items: center; gap: 7px;
        padding: 8px 14px; border-radius: 999px; cursor: pointer;
        background: #1a6dcc; color: #fff; border: none;
        font: 600 12px system-ui, sans-serif;
        box-shadow: 0 3px 14px rgba(0,0,0,.35);
      }
      .drawer {
        width: 460px; max-width: calc(100vw - 32px);
        /* Fixed height, not max-height. The drawer is anchored to the bottom of
           the viewport, so sizing it to its content made taller tabs push the
           tab strip upwards — the control you just clicked would move out from
           under the pointer. A constant height pins the tabs and the action
           row; only the scroll area between them changes. */
        height: min(72vh, 560px);
        display: flex; flex-direction: column;
        background: #16181c; border: 1px solid #2e333a; border-radius: 12px;
        box-shadow: 0 8px 34px rgba(0,0,0,.45); overflow: hidden;
        resize: both;
      }
      :host([data-collapsed]) .drawer { display: none; }
      :host([data-collapsed]) .pill { display: inline-flex; }

      .head {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 11px; background: #1e2126;
      }
      .head strong { font-size: 12.5px; }
      .head .sub { font: 11px ui-monospace, Consolas, monospace; color: #949ba5; flex: 1; }
      .icon {
        border: 1px solid #2e333a; background: #16181c; color: #949ba5;
        border-radius: 6px; cursor: pointer; font-size: 12px; padding: 2px 7px;
      }
      .icon:hover { color: #e6e8ea; border-color: #5aa7f5; }

      .tabs {
        display: flex; gap: 2px; padding: 0 9px; background: #1e2126;
        border-bottom: 1px solid #2e333a;
      }
      .tab {
        padding: 6px 11px 5px; cursor: pointer; background: transparent;
        border: 1px solid transparent; border-bottom: none;
        border-radius: 7px 7px 0 0; color: #949ba5;
        font: 11.5px system-ui, sans-serif; position: relative; top: 1px;
      }
      .tab:hover { color: #e6e8ea; }
      .tab.active {
        background: #16181c; border-color: #2e333a; color: #e6e8ea; font-weight: 600;
      }
      .tab.bad { color: #ff7b72; }
      .tab.pending { opacity: .6; font-style: italic; }

      .body { overflow-y: auto; padding: 0 0 10px; flex: 1; min-height: 0; }
      .foot {
        border-top: 1px solid #2e333a; background: #1e2126;
        padding: 8px 11px; flex: none;
      }
      .foot:empty { display: none; }
      .note, .empty { color: #949ba5; font-size: 11.5px; padding: 14px 12px; line-height: 1.7; }

      .case-head {
        display: flex; align-items: baseline; gap: 8px; padding: 9px 11px 0;
      }
      .case-head .rn { font: 600 11.5px ui-monospace, Consolas, monospace; }
      .case-head .st {
        margin-left: auto; font-size: 11px; font-weight: 600;
        padding: 1px 7px; border-radius: 999px; white-space: nowrap;
      }
      .st.bad { color: #ff7b72; background: rgba(255,123,114,.12); }

      .keyfacts {
        display: grid; grid-template-columns: 1fr 1fr; gap: 11px 14px;
        padding: 11px; border-bottom: 1px solid #2e333a; background: #1b1e23;
      }
      .kf { min-width: 0; }
      .kf.wide { grid-column: 1 / -1; }
      .kf .k {
        font: 600 9.5px system-ui, sans-serif; letter-spacing: .07em;
        text-transform: uppercase; color: #6b7480; margin-bottom: 3px;
      }
      .kf .v { font-size: 14px; font-weight: 600; color: #e6e8ea; line-height: 1.25; }
      .kf .v.good { color: #4fc07d; }
      .kf .v.warn { color: #e3b341; }
      .kf .sub {
        font: 10px ui-monospace, Consolas, monospace; color: #949ba5; margin-top: 2px;
        overflow-wrap: anywhere;
      }

      .kv {
        display: grid; grid-template-columns: auto 1fr; gap: 3px 10px;
        margin: 0; padding: 8px 11px; font-size: 11.5px;
      }
      .kv dt { color: #949ba5; font: 10.5px ui-monospace, Consolas, monospace; }
      .kv dd { margin: 0; }
      .kv .dim, .dim { color: #949ba5; }
      .warn { color: #e3b341; } .good { color: #4fc07d; }

      .block { border-top: 1px solid #2e333a; padding: 8px 11px; }
      .block h4 {
        margin: 0 0 5px; font: 600 10px system-ui, sans-serif; color: #949ba5;
        text-transform: uppercase; letter-spacing: .05em;
      }
      .ev { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
      .ev code { font: 11px ui-monospace, Consolas, monospace; color: #e3b341; min-width: 40px; flex: none; }
      .ev .evbody { min-width: 0; }
      .ev .ts { font: 10.5px ui-monospace, Consolas, monospace; color: #949ba5; }
      .ev .lbl { font-size: 11px; color: #c9ced6; }
      .ev .n { font-size: 10px; color: #6b7480; }

      .flags { display: flex; flex-wrap: wrap; gap: 2px 12px; }
      .flag { font: 10.5px ui-monospace, Consolas, monospace; white-space: nowrap; }
      .flag.on { color: #c9ced6; }
      .flag.off { color: #6b7480; }
      .flag.alert { color: #e3b341; font-weight: 600; }

      pre {
        margin: 0; padding: 9px 11px; border-top: 1px solid #2e333a;
        font: 11px/1.5 ui-monospace, Consolas, monospace;
        white-space: pre-wrap; word-break: break-word;
        background: #16181c;
      }
      .tok-key { color: #5aa7f5; } .tok-str { color: #4fc07d; }
      .tok-num { color: #e3b341; } .tok-bool, .tok-null { color: #ff7b72; }
      .row { display: flex; gap: 6px; }
      .row button {
        font: 11px system-ui, sans-serif; padding: 3px 8px; cursor: pointer;
        border: 1px solid #2e333a; border-radius: 5px; background: #1e2126; color: #e6e8ea;
      }
      .row button:hover { border-color: #5aa7f5; }
      .row button.on { border-color: #5aa7f5; color: #5aa7f5; }
    </style>
    <div class="wrap">
      <button class="pill" data-act="expand">Case API <span data-role="pillcount"></span></button>
      <div class="drawer">
        <div class="head">
          <strong>Case API</strong>
          <span class="sub" data-role="sub"></span>
          <button class="icon" data-act="reveal" title="Show auth headers">🔒</button>
          <button class="icon" data-act="refresh" title="Refresh">↻</button>
          <button class="icon" data-act="collapse" title="Collapse">–</button>
        </div>
        <div class="tabs" data-role="tabs"></div>
        <div class="body" data-role="body"></div>
        <div class="foot" data-role="foot"></div>
      </div>
    </div>`;

  const q = (role) => root.querySelector(`[data-role="${role}"]`);

  const attach = () => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  attach();
  // The SPA can swap out large parts of the DOM on navigation; re-attach if we
  // get torn out with it.
  setInterval(attach, 2000);

  // --- building blocks -----------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // The three things people actually check — whether anything is needed from
  // them, how long since the case moved, and which office holds it — get their
  // own block above the detail grid rather than being one row among many.
  function keyFacts(s) {
    const wrap = el("div", "keyfacts");

    // Tone is passed explicitly rather than inferred from the class string —
    // inferring it silently lost the colour as soon as a layout class was added.
    const cell = ({ cls = "", label, value, sub, title, tone = "" }) => {
      const c = el("div", `kf ${cls}`.trim());
      c.appendChild(el("div", "k", label));
      c.appendChild(el("div", `v ${tone}`.trim(), value));
      if (sub) c.appendChild(el("div", "sub", sub));
      if (title) c.title = title;
      return c;
    };

    const extras = [];
    if (s.closed) extras.push("closed");
    if (s.premium) extras.push("premium processing");
    wrap.appendChild(
      cell({
        cls: "wide",
        label: "Status",
        value: s.actionRequired ? "Action required" : "No action needed",
        sub: extras.join(" · "),
        tone: s.actionRequired ? "warn" : "good",
      })
    );

    const office = codes.office(s.receipt);
    const hasOffice = !!(office && (office.name || office.code));

    if (s.updated) {
      const exact = F.stamp(s.updatedStamp) || s.updated;
      const ago = F.daysAgo(s.updatedStamp || s.updated);
      wrap.appendChild(
        cell({
          cls: hasOffice ? "" : "wide",
          label: "Last updated",
          value: ago || exact,
          sub: ago ? exact : "",
          title: s.updatedStamp || "",
        })
      );
    }

    // /cases carries no location; the office comes from case_status, which the
    // page fetches anyway.
    if (hasOffice) {
      wrap.appendChild(
        cell({
          cls: s.updated ? "" : "wide",
          label: "Location",
          value: office.name || office.code,
          sub: office.name && office.code ? office.code : "",
          title: office.raw,
        })
      );
    }

    return wrap;
  }

  function kvBlock(s) {
    const dl = el("dl", "kv");
    const add = (k, node) => {
      dl.appendChild(el("dt", null, k));
      dl.appendChild(typeof node === "string" ? el("dd", null, node) : node);
    };

    // Applicant is hoisted into the header when every case agrees on it.
    if (s.applicant && !hoistedApplicant) add("applicant", s.applicant);
    if (s.formName) add("form", `${s.formType} · ${s.formName}`);
    // Prefer the millisecond-precision *Timestamp fields; stamp() drops the time
    // component when it's midnight UTC, i.e. genuinely a date-only value.
    if (s.filed) {
      const when = F.stamp(s.filedStamp) || s.filed;
      const dd = el("dd", null, `${when}${s.channel ? ` · ${s.channel}` : ""}`);
      if (s.filedStamp) dd.title = s.filedStamp;
      add("filed", dd);
    }

    const c = s.counts;
    const bits = [];
    if (c.documents) bits.push(`${c.documents} docs`);
    if (c.evidence) bits.push(`${c.evidence} RFE`);
    if (c.concurrent) bits.push(`${c.concurrent} concurrent`);
    if (c.addendums) bits.push(`${c.addendums} addendums`);
    add("attached", bits.length ? bits.join(" · ") : el("dd", "dim", "nothing attached"));

    // Any scalar field the explicit rows above don't cover, so nothing in the
    // payload is silently dropped.
    for (const x of s.extra) add(x.key, x.value);

    return dl;
  }

  // Every boolean in the payload, by its raw API name. USCIS doesn't document
  // what these mean and the names are not always self-explanatory, so they're
  // shown verbatim rather than translated into a guess.
  function flagsBlock(s) {
    if (!s.flags.length) return null;
    const b = el("div", "block");
    b.appendChild(el("h4", null, `Flags (${s.flags.filter((f) => f.value).length} set)`));
    const wrap = el("div", "flags");
    for (const f of s.flags) {
      const cls = f.alert ? "flag alert" : f.value ? "flag on" : "flag off";
      wrap.appendChild(el("span", cls, `${f.value ? "✓" : "✗"} ${f.key}`));
    }
    b.appendChild(wrap);
    return b;
  }

  function noticesBlock(s) {
    if (!s.notices.length) return null;
    const b = el("div", "block");
    b.appendChild(el("h4", null, `Notices (${s.notices.length})`));
    for (const n of s.notices) {
      const row = el("div", "ev");
      row.appendChild(el("code", null, "✉"));

      const stack = el("div", "evbody");
      const ts = el("div", "ts", F.stamp(n.generationDate) || "");
      if (n.generationDate) ts.title = n.generationDate;
      if (n.letterId) ts.appendChild(el("span", "n", `  #${n.letterId}`));
      stack.appendChild(ts);

      const lbl = el("div", "lbl", n.actionType || "notice");
      if (n.appointmentDateTime) {
        const appt = el("span", "dim", ` — appt ${F.stamp(n.appointmentDateTime)}`);
        appt.title = n.appointmentDateTime;
        lbl.appendChild(appt);
      }
      stack.appendChild(lbl);

      row.appendChild(stack);
      b.appendChild(row);
    }
    return b;
  }

  function eventsBlock(s) {
    if (!s.events.length) return null;

    const rows = F.eventRows(s.events);
    const b = el("div", "block");
    b.appendChild(el("h4", null, `Events (${rows.length})`));

    for (const g of rows) {
      const row = el("div", "ev");
      row.appendChild(el("code", null, g.code));

      const stack = el("div", "evbody");
      const ts = el("div", "ts", g.when);
      if (g.datedDay) ts.appendChild(el("span", "n", `  dated ${g.datedDay}`));
      if (g.recorded) ts.appendChild(el("span", "n", `  recorded ${g.recorded}`));
      // Raw UTC value plus the id, so the source instant is always recoverable.
      ts.title = [g.raw, g.id && `eventId ${g.id}`].filter(Boolean).join("\n");
      stack.appendChild(ts);

      const text = codes.label(s.receipt, g.code);
      stack.appendChild(el("div", text ? "lbl" : "lbl dim", text || "(no label available)"));

      row.appendChild(stack);
      b.appendChild(row);
    }
    return b;
  }

  // --- rendering -----------------------------------------------------------
  function render() {
    host.toggleAttribute("data-collapsed", !open);
    codes = F.codeMapFrom(captures);

    const cases = receipts.map((r) => {
      const rec = captures.find((c) => c.url === detailUrl(r));
      return { r, rec, statusRec: statusRecord(r), s: rec ? F.summarize(rec.body) : null };
    });

    // Every case belongs to the same person in the common case; showing the name
    // once beats repeating it on every tab.
    const names = [...new Set(cases.map((x) => x.s && x.s.applicant).filter(Boolean))];
    hoistedApplicant = names.length === 1 ? names[0] : "";

    const plural = `${receipts.length} case${receipts.length === 1 ? "" : "s"}`;
    q("sub").textContent = hoistedApplicant ? `${hoistedApplicant} · ${plural}` : plural;
    q("pillcount").textContent = receipts.length ? `· ${receipts.length}` : "";

    if (!activeCase || !receipts.includes(activeCase)) activeCase = receipts[0] || "";

    // tabs
    const tabs = q("tabs");
    tabs.textContent = "";
    for (const { r, rec, s } of cases) {
      const label = (s && s.formType) || (rec ? `…${r.slice(-4)}` : `…${r.slice(-4)}`);
      const cls =
        "tab" +
        (r === activeCase ? " active" : "") +
        (rec && rec.status >= 400 ? " bad" : "") +
        (!rec ? " pending" : "");
      const b = el("button", cls, label);
      const issue = rec ? problem(rec.status) : "";
      b.title = !rec ? `${r} — not loaded yet` : issue ? `${r} — ${issue}` : r;
      b.addEventListener("click", () => {
        activeCase = r;
        showRaw = false;
        render();
        if (!rec) fetchCases([r]);
      });
      tabs.appendChild(b);
    }

    // body — one case only
    const body = q("body");
    const foot = q("foot");
    body.textContent = "";
    foot.textContent = ""; // .foot:empty collapses, so early returns need no guard

    if (!captures.length) {
      body.appendChild(el("div", "empty", "Waiting for case-service traffic… open or reload a case page."));
      return;
    }
    if (!receipts.length) {
      body.appendChild(el("div", "empty", "No case receipt numbers found in the captured traffic yet."));
      return;
    }

    const current = cases.find((x) => x.r === activeCase);
    if (!current || !current.rec) {
      body.appendChild(el("div", "note", `Fetching /cases/${activeCase}…`));
      return;
    }

    const { r, rec, statusRec, s } = current;
    const rawResponses = combinedBody(rec, statusRec);

    const chead = el("div", "case-head");
    chead.appendChild(el("span", "rn", r));
    const issue = problem(rec.status);
    if (issue) {
      const note = el("span", "st bad", issue);
      note.title = `HTTP ${rec.status}${rec.statusText ? ` ${rec.statusText}` : ""}`;
      chead.appendChild(note);
    }
    body.appendChild(chead);

    if (s) {
      body.appendChild(keyFacts(s));
      body.appendChild(kvBlock(s));
      const n = noticesBlock(s);
      if (n) body.appendChild(n);
      const e = eventsBlock(s);
      if (e) body.appendChild(e);
      const f = flagsBlock(s);
      if (f) body.appendChild(f);
    }

    const row = el("div", "row");
    const copy = el("button", null, "Copy JSON");
    copy.title = "Copy the /cases and /case_status responses";
    copy.addEventListener("click", () => navigator.clipboard.writeText(rawResponses));
    const rawBtn = el("button", showRaw === "json" ? "on" : null, "Raw JSON");
    rawBtn.title = "Show the /cases and /case_status responses";
    rawBtn.addEventListener("click", () => {
      showRaw = showRaw === "json" ? false : "json";
      render();
    });
    const hdrBtn = el("button", showRaw === "headers" ? "on" : null, "Headers");
    hdrBtn.addEventListener("click", () => {
      showRaw = showRaw === "headers" ? false : "headers";
      render();
    });
    const again = el("button", null, "Re-fetch");
    again.addEventListener("click", () => fetchCases([r], true));
    row.append(copy, rawBtn, hdrBtn, again);
    foot.appendChild(row); // pinned outside the scroll area, so it never moves

    // Raw views are opt-in and replace each other, so the drawer never grows
    // unbounded.
    if (showRaw === "json" || !s) {
      const pre = el("pre");
      pre.innerHTML = F.bodyHtml(rawResponses);
      body.appendChild(pre);
    } else if (showRaw === "headers") {
      const pre = el("pre");
      pre.textContent = `— request —\n${F.headerBlock(rec.requestHeaders, reveal)}\n\n— response —\n${F.headerBlock(
        rec.responseHeaders,
        reveal
      )}`;
      body.appendChild(pre);
    }
    // /documents is deliberately never rendered. case_status is included in the
    // raw/copy bundle and also supplies event labels and the office above.
  }

  // --- data ----------------------------------------------------------------
  async function load() {
    const res = await send({ type: "list" });
    if (!res.ok) return;
    captures = res.list || [];
    receipts = res.receipts || [];
    missing = res.missing || [];
    render();

    if (!autoFetchDone && missing.length && captures.length) {
      autoFetchDone = true;
      await fetchCases();
    }
  }

  async function fetchCases(only, force) {
    if (busy) return;
    busy = true;
    if (force && only && only.length) activeCase = only[0];
    await send({ type: "fetchCases", receipts: only || missing });
    busy = false;
    const res = await send({ type: "list" });
    if (res.ok) {
      captures = res.list || [];
      receipts = res.receipts || [];
      missing = res.missing || [];
      render();
    }
  }

  // --- events --------------------------------------------------------------
  root.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const which = act.dataset.act;
    if (which === "collapse" || which === "expand") {
      open = which === "expand";
      chrome.storage.local.set({ panelOpen: open });
      render();
    } else if (which === "refresh") {
      autoFetchDone = false;
      load();
    } else if (which === "reveal") {
      reveal = !reveal;
      act.textContent = reveal ? "🔓" : "🔒";
      render();
    }
  });

  // New capture from the page → refresh, debounced so a burst settles first.
  let timer = null;
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== TAG) return;
    clearTimeout(timer);
    timer = setTimeout(load, 700);
  });

  chrome.storage.local.get("panelOpen", (v) => {
    if (v && typeof v.panelOpen === "boolean") open = v.panelOpen;
    load();
  });
})();
