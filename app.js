// Shark Survey — single-page PWA
// One snorkel/dive survey = shared metadata + N shark observations.
// Persists drafts to localStorage; syncs completed surveys to a Google Apps
// Script web app that writes one row per shark to a single Sheet tab.

/* =========================================================================
 *  REFERENCE DATA
 * ========================================================================= */

const DURATION_HOURS = [0, 1, 2, 3, 4, 5];
const DURATION_MINUTES = Array.from({ length: 60 }, (_, i) => i);

// Order matters — drives the on-screen pill layout (3 cols × 2 rows):
//   row 1: NN, JV, AU
//   row 2: AM, AF, AFP
const LIFE_STAGE_OPTIONS = [
  { code: "NN", label: "Neonate" },
  { code: "JV", label: "Juvenile" },
  { code: "AU", label: "Adult Unidentified" },
  { code: "AM", label: "Adult Male" },
  { code: "AF", label: "Adult Female" },
  { code: "AFP", label: "Adult Female Pregnant" },
];

// Order matters — drives the on-screen pill layout (2 cols × 4 rows):
//   C1 C2 / C3 C4 / F1 F2 / H1 H2
const BEHAVIOUR_OPTIONS = [
  { code: "C1", label: "Cruising Solo" },
  { code: "C2", label: "Cruising Group No Leader" },
  { code: "C3", label: "Cruising Group With Leader" },
  { code: "C4", label: "Cruising Group As Leader" },
  { code: "F1", label: "Feeding Solo" },
  { code: "F2", label: "Feeding Group" },
  { code: "H1", label: "Hunting Solo" },
  { code: "H2", label: "Hunting Group" },
];

// Seeded shark survey sites. Surveyors can add device-local custom sites
// via the picker's "+ Add new site" affordance. The Site input is validated
// against this list (plus customs) — typing a name that isn't in the list
// is rejected on blur and at submit time. The only way to enter a new
// value is via "+ Add new site".
const DEFAULT_DIVE_SITES = [
  "Aow Leuk",
  "Chalok Bay",
  "Freedom Beach",
  "Hin Wong Bay",
  "June Juea",
  "Sai Daeng",
  "Sai Nuan (Banana Rock)",
  "Sai Thong (Leo Beach)",
  "Shark Bay",
  "Tanote Bay",
  "Tao Tong",
];

// Site Area — same predefined list as the EMP Uploader's "Location Within".
// Fixed list (not user-extensible) — surveyors pick from a dropdown.
const SITE_AREA_OPTIONS = [
  "Main Site",
  "Artificial Reef",
  "Pinnacle",
  "Reef",
  "North Wall",
  "East Wall",
  "South Wall",
  "West Wall",
  "Sand Patch",
];

// Tourist headcount buckets — rough estimate of how busy the site was.
const TOURISTS_OPTIONS = [
  "Under 25",
  "25-50",
  "50-100",
  "100-150",
  "150+",
];

/* =========================================================================
 *  STORAGE KEYS
 * ========================================================================= */

const LS_DRAFT = "shk:draft";
const LS_QUEUE = "shk:queue";
const LS_SETTINGS = "shk:settings";
const LS_CUSTOM_SITES = "shk:customDiveSites";

// Baked-in Apps Script Web App endpoint for the BTC team's shared master
// Shark Survey Sheet. New devices pick this up automatically — teammates
// just open the URL and start submitting. To override on a specific device,
// set a different URL in Settings (⚙). Clearing the field disables sync.
const DEFAULT_SYNC_URL = "https://script.google.com/macros/s/AKfycbxesh3nQ6yk2xNmLYGs4h6vrueiNWnOk32DEwVzakchMGEIHGFAdRRC7rikz-M2J_DY/exec";

// Shared secret token sent in every submission payload. The Apps Script
// checks this value at the top of doPost and rejects requests without a
// match. Stops drive-by scrapers. Not strong security — visible to anyone
// who reads app.js — but a good speed-bump.
//
// To rotate: generate a new token, update this constant AND the SYNC_SECRET
// constant in apps-script.gs, redeploy the Apps Script, bump CACHE_VERSION.
const SYNC_SECRET = "a8c2f140-9b3e-4d7a-8e16-2c5f9a3b1e4d-shark1";

/* =========================================================================
 *  STATE
 * ========================================================================= */

const state = {
  draft: null,
  queue: [],
  settings: { syncUrl: "", autoSync: true },
  current: "setup",
  expandedShark: null, // id of the shark card currently expanded
};

function newDraft() {
  return {
    id: cryptoId(),
    createdAt: new Date().toISOString(),
    metadata: {
      surveyLeader: "",
      uploadedBy: "",
      numberOfSurveyors: "",
      date: "",
      site: "",
      siteArea: "",
      surveyStartTime: "",
      surveyDuration: "",
      numberOfLargeBoatsAtSite: "",
      numberOfSmallBoatsAtSite: "",
      numberOfTouristsAtSite: "",
      otherSpecies: "",
    },
    sharks: [],
    submitted: false,
  };
}

function newShark() {
  return {
    id: cryptoId(),
    timeSeen: "",
    depthObserved: "",
    approxSize: "",
    lifeStage: "",
    behaviourCode: "",
    markings: "",
    comment: "",
  };
}

function cryptoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* =========================================================================
 *  PERSISTENCE
 * ========================================================================= */

function saveDraft() {
  if (state.draft) localStorage.setItem(LS_DRAFT, JSON.stringify(state.draft));
}
function loadDraft() {
  const raw = localStorage.getItem(LS_DRAFT);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d.sharks) d.sharks = [];
    if (!d.metadata) d.metadata = {};
    if (typeof d.submitted !== "boolean") d.submitted = false;
    return d;
  } catch { return null; }
}
function clearDraft() {
  localStorage.removeItem(LS_DRAFT);
  state.draft = null;
}
function saveQueue() { localStorage.setItem(LS_QUEUE, JSON.stringify(state.queue)); }
function loadQueue() {
  const raw = localStorage.getItem(LS_QUEUE);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
function loadCustomSites() {
  try { return JSON.parse(localStorage.getItem(LS_CUSTOM_SITES) || "[]"); }
  catch { return []; }
}
function saveCustomSites(list) {
  localStorage.setItem(LS_CUSTOM_SITES, JSON.stringify(list));
}
function getAllDiveSites() {
  const seen = new Set();
  const out = [];
  [...DEFAULT_DIVE_SITES, ...loadCustomSites()].forEach((s) => {
    const trimmed = (s || "").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  });
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
function addCustomSite(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const all = getAllDiveSites().map((s) => s.toLowerCase());
  if (all.includes(trimmed.toLowerCase())) return false;
  const custom = loadCustomSites();
  custom.push(trimmed);
  saveCustomSites(custom);
  return true;
}


function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); }
function loadSettings() {
  const defaults = { syncUrl: DEFAULT_SYNC_URL, autoSync: true };
  const raw = localStorage.getItem(LS_SETTINGS);
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; }
  catch { return defaults; }
}

/* =========================================================================
 *  ROUTING / RENDER
 * ========================================================================= */

const $app = () => document.getElementById("app");

function renderTpl(id) {
  const tpl = document.getElementById(id);
  const node = tpl.content.firstElementChild.cloneNode(true);
  $app().innerHTML = "";
  $app().appendChild(node);
  return node;
}

function go(screen) {
  state.current = screen;
  document.querySelectorAll("#survey-tabs .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.screen === screen);
  });
  const tabs = document.getElementById("survey-tabs");
  tabs.classList.toggle("hidden", screen === "setup");
  if (screen === "setup") renderSetup();
  else if (screen === "info") renderInfo();
  else if (screen === "sharks") renderSharks();
  else if (screen === "review") renderReview();
}

/* =========================================================================
 *  SITE PICKER — strict <select> dropdown + "+ Add new site" affordance.
 *
 *  Surveyors can only enter sites that are in the dropdown. To register a
 *  new site, they must use the explicit "+ Add new site" button: it saves
 *  the new name to device-local storage and inserts it into the dropdown.
 *  Free-text entry is intentionally not supported, to keep the Sheet's
 *  "site" column clean and analysable.
 * ========================================================================= */

function attachDiveSitePicker(select, initialValue) {
  if (!select || select.tagName !== "SELECT") return;

  function rebuildOptions(selectedValue) {
    // Preserve the leading placeholder option from the template and rebuild
    // the data options below it. If the desired value isn't in the canonical
    // list (e.g. a legacy draft from before this update), we re-insert it
    // anyway so the surveyor sees their stored choice rather than a blank.
    const placeholder = select.querySelector('option[value=""]');
    select.innerHTML = "";
    if (placeholder) select.appendChild(placeholder);
    const sites = getAllDiveSites();
    if (selectedValue && !sites.includes(selectedValue)) sites.push(selectedValue);
    sites
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        select.appendChild(opt);
      });
    if (selectedValue) select.value = selectedValue;
  }
  rebuildOptions(initialValue || "");

  // "+ Add new site" affordance sits below the select inside the same label,
  // so it stacks naturally with the form's gap spacing.
  const host = select.closest("label") || select.parentNode;
  const addRow = document.createElement("div");
  addRow.className = "dive-site-add-row";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "dive-site-add";
  addBtn.textContent = "+ Add new site";

  const addForm = document.createElement("div");
  addForm.className = "dive-site-add-form hidden";
  const newInput = document.createElement("input");
  newInput.type = "text";
  newInput.maxLength = 60;
  newInput.placeholder = "New site name";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost";
  cancelBtn.textContent = "Cancel";
  addForm.append(newInput, saveBtn, cancelBtn);

  addBtn.addEventListener("click", () => {
    addBtn.classList.add("hidden");
    addForm.classList.remove("hidden");
    newInput.focus();
  });
  cancelBtn.addEventListener("click", () => {
    addForm.classList.add("hidden");
    addBtn.classList.remove("hidden");
    newInput.value = "";
  });
  function commitNew() {
    const name = newInput.value.trim();
    if (!name) return;
    const added = addCustomSite(name);
    rebuildOptions(name);
    // Fire both events: 'input' for the Info screen's persist() listener,
    // 'change' for any future code listening for canonical change events.
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    if (added) toast(`Added "${name}" to site list.`);
    else toast(`"${name}" is already in the site list — selected.`);
    addForm.classList.add("hidden");
    addBtn.classList.remove("hidden");
    newInput.value = "";
  }
  saveBtn.addEventListener("click", commitNew);
  newInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitNew(); }
    if (e.key === "Escape") { cancelBtn.click(); }
  });

  addRow.append(addBtn, addForm);
  host.appendChild(addRow);
}

/* =========================================================================
 *  SITE AREA SELECT — fixed list (matches EMP Uploader "Location Within")
 * ========================================================================= */

function populateSiteArea(select, currentValue) {
  // Keep the placeholder option already in the template.
  SITE_AREA_OPTIONS.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  if (currentValue) select.value = currentValue;
}

function populateTourists(select, currentValue) {
  TOURISTS_OPTIONS.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  if (currentValue) select.value = currentValue;
}

/* =========================================================================
 *  DURATION DROPDOWNS (Hours + Minutes)
 *  Canonical storage is the "HH:MM" string. The two selects are pure UI.
 * ========================================================================= */

function attachDurationPicker(scope, onChange) {
  const hSel = scope.querySelector('[name="durationHours"]');
  const mSel = scope.querySelector('[name="durationMinutes"]');
  if (!hSel || !mSel) return null;

  DURATION_HOURS.forEach((h) => {
    const o = document.createElement("option");
    o.value = String(h);
    o.textContent = `${String(h).padStart(2, "0")} h`;
    hSel.appendChild(o);
  });
  DURATION_MINUTES.forEach((m) => {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = `${String(m).padStart(2, "0")} min`;
    mSel.appendChild(o);
  });

  function setValueFromStored(stored) {
    if (!stored || !/^\d{1,2}:[0-5]\d$/.test(stored)) {
      hSel.value = "";
      mSel.value = "";
      return;
    }
    const [h, m] = stored.split(":").map((p) => parseInt(p, 10));
    hSel.value = DURATION_HOURS.includes(h) ? String(h) : "";
    mSel.value = DURATION_MINUTES.includes(m) ? String(m) : "";
  }

  function readValue() {
    if (hSel.value === "" || mSel.value === "") return "";
    const h = parseInt(hSel.value, 10);
    const m = parseInt(mSel.value, 10);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  if (typeof onChange === "function") {
    hSel.addEventListener("change", onChange);
    mSel.addEventListener("change", onChange);
  }

  return { setValueFromStored, readValue, hSel, mSel };
}

/* =========================================================================
 *  SETUP SCREEN
 * ========================================================================= */

function renderSetup() {
  const node = renderTpl("tpl-setup");
  const form = node.querySelector("#setup-form");
  const resumeBtn = node.querySelector("#resume-btn");

  const existing = loadDraft();
  if (existing) {
    resumeBtn.classList.remove("hidden");
    const m = existing.metadata || {};
    if (m.surveyLeader) form.querySelector('[name="surveyLeader"]').value = m.surveyLeader;
    if (m.uploadedBy) form.querySelector('[name="uploadedBy"]').value = m.uploadedBy;
    if (m.numberOfSurveyors) form.querySelector('[name="numberOfSurveyors"]').value = m.numberOfSurveyors;
    if (m.date) form.querySelector('[name="date"]').value = m.date;
    if (m.site) form.querySelector('[name="site"]').value = m.site;
    if (m.surveyStartTime) form.querySelector('[name="surveyStartTime"]').value = m.surveyStartTime;
    if (m.numberOfLargeBoatsAtSite) form.querySelector('[name="numberOfLargeBoatsAtSite"]').value = m.numberOfLargeBoatsAtSite;
    if (m.numberOfSmallBoatsAtSite) form.querySelector('[name="numberOfSmallBoatsAtSite"]').value = m.numberOfSmallBoatsAtSite;
    if (m.otherSpecies) form.querySelector('[name="otherSpecies"]').value = m.otherSpecies;
    resumeBtn.addEventListener("click", () => {
      state.draft = existing;
      saveDraft();
      go("sharks");
    });
  }

  if (!form.date.value) form.date.value = new Date().toISOString().slice(0, 10);

  attachDiveSitePicker(form.querySelector('[name="site"]'), existing?.metadata?.site || "");
  populateSiteArea(form.querySelector('[name="siteArea"]'), existing?.metadata?.siteArea || "");
  populateTourists(form.querySelector('[name="numberOfTouristsAtSite"]'), existing?.metadata?.numberOfTouristsAtSite || "");

  const duration = attachDurationPicker(form);
  if (duration && existing) duration.setValueFromStored(existing.metadata?.surveyDuration || "");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const meta = {
      surveyLeader: (fd.get("surveyLeader") || "").toString().trim(),
      uploadedBy: (fd.get("uploadedBy") || "").toString().trim(),
      numberOfSurveyors: (fd.get("numberOfSurveyors") || "").toString().trim(),
      date: (fd.get("date") || "").toString(),
      site: (fd.get("site") || "").toString(),
      siteArea: (fd.get("siteArea") || "").toString(),
      surveyStartTime: (fd.get("surveyStartTime") || "").toString(),
      surveyDuration: duration ? duration.readValue() : "",
      numberOfLargeBoatsAtSite: (fd.get("numberOfLargeBoatsAtSite") || "").toString().trim(),
      numberOfSmallBoatsAtSite: (fd.get("numberOfSmallBoatsAtSite") || "").toString().trim(),
      numberOfTouristsAtSite: (fd.get("numberOfTouristsAtSite") || "").toString(),
      otherSpecies: (fd.get("otherSpecies") || "").toString().trim(),
    };
    if (!meta.surveyLeader || !meta.uploadedBy || !meta.numberOfSurveyors || !meta.date ||
        !meta.site || !meta.siteArea || !meta.surveyStartTime || !meta.surveyDuration ||
        meta.numberOfLargeBoatsAtSite === "" || meta.numberOfSmallBoatsAtSite === "" ||
        !meta.numberOfTouristsAtSite) {
      toast("Fill all required metadata fields (Other Species is optional).");
      return;
    }
    if (!state.draft) state.draft = newDraft();
    state.draft.metadata = meta;
    saveDraft();
    go("sharks");
  });
}

/* =========================================================================
 *  INFO SCREEN (auto-saving metadata editor)
 * ========================================================================= */

function renderInfo() {
  if (!state.draft) return go("setup");
  const node = renderTpl("tpl-info");
  const form = node.querySelector("#info-form");
  const savedIndicator = node.querySelector("#info-saved");

  const m = state.draft.metadata;
  form.querySelector('[name="surveyLeader"]').value = m.surveyLeader || "";
  form.querySelector('[name="uploadedBy"]').value = m.uploadedBy || "";
  form.querySelector('[name="numberOfSurveyors"]').value = m.numberOfSurveyors || "";
  form.querySelector('[name="date"]').value = m.date || "";
  form.querySelector('[name="site"]').value = m.site || "";
  form.querySelector('[name="surveyStartTime"]').value = m.surveyStartTime || "";
  form.querySelector('[name="numberOfLargeBoatsAtSite"]').value = m.numberOfLargeBoatsAtSite || "";
  form.querySelector('[name="numberOfSmallBoatsAtSite"]').value = m.numberOfSmallBoatsAtSite || "";
  form.querySelector('[name="otherSpecies"]').value = m.otherSpecies || "";

  attachDiveSitePicker(form.querySelector('[name="site"]'), m.site || "");
  populateSiteArea(form.querySelector('[name="siteArea"]'), m.siteArea || "");
  populateTourists(form.querySelector('[name="numberOfTouristsAtSite"]'), m.numberOfTouristsAtSite || "");

  let savedTimer = null;
  function flashSaved() {
    if (!savedIndicator) return;
    savedIndicator.textContent = "Saved ✓";
    savedIndicator.classList.add("flash");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedIndicator.textContent = "Changes save automatically.";
      savedIndicator.classList.remove("flash");
    }, 1400);
  }

  function persist() {
    const fd = new FormData(form);
    state.draft.metadata.surveyLeader = (fd.get("surveyLeader") || "").toString().trim();
    state.draft.metadata.uploadedBy = (fd.get("uploadedBy") || "").toString().trim();
    state.draft.metadata.numberOfSurveyors = (fd.get("numberOfSurveyors") || "").toString().trim();
    state.draft.metadata.date = (fd.get("date") || "").toString();
    state.draft.metadata.site = (fd.get("site") || "").toString();
    state.draft.metadata.siteArea = (fd.get("siteArea") || "").toString();
    state.draft.metadata.surveyStartTime = (fd.get("surveyStartTime") || "").toString();
    state.draft.metadata.surveyDuration = duration ? duration.readValue() : "";
    state.draft.metadata.numberOfLargeBoatsAtSite = (fd.get("numberOfLargeBoatsAtSite") || "").toString().trim();
    state.draft.metadata.numberOfSmallBoatsAtSite = (fd.get("numberOfSmallBoatsAtSite") || "").toString().trim();
    state.draft.metadata.numberOfTouristsAtSite = (fd.get("numberOfTouristsAtSite") || "").toString();
    state.draft.metadata.otherSpecies = (fd.get("otherSpecies") || "").toString().trim();
    saveDraft();
    flashSaved();
  }

  const duration = attachDurationPicker(form, persist);
  if (duration) duration.setValueFromStored(m.surveyDuration || "");

  ["surveyLeader", "uploadedBy", "numberOfSurveyors", "site", "numberOfLargeBoatsAtSite", "numberOfSmallBoatsAtSite", "otherSpecies"].forEach((n) => {
    const el = form.querySelector(`[name="${n}"]`);
    if (el) el.addEventListener("input", persist);
  });
  form.querySelector('[name="date"]').addEventListener("change", persist);
  form.querySelector('[name="site"]').addEventListener("change", persist);
  form.querySelector('[name="siteArea"]').addEventListener("change", persist);
  form.querySelector('[name="surveyStartTime"]').addEventListener("change", persist);
  form.querySelector('[name="numberOfTouristsAtSite"]').addEventListener("change", persist);
}

/* =========================================================================
 *  SHARKS SCREEN — collapsible list of per-shark cards
 * ========================================================================= */

function renderSharks() {
  if (!state.draft) return go("setup");
  const node = renderTpl("tpl-sharks");

  const countPill = node.querySelector("#shark-count");
  const list = node.querySelector("#shark-list");
  const addBtn = node.querySelector("#add-shark");

  function refreshCount() {
    const n = state.draft.sharks.length;
    countPill.textContent = `${n} shark${n === 1 ? "" : "s"}`;
  }
  refreshCount();

  function renderList() {
    list.innerHTML = "";
    if (state.draft.sharks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No sharks logged yet. Tap “+ Add a shark” when you spot your first one.";
      list.appendChild(hint);
      return;
    }
    state.draft.sharks.forEach((s, idx) => {
      list.appendChild(buildSharkCard(s, idx, () => {
        refreshCount();
        renderList();
      }));
    });
  }
  renderList();

  addBtn.addEventListener("click", () => {
    const s = newShark();
    state.draft.sharks.push(s);
    state.expandedShark = s.id;
    saveDraft();
    refreshCount();
    renderList();
  });
}

function buildSharkCard(shark, idx, onChange) {
  const card = document.createElement("div");
  card.className = "shark-card" + (state.expandedShark === shark.id ? " open" : "");

  const head = document.createElement("div");
  head.className = "shark-card-head";

  const num = document.createElement("div");
  num.className = "shark-card-num";
  num.textContent = idx + 1;
  head.appendChild(num);

  const summary = document.createElement("div");
  summary.className = "shark-card-summary";
  const title = document.createElement("div");
  title.className = "shark-card-title";
  title.textContent = `Shark ${idx + 1}`;
  const meta = document.createElement("div");
  meta.className = "shark-card-meta";
  meta.textContent = buildSharkSummary(shark);
  const incompleteBadge = document.createElement("span");
  incompleteBadge.className = "incomplete-badge";
  incompleteBadge.textContent = "Incomplete";
  summary.append(title, meta, incompleteBadge);
  head.appendChild(summary);

  function refreshIncomplete() {
    const missing = sharkMissingFields(shark);
    incompleteBadge.classList.toggle("hidden", missing.length === 0);
    incompleteBadge.title = missing.length ? `Missing: ${missing.join(", ")}` : "";
  }
  refreshIncomplete();

  const chev = document.createElement("div");
  chev.className = "shark-card-chev";
  chev.textContent = state.expandedShark === shark.id ? "▾" : "▸";
  head.appendChild(chev);

  head.addEventListener("click", () => {
    state.expandedShark = state.expandedShark === shark.id ? null : shark.id;
    onChange();
  });
  card.appendChild(head);

  if (state.expandedShark === shark.id) {
    card.appendChild(buildSharkBody(shark, () => {
      title.textContent = `Shark ${idx + 1}`;
      meta.textContent = buildSharkSummary(shark);
      refreshIncomplete();
    }, () => {
      const i = state.draft.sharks.findIndex((x) => x.id === shark.id);
      if (i >= 0) state.draft.sharks.splice(i, 1);
      if (state.expandedShark === shark.id) state.expandedShark = null;
      saveDraft();
      onChange();
    }, () => {
      state.expandedShark = null;
      onChange();
    }));
  }

  return card;
}

function buildSharkSummary(s) {
  const stageLabel = (LIFE_STAGE_OPTIONS.find((o) => o.code === s.lifeStage) || {}).label;
  const behaviourLabel = (BEHAVIOUR_OPTIONS.find((o) => o.code === s.behaviourCode) || {}).label;
  const bits = [];
  if (stageLabel) bits.push(stageLabel);
  if (behaviourLabel) bits.push(behaviourLabel);
  if (s.approxSize) bits.push(`${s.approxSize} cm`);
  if (s.depthObserved) bits.push(`${s.depthObserved} m`);
  if (s.timeSeen) bits.push(s.timeSeen);
  return bits.length ? bits.join(" · ") : "Tap to fill in details";
}

function buildSharkBody(shark, onUpdate, onDelete, onSave) {
  const body = document.createElement("div");
  body.className = "shark-card-body";

  const grid = document.createElement("div");
  grid.className = "shark-grid";

  function field(labelText, build) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(build());
    return label;
  }

  function persist() {
    saveDraft();
    onUpdate();
  }

  // Time Seen
  grid.appendChild(field("Time Seen *", () => {
    const inp = document.createElement("input");
    inp.type = "time";
    inp.value = shark.timeSeen || "";
    inp.addEventListener("change", () => { shark.timeSeen = inp.value; persist(); });
    return inp;
  }));

  // Depth Observed
  grid.appendChild(field("Depth Observed (m) *", () => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.min = "0";
    inp.inputMode = "decimal";
    inp.placeholder = "e.g. 8.5";
    inp.value = shark.depthObserved || "";
    inp.addEventListener("focus", () => setTimeout(() => inp.select(), 0));
    inp.addEventListener("input", () => { shark.depthObserved = inp.value; persist(); });
    inp.addEventListener("blur", () => {
      const raw = inp.value.trim();
      if (!raw) return;
      const n = parseFloat(raw);
      if (isNaN(n)) return;
      const formatted = Math.max(0, n).toFixed(1);
      inp.value = formatted;
      shark.depthObserved = formatted;
      persist();
    });
    return inp;
  }));

  body.appendChild(grid);

  // Life Stage — 3 cols × 2 rows
  body.appendChild(buildPillField("Life Stage *", LIFE_STAGE_OPTIONS,
    shark.lifeStage,
    (val) => { shark.lifeStage = val; persist(); }, 3));

  // Approx Size — optional, sits as a full-width field below Life Stage
  const sizeLabel = document.createElement("label");
  const sizeSpan = document.createElement("span");
  sizeSpan.textContent = "Approx Size (If Observed)";
  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.min = "0";
  sizeInput.step = "0.01";
  sizeInput.inputMode = "decimal";
  sizeInput.placeholder = "Estimated Length (M)";
  sizeInput.value = shark.approxSize || "";
  sizeInput.addEventListener("focus", () => setTimeout(() => sizeInput.select(), 0));
  sizeInput.addEventListener("input", () => { shark.approxSize = sizeInput.value; persist(); });
  sizeLabel.append(sizeSpan, sizeInput);
  body.appendChild(sizeLabel);

  // Behaviour Code — 2 cols × 4 rows
  body.appendChild(buildPillField("Behaviour Code *", BEHAVIOUR_OPTIONS,
    shark.behaviourCode,
    (val) => { shark.behaviourCode = val; persist(); }, 2));

  // Markings
  const markingsLabel = document.createElement("label");
  const markingsSpan = document.createElement("span");
  markingsSpan.textContent = "Markings / distinguishing features";
  const markingsArea = document.createElement("textarea");
  markingsArea.rows = 3;
  markingsArea.maxLength = 800;
  markingsArea.placeholder = "Scars, notches, fin shape, colouration, tag IDs, …";
  markingsArea.value = shark.markings || "";
  markingsArea.addEventListener("input", () => { shark.markings = markingsArea.value; persist(); });
  markingsLabel.append(markingsSpan, markingsArea);
  body.appendChild(markingsLabel);

  // Comment
  const commentLabel = document.createElement("label");
  const commentSpan = document.createElement("span");
  commentSpan.textContent = "Comment";
  const commentArea = document.createElement("textarea");
  commentArea.rows = 3;
  commentArea.maxLength = 800;
  commentArea.placeholder = "Anything else worth noting about this sighting.";
  commentArea.value = shark.comment || "";
  commentArea.addEventListener("input", () => { shark.comment = commentArea.value; persist(); });
  commentLabel.append(commentSpan, commentArea);
  body.appendChild(commentLabel);

  // Card actions — Delete (left, destructive) + Save Shark (right, primary)
  const actions = document.createElement("div");
  actions.className = "shark-card-actions";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "shark-delete-btn";
  delBtn.textContent = "Delete this shark";
  delBtn.addEventListener("click", () => {
    if (!confirm("Delete this shark? This removes it from the draft on this device.")) return;
    onDelete();
    toast("Shark removed.");
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary shark-save-btn";
  saveBtn.textContent = "Save Shark";
  saveBtn.addEventListener("click", () => {
    if (typeof onSave === "function") onSave();
    toast("Shark saved.");
  });
  actions.append(delBtn, saveBtn);
  body.appendChild(actions);

  return body;
}

function buildPillField(labelText, options, currentValue, onChange, columns) {
  const wrap = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.appendChild(span);

  const group = document.createElement("div");
  group.className = "pill-group";
  if (columns) group.style.setProperty("--pill-cols", columns);
  options.forEach((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill-btn" + (currentValue === opt.code ? " selected" : "");
    b.textContent = opt.code === opt.label ? opt.code : `${opt.code} — ${opt.label}`;
    b.addEventListener("click", () => {
      const next = currentValue === opt.code ? "" : opt.code;
      currentValue = next;
      onChange(next);
      group.querySelectorAll(".pill-btn").forEach((x) => x.classList.remove("selected"));
      if (next) b.classList.add("selected");
    });
    group.appendChild(b);
  });
  wrap.appendChild(group);
  return wrap;
}

/* =========================================================================
 *  REVIEW / SUBMIT
 * ========================================================================= */

function renderReview() {
  if (!state.draft) return go("setup");
  const node = renderTpl("tpl-review");
  const sum = node.querySelector("#review-summary");
  const meta = state.draft.metadata;

  const metaList = document.createElement("dl");
  metaList.className = "review-meta";
  [
    ["Survey Leader", meta.surveyLeader],
    ["Uploaded By", meta.uploadedBy],
    ["Number of Surveyors", meta.numberOfSurveyors],
    ["Date", meta.date],
    ["Site", meta.site],
    ["Site Area", meta.siteArea],
    ["Survey Start Time", meta.surveyStartTime],
    ["Survey Duration", meta.surveyDuration],
    ["Number of Large Boats At Site", meta.numberOfLargeBoatsAtSite],
    ["Number of Small Boats At Site", meta.numberOfSmallBoatsAtSite],
    ["Number of Tourists At Site", meta.numberOfTouristsAtSite],
    ["Number of Sharks Seen", String(state.draft.sharks.length)],
    ["Other Species", meta.otherSpecies],
  ].forEach(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = (v === "" || v === undefined || v === null) ? "—" : v;
    metaList.append(dt, dd);
  });
  sum.appendChild(metaList);

  // Shark block
  const block = document.createElement("div");
  block.className = "review-block";
  const h4 = document.createElement("h4");
  h4.textContent = "Sharks ";
  const badge = document.createElement("span");
  const status = reviewStatus();
  badge.className = "review-status " + status.kind;
  badge.textContent = status.label;
  h4.appendChild(badge);
  block.appendChild(h4);

  if (status.notes) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = status.notes;
    p.style.margin = "4px 0 0";
    block.appendChild(p);
  }

  if (state.draft.sharks.length > 0) {
    const mini = document.createElement("div");
    mini.className = "shark-mini-list";
    state.draft.sharks.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "shark-mini";
      const numEl = document.createElement("span");
      numEl.className = "shark-mini-num";
      numEl.textContent = `#${i + 1}`;
      const wrap = document.createElement("div");
      wrap.style.flex = "1";
      const wTitle = document.createElement("div");
      wTitle.textContent = `Shark ${i + 1}`;
      wTitle.style.fontWeight = "600";
      const wDetail = document.createElement("div");
      wDetail.className = "shark-mini-detail";
      wDetail.textContent = buildSharkSummary(s);
      wrap.append(wTitle, wDetail);
      const missing = sharkMissingFields(s);
      if (missing.length) {
        const warn = document.createElement("div");
        warn.className = "shark-mini-warn";
        warn.textContent = `Missing: ${missing.join(", ")}`;
        wrap.appendChild(warn);
      }
      row.append(numEl, wrap);
      mini.appendChild(row);
    });
    block.appendChild(mini);
  }

  sum.appendChild(block);

  const submitBtn = node.querySelector("#submit-all");
  const noSharks = state.draft.sharks.length === 0;
  const incompleteCount = state.draft.sharks.filter((s) => sharkMissingFields(s).length > 0).length;
  const pairingErr = behaviourPairingError(state.draft);
  submitBtn.disabled = state.draft.submitted || incompleteCount > 0 || !!pairingErr;
  if (state.draft.submitted) {
    submitBtn.textContent = "ALREADY SUBMITTED";
    submitBtn.title = "This draft has already been submitted. Reset to start a new survey.";
  } else if (incompleteCount > 0) {
    submitBtn.title = `${incompleteCount} shark${incompleteCount === 1 ? "" : "s"} still missing required fields. Fill them in before submitting.`;
  } else if (pairingErr) {
    submitBtn.title = pairingErr;
  } else if (noSharks) {
    submitBtn.title = "Submit zero-shark survey — one row with metadata and dashes in every shark column.";
  } else {
    submitBtn.title = `Submit ${state.draft.sharks.length} shark row${state.draft.sharks.length === 1 ? "" : "s"} to the Sheet.`;
  }
  submitBtn.addEventListener("click", submitSurvey);

  node.querySelector("#download-csv").addEventListener("click", downloadCSV);
  node.querySelector("#copy-tsv").addEventListener("click", copyTSV);
  node.querySelector("#export-json").addEventListener("click", exportJSON);
  node.querySelector("#discard-all").addEventListener("click", () => {
    if (confirm("Reset all data for this survey? This wipes the entire draft and cannot be undone.")) {
      clearDraft();
      toast("All data reset");
      go("setup");
    }
  });
}

function reviewStatus() {
  const n = state.draft.sharks.length;
  if (state.draft.submitted) {
    return { kind: "complete", label: "Submitted", notes: "This survey has been submitted. Reset to start a new one." };
  }
  if (n === 0) {
    return {
      kind: "complete",
      label: "Zero Sharks",
      notes: "No sharks observed — submitting will record one summary row with the metadata and a dash (–) in every shark column. No data is still data.",
    };
  }
  const incomplete = state.draft.sharks.filter((s) => sharkMissingFields(s).length > 0).length;
  if (incomplete > 0) {
    return {
      kind: "partial",
      label: "Incomplete",
      notes: `${n} shark${n === 1 ? "" : "s"} logged · ${incomplete} with missing required fields. Fill them in on the Sharks tab before submitting.`,
    };
  }
  const pairingErr = behaviourPairingError(state.draft);
  if (pairingErr) {
    return { kind: "partial", label: "Pairing Issue", notes: pairingErr };
  }
  return { kind: "complete", label: "Complete", notes: `${n} shark${n === 1 ? "" : "s"} ready to submit.` };
}

function sharkMissingFields(s) {
  const missing = [];
  if (!s.timeSeen) missing.push("time");
  if (!s.depthObserved) missing.push("depth");
  if (!s.lifeStage) missing.push("life stage");
  if (!s.behaviourCode) missing.push("behaviour");
  return missing;
}

// Cross-shark validation for the Cruising Group behaviour codes:
//   C3 = "Cruising Group With Leader" — implies a leader was observed.
//   C4 = "Cruising Group As Leader"   — implies the followers were observed.
// They're two sides of the same sighting, so a survey with one but not the
// other is inconsistent. Returns an error message string or null if OK.
function behaviourPairingError(draft) {
  const c3 = draft.sharks
    .map((s, i) => (s.behaviourCode === "C3" ? i + 1 : null))
    .filter((x) => x);
  const c4 = draft.sharks
    .map((s, i) => (s.behaviourCode === "C4" ? i + 1 : null))
    .filter((x) => x);
  const list = (nums) => (nums.length === 1 ? `Shark ${nums[0]}` : `Sharks ${nums.join(", ")}`);
  if (c3.length > 0 && c4.length === 0) {
    return `${list(c3)} coded C3 (group with leader) — at least one shark must also be coded C4 (the leader). Add the leader or change the selection.`;
  }
  if (c4.length > 0 && c3.length === 0) {
    return `${list(c4)} coded C4 (the leader) — at least one shark must also be coded C3 (the followers). Add the followers or change the selection.`;
  }
  return null;
}

/* =========================================================================
 *  PAYLOAD / SCHEMA
 * ========================================================================= */

function buildSchema() {
  return {
    meta: [
      "surveyId",
      "submittedAt",
      "surveyLeader",
      "uploadedBy",
      "numberOfSurveyors",
      "dateDay",
      "dateMonth",
      "dateYear",
      "site",
      "siteArea",
      "surveyStartTime",
      "surveyDuration",
      "numberOfLargeBoatsAtSite",
      "numberOfSmallBoatsAtSite",
      "numberOfTouristsAtSite",
      "otherSpecies",
      "numberOfSharksSeen",
    ],
    shark: [
      "sharkNumber",
      "timeSeen",
      "depthObserved",
      "approxSize",
      "lifeStage",
      "behaviourCode",
      "markings",
      "comment",
    ],
  };
}

// Splits a canonical "YYYY-MM-DD" string into the three output columns.
// Empty/invalid input → empty strings, matching the rest of the row contract.
function splitDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { dateDay: "", dateMonth: "", dateYear: "" };
  }
  const [year, month, day] = iso.split("-");
  return { dateDay: day, dateMonth: month, dateYear: year };
}

function buildRows(draft) {
  const submittedAt = new Date().toISOString();
  const numSharks = draft.sharks.length;
  const dateParts = splitDate(draft.metadata.date || "");
  const baseMeta = {
    surveyId: draft.id,
    submittedAt,
    surveyLeader: draft.metadata.surveyLeader || "",
    uploadedBy: draft.metadata.uploadedBy || "",
    numberOfSurveyors: draft.metadata.numberOfSurveyors || "",
    dateDay: dateParts.dateDay,
    dateMonth: dateParts.dateMonth,
    dateYear: dateParts.dateYear,
    site: draft.metadata.site || "",
    siteArea: draft.metadata.siteArea || "",
    surveyStartTime: draft.metadata.surveyStartTime || "",
    surveyDuration: draft.metadata.surveyDuration || "",
    numberOfLargeBoatsAtSite: draft.metadata.numberOfLargeBoatsAtSite || "",
    numberOfSmallBoatsAtSite: draft.metadata.numberOfSmallBoatsAtSite || "",
    numberOfTouristsAtSite: draft.metadata.numberOfTouristsAtSite || "",
    otherSpecies: draft.metadata.otherSpecies || "",
    numberOfSharksSeen: numSharks,
  };

  // Zero-shark surveys still produce a row — no data is still data. The
  // shark columns get "-" so the Sheet stays rectangular and zero-shark
  // surveys are visually distinct from sighting rows.
  if (numSharks === 0) {
    return [{
      ...baseMeta,
      sharkNumber: "-",
      timeSeen: "-",
      depthObserved: "-",
      approxSize: "-",
      lifeStage: "-",
      behaviourCode: "-",
      markings: "-",
      comment: "-",
    }];
  }

  return draft.sharks.map((s, i) => ({
    ...baseMeta,
    sharkNumber: i + 1,
    timeSeen: s.timeSeen || "",
    depthObserved: s.depthObserved || "",
    approxSize: s.approxSize || "",
    lifeStage: s.lifeStage || "",
    behaviourCode: s.behaviourCode || "",
    markings: s.markings || "",
    comment: s.comment || "",
  }));
}

/* =========================================================================
 *  SUBMIT / SYNC
 * ========================================================================= */

async function submitSurvey() {
  if (!state.draft) return;
  if (state.draft.submitted) {
    toast("This survey has already been submitted.");
    return;
  }
  const incomplete = state.draft.sharks
    .map((s, i) => ({ idx: i + 1, missing: sharkMissingFields(s) }))
    .filter((x) => x.missing.length > 0);
  if (incomplete.length > 0) {
    toast(`Shark ${incomplete[0].idx} is missing: ${incomplete[0].missing.join(", ")}. Fill all required fields before submitting.`);
    return;
  }
  const pairingErr = behaviourPairingError(state.draft);
  if (pairingErr) {
    toast(pairingErr);
    return;
  }

  const rows = buildRows(state.draft);
  const isZero = state.draft.sharks.length === 0;
  const payload = { rows, schema: buildSchema() };

  state.queue.push({
    id: state.draft.id,
    queuedAt: new Date().toISOString(),
    payload,
  });
  saveQueue();
  updateQueuePill();

  state.draft.submitted = true;
  saveDraft();
  renderReview();

  if (!state.settings.syncUrl) {
    toast(isZero
      ? "Queued zero-shark survey locally — add a Sheets URL in Settings to push."
      : `Queued ${rows.length} shark row${rows.length === 1 ? "" : "s"} locally — add a Sheets URL in Settings to push.`);
    return;
  }

  try {
    await flushQueue();
    toast(isZero
      ? "Submitted zero-shark survey to Google Sheets ✓"
      : `Submitted ${rows.length} shark row${rows.length === 1 ? "" : "s"} to Google Sheets ✓`);
  } catch (e) {
    toast(`Sync failed (${e.message}). Rows queued, will retry when online.`);
  }
}

async function flushQueue() {
  if (!state.settings.syncUrl) return;
  if (!navigator.onLine) throw new Error("Offline");
  while (state.queue.length > 0) {
    const item = state.queue[0];
    // Apps Script web apps reject preflight (no custom headers) — use text/plain.
    // The shared secret rides inside the JSON body so it's never in a URL or
    // header (where it'd be more likely to leak via logs / referrers).
    const body = { ...item.payload, secret: SYNC_SECRET };
    const res = await fetch(state.settings.syncUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === false) throw new Error(data.error || "Apps Script error");
    state.queue.shift();
    saveQueue();
    updateQueuePill();
  }
}

/* =========================================================================
 *  PENDING SYNC QUEUE MODAL
 * ========================================================================= */

function relativeTime(iso) {
  if (!iso) return "queued";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function summarizeQueueItem(item) {
  const rows = (item.payload && item.payload.rows) || [];
  const site = rows[0] && rows[0].site;
  const date = rows[0] && rows[0].date;
  return {
    title: site ? `${site} · ${date || ""}`.trim() : "Shark survey",
    detail: `${rows.length} shark row${rows.length === 1 ? "" : "s"}`,
  };
}

function removeQueueItem(idx) {
  const item = state.queue[idx];
  if (state.draft && item && item.id === state.draft.id) {
    state.draft.submitted = false;
    saveDraft();
  }
  state.queue.splice(idx, 1);
  saveQueue();
  updateQueuePill();
}

function openQueueModal() {
  const node = renderModal("tpl-queue-modal");
  const list = node.querySelector("#queue-list");
  const emptyHint = node.querySelector("#queue-empty-hint");
  const syncHint = node.querySelector("#queue-sync-hint");
  const retryBtn = node.querySelector("#queue-retry-btn");

  function render() {
    list.innerHTML = "";
    if (state.queue.length === 0) {
      emptyHint.classList.remove("hidden");
      retryBtn.disabled = true;
      syncHint.textContent = "";
      return;
    }
    emptyHint.classList.add("hidden");

    state.queue.forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = "queue-item";

      const top = document.createElement("div");
      top.className = "queue-item-top";

      const titleWrap = document.createElement("div");
      titleWrap.className = "queue-item-title-wrap";
      const summary = summarizeQueueItem(item);
      const title = document.createElement("div");
      title.className = "queue-item-title";
      title.textContent = summary.title;
      const detail = document.createElement("div");
      detail.className = "queue-item-detail muted small";
      detail.textContent = `${summary.detail} · ${relativeTime(item.queuedAt)}`;
      titleWrap.append(title, detail);
      top.appendChild(titleWrap);

      const rmBtn = document.createElement("button");
      rmBtn.className = "queue-item-remove";
      rmBtn.textContent = "Remove";
      rmBtn.title = "Drop this submission and re-enable the survey for re-submission";
      rmBtn.addEventListener("click", () => {
        if (!confirm(`Remove this queued submission?\n\n${summary.title}\n${summary.detail}`)) return;
        removeQueueItem(idx);
        render();
        if (state.current === "review") renderReview();
      });
      top.appendChild(rmBtn);

      card.appendChild(top);
      list.appendChild(card);
    });

    if (!state.settings.syncUrl) {
      syncHint.textContent = "No Sheets sync URL set in Settings — Retry won't push anywhere yet.";
      retryBtn.disabled = true;
    } else if (!navigator.onLine) {
      syncHint.textContent = "Offline — Retry will fail until the device is back online.";
      retryBtn.disabled = false;
    } else {
      syncHint.textContent = "";
      retryBtn.disabled = false;
    }
  }
  render();

  node.querySelector('[data-action="close"]').addEventListener("click", () => closeModal(node));
  retryBtn.addEventListener("click", async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = "Retrying…";
    try {
      await flushQueue();
      toast("Queue flushed ✓");
      closeModal(node);
      if (state.current === "review") renderReview();
    } catch (e) {
      retryBtn.disabled = false;
      retryBtn.textContent = "Retry now";
      toast(`Retry failed (${e.message})`);
      render();
    }
  });
}

function openSettings() {
  const node = renderModal("tpl-settings");
  node.querySelector("#sync-url").value = state.settings.syncUrl || "";
  node.querySelector("#auto-sync").checked = !!state.settings.autoSync;
  node.querySelector('[data-action="cancel"]').addEventListener("click", () => closeModal(node));
  node.querySelector('[data-action="save"]').addEventListener("click", () => {
    state.settings.syncUrl = node.querySelector("#sync-url").value.trim();
    state.settings.autoSync = node.querySelector("#auto-sync").checked;
    saveSettings();
    closeModal(node);
    toast("Settings saved");
    updateQueuePill();
  });
}

function renderModal(tplId) {
  const tpl = document.getElementById(tplId);
  const node = tpl.content.firstElementChild.cloneNode(true);
  document.body.appendChild(node);
  return node;
}
function closeModal(node) {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

/* =========================================================================
 *  EXPORTS — JSON / CSV / TSV
 * ========================================================================= */

function exportJSON() {
  if (!state.draft && state.queue.length === 0) return;
  const data = state.draft
    ? { rows: buildRows(state.draft), schema: buildSchema() }
    : state.queue;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, `shark-survey-${stampForFilename()}.json`);
}

function downloadCSV() {
  if (!state.draft) return;
  const csv = surveyToDelimited(",");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `shark-survey-${stampForFilename()}.csv`);
}

async function copyTSV() {
  if (!state.draft) return;
  const tsv = surveyToDelimited("\t");
  try {
    await navigator.clipboard.writeText(tsv);
    toast("Copied as TSV — paste into Sheets.");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = tsv;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Copied to clipboard."); }
    catch { toast("Could not copy — select and copy manually."); }
    ta.remove();
  }
}

function surveyToDelimited(sep) {
  const schema = buildSchema();
  const cols = [...schema.meta, ...schema.shark];
  const rows = buildRows(state.draft);
  const lines = [cols.map(csvEscape).join(sep)];
  rows.forEach((r) => {
    lines.push(cols.map((c) => csvEscape(r[c] === undefined ? "" : r[c])).join(sep));
  });
  return lines.join("\n");
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\t\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function stampForFilename() {
  const meta = state.draft?.metadata || {};
  const date = meta.date || new Date().toISOString().slice(0, 10);
  const loc = (meta.site || "survey").replace(/[^a-z0-9]+/gi, "_");
  return `${date}-${loc}`;
}

/* =========================================================================
 *  UI HELPERS
 * ========================================================================= */

function updateQueuePill() {
  const el = document.getElementById("queue-count");
  if (el) el.textContent = state.queue.length;
}

function updateNetStatus() {
  const dot = document.getElementById("net-status");
  if (!dot) return;
  dot.classList.toggle("offline", !navigator.onLine);
  dot.title = navigator.onLine ? "Online" : "Offline — submissions will queue";
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* =========================================================================
 *  BOOT
 * ========================================================================= */

function boot() {
  state.queue = loadQueue();
  state.settings = loadSettings();
  state.draft = loadDraft();
  updateQueuePill();
  updateNetStatus();

  document.querySelectorAll("#survey-tabs .tab").forEach((b) => {
    b.addEventListener("click", () => {
      if (!state.draft) return go("setup");
      go(b.dataset.screen);
    });
  });
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("queue-count").addEventListener("click", openQueueModal);

  window.addEventListener("online", () => {
    updateNetStatus();
    if (state.settings.autoSync && state.queue.length > 0) {
      flushQueue().catch(() => {});
    }
  });
  window.addEventListener("offline", updateNetStatus);

  go(state.draft ? "sharks" : "setup");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
