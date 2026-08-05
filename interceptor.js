// Runs in the page's own JS world (MAIN) at document_start, before the USCIS app
// boots. Wraps fetch + XMLHttpRequest so every case-service call the app makes is
// mirrored out to the extension, with the session credentials it already used.
(() => {
  const TAG = "__USCIS_API_VIEWER__";
  const MATCH = /\/account\/case-service\/api\//i;
  const MAX_BODY = 2000000;

  if (window[TAG]) return; // don't double-wrap on soft navigations
  window[TAG] = true;

  const post = (record) => {
    try {
      window.postMessage({ source: TAG, record }, window.location.origin);
    } catch (_) {
      /* page may have been torn down */
    }
  };

  const abs = (url) => {
    try {
      return new URL(url, window.location.href).href;
    } catch (_) {
      return String(url);
    }
  };

  const headersToObj = (h) => {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === "function") h.forEach((v, k) => (out[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
      else Object.assign(out, h);
    } catch (_) {
      /* ignore malformed header bags */
    }
    return out;
  };

  const clip = (text) =>
    typeof text === "string" && text.length > MAX_BODY
      ? text.slice(0, MAX_BODY) + "\n\n/* …truncated by USCIS Case Viewer */"
      : text;

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      let url, method, reqHeaders, reqBody;
      try {
        const isRequest = typeof Request !== "undefined" && input instanceof Request;
        url = abs(isRequest ? input.url : input);
        method = ((init && init.method) || (isRequest && input.method) || "GET").toUpperCase();
        reqHeaders = Object.assign(
          isRequest ? headersToObj(input.headers) : {},
          headersToObj(init && init.headers)
        );
        reqBody = init && typeof init.body === "string" ? clip(init.body) : undefined;
      } catch (_) {
        return origFetch.apply(this, arguments);
      }

      if (!MATCH.test(url)) return origFetch.apply(this, arguments);

      const started = Date.now();
      return origFetch.apply(this, arguments).then(
        (res) => {
          try {
            res
              .clone()
              .text()
              .then((body) =>
                post({
                  via: "fetch",
                  url,
                  method,
                  status: res.status,
                  statusText: res.statusText,
                  requestHeaders: reqHeaders,
                  requestBody: reqBody,
                  responseHeaders: headersToObj(res.headers),
                  body: clip(body),
                  startedAt: started,
                  durationMs: Date.now() - started,
                })
              )
              .catch(() => {});
          } catch (_) {
            /* body already consumed elsewhere */
          }
          return res;
        },
        (err) => {
          post({
            via: "fetch",
            url,
            method,
            status: 0,
            statusText: "network error",
            requestHeaders: reqHeaders,
            requestBody: reqBody,
            responseHeaders: {},
            body: String((err && err.message) || err),
            startedAt: started,
            durationMs: Date.now() - started,
            error: true,
          });
          throw err;
        }
      );
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this[TAG] = {
        method: String(method || "GET").toUpperCase(),
        url: abs(url),
        headers: {},
      };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      if (this[TAG]) this[TAG].headers[name] = value;
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      const meta = this[TAG];
      if (meta && MATCH.test(meta.url)) {
        const started = Date.now();
        this.addEventListener("loadend", () => {
          let text = "";
          try {
            text = this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : typeof this.response === "string"
                ? this.response
                : JSON.stringify(this.response);
          } catch (_) {
            text = "/* response body not readable as text */";
          }
          const respHeaders = {};
          try {
            (this.getAllResponseHeaders() || "")
              .trim()
              .split(/[\r\n]+/)
              .forEach((line) => {
                const i = line.indexOf(":");
                if (i > 0) respHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
              });
          } catch (_) {
            /* ignore */
          }
          post({
            via: "xhr",
            url: meta.url,
            method: meta.method,
            status: this.status,
            statusText: this.statusText,
            requestHeaders: meta.headers,
            requestBody: typeof body === "string" ? clip(body) : undefined,
            responseHeaders: respHeaders,
            body: clip(text),
            startedAt: started,
            durationMs: Date.now() - started,
            error: this.status === 0,
          });
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
