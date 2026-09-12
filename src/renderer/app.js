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
  smartMods: $("smart-mod-list"),
  smartCount: $("smart-count"),
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

const TYPE_SECTIONS = [
  { id: "lspdfr", title: "LSPDFR", hint: "Rage Plugin Hook and LSPD First Response. Keep this enabled.", match: ["lspdfr", "rage"] },
  { id: "script", title: "Scripts / ASI", hint: "Root scripts such as DirectStorageFix. Not GTA Online.", match: ["script"] },
  { id: "vehicle", title: "Cars", hint: "Addon or replacement vehicles for Story Mode.", match: ["vehicle"] },
  { id: "map", title: "Buildings / maps", hint: "Stations, interiors, and world edits.", match: ["map"] },
  { id: "audio", title: "Sound packs", hint: "Sirens and scanner audio. LSPDFR’s own scanner stays with LSPDFR.", match: ["audio"] },
  { id: "uniform", title: "Uniforms", hint: "EUP and wardrobe packs.", match: ["uniform"] },
  { id: "els", title: "ELS", hint: "Emergency lighting configs.", match: ["els"] },
  { id: "other", title: "Other", hint: "Gameconfig, LML, OpenIV, or unrecognized packs.", match: ["gameconfig", "lml", "oiv"] },
];

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
  if (kinds.includes("lspdfr") || kinds.includes("rage")) return "lspdfr";
  for (const section of TYPE_SECTIONS) {
    if (section.id === "lspdfr" || section.id === "other") continue;
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

function renderModCard(mod) {
  const when = new Date(mod.installedAt).toLocaleString();
  const group = primaryKind(mod);
  const extra = labelsFor(mod).filter((label) => {
    if (label === KIND_LABELS[group]) return false;
    if (group === "lspdfr" && label === "Sound packs") return false;
    return true;
  });
  const folder = folderHint(mod);
  const lamp = mod.lamp === "ok" ? "ok" : "bad";
  const lampLabel = mod.lampLabel || (lamp === "ok" ? "Working" : "Not working");
  return `
    <article class="mod ${mod.enabled ? "" : "disabled"}" data-id="${escapeHtml(mod.id)}">
      <i class="lamp ${lamp}" title="${escapeHtml(mod.lampDetail || lampLabel)}"></i>
      <div>
        <h3>${escapeHtml(displayName(mod))}</h3>
        <p><span class="mod-state">${escapeHtml(lampLabel)}</span> · ${mod.fileCount} files${folder ? ` · ${escapeHtml(folder)}` : ""} · ${when}</p>
        ${kindBadges(extra)}
      </div>
      <div class="mod-actions">
        <button class="ghost" data-act="toggle" type="button">${mod.enabled ? "Disable" : "Enable"}</button>
        <button class="ghost" data-act="remove" type="button">Remove</button>
      </div>
    </article>
  `;
}

function renderMods(mods) {
  ui.modCount.textContent = String(mods.length);
  const groups = new Map(TYPE_SECTIONS.map((section) => [section.id, []]));
  for (const mod of mods) {
    const key = primaryKind(mod);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mod);
  }

  ui.mods.innerHTML = TYPE_SECTIONS.map((section) => {
    const items = groups.get(section.id) || [];
    if (!items.length && section.id === "other") return "";
    return `
      <section class="mod-type${items.length ? "" : " is-empty"}" data-type="${section.id}">
        <header class="mod-type-head">
          <div>
            <h3>${escapeHtml(section.title)}</h3>
            <p>${escapeHtml(section.hint)}</p>
          </div>
          <span class="count">${items.length}</span>
        </header>
        ${items.length ? `<div class="mod-type-list">${items.map(renderModCard).join("")}</div>` : ""}
      </section>
    `;
  }).join("");
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
  if (dash) dash.classList.toggle("hidden", page !== "dashboard");
  if (mods) mods.classList.toggle("hidden", page !== "mods");
  if (page === "dashboard") refreshDashboard();
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

function renderSmartCard(mod) {
  const when = new Date(mod.installedAt).toLocaleString();
  const conf = Math.round((mod.confidence || 0) * 100);
  const skipped = (mod.skipped || []).length;
  const files = (mod.files || []).length;
  const compat = compatibilityLabel(mod.compatibilityStatus || mod.compatibility);
  const requiredTotal = Number(mod.requiredTotal) || 0;
  const requiredSatisfied = Number(mod.requiredSatisfied) || 0;
  const deps = requiredTotal ? `${requiredSatisfied}/${requiredTotal} required` : "No required deps recorded";
  const health = modHealthById.get(mod.id);
  const status = health ? health.status : mod.enabled === false ? "DISABLED" : (mod.cardHealth || "UNKNOWN").toUpperCase();
  const reasons = (health && health.reasons) || [];
  const crash = health && health.crash;
  const profiles = (health && health.profiles) || [];
  const history = (mod.historyLabels || []).slice(-3).join(" · ");
  const lamp = status === "BROKEN" ? "bad" : status === "WARNING" || status === "UNKNOWN" ? "warn" : status === "DISABLED" ? "grey" : "ok";
  const statusLabel = status === "DISABLED" ? "Disabled" : status;
  return `
    <article class="mod ${mod.enabled ? "" : "disabled"}" data-smart-id="${escapeHtml(mod.id)}">
      <i class="lamp ${lamp}"></i>
      <div>
        <h3>${escapeHtml(mod.name)}</h3>
        <p>${escapeHtml(mod.type || "Mod")} · ${escapeHtml(mod.version || "UNKNOWN")} · ${files} files${skipped ? ` · ${skipped} skipped` : ""} · ${when}</p>
        <p class="muted">${escapeHtml(statusLabel)}${reasons[0] ? ` — ${escapeHtml(reasons[0])}` : ""} · Compatibility: ${escapeHtml(compat)} · ${escapeHtml(deps)}</p>
        ${reasons.slice(1, 3).map((row) => `<p class="muted">• ${escapeHtml(row)}</p>`).join("")}
        ${crash && crash.total ? `<p class="muted">Sessions: ${crash.clean} clean · ${crash.failed} failed${crash.level !== "NONE" ? ` · Crash correlation: ${crash.level}` : ""}</p>` : ""}
        ${profiles.length ? `<p class="muted">Used in: ${escapeHtml(profiles.join(", "))}</p>` : ""}
        ${history ? `<p class="muted">${escapeHtml(history)}</p>` : ""}
      </div>
      <div class="mod-actions">
        <button data-sact="details" type="button">Details</button>
        <button class="ghost" data-sact="repair" type="button">Repair</button>
        <button class="ghost" data-sact="toggle" type="button">${mod.enabled ? "Disable" : "Enable"}</button>
        <button class="ghost" data-sact="remove" type="button">Remove</button>
      </div>
    </article>
  `;
}

function currentModFilter() {
  const query = ($("mod-search") && $("mod-search").value) || "";
  const status = ($("mod-filter") && $("mod-filter").value) || "";
  return { query: query.trim().toLowerCase(), status };
}

function visibleSmartMods() {
  const { query, status } = currentModFilter();
  return smartMods.filter((mod) => {
    const health = modHealthById.get(mod.id);
    const rowStatus = health ? health.status : mod.enabled === false ? "DISABLED" : "UNKNOWN";
    if (status === "ENABLED" && mod.enabled === false) return false;
    if (status === "DISABLED" && mod.enabled !== false) return false;
    if (status && status !== "ENABLED" && status !== "DISABLED" && rowStatus !== status) return false;
    if (!query) return true;
    const hay = [mod.name, mod.canonicalModId, mod.category, ...(mod.files || []).map((f) => f.destination)].join(" ").toLowerCase();
    return hay.includes(query);
  });
}

function renderSmartMods() {
  if (!ui.smartMods) return;
  const rows = visibleSmartMods();
  if (ui.smartCount) ui.smartCount.textContent = String(smartMods.length);
  ui.smartMods.innerHTML = rows.length
    ? rows.map(renderSmartCard).join("")
    : `<p class="empty">${smartMods.length ? "No mods match that search." : "No Smart Install mods yet. Tick “Preview before installing”, then drop a plugin."}</p>`;
}

async function refreshSmart() {
  try {
    smartMods = await window.tactix.smartList();
    const health = await window.tactix.modsHealth();
    modHealthById = new Map((health || []).map((row) => [row.installId, row]));
  } catch {
    smartMods = [];
  }
  renderSmartMods();
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
                )}</strong><small>${escapeHtml(d.kind)} · ${escapeHtml(d.state)}</small></div></li>`;
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

    $("smart-cancel").onclick = () => resolve(false);
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
        resolve(true);
      };
    }
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
    } catch (error) {
      addLog({ level: "error", message: error.message });
      continue;
    }

    const go = await confirmSmartPreview(preview);
    if (!go) {
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
          const again = await confirmSmartPreview(preview);
          if (!again) {
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
    showOverlay(`<h2>Dependency details</h2><p>${escapeHtml(name)} is not installed. V4C will not download it. Install it yourself through Smart Install if you have the pack.</p><div class="dialog-actions"><button id="dep-close" class="ghost" type="button">Close</button></div>`, true);
    $("dep-close").onclick = () => showSessionDetail(session);
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
  const mod = state.mods.find((item) => item.id === id);
  try {
    setBusy(true);
    if (button.dataset.act === "remove") {
      renderState(await window.tactix.uninstall(id));
    } else if (mod) {
      renderState(await window.tactix.setEnabled(id, !mod.enabled));
    }
  } catch (error) {
    addLog({ level: "error", message: error.message });
  } finally {
    setBusy(false);
  }
});

if (ui.smartMods) {
  ui.smartMods.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-sact]");
    const card = event.target.closest("[data-smart-id]");
    if (!button || !card) return;
    const id = card.dataset.smartId;
    const mod = smartMods.find((item) => item.id === id);
    try {
      setBusy(true);
      if (button.dataset.sact === "details") {
        await showModDetails(id);
      } else if (button.dataset.sact === "repair") {
        const result = await window.tactix.smartRepair(id);
        renderState(result.state);
      } else if (button.dataset.sact === "remove") {
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
      } else if (mod && button.dataset.sact === "toggle") {
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
    } catch (error) {
      addLog({ level: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  });
}

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
    <ul>${(health.reasons || []).map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>
    <p>Installed: ${escapeHtml((details.mod && details.mod.version) || "UNKNOWN")}<br />Known-good: ${escapeHtml(knowledge.knownGoodVersion || "none")}${knowledge.hasUserOverride ? "<br /><em>Some fields are your local notes, not verified global truth.</em>" : ""}</p>
    <h3>Version history</h3>
    <ul>${history.map((row) => `<li>${escapeHtml(row.version)}${row.current ? " — current" : ""}${row.knownGood ? " — known good" : ""}${row.hasPayload ? "" : " (no payload)"}</li>`).join("") || "<li>No stored versions.</li>"}</ul>
    <h3>Dependencies</h3>
    <p>${tree || "None recorded."}</p>
    ${dependents.length ? `<p>${escapeHtml((details.mod && details.mod.name) || "This mod")} is required by:<br />${dependents.map((row) => `• ${escapeHtml(row.name)}`).join("<br />")}</p>` : ""}
    <h3>Managed configs</h3>
    <ul>${configs.map((row) => `<li><code>${escapeHtml(row.destination)}</code> ${row.modifiedFromDefault ? "modified from default" : "matches default"} · last changed ${escapeHtml(formatWhen(row.lastChanged))}<br />
      <button data-cdiff="${escapeHtml(row.destination)}" class="ghost" type="button">View differences</button>
      <button data-cdef="${escapeHtml(row.destination)}" class="ghost" type="button">Restore default</button></li>`).join("") || "<li>None.</li>"}</ul>
    <div class="row-actions">
      <button id="md-edit" type="button">Edit local metadata</button>
      <button id="md-kg" class="ghost" type="button">Mark current version as Known Good</button>
      <button id="md-restore" class="ghost" type="button" ${plan.available ? "" : "disabled"}>Restore Known-Good Version</button>
    </div>
    ${developerMode() ? `<h3>Developer</h3><p class="muted">installId ${escapeHtml(installId)}<br />canonical ${escapeHtml((details.mod && details.mod.canonicalModId) || "none")}<br />manifest ${escapeHtml((details.manifest && details.manifest.id) || "")}</p>` : ""}
    <div class="dialog-actions"><button id="md-close" class="ghost" type="button">Close</button></div>
  `, true);
  $("md-close").onclick = hideOverlay;
  $("md-edit").onclick = () => showKnowledgeEditor(details);
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
    <p><label>Session retention <input id="set-sess" type="number" min="5" max="200" value="${Number(cfg.sessionRetention) || 40}" /></label></p>
    <p><label>Automatic snapshot retention <input id="set-auto" type="number" min="5" max="40" value="${Number(cfg.autoSnapshotRetention) || 15}" /></label></p>
    <p><label><input id="set-last" type="checkbox" ${cfg.openLastPage ? "checked" : ""} /> Open last active page</label></p>
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
    await window.tactix.settingsSave({
      defaultProfileId: $("set-profile").value,
      snapshotBeforeUpdate: $("set-snap-update").checked,
      snapshotBeforeRiskyInstall: $("set-snap-risk").checked,
      smartPreviewDefault: $("set-preview").checked,
      sessionRetention: Number($("set-sess").value),
      autoSnapshotRetention: Number($("set-auto").value),
      openLastPage: $("set-last").checked,
      developerMode: $("set-dev").checked,
      theme: prefTheme,
    });
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

if ($("theme-dark")) $("theme-dark").onclick = () => applyTheme("dark", true);
if ($("theme-bright")) $("theme-bright").onclick = () => applyTheme("bright", true);
if ($("btn-troubleshoot")) $("btn-troubleshoot").onclick = () => showTroubleshoot().catch((error) => addLog({ level: "error", message: userError(error) }));
if ($("btn-dash-tests")) $("btn-dash-tests").onclick = () => $("btn-tests").click();
if ($("mod-search")) $("mod-search").oninput = () => renderSmartMods();
if ($("mod-filter")) $("mod-filter").onchange = () => renderSmartMods();

window.tactix.onLog(addLog);
window.tactix.onProgress(updateProgress);

refresh().then(async () => {
  addLog({ level: "info", message: "GTA 5 Mod Manager ready. GTA V Enhanced only." });
  refreshSmart();
  refreshDashboard();
  if (state && state.config && state.config.openLastPage && state.config.lastPage === "mods") showPage("mods");
  else showPage("dashboard");
  if (!state?.config.officialPath || !state?.game.sandboxReady) {
    const found = await window.tactix.detectGame();
    setupForm(found.found ? found : {});
  }
});
