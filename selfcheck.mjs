// Self-check gate for build.mjs — assertions on the pure data-model, menu-
// tree-building, and text-combination logic (mirrored here, not imported,
// since extension.js is a browser IIFE that expects a live `marinara`
// bridge object) plus a small drift guard against the checked-in source.
// Run standalone with:
//   node selfcheck.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert";

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
      contextList: [],
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
    { id: genId("qrs"), name: "New Set", qrList: [], disableSend: false, injectInput: false, placeBeforeInput: false, color: "" },
    overrides,
  );
}

function defaultData() {
  return { settings: { enabled: true, isCombined: false }, sets: {}, globalSetIds: [], chatSetIds: {}, characterSetIds: {} };
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

function combineWithInput(message, existing, set) {
  if (!set.injectInput || !existing || !existing.trim()) return message;
  return set.placeBeforeInput ? message + " " + existing : existing + " " + message;
}

function toggleInArray(arr, value, shouldContain) {
  const idx = arr.indexOf(value);
  if (shouldContain && idx === -1) arr.push(value);
  if (!shouldContain && idx !== -1) arr.splice(idx, 1);
}

function removeFromAllScopes(data, setId) {
  toggleInArray(data.globalSetIds, setId, false);
  Object.keys(data.chatSetIds).forEach((cid) => toggleInArray(data.chatSetIds[cid], setId, false));
  Object.keys(data.characterSetIds).forEach((cid) => toggleInArray(data.characterSetIds[cid], setId, false));
}

function buildQrNode(data, qr, ancestry) {
  const children = [];
  (qr.contextList || []).forEach((link) => {
    const linkedSet = data.sets[link.setId];
    if (!linkedSet || ancestry.has(link.setId)) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(link.setId);
    children.push({ kind: "header", label: linkedSet.name });
    (linkedSet.qrList || []).forEach((childQr) => {
      if (!childQr.isHidden) children.push(buildQrNode(data, childQr, nextAncestry));
    });
  });
  return { kind: "item", qr, label: qr.label || qr.title || "(untitled)", children };
}

function buildSetNodes(data, setId, ancestry) {
  const set = data.sets[setId];
  if (!set) return [];
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(setId);
  return (set.qrList || []).filter((qr) => !qr.isHidden).map((qr) => buildQrNode(data, qr, nextAncestry));
}

function buildTopLevelMenu(data, setIds) {
  const nodes = [];
  if (data.settings.isCombined) {
    setIds.forEach((id) => nodes.push(...buildSetNodes(data, id, new Set())));
    return nodes;
  }
  setIds.forEach((id) => {
    const set = data.sets[id];
    if (!set || !(set.qrList || []).some((qr) => !qr.isHidden)) return;
    nodes.push({ kind: "header", label: set.name });
    nodes.push(...buildSetNodes(data, id, new Set()));
  });
  return nodes;
}

function findSetOwningQr(data, qrId) {
  for (const id of Object.keys(data.sets)) {
    if ((data.sets[id].qrList || []).some((qr) => qr.id === qrId)) return data.sets[id];
  }
  return null;
}

// ── combineWithInput ──
{
  const set = makeSet({ injectInput: false });
  assert.equal(combineWithInput("hi", "existing", set), "hi");
}
{
  const set = makeSet({ injectInput: true, placeBeforeInput: false });
  assert.equal(combineWithInput("hi", "existing", set), "existing hi");
}
{
  const set = makeSet({ injectInput: true, placeBeforeInput: true });
  assert.equal(combineWithInput("hi", "existing", set), "hi existing");
}
{
  const set = makeSet({ injectInput: true, placeBeforeInput: true });
  assert.equal(combineWithInput("hi", "  ", set), "hi"); // whitespace-only existing text is ignored
}

// ── toggleInArray: idempotent add/remove ──
{
  const arr = ["a"];
  toggleInArray(arr, "b", true);
  toggleInArray(arr, "b", true);
  assert.deepEqual(arr, ["a", "b"]);
  toggleInArray(arr, "a", false);
  toggleInArray(arr, "a", false);
  assert.deepEqual(arr, ["b"]);
}

// ── removeFromAllScopes ──
{
  const data = defaultData();
  data.globalSetIds = ["s1", "s2"];
  data.chatSetIds = { c1: ["s1"] };
  data.characterSetIds = { char1: ["s1", "s2"] };
  removeFromAllScopes(data, "s1");
  assert.deepEqual(data.globalSetIds, ["s2"]);
  assert.deepEqual(data.chatSetIds.c1, []);
  assert.deepEqual(data.characterSetIds.char1, ["s2"]);
}

// ── normalizeData: fills defaults, tolerates garbage ──
{
  const normalized = normalizeData({ settings: { enabled: false }, sets: "not an object", globalSetIds: null });
  assert.equal(normalized.settings.enabled, false);
  assert.equal(normalized.settings.isCombined, false); // default filled in
  assert.deepEqual(normalized.sets, {});
  assert.deepEqual(normalized.globalSetIds, []);
}

// ── buildTopLevelMenu: grouped mode has set-name headers, hides isHidden QRs ──
{
  const data = defaultData();
  const visible = makeQuickReply({ id: "qr1", label: "Visible" });
  const hidden = makeQuickReply({ id: "qr2", label: "Hidden", isHidden: true });
  const set = makeSet({ id: "s1", name: "My Set", qrList: [visible, hidden] });
  data.sets.s1 = set;
  const nodes = buildTopLevelMenu(data, ["s1"]);
  assert.equal(nodes.length, 2); // header + 1 visible item (hidden excluded)
  assert.equal(nodes[0].kind, "header");
  assert.equal(nodes[0].label, "My Set");
  assert.equal(nodes[1].qr.id, "qr1");
}

// ── buildTopLevelMenu: combined mode flattens, no headers ──
{
  const data = defaultData();
  data.settings.isCombined = true;
  data.sets.s1 = makeSet({ id: "s1", name: "A", qrList: [makeQuickReply({ id: "qr1" })] });
  data.sets.s2 = makeSet({ id: "s2", name: "B", qrList: [makeQuickReply({ id: "qr2" })] });
  const nodes = buildTopLevelMenu(data, ["s1", "s2"]);
  assert.ok(nodes.every((n) => n.kind === "item"));
  assert.equal(nodes.length, 2);
}

// ── buildQrNode: contextList becomes nested children, cyclic links don't infinite-loop ──
{
  const data = defaultData();
  const childQr = makeQuickReply({ id: "child" });
  const setB = makeSet({ id: "setB", name: "Set B", qrList: [childQr] });
  data.sets.setB = setB;
  const parentQr = makeQuickReply({ id: "parent", contextList: [{ setId: "setB", isChained: false }] });
  const node = buildQrNode(data, parentQr, new Set());
  assert.equal(node.children.length, 2); // header + child item
  assert.equal(node.children[1].qr.id, "child");

  // Cyclic: setB links back to a set containing parentQr's own set — must terminate.
  const cyclicChild = makeQuickReply({ id: "cyclic", contextList: [{ setId: "setA", isChained: false }] });
  data.sets.setB.qrList = [cyclicChild];
  data.sets.setA = makeSet({ id: "setA", name: "Set A", qrList: [parentQr] });
  const cyclicNode = buildQrNode(data, parentQr, new Set(["setA"]));
  assert.ok(cyclicNode); // completes without throwing/hanging
}

// ── findSetOwningQr ──
{
  const data = defaultData();
  const qr = makeQuickReply({ id: "target" });
  data.sets.s1 = makeSet({ id: "s1", qrList: [qr] });
  assert.equal(findSetOwningQr(data, "target").id, "s1");
  assert.equal(findSetOwningQr(data, "missing"), null);
}

// ── Drift guard: checked-in source must still expose the functions/behaviors
//    this selfcheck assumes exist. ──
{
  const src = readFileSync(new URL("./extension.js", import.meta.url), "utf8");
  const mustContain = [
    "function makeQuickReply",
    "function makeSet",
    "function combineWithInput",
    "function toggleInArray",
    "function removeFromAllScopes",
    "function buildQrNode",
    "function buildTopLevelMenu",
    "function findSetOwningQr",
    "function runAutoExecTrigger",
    "autoExecInProgress",
    "marinara.storage",
    "function openMainMenu",
    "function openManagementModal",
  ];
  for (const token of mustContain) {
    assert.ok(src.includes(token), `extension.js drift: expected to find "${token}"`);
  }
}

console.log("selfcheck: all assertions passed");
