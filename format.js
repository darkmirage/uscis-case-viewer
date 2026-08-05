// Shared rendering helpers. Loaded both as a content script (for the in-page
// panel) and as a plain script in popup.html / viewer.html, so the two views
// can't drift apart. Assigned onto globalThis explicitly — top-level `const`
// wouldn't be reliably visible to the other files.
globalThis.USCISFmt = (() => {
  const SENSITIVE = /^(authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|.*-token|.*api-key)$/i;
  const RECEIPT_ANY = /\b(IOE|LIN|SRC|EAC|WAC|MSC|NBC|YSC|VSC|TSC|CSC|NSC)\d{10}\b/;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const mask = (key, value, reveal) => {
    if (reveal || !SENSITIVE.test(key)) return value;
    const v = String(value);
    return v.length <= 16
      ? "•".repeat(v.length)
      : `${v.slice(0, 12)}…${"•".repeat(8)} [${v.length} chars]`;
  };

  const prettyBody = (body) => {
    if (!body) return "(empty body)";
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch (_) {
      return body;
    }
  };

  // Highlight an already-escaped JSON string.
  const highlight = (text) =>
    escapeHtml(text).replace(
      /("(\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?/g,
      (match, str, _c, colon, keyword) => {
        if (str) return `<span class="${colon ? "tok-key" : "tok-str"}">${str}</span>${colon || ""}`;
        if (keyword) return `<span class="tok-${keyword === "null" ? "null" : "bool"}">${match}</span>`;
        return `<span class="tok-num">${match}</span>`;
      }
    );

  // Pretty JSON as highlighted HTML, falling back to escaped plain text.
  const bodyHtml = (body) => {
    const pretty = prettyBody(body);
    return pretty.startsWith("{") || pretty.startsWith("[") ? highlight(pretty) : escapeHtml(pretty);
  };

  const headerBlock = (headers, reveal) => {
    const entries = Object.entries(headers || {});
    if (!entries.length) return "(none)";
    return entries.map(([k, v]) => `${k}: ${mask(k, v, reveal)}`).join("\n");
  };

  const toCurl = (rec, reveal) => {
    const parts = [`curl '${rec.url}'`];
    if (rec.method && rec.method !== "GET") parts.push(`  -X ${rec.method}`);
    for (const [k, v] of Object.entries(rec.requestHeaders || {})) {
      parts.push(`  -H '${k}: ${String(mask(k, v, reveal)).replace(/'/g, "'\\''")}'`);
    }
    if (rec.requestBody) parts.push(`  --data-raw '${rec.requestBody.replace(/'/g, "'\\''")}'`);
    return parts.join(" \\\n");
  };

  const shortPath = (url) => {
    try {
      const u = new URL(url);
      return u.pathname.replace("/account/case-service/api", "…") + u.search;
    } catch (_) {
      return url;
    }
  };

  const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "");

  // Pull a form type ("I-485") out of a detail payload for labelling, tolerating
  // both {data:{…}} and flat shapes.
  const formTypeOf = (body) => {
    try {
      const j = JSON.parse(body);
      const d = j && j.data ? j.data : j;
      return (d && (d.formType || d.formNumber)) || "";
    } catch (_) {
      return "";
    }
  };

  const unwrap = (body) => {
    try {
      const j = JSON.parse(body);
      return j && j.data ? j.data : j;
    } catch (_) {
      return null;
    }
  };

  const daysAgo = (iso) => {
    if (!iso) return "";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const days = Math.round((Date.now() - then) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 0) return `in ${-days}d`;
    return `${days}d ago`;
  };

  // Office names arrive shouting ("NATIONAL BENEFITS CENTER"). Title-case the
  // words but leave short tokens alone so centre codes like NBC or TSC survive.
  const SMALL_WORDS = new Set(["of", "the", "and", "for", "at", "in", "on"]);
  const titleCase = (s) =>
    String(s)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i) => {
        if (SMALL_WORDS.has(w)) return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
        if (w.length <= 3) return w.toUpperCase();
        return w[0].toUpperCase() + w.slice(1);
      })
      .join(" ");

  // case_status is never displayed, but it is the only place two things live:
  //   * the human wording for USCIS's own action codes (currentActionCode /
  //     statusTitle, and historicalCaseStatuses[].actionCode / statusTitle), so
  //     the raw eventCodes in /cases can be labelled without guesswork
  //   * jurisdiction / jurisdictionDescription — the office handling the case,
  //     which /cases does not return at all
  //
  // Labels are keyed per receipt as well as globally: the same code can carry
  // form-specific wording, and a flat map would let one case overwrite another.
  const codeMapFrom = (captures) => {
    const byReceipt = {};
    const byCode = {};
    const offices = {};
    for (const c of captures || []) {
      if (!/\/case_status\//.test(c.url || "")) continue;
      const d = unwrap(c.body);
      if (!d) continue;
      const rn = d.receiptNumber || (String(c.url).match(/case_status\/([A-Z]{3}\d{10})/) || [])[1];
      const put = (code, title) => {
        if (!code || !title) return;
        byCode[code] = title;
        if (rn) (byReceipt[rn] = byReceipt[rn] || {})[code] = title;
      };
      put(d.currentActionCode, d.statusTitle);
      for (const h of d.historicalCaseStatuses || []) put(h.actionCode, h.statusTitle);

      if (rn && (d.jurisdiction || d.jurisdictionDescription)) {
        offices[rn] = {
          code: d.jurisdiction || "",
          name: d.jurisdictionDescription ? titleCase(d.jurisdictionDescription) : "",
          raw: d.jurisdictionDescription || d.jurisdiction || "",
        };
      }
    }
    return {
      byReceipt,
      byCode,
      label: (receipt, code) => (byReceipt[receipt] && byReceipt[receipt][code]) || byCode[code] || "",
      office: (receipt) => offices[receipt] || null,
    };
  };

  const pad = (n, w = 2) => String(n).padStart(w, "0");

  // A value at exactly midnight UTC carries no time information — it's a plain
  // calendar date the API happened to serialise as an instant. Converting one to
  // local time would shove it onto the previous evening, so these are printed as
  // their UTC calendar date and never converted.
  const isDateOnly = (d) =>
    !d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds() && !d.getUTCMilliseconds();

  const tzAbbr = (d) => {
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName");
      return part ? part.value : "";
    } catch (_) {
      return "";
    }
  };

  // Render an instant in the viewer's local timezone, to the millisecond.
  // The raw ISO string is kept on hover everywhere this is used, so the exact
  // value the API returned is never lost.
  const stamp = (iso) => {
    const t = Date.parse(iso);
    if (!iso || Number.isNaN(t)) return "";
    const d = new Date(t);

    if (isDateOnly(d)) {
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }

    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const ms = d.getMilliseconds();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${
      ms ? `.${pad(ms, 3)}` : ""
    }`;
    return `${date} ${time} ${tzAbbr(d)}`.trim();
  };

  // One row per event, newest first — no aggregation. With millisecond stamps
  // the API's double-writes are visible as what they are rather than hidden
  // behind a ×N badge.
  const eventRows = (events) =>
    (events || []).map((e) => {
      const raw = e.eventTimestamp || "";
      const created = e.createdAtTimestamp || e.createdAt || "";
      const day = String(e.eventDateTime || "").slice(0, 10);
      const when = stamp(raw) || day;
      return {
        code: e.eventCode || "?",
        // Precise instant where the data has one, else the date-only field.
        when,
        raw,
        // Local rendering can land on a different calendar day than the API's
        // own eventDateTime — say so rather than quietly showing one of them.
        datedDay: day && raw && when.slice(0, 10) !== day ? day : "",
        // When USCIS actually wrote the record; it backdates some events.
        recorded: created && String(created).slice(0, 10) !== day ? stamp(created) || created : "",
        id: e.eventId || "",
      };
    });

  // Top-level keys the summary renders explicitly. Anything NOT in here is
  // picked up generically below, so a field USCIS adds later still surfaces
  // instead of being silently dropped.
  const CONSUMED = new Set([
    "receiptNumber",
    "submissionDate",
    "submissionTimestamp",
    "formType",
    "formName",
    "updatedAt",
    "updatedAtTimestamp",
    "applicantName",
    "closed",
    "isPremiumProcessed",
    "actionRequired",
    "elisChannelType",
    "concurrentCases",
    "documents",
    "evidenceRequests",
    "notices",
    "events",
    "addendums",
  ]);

  // Booleans that mean something is wrong when true, rather than merely set.
  const ALERT_WHEN_TRUE = new Set(["cmsFailure"]);

  // Condense a /cases/{receipt} payload into the fields worth surfacing.
  const summarize = (body) => {
    const d = unwrap(body);
    if (!d || typeof d !== "object" || !d.receiptNumber) return null;

    // Sweep up everything the explicit fields above don't cover.
    const flags = [];
    const extra = [];
    for (const [key, v] of Object.entries(d)) {
      if (CONSUMED.has(key)) continue;
      if (typeof v === "boolean") {
        flags.push({ key, value: v, alert: v && ALERT_WHEN_TRUE.has(key) });
      } else if (typeof v === "number" || (typeof v === "string" && v !== "")) {
        extra.push({ key, value: String(v) });
      } else if (v && typeof v === "object") {
        const keys = Array.isArray(v) ? v : Object.keys(v);
        if (keys.length) {
          extra.push({
            key,
            value: Array.isArray(v) ? `[${v.length} items]` : `{ ${Object.keys(v).join(", ")} }`,
          });
        }
      }
    }
    // True first, then alphabetical — set flags are the interesting ones.
    flags.sort((a, b) => Number(b.value) - Number(a.value) || a.key.localeCompare(b.key));
    extra.sort((a, b) => a.key.localeCompare(b.key));

    const stamp = (e) => e.eventTimestamp || e.eventDateTime || e.createdAtTimestamp || "";
    const events = (Array.isArray(d.events) ? [...d.events] : []).sort((a, b) =>
      String(stamp(b)).localeCompare(String(stamp(a)))
    );

    return {
      receipt: d.receiptNumber,
      formType: d.formType || "",
      formName: d.formName || "",
      applicant: d.applicantName || "",
      filed: d.submissionDate || "",
      filedStamp: d.submissionTimestamp || "",
      channel: d.elisChannelType || "",
      updated: d.updatedAt || String(d.updatedAtTimestamp || "").slice(0, 10),
      updatedStamp: d.updatedAtTimestamp || "",
      flags,
      extra,
      actionRequired: !!d.actionRequired,
      closed: !!d.closed,
      premium: !!d.isPremiumProcessed,
      notices: Array.isArray(d.notices) ? d.notices : [],
      events,
      counts: {
        documents: (d.documents || []).length,
        evidence: (d.evidenceRequests || []).length,
        concurrent: (d.concurrentCases || []).length,
        addendums: (d.addendums || []).length,
      },
      latest: events[0] || null,
    };
  };

  return {
    SENSITIVE,
    RECEIPT_ANY,
    unwrap,
    daysAgo,
    stamp,
    titleCase,
    codeMapFrom,
    eventRows,
    summarize,
    escapeHtml,
    mask,
    prettyBody,
    highlight,
    bodyHtml,
    headerBlock,
    toCurl,
    shortPath,
    timeOf,
    formTypeOf,
  };
})();
