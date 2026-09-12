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
};

let state = null;
let busy = false;
let smartMods = [];

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

function renderSmartCard(mod) {
  const when = new Date(mod.installedAt).toLocaleString();
  const conf = Math.round((mod.confidence || 0) * 100);
  const skipped = (mod.skipped || []).length;
  const files = (mod.files || []).length;
  return `
    <article class="mod ${mod.enabled ? "" : "disabled"}" data-smart-id="${escapeHtml(mod.id)}">
      <i class="lamp ${mod.enabled ? "ok" : "warn"}"></i>
      <div>
        <h3>${escapeHtml(mod.name)}</h3>
        <p>${escapeHtml(mod.type || "Mod")} · ${conf}% · ${files} files${skipped ? ` · ${skipped} skipped` : ""} · ${when}</p>
      </div>
      <div class="mod-actions">
        <button class="ghost" data-sact="toggle" type="button">${mod.enabled ? "Disable" : "Enable"}</button>
        <button class="ghost" data-sact="remove" type="button">Remove</button>
      </div>
    </article>
  `;
}

function renderSmartMods() {
  if (!ui.smartMods) return;
  if (ui.smartCount) ui.smartCount.textContent = String(smartMods.length);
  ui.smartMods.innerHTML = smartMods.length
    ? smartMods.map(renderSmartCard).join("")
    : `<p class="empty">No Smart Install mods yet. Tick “Preview before installing”, then drop a plugin.</p>`;
}

async function refreshSmart() {
  try {
    smartMods = await window.tactix.smartList();
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
function confirmSmartPreview(preview) {
  return new Promise((resolve) => {
    const files = preview.files || [];
    const adds = files.filter((f) => f.action === "add");
    const reps = files.filter((f) => f.action === "replace");
    const skips = files.filter((f) => f.action === "skip");
    const sev = (preview.conflicts && preview.conflicts.severity) || "NONE";
    const meta = severityMeta(sev);
    const blocked = sev === "BLOCKED";
    const conf = Math.round((preview.confidence || 0) * 100);
    const execs = preview.executables || [];
    const conflictItems = ((preview.conflicts && preview.conflicts.items) || []).filter(
      (i) => i.level !== "NONE" && i.level !== "SAFE_REPLACEMENT"
    );

    showOverlay(
      `
      <h2>Smart Install — ${escapeHtml(preview.name)}</h2>
      <p>
        Detected <strong>${escapeHtml(preview.type)}</strong> ·
        ${conf}% confidence · <span class="sev ${meta.cls}">${meta.text}</span><br />
        <span class="muted">${escapeHtml(preview.modeLabel || "")}</span>
      </p>
      <div class="badges">
        <span class="badge">${adds.length} new</span>
        <span class="badge">${reps.length} replace</span>
        <span class="badge">${skips.length} skipped</span>
      </div>
      <p class="muted">Everything installs into the LSPDFR folder only. Protected launch files are never overwritten.</p>
      ${
        conflictItems.length
          ? `<h3>Attention</h3><ul class="check-list">${conflictItems
              .map(
                (i) =>
                  `<li><i class="lamp ${
                    i.level === "BLOCKED" || i.level === "HIGH_RISK" ? "bad" : "warn"
                  }"></i><div><small>${escapeHtml(i.message)}</small></div></li>`
              )
              .join("")}</ul>`
          : ""
      }
      ${
        execs.length
          ? `<h3>Executables — never run automatically</h3><ul class="warnings">${execs
              .map((e) => `<li>${escapeHtml(e)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <h3>New files (${adds.length})</h3>
      ${planList(adds)}
      ${reps.length ? `<h3>Replaces (${reps.length}) — originals backed up</h3>${planList(reps)}` : ""}
      ${skips.length ? `<h3>Skipped to protect the launch (${skips.length})</h3>${planList(skips)}` : ""}
      <div class="dialog-actions">
        <button id="smart-install" class="primary" type="button" ${blocked ? "disabled" : ""}>${
          blocked ? "Blocked" : "Install"
        }</button>
        <button id="smart-cancel" class="ghost" type="button">Cancel</button>
      </div>
    `,
      true
    );

    $("smart-cancel").onclick = () => resolve(false);
    const install = $("smart-install");
    if (install && !blocked) install.onclick = () => resolve(true);
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

$("btn-open-official").onclick = () => window.tactix.openFolder("official").catch((error) => addLog({ level: "error", message: error.message }));
$("btn-open-sandbox").onclick = () => window.tactix.openFolder("sandbox").catch((error) => addLog({ level: "error", message: error.message }));

$("btn-lspdfr").onclick = async () => {
  try {
    await window.tactix.launchLspdfr();
  } catch (error) {
    addLog({ level: "error", message: error.message });
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
      if (button.dataset.sact === "remove") {
        const result = await window.tactix.smartUninstall(id);
        renderState(result.state);
      } else if (mod) {
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

window.tactix.onLog(addLog);
window.tactix.onProgress(updateProgress);

refresh().then(async () => {
  addLog({ level: "info", message: "GTA 5 Mod Manager ready. GTA V Enhanced only." });
  refreshSmart();
  if (!state?.config.officialPath || !state?.game.sandboxReady) {
    const found = await window.tactix.detectGame();
    setupForm(found.found ? found : {});
  }
});
