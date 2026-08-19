// ==UserScript==
// @name         RIKU pump.fun chat relay
// @namespace    quantriku
// @version      3.0
// @description  Watches the pump.fun livestream chat on RIKU's coin page and relays NEW messages to RIKU's server so he reacts to them on camera.
// @match        https://pump.fun/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      quantriku.fun
// ==/UserScript==

/*
 * MUST be installed as a TAMPERMONKEY userscript — NOT pasted in the console.
 * pump.fun's Content Security Policy blocks page-context fetches to other
 * domains, so a console paste can't reach RIKU. Tampermonkey's GM_xmlhttpRequest
 * bypasses that (it runs in the extension, outside the page CSP).
 *
 * SETUP:
 *  1. Install the Tampermonkey extension.
 *  2. Tampermonkey → Create a new script → paste this whole file → save.
 *  3. Set KEY below to your /admin password.
 *  4. Open RIKU's pump.fun coin page. It auto-runs (see the console log).
 *
 * It ignores whatever chat is already on screen and relays only NEW messages.
 * Tuned to pump.fun markup: row=div.flex.items-start, user=a[href^="/profile/"],
 * text=span.text-text-primary (minus the invisible padding span).
 */
(() => {
  const CONFIG = {
    SERVER: "https://quantriku.fun",
    KEY: "riku12quant",   // your /admin password
    MAX_LEN: 200,
  };

  if (window.__rikuChatRelay) { console.log("[riku] relay already running — reload the page to restart"); return; }
  window.__rikuChatRelay = true;

  // CSP-proof sender: Tampermonkey's GM_xmlhttpRequest (v4 = GM.xmlHttpRequest)
  const gmSend =
    (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
    (typeof GM !== "undefined" && GM.xmlHttpRequest) ||
    null;
  if (!gmSend) {
    console.warn("[riku] NOT running under Tampermonkey — pump.fun's CSP will block the relay. Install this as a Tampermonkey userscript (see the header comment).");
  }

  const seenRows = new WeakSet();

  function extract(row) {
    const link = row.querySelector('a[href^="/profile/"]');
    const textEl = row.querySelector(".text-text-primary");
    if (!link || !textEl) return null;
    const href = link.getAttribute("href") || "";
    let author = href.split("/").filter(Boolean).pop() || link.textContent.trim() || "viewer";
    let text = "";
    textEl.childNodes.forEach((n) => {
      if (n.nodeType === 1 && n.getAttribute && n.getAttribute("aria-hidden") === "true") return;
      text += n.textContent || "";
    });
    text = text.replace(/\s+/g, " ").trim().slice(0, CONFIG.MAX_LEN);
    if (!text) return null;
    return { author: author.slice(0, 24), text };
  }

  function relay(m) {
    const url = `${CONFIG.SERVER}/admin/chat-add?user=${encodeURIComponent(m.author)}&text=${encodeURIComponent(m.text)}&key=${encodeURIComponent(CONFIG.KEY)}`;
    const ok = () => console.log(`[riku] relayed  ${m.author}: ${m.text}`);
    const fail = (e) => console.warn("[riku] relay failed:", e && e.error ? e.error : e);
    if (gmSend) {
      gmSend({ method: "GET", url, onload: ok, onerror: fail, ontimeout: fail });
    } else {
      // last resort (will be CSP-blocked on pump.fun) — proves capture works
      fetch(url).then(ok).catch(() => console.warn("[riku] fetch blocked by pump.fun CSP — install as a Tampermonkey userscript"));
    }
  }

  function handleRow(row) {
    if (!row || seenRows.has(row)) return;
    seenRows.add(row);
    const m = extract(row);
    if (m) relay(m);
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches("div.flex.items-start") && node.querySelector('a[href^="/profile/"]')) handleRow(node);
    if (node.querySelectorAll) {
      node.querySelectorAll(".text-text-primary").forEach((t) => {
        const row = t.closest("div.flex.items-start");
        if (row) handleRow(row);
      });
    }
  }

  function findChat() {
    return (
      document.querySelector("div.flex.flex-grow.flex-col.gap-0") ||
      document.querySelector('a[href^="/profile/"]')?.closest("div.flex.items-start")?.parentElement ||
      document.body
    );
  }

  let tries = 0;
  const timer = setInterval(() => {
    const container = findChat();
    const rows = container.querySelectorAll("div.flex.items-start");
    if (rows.length || ++tries > 40) {
      clearInterval(timer);
      container.querySelectorAll(".text-text-primary").forEach((t) => {
        const row = t.closest("div.flex.items-start");
        if (row) seenRows.add(row);
      });
      console.log(`[riku] watching pump.fun chat — ${rows.length} existing messages ignored. New ones go to RIKU.` + (gmSend ? "" : "  (⚠ no Tampermonkey — relay will be CSP-blocked)"));
      const obs = new MutationObserver((muts) => {
        for (const mu of muts) for (const n of mu.addedNodes) scan(n);
      });
      obs.observe(container, { childList: true, subtree: true });
      window.__rikuChatObs = obs;
    }
  }, 1000);
})();
