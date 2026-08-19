// ==UserScript==
// @name         RIKU pump.fun chat relay
// @namespace    quantriku
// @version      1.0
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
 * On start it snapshots whatever chat is already there and IGNORES it. Only
 * messages that arrive AFTER it starts get sent to RIKU.
 *
 * If the author/text split looks wrong in the console log, copy the "SAMPLE HTML"
 * line it prints for the first message and send it to me — I'll tune the selectors.
 */
(() => {
  const CONFIG = {
    SERVER: "https://quantriku.fun",
    KEY: "REPLACE_WITH_ADMIN_PASSWORD",   // your /admin password
    CONTAINER_SELECTOR: "div.flex.flex-grow.flex-col.gap-0", // the chat list you found
    MAX_LEN: 200,                          // trim long messages
  };

  if (window.__rikuChatRelay) { console.log("[riku] relay already running"); return; }
  window.__rikuChatRelay = true;

  const seen = new WeakSet();
  let sampleLogged = 0;

  // Best-effort extraction of {author, text} from one chat-row element.
  function extract(node) {
    if (!(node instanceof HTMLElement)) return null;
    const whole = (node.innerText || node.textContent || "").trim();
    if (!whole) return null;

    // author: a profile link or the first short bold/handle-looking element
    let author = "";
    const link = node.querySelector('a[href*="/profile"], a[href*="/@"], a[href^="/"]');
    if (link && link.innerText.trim()) author = link.innerText.trim();
    if (!author) {
      const bold = node.querySelector('.font-semibold, .font-bold, b, strong');
      if (bold && bold.innerText.trim() && bold.innerText.trim().length <= 24) author = bold.innerText.trim();
    }
    // text: the whole row minus the author token at the start
    let text = whole;
    if (author && text.startsWith(author)) text = text.slice(author.length).replace(/^[:\s]+/, "");
    if (!author) author = "chat";
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

  function handleNode(node) {
    if (seen.has(node)) return;
    seen.add(node);
    const m = extract(node);
    if (!m) return;
    if (sampleLogged < 2) { sampleLogged++; console.log("[riku] SAMPLE HTML >>>", node.outerHTML.slice(0, 400)); }
    relay(m);
  }

  function start(container) {
    // snapshot everything already present -> ignore it
    for (const c of container.children) seen.add(c);
    console.log(`[riku] watching pump.fun chat — ${container.children.length} existing messages ignored. New ones go to RIKU.`);
    const obs = new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) if (n.nodeType === 1) handleNode(n);
    });
    obs.observe(container, { childList: true });
    window.__rikuChatObs = obs;
  }

  // wait for the chat container to exist (SPA renders late)
  let tries = 0;
  const timer = setInterval(() => {
    const container = document.querySelector(CONFIG.CONTAINER_SELECTOR);
    if (container) { clearInterval(timer); start(container); }
    else if (++tries > 60) { clearInterval(timer); console.warn("[riku] chat container not found — is the selector right? open a message, right-click > Inspect, and send me the markup."); }
  }, 1000);
})();
