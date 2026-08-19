// ==UserScript==
// @name         RIKU pump.fun chat relay
// @namespace    quantriku
// @version      2.0
// @description  Watches the pump.fun livestream chat on RIKU's coin page and relays NEW messages to RIKU's server so he reacts to them on camera.
// @match        https://pump.fun/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * HOW TO USE
 *  - Easiest: paste this whole file into the browser Console on RIKU's coin page.
 *  - Or install Tampermonkey and add it as a userscript (it auto-runs on pump.fun).
 *
 * On start it marks every message already on screen as seen and IGNORES them.
 * Only messages that arrive AFTER it starts get sent to RIKU.
 *
 * Tuned to pump.fun's real chat markup:
 *   row      = div.flex.items-start
 *   username = a[href^="/profile/"]        (href holds the FULL handle)
 *   text     = span.text-text-primary      (minus the invisible padding span)
 */
(() => {
  const CONFIG = {
    SERVER: "https://quantriku.fun",
    KEY: "REPLACE_WITH_ADMIN_PASSWORD",   // your /admin password
    MAX_LEN: 200,
  };

  if (window.__rikuChatRelay) { console.log("[riku] relay already running — reload the page to restart"); return; }
  window.__rikuChatRelay = true;

  const seenRows = new WeakSet();

  // pull {author, text} out of one message row (div.flex.items-start)
  function extract(row) {
    const link = row.querySelector('a[href^="/profile/"]');
    const textEl = row.querySelector(".text-text-primary");
    if (!link || !textEl) return null;
    // href = /profile/<fullhandle> — better than the truncated display text
    const href = link.getAttribute("href") || "";
    let author = href.split("/").filter(Boolean).pop() || link.textContent.trim() || "viewer";
    // message text, skipping the invisible aria-hidden padding span
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
    const u = `${CONFIG.SERVER}/admin/chat-add?user=${encodeURIComponent(m.author)}&text=${encodeURIComponent(m.text)}&key=${encodeURIComponent(CONFIG.KEY)}`;
    fetch(u).then((r) => r.json()).then((j) => {
      console.log(`[riku] relayed  ${m.author}: ${m.text}` + (j && j.unread != null ? `  (unread ${j.unread})` : ""));
    }).catch((e) => console.warn("[riku] relay failed (check KEY/SERVER):", e.message));
  }

  function handleRow(row) {
    if (!row || seenRows.has(row)) return;
    seenRows.add(row);
    const m = extract(row);
    if (m) relay(m);
  }

  // find message rows inside any newly-added DOM node and process them
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

  // find the chat scroll area; fall back to body if the class ever changes
  function findChat() {
    return (
      document.querySelector("div.flex.flex-grow.flex-col.gap-0") ||
      // fallback: the element that actually holds message rows
      (document.querySelector('a[href^="/profile/"]')?.closest("div.flex.items-start")?.parentElement) ||
      document.body
    );
  }

  let tries = 0;
  const timer = setInterval(() => {
    const container = findChat();
    const rows = container.querySelectorAll('div.flex.items-start');
    if (rows.length || ++tries > 40) {
      clearInterval(timer);
      // ignore everything already on screen
      container.querySelectorAll(".text-text-primary").forEach((t) => {
        const row = t.closest("div.flex.items-start");
        if (row) seenRows.add(row);
      });
      console.log(`[riku] watching pump.fun chat — ${rows.length} existing messages ignored. New ones go to RIKU.`);
      const obs = new MutationObserver((muts) => {
        for (const mu of muts) for (const n of mu.addedNodes) scan(n);
      });
      obs.observe(container, { childList: true, subtree: true });
      window.__rikuChatObs = obs;
    }
  }, 1000);
})();
