// Quick Reply — Marinara Engine port of SillyTavern's built-in Quick Reply
// extension, TEXT-SNIPPET SCOPE ONLY.
//
// The original is ~65% a full STscript IDE (code editor, breakpoints, step
// debugger, ~25 /qr-* slash commands) built on SillyTavern's scripting
// engine. Marinara has no equivalent scripting VM (its own slash-command
// engine is a small fixed set with no extension registration hook), so this
// port keeps only what's genuinely a "button bar of canned messages": sets,
// global/chat/character scoping, nested context menus, auto-execute
// triggers, and a full create/edit UI. See README.md "Known limitations"
// for the full list of what was dropped.
//
// UI departs from the original by design (per porting decision): instead of
// a docked bar of one button per Quick Reply, there is a single dropdown
// trigger; the dropdown IS the context-menu system (nested QRs become
// flyout submenus), not a separate right-click-only feature.
// ── Marinara Engine 2.4 full-page compatibility shim ──────────────────────
// This extension was written for the legacy unsandboxed extension bridge
// (marinara.addElement/addStyle/on/observe/apiFetch/extensionId + a
// {value}-shaped storage). Marinara 2.4 removed that system and replaced it
// with "Personal Extensions". In full-page mode (bundle capabilities include
// "full_page_access") the injected `marinara` object only exposes
// { extension, log, storage{get,patch,clear}, fetch, setTimeout/Interval +
// clears, onCleanup } — but the real page DOM and window.fetch (already
// CSRF-shimmed + cookie-authenticated) are fully available. __mariCompat
// rebuilds the old helper surface on top of the new one, so the IIFE body
// below is unchanged. See NOTES-2.4-personal-extension-migration.md.
function __mariCompat(real) {
  const resolve = (t) => (typeof t === "string" ? document.querySelector(t) : t);
  return {
    log: real.log,
    fetch: real.fetch,
    extension: real.extension,
    extensionId: real.extension && real.extension.id,
    extensionName: real.extension && real.extension.name,
    setTimeout: (fn, ms, ...a) => real.setTimeout(fn, ms, ...a),
    clearTimeout: (id) => real.clearTimeout(id),
    setInterval: (fn, ms, ...a) => real.setInterval(fn, ms, ...a),
    clearInterval: (id) => real.clearInterval(id),
    onCleanup: (fn) => real.onCleanup(fn),
    // Legacy storage returned a { value } envelope; the new API returns the
    // stored object directly. Re-wrap so callers reading res.value still work.
    storage: {
      get: async () => ({ value: await real.storage.get() }),
      patch: async (patch) => ({ value: await real.storage.patch(patch) }),
      delete: () => real.storage.clear(),
    },
    addStyle(css) {
      const el = document.createElement("style");
      el.textContent = css;
      document.head.appendChild(el);
      real.onCleanup(() => el.remove());
      return el;
    },
    addElement(parent, tag, attrs) {
      const host = resolve(parent);
      const el = document.createElement(tag);
      if (attrs) {
        for (const key of Object.keys(attrs)) {
          const val = attrs[key];
          if (key === "innerHTML") el.innerHTML = val;
          else if (key === "textContent") el.textContent = val;
          else if (val != null) el.setAttribute(key, val);
        }
      }
      if (host) host.appendChild(el);
      real.onCleanup(() => el.remove());
      return el;
    },
    on(target, event, handler, options) {
      const node = resolve(target);
      if (!node) return () => {};
      const wrapped = (ev) => {
        try {
          return handler(ev);
        } catch (err) {
          real.log.error("event handler error", err);
        }
      };
      node.addEventListener(event, wrapped, options);
      const off = () => node.removeEventListener(event, wrapped, options);
      real.onCleanup(off);
      return off;
    },
    observe(target, callback, options) {
      const node = resolve(target);
      if (!node) return { disconnect() {} };
      const observer = new MutationObserver(callback);
      observer.observe(node, options || { childList: true, subtree: true });
      real.onCleanup(() => observer.disconnect());
      return observer;
    },
    async apiFetch(path, options) {
      const opts = { credentials: "same-origin", ...(options || {}) };
      opts.headers = { ...((options && options.headers) || {}) };
      if (opts.body != null && typeof opts.body !== "string") {
        opts.body = JSON.stringify(opts.body);
        if (!opts.headers["Content-Type"] && !opts.headers["content-type"]) {
          opts.headers["Content-Type"] = "application/json";
        }
      }
      const url = "/api/" + String(path).replace(/^\/+/, "");
      const res = await real.fetch(url, opts);
      if (!res.ok) throw new Error("apiFetch " + url + " failed: " + res.status);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return res.json();
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

(function (marinara) {
  "use strict";

  const NS = "qr";
  const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  const LOCAL_STORAGE_KEY = NS + "-" + (marinara.extensionId || "quick-reply");

  // ──────────────────────────────────────────────
  // Data model
  // ──────────────────────────────────────────────
  function genId(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function makeQuickReply(overrides) {
    return Object.assign(
      {
        id: genId("qri"),
        icon: "",
        label: "New Reply",
        showLabel: true,
        title: "",
        message: "",
        contextList: [], // [{ setId, isChained }]
        isHidden: false,
        executeOnStartup: false,
        executeOnChatChange: false,
        executeOnUser: false,
        executeOnAi: false,
        preventAutoExecute: true,
      },
      overrides,
    );
  }

  function makeSet(overrides) {
    return Object.assign(
      {
        id: genId("qrs"),
        name: "New Set",
        qrList: [],
        disableSend: false,
        injectInput: false,
        placeBeforeInput: false,
        color: "",
      },
      overrides,
    );
  }

  function defaultData() {
    return {
      settings: { enabled: true, isCombined: false },
      sets: {},
      globalSetIds: [],
      chatSetIds: {},
      characterSetIds: {},
    };
  }

  // ──────────────────────────────────────────────
  // Storage: marinara.storage, falling back to localStorage
  // ──────────────────────────────────────────────
  async function loadData() {
    if (marinara.storage && typeof marinara.storage.get === "function") {
      try {
        const res = await marinara.storage.get();
        const saved = res && res.value && res.value.data;
        if (saved && typeof saved === "object") return normalizeData(saved);
      } catch (e) {
        // fall through to localStorage
      }
    }
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) return normalizeData(JSON.parse(raw));
    } catch (e) {
      // ignore malformed/unavailable localStorage
    }
    return defaultData();
  }

  function normalizeData(saved) {
    const base = defaultData();
    return {
      settings: Object.assign({}, base.settings, saved.settings || {}),
      sets: saved.sets && typeof saved.sets === "object" ? saved.sets : {},
      globalSetIds: Array.isArray(saved.globalSetIds) ? saved.globalSetIds : [],
      chatSetIds: saved.chatSetIds && typeof saved.chatSetIds === "object" ? saved.chatSetIds : {},
      characterSetIds: saved.characterSetIds && typeof saved.characterSetIds === "object" ? saved.characterSetIds : {},
    };
  }

  async function persistData() {
    if (marinara.storage && typeof marinara.storage.patch === "function") {
      try {
        await marinara.storage.patch({ data });
      } catch (e) {
        // fall through to localStorage as a best-effort backup
      }
    }
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // quota exceeded or unavailable — data simply won't persist
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = marinara.setTimeout(persistData, 400);
  }

  let data = defaultData();

  // ──────────────────────────────────────────────
  // Active chat / character
  // ──────────────────────────────────────────────
  function getActiveChatId() {
    try {
      return localStorage.getItem(ACTIVE_CHAT_KEY);
    } catch (e) {
      return null;
    }
  }

  async function getActiveChat() {
    const chatId = getActiveChatId();
    if (!chatId) return null;
    try {
      return await marinara.apiFetch("/chats/" + chatId);
    } catch (e) {
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // Scope resolution: global + chat + character(s), merged
  // ──────────────────────────────────────────────
  async function getActiveSetIds() {
    const ids = [];
    const seen = new Set();
    const push = (id) => {
      if (data.sets[id] && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    data.globalSetIds.forEach(push);

    const chatId = getActiveChatId();
    if (chatId) {
      (data.chatSetIds[chatId] || []).forEach(push);
      const chat = await getActiveChat();
      if (chat && Array.isArray(chat.characterIds)) {
        chat.characterIds.forEach((cid) => {
          (data.characterSetIds[cid] || []).forEach(push);
        });
      }
    }
    return ids;
  }

  // ──────────────────────────────────────────────
  // Execution model
  // ──────────────────────────────────────────────
  function findTextarea() {
    return document.querySelector(".mari-chat-input-textarea");
  }

  function setComposeValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function combineWithInput(message, existing, set) {
    if (!set.injectInput || !existing || !existing.trim()) return message;
    return set.placeBeforeInput ? message + " " + existing : existing + " " + message;
  }

  function dispatchAutoSend(textarea) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
  }

  async function executeQuickReply(qr, set) {
    const textarea = findTextarea();
    if (!textarea) {
      showStatus("Could not find the compose box.", true);
      return;
    }
    const existing = textarea.value;
    const finalMessage = combineWithInput(qr.message, existing, set);
    setComposeValue(textarea, finalMessage);
    textarea.focus();
    if (!set.disableSend) {
      await new Promise((resolve) => marinara.setTimeout(resolve, 30));
      dispatchAutoSend(textarea);
    }
  }

  // ──────────────────────────────────────────────
  // Auto-execute scheduler
  // ──────────────────────────────────────────────
  let autoExecInProgress = false;

  async function collectAutoExecCandidates(triggerField) {
    const setIds = await getActiveSetIds();
    const candidates = [];
    setIds.forEach((setId) => {
      const set = data.sets[setId];
      (set.qrList || []).forEach((qr) => {
        if (qr[triggerField]) candidates.push({ qr, set });
      });
    });
    return candidates;
  }

  async function runAutoExecTrigger(triggerField) {
    if (!data.settings.enabled || autoExecInProgress) return;
    const candidates = await collectAutoExecCandidates(triggerField);
    if (!candidates.length) return;

    autoExecInProgress = true;
    try {
      for (const { qr, set } of candidates) {
        await executeQuickReply(qr, set);
        if (qr.preventAutoExecute) break;
      }
    } finally {
      // Small cooldown so the auto-sent message's own render doesn't
      // immediately re-enter (e.g. executeOnUser firing executeOnAi's watcher).
      marinara.setTimeout(() => {
        autoExecInProgress = false;
      }, 500);
    }
  }

  let seenMessageIds = new Set();
  function reseedSeenMessages() {
    seenMessageIds = new Set(
      Array.from(document.querySelectorAll("[data-message-id]")).map((row) => row.getAttribute("data-message-id")),
    );
  }

  function watchMessages() {
    reseedSeenMessages(); // don't fire for chat history already on screen at load time
    marinara.observe(document.body, () => {
      document.querySelectorAll("[data-message-id]").forEach((row) => {
        const id = row.getAttribute("data-message-id");
        if (seenMessageIds.has(id)) return;
        seenMessageIds.add(id);
        const role = row.getAttribute("data-message-role");
        if (role === "user") runAutoExecTrigger("executeOnUser");
        else if (role === "assistant") runAutoExecTrigger("executeOnAi");
      });
    });
  }

  function watchChatChange() {
    let lastId = getActiveChatId();
    marinara.setInterval(() => {
      const id = getActiveChatId();
      if (id === lastId) return;
      lastId = id;
      // Let the newly-switched chat's messages render before reseeding, so
      // its existing history doesn't spuriously read as "new" afterwards.
      marinara.setTimeout(reseedSeenMessages, 300);
      runAutoExecTrigger("executeOnChatChange");
    }, 1000);
  }

  // ──────────────────────────────────────────────
  // Status pill
  // ──────────────────────────────────────────────
  let statusEl = null;
  function showStatus(text, isError) {
    if (!statusEl) statusEl = marinara.addElement(document.body, "div", { class: "qr-status" });
    statusEl.textContent = text;
    statusEl.classList.toggle("qr-status-error", !!isError);
    statusEl.classList.add("qr-status-visible");
    clearTimeout(showStatus._t);
    showStatus._t = marinara.setTimeout(() => statusEl && statusEl.classList.remove("qr-status-visible"), 3000);
  }

  // ──────────────────────────────────────────────
  // Small DOM helpers
  // ──────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "textContent" || k === "innerHTML") node[k] = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  // ──────────────────────────────────────────────
  // Shared compose-box toolbar
  //
  // A row shared by convention across Marinara extensions, above
  // .mari-chat-input-box instead of inside it, so multiple extensions'
  // buttons don't squeeze the compose textarea on narrow windows. See
  // marinara-extensions/NOTES-compose-box-ui-placement.md. Created with
  // plain DOM (not marinara.addElement) and inline styles (not
  // marinara.addStyle) so it isn't tied to any single extension's own
  // enable/disable lifecycle — whichever extension happens to create it
  // shouldn't take it down (and its styling) when that extension unloads.
  // ──────────────────────────────────────────────
  const EXT_TOOLBAR_ID = "marinara-ext-toolbar";

  function getOrCreateExtToolbar() {
    const inputWrap = document.querySelector(".mari-chat-input");
    if (!inputWrap) return null;
    const box = inputWrap.querySelector(".mari-chat-input-box");
    if (!box) return null; // mobile collapsed composer — nothing to attach to
    let toolbar = document.getElementById(EXT_TOOLBAR_ID);
    if (!toolbar || !inputWrap.contains(toolbar)) {
      toolbar = document.createElement("div");
      toolbar.id = EXT_TOOLBAR_ID;
      toolbar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:0.25rem;margin:0 0 0.375rem;";
      box.insertAdjacentElement("beforebegin", toolbar);
    }
    return toolbar;
  }

  function removeFromExtToolbar() {
    Array.prototype.slice.call(arguments).forEach((elx) => elx && elx.remove());
    const toolbar = document.getElementById(EXT_TOOLBAR_ID);
    if (toolbar && !toolbar.children.length) toolbar.remove();
  }

  // ──────────────────────────────────────────────
  // Styles
  // ──────────────────────────────────────────────
  marinara.addStyle(`
    .qr-status {
      position: fixed; bottom: 1rem; right: 1rem; z-index: 999999;
      background: #1f2937; color: #f9fafb; padding: 0.5rem 0.875rem;
      border-radius: 0.5rem; font: 0.8125rem system-ui, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      opacity: 0; transform: translateY(6px); pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    .qr-status-visible { opacity: 1; transform: translateY(0); }
    .qr-status-error { background: #7f1d1d; }

    .qr-compose-btn, .qr-gear-btn {
      display: flex; align-items: center; justify-content: center;
      width: 2rem; height: 2rem; border-radius: 0.75rem; border: none;
      background: transparent; color: inherit; opacity: 0.55; cursor: pointer;
      flex-shrink: 0; font-size: 1rem; line-height: 1;
    }
    .qr-compose-btn:hover, .qr-gear-btn:hover { opacity: 1; background: rgba(127,127,127,0.15); }

    /* ── Flyout dropdown menu (the primary Quick Reply UI) ── */
    .qr-menu-blocker { position: fixed; inset: 0; z-index: 999990; background: transparent; }
    .qr-menu {
      position: fixed; z-index: 999991; min-width: 12rem; max-width: 20rem;
      max-height: 70vh; overflow-y: auto;
      background: #111827; color: #f3f4f6; border: 1px solid rgba(127,127,127,0.35);
      border-radius: 0.5rem; box-shadow: 0 10px 30px rgba(0,0,0,0.45);
      font: 0.8125rem system-ui, sans-serif; padding: 0.25rem;
    }
    .qr-menu-empty { padding: 0.5rem 0.75rem; opacity: 0.6; }
    .qr-menu-header {
      padding: 0.375rem 0.6rem 0.2rem; margin-top: 0.25rem;
      font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.03em;
      opacity: 0.55; border-left: 3px solid transparent;
    }
    .qr-menu-header:first-child { margin-top: 0; }
    .qr-menu-item {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.35rem 0.6rem; border-radius: 0.375rem; cursor: pointer;
      position: relative;
    }
    .qr-menu-item:hover, .qr-menu-item.qr-menu-item-open { background: rgba(127,127,127,0.15); }
    .qr-menu-item-icon { flex-shrink: 0; width: 1.1rem; text-align: center; }
    .qr-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qr-menu-item-expander { opacity: 0.5; flex-shrink: 0; }
    .qr-menu-item-edit {
      opacity: 0; flex-shrink: 0; background: none; border: none; color: inherit;
      cursor: pointer; padding: 0.1rem 0.25rem; border-radius: 0.25rem;
    }
    .qr-menu-item:hover .qr-menu-item-edit { opacity: 0.6; }
    .qr-menu-item-edit:hover { opacity: 1 !important; background: rgba(127,127,127,0.2); }
    .qr-menu-submenu { position: fixed; z-index: 999992; }

    /* ── Management modal ── */
    .qr-modal-overlay {
      position: fixed; inset: 0; z-index: 999998; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .qr-modal {
      width: min(46rem, 94vw); max-height: 90vh; overflow: auto;
      background: #111827; color: #f3f4f6; border-radius: 0.75rem;
      padding: 1rem 1.25rem 1.25rem; font: 0.875rem system-ui, sans-serif;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .qr-modal h3 { margin: 0 0 0.5rem; font-size: 1rem; }
    .qr-modal h4 { margin: 1rem 0 0.4rem; font-size: 0.8125rem; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.03em; }
    .qr-modal-hint { opacity: 0.6; font-size: 0.75rem; margin: 0 0 0.75rem; }
    .qr-close-btn { float: right; background: none; border: none; color: inherit; opacity: 0.6; cursor: pointer; font-size: 1rem; }
    .qr-close-btn:hover { opacity: 1; }
    .qr-row { margin: 0.5rem 0; display: flex; flex-direction: column; gap: 0.25rem; }
    .qr-row label { font-size: 0.75rem; opacity: 0.75; }
    .qr-row input[type="text"], .qr-row input[type="number"], .qr-row select, .qr-row textarea {
      background: #1f2937; color: #f3f4f6; border: 1px solid rgba(127,127,127,0.35);
      border-radius: 0.375rem; padding: 0.375rem 0.5rem; font: inherit;
    }
    .qr-row textarea { min-height: 3.5rem; resize: vertical; }
    .qr-row-inline { flex-direction: row; align-items: center; justify-content: space-between; }
    .qr-btn {
      padding: 0.35rem 0.75rem; border-radius: 0.375rem; border: 1px solid rgba(127,127,127,0.35);
      background: #1f2937; color: inherit; cursor: pointer; font: inherit; font-size: 0.8125rem;
    }
    .qr-btn:hover { filter: brightness(1.15); }
    .qr-btn-primary { background: #2563eb; border-color: #2563eb; color: white; }
    .qr-btn-danger { background: #7f1d1d; border-color: #7f1d1d; color: white; }
    .qr-btn-icon { padding: 0.3rem 0.45rem; }
    .qr-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }

    .qr-set-list { display: flex; flex-direction: column; gap: 0.4rem; margin: 0.5rem 0 1rem; }
    .qr-set-row {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem;
      border-radius: 0.5rem; border: 1px solid rgba(127,127,127,0.25); border-left-width: 3px;
    }
    .qr-set-row.qr-set-row-active { background: rgba(37,99,235,0.15); border-color: #2563eb; }
    .qr-set-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .qr-set-scopes { display: flex; gap: 0.6rem; font-size: 0.7rem; opacity: 0.85; }
    .qr-set-scopes label { display: flex; align-items: center; gap: 0.2rem; cursor: pointer; }
    .qr-set-scopes input:disabled + span { opacity: 0.4; }

    .qr-editor-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 0.5rem 0; }
    .qr-editor-row { border: 1px solid rgba(127,127,127,0.3); border-radius: 0.5rem; padding: 0.5rem 0.6rem; }
    .qr-editor-row-head { display: flex; align-items: center; gap: 0.4rem; }
    .qr-editor-row-head input[type="text"] { flex: 1; min-width: 0; }
    .qr-editor-icon-input { width: 3rem; text-align: center; }
    .qr-editor-details { margin-top: 0.5rem; display: none; flex-direction: column; gap: 0.5rem; }
    .qr-editor-details.qr-open { display: flex; }
    .qr-editor-flags { display: flex; flex-wrap: wrap; gap: 0.6rem; font-size: 0.75rem; }
    .qr-editor-flags label { display: flex; align-items: center; gap: 0.25rem; }
    .qr-ctxlist-row { display: flex; align-items: center; gap: 0.4rem; }
    .qr-ctxlist-row select { flex: 1; }
  `);

  // ──────────────────────────────────────────────
  // Menu tree building — a QR's contextList becomes a nested flyout
  // submenu; this is the dropdown-as-context-menu design from the plan.
  // ──────────────────────────────────────────────
  function buildQrNode(qr, ancestry) {
    const children = [];
    (qr.contextList || []).forEach((link) => {
      const linkedSet = data.sets[link.setId];
      if (!linkedSet || ancestry.has(link.setId)) return; // guard against cyclic links
      const nextAncestry = new Set(ancestry);
      nextAncestry.add(link.setId);
      children.push({ kind: "header", label: linkedSet.name, color: linkedSet.color });
      (linkedSet.qrList || []).forEach((childQr) => {
        if (!childQr.isHidden) children.push(buildQrNode(childQr, nextAncestry));
      });
    });
    return {
      kind: "item",
      qr,
      label: qr.label || qr.title || "(untitled)",
      icon: qr.icon,
      title: qr.title || qr.message,
      children,
    };
  }

  function buildSetNodes(setId, ancestry) {
    const set = data.sets[setId];
    if (!set) return [];
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(setId);
    return (set.qrList || []).filter((qr) => !qr.isHidden).map((qr) => buildQrNode(qr, nextAncestry));
  }

  async function buildTopLevelMenu() {
    const setIds = await getActiveSetIds();
    const nodes = [];
    if (data.settings.isCombined) {
      setIds.forEach((id) => nodes.push(...buildSetNodes(id, new Set())));
      return nodes;
    }
    setIds.forEach((id) => {
      const set = data.sets[id];
      if (!set || !(set.qrList || []).some((qr) => !qr.isHidden)) return;
      nodes.push({ kind: "header", label: set.name, color: set.color });
      nodes.push(...buildSetNodes(id, new Set()));
    });
    return nodes;
  }

  function findSetOwningQr(qrId) {
    const setIds = Object.keys(data.sets);
    for (const id of setIds) {
      const set = data.sets[id];
      if ((set.qrList || []).some((qr) => qr.id === qrId)) return set;
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Menu rendering (flyout dropdown, click-driven — no hover timers)
  // ──────────────────────────────────────────────
  let menuBlocker = null;
  let menuPanels = [];

  function closeMenu() {
    if (menuBlocker) {
      menuBlocker.remove();
      menuBlocker = null;
    }
    menuPanels.forEach((panel) => panel.remove());
    menuPanels = [];
    document.removeEventListener("keydown", handleMenuKeydown, true);
  }

  function handleMenuKeydown(e) {
    if (e.key === "Escape") closeMenu();
  }

  function positionNear(panel, rect, preferRight) {
    document.body.appendChild(panel);
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = preferRight ? rect.right + 2 : rect.left;
    let top = preferRight ? rect.top : rect.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = preferRight ? Math.max(8, rect.left - pw - 2) : window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  function renderMenuPanel(nodes, onSelect) {
    const panel = el("div", { class: "qr-menu" });
    if (!nodes.length) {
      panel.appendChild(el("div", { class: "qr-menu-empty", textContent: "No quick replies here yet." }));
      return panel;
    }
    nodes.forEach((node) => {
      if (node.kind === "header") {
        const header = el("div", { class: "qr-menu-header", textContent: node.label });
        if (node.color) header.style.borderLeftColor = node.color;
        panel.appendChild(header);
        return;
      }

      const hasChildren = node.children && node.children.length > 0;
      const row = el("div", { class: "qr-menu-item", title: node.title || "" }, [
        el("span", { class: "qr-menu-item-icon", textContent: node.icon || "▸" }),
        el("span", { class: "qr-menu-item-label", textContent: node.label }),
      ]);
      if (hasChildren) row.appendChild(el("span", { class: "qr-menu-item-expander", textContent: "▶" }));

      const editBtn = el("button", { class: "qr-menu-item-edit", type: "button", title: "Edit", textContent: "✏️" });
      editBtn.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        openQrEditorModal(node.qr.id);
      };
      row.appendChild(editBtn);

      if (hasChildren) {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          const submenu = renderMenuPanel(node.children, onSelect);
          submenu.classList.add("qr-menu-submenu");
          positionNear(submenu, row.getBoundingClientRect(), true);
          menuPanels.push(submenu);
          row.classList.add("qr-menu-item-open");
        });
      } else {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          onSelect(node.qr);
        });
      }
      panel.appendChild(row);
    });
    return panel;
  }

  async function openMainMenu(anchorEl) {
    closeMenu();
    if (!data.settings.enabled) {
      showStatus("Quick Reply is disabled — enable it in settings.", true);
      return;
    }
    const nodes = await buildTopLevelMenu();

    menuBlocker = el("div", { class: "qr-menu-blocker" });
    menuBlocker.addEventListener("mousedown", closeMenu);
    document.body.appendChild(menuBlocker);
    document.addEventListener("keydown", handleMenuKeydown, true);

    const panel = renderMenuPanel(nodes, async (qr) => {
      const set = findSetOwningQr(qr.id);
      if (!set) return;
      await executeQuickReply(qr, set);
    });
    positionNear(panel, anchorEl.getBoundingClientRect(), false);
    menuPanels.push(panel);
  }

  // ──────────────────────────────────────────────
  // Import / export (single set, JSON)
  // ──────────────────────────────────────────────
  function exportSet(setId) {
    const set = data.sets[setId];
    if (!set) return;
    const blob = new Blob([JSON.stringify(set, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: (set.name || "quick-reply-set").replace(/[^\w.-]+/g, "_") + ".json" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    marinara.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Imported sets get fresh ids and dropped contextList links (they'd point
  // at set ids from the exporting instance that don't exist here) — a
  // disclosed limitation, see README.
  function importSetFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const qrList = Array.isArray(parsed.qrList)
            ? parsed.qrList.map((qr) => makeQuickReply(Object.assign({}, qr, { id: genId("qri"), contextList: [] })))
            : [];
          resolve(makeSet(Object.assign({}, parsed, { id: genId("qrs"), qrList })));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error || new Error("Could not read the file."));
      reader.readAsText(file);
    });
  }

  // ──────────────────────────────────────────────
  // Management modal
  // ──────────────────────────────────────────────
  let managementOverlay = null;
  let editingSetId = null;
  let expandedQrIds = new Set();

  function persistAndRerender() {
    scheduleSave();
    renderManagementModal();
  }

  function toggleInArray(arr, value, shouldContain) {
    const idx = arr.indexOf(value);
    if (shouldContain && idx === -1) arr.push(value);
    if (!shouldContain && idx !== -1) arr.splice(idx, 1);
  }

  function removeFromAllScopes(setId) {
    toggleInArray(data.globalSetIds, setId, false);
    Object.keys(data.chatSetIds).forEach((cid) => toggleInArray(data.chatSetIds[cid], setId, false));
    Object.keys(data.characterSetIds).forEach((cid) => toggleInArray(data.characterSetIds[cid], setId, false));
  }

  function makeScopeCheckbox(labelText, checked, enabled, onChange) {
    const label = el("label", {}, [el("input", { type: "checkbox" }), el("span", { textContent: labelText })]);
    const input = label.querySelector("input");
    input.checked = checked;
    input.disabled = !enabled;
    input.onchange = (e) => onChange(e.target.checked);
    return label;
  }

  async function openManagementModal() {
    if (managementOverlay) return;
    managementOverlay = el("div", { class: "qr-modal-overlay" });
    document.body.appendChild(managementOverlay);
    managementOverlay.addEventListener("mousedown", (e) => {
      if (e.target === managementOverlay) closeManagementModal();
    });
    marinara.onCleanup(closeManagementModal);
    await renderManagementModal();
  }

  function closeManagementModal() {
    if (managementOverlay) {
      managementOverlay.remove();
      managementOverlay = null;
    }
  }

  function openQrEditorModal(qrId) {
    const set = findSetOwningQr(qrId);
    if (!set) return;
    editingSetId = set.id;
    expandedQrIds.add(qrId);
    openManagementModal();
  }

  async function renderManagementModal() {
    if (!managementOverlay) return;
    const chat = await getActiveChat();
    const chatId = getActiveChatId();
    const characterId = chat && Array.isArray(chat.characterIds) && chat.characterIds.length ? chat.characterIds[0] : null;

    managementOverlay.innerHTML = "";
    const modal = el("div", { class: "qr-modal" });
    managementOverlay.appendChild(modal);

    const closeBtn = el("button", { class: "qr-close-btn", type: "button", textContent: "✕" });
    closeBtn.onclick = closeManagementModal;
    modal.appendChild(closeBtn);
    modal.appendChild(el("h3", { textContent: "Quick Reply" }));

    const enabledRow = el("div", { class: "qr-row qr-row-inline" }, [
      el("label", { textContent: "Enabled" }),
      el("input", { type: "checkbox" }),
    ]);
    enabledRow.querySelector("input").checked = data.settings.enabled;
    enabledRow.querySelector("input").onchange = (e) => {
      data.settings.enabled = e.target.checked;
      persistAndRerender();
    };
    modal.appendChild(enabledRow);

    const combineRow = el("div", { class: "qr-row qr-row-inline" }, [
      el("label", { textContent: "Combine all sets into one list" }),
      el("input", { type: "checkbox" }),
    ]);
    combineRow.querySelector("input").checked = data.settings.isCombined;
    combineRow.querySelector("input").onchange = (e) => {
      data.settings.isCombined = e.target.checked;
      persistAndRerender();
    };
    modal.appendChild(combineRow);

    modal.appendChild(el("h4", { textContent: "Sets" }));
    const setActions = el("div", { class: "qr-actions" });
    const newSetBtn = el("button", { class: "qr-btn qr-btn-primary", type: "button", textContent: "＋ New set" });
    newSetBtn.onclick = () => {
      const set = makeSet({});
      data.sets[set.id] = set;
      editingSetId = set.id;
      persistAndRerender();
    };
    const importInput = el("input", { type: "file", accept: "application/json" });
    importInput.style.display = "none";
    importInput.onchange = async () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = "";
      if (!file) return;
      try {
        const set = await importSetFromFile(file);
        data.sets[set.id] = set;
        editingSetId = set.id;
        persistAndRerender();
        showStatus('Imported "' + set.name + '".');
      } catch (e) {
        showStatus("Import failed: " + (e.message || "invalid file"), true);
      }
    };
    const importBtn = el("button", { class: "qr-btn", type: "button", textContent: "Import…" });
    importBtn.onclick = () => importInput.click();
    setActions.appendChild(newSetBtn);
    setActions.appendChild(importBtn);
    setActions.appendChild(importInput);
    modal.appendChild(setActions);

    const setList = el("div", { class: "qr-set-list" });
    const allSets = Object.values(data.sets).sort((a, b) => a.name.localeCompare(b.name));
    if (!allSets.length) {
      setList.appendChild(el("div", { class: "qr-modal-hint", textContent: "No sets yet — create one to get started." }));
    }
    allSets.forEach((set) => {
      const row = el("div", { class: "qr-set-row" + (set.id === editingSetId ? " qr-set-row-active" : "") });
      if (set.color) row.style.borderLeftColor = set.color;
      const nameEl = el("span", { class: "qr-set-name", textContent: set.name + " (" + (set.qrList || []).length + ")" });
      nameEl.onclick = () => {
        editingSetId = editingSetId === set.id ? null : set.id;
        renderManagementModal();
      };
      row.appendChild(nameEl);

      const scopes = el("div", { class: "qr-set-scopes" });
      scopes.appendChild(
        makeScopeCheckbox("Global", data.globalSetIds.includes(set.id), true, (checked) => {
          toggleInArray(data.globalSetIds, set.id, checked);
          persistAndRerender();
        }),
      );
      scopes.appendChild(
        makeScopeCheckbox("Chat", chatId ? (data.chatSetIds[chatId] || []).includes(set.id) : false, !!chatId, (checked) => {
          if (!chatId) return;
          if (!data.chatSetIds[chatId]) data.chatSetIds[chatId] = [];
          toggleInArray(data.chatSetIds[chatId], set.id, checked);
          persistAndRerender();
        }),
      );
      scopes.appendChild(
        makeScopeCheckbox(
          "Character",
          characterId ? (data.characterSetIds[characterId] || []).includes(set.id) : false,
          !!characterId,
          (checked) => {
            if (!characterId) return;
            if (!data.characterSetIds[characterId]) data.characterSetIds[characterId] = [];
            toggleInArray(data.characterSetIds[characterId], set.id, checked);
            persistAndRerender();
          },
        ),
      );
      row.appendChild(scopes);

      const rowActions = el("div", { class: "qr-actions" });
      const exportBtn = el("button", { class: "qr-btn qr-btn-icon", type: "button", title: "Export", textContent: "⬇" });
      exportBtn.onclick = (e) => {
        e.stopPropagation();
        exportSet(set.id);
      };
      const dupBtn = el("button", { class: "qr-btn qr-btn-icon", type: "button", title: "Duplicate", textContent: "⧉" });
      dupBtn.onclick = (e) => {
        e.stopPropagation();
        const copy = makeSet(
          Object.assign({}, set, {
            id: genId("qrs"),
            name: set.name + " copy",
            qrList: (set.qrList || []).map((qr) => makeQuickReply(Object.assign({}, qr, { id: genId("qri") }))),
          }),
        );
        data.sets[copy.id] = copy;
        persistAndRerender();
      };
      const delBtn = el("button", { class: "qr-btn qr-btn-icon qr-btn-danger", type: "button", title: "Delete", textContent: "🗑" });
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (!window.confirm('Delete set "' + set.name + '"? This cannot be undone.')) return;
        delete data.sets[set.id];
        removeFromAllScopes(set.id);
        if (editingSetId === set.id) editingSetId = null;
        persistAndRerender();
      };
      rowActions.appendChild(exportBtn);
      rowActions.appendChild(dupBtn);
      rowActions.appendChild(delBtn);
      row.appendChild(rowActions);

      setList.appendChild(row);
    });
    modal.appendChild(setList);

    const editingSet = editingSetId ? data.sets[editingSetId] : null;
    if (editingSet) modal.appendChild(renderSetEditor(editingSet));
  }

  function renderSetEditor(set) {
    const wrap = el("div", {});
    wrap.appendChild(el("h4", { textContent: "Editing: " + set.name }));

    const nameRow = el("div", { class: "qr-row" }, [el("label", { textContent: "Set name" })]);
    const nameInput = el("input", { type: "text" });
    nameInput.value = set.name;
    nameInput.oninput = (e) => {
      set.name = e.target.value;
      scheduleSave();
    };
    nameInput.onblur = () => renderManagementModal();
    nameRow.appendChild(nameInput);
    wrap.appendChild(nameRow);

    const flagsRow = el("div", { class: "qr-editor-flags" });
    [
      ["disableSend", "Never auto-send (insert only)"],
      ["injectInput", "Combine with existing input text"],
      ["placeBeforeInput", 'Place before existing text (needs "combine")'],
    ].forEach(([key, labelText]) => {
      const wrapLabel = el("label", {}, [el("input", { type: "checkbox" }), el("span", { textContent: labelText })]);
      const input = wrapLabel.querySelector("input");
      input.checked = !!set[key];
      input.onchange = (e) => {
        set[key] = e.target.checked;
        scheduleSave();
      };
      flagsRow.appendChild(wrapLabel);
    });
    wrap.appendChild(flagsRow);

    const colorRow = el("div", { class: "qr-row" }, [el("label", { textContent: "Accent color" })]);
    const colorInput = el("input", { type: "color" });
    colorInput.value = set.color || "#2563eb";
    colorInput.oninput = (e) => {
      set.color = e.target.value;
      scheduleSave();
    };
    colorRow.appendChild(colorInput);
    wrap.appendChild(colorRow);

    wrap.appendChild(el("h4", { textContent: "Quick replies" }));
    const list = el("div", { class: "qr-editor-list" });
    set.qrList = set.qrList || [];
    set.qrList.forEach((qr, index) => list.appendChild(renderQrEditorRow(set, qr, index)));
    wrap.appendChild(list);

    const addBtn = el("button", { class: "qr-btn qr-btn-primary", type: "button", textContent: "＋ Add quick reply" });
    addBtn.onclick = () => {
      const qr = makeQuickReply({});
      set.qrList.push(qr);
      expandedQrIds.add(qr.id);
      persistAndRerender();
    };
    wrap.appendChild(addBtn);

    return wrap;
  }

  function renderQrEditorRow(set, qr, index) {
    const row = el("div", { class: "qr-editor-row" });
    const head = el("div", { class: "qr-editor-row-head" });

    const iconInput = el("input", { type: "text", class: "qr-editor-icon-input", placeholder: "🙂" });
    iconInput.value = qr.icon || "";
    iconInput.oninput = (e) => {
      qr.icon = e.target.value;
      scheduleSave();
    };
    head.appendChild(iconInput);

    const labelInput = el("input", { type: "text", placeholder: "Label" });
    labelInput.value = qr.label || "";
    labelInput.oninput = (e) => {
      qr.label = e.target.value;
      scheduleSave();
    };
    head.appendChild(labelInput);

    const upBtn = el("button", { class: "qr-btn qr-btn-icon", type: "button", title: "Move up", textContent: "↑" });
    upBtn.disabled = index === 0;
    upBtn.onclick = () => {
      if (index === 0) return;
      const list = set.qrList;
      const tmp = list[index - 1];
      list[index - 1] = list[index];
      list[index] = tmp;
      persistAndRerender();
    };
    const downBtn = el("button", { class: "qr-btn qr-btn-icon", type: "button", title: "Move down", textContent: "↓" });
    downBtn.disabled = index === set.qrList.length - 1;
    downBtn.onclick = () => {
      const list = set.qrList;
      if (index === list.length - 1) return;
      const tmp = list[index + 1];
      list[index + 1] = list[index];
      list[index] = tmp;
      persistAndRerender();
    };
    const expandBtn = el("button", {
      class: "qr-btn qr-btn-icon",
      type: "button",
      title: "Edit details",
      textContent: expandedQrIds.has(qr.id) ? "▾" : "▸",
    });
    expandBtn.onclick = () => {
      if (expandedQrIds.has(qr.id)) expandedQrIds.delete(qr.id);
      else expandedQrIds.add(qr.id);
      renderManagementModal();
    };
    const delBtn = el("button", { class: "qr-btn qr-btn-icon qr-btn-danger", type: "button", title: "Delete", textContent: "🗑" });
    delBtn.onclick = () => {
      if (!window.confirm('Delete quick reply "' + (qr.label || qr.title || "untitled") + '"?')) return;
      set.qrList.splice(index, 1);
      expandedQrIds.delete(qr.id);
      persistAndRerender();
    };
    head.appendChild(upBtn);
    head.appendChild(downBtn);
    head.appendChild(expandBtn);
    head.appendChild(delBtn);
    row.appendChild(head);

    const details = el("div", { class: "qr-editor-details" + (expandedQrIds.has(qr.id) ? " qr-open" : "") });

    const titleRow = el("div", { class: "qr-row" }, [el("label", { textContent: "Tooltip title (optional)" })]);
    const titleInput = el("input", { type: "text" });
    titleInput.value = qr.title || "";
    titleInput.oninput = (e) => {
      qr.title = e.target.value;
      scheduleSave();
    };
    titleRow.appendChild(titleInput);
    details.appendChild(titleRow);

    const msgRow = el("div", { class: "qr-row" }, [el("label", { textContent: "Message" })]);
    const msgArea = el("textarea", { rows: "3" });
    msgArea.value = qr.message || "";
    msgArea.oninput = (e) => {
      qr.message = e.target.value;
      scheduleSave();
    };
    msgRow.appendChild(msgArea);
    details.appendChild(msgRow);

    const flagsRow = el("div", { class: "qr-editor-flags" });
    [
      ["showLabel", "Show label"],
      ["isHidden", "Hide from menu (still reachable via context links)"],
      ["preventAutoExecute", "Don't let this re-trigger other auto-exec replies"],
    ].forEach(([key, labelText]) => {
      const wrapLabel = el("label", {}, [el("input", { type: "checkbox" }), el("span", { textContent: labelText })]);
      const input = wrapLabel.querySelector("input");
      input.checked = !!qr[key];
      input.onchange = (e) => {
        qr[key] = e.target.checked;
        scheduleSave();
      };
      flagsRow.appendChild(wrapLabel);
    });
    details.appendChild(flagsRow);

    details.appendChild(el("label", { textContent: "Auto-execute" }));
    const autoRow = el("div", { class: "qr-editor-flags" });
    [
      ["executeOnStartup", "On startup"],
      ["executeOnChatChange", "On chat change"],
      ["executeOnUser", "After your message"],
      ["executeOnAi", "After AI message"],
    ].forEach(([key, labelText]) => {
      const wrapLabel = el("label", {}, [el("input", { type: "checkbox" }), el("span", { textContent: labelText })]);
      const input = wrapLabel.querySelector("input");
      input.checked = !!qr[key];
      input.onchange = (e) => {
        qr[key] = e.target.checked;
        scheduleSave();
      };
      autoRow.appendChild(wrapLabel);
    });
    details.appendChild(autoRow);

    details.appendChild(el("label", { textContent: "Context menu links (opens as a submenu when this reply is picked)" }));
    const ctxList = el("div", {});
    qr.contextList = qr.contextList || [];
    qr.contextList.forEach((link, linkIndex) => {
      const ctxRow = el("div", { class: "qr-ctxlist-row" });
      const select = el("select");
      select.appendChild(el("option", { value: "", textContent: "Select a set…" }));
      Object.values(data.sets)
        .filter((s) => s.id !== set.id)
        .forEach((s) => {
          const opt = el("option", { value: s.id, textContent: s.name });
          if (s.id === link.setId) opt.setAttribute("selected", "selected");
          select.appendChild(opt);
        });
      select.onchange = (e) => {
        link.setId = e.target.value;
        scheduleSave();
      };
      const removeBtn = el("button", { class: "qr-btn qr-btn-icon", type: "button", title: "Remove", textContent: "✕" });
      removeBtn.onclick = () => {
        qr.contextList.splice(linkIndex, 1);
        persistAndRerender();
      };
      ctxRow.appendChild(select);
      ctxRow.appendChild(removeBtn);
      ctxList.appendChild(ctxRow);
    });
    details.appendChild(ctxList);
    const addLinkBtn = el("button", { class: "qr-btn", type: "button", textContent: "＋ Add linked set" });
    addLinkBtn.onclick = () => {
      qr.contextList.push({ setId: "", isChained: false });
      persistAndRerender();
    };
    details.appendChild(addLinkBtn);

    row.appendChild(details);
    return row;
  }

  // ──────────────────────────────────────────────
  // Compose box buttons
  // ──────────────────────────────────────────────
  function injectComposeButtons() {
    const toolbar = getOrCreateExtToolbar();
    if (!toolbar || toolbar.querySelector(".qr-compose-btn")) return;

    const menuBtn = el("button", { class: "qr-compose-btn", type: "button", title: "Quick Replies", textContent: "💬" });
    toolbar.appendChild(menuBtn);
    marinara.on(menuBtn, "click", (e) => {
      e.stopPropagation();
      openMainMenu(menuBtn);
    });

    const gearBtn = el("button", {
      class: "qr-gear-btn",
      type: "button",
      title: "Quick Reply settings",
      textContent: "⚙",
    });
    toolbar.appendChild(gearBtn);
    marinara.on(gearBtn, "click", openManagementModal);

    marinara.onCleanup(() => removeFromExtToolbar(menuBtn, gearBtn));
  }

  // ──────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────
  async function init() {
    data = await loadData();
    injectComposeButtons();
    watchMessages();
    watchChatChange();
    marinara.observe(document.body, injectComposeButtons);
    runAutoExecTrigger("executeOnStartup");
  }

  init();
})(__mariCompat(marinara));
