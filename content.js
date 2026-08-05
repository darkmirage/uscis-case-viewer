// Isolated-world bridge: relays captures from the page into the service worker.
(() => {
  const TAG = "__USCIS_API_VIEWER__";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG || !data.record) return;

    try {
      chrome.runtime.sendMessage({ type: "capture", record: data.record }, () => {
        // Swallow "receiving end does not exist" when the worker is respawning.
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // Extension was reloaded/updated; the page keeps working, captures stop
      // until the tab is refreshed.
    }
  });
})();
