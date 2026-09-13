const $ = (id) => document.getElementById(id);

const ui = {
  official: $("label-official"),
  sandbox: $("label-sandbox"),
  rph: $("label-rph"),
  lampOfficial: $("lamp-official"),
  lampSandbox: $("lamp-sandbox"),
  lampRph: $("lamp-rph"),
  lspdfr: $("btn-lspdfr"),
  online: $("btn-online"),
  mods: $("mod-list"),
  modCount: $("mod-count"),
  log: $("log"),
  overlay: $("overlay"),
  dialog: $("dialog-body"),
  dialogBox: $("dialog"),
  drop: $("dropzone"),
  healthTitle: $("label-health-title"),
  healthDetail: $("label-health"),
  lampHealth: $("lamp-health"),
  smartToggle: $("smart-toggle"),
  smartMods: $("mod-list"),
  smartCount: $("mod-count"),
  lampSession: $("lamp-session"),
  sessionResult: $("label-session-result"),
  sessionDetail: $("label-session-detail"),
  retestBanner: $("retest-banner"),
  lampProfile: $("lamp-profile"),
  profileName: $("label-profile-name"),
  profileDetail: $("label-profile-detail"),
};

const THEME_KEY = "tactix.theme";

function normalizeTheme(value) {
  return value === "bright" ? "bright" : "dark";
}

function storedTheme() {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return "";
  }
}

function applyTheme(theme, persist = false) {
  const next = normalizeTheme(theme);
  document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore quota / private mode */
  }
  const darkBtn = $("theme-dark");
  const brightBtn = $("theme-bright");
  if (darkBtn) darkBtn.classList.toggle("is-active", next === "dark");
  if (brightBtn) brightBtn.classList.toggle("is-active", next === "bright");
  if (persist) window.tactix.settingsSave({ theme: next }).catch(() => {});
}

applyTheme(storedTheme() || document.documentElement.getAttribute("data-theme") || "dark");

let state = null;
let busy = false;
let smartMods = [];
let modHealthById = new Map();
let currentPage = "dashboard";
let previewDefaultApplied = false;
let workshopHandoff = null;
let workshopInboxTimer = null;
let lastWorkshopInboxPrompt = "";

function shortPath(value) {
  if (!value) return "Not set";
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts.slice(-3).join("\\");
}

function setLamp(el, mode) {
  el.className = `lamp ${mode}`;
}

function showOverlay(html, wide = false) {
  ui.dialog.innerHTML = html;
  ui.overlay.classList.remove("hidden");
  if (ui.dialogBox) ui.dialogBox.classList.toggle("wide", wide);
}

function hideOverlay() {
  ui.overlay.classList.add("hidden");
  ui.dialog.innerHTML = "";
  if (ui.dialogBox) ui.dialogBox.classList.remove("wide");
}

function addLog(entry) {
  const item = document.createElement("li");
  item.className = entry.level || "info";
  const time = new Date(entry.at || Date.now()).toLocaleTimeString();
  item.textContent = `${time}  ${entry.message}`;
  ui.log.prepend(item);
  while (ui.log.children.length > 80) ui.log.lastChild.remove();
}

const KIND_LABELS = {
  lspdfr: "LSPDFR",
  rage: "Rage Plugin Hook",
  vehicle: "Cars",
  map: "Buildings / maps",
  audio: "Sound packs",
  uniform: "Uniforms",
  script: "Scripts / ASI",
  els: "ELS",
  gameconfig: "Gameconfig / heap",
  oiv: "OpenIV package",
  lml: "Lenny's Mod Loader",
};

const MOD_SECTIONS = [
  { id: "lspdfr", title: "LSPDFR plugins", match: ["lspdfr", "lspdfr_plugin"] },
  { id: "rage", title: "Rage Plugin Hook", match: ["rage", "rage_plugin"] },
  { id: "dependency", title: "Dependencies", match: ["dependency"] },
  { id: "script", title: "Scripts / ASI", match: ["script", "asi"] },
  { id: "vehicle", title: "Cars", match: ["vehicle"] },
  { id: "map", title: "Buildings / maps", match: ["map"] },
  { id: "audio", title: "Sound packs", match: ["audio"] },
  { id: "uniform", title: "Uniforms", match: ["uniform"] },
  { id: "els", title: "ELS", match: ["els"] },
  { id: "other", title: "Other", match: ["gameconfig", "lml", "oiv"] },
];

const SMART_SECTIONS = MOD_SECTIONS;
const TYPE_SECTIONS = MOD_SECTIONS;

function kindBadges(labels) {
  if (!labels?.length) return "";
  return `<div class="badges">${labels.map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join("")}</div>`;
}

function labelsFor(mod) {
  if (mod.kindLabels?.length) return mod.kindLabels;
  return (mod.kinds || []).map((kind) => KIND_LABELS[kind]).filter(Boolean);
}

function primaryKind(mod) {
  const kinds = mod.kinds || [];
  if (kinds.includes("lspdfr")) return "lspdfr";
  if (kinds.includes("rage")) return "rage";
  for (const section of MOD_SECTIONS) {
    if (section.id === "other") continue;
    if (section.match.some((kind) => kinds.includes(kind))) return section.id;
  }
  return "other";
}

function displayName(mod) {
  let name = String(mod.name || mod.archiveName || "Pack");
  name = name.replace(/^[0-9a-f]{4,8}-/i, "");
  name = name.replace(/\.(zip|rar|7z|oiv|exe)$/i, "");
  name = name.replace(/_setup$/i, "");
  name = name.replace(/[_-]+/g, " ").trim();
  if (/^lspdfr\b/i.test(name)) return "LSPDFR";
  if (/directstorage/i.test(name)) return "DirectStorageFix";
  return name;
}

function folderHint(mod) {
  const files = mod.files || [];
  const hits = new Set();
  for (const file of files) {
    const n = String(file).replace(/\//g, "\\").toLowerCase();
    if (n.startsWith("plugins\\")) hits.add("Plugins");
    else if (n.startsWith("lspdfr\\")) hits.add("lspdfr\\");
    else if (n.startsWith("els\\")) hits.add("ELS");
    else if (n.startsWith("scripts\\")) hits.add("scripts\\");
    else if (n.startsWith("lml\\")) hits.add("lml\\");
    else if (n.includes("\\dlcpacks\\")) hits.add("DLC packs");
    else if (n.startsWith("mods\\")) hits.add("mods\\");
    else if (/\.asi$/i.test(n) && !n.includes("\\")) hits.add("Game root");
  }
  return [...hits].slice(0, 3).join(" · ");
}

function typeLabel(mod) {
  const section = TYPE_SECTIONS.find((row) => row.id === primaryKind(mod));
  return section ? section.title : "Other";
}

function folderLamp(mod) {
  if (mod.lamp === "ok" || mod.lamp === "warn" || mod.lamp === "grey" || mod.lamp === "bad") return mod.lamp;
  return mod.enabled === false ? "grey" : "bad";
}

function normalizeDest(file) {
  return String(typeof file === "string" ? file : (file && (file.destination || file.dest)) || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function destSet(mod) {
  return new Set((mod.files || []).map(normalizeDest).filter(Boolean));
}

function notableDests(mod) {
  return [...destSet(mod)].filter((dest) => /\.(dll|asi)$/i.test(dest));
}

function folderCoveredBySmart(folder, smartList) {
  const notables = notableDests(folder);
  const files = [...destSet(folder)];
  return (smartList || []).some((smart) => {
    const owned = destSet(smart);
    if (notables.length) {
      const hits = notables.filter((dest) => owned.has(dest)).length;
      return hits === notables.length || hits / notables.length >= 0.8;
    }
    if (!files.length) return false;
    const hits = files.filter((dest) => owned.has(dest)).length;
    return hits >= Math.max(1, Math.ceil(files.length * 0.8));
  });
}

function smartRowStatus(mod) {
  const health = modHealthById.get(mod.id);
  if (health) return health.status;
  return mod.enabled === false ? "DISABLED" : "UNKNOWN";
}

function smartLamp(status) {
  if (status === "BROKEN") return { lamp: "bad", label: "Broken" };
  if (status === "WARNING" || status === "UNKNOWN") return { lamp: "warn", label: "Needs attention" };
  if (status === "DISABLED") return { lamp: "grey", label: "Disabled" };
  return { lamp: "ok", label: "Healthy" };
}

function unifiedRows() {
  const folderMods = (state && state.mods) || [];
  const covered = new Set();
  const rows = (smartMods || []).map((mod) => {
    const status = smartRowStatus(mod);
    const lamp = smartLamp(status);
    const health = modHealthById.get(mod.id);
    const reasons = (health && health.reasons) || [];
    const compat = compatibilityLabel(mod.compatibilityStatus || mod.compatibility);
    return {
      origin: "smart",
      id: mod.id,
      name: mod.name,
      enabled: mod.enabled !== false,
      section: primarySmartKind(mod),
      lamp: lamp.lamp,
      lampLabel: lamp.label,
      lampDetail: reasons[0] || lamp.label,
      status,
      meta: [lamp.label, compat !== "Unknown" ? compat : "", reasons[0]].filter(Boolean).join(" · "),
      raw: mod,
    };
  });
  for (const mod of folderMods) {
    if (folderCoveredBySmart(mod, smartMods)) {
      covered.add(mod.id);
      continue;
    }
    const lamp = folderLamp(mod);
    const lampLabel = mod.lampLabel || (lamp === "ok" ? "Healthy" : lamp === "warn" ? "Needs attention" : lamp === "grey" ? "Disabled" : "Broken");
    const status = mod.healthStatus || (mod.enabled === false ? "DISABLED" : lamp === "ok" ? "HEALTHY" : lamp === "warn" ? "WARNING" : "BROKEN");
    const folder = folderHint(mod);
    rows.push({
      origin: mod.discovery === "DISK" ? "disk" : "folder",
      id: mod.id,
      name: displayName(mod),
      enabled: mod.enabled !== false,
      section: primaryKind(mod),
      lamp,
      lampLabel,
      lampDetail: mod.lampDetail || lampLabel,
      status,
      meta: [lampLabel, mod.discovery === "DISK" ? "Found in Duty folder" : folder, mod.lampDetail]
        .filter(Boolean)
        .join(" · "),
      raw: mod,
    });
  }
  return { rows, hiddenFolder: covered.size };
}

function currentModFilter() {
  const query = ($("mod-search") && $("mod-search").value) || "";
  const status = ($("mod-filter") && $("mod-filter").value) || "";
  return { query: query.trim().toLowerCase(), status };
}

function visibleUnifiedRows() {
  const { query, status } = currentModFilter();
  const { rows } = unifiedRows();
  return rows.filter((row) => {
    if (status === "ENABLED" && !row.enabled) return false;
    if (status === "DISABLED" && row.enabled) return false;
    if (status && status !== "ENABLED" && status !== "DISABLED" && row.status !== status) return false;
    if (!query) return true;
    const files = (row.raw.files || []).map((file) => (typeof file === "string" ? file : file.destination || "")).join(" ");
    const hay = [row.name, row.raw.canonicalModId, row.raw.category, files].join(" ").toLowerCase();
    return hay.includes(query);
  });
}

function canRepairRow(row) {
  if (row.origin !== "smart") return false;
  const health = modHealthById.get(row.id);
  const issues = (health && health.issues) || [];
  if (issues.some((issue) => issue.code === "MISSING_MANAGED_FILE" || issue.code === "STORE_MISSING")) return true;
  return Boolean(health && health.status === "BROKEN" && /missing/i.test((health.reasons || []).join(" ")));
}

function renderModCard(row) {
  const repair = canRepairRow(row) ? `<button class="ghost" data-act="repair" type="button">Repair</button>` : "";
  const manage =
    row.origin === "disk"
      ? ""
      : `<button class="ghost" data-act="toggle" type="button">${row.enabled ? "Disable" : "Enable"}</button>
        <button class="ghost" data-act="remove" type="button">Remove</button>`;
  return `
    <article class="mod ${row.enabled ? "" : "disabled"}" data-origin="${row.origin}" data-id="${escapeHtml(row.id)}">
      <i class="lamp ${row.lamp}" title="${escapeHtml(row.lampDetail || row.lampLabel)}"></i>
      <div class="mod-main">
        <h3>${escapeHtml(row.name)}</h3>
        <p>${escapeHtml(row.meta)}</p>
      </div>
      <div class="mod-actions">
        <button class="ghost" data-act="details" type="button">Details</button>
        ${repair}
        ${manage}
      </div>
    </article>
  `;
}

function renderAllMods() {
  if (!ui.mods) return;
  const { rows } = unifiedRows();
  const visible = visibleUnifiedRows();
  if (ui.modCount) ui.modCount.textContent = String(rows.length);
  if (ui.smartCount) ui.smartCount.textContent = String(rows.length);
  if (!rows.length) {
    ui.mods.innerHTML = `<p class="empty">Nothing installed yet. Drop a pack or plugin above.</p>`;
    return;
  }
  if (!visible.length) {
    ui.mods.innerHTML = `<p class="empty">No mods match that search.</p>`;
    return;
  }
  const groups = new Map(MOD_SECTIONS.map((section) => [section.id, []]));
  for (const row of visible) {
    const key = groups.has(row.section) ? row.section : "other";
    groups.get(key).push(row);
  }
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
  ui.mods.innerHTML = MOD_SECTIONS.map((section) => {
    const items = (groups.get(section.id) || []).sort(byName);
    if (!items.length) return "";
    return `
      <section class="mod-type" data-type="${section.id}">
        <header class="mod-type-head">
          <h3>${escapeHtml(section.title)}</h3>
          <span class="count">${items.length}</span>
        </header>
        <div class="mod-type-list">${items.map(renderModCard).join("")}</div>
      </section>
    `;
  }).join("");
}

function renderMods() {
  renderAllMods();
}

function conditionLine(analysis) {
  const todos = (analysis && analysis.todos) || (analysis && analysis.summary || []).filter((row) => row.nextStep && row.nextStep.needed);
  if (!analysis) return "Analyze mods lists only what you need to do.";
  if (todos.length) return todos.length === 1 ? "1 thing to do." : `${todos.length} things to do.`;
  const advice = (analysis.advice || []).filter((line) => line && line !== "Nothing you need to do.");
  if (advice.length) return advice.length === 1 ? "1 thing to do." : `${advice.length} things to do.`;
  const broken = Number((analysis.counts && analysis.counts.BROKEN) || 0);
  if (broken) return broken === 1 ? "1 thing to do." : `${broken} things to do.`;
  return "Nothing you need to do.";
}

function renderModCondition(analysis) {
  const line = $("mods-condition-line");
  if (line) line.textContent = conditionLine(analysis);
}

function showFolderModDetails(mod) {
  const reasons = mod.healthReasons || (mod.lampDetail ? [mod.lampDetail] : []);
  const foundOnDisk = mod.discovery === "DISK";
  showOverlay(`
    <p class="eyebrow">MOD</p>
    <h2>${escapeHtml(displayName(mod))}</h2>
    <p>${escapeHtml(mod.lampLabel || "Unknown")} — ${escapeHtml(mod.healthStatus || "")}</p>
    <ul>${reasons.map((row) => `<li>${escapeHtml(row)}</li>`).join("") || "<li>No extra notes.</li>"}</ul>
    ${mdtBlock(mod.mdt)}
    ${mod.keybinds ? `<h3>Keybinds</h3>${keybindBlock(mod.keybinds)}` : ""}
    <p class="muted">${
      foundOnDisk
        ? "Found in the Duty folder. It was not installed through Smart Install, so Enable / Remove stay off until you drop the official zip."
        : "This lamp is from local files and Duty logs. It is not a guarantee the next launch will work."
    }</p>
    <div class="dialog-actions"><button id="fd-close" class="ghost" type="button">Close</button></div>
  `);
  $("fd-close").onclick = hideOverlay;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderState(next) {
  state = next;
  const { config: cfg, game, mods } = next;

  ui.official.textContent = game.officialReady ? shortPath(cfg.officialPath) : "Not set";
  ui.sandbox.textContent = game.sandboxReady ? shortPath(cfg.sandboxPath) : cfg.sandboxPath ? "Not created yet" : "Not set";
  ui.rph.textContent = game.hasRage ? "Ready in LSPDFR folder" : "Drop LSPDFR Enhanced Preview";

  setLamp(ui.lampOfficial, game.officialReady ? "ok" : "bad");
  setLamp(ui.lampSandbox, game.sandboxReady ? "ok" : cfg.sandboxPath ? "warn" : "bad");
  setLamp(ui.lampRph, game.hasRage ? "ok" : "warn");

  ui.lspdfr.disabled = !game.sandboxReady || !game.hasRage || busy;
  ui.online.disabled = !game.officialReady || busy;

  const tests = next.tests;
  if (tests) {
    const lamp = tests.verdict === "ready" ? "ok" : tests.verdict === "caution" ? "warn" : "bad";
    setLamp(ui.lampHealth, lamp);
    ui.healthTitle.textContent =
      tests.verdict === "ready" ? "Ready" : tests.verdict === "caution" ? "Caution" : "Will likely fail";
    ui.healthDetail.textContent = tests.summary;
  } else {
    setLamp(ui.lampHealth, "");
    ui.healthTitle.textContent = "Not run yet";
    ui.healthDetail.textContent = "Create the LSPDFR folder, then run tests.";
  }

  renderMods(mods || []);
  renderModCondition(next.modAnalysis);
  renderLastSession(next.lastSession);
  renderRetestBanner(next.pendingRetest || (next.lastSession && next.lastSession.pendingRetest));
  renderActiveProfile(next.profile);
  applyPreviewDefault(next.config);
  const remembered = storedTheme();
  if (remembered) applyTheme(remembered);
  else if (cfg && cfg.theme) applyTheme(cfg.theme);
  renderDashboardLite(next);
}

function sessionTone(result) {
  if (result === "CLEAN_EXIT") return "ok";
  if (result === "LAUNCH_FAILED" || result === "TERMINATED") return "";
  if (result === "GAME_CRASH" || result === "RPH_CRASH" || result === "LSPDFR_CRASH") return "bad";
  return "warn";
}

function sessionLabel(result) {
  const map = {
    CLEAN_EXIT: "Clean Exit",
    GAME_CRASH: "Game Crash",
    RPH_CRASH: "RPH Crash",
    LSPDFR_CRASH: "LSPDFR Crash",
    LAUNCH_FAILED: "Launch Failed",
    TERMINATED: "Terminated",
    UNKNOWN: "Unknown",
  };
  return map[result] || "Unknown";
}

function formatDuration(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

function mdtRenderLamp(value) {
  const key = String(value || "").toUpperCase();
  if (key === "WORKING" || key === "DETECTED" || key === "INITIALIZED") return "ok";
  if (key === "FAILED") return "bad";
  return "warn";
}

function mdtBlock(info) {
  const data = info || null;
  if (!data || !data.plugin) return "";
  return `
    <h3>Callout Interface</h3>
    <p>Callout Interface: <i class="lamp ${data.plugin === "WORKING" ? "ok" : data.plugin === "FAILED" ? "bad" : "warn"}"></i> ${escapeHtml(data.plugin)}</p>
    <ul class="mdt-report">
      <li>MDT configuration: ${escapeHtml(data.mdt)}</li>
      <li>MDT input: <i class="lamp ${mdtRenderLamp(data.mdtInput)}"></i> ${escapeHtml(data.mdtInput || "UNVERIFIED")}</li>
      <li>MDT canvas: <i class="lamp ${mdtRenderLamp(data.mdtCanvas)}"></i> ${escapeHtml(data.mdtCanvas || "UNVERIFIED")}</li>
      <li>MDT rendering: <i class="lamp ${mdtRenderLamp(data.mdtRendering)}"></i> ${escapeHtml(data.mdtRendering || "UNVERIFIED")}</li>
      <li>Renderer: ${escapeHtml(data.renderer || "RawCanvasUI")}</li>
      <li>Graphics API: ${escapeHtml(data.graphicsApi || "UNKNOWN")}</li>
      <li>Last render error: ${escapeHtml(data.lastRenderError || "NONE")}</li>
      <li>Suggested fix: ${escapeHtml(data.suggestedFix || "NONE")}</li>
      <li>Toggle key: ${escapeHtml(data.toggleKey)}</li>
      <li>Vehicle only: ${escapeHtml(data.vehicleOnly)}</li>
      <li>Key conflict: ${escapeHtml(data.keyConflict)}</li>
    </ul>
    ${data.pressHint ? `<p class="muted">${escapeHtml(data.pressHint)}</p>` : ""}
  `;
}

function keybindBlock(info) {
  const data = info || {};
  const binds = data.binds || [];
  if (!binds.length) {
    return `<p class="muted">${escapeHtml(data.note || "No keybinds were found in this mod’s configs or notes.")}</p>`;
  }
  const rows = binds
    .map(
      (bind) => `
      <li class="keybind-row">
        <kbd>${escapeHtml(bind.keys)}</kbd>
        <div>
          <strong>${escapeHtml(bind.action)}</strong>
          ${bind.detail ? `<small>${escapeHtml(bind.detail)}</small>` : ""}
        </div>
      </li>`
    )
    .join("");
  return `
    <p class="muted">${escapeHtml(data.note || "")}</p>
    <ul class="keybind-list">${rows}</ul>
  `;
}

function renderActiveProfile(summary) {
  if (!ui.profileName) return;
  if (!summary || !summary.profile) {
    setLamp(ui.lampProfile, "");
    ui.profileName.textContent = "No profile yet";
    ui.profileDetail.textContent = "Create a profile from the current Duty setup.";
    return;
  }
  const health = summary.health || "HEALTHY";
  setLamp(ui.lampProfile, health === "HEALTHY" ? "ok" : health === "BROKEN" ? "bad" : "warn");
  ui.profileName.textContent = `${summary.profile.name}${summary.profile.knownGood ? " · Known Good" : ""}`;
  const drift = summary.drift && summary.drift.drifted ? " · Profile modified" : "";
  ui.profileDetail.textContent = `${summary.enabledCount || 0} mods enabled · ${health}${drift}`;
}

function developerMode() {
  if (state && state.config && state.config.developerMode) return true;
  try {
    return window.localStorage.getItem("tactix.dev") === "1";
  } catch {
    return false;
  }
}

function userError(error) {
  const raw = error && error.message ? String(error.message) : String(error || "Something went wrong.");
  if (/What happened|INSTALLATION FAILED|PROFILE INCOMPLETE|CONFIG CHANGED OUTSIDE/i.test(raw)) return raw;
  return `What happened\n${raw}\n\nWhy it matters\nThe last action did not finish.\n\nWhat you can do\nTry again, or use Recovery / Restore Known-Good Setup.`;
}

function showPage(page) {
  currentPage = page;
  const dash = $("page-dashboard");
  const mods = $("page-mods");
  const browse = $("page-browse");
  if (dash) dash.classList.toggle("hidden", page !== "dashboard");
  if (mods) mods.classList.toggle("hidden", page !== "mods");
  if (browse) browse.classList.toggle("hidden", page !== "browse");
  if (page === "dashboard") refreshDashboard();
  if (page === "mods") refreshSmart().catch((error) => addLog({ level: "error", message: userError(error) }));
  if (page === "browse") refreshWorkshop().catch((error) => addLog({ level: "error", message: userError(error) }));
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.page === page);
  });
  if (state && state.config && state.config.openLastPage) {
    window.tactix.settingsSave({ lastPage: page }).catch(() => {});
  }
}

function applyPreviewDefault(cfg) {
  if (!ui.smartToggle || previewDefaultApplied || !cfg) return;
  if (cfg.smartPreviewDefault) {
    ui.smartToggle.checked = true;
    previewDefaultApplied = true;
    return;
  }
  window.tactix
    .smartReadiness()
    .then((ready) => {
      if (ready && ready.ready && !previewDefaultApplied) {
        ui.smartToggle.checked = true;
        previewDefaultApplied = true;
      }
    })
    .catch(() => {});
}

function renderDashboardLite(next) {
  const duty = next.dutyHealth;
  if ($("dash-duty-title") && duty) {
    $("dash-duty-title").textContent = duty.status || "UNKNOWN";
    $("dash-duty-detail").textContent = (duty.reasons && duty.reasons[0]) || "Duty health from the last check.";
    setLamp($("dash-duty-lamp"), duty.status === "HEALTHY" ? "ok" : duty.status === "BROKEN" ? "bad" : "warn");
    $("dash-duty-reasons").innerHTML = (duty.reasons || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("");
  }
  if ($("dash-profile-name") && next.profile && next.profile.profile) {
    $("dash-profile-name").textContent = next.profile.profile.name;
    $("dash-profile-detail").textContent = `${next.profile.enabledCount || 0} mods enabled · ${next.profile.health || ""}`;
  }
  if ($("dash-session-title") && next.lastSession) {
    $("dash-session-title").textContent = sessionLabel(next.lastSession.result);
    $("dash-session-detail").textContent = formatDuration(next.lastSession.durationMs);
  }
}

async function refreshDashboard() {
  try {
    const dash = await window.tactix.dashboard();
    if ($("dash-duty-title") && dash.dutyHealth) {
      $("dash-duty-title").textContent = dash.dutyHealth.status;
      $("dash-duty-detail").textContent = (dash.dutyHealth.reasons || [])[0] || "";
      setLamp($("dash-duty-lamp"), dash.dutyHealth.status === "HEALTHY" ? "ok" : dash.dutyHealth.status === "BROKEN" ? "bad" : "warn");
      $("dash-duty-reasons").innerHTML = (dash.dutyHealth.reasons || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("");
    }
    if ($("dash-mod-counts") && dash.counts) {
      $("dash-mod-counts").textContent = `${dash.counts.HEALTHY + dash.counts.WARNING + dash.counts.BROKEN} enabled · ${dash.counts.DISABLED} disabled`;
      $("dash-mod-health").textContent = dash.counts.BROKEN
        ? `${dash.counts.BROKEN} broken`
        : dash.counts.WARNING
          ? `${dash.counts.WARNING} warning`
          : "No warnings";
    }
    if ($("dash-alerts")) {
      const alerts = dash.alerts || [];
      $("dash-alerts").innerHTML = alerts.length
        ? alerts
            .slice(0, 6)
            .map((row) => `<li><strong>${escapeHtml(row.title)}</strong> — ${escapeHtml(row.detail)}</li>`)
            .join("")
        : `<li class="muted">Nothing needs attention.</li>`;
    }
    if ($("dash-recent")) {
      $("dash-recent").innerHTML = (dash.recentChanges || []).length
        ? dash.recentChanges
            .map((row) => `<li>${escapeHtml(row.event || "")} ${escapeHtml(row.name || row.installId || "")}</li>`)
            .join("")
        : `<li class="muted">No recent manager activity.</li>`;
    }
    if ($("dash-app-health")) {
      $("dash-app-health").textContent = `Mod Manager Health: ${dash.appHealth || "Unknown"} · Duty Health: ${(dash.dutyHealth && dash.dutyHealth.status) || "Unknown"}`;
    }
    if (state && state.profile && state.profile.profile && $("dash-profile-name")) {
      $("dash-profile-name").textContent = state.profile.profile.name;
      $("dash-profile-detail").textContent = `${state.profile.enabledCount || 0} mods enabled · ${state.profile.health || ""}`;
    }
    if (state && state.lastSession && $("dash-session-title")) {
      $("dash-session-title").textContent = sessionLabel(state.lastSession.result);
      $("dash-session-detail").textContent = formatDuration(state.lastSession.durationMs);
    }
  } catch (error) {
    addLog({ level: "error", message: userError(error) });
  }
}

function renderRetestBanner(pending) {
  if (!ui.retestBanner) return;
  const action = pending && pending.action;
  if (!action) {
    ui.retestBanner.classList.add("hidden");
    ui.retestBanner.innerHTML = "";
    return;
  }
  if (action.state === "RETEST_COMPLETED" && !action.resolution) {
    ui.retestBanner.classList.remove("hidden");
    ui.retestBanner.innerHTML = renderCompletedRetest(action);
    bindRetestBannerActions(action);
    return;
  }
  if (action.state !== "APPLIED" && action.state !== "RETEST_LAUNCHED") {
    ui.retestBanner.classList.add("hidden");
    ui.retestBanner.innerHTML = "";
    return;
  }
  ui.retestBanner.classList.remove("hidden");
  const launchFailed = action.retest && action.retest.outcome === "LAUNCH_FAILED";
  ui.retestBanner.innerHTML = `
    <p class="eyebrow">RETEST MODE</p>
    <p>Testing: ${escapeHtml((action.changes && action.changes[0]) || action.targetName || action.type)}</p>
    <p>Original crash: ${escapeHtml(formatWhen((action.snapshot && action.snapshot.createdAt) || "") || action.sessionId)}</p>
    ${launchFailed ? "<p>Test change was applied, but LSPDFR did not launch.</p>" : ""}
    <div class="row-actions">
      ${action.state === "APPLIED" ? `<button id="retest-continue" type="button">Continue retest</button>` : ""}
      <button id="retest-restore" class="ghost" type="button">Restore previous state</button>
    </div>
  `;
  const cont = $("retest-continue");
  if (cont) cont.onclick = () => $("btn-lspdfr").click();
  bindRetestBannerActions(action);
}

function renderCompletedRetest(action) {
  const outcome = action.retest && action.retest.outcome;
  if (outcome === "CRASH_REPRODUCED") {
    return `
      <p class="eyebrow">CRASH REPRODUCED</p>
      <p>The same crash occurred with ${escapeHtml(action.targetName || "the tested change")} applied. This weakens it as the primary suspect.</p>
      <div class="row-actions"><button id="retest-restore" class="ghost" type="button">Restore previous state</button></div>
    `;
  }
  if (outcome === "LAUNCH_FAILED") {
    return `
      <p class="eyebrow">LAUNCH FAILED</p>
      <p>Test change was applied, but LSPDFR did not launch.</p>
      <div class="row-actions"><button id="retest-restore" class="ghost" type="button">Restore previous state</button></div>
    `;
  }
  if (outcome === "NO_CRASH_OBSERVED") {
    return `
      <p class="eyebrow">RETEST COMPLETE</p>
      <p>Crash was not observed. This strengthens ${escapeHtml(action.targetName || "the suspect")} as a suspect but does not prove causation.</p>
      <div class="row-actions">
        <button id="retest-keep" type="button">${action.type === "DISABLE_MOD_AND_RETEST" ? "Keep disabled" : "Keep this state"}</button>
        <button id="retest-restore" class="ghost" type="button">Restore previous state</button>
      </div>
    `;
  }
  return `
    <p class="eyebrow">RETEST INCOMPLETE</p>
    <p>${escapeHtml((action.retest && action.retest.summary) || "There is not enough evidence to classify this retest.")}</p>
    <div class="row-actions"><button id="retest-restore" class="ghost" type="button">Restore previous state</button></div>
  `;
}

function bindRetestBannerActions(action) {
  const keep = $("retest-keep");
  if (keep) {
    keep.onclick = async () => {
      try {
        await window.tactix.crashActionKeep(action.actionId);
        await refresh();
      } catch (error) {
        addLog({ level: "error", message: error.message });
      }
    };
  }
  const restore = $("retest-restore");
  if (restore) {
    restore.onclick = async () => {
      try {
        await window.tactix.crashActionRestore(action.actionId);
        await refresh();
      } catch (error) {
        addLog({ level: "error", message: error.message });
      }
    };
  }
}

function renderLastSession(session) {
  if (!ui.sessionResult) return;
  if (!session) {
    setLamp(ui.lampSession, "");
    ui.sessionResult.textContent = "No session yet";
    ui.sessionDetail.textContent = "Launch Duty to start recording evidence.";
    return;
  }
  setLamp(ui.lampSession, sessionTone(session.result));
  ui.sessionResult.textContent = sessionLabel(session.result);
  const analysis = session.analysis;
  if (analysis && analysis.suspectName) {
    ui.sessionDetail.textContent = `Last crash: Likely suspect — ${analysis.suspectName} · Confidence — ${confidenceLabel(analysis.suspectConfidence)}`;
    return;
  }
  ui.sessionDetail.textContent = `${formatDuration(session.durationMs)} · ${session.enabledModCount || 0} mods`;
}

function confidenceLabel(value) {
  const map = { HIGH: "High", MEDIUM: "Medium", LOW: "Low", WEAK: "Weak", UNKNOWN: "Unknown" };
  return map[value] || value || "Unknown";
}

async function refresh() {
  renderState(await window.tactix.state());
}

async function refreshScreen() {
  if (busy) return;
  showOverlay(`
    <p class="eyebrow">REFRESH</p>
    <h2>Updating the manager</h2>
    <p>Reloading folders, mods, profiles, and status. The game is not closed.</p>
  `);
  try {
    busy = true;
    await refresh();
    await refreshSmart();
    await refreshDashboard();
    if (currentPage === "browse") await refreshWorkshop();
    addLog({ level: "ok", message: "Manager refreshed." });
  } catch (error) {
    addLog({ level: "error", message: userError(error) });
  } finally {
    busy = false;
    if (state) renderState(state);
    hideOverlay();
  }
}

function setupForm(seed = {}) {
  const official = seed.officialPath || seed.path || state?.config.officialPath || "";
  const sandboxPath = seed.sandboxPath || seed.suggestedSandbox || state?.config.sandboxPath || "";
  const launcher = seed.launcher || state?.config.launcher || "unknown";
  const cloneMode = seed.cloneMode || state?.config.cloneMode || "linked";

  showOverlay(`
    <h2>Setup</h2>
    <p>GTA 5 Mod Manager keeps GTA Online in your official Enhanced folder and installs LSPDFR into a second folder.</p>
    <div class="field">
      <label>Official Enhanced folder (Online)</label>
      <div class="field-row">
        <input id="setup-official" value="${escapeHtml(official)}" />
        <button id="pick-official" class="ghost" type="button">Browse</button>
      </div>
    </div>
    <div class="field">
      <label>LSPDFR folder</label>
      <div class="field-row">
        <input id="setup-sandbox" value="${escapeHtml(sandboxPath)}" />
        <button id="pick-sandbox" class="ghost" type="button">Browse</button>
      </div>
    </div>
    <div class="field">
      <label>Launcher</label>
      <select id="setup-launcher">
        <option value="steam"${launcher === "steam" ? " selected" : ""}>Steam</option>
        <option value="rockstar"${launcher === "rockstar" ? " selected" : ""}>Rockstar Launcher</option>
        <option value="epic"${launcher === "epic" ? " selected" : ""}>Epic Games</option>
        <option value="unknown"${launcher === "unknown" ? " selected" : ""}>Auto / unknown</option>
      </select>
    </div>
    <div class="field">
      <label>Native archive backend</label>
      <p class="muted">Available: ${escapeHtml((state && state.archiveBackend && state.archiveBackend.available ? "Yes" : "No") || "No")}<br />
      Mode: ${escapeHtml((state && state.archiveBackend && state.archiveBackend.mode) || "READ_ONLY")}<br />
      Real GTA archives: ${escapeHtml((state && state.archiveBackend && state.archiveBackend.realGtaArchives ? "Supported (read-only OPEN RPF7)" : "No") || "No")}<br />
      Writes: Disabled<br />
      Vehicle install layer: Unsupported</p>
    </div>
    <div class="field">
      <label>Copy mode</label>
      <select id="setup-mode">
        <option value="linked"${cloneMode === "linked" ? " selected" : ""}>Linked copy (saves space, same drive)</option>
        <option value="full"${cloneMode === "full" ? " selected" : ""}>Full copy (uses much more disk)</option>
      </select>
    </div>
    <div class="dialog-actions">
      <button id="setup-detect" class="ghost" type="button">Detect game</button>
      <button id="setup-create" class="primary" type="button">Create LSPDFR folder</button>
      <button id="setup-close" class="ghost" type="button">Close</button>
    </div>
  `);

  $("pick-official").onclick = async () => {
    const folder = await window.tactix.pickFolder("Select official GTA V Enhanced folder");
    if (!folder) return;
    const inspected = await window.tactix.inspect(folder);
    if (!inspected.ok) {
      addLog({ level: "error", message: inspected.reason });
      return;
    }
    $("setup-official").value = folder;
    $("setup-launcher").value = inspected.launcher;
    if (!$("setup-sandbox").value && inspected.suggestedSandbox) {
      $("setup-sandbox").value = inspected.suggestedSandbox;
    }
  };

  $("pick-sandbox").onclick = async () => {
    const folder = await window.tactix.pickFolder("Select or create the LSPDFR folder location");
    if (folder) $("setup-sandbox").value = folder;
  };

  $("setup-detect").onclick = async () => {
    const found = await window.tactix.detectGame();
    if (!found.found) {
      addLog({ level: "error", message: "Could not find GTA V Enhanced automatically. Browse to GTA5_Enhanced.exe." });
      return;
    }
    $("setup-official").value = found.path;
    $("setup-sandbox").value = found.sandboxPath;
    $("setup-launcher").value = found.launcher;
    addLog({ level: "ok", message: `Found Enhanced at ${found.path}` });
  };

  $("setup-close").onclick = hideOverlay;

  $("setup-create").onclick = async () => {
    try {
      setBusy(true, "Saving setup…");
      await window.tactix.saveSetup({
        officialPath: $("setup-official").value.trim(),
        sandboxPath: $("setup-sandbox").value.trim(),
        launcher: $("setup-launcher").value,
        cloneMode: $("setup-mode").value,
      });
      showProgress("Creating LSPDFR folder", "Linking official game files into the second folder. This can take a few minutes.");
      const result = await window.tactix.createSandbox();
      renderState(result.state);
      hideOverlay();
      addLog({ level: "ok", message: "LSPDFR folder is ready. Drop LSPDFR Enhanced Preview next." });
    } catch (error) {
      addLog({ level: "error", message: error.message });
      hideOverlay();
      setupForm();
    } finally {
      setBusy(false);
    }
  };
}

function showProgress(title, detail) {
  showOverlay(`
    <h2>${escapeHtml(title)}</h2>
    <p id="progress-detail">${escapeHtml(detail)}</p>
    <div class="progress"><i id="progress-bar"></i></div>
    <p id="progress-count">Starting…</p>
  `);
}

function updateProgress(progress) {
  const bar = $("progress-bar");
  const count = $("progress-count");
  if (!bar || !progress.total) return;
  const pct = Math.round((progress.done / progress.total) * 100);
  bar.style.width = `${pct}%`;
  if (count) count.textContent = `${progress.done} / ${progress.total} · ${progress.file || ""}`;
}

function setBusy(next, message) {
  busy = next;
  if (state) renderState(state);
  if (next && message) addLog({ level: "info", message });
}

function showPlan(plan) {
  const folders = plan.folders
    .map((folder) => `<li>${escapeHtml(folder.name)} — ${folder.count} files</li>`)
    .join("");
  const warnings = (plan.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const notes = (plan.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("");

  showOverlay(`
    <h2>Install ${escapeHtml(plan.archiveName)}</h2>
    ${kindBadges(plan.kindLabels)}
    <p>${plan.fileCount} files will be copied into the LSPDFR folder only. The Online folder stays clean.</p>
    <ul>${folders}</ul>
    ${notes ? `<ul class="notes">${notes}</ul>` : ""}
    ${warnings ? `<ul class="warnings">${warnings}</ul>` : ""}
    <div class="dialog-actions">
      <button id="plan-yes" class="primary" type="button">Install</button>
      <button id="plan-no" class="ghost" type="button">Cancel</button>
    </div>
  `, true);

  $("plan-no").onclick = async () => {
    await window.tactix.cancelPlan(plan.id);
    hideOverlay();
  };

  $("plan-yes").onclick = async () => {
    try {
      setBusy(true);
      showProgress("Installing", plan.archiveName);
      const result = await window.tactix.commit(plan.id);
      renderState(result.state);
      hideOverlay();
    } catch (error) {
      addLog({ level: "error", message: error.message });
      hideOverlay();
    } finally {
      setBusy(false);
    }
  };
}

function compatibilityLabel(status) {
  switch (String(status || "UNKNOWN").toUpperCase()) {
    case "VERIFIED":
      return "Verified";
    case "LIKELY_COMPATIBLE":
      return "Likely Compatible";
    case "WARNING":
      return "Warning";
    case "INCOMPATIBLE":
      return "Incompatible";
    default:
      return "Unknown";
  }
}

function primarySmartKind(mod) {
  const hay = [
    mod.type,
    mod.category,
    mod.canonicalModId,
    ...((mod.files || []).map((file) => file.destination || file)),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\\/g, "/");
  if (hay.includes("plugins/lspdfr") || hay.includes("lspdfr_plugin")) return "lspdfr";
  if (hay.includes("rage_plugin") || hay.includes("ragepluginhook") || hay.includes("rage plugin")) return "rage";
  if (hay.includes("dependency") || /ragenativeui|lemonui|ifruit|damagetracker/.test(hay)) return "dependency";
  if (/\.asi\b/.test(hay) || hay.includes("/scripts/") || hay.includes("asi") || hay.includes("script")) return "script";
  if (hay.includes("vehicle") || hay.includes("dlcpack") || /\.yft|\.ytd/.test(hay)) return "vehicle";
  if (hay.includes("map") || hay.includes("ymap")) return "map";
  if (hay.includes("audio") || hay.includes("awc")) return "audio";
  if (hay.includes("els")) return "els";
  for (const section of SMART_SECTIONS) {
    if (section.id === "other") continue;
    if (section.match.some((token) => hay.includes(token))) return section.id;
  }
  return "other";
}

function renderSmartMods() {
  renderAllMods();
}

async function refreshSmart() {
  try {
    smartMods = await window.tactix.smartList();
    const health = await window.tactix.modsHealth();
    modHealthById = new Map((health || []).map((row) => [row.installId, row]));
  } catch {
    smartMods = [];
  }
  renderAllMods();
}

function severityMeta(sev) {
  switch (sev) {
    case "BLOCKED":
      return { cls: "bad", text: "Blocked" };
    case "HIGH_RISK":
      return { cls: "bad", text: "High risk" };
    case "WARNING":
      return { cls: "warn", text: "Warnings" };
    case "SAFE_REPLACEMENT":
      return { cls: "ok", text: "Safe" };
    default:
      return { cls: "ok", text: "Clean" };
  }
}

function planList(items) {
  if (!items.length) return `<p class="empty">None.</p>`;
  const max = 40;
  const rows = items
    .slice(0, max)
    .map((f) => {
      const reason = f.reason ? ` <span class="muted">— ${escapeHtml(f.reason)}</span>` : "";
      return `<li><code>${escapeHtml(f.destination)}</code><span class="badge">${escapeHtml(f.category)}</span>${reason}</li>`;
    })
    .join("");
  const more = items.length > max ? `<li class="muted">+${items.length - max} more…</li>` : "";
  return `<ul class="plan-list">${rows}${more}</ul>`;
}

// Shows the Smart Install preview. Resolves true if the user chooses Install.
function lampForStatus(status) {
  if (status === "VERIFIED" || status === "LIKELY_COMPATIBLE" || status === "INSTALLED" || status === "BUNDLED" || status === "SAFE" || status === "SAFE_TO_INSTALL") {
    return "ok";
  }
  if (status === "INCOMPATIBLE" || status === "BLOCKED" || status === "NOT_RECOMMENDED") return "bad";
  if (status === "UNSUPPORTED") return "warn";
  if (status === "UNKNOWN") return "warn";
  return "warn";
}

function findingList(title, items, emptyText) {
  if (!items || !items.length) {
    return `<h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(emptyText || "None.")}</p>`;
  }
  return `<h3>${escapeHtml(title)}</h3><ul class="check-list">${items
    .map(
      (item) =>
        `<li><i class="lamp ${lampForStatus(item.status || item.level)}"></i><div><strong>${escapeHtml(
          item.message || item.name || ""
        )}</strong>${item.why && item.why !== item.message ? `<small>${escapeHtml(item.why)}</small>` : ""}</div></li>`
    )
    .join("")}</ul>`;
}

function recommendationCopy(status) {
  switch (status) {
    case "SAFE_TO_INSTALL":
      return { cls: "ok", title: "SAFE TO INSTALL", button: "Install" };
    case "NOT_RECOMMENDED":
      return { cls: "bad", title: "NOT RECOMMENDED", button: "Install Anyway" };
    case "BLOCKED":
      return { cls: "bad", title: "INSTALLATION BLOCKED", button: "Install disabled" };
    case "UNSUPPORTED":
      return { cls: "warn", title: "UNSUPPORTED — DRY RUN ONLY", button: "Install disabled" };
    default:
      return { cls: "warn", title: "INSTALL WITH WARNING", button: "Install Anyway" };
  }
}

function offerForDep(preview, dep) {
  return ((preview && preview.downloadOffers) || []).find(
    (offer) => offer.id === dep.modId || String(offer.name).toLowerCase() === String(dep.name || "").toLowerCase()
  );
}

function depActionButtons(offer, dep) {
  if (!offer) return "";
  if (dep && (dep.state === "INSTALLED" || dep.state === "BUNDLED")) return "";
  if (dep && dep.state === "DISABLED") {
    return `<small>Parked in Duty. Enable it from Smart Install if this plugin should use it.</small>`;
  }
  const bits = [];
  if (offer.note) bits.push(`<small>${escapeHtml(offer.note)}</small>`);
  if (offer.sourceLabel) bits.push(`<small>${escapeHtml(offer.sourceLabel)}</small>`);
  const actions = [];
  if (offer.canDownload) {
    actions.push(
      `<button type="button" class="primary" data-dep-download="${escapeHtml(offer.id)}">Download &amp; install</button>`
    );
  }
  if (offer.pageUrl) {
    actions.push(
      `<button type="button" class="ghost" data-dep-page="${escapeHtml(offer.pageUrl)}">Open download page</button>`
    );
  }
  return `${bits.join("")}${actions.length ? `<div class="dep-actions">${actions.join("")}</div>` : ""}`;
}

function installGuideBlock(guide) {
  if (!guide || !(guide.steps || []).length) {
    return `<h3>How to install for LSPDFR</h3><p class="muted">No install notes yet. Tick Preview first so the app can read the pack’s README and any known public notes.</p>`;
  }
  const source = (guide.sources || []).length
    ? `<p class="fineprint">${guide.usedAi ? "AI summary from " : "From "}${escapeHtml(guide.sources.join(" · "))}</p>`
    : "";
  const extra = [];
  if ((guide.needs || []).length) extra.push(`Needs: ${guide.needs.join(", ")}`);
  if ((guide.conflicts || []).length) extra.push(`Often conflicts with: ${guide.conflicts.join(", ")}`);
  return `
    <h3>How to install for LSPDFR</h3>
    ${guide.title ? `<p><strong>${escapeHtml(guide.title)}</strong></p>` : ""}
    <ol class="guide-steps">${guide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    ${extra.length ? `<p class="muted">${escapeHtml(extra.join(" · "))}</p>` : ""}
    ${source}
  `;
}

function vehiclePreviewBlock(preview) {
  const vehicle = preview.vehicle;
  if (!vehicle || !vehicle.detected) return "";
  const text = (vehicle.preview && vehicle.preview.text) || "";
  const plan = vehicle.plan || preview.archivePlan || {};
  const groups = vehicle.groups || [];
  const evidence = ((vehicle.classification && vehicle.classification.evidence) || []).concat(
    groups.flatMap((g) => (g.slotEvidence || []).map((e) => `${e.source}: ${e.evidence || e.slot || ""}`))
  );
  const ops = (plan.archiveOperations || [])
    .map((op) => `${op.action} ${op.entry || "UNKNOWN"} (${op.status})`)
    .join("\n");
  return `
    <h3>Vehicle mod detected</h3>
    <p>✓ assets recognized<br />✓ slot detected<br />✓ metadata detected</p>
    <p><strong>Automatic installation:</strong> Unavailable for encrypted GTA V Enhanced archives. This is not an OpenIV replacement.</p>
    <pre class="vehicle-preview">${escapeHtml(text)}</pre>
    <h3>Technical details — vehicle</h3>
    <p class="muted">
      classification ${escapeHtml(vehicle.kind || "")}<br />
      slots ${escapeHtml(groups.map((g) => `${g.slot} (${g.confidence})`).join(", ") || "none")}<br />
      path resolution ${escapeHtml((vehicle.pathResolutions || []).map((r) => `${r.slot}: ${r.status}`).join(", ") || "none")}<br />
      planned operations ${escapeHtml(String((plan.archiveOperations || []).length))}<br />
      archiveRequired ${preview.archiveRequired ? "true" : "false"}
    </p>
    ${
      evidence.length
        ? `<ul class="check-list">${evidence
            .slice(0, 12)
            .map((line) => `<li><i class="lamp warn"></i><div><small>${escapeHtml(line)}</small></div></li>`)
            .join("")}</ul>`
        : ""
    }
    ${ops ? `<pre class="vehicle-preview">${escapeHtml(ops)}</pre>` : ""}
    ${
      (plan.ownershipConflicts || []).length
        ? `<h3>Archive ownership</h3><ul class="check-list">${plan.ownershipConflicts
            .map((c) => `<li><i class="lamp warn"></i><div><small>${escapeHtml(c.message)}</small></div></li>`)
            .join("")}</ul>`
        : ""
    }
  `;
}

function identityBlock(preview) {
  const recognition = preview.recognition || {};
  const pct = Math.round((recognition.confidence || 0) * 100);
  if (recognition.ambiguous && (recognition.candidates || []).length) {
    return `<h3>Ambiguous identity</h3><p>Could be:</p><ul class="check-list">${recognition.candidates
      .map((c) => `<li><div><strong>${escapeHtml(c.name)}</strong><small>${Math.round((c.confidence || 0) * 100)}%</small></div></li>`)
      .join("")}</ul><p class="muted">The manager will install this as an unknown/generic mod unless identity is confirmed.</p>`;
  }
  if (!recognition.modId) {
    return `<h3>Unknown mod</h3><p>Smart Install understands the package structure but does not have a verified identity for this mod.</p>
      <p>Type: <strong>${escapeHtml(preview.type || "Mod")}</strong><br />Installation safety: ${escapeHtml(
        (preview.installSafety && preview.installSafety.status) || "UNKNOWN"
      )}<br />Compatibility: ${escapeHtml((preview.compatibility && preview.compatibility.status) || "UNKNOWN")}</p>
      <p class="muted">${
        preview.archiveRequired
          ? "This mod type is recognized, but this build cannot yet install encrypted archive modifications automatically."
          : "The mod can still be installed using generic Smart Install rules."
      }</p>`;
  }
  if (recognition.band === "LOW") {
    return `<h3>Low-confidence match</h3><p>Possible match: ${escapeHtml(recognition.name)}<br />Confidence: ${pct}%</p>
      <p class="muted">This is not treated as a confirmed identity.</p>`;
  }
  return `<p>${escapeHtml(preview.type || "Mod")} · ${escapeHtml(recognition.name || "")} · Recognition: ${escapeHtml(
    recognition.band || "UNKNOWN"
  )} · Version: ${escapeHtml(preview.droppedVersion || "UNKNOWN")}</p>`;
}

function relationBlock(preview) {
  const dup = preview.duplicate || {};
  if (!dup.alreadyInstalled) return "";
  const installed = (dup.installed && dup.installed.version) || "UNKNOWN";
  const dropped = (dup.dropped && dup.dropped.version) || preview.droppedVersion || "UNKNOWN";
  if (dup.relation === "UPDATE") {
    const detected = preview.updateDetected;
    const review = preview.updateReview || {};
    if (detected) {
      const risk = detected.risk || {};
      return `<h3>UPDATE DETECTED</h3>
        <p>Installed: ${escapeHtml(detected.installedVersion)}<br />Dropped: ${escapeHtml(detected.droppedVersion)}<br />Known-good: ${escapeHtml(detected.knownGoodVersion || "none")}</p>
        <p>Changes:<br />• ${detected.changes.filesReplaced} files replaced<br />• ${detected.changes.newDependencies} new dependency<br />• config ${detected.changes.configPreserved ? "preserved" : "may change"}<br />• compatibility ${escapeHtml(detected.changes.compatibility)}</p>
        <p><strong>Update risk: ${escapeHtml(risk.level || "UNKNOWN")}</strong><br />${(risk.reasons || []).map((row) => escapeHtml(row)).join("<br />")}</p>`;
    }
    return `<h3>UPDATE DETECTED</h3><p>Installed: ${escapeHtml(installed)}<br />Dropped: ${escapeHtml(dropped)}</p>
      <p class="muted">Added ${(review.added || []).length} · Replaced ${(review.replaced || []).length} · Removed ${(review.removed || []).length} · Configs preserved ${(review.configsPreserved || []).length}</p>`;
  }
  if (dup.relation === "DOWNGRADE") {
    return `<h3>Older version detected</h3><p>Installed: ${escapeHtml(installed)}<br />Dropped: ${escapeHtml(dropped)}</p><p>Downgrading may restore older files or configuration.</p>`;
  }
  return `<h3>Already installed</h3><p>Installed version: ${escapeHtml(installed)}<br />Dropped version: ${escapeHtml(dropped)}</p>`;
}

function confirmSmartPreview(preview) {
  return new Promise((resolve) => {
    const files = preview.files || [];
    const adds = files.filter((f) => f.action === "add");
    const reps = files.filter((f) => f.action === "replace");
    const skips = files.filter((f) => f.action === "skip");
    const sev = (preview.conflicts && preview.conflicts.severity) || "NONE";
    const recommendation = preview.recommendation || { status: sev === "BLOCKED" ? "BLOCKED" : "INSTALL_WITH_WARNING", reasons: [] };
    const blocked = recommendation.status === "BLOCKED" || sev === "BLOCKED";
    const unsupported = recommendation.status === "UNSUPPORTED" || preview.archiveRequired;
    const rec = recommendationCopy(blocked ? "BLOCKED" : recommendation.status);
    const installDisabled = blocked || unsupported;
    const recognition = preview.recognition || {};
    const compat = preview.compatibility && !Array.isArray(preview.compatibility)
      ? preview.compatibility
      : { status: "UNKNOWN", findings: [] };
    const safety = preview.installSafety || { status: "SAFE", findings: [] };
    const resolved = preview.resolvedDependencies || [];
    const readmeBits = preview.readmeEvidence || [];
    const fileConflicts = ((preview.conflicts && preview.conflicts.items) || []).filter(
      (i) => i.level !== "NONE" && i.level !== "SAFE_REPLACEMENT" && i.code !== "dependency" && i.code !== "compatibility"
    );
    const visibleCompat = (compat.findings || []).filter((f) => f.severity !== "INFO" || f.code === "GTA_ENHANCED" || /_VERSION/.test(f.code));
    const blockedWhy = (safety.findings || []).filter((f) => f.status === "BLOCKED");
    const relation = (preview.duplicate && preview.duplicate.relation) || "NEW";
    let button = rec.button;
    if (!installDisabled && relation === "SAME") button = "Reinstall";
    if (!installDisabled && relation === "UPDATE") button = "Review Update";
    const diffs = preview.configDiffs || [];

    showOverlay(
      `
      <h2>Smart Install — ${escapeHtml(preview.name)}</h2>
      ${identityBlock(preview)}
      ${installGuideBlock(preview.installGuide)}
      ${vehiclePreviewBlock(preview)}
      ${relationBlock(preview)}
      <div class="rec-banner">
        <p><span class="sev ${rec.cls}">${rec.title}</span></p>
        <ul class="check-list">${(recommendation.reasons || []).map((r) => `<li><div><small>${escapeHtml(r)}</small></div></li>`).join("")}</ul>
      </div>
      ${
        blocked
          ? `<h3>Installation blocked</h3><p>${escapeHtml(
              (blockedWhy[0] && blockedWhy[0].message) ||
                (fileConflicts.find((i) => i.level === "BLOCKED") || {}).message ||
                "This package cannot be installed safely. No files have been changed."
            )}</p>`
          : ""
      }
      ${findingList("Compatibility", visibleCompat, "No compatibility evidence yet.")}
      ${
        resolved.length
          ? `<h3>Dependencies</h3><ul class="check-list">${resolved
              .map((d) => {
                const lamp =
                  d.state === "INSTALLED" || d.state === "BUNDLED"
                    ? "ok"
                    : d.kind === "REQUIRED" && (d.state === "MISSING" || d.state === "DISABLED")
                      ? "bad"
                      : "warn";
                const ver =
                  d.state === "BUNDLED"
                    ? d.bundledVersion && d.bundledVersion !== "UNKNOWN"
                      ? ` ${d.bundledVersion} (bundled)`
                      : " (bundled)"
                    : d.installedVersion && d.installedVersion !== "UNKNOWN"
                      ? ` ${d.installedVersion}`
                      : "";
                return `<li><i class="lamp ${lamp}"></i><div><strong>${escapeHtml(d.name)}${escapeHtml(
                  ver
                )}</strong><small>${escapeHtml(d.kind)} · ${escapeHtml(d.state)}</small>${depActionButtons(
                  offerForDep(preview, d),
                  d
                )}</div></li>`;
              })
              .join("")}</ul>`
          : "<h3>Dependencies</h3><p class=\"muted\">None recorded.</p>"
      }
      ${findingList("Conflicts", fileConflicts.map((i) => ({ status: i.level, message: i.message })), "None")}
      ${findingList("Install safety", (safety.findings || []).filter((f) => f.severity !== "INFO" || f.code === "ROLLBACK_AVAILABLE"), "Rollback available.")}
      ${
        diffs.length
          ? `<h3>Configuration changes</h3>${diffs
              .map(
                (d) =>
                  `<p><code>${escapeHtml(d.destination)}</code></p><div class="diff-block"><div><small>Existing</small><pre>${escapeHtml(
                    d.existing || ""
                  )}</pre></div><div><small>Incoming</small><pre>${escapeHtml(d.incoming || "")}</pre></div></div>`
              )
              .join("")}`
          : ""
      }
      ${
        readmeBits.length
          ? `<h3>Technical details — README evidence</h3><ul class="check-list">${readmeBits
              .map(
                (r) =>
                  `<li><i class="lamp warn"></i><div><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(
                    r.file || "README"
                  )} · ${escapeHtml(r.kind)} · ${escapeHtml(r.version || "UNKNOWN")} · ${escapeHtml(r.evidence || "")}</small></div></li>`
              )
              .join("")}</ul>`
          : ""
      }
      <h3>New files (${adds.length})</h3>
      ${planList(adds)}
      ${reps.length ? `<h3>Replaces (${reps.length}) — originals backed up</h3>${planList(reps)}` : ""}
      ${
        skips.filter((f) => f.archiveRequired).length
          ? `<h3>Archive assets not copied (${skips.filter((f) => f.archiveRequired).length})</h3>${planList(
              skips.filter((f) => f.archiveRequired)
            )}`
          : ""
      }
      ${
        skips.filter((f) => !f.archiveRequired).length
          ? `<h3>Skipped to protect the launch (${skips.filter((f) => !f.archiveRequired).length})</h3>${planList(
              skips.filter((f) => !f.archiveRequired)
            )}`
          : ""
      }
      <h3>Technical details</h3>
      <p class="muted">
        analysisId ${escapeHtml(preview.analysisId || "")}<br />
        installId ${escapeHtml(preview.installId || preview.id || "")}<br />
        canonicalModId ${escapeHtml(preview.canonicalModId || "null")}<br />
        archive hash ${escapeHtml(preview.sourceArchiveHash || "")}<br />
        config policy ${escapeHtml(preview.configPolicy || "KEEP_EXISTING")}
      </p>
      <div class="dialog-actions">
        <button id="smart-install" class="primary" type="button" ${installDisabled ? "disabled" : ""}>${
          installDisabled ? rec.button : button
        }</button>
        <button id="smart-cancel" class="ghost" type="button">Cancel</button>
      </div>
    `,
      true
    );

    $("smart-cancel").onclick = () => resolve({ action: "cancel" });
    const install = $("smart-install");
    if (install && !installDisabled) {
      install.onclick = () => {
        if (recommendation.status === "NOT_RECOMMENDED" || relation === "DOWNGRADE") {
          const ok = window.confirm(
            relation === "DOWNGRADE"
              ? "This package is older than the installed version. Continue anyway?"
              : "This install is not recommended. Continue anyway?"
          );
          if (!ok) return;
        }
        resolve({ action: "install" });
      };
    }
    ui.dialog.querySelectorAll("[data-dep-page]").forEach((button) => {
      button.onclick = () => {
        window.tactix.depOpenPage(button.dataset.depPage).catch((error) => {
          addLog({ level: "error", message: userError(error) });
        });
      };
    });
    ui.dialog.querySelectorAll("[data-dep-download]").forEach((button) => {
      button.onclick = async () => {
        const offer = (preview.downloadOffers || []).find((row) => row.id === button.dataset.depDownload);
        if (!offer) return;
        const ok = window.confirm(
          `Download ${offer.name} from ${offer.sourceLabel || "its official source"} and install it into the Duty LSPDFR folder only?\n\nNothing is written to the official Steam / Online folder.`
        );
        if (!ok) return;
        button.disabled = true;
        showProgress("Downloading", offer.name);
        try {
          const result = await window.tactix.depDownloadInstall({ modId: offer.id });
          if (!result || !result.ok) throw new Error((result && result.message) || `Could not install ${offer.name}.`);
          addLog({ level: "ok", message: `Installed ${result.name} into Duty.` });
          await window.tactix.smartCancel(preview.id).catch(() => {});
          const next = await window.tactix.smartAnalyze(preview.source);
          resolve({ action: "refresh", preview: next });
        } catch (error) {
          addLog({ level: "error", message: userError(error) });
          window.alert(userError(error));
          resolve({ action: "refresh", preview });
        }
      };
    });
  });
}

// Runs the Smart Install preview → commit flow for each source in turn.
async function smartIngest(sources) {
  for (const source of sources) {
    const name = source.split(/[/\\]/).pop();
    let preview;
    try {
      addLog({ level: "info", message: `Analyzing ${name} (Smart Install)…` });
      preview = await window.tactix.smartAnalyze(source);
      if (workshopHandoff) {
        const allowed = await applyWorkshopHandoff(preview);
        if (!allowed) {
          await window.tactix.smartCancel(preview.id).catch(() => {});
          addLog({ level: "warn", message: `Skipped ${name} because it did not match the selected Browse Mods item.` });
          continue;
        }
      }
    } catch (error) {
      addLog({ level: "error", message: error.message });
      continue;
    }

    let decision = await confirmSmartPreview(preview);
    while (decision && decision.action === "refresh") {
      preview = decision.preview || preview;
      decision = await confirmSmartPreview(preview);
    }
    if (!decision || decision.action === "cancel") {
      await window.tactix.smartCancel(preview.id).catch(() => {});
      hideOverlay();
      addLog({ level: "info", message: `Cancelled ${preview.name}.` });
      continue;
    }

    try {
      showProgress("Installing", preview.name);
      const result = await window.tactix.smartCommit(preview.id);
      renderState(result.state);
      await refreshSmart();
      hideOverlay();
      addLog({ level: "ok", message: `Smart-installed ${preview.name}.` });
    } catch (error) {
      if (/ENVIRONMENT CHANGED/i.test(error.message || "")) {
        addLog({ level: "warn", message: error.message });
        hideOverlay();
        try {
          preview = await window.tactix.smartAnalyze(source);
          let again = await confirmSmartPreview(preview);
          while (again && again.action === "refresh") {
            preview = again.preview || preview;
            again = await confirmSmartPreview(preview);
          }
          if (!again || again.action === "cancel") {
            await window.tactix.smartCancel(preview.id).catch(() => {});
            hideOverlay();
            continue;
          }
          showProgress("Installing", preview.name);
          const retried = await window.tactix.smartCommit(preview.id);
          renderState(retried.state);
          await refreshSmart();
          hideOverlay();
          addLog({ level: "ok", message: `Smart-installed ${preview.name}.` });
          continue;
        } catch (retryError) {
          addLog({ level: "error", message: retryError.message });
          hideOverlay();
          continue;
        }
      }
      addLog({ level: "error", message: error.message });
      hideOverlay();
    }
  }
}

function pathsFromDataTransfer(data) {
  if (!data) return [];
  const fromFiles = [...(data.files || [])]
    .map((file) => {
      try {
        return window.tactix.pathForFile(file);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return fromFiles;
}

async function ensureReady() {
  if (state?.game.sandboxReady) return true;

  let official = state?.config.officialPath || "";
  let sandboxPath = state?.config.sandboxPath || "";
  let launcher = state?.config.launcher || "unknown";
  const cloneMode = state?.config.cloneMode || "linked";

  if (!official) {
    const found = await window.tactix.detectGame();
    if (!found.found) {
      addLog({ level: "error", message: "Could not find GTA V Enhanced automatically. Browse to it in Setup once, then drop LSPDFR again." });
      setupForm();
      return false;
    }
    official = found.path;
    sandboxPath = found.sandboxPath;
    launcher = found.launcher;
    addLog({ level: "ok", message: `Found Enhanced at ${found.path}` });
  }

  setBusy(true, "Preparing the LSPDFR folder. This happens once.");
  showProgress("Preparing LSPDFR folder", "Linking official Enhanced files into a second folder so mods never touch Online.");
  await window.tactix.saveSetup({ officialPath: official, sandboxPath, launcher, cloneMode });
  const created = await window.tactix.createSandbox();
  renderState(created.state);
  return true;
}

async function ingestFiles(filePaths) {
  let sources = [...new Set((filePaths || []).filter(Boolean))];
  if (!sources.length) {
    sources = await window.tactix.clipboardPaths();
  }
  if (!sources.length) {
    addLog({
      level: "error",
      message: "Nothing usable was received. Drop the LSPDFR zip or folder.",
    });
    return;
  }

  try {
    setBusy(true);
    if (!(await ensureReady())) return;

    if (ui.smartToggle && ui.smartToggle.checked) {
      await smartIngest(sources);
      return;
    }

    let lastTests = null;
    for (const source of sources) {
      const name = source.split(/[/\\]/).pop();
      showProgress("Installing", name);
      addLog({ level: "info", message: `Installing ${name}…` });
      const result = await window.tactix.installAuto(source);
      renderState(result.state);
      lastTests = result.tests;
      addLog({ level: "ok", message: `Installed ${result.record.name} (${result.record.fileCount} files).` });
    }

    if (lastTests) showTests(lastTests, { installed: true });
    else hideOverlay();
  } catch (error) {
    addLog({ level: "error", message: error.message });
    hideOverlay();
  } finally {
    setBusy(false);
  }
}

function setDropHover(on) {
  ui.drop.classList.toggle("drag", on);
}

["dragenter", "dragover"].forEach((name) => {
  document.addEventListener(name, (event) => {
    event.preventDefault();
    setDropHover(true);
  });
});

document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) setDropHover(false);
});

document.addEventListener("drop", async (event) => {
  event.preventDefault();
  setDropHover(false);
  await ingestFiles(pathsFromDataTransfer(event.dataTransfer));
});

document.addEventListener("paste", async (event) => {
  const fromEvent = pathsFromDataTransfer(event.clipboardData);
  const fromClip = fromEvent.length ? fromEvent : await window.tactix.clipboardPaths();
  if (!fromClip.length) {
    addLog({ level: "error", message: "Paste did not include a folder or archive. Copy the LSPDFR folder in Explorer, then paste here." });
    return;
  }
  addLog({ level: "info", message: `Pasted ${fromClip.map((item) => item.split(/[/\\]/).pop()).join(", ")}` });
  await ingestFiles(fromClip);
});

ui.drop.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const folder = await window.tactix.pickFolder("Select LSPDFR or mod folder");
    if (folder) await ingestFiles([folder]);
  }
});

$("btn-browse").onclick = async () => {
  const files = await window.tactix.pickArchives();
  await ingestFiles(files);
};

$("btn-browse-folder").onclick = async () => {
  const folder = await window.tactix.pickFolder("Select LSPDFR or mod folder");
  if (folder) await ingestFiles([folder]);
};

function showTests(tests, options = {}) {
  if (!tests) {
    addLog({ level: "error", message: "Create the LSPDFR folder before running tests." });
    return;
  }
  const warningItems = (tests.dutyWarnings || [])
    .map((row) => `<li><strong>${escapeHtml(row.status)}</strong> — ${escapeHtml(row.title)}${row.detail ? ` <small>${escapeHtml(row.detail)}</small>` : ""}</li>`)
    .join("");
  const items = tests.checks
    .map((item) => {
      return `<li>
        <i class="lamp ${item.level}"></i>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.detail)}</small>
        </div>
      </li>`;
    })
    .join("");
  const battlEye = tests.checks.find((item) => item.id === "battleye" && !item.ok);
  const canPlay = Boolean(state?.game.hasRage && state?.game.sandboxReady);

  showOverlay(`
    <h2>${options.installed ? "Installed" : "Function test"}</h2>
    <p>${escapeHtml(options.installed ? `LSPDFR is in the duty folder. ${tests.summary}` : tests.summary)}</p>
    ${warningItems ? `<h3>Current Duty Warnings</h3><ul class="check-list">${warningItems}</ul>` : ""}
    <ul class="check-list">${items}</ul>
    <div class="dialog-actions">
      ${canPlay ? `<button id="tests-play" class="primary" type="button">Play LSPDFR</button>` : ""}
      ${battlEye ? `<button id="fix-be" class="primary" type="button">Disable BattlEye</button>` : ""}
      <button id="tests-again" class="ghost" type="button">Run again</button>
      <button id="tests-close" class="ghost" type="button">Close</button>
    </div>
  `, true);

  const play = $("tests-play");
  if (play) {
    play.onclick = async () => {
      try {
        hideOverlay();
        await window.tactix.launchLspdfr();
      } catch (error) {
        addLog({ level: "error", message: error.message });
      }
    };
  }

  $("tests-close").onclick = hideOverlay;
  $("tests-again").onclick = async () => {
    try {
      setBusy(true, "Running function tests…");
      const result = await window.tactix.runTests();
      renderState(result.state);
      showTests(result.tests);
    } catch (error) {
      addLog({ level: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  };
  const fix = $("fix-be");
  if (fix) {
    fix.onclick = async () => {
      try {
        const result = await window.tactix.fixBattlEye();
        renderState(result.state);
        showTests(result.state.tests);
      } catch (error) {
        addLog({ level: "error", message: error.message });
      }
    };
  }
}

function showCrashes(report) {
  const last = report.lastCrash
    ? `<p>Last crash from ${escapeHtml(report.lastCrash.source)} · ${escapeHtml(report.lastCrash.summary)}</p>`
    : `<p>No crash signature found in recent logs. Launch LSPDFR once if you want a fresh report.</p>`;
  const logs = (report.logs || [])
    .map((log) => {
      const errors = (log.errors || []).map((line) => escapeHtml(line)).join("<br>");
      return `<li>
        <i class="lamp ${log.errors?.length ? "bad" : "ok"}"></i>
        <div>
          <strong>${escapeHtml(log.name)}</strong>
          <small>${errors || "No errors in the tail of this log."}</small>
          <div class="row-actions">
            <button class="ghost" data-open="${escapeHtml(log.path)}" type="button">Open</button>
          </div>
        </div>
      </li>`;
    })
    .join("");
  const dumps = (report.dumps || [])
    .map((dump) => `<li>
      <i class="lamp bad"></i>
      <div>
        <strong>${escapeHtml(dump.name)}</strong>
        <small>${escapeHtml(dump.mtime || "")}</small>
        <div class="row-actions">
          <button class="ghost" data-open="${escapeHtml(dump.path)}" type="button">Open</button>
        </div>
      </div>
    </li>`)
    .join("");

  showOverlay(`
    <h2>Crash reports</h2>
    ${last}
    <ul class="crash-list">${logs || "<li>No logs yet.</li>"}${dumps}</ul>
    <div class="dialog-actions">
      <button id="crashes-close" class="ghost" type="button">Close</button>
    </div>
  `, true);

  $("crashes-close").onclick = hideOverlay;
  ui.dialog.querySelectorAll("button[data-open]").forEach((button) => {
    button.onclick = () =>
      window.tactix.openPath(button.dataset.open).catch((error) => addLog({ level: "error", message: error.message }));
  });
}

$("btn-settings").onclick = () => setupForm();

$("btn-tests").onclick = async () => {
  try {
    setBusy(true, "Running function tests…");
    const result = await window.tactix.runTests();
    renderState(result.state);
    showTests(result.tests);
  } catch (error) {
    addLog({ level: "error", message: error.message });
  } finally {
    setBusy(false);
  }
};

$("btn-crashes").onclick = async () => {
  try {
    showCrashes(await window.tactix.crashReports());
  } catch (error) {
    addLog({ level: "error", message: error.message });
  }
};

async function showSessionHistory(rows, filter = "All") {
  const list = rows || (await window.tactix.sessionFilter({ type: filter }));
  const items = (list || [])
    .map(
      (row) => `
      <button class="session-row" data-session="${escapeHtml(row.sessionId)}" type="button">
        <i class="lamp ${sessionTone(row.result)}"></i>
        <div>
          <strong>${escapeHtml(sessionLabel(row.result))}</strong>
          <small>${escapeHtml(formatWhen(row.startedAt))} · ${escapeHtml(formatDuration(row.durationMs))} · ${row.enabledModCount || 0} mods</small>
        </div>
      </button>`
    )
    .join("");
  showOverlay(`
    <p class="eyebrow">Evidence only</p>
    <h2>Launch History</h2>
    <div class="filter-row">
      ${["All", "Clean", "Crash", "Unknown", "Profile", "Mod"].map((type) => `<button data-sestype="${type}" class="ghost" type="button">${type}</button>`).join("")}
    </div>
    <div class="session-list">${items || "<p class='empty'>No LSPDFR sessions recorded yet.</p>"}</div>
    <div class="dialog-actions">
      <button id="sessions-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("sessions-close").onclick = hideOverlay;
  ui.dialog.querySelectorAll("button[data-sestype]").forEach((button) => {
    button.onclick = async () => {
      try {
        showSessionHistory(await window.tactix.sessionFilter({ type: button.dataset.sestype }), button.dataset.sestype);
      } catch (error) {
        addLog({ level: "error", message: userError(error) });
      }
    };
  });
  ui.dialog.querySelectorAll("button[data-session]").forEach((button) => {
    button.onclick = async () => {
      try {
        showSessionDetail(await window.tactix.sessionGet(button.dataset.session));
      } catch (error) {
        addLog({ level: "error", message: userError(error) });
      }
    };
  });
}

function showSessionDetail(session) {
  if (!session) return;
  const env = session.environment || {};
  const mods = (session.mods || []).filter((mod) => mod.enabled);
  const changes = (session.recentChanges || []).slice(-8);
  const overlaysAt = session.overlays || {};
  const logs = (session.logs || []).map((log) => `<li>${escapeHtml(log.name)}</li>`).join("");
  const timeline = (session.timeline || [])
    .slice(-12)
    .map((row) => `<li>${escapeHtml(formatWhen(row.time))} ${escapeHtml(row.type)}</li>`)
    .join("");
  const failed = ["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH", "LAUNCH_FAILED", "UNKNOWN"].includes(session.result);
  const allowAnalyze = failed || developerMode();
  const analysis = session.analysis;
  showOverlay(`
    <p class="eyebrow">LSPDFR SESSION</p>
    <h2>${escapeHtml(sessionLabel(session.result))}</h2>
    <p>Started ${escapeHtml(formatWhen(session.startedAt))}<br />
    Duration ${escapeHtml(formatDuration(session.durationMs))}<br />
    Confidence ${escapeHtml(session.confidence || "UNKNOWN")}</p>
    ${renderAnalysisHtml(analysis, session)}
    <h3>Environment</h3>
    <p>GTA ${escapeHtml(env.gtaVersion || "UNKNOWN")}<br />
    LSPDFR ${escapeHtml(env.lspdfrVersion || "UNKNOWN")}<br />
    RPH ${escapeHtml(env.rphVersion || "UNKNOWN")}</p>
    <h3>Mods</h3>
    <p>${mods.length} enabled</p>
    ${
      changes.length
        ? `<h3>Recent changes</h3><ul class="check-list">${changes
            .map((row) => `<li><div><small>${escapeHtml(row.name || row.installId || "")} ${escapeHtml(row.label)}</small></div></li>`)
            .join("")}</ul>`
        : ""
    }
    ${
      overlaysAt.nvidiaDetected
        ? `<p>⚠ NVIDIA Overlay detected${overlaysAt.nvidiaClosedByManager ? " and closed by the manager" : ""}.</p>`
        : ""
    }
    <h3>Logs</h3>
    <ul class="crash-list">${logs || "<li>No logs attached.</li>"}</ul>
    <h3>Timeline</h3>
    <ul class="crash-list">${timeline || "<li>No events.</li>"}</ul>
    <div class="dialog-actions">
      ${
        allowAnalyze
          ? `<button id="session-analyze" type="button">${analysis ? "Re-analyze Crash" : "Analyze Crash"}</button>`
          : `<button class="ghost" type="button" disabled>Analyze Crash</button>`
      }
      <button id="session-compare" class="ghost" type="button">Compare with last clean session</button>
      <button id="session-back" class="ghost" type="button">Back</button>
    </div>
  `, true);
  $("session-back").onclick = async () => showSessionHistory(await window.tactix.sessionList());
  $("session-compare").onclick = async () => {
    try {
      const cmp = await window.tactix.sessionCompareLastClean(session.sessionId);
      const versions = (cmp.versionChanges || []).map((row) => `${row.name} ${row.from} → ${row.to}`).join(" · ") || "none";
      const enabled = (cmp.newlyEnabled || []).map((row) => row.name).join(" · ") || "none";
      showOverlay(`
        <p class="eyebrow">COMPARE</p>
        <h2>Last clean session</h2>
        <p>Mod versions: ${escapeHtml(versions)}</p>
        <p>Newly enabled: ${escapeHtml(enabled)}</p>
        <p>Overlay now: ${cmp.overlayOn ? "detected" : "off"} · then: ${cmp.lastCleanOverlayOn ? "detected" : "off"}</p>
        <p>GTA ${escapeHtml((cmp.lastCleanEnv && cmp.lastCleanEnv.gtaVersion) || "?")} → ${escapeHtml((cmp.targetEnv && cmp.targetEnv.gtaVersion) || "?")}<br />
        RPH ${escapeHtml((cmp.lastCleanEnv && cmp.lastCleanEnv.rphVersion) || "?")} → ${escapeHtml((cmp.targetEnv && cmp.targetEnv.rphVersion) || "?")}<br />
        LSPDFR ${escapeHtml((cmp.lastCleanEnv && cmp.lastCleanEnv.lspdfrVersion) || "?")} → ${escapeHtml((cmp.targetEnv && cmp.targetEnv.lspdfrVersion) || "?")}</p>
        <div class="dialog-actions"><button id="cmp-back" class="ghost" type="button">Back</button></div>
      `, true);
      $("cmp-back").onclick = () => showSessionDetail(session);
    } catch (error) {
      addLog({ level: "error", message: userError(error) });
    }
  };
  const analyzeBtn = $("session-analyze");
  if (analyzeBtn) {
    analyzeBtn.onclick = async () => {
      try {
        analyzeBtn.disabled = true;
        const next = await window.tactix.sessionAnalyze(session.sessionId);
        const actions = await window.tactix.crashActionPlan(session.sessionId);
        showSessionDetail({ ...session, analysis: next, analysisStatus: next.stale ? "STALE" : "CURRENT", crashActions: actions });
        await refresh();
      } catch (error) {
        addLog({ level: "error", message: error.message });
        analyzeBtn.disabled = false;
      }
    };
  }
  bindCrashActionButtons(session);
  if (session.analysis && !session.analysis.stale && !(session.crashActions || []).length) {
    window.tactix
      .crashActionPlan(session.sessionId)
      .then((actions) => {
        if (actions && actions.length) showSessionDetail({ ...session, crashActions: actions });
      })
      .catch(() => {});
  }
}

function renderCrashActionButtons(actions, analysis) {
  if (analysis && analysis.stale) return "";
  const usable = (actions || []).filter((row) => row.available !== false && row.type !== "NO_SAFE_ACTION" && row.state === "PLANNED");
  if (!usable.length) return "";
  const primary = usable.find((row) => row.primary) || usable[0];
  const rest = usable.filter((row) => row.actionId !== primary.actionId).slice(0, 3);
  const label = (type) =>
    ({
      DISABLE_MOD_AND_RETEST: "Disable & Retest",
      ROLLBACK_MOD_AND_RETEST: "Restore Previous Version",
      REPAIR_MOD_AND_RETEST: "Repair Mod",
      REPAIR_EXISTING_DEPENDENCY: "Repair Dependency",
      CLOSE_OVERLAY_AND_RETEST: "Close Overlay & Retest",
      RE_ENABLE_MOD: "Re-enable Dependency",
      MINIMAL_RETEST: "Minimal Retest",
      OPEN_DEPENDENCY_DETAILS: "Dependency Details",
    }[type] || type);
  return `
    <div class="row-actions crash-actions">
      <button data-crash-action="${escapeHtml(primary.actionId)}" type="button">${escapeHtml(label(primary.type))}</button>
      ${rest.map((row) => `<button data-crash-action="${escapeHtml(row.actionId)}" class="ghost" type="button">${escapeHtml(label(row.type))}</button>`).join("")}
    </div>
  `;
}

function bindCrashActionButtons(session) {
  ui.dialog.querySelectorAll("button[data-crash-action]").forEach((button) => {
    button.onclick = () => {
      const action = (session.crashActions || []).find((row) => row.actionId === button.dataset.crashAction);
      if (action) confirmCrashAction(session, action);
    };
  });
}

async function showDependencyDetails(session, name) {
  let offer = null;
  try {
    const offers = await window.tactix.depOffers({ names: [name] });
    offer = (offers && offers[0]) || null;
  } catch {
    offer = null;
  }
  const actions = [];
  if (offer && offer.canDownload) {
    actions.push(`<button id="dep-download" class="primary" type="button">Download &amp; install</button>`);
  }
  if (offer && offer.pageUrl) {
    actions.push(`<button id="dep-page" class="ghost" type="button">Open download page</button>`);
  }
  const note = offer
    ? offer.note || offer.sourceLabel
    : "If you already have the pack, drop it on Smart Install. Curated official zips can also be downloaded from a Smart Install preview.";
  showOverlay(
    `<h2>Dependency details</h2><p><strong>${escapeHtml(name)}</strong> is not installed in Duty.</p><p>${escapeHtml(
      note
    )}</p><p class="muted">Downloads go into the Duty LSPDFR folder only — never the official Steam / Online folder.</p><div class="dialog-actions">${actions.join(
      ""
    )}<button id="dep-close" class="ghost" type="button">Close</button></div>`,
    true
  );
  $("dep-close").onclick = () => showSessionDetail(session);
  const page = $("dep-page");
  if (page && offer) {
    page.onclick = () => window.tactix.depOpenPage(offer.pageUrl).catch((error) => addLog({ level: "error", message: userError(error) }));
  }
  const download = $("dep-download");
  if (download && offer) {
    download.onclick = async () => {
      const ok = window.confirm(
        `Download ${offer.name} from ${offer.sourceLabel || "its official source"} and install it into the Duty LSPDFR folder only?`
      );
      if (!ok) return;
      download.disabled = true;
      showProgress("Downloading", offer.name);
      try {
        const result = await window.tactix.depDownloadInstall({ modId: offer.id });
        addLog({ level: "ok", message: `Installed ${result.name} into Duty.` });
        hideOverlay();
        await refresh();
        showSessionDetail(session);
      } catch (error) {
        addLog({ level: "error", message: userError(error) });
        window.alert(userError(error));
        showDependencyDetails(session, name);
      }
    };
  }
}

function confirmCrashAction(session, action) {
  const name = action.targetName || "this component";
  let title = "Test this theory?";
  let body = `${name} will be changed temporarily.\nYour current state can be restored after the test.`;
  let confirm = "Continue";
  if (action.type === "DISABLE_MOD_AND_RETEST") {
    title = "Test this theory?";
    body = `${name} will be disabled temporarily.\n\nNo files will be deleted.\nYour current state can be restored after the test.`;
    confirm = "Disable & Retest";
  } else if (action.type === "ROLLBACK_MOD_AND_RETEST") {
    const preview = action.preview || {};
    title = "Restore previous version?";
    body = `Current version:\n${preview.from || "unknown"}\n\nRestore:\n${preview.to || "unknown"}\n\nConfigs:\n${preview.configPolicy || "Keep existing"}\n\nFiles:\n${preview.filesReplaced || 0} replaced\n${preview.filesRestored || 0} restored`;
    confirm = "Restore Previous Version";
  } else if (action.type === "CLOSE_OVERLAY_AND_RETEST") {
    title = "Close overlay and retest?";
    body = "NVIDIA Overlay will be closed for this launch using the existing temporary suppression. Driver settings are not changed.";
    confirm = "Close Overlay & Retest";
  } else if (action.type === "RE_ENABLE_MOD") {
    title = "Re-enable dependency?";
    body = "Required dependency is disabled.\n\nRe-enabling it may reintroduce a known local stability issue.";
    confirm = "Re-enable & Retest";
  } else if (action.warning) {
    body = action.warning;
  }
  if (action.type === "OPEN_DEPENDENCY_DETAILS") {
    showDependencyDetails(session, name);
    return;
  }
  showOverlay(`
    <p class="eyebrow">CONFIRM TEST</p>
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body).replaceAll("\n", "<br />")}</p>
    <div class="dialog-actions">
      <button id="crash-cancel" class="ghost" type="button">Cancel</button>
      <button id="crash-confirm" type="button">${escapeHtml(confirm)}</button>
    </div>
  `, true);
  $("crash-cancel").onclick = () => showSessionDetail(session);
  $("crash-confirm").onclick = async () => {
    try {
      $("crash-confirm").disabled = true;
      await window.tactix.crashActionApply(action.actionId);
      await refresh();
      showOverlay(`
        <p class="eyebrow">RETEST READY</p>
        <h2>Test change applied</h2>
        <p>${escapeHtml((action.changes && action.changes[0]) || name)} is ready to retest. Play LSPDFR when you want to start the session. Nothing else will change automatically.</p>
        <div class="dialog-actions">
          <button id="crash-launch" type="button">Play LSPDFR</button>
          <button id="crash-later" class="ghost" type="button">Later</button>
        </div>
      `, true);
      $("crash-launch").onclick = () => {
        hideOverlay();
        $("btn-lspdfr").click();
      };
      $("crash-later").onclick = hideOverlay;
    } catch (error) {
      addLog({ level: "error", message: error.message });
      showOverlay(`<h2>Test could not be applied</h2><p>${escapeHtml(error.message)}</p><div class="dialog-actions"><button id="crash-err" class="ghost" type="button">Close</button></div>`, true);
      $("crash-err").onclick = () => showSessionDetail(session);
    }
  };
}

function renderAnalysisHtml(analysis, session) {
  if (!analysis) return "";
  if (analysis.stale) {
    return `<div class="analysis-block"><p class="eyebrow">CRASH ANALYSIS</p><p>This crash analysis is out of date because the Duty setup changed.</p><p>Re-analyze before applying a test.</p></div>`;
  }
  const unknown = analysis.analysisConfidence === "UNKNOWN" || !(analysis.suspects || []).length;
  if (unknown) {
    const test = (analysis.recommendedTests && analysis.recommendedTests[0] && analysis.recommendedTests[0].text) ||
      "Launch with recently changed mods disabled.";
    return `
      <div class="analysis-block">
        <p class="eyebrow">CRASH ANALYSIS</p>
        <h3>No clear cause identified</h3>
        <p>${escapeHtml(analysis.summary || "The logs do not name a failing plugin and there is not enough session history to confidently rank one.")}</p>
        <p>Best next test: ${escapeHtml(test)}</p>
        ${renderCrashActionButtons(session && session.crashActions, analysis)}
      </div>
    `;
  }
  const top = analysis.suspects[0];
  const others = (analysis.suspects || []).slice(1);
  const alts = analysis.alternatives || [];
  const why = (top.reasons || []).map((row) => `<li><span></span><div>${escapeHtml(row)}</div></li>`).join("");
  const counters = (top.counterEvidence || []).map((row) => `<li><span></span><div>${escapeHtml(row)}</div></li>`).join("");
  const test = (analysis.recommendedTests && analysis.recommendedTests[0] && analysis.recommendedTests[0].text) || "";
  const other = others.length
    ? others.map((row) => `${escapeHtml(row.name)} — ${escapeHtml(confidenceLabel(row.confidence))}`).join("<br />")
    : alts.map((row) => escapeHtml(row)).join("<br />");
  const tech = `
    <details class="tech-details">
      <summary>Technical details</summary>
      <p>Analyzer ${escapeHtml(analysis.analyzerVersion || "")} · rules ${escapeHtml(analysis.rulesVersion || "")}</p>
      <p>Overall confidence ${escapeHtml(analysis.analysisConfidence)}</p>
      <ul class="crash-list">${(analysis.suspects || [])
        .map(
          (row) =>
            `<li><span></span><div>${escapeHtml(row.type)} ${escapeHtml(row.name)} score ${row.score} ${escapeHtml(row.confidence)}<small>${escapeHtml(
              ((row.weights && row.weights.added) || []).map((item) => `+${item.weight} ${item.reason}`).join(" · ")
            )}</small></div></li>`
        )
        .join("")}</ul>
      <p>Log patterns: ${escapeHtml(((analysis.evidence && analysis.evidence.logPatterns) || []).map((row) => row.id).join(", ") || "none")}</p>
      <p>Sample: ${(analysis.evidence && analysis.evidence.sample && analysis.evidence.sample.clean) || 0} clean / ${(analysis.evidence && analysis.evidence.sample && analysis.evidence.sample.failed) || 0} failed</p>
    </details>
  `;
  return `
    <div class="analysis-block">
      <p class="eyebrow">CRASH ANALYSIS</p>
      <h3>Most likely suspect</h3>
      <p><strong>${escapeHtml(top.name)}</strong><br />Confidence: ${escapeHtml(confidenceLabel(top.confidence))}</p>
      <p>${escapeHtml(analysis.summary || "")}</p>
      <h3>Why</h3>
      <ul class="check-list">${why || "<li><span></span><div>Limited evidence.</div></li>"}</ul>
      ${
        counters
          ? `<h3>Counter-evidence</h3><ul class="check-list">${counters}</ul>`
          : ""
      }
      ${test ? `<h3>Recommended test</h3><p>${escapeHtml(test)}</p>` : ""}
      ${renderCrashActionButtons(session && session.crashActions, analysis)}
      ${other ? `<h3>Other possibilities</h3><p>${other}</p>` : ""}
      ${tech}
    </div>
  `;
}

async function showProfiles() {
  const profiles = await window.tactix.profileList();
  const active = await window.tactix.profileActive();
  const items = (profiles || [])
    .map((profile) => {
      const current = active && active.profile && active.profile.profileId === profile.profileId;
      return `<li>
        <div>
          <strong>${current ? "●" : "○"} ${escapeHtml(profile.name)}${profile.knownGood ? " · Known Good" : ""}</strong>
          <small>${profile.mods ? profile.mods.length : 0} mods · ${escapeHtml(profile.health || "")}${profile.drifted ? " · Drift" : ""} · last used ${escapeHtml(formatWhen(profile.updatedAt))}</small>
        </div>
        <div class="row-actions">
          ${current ? "" : `<button data-pswitch="${escapeHtml(profile.profileId)}" type="button">Switch</button>`}
          <button data-pgood="${escapeHtml(profile.profileId)}" class="ghost" type="button">Set as Known Good</button>
          <button data-prename="${escapeHtml(profile.profileId)}" class="ghost" type="button">Rename</button>
          <button data-pdup="${escapeHtml(profile.profileId)}" class="ghost" type="button">Duplicate</button>
          <button data-pdel="${escapeHtml(profile.profileId)}" class="ghost" type="button">Delete</button>
        </div>
      </li>`;
    })
    .join("");
  const drift = active && active.drift && active.drift.drifted
    ? `<p>PROFILE MODIFIED<br />${escapeHtml((active.drift.notes || []).join(" · "))}</p>
       <div class="row-actions">
         <button id="drift-update" type="button">Update Profile</button>
         <button id="drift-restore" class="ghost" type="button">Restore Profile</button>
         <button id="drift-ignore" class="ghost" type="button">Ignore for now</button>
       </div>`
    : "";
  showOverlay(`
    <p class="eyebrow">PROFILES</p>
    <h2>Duty setups</h2>
    <p id="profile-rec" class="muted"></p>
    ${drift}
    <ul class="crash-list">${items || "<li>No profiles yet.</li>"}</ul>
    <div class="dialog-actions">
      <button id="profile-create" type="button">Create Profile From Current Setup</button>
      <button id="profiles-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("profiles-close").onclick = hideOverlay;
  if (active && active.profile && $("profile-rec")) {
    window.tactix.profileRecommendation(active.profile.profileId).then((rec) => {
      if (rec && rec.suggest) $("profile-rec").textContent = rec.message;
    }).catch(() => {});
  }
  $("profile-create").onclick = async () => {
    const name = window.prompt("Profile name", "Stable Patrol") || "New profile";
    await window.tactix.profileCreate({ name });
    await refresh();
    showProfiles();
  };
  if ($("drift-update") && active) {
    $("drift-update").onclick = async () => {
      await window.tactix.profileUpdateFromCurrent(active.profile.profileId);
      await refresh();
      showProfiles();
    };
    $("drift-restore").onclick = () => confirmSwitch(active.profile.profileId);
    $("drift-ignore").onclick = hideOverlay;
  }
  ui.dialog.querySelectorAll("button[data-pswitch]").forEach((button) => {
    button.onclick = () => confirmSwitch(button.dataset.pswitch);
  });
  ui.dialog.querySelectorAll("button[data-pgood]").forEach((button) => {
    button.onclick = async () => {
      await window.tactix.profileKnownGood(button.dataset.pgood);
      await refresh();
      showProfiles();
    };
  });
  ui.dialog.querySelectorAll("button[data-prename]").forEach((button) => {
    button.onclick = async () => {
      const current = profiles.find((row) => row.profileId === button.dataset.prename);
      const name = window.prompt("Rename profile", current ? current.name : "");
      if (!name) return;
      await window.tactix.profileRename(button.dataset.prename, name);
      showProfiles();
    };
  });
  ui.dialog.querySelectorAll("button[data-pdup]").forEach((button) => {
    button.onclick = async () => {
      await window.tactix.profileDuplicate(button.dataset.pdup);
      showProfiles();
    };
  });
  ui.dialog.querySelectorAll("button[data-pdel]").forEach((button) => {
    button.onclick = async () => {
      if (!window.confirm("Delete this profile? Duty files stay as they are.")) return;
      await window.tactix.profileDelete(button.dataset.pdel);
      await refresh();
      showProfiles();
    };
  });
}

async function confirmSwitch(profileId) {
  const plan = await window.tactix.profilePlanSwitch(profileId);
  const text = [
    `SWITCH TO: ${String(plan.profileName || "").toUpperCase()}`,
    plan.disable.length ? `Disable:\n${plan.disable.map((row) => `• ${row.name}`).join("\n")}` : "",
    plan.enable.length ? `Enable:\n${plan.enable.map((row) => `• ${row.name}`).join("\n")}` : "",
    plan.restoreVersion.length ? `Restore version:\n${plan.restoreVersion.map((row) => `• ${row.name} ${row.to}`).join("\n")}` : "",
    plan.configChanges.length ? `Configs:\n• ${plan.configChanges.length} managed configs changed` : "",
    plan.incompleteMessage || "",
    plan.externalConfigs && plan.externalConfigs.length
      ? `CONFIG CHANGED OUTSIDE MOD MANAGER\n\n${plan.externalConfigs.map((row) => row.destination).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  showOverlay(`
    <p class="eyebrow">SWITCH PROFILE</p>
    <h2>${escapeHtml(plan.profileName || "Profile")}</h2>
    <p>${escapeHtml(text).replaceAll("\n", "<br />")}</p>
    <div class="dialog-actions">
      <button id="switch-cancel" class="ghost" type="button">Cancel</button>
      <button id="switch-go" type="button" ${plan.complete ? "" : "disabled"}>Switch Profile</button>
    </div>
  `, true);
  $("switch-cancel").onclick = () => showProfiles();
  $("switch-go").onclick = async () => {
    try {
      await window.tactix.profileSwitch({
        profileId,
        confirmOverwriteConfigs: Boolean(plan.externalConfigs && plan.externalConfigs.length),
      });
      await refresh();
      hideOverlay();
    } catch (error) {
      addLog({ level: "error", message: error.message });
    }
  };
}

function snapshotKind(reason, snap) {
  if (snap.knownGood) return "Known Good";
  if (reason === "MANUAL") return "Manual";
  if (reason === "BEFORE_UPDATE" || reason === "BEFORE_DOWNGRADE") return "Before Update";
  if (reason === "BEFORE_CRASH_ACTION") return "Before Crash Test";
  if (reason === "BEFORE_PROFILE_SWITCH") return "Before profile switch";
  if (reason === "BEFORE_REPAIR") return "Before repair";
  return "Automatic";
}

async function showRecovery(filter = "ALL") {
  const snaps = await window.tactix.snapshotList();
  const filtered = (snaps || []).filter((row) => {
    if (filter === "ALL") return true;
    if (filter === "MANUAL") return row.reason === "MANUAL";
    if (filter === "KNOWN_GOOD") return row.knownGood || row.pinned;
    if (filter === "AUTO") return row.reason !== "MANUAL";
    return row.reason === filter;
  });
  const items = filtered
    .map(
      (row) => `<li>
        <div>
          <strong>${row.pinned ? "★ " : ""}${escapeHtml(row.name)}</strong>
          <small>${escapeHtml(formatWhen(row.createdAt))} · ${escapeHtml(snapshotKind(row.reason, row))} · ${row.mods ? row.mods.length : 0} mods</small>
        </div>
        <div class="row-actions">
          <button data-srestore="${escapeHtml(row.snapshotId)}" type="button">Restore</button>
          <button data-spin="${escapeHtml(row.snapshotId)}" class="ghost" type="button">${row.pinned ? "Unpin" : "Pin"}</button>
        </div>
      </li>`
    )
    .join("");
  const usage = state && state.storage ? state.storage : { bytes: 0, profilesBytes: 0, snapshotsBytes: 0 };
  const mb = (n) => `${((Number(n) || 0) / (1024 * 1024)).toFixed(1)} MB`;
  showOverlay(`
    <p class="eyebrow">RECOVERY POINTS</p>
    <h2>Snapshots</h2>
    <div class="filter-row">
      <button data-sfilter="ALL" class="ghost" type="button">All</button>
      <button data-sfilter="MANUAL" class="ghost" type="button">Manual</button>
      <button data-sfilter="AUTO" class="ghost" type="button">Automatic</button>
      <button data-sfilter="BEFORE_UPDATE" class="ghost" type="button">Before Update</button>
      <button data-sfilter="BEFORE_CRASH_ACTION" class="ghost" type="button">Before Crash Test</button>
      <button data-sfilter="KNOWN_GOOD" class="ghost" type="button">Known Good</button>
    </div>
    <p>Storage: ${mb(usage.bytes)} (profiles ${mb(usage.profilesBytes)} · snapshots ${mb(usage.snapshotsBytes)})</p>
    <ul class="crash-list">${items || "<li>No snapshots yet.</li>"}</ul>
    <div class="dialog-actions">
      <button id="snap-create" type="button">Create Snapshot</button>
      <button id="snap-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("snap-close").onclick = hideOverlay;
  ui.dialog.querySelectorAll("button[data-sfilter]").forEach((button) => {
    button.onclick = () => showRecovery(button.dataset.sfilter);
  });
  $("snap-create").onclick = async () => {
    const name = window.prompt("Snapshot name", "Known Good Before Testing New Callouts");
    if (!name) return;
    await window.tactix.snapshotCreate({ name });
    await refresh();
    showRecovery();
  };
  ui.dialog.querySelectorAll("button[data-srestore]").forEach((button) => {
    button.onclick = () => confirmRestore(button.dataset.srestore);
  });
  ui.dialog.querySelectorAll("button[data-spin]").forEach((button) => {
    button.onclick = async () => {
      const row = snaps.find((item) => item.snapshotId === button.dataset.spin);
      await window.tactix.snapshotPin(button.dataset.spin, !(row && row.pinned));
      showRecovery();
    };
  });
}

async function confirmRestore(snapshotId) {
  const preview = await window.tactix.snapshotPlan(snapshotId);
  const plan = preview.plan;
  const env = plan.environmentWarning
    ? `<p>ENVIRONMENT CHANGED<br />This snapshot was created on: ${escapeHtml(plan.environmentWarning.snapshot)}<br />Current: ${escapeHtml(plan.environmentWarning.current)}</p>`
    : "";
  showOverlay(`
    <p class="eyebrow">RESTORE SNAPSHOT</p>
    <h2>${escapeHtml(preview.snapshot.name)}</h2>
    <p>Mods:<br />${plan.disable.length} will be disabled<br />${plan.enable.length} will be enabled<br />${plan.restoreVersion.length} versions restored</p>
    <p>Configs:<br />${plan.configChanges.length} restored</p>
    ${env}
    <div class="dialog-actions">
      <button id="restore-cancel" class="ghost" type="button">Cancel</button>
      <button id="restore-go" type="button" ${plan.complete ? "" : "disabled"}>Restore</button>
    </div>
  `, true);
  $("restore-cancel").onclick = () => showRecovery();
  $("restore-go").onclick = async () => {
    try {
      await window.tactix.snapshotRestore(snapshotId);
      await refresh();
      hideOverlay();
    } catch (error) {
      addLog({ level: "error", message: error.message });
    }
  };
}

$("btn-sessions").onclick = async () => {
  try {
    showSessionHistory(await window.tactix.sessionList());
  } catch (error) {
    addLog({ level: "error", message: error.message });
  }
};

if ($("btn-profiles")) {
  $("btn-profiles").onclick = () => showProfiles().catch((error) => addLog({ level: "error", message: error.message }));
}
if ($("btn-recovery")) {
  $("btn-recovery").onclick = () => showRecovery().catch((error) => addLog({ level: "error", message: error.message }));
}
if ($("btn-known-good")) {
  $("btn-known-good").onclick = async () => {
    try {
      const preview = await window.tactix.profileRestoreKnownGood();
      await confirmSwitch(preview.profileId);
    } catch (error) {
      addLog({ level: "error", message: error.message });
    }
  };
}

$("btn-open-official").onclick = () => window.tactix.openFolder("official").catch((error) => addLog({ level: "error", message: error.message }));
$("btn-open-sandbox").onclick = () => window.tactix.openFolder("sandbox").catch((error) => addLog({ level: "error", message: error.message }));

$("btn-lspdfr").onclick = async () => {
  try {
    await window.tactix.launchLspdfr();
    await refresh();
  } catch (error) {
    addLog({ level: "error", message: error.message });
    await refresh();
  }
};

$("btn-online").onclick = async () => {
  try {
    await window.tactix.launchOnline();
  } catch (error) {
    addLog({ level: "error", message: error.message });
  }
};

ui.mods.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  const card = event.target.closest(".mod");
  if (!button || !card) return;
  const id = card.dataset.id;
  const origin = card.dataset.origin || "folder";
  try {
    setBusy(true);
    if (origin === "smart") {
      const mod = smartMods.find((item) => item.id === id);
      if (button.dataset.act === "details") {
        await showModDetails(id);
      } else if (button.dataset.act === "repair") {
        const result = await window.tactix.smartRepair(id);
        const restored = (result.result && result.result.restored) || [];
        if (restored.length) addLog({ level: "ok", message: `Restored ${restored.length} file(s) for ${mod && mod.name ? mod.name : "this mod"}.` });
        else addLog({ level: "info", message: "Repair found no missing files. The lamp is about condition, not a broken copy." });
        renderState(result.state);
      } else if (button.dataset.act === "remove") {
        const impact = await window.tactix.depsImpact(id);
        if (impact.requiredDependents && impact.requiredDependents.length) {
          const ok = window.confirm(`DEPENDENCY IMPACT\n\nRemoving this mod may affect:\n${impact.requiredDependents.map((row) => `• ${row.name}`).join("\n")}\n\nContinue?`);
          if (!ok) return;
        }
        let result = await window.tactix.smartUninstall(id, false);
        if (result && result.needsConfirm) {
          const ok = window.confirm(`${result.message}\n\nRemove this mod anyway?`);
          if (!ok) return;
          result = await window.tactix.smartUninstall(id, true);
        }
        renderState(result.state);
      } else if (mod && button.dataset.act === "toggle") {
        if (mod.enabled) {
          const impact = await window.tactix.depsImpact(id);
          if (impact.requiredDependents && impact.requiredDependents.length) {
            const ok = window.confirm(`DEPENDENCY IMPACT\n\nDisabling this mod may affect:\n${impact.requiredDependents.map((row) => `• ${row.name}`).join("\n")}\n\nContinue?`);
            if (!ok) return;
          }
        }
        const result = await window.tactix.smartSetEnabled(id, !mod.enabled);
        renderState(result.state);
      }
      await refreshSmart();
      return;
    }
    if (origin === "disk") {
      const diskMod = (state.mods || []).find((item) => item.id === id);
      if (button.dataset.act === "details" && diskMod) showFolderModDetails(diskMod);
      return;
    }
    const mod = (state.mods || []).find((item) => item.id === id);
    if (button.dataset.act === "details" && mod) {
      showFolderModDetails(mod);
    } else if (button.dataset.act === "remove") {
      renderState(await window.tactix.uninstall(id));
    } else if (mod && button.dataset.act === "toggle") {
      renderState(await window.tactix.setEnabled(id, !mod.enabled));
    }
    await refreshSmart();
  } catch (error) {
    addLog({ level: "error", message: error.message });
  } finally {
    setBusy(false);
  }
});

async function showModDetails(installId) {
  const details = await window.tactix.modDetails(installId);
  const health = details.health || { status: "UNKNOWN", reasons: [] };
  const knowledge = details.knowledge || {};
  const history = details.versionHistory || [];
  const deps = (details.dependencies && details.dependencies.dependencies) || [];
  const dependents = details.dependents || [];
  const configs = details.configs || [];
  const plan = details.knownGoodPlan || {};
  const user = details.userEntry || {};
  const tree = deps.map((dep, i) => `${i === deps.length - 1 ? "└─" : "├─"} ${dep.name}`).join("<br />");
  showOverlay(`
    <p class="eyebrow">MOD DETAILS</p>
    <h2>${escapeHtml(knowledge.displayName || (details.mod && details.mod.name) || installId)}</h2>
    <p>${escapeHtml(health.status)}</p>
    ${
      health.runtime
        ? `<p>Runtime: ${escapeHtml(health.runtime.status)}${health.runtime.ruleTier ? ` · ${escapeHtml(health.runtime.ruleTier)}` : ""}${
            health.runtime.confidence ? ` · ${escapeHtml(health.runtime.confidence)}` : ""
          }${health.runtime.evidence ? ` — ${escapeHtml(health.runtime.evidence)}` : ""}</p>`
        : `<p>Runtime: unverified — waiting for a Duty load signal.</p>`
    }
    <ul>${(health.reasons || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>
    ${
      (details.runtimeHistory || []).length
        ? `<h3>Runtime by version</h3><ul>${details.runtimeHistory
            .map((row) => `<li>${escapeHtml(row.version)} — ${row.worked} working · ${row.failed} failed</li>`)
            .join("")}</ul>`
        : ""
    }
    <p>Installed: ${escapeHtml((details.mod && details.mod.version) || "UNKNOWN")}<br />Known-good: ${escapeHtml(knowledge.knownGoodVersion || "none")}${knowledge.hasUserOverride ? "<br /><em>Some fields are your local notes, not verified global truth.</em>" : ""}</p>
    <h3>Version history</h3>
    <ul>${history.map((row) => `<li>${escapeHtml(row.version)}${row.current ? " — current" : ""}${row.knownGood ? " — known good" : ""}${row.hasPayload ? "" : " (no payload)"}</li>`).join("") || "<li>No stored versions.</li>"}</ul>
    <h3>Dependencies</h3>
    <p>${tree || "None recorded."}</p>
    ${dependents.length ? `<p>${escapeHtml((details.mod && details.mod.name) || "This mod")} is required by:<br />${dependents.map((row) => `• ${escapeHtml(row.name)}`).join("<br />")}</p>` : ""}
    ${mdtBlock(details.mdt || (health && health.mdt))}
    <h3>Keybinds</h3>
    ${keybindBlock(details.keybinds)}
    <h3>Managed configs</h3>
    <ul>${configs.map((row) => `<li><code>${escapeHtml(row.destination)}</code> ${row.modifiedFromDefault ? "modified from default" : "matches default"} · last changed ${escapeHtml(formatWhen(row.lastChanged))}<br />
      <button data-cdiff="${escapeHtml(row.destination)}" class="ghost" type="button">View differences</button>
      <button data-cdef="${escapeHtml(row.destination)}" class="ghost" type="button">Restore default</button></li>`).join("") || "<li>None.</li>"}</ul>
    <div class="row-actions">
      <button id="md-edit" type="button">Edit local metadata</button>
      <button id="md-runtime" class="ghost" type="button">Set runtime verification rule</button>
      <button id="md-kg" class="ghost" type="button">Mark current version as Known Good</button>
      <button id="md-restore" class="ghost" type="button" ${plan.available ? "" : "disabled"}>Restore Known-Good Version</button>
    </div>
    ${developerMode() ? `<h3>Developer</h3><p class="muted">installId ${escapeHtml(installId)}<br />canonical ${escapeHtml((details.mod && details.mod.canonicalModId) || "none")}<br />manifest ${escapeHtml((details.manifest && details.manifest.id) || "")}</p>${
      (details.runtimeSuggestions || []).length
        ? `<p>Possible runtime verification signal found:</p><ul>${details.runtimeSuggestions
            .slice(0, 4)
            .map((line) => `<li><code>${escapeHtml(line)}</code></li>`)
            .join("")}</ul><p class="muted">Use Set runtime verification rule to confirm. Nothing is saved automatically.</p>`
        : ""
    }` : ""}
    <div class="dialog-actions"><button id="md-close" class="ghost" type="button">Close</button></div>
  `, true);
  $("md-close").onclick = hideOverlay;
  $("md-edit").onclick = () => showKnowledgeEditor(details);
  if ($("md-runtime")) $("md-runtime").onclick = () => showRuntimeRuleEditor(details);
  $("md-kg").onclick = async () => {
    await window.tactix.knowledgeMarkKnownGood({ installId, version: details.mod && details.mod.version });
    showModDetails(installId);
  };
  $("md-restore").onclick = async () => {
    if (!plan.available) return;
    if (!window.confirm(`Restore ${plan.name || "this mod"} from ${plan.from} to known-good ${plan.to}?`)) return;
    try {
      await window.tactix.updateRestoreKnownGood(installId);
      await refresh();
      await refreshSmart();
      hideOverlay();
    } catch (error) {
      addLog({ level: "error", message: userError(error) });
    }
  };
  ui.dialog.querySelectorAll("button[data-cdiff]").forEach((button) => {
    button.onclick = async () => {
      const diff = await window.tactix.configDiff({ installId, destination: button.dataset.cdiff });
      window.alert(`${button.dataset.cdiff}\n\n${JSON.stringify((diff.diff && diff.diff.changes) || diff.diff || {}, null, 2)}`);
    };
  });
  ui.dialog.querySelectorAll("button[data-cdef]").forEach((button) => {
    button.onclick = async () => {
      if (!window.confirm(`Restore the installed default for ${button.dataset.cdef}?`)) return;
      await window.tactix.configRestoreDefault({ installId, destination: button.dataset.cdef });
      showModDetails(installId);
    };
  });
}

function showRuntimeRuleEditor(details) {
  const rule = details.runtimeRule;
  const current = (rule && rule.positiveSignals && rule.positiveSignals[0] && rule.positiveSignals[0].contains) || "";
  const suggestions = details.runtimeSuggestions || [];
  showOverlay(`
    <p class="eyebrow">RUNTIME RULE</p>
    <h2>Set runtime verification rule</h2>
    <p class="muted">When this text appears in a Duty RPH or LSPDFR log, mark this mod as working. Contains or exact match only. No scripts. Saved on this PC, not in built-in knowledge.</p>
    ${current ? `<p>Current rule: <code>${escapeHtml(current)}</code></p>` : "<p>No local rule yet.</p>"}
    <p><label>Log line<br /><textarea id="rt-line" rows="3">${escapeHtml(current)}</textarea></label></p>
    <p><label><input id="rt-exact" type="checkbox" /> Match the whole line exactly</label></p>
    ${
      suggestions.length
        ? `<h3>Possible signals from the last session</h3><p class="muted">Confirmation required. Nothing is saved until you choose one.</p><ul>${suggestions
            .map((line, index) => `<li><code>${escapeHtml(line)}</code><br /><button type="button" class="ghost" data-rsig="${index}">Use this as a local verification rule?</button></li>`)
            .join("")}</ul>`
        : ""
    }
    <div class="dialog-actions">
      <button id="rt-save" type="button">Save rule</button>
      <button id="rt-clear" class="ghost" type="button" ${current ? "" : "disabled"}>Clear rule</button>
      <button id="rt-cancel" class="ghost" type="button">Cancel</button>
    </div>
  `, true);
  const applyContains = async (contains, match) => {
    const result = await window.tactix.runtimeSetRule({
      installId: details.installId,
      canonicalModId: details.mod && details.mod.canonicalModId,
      contains,
      match,
      source: "USER_OVERRIDE",
    });
    if (result && result.error) {
      addLog({ level: "error", message: result.error });
      return;
    }
    await refreshSmart();
    showModDetails(details.installId);
  };
  $("rt-cancel").onclick = () => showModDetails(details.installId);
  $("rt-save").onclick = () => applyContains($("rt-line").value, $("rt-exact").checked ? "exact" : "contains");
  $("rt-clear").onclick = async () => {
    await window.tactix.runtimeClearRule({
      installId: details.installId,
      canonicalModId: details.mod && details.mod.canonicalModId,
    });
    await refreshSmart();
    showModDetails(details.installId);
  };
  ui.dialog.querySelectorAll("button[data-rsig]").forEach((button) => {
    button.onclick = () => {
      const line = suggestions[Number(button.dataset.rsig)];
      if (!line) return;
      if (!window.confirm(`Use this as a local verification rule?\n\n${line}`)) return;
      applyContains(line, "contains");
    };
  });
}

function showKnowledgeEditor(details) {
  const user = details.userEntry || {};
  showOverlay(`
    <p class="eyebrow">LOCAL METADATA</p>
    <h2>Edit local metadata</h2>
    <p class="muted">Saved only on this PC. Marked as user-provided, not verified global truth.</p>
    <p><label>Display name<br /><input id="kn-name" value="${escapeHtml(user.displayName || "")}" /></label></p>
    <p><label>Version override<br /><input id="kn-ver" value="${escapeHtml(user.versionOverride || "")}" /></label></p>
    <p><label>Notes<br /><textarea id="kn-notes">${escapeHtml(user.notes || "")}</textarea></label></p>
    <p><label>Source URL<br /><input id="kn-home" value="${escapeHtml(user.homepage || "")}" /></label></p>
    <details>
      <summary>Advanced</summary>
      <p><label>Category<br /><input id="kn-cat" value="${escapeHtml(user.category || "")}" /></label></p>
      <p><label>Compatibility note<br /><input id="kn-compat" value="${escapeHtml(user.compatibilityNotes || "")}" /></label></p>
      <p><label>Known-good version<br /><input id="kn-kg" value="${escapeHtml(user.knownGoodVersion || "")}" /></label></p>
    </details>
    <div class="dialog-actions">
      <button id="kn-save" type="button">Save</button>
      <button id="kn-cancel" class="ghost" type="button">Cancel</button>
    </div>
  `, true);
  $("kn-cancel").onclick = () => showModDetails(details.installId);
  $("kn-save").onclick = async () => {
    await window.tactix.knowledgeSet({
      installId: details.installId,
      canonicalModId: details.mod && details.mod.canonicalModId,
      patch: {
        displayName: $("kn-name").value,
        versionOverride: $("kn-ver").value,
        notes: $("kn-notes").value,
        homepage: $("kn-home").value,
        category: $("kn-cat") ? $("kn-cat").value : "",
        compatibilityNotes: $("kn-compat") ? $("kn-compat").value : "",
        knownGoodVersion: $("kn-kg") ? $("kn-kg").value : "",
      },
    });
    showModDetails(details.installId);
  };
}

async function showTroubleshoot() {
  const result = await window.tactix.troubleshoot();
  showOverlay(`
    <p class="eyebrow">TROUBLESHOOT DUTY</p>
    <h2>Guided check</h2>
    <p>Nothing is changed automatically.</p>
    <ul class="check-list">${(result.steps || []).map((step) => `<li><i class="lamp ${step.status === "ok" ? "ok" : step.status === "bad" ? "bad" : "warn"}"></i><div><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.detail)}</small></div></li>`).join("")}</ul>
    <h3>Suggested next action</h3>
    <p><strong>${escapeHtml(result.suggestion.title)}</strong><br />${escapeHtml(result.suggestion.detail)}</p>
    <div class="dialog-actions">
      <button id="ts-go" type="button">Do that</button>
      <button id="ts-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("ts-close").onclick = hideOverlay;
  $("ts-go").onclick = () => {
    hideOverlay();
    const action = result.suggestion.action;
    if (action === "RESTORE_KNOWN_GOOD") $("btn-known-good").click();
    else if (action === "OPEN_PROFILES") showProfiles();
    else if (action === "OPEN_MODS") showPage("mods");
    else if (action === "RUN_HEALTH") $("btn-tests").click();
    else if (action === "OPEN_CRASH") $("btn-sessions").click();
  };
}

async function showDiagnostics() {
  const check = await window.tactix.selfCheck();
  const audit = await window.tactix.auditLog(40);
  const usage = await window.tactix.storageUsage();
  const mb = (n) => `${((Number(n) || 0) / (1024 * 1024)).toFixed(1)} MB`;
  const kinds = ["INSTALL", "UPDATE", "PROFILE_SWITCH", "SNAPSHOT", "CRASH_ACTION", "REPAIR"];
  showOverlay(`
    <p class="eyebrow">DIAGNOSTICS</p>
    <h2>Check Mod Manager</h2>
    <p>Mod Manager Health: <strong>${escapeHtml(check.appHealth)}</strong></p>
    <ul>${(check.checks || []).map((row) => `<li>${row.ok ? "✓" : "•"} ${escapeHtml(row.detail)}</li>`).join("")}</ul>
    ${(check.dutyWarnings || []).length
      ? `<h3>Current Duty Warnings</h3><ul>${check.dutyWarnings
          .map((row) => `<li><strong>${escapeHtml(row.status)}</strong> — ${escapeHtml(row.title)}</li>`)
          .join("")}</ul>`
      : ""}
    <h3>Storage & Recovery</h3>
    <p>Payloads ${mb(usage.payloads)} · Backups ${mb(usage.backups)} · Snapshots ${mb(usage.snapshots)} · Sessions ${mb(usage.sessions)}</p>
    <div class="row-actions">
      <button id="diag-logs" type="button">Log viewer</button>
      <button id="diag-export" class="ghost" type="button">Export Diagnostic Report</button>
      <button id="diag-backup" class="ghost" type="button">Export Manager Backup</button>
      <button id="diag-import" class="ghost" type="button">Import Manager Backup</button>
      <button id="diag-clean" class="ghost" type="button">Clean unused files</button>
    </div>
    <h3>Audit</h3>
    <div class="filter-row">${kinds.map((k) => `<button data-akind="${k}" class="ghost" type="button">${k}</button>`).join("")}</div>
    <ul id="audit-list">${audit.map((row) => `<li>${escapeHtml(row.event)} · ${escapeHtml(row.name || row.installId || "")}</li>`).join("")}</ul>
    ${developerMode() ? `<h3>Developer</h3><p class="muted">Inventory, recognition, manifests, and scores stay on this PC. No telemetry.</p>` : ""}
    <div class="dialog-actions"><button id="diag-close" class="ghost" type="button">Close</button></div>
  `, true);
  $("diag-close").onclick = hideOverlay;
  $("diag-logs").onclick = () => showLogViewer();
  $("diag-export").onclick = async () => {
    const result = await window.tactix.exportDiagnostics();
    if (!result.canceled) addLog({ level: "ok", message: `Diagnostic report written to ${result.path}` });
  };
  $("diag-backup").onclick = async () => {
    const result = await window.tactix.backupExport();
    if (!result.canceled) addLog({ level: "ok", message: `Manager backup written to ${result.path}` });
  };
  $("diag-import").onclick = async () => {
    const preview = await window.tactix.backupImportPlan();
    if (preview.canceled) return;
    if (!preview.plan.valid) {
      addLog({ level: "error", message: "That backup folder is not valid." });
      return;
    }
    if (!window.confirm("Import this manager backup? Review the plan first — Duty files are not rewritten blindly.")) return;
    await window.tactix.backupImportApply({ dir: preview.dir });
    await refresh();
  };
  $("diag-clean").onclick = async () => {
    const plan = await window.tactix.storageCleanupPlan();
    const ok = window.confirm(`Remove ${plan.candidates.length} unused item(s)? Pinned, known-good, and active payloads stay.`);
    if (!ok) return;
    await window.tactix.storageCleanupApply(plan.candidates.map((row) => row.id));
    addLog({ level: "ok", message: "Unused manager files were cleaned." });
  };
  ui.dialog.querySelectorAll("button[data-akind]").forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.akind;
      $("audit-list").innerHTML = audit
        .filter((row) => String(row.event || "").includes(kind) || String(row.event || "").includes(kind.replace("_", "")))
        .map((row) => `<li>${escapeHtml(row.event)} · ${escapeHtml(row.name || row.installId || "")}</li>`)
        .join("") || "<li>None.</li>";
    };
  });
}

async function showLogViewer() {
  const logs = await window.tactix.logsList();
  showOverlay(`
    <p class="eyebrow">LOGS</p>
    <h2>Log viewer</h2>
    <div class="filter-row">${logs.map((row) => `<button data-log="${escapeHtml(row.path)}" class="ghost" type="button">${escapeHtml(row.name)}</button>`).join("") || "<span>No logs found.</span>"}</div>
    <input id="log-search" class="log-search" type="search" placeholder="Search" />
    <pre id="log-text" class="log-viewer">Pick a log.</pre>
    <div class="dialog-actions">
      <button id="log-copy" class="ghost" type="button">Copy</button>
      <button id="log-open" class="ghost" type="button">Open file location</button>
      <button id="log-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  let current = logs[0] ? logs[0].path : "";
  const load = async () => {
    if (!current) return;
    const read = await window.tactix.logsRead({ filePath: current, tailLines: 200, search: $("log-search").value });
    $("log-text").textContent = read.text || "(empty)";
  };
  if (current) load();
  ui.dialog.querySelectorAll("button[data-log]").forEach((button) => {
    button.onclick = () => {
      current = button.dataset.log;
      load();
    };
  });
  $("log-search").oninput = () => load();
  $("log-copy").onclick = () => navigator.clipboard.writeText($("log-text").textContent);
  $("log-open").onclick = () => current && window.tactix.openPath(current.replace(/[^\\/]+$/, ""));
  $("log-close").onclick = hideOverlay;
}

const WORKSHOP_CHIPS = [
  { id: "", label: "All" },
  { id: "FEATURED", label: "Featured" },
  { id: "ESSENTIAL", label: "Essential" },
  { id: "PLUGINS", label: "Plugins" },
  { id: "CALLOUTS", label: "Callouts" },
  { id: "DISPATCH", label: "Dispatch" },
  { id: "MDT", label: "MDT" },
  { id: "BACKUP", label: "Backup" },
  { id: "IMMERSION", label: "Immersion" },
  { id: "FRAMEWORKS", label: "Frameworks" },
  { id: "VEHICLES", label: "Vehicles" },
  { id: "EUP", label: "EUP" },
  { id: "ENHANCED", label: "Enhanced" },
  { id: "INSTALLED", label: "Installed" },
  { id: "UPDATES", label: "Updates" },
  { id: "FAVORITES", label: "Favorites" },
];

function workshopQuery() {
  const chip = document.querySelector(".workshop-chip.is-active");
  return {
    query: ($("workshop-search") && $("workshop-search").value) || "",
    filter: ($("workshop-filter") && $("workshop-filter").value) || (chip && chip.dataset.filter) || "",
  };
}

function depMark(dep) {
  return dep.installed ? "✓" : "✕";
}

function renderWorkshopCard(mod) {
  const installed = mod.installedState || {};
  const deps = (mod.dependencies || []).slice(0, 4);
  const update = installed.updateAvailable
    ? `<p>Installed ${escapeHtml(installed.installedVersion || "?")} · Available ${escapeHtml(installed.sourceVersion || "?")}${installed.updateRisk ? ` · Risk ${escapeHtml(installed.updateRisk.level)}` : ""}</p>`
    : "";
  return `
    <article class="mod workshop-card" data-workshop-id="${escapeHtml(mod.workshopId)}">
      <i class="lamp ${installed.installed ? "ok" : "grey"}"></i>
      <div class="mod-main">
        <h3>${escapeHtml(mod.name)}</h3>
        <p>${escapeHtml(mod.categoryLabel)} · ${escapeHtml(mod.sourceBadge)} · Enhanced ${escapeHtml(mod.enhancedLabel)}</p>
        <p>${deps.length ? `Dependencies: ${deps.map((d) => `${depMark(d)} ${escapeHtml(d.name)}`).join(" · ")}` : "Dependencies: none recorded"}</p>
        <p>Installed: ${installed.installed ? escapeHtml(installed.installedVersion || "Yes") : "No"}${mod.favorite ? " · Favorite" : ""}</p>
        ${update}
        ${mod.archiveInstallUnsupported ? `<p class="muted">Vehicle/EUP archive · automatic install not supported for encrypted Enhanced archives</p>` : ""}
      </div>
      <div class="mod-actions">
        <button data-wact="details" type="button">Details</button>
        <button class="ghost" data-wact="get" type="button">${installed.updateAvailable ? "Get update" : "Get mod"}</button>
        <button class="ghost" data-wact="fav" type="button">${mod.favorite ? "Unfavorite" : "Favorite"}</button>
      </div>
    </article>
  `;
}

async function applyWorkshopHandoff(preview) {
  if (!workshopHandoff) return true;
  const check = await window.tactix.workshopEvaluateHandoff({ expected: workshopHandoff, preview });
  if (check && check.mismatch) {
    return window.confirm(`${check.message}\n\nAnalyze this file with Smart Install anyway?`);
  }
  if (check && check.weak && check.message) {
    return window.confirm(`${check.message}\n\nContinue to Smart Install preview?`);
  }
  return true;
}

async function importWorkshopFiles(paths, handoff = workshopHandoff) {
  if (handoff) workshopHandoff = handoff;
  await smartIngest(paths);
}

async function showWorkshopDetails(workshopId) {
  const mod = await window.tactix.workshopDetails(workshopId);
  if (!mod) return;
  const installed = mod.installedState || {};
  const deps = (mod.dependencies || [])
    .map((dep) => `<li><button class="ghost" data-wdep="${escapeHtml(dep.workshopId)}" type="button">${dep.installed ? "✓" : "✕"} ${escapeHtml(dep.name)}</button></li>`)
    .join("");
  const used = (mod.usedBy || []).map((row) => `<li>${escapeHtml(row.name)}</li>`).join("");
  const order = (mod.installOrder || []).map((row) => `<li>${row.step}. ${escapeHtml(row.name)}</li>`).join("");
  const collections = (await window.tactix.workshopLibrary()).collections || [];
  showOverlay(`
    <p class="eyebrow">BROWSE MODS</p>
    <h2>${escapeHtml(mod.name)}</h2>
    <p>${escapeHtml(mod.sourceBadge)} · ${escapeHtml(mod.categoryLabel)}${mod.author ? ` · ${escapeHtml(mod.author)}` : ""}</p>
    <p>${escapeHtml(mod.description || "")}</p>
    <p>Version: ${escapeHtml(mod.version || "See official page")}<br />Installed: ${installed.installed ? escapeHtml(installed.installedVersion || "Yes") : "No"}${installed.knownGoodVersion ? `<br />Known-good: ${escapeHtml(installed.knownGoodVersion)}` : ""}</p>
    <p>Enhanced compatibility: ${escapeHtml(mod.enhancedLabel)} <span class="muted">(local manager data, not the source page)</span></p>
    ${mod.archiveInstallUnsupported ? `<p><strong>Vehicle / archive mod</strong><br />Automatic installation is not supported for encrypted GTA V Enhanced archives.</p>` : ""}
    <h3>Dependencies</h3>
    <ul>${deps || "<li>None recorded locally.</li>"}</ul>
    ${order ? `<h3>Recommended install order</h3><ol>${order}</ol>` : ""}
    ${used ? `<h3>Used by</h3><ul>${used}</ul>` : ""}
    ${(mod.conflicts || []).length ? `<h3>Known conflicts</h3><ul>${mod.conflicts.map((row) => `<li>${escapeHtml(row.name)}${row.reason ? ` — ${escapeHtml(row.reason)}` : ""}</li>`).join("")}</ul>` : ""}
    <p>Local crash history: ${mod.crash && mod.crash.failed ? `${mod.crash.failed} failed / ${mod.crash.clean} clean (correlation, not proof)` : "None"}</p>
    <p>Health: ${escapeHtml((mod.health && mod.health.status) || "n/a")}</p>
    <p class="muted">${escapeHtml(mod.licenseNote)}</p>
    <p class="muted">A source page is not a safety rating. Smart Install still decides whether a downloaded file can be installed.</p>
    <div class="field">
      <label>Add to collection</label>
      <select id="w-col">${["<option value=''>Choose…</option>"].concat(collections.map((col) => `<option value="${escapeHtml(col.id)}">${escapeHtml(col.name)}</option>`)).join("")}</select>
    </div>
    <div class="dialog-actions">
      <button id="w-open" type="button">Open official page</button>
      <button id="w-fav" class="ghost" type="button">${mod.favorite ? "Unfavorite" : "Favorite"}</button>
      <button id="w-newcol" class="ghost" type="button">New collection</button>
      <button id="w-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("w-close").onclick = hideOverlay;
  $("w-open").onclick = () => getWorkshopMod(mod.workshopId);
  $("w-fav").onclick = async () => {
    await window.tactix.workshopFavoriteToggle(mod.workshopId);
    hideOverlay();
    await refreshWorkshop();
  };
  $("w-newcol").onclick = async () => {
    const name = window.prompt("Collection name");
    if (!name) return;
    const next = await window.tactix.workshopCollectionCreate(name);
    const created = (next.collections || []).slice(-1)[0];
    if (created) await window.tactix.workshopCollectionAdd({ collectionId: created.id, workshopId: mod.workshopId });
    hideOverlay();
    await refreshWorkshop();
  };
  $("w-col").onchange = async () => {
    const id = $("w-col").value;
    if (!id) return;
    await window.tactix.workshopCollectionAdd({ collectionId: id, workshopId: mod.workshopId });
    addLog({ level: "ok", message: `Added ${mod.name} to a collection.` });
  };
  ui.dialog.querySelectorAll("[data-wdep]").forEach((button) => {
    button.onclick = () => showWorkshopDetails(button.dataset.wdep);
  });
}

async function getWorkshopMod(workshopId) {
  const result = await window.tactix.workshopGetMod(workshopId);
  if (!result || !result.ok) {
    addLog({ level: "error", message: "That catalog entry has no official page." });
    return;
  }
  workshopHandoff = result.handoff;
  addLog({
    level: "info",
    message: result.opened
      ? `Opened the official page for ${result.handoff.expectedName}. Download the zip, then Import Download or use the inbox.`
      : `Official page ready. Import the downloaded archive into Smart Install.`,
  });
}

async function refreshWorkshopInbox() {
  if (!$("workshop-inbox")) return;
  const inbox = await window.tactix.workshopInbox();
  const items = inbox.items || [];
  $("workshop-inbox").innerHTML = items.length
    ? items
        .map(
          (row) => `<article class="workshop-inbox-row" data-inbox-path="${escapeHtml(row.path)}">
            <div><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.state)}</small></div>
            <div class="mod-actions">
              <button data-iact="analyze" type="button">Analyze</button>
              <button class="ghost" data-iact="ignore" type="button">Ignore</button>
            </div>
          </article>`
        )
        .join("")
    : `<p class="muted">No new downloads waiting.</p>`;
  $("workshop-inbox").querySelectorAll("[data-iact]").forEach((button) => {
    button.onclick = async () => {
      const row = button.closest("[data-inbox-path]");
      const filePath = row && row.dataset.inboxPath;
      if (!filePath) return;
      if (button.dataset.iact === "ignore") {
        await window.tactix.workshopInboxIgnore(filePath);
        await refreshWorkshopInbox();
        return;
      }
      const ok = window.confirm("Analyze this archive with Smart Install? Nothing will be installed until you confirm the preview.");
      if (!ok) return;
      if (inbox.watch && inbox.watch.expected) workshopHandoff = inbox.watch.expected;
      await importWorkshopFiles([filePath], workshopHandoff);
      await refreshWorkshop();
    };
  });
  const fresh = items.find((row) => row.state === "NEW" && inbox.watch && inbox.watch.expected);
  if (fresh && fresh.path !== lastWorkshopInboxPrompt) {
    lastWorkshopInboxPrompt = fresh.path;
    const name = (inbox.watch.expected && inbox.watch.expected.expectedName) || "Selected mod";
    const ok = window.confirm(`${name} download detected. Analyze with Smart Install?`);
    if (ok) {
      workshopHandoff = inbox.watch.expected;
      await importWorkshopFiles([fresh.path], workshopHandoff);
      await refreshWorkshop();
    }
  }
}

async function refreshWorkshop() {
  if (!$("workshop-list")) return;
  renderWorkshopChips();
  const data = await window.tactix.workshopBrowse(workshopQuery());
  const notice = [];
  if (data.notice) notice.push(data.notice);
  if (data.api && data.api.message) notice.push(data.api.message);
  if (data.cache && data.cache.lastUpdated) notice.push(`Last updated ${new Date(data.cache.lastUpdated).toLocaleString()}`);
  if ($("workshop-notice")) $("workshop-notice").textContent = notice.join(" · ");
  const rec = data.recommendations || [];
  if ($("workshop-recommend")) {
    $("workshop-recommend").innerHTML = rec.length
      ? `<p class="section-label">Recommended for my setup</p><ul>${rec
          .map((row) => `<li><button class="ghost" data-wrec="${escapeHtml(row.workshopId)}" type="button">${escapeHtml(row.name)}</button> <small>${escapeHtml(row.reason)}</small></li>`)
          .join("")}</ul>`
      : "";
    $("workshop-recommend").querySelectorAll("[data-wrec]").forEach((button) => {
      button.onclick = () => showWorkshopDetails(button.dataset.wrec);
    });
  }
  const rows = data.mods || [];
  $("workshop-list").innerHTML = rows.length ? rows.map(renderWorkshopCard).join("") : `<p class="empty">No catalog mods match that search.</p>`;
  $("workshop-list").querySelectorAll("[data-wact]").forEach((button) => {
    button.onclick = async () => {
      const card = button.closest("[data-workshop-id]");
      const id = card && card.dataset.workshopId;
      if (!id) return;
      if (button.dataset.wact === "details") return showWorkshopDetails(id);
      if (button.dataset.wact === "get") return getWorkshopMod(id);
      await window.tactix.workshopFavoriteToggle(id);
      await refreshWorkshop();
    };
  });
  await refreshWorkshopInbox();
}

function renderWorkshopChips() {
  const host = $("workshop-cats");
  if (!host || host.dataset.ready === "1") return;
  host.innerHTML = WORKSHOP_CHIPS.map((chip) => `<button type="button" class="workshop-chip${chip.id === "" ? " is-active" : ""}" data-filter="${escapeHtml(chip.id)}">${escapeHtml(chip.label)}</button>`).join("");
  host.dataset.ready = "1";
  host.querySelectorAll(".workshop-chip").forEach((button) => {
    button.onclick = () => {
      host.querySelectorAll(".workshop-chip").forEach((row) => row.classList.toggle("is-active", row === button));
      if ($("workshop-filter")) $("workshop-filter").value = button.dataset.filter || "";
      refreshWorkshop().catch((error) => addLog({ level: "error", message: userError(error) }));
    };
  });
}

function startWorkshopInboxWatch() {
  if (workshopInboxTimer) return;
  workshopInboxTimer = setInterval(() => {
    if (currentPage === "browse") refreshWorkshopInbox().catch(() => {});
  }, 4000);
}

async function showPrefs() {
  const cfg = await window.tactix.settingsGet();
  const profiles = await window.tactix.profileList();
  showOverlay(`
    <p class="eyebrow">SETTINGS</p>
    <h2>Personal settings</h2>
    <p><label>Default profile<br /><select id="set-profile">${["<option value=''>None</option>"].concat(profiles.map((p) => `<option value="${escapeHtml(p.profileId)}" ${cfg.defaultProfileId === p.profileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)).join("")}</select></label></p>
    <p><label><input id="set-snap-update" type="checkbox" ${cfg.snapshotBeforeUpdate ? "checked" : ""} /> Create snapshot before update</label></p>
    <p><label><input id="set-snap-risk" type="checkbox" ${cfg.snapshotBeforeRiskyInstall !== false ? "checked" : ""} /> Create snapshot before risky install</label></p>
    <p><label><input id="set-preview" type="checkbox" ${cfg.smartPreviewDefault ? "checked" : ""} /> Smart Install preview default</label></p>
    <p class="muted">If a pack needs RageNativeUI or another curated dependency, Smart Install offers Download &amp; install from the official GitHub release. LCPDFR.com files (like Damage Tracker Framework) still need you to download the zip, then drop it here.</p>
    <p><label><input id="set-guides" type="checkbox" ${cfg.lookupInstallGuides !== false ? "checked" : ""} /> Look up public install notes during preview</label></p>
    <p><label><input id="set-ai" type="checkbox" ${cfg.aiGuideEnabled ? "checked" : ""} /> Use AI to summarize install notes and Analyze Mods (optional)</label></p>
    <div class="field">
      <label>AI API key (kept on this PC)</label>
      <input id="set-ai-key" type="password" autocomplete="off" placeholder="${cfg.aiApiKey ? "Saved — leave blank to keep" : "Optional"}" />
    </div>
    <div class="field">
      <label>AI endpoint</label>
      <input id="set-ai-url" value="${escapeHtml(cfg.aiApiUrl || "")}" placeholder="https://api.openai.com/v1/chat/completions" />
    </div>
    <p><label>Session retention <input id="set-sess" type="number" min="5" max="200" value="${Number(cfg.sessionRetention) || 40}" /></label></p>
    <p><label>Automatic snapshot retention <input id="set-auto" type="number" min="5" max="40" value="${Number(cfg.autoSnapshotRetention) || 15}" /></label></p>
    <p><label><input id="set-last" type="checkbox" ${cfg.openLastPage ? "checked" : ""} /> Open last active page</label></p>
    <p class="section-label">Workshop</p>
    <p>LCPDFR API: ${escapeHtml((cfg.workshopApi && cfg.workshopApi.status) || "not_configured")}${cfg.lcpdfrApiConfigured ? " (key saved on this PC)" : ""}</p>
    <p class="muted">${escapeHtml((cfg.workshopApi && cfg.workshopApi.message) || "Browse Mods works without a key using the local catalog.")}</p>
    <div class="field">
      <label>LCPDFR API key</label>
      <input id="set-lcpdfr-key" type="password" autocomplete="off" placeholder="${cfg.lcpdfrApiConfigured ? "Saved — leave blank to keep" : "Optional. Never enter your LCPDFR password."}" />
    </div>
    <div class="field">
      <label>Download directory</label>
      <input id="set-dl-dir" value="${escapeHtml(cfg.workshopDownloadDirectory || "")}" placeholder="Leave blank for your user Downloads folder" />
    </div>
    <p><label><input id="set-watch" type="checkbox" ${cfg.workshopWatchDownloads ? "checked" : ""} /> Watch Downloads after Get Mod</label></p>
    <p><label>Cache retention (hours) <input id="set-cache-hrs" type="number" min="1" max="168" value="${Number(cfg.workshopCacheRetentionHours) || 24}" /></label></p>
    <p><label><input id="set-open-src" type="checkbox" ${cfg.workshopOpenSourceLinks !== false ? "checked" : ""} /> Open official source links in the browser</label></p>
    <p class="section-label">Appearance</p>
    <div class="theme-switch" role="group" aria-label="Appearance">
      <button id="set-theme-dark" type="button">Dark</button>
      <button id="set-theme-bright" type="button">Bright</button>
    </div>
    <p><label><input id="set-dev" type="checkbox" ${cfg.developerMode ? "checked" : ""} /> Developer mode</label></p>
    <div class="dialog-actions">
      <button id="set-save" type="button">Save</button>
      <button id="set-close" class="ghost" type="button">Close</button>
    </div>
  `, true);
  $("set-close").onclick = hideOverlay;
  let prefTheme = normalizeTheme(cfg.theme || storedTheme());
  const markPrefTheme = () => {
    $("set-theme-dark").classList.toggle("is-active", prefTheme === "dark");
    $("set-theme-bright").classList.toggle("is-active", prefTheme === "bright");
  };
  markPrefTheme();
  $("set-theme-dark").onclick = () => {
    prefTheme = "dark";
    applyTheme(prefTheme, true);
    markPrefTheme();
  };
  $("set-theme-bright").onclick = () => {
    prefTheme = "bright";
    applyTheme(prefTheme, true);
    markPrefTheme();
  };
  $("set-save").onclick = async () => {
    const patch = {
      defaultProfileId: $("set-profile").value,
      snapshotBeforeUpdate: $("set-snap-update").checked,
      snapshotBeforeRiskyInstall: $("set-snap-risk").checked,
      smartPreviewDefault: $("set-preview").checked,
      lookupInstallGuides: $("set-guides").checked,
      aiGuideEnabled: $("set-ai").checked,
      aiApiUrl: $("set-ai-url").value.trim(),
      sessionRetention: Number($("set-sess").value),
      autoSnapshotRetention: Number($("set-auto").value),
      openLastPage: $("set-last").checked,
      developerMode: $("set-dev").checked,
      theme: prefTheme,
      workshopDownloadDirectory: $("set-dl-dir").value.trim(),
      workshopWatchDownloads: $("set-watch").checked,
      workshopCacheRetentionHours: Number($("set-cache-hrs").value),
      workshopOpenSourceLinks: $("set-open-src").checked,
    };
    const key = $("set-ai-key").value.trim();
    if (key) patch.aiApiKey = key;
    await window.tactix.settingsSave(patch);
    const lcpdfr = $("set-lcpdfr-key").value.trim();
    if (lcpdfr) await window.tactix.workshopSetApiKey(lcpdfr);
    hideOverlay();
  };
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.onclick = () => {
    const page = button.dataset.page;
    if (page === "profiles") showProfiles().catch((error) => addLog({ level: "error", message: userError(error) }));
    else if (page === "recovery") showRecovery().catch((error) => addLog({ level: "error", message: userError(error) }));
    else if (page === "sessions") showSessionHistory().catch((error) => addLog({ level: "error", message: userError(error) }));
    else if (page === "diagnostics") showDiagnostics().catch((error) => addLog({ level: "error", message: userError(error) }));
    else if (page === "prefs") showPrefs().catch((error) => addLog({ level: "error", message: userError(error) }));
    else showPage(page);
  };
});

if ($("btn-refresh")) $("btn-refresh").onclick = () => refreshScreen();

function analyzeRowAction(row) {
  const fix = row.fix || {};
  if (fix.fixable) {
    return `<button class="ghost" type="button" data-fix-id="${escapeHtml(row.installId || "")}" data-fix-source="${escapeHtml(
      row.source || ""
    )}">Do this</button>`;
  }
  return "";
}

function showAnalyzeResults(result, report = null) {
  const todos = result.todos || (result.summary || []).filter((row) => row.nextStep && row.nextStep.needed);
  const reportLines = ((report && report.results) || [])
    .map((row) => `<li>${escapeHtml(row.name || "Mod")}: ${escapeHtml(row.message || (row.ok ? "Done." : "Failed."))}</li>`)
    .join("");
  const list = todos
    .slice(0, 40)
    .map((row, index) => {
      const step = (row.nextStep && row.nextStep.do) || (row.reasons && row.reasons[0]) || "";
      return `<li class="${row.fix && row.fix.fixable ? "has-fix" : ""}"><i class="lamp ${row.lamp || "warn"}"></i><div><strong>${
        index + 1
      }. ${escapeHtml(row.name)}</strong><small>${escapeHtml(step)}</small></div>${analyzeRowAction(row)}</li>`;
    })
    .join("");
  const canFix = todos.some((row) => row.fix && row.fix.fixable);
  showOverlay(
    `
        <p class="eyebrow">ANALYZE MODS</p>
        <h2>What to do</h2>
        ${reportLines ? `<p class="section-label">Just done</p><ul>${reportLines}</ul>` : ""}
        <ul class="check-list">${list || "<li>Nothing you need to do.</li>"}</ul>
        <div class="dialog-actions">
          ${canFix ? `<button id="an-fix-all" type="button">Do everything the app can</button>` : ""}
          <button id="an-close" class="ghost" type="button">Close</button>
        </div>
      `,
    true
  );
  $("an-close").onclick = hideOverlay;
  if ($("an-fix-all")) $("an-fix-all").onclick = () => applyAnalyzeFix({ all: true });
  ui.dialog.querySelectorAll("button[data-fix-id]").forEach((button) => {
    button.onclick = () => applyAnalyzeFix({ installId: button.dataset.fixId, source: button.dataset.fixSource });
  });
}

async function applyAnalyzeFix(payload) {
  try {
    setBusy(true);
    const next = payload.all
      ? await window.tactix.modsFixAll()
      : await window.tactix.modsFixOne({ installId: payload.installId, source: payload.source });
    const report = next.report || {};
    if (report.fixed) addLog({ level: "ok", message: `Fixed ${report.fixed} issue(s) from Analyze Mods.` });
    if (report.failed) addLog({ level: "error", message: `${report.failed} automatic fix(es) failed.` });
    if (!report.fixed && !report.failed && next.message) addLog({ level: "warn", message: next.message });
    const analysis = next.analysis || (await window.tactix.modsAnalyzeAll());
    renderModCondition(analysis);
    await refreshSmart();
    renderState(await window.tactix.state());
    showAnalyzeResults(analysis, report);
  } catch (error) {
    addLog({ level: "error", message: userError(error) });
  } finally {
    setBusy(false);
  }
}

if ($("btn-analyze-mods")) {
  $("btn-analyze-mods").onclick = async () => {
    try {
      setBusy(true);
      const result = await window.tactix.modsAnalyzeAll();
      renderModCondition(result);
      await refreshSmart();
      renderState(await window.tactix.state());
      showAnalyzeResults(result);
    } catch (error) {
      addLog({ level: "error", message: userError(error) });
    } finally {
      setBusy(false);
    }
  };
}
document.addEventListener("keydown", (event) => {
  if (event.key === "F5") {
    event.preventDefault();
    refreshScreen();
  }
});
if ($("theme-dark")) $("theme-dark").onclick = () => applyTheme("dark", true);
if ($("theme-bright")) $("theme-bright").onclick = () => applyTheme("bright", true);
if ($("btn-troubleshoot")) $("btn-troubleshoot").onclick = () => showTroubleshoot().catch((error) => addLog({ level: "error", message: userError(error) }));
if ($("btn-dash-tests")) $("btn-dash-tests").onclick = () => $("btn-tests").click();
if ($("mod-search")) $("mod-search").oninput = () => renderSmartMods();
if ($("mod-filter")) $("mod-filter").onchange = () => renderSmartMods();
if ($("workshop-search")) $("workshop-search").oninput = () => refreshWorkshop().catch((error) => addLog({ level: "error", message: userError(error) }));
if ($("workshop-filter")) $("workshop-filter").onchange = () => refreshWorkshop().catch((error) => addLog({ level: "error", message: userError(error) }));
if ($("workshop-import")) {
  $("workshop-import").onclick = async () => {
    const files = await window.tactix.pickArchives();
    if (!files || !files.length) return;
    await importWorkshopFiles(files, workshopHandoff);
    await refreshWorkshop();
  };
}
if ($("workshop-refresh")) $("workshop-refresh").onclick = () => refreshWorkshop().catch((error) => addLog({ level: "error", message: userError(error) }));
startWorkshopInboxWatch();

window.tactix.onLog(addLog);
window.tactix.onProgress(updateProgress);

refresh().then(async () => {
  addLog({ level: "info", message: "GTA 5 Mod Manager ready. GTA V Enhanced only." });
  refreshSmart();
  refreshDashboard();
  if (state && state.config && state.config.openLastPage && (state.config.lastPage === "mods" || state.config.lastPage === "browse")) showPage(state.config.lastPage);
  else showPage("dashboard");
  if (!state?.config.officialPath || !state?.game.sandboxReady) {
    const found = await window.tactix.detectGame();
    setupForm(found.found ? found : {});
  }
});
