const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const sevenBin = require("7zip-bin");
const registry = require("./registry");
const dlclist = require("./dlclist");
const { buildPlanFiles, readAssemblyCopies, isJunk, slugPack, RPH_ROOT_DLLS } = require("./modtypes");
const { exists, safeJoin, tactixDir, isEnhancedFolder } = require("./paths");
const environmentInventory = require("./environmentInventory");
const { applyGenericInstallerArchiveGuard } = require("./vehicle/vehiclePackageAnalyzer");

const execFileAsync = promisify(execFile);

const SKIP_NAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

const GAME_ROOT_HINTS = new Set([
  "plugins",
  "lspdfr",
  "update",
  "x64",
  "dlcpacks",
  "els",
  "scripts",
  "menyoo.asi",
  "dinput8.dll",
  "scripthookv.dll",
  "ragepluginhook.exe",
  "ragepluginhook.ini",
]);

const GAME_FOLDER_NAMES = new Set([
  "grand theft auto v",
  "grand theft auto v enhanced",
  "gta v",
  "gta5",
  "gtav",
  "gtav enhanced",
]);

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "mod";
}

function uniqueId(archiveName) {
  return `${slug(archiveName)}-${Date.now().toString(36)}`;
}

function sevenZipBin(archivePath) {
  const full = path.join(__dirname, "..", "..", "tools", "7z", "7z.exe");
  if (/\.exe$/i.test(archivePath) && exists(full)) return full;
  return exists(full) ? full : sevenBin.path7za;
}

async function extractArchive(archivePath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const args = ["x", archivePath, `-o${destDir}`, "-y", "-aoa"];
  if (/\.exe$/i.test(archivePath)) args.push("-x!$PLUGINSDIR\\*");
  const tryBin = async (bin) => {
    await execFileAsync(bin, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16,
    });
  };
  try {
    await tryBin(sevenZipBin(archivePath));
  } catch (error) {
    const fallback = path.join(__dirname, "..", "..", "tools", "7z", "7z.exe");
    if (exists(fallback) && sevenZipBin(archivePath) !== fallback) {
      await tryBin(fallback);
      return;
    }
    throw error;
  }
}

function shouldSkip(rel) {
  const parts = rel.split(/[/\\]/).map((part) => part.toLowerCase());
  if (parts.some((part) => part === "__macosx" || part === "$pluginsdir" || part.startsWith("."))) return true;
  if (/uinst|uninstall/i.test(parts[parts.length - 1])) return true;
  const base = parts[parts.length - 1];
  return SKIP_NAMES.has(base);
}

async function listFiles(root) {
  const files = [];
  async function visit(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && !shouldSkip(rel)) {
        files.push(rel);
      }
    }
  }
  await visit(root);
  return files;
}

function namesIn(dir) {
  try {
    return fs.readdirSync(dir).map((name) => name.toLowerCase());
  } catch {
    return [];
  }
}

function looksLikeGameRoot(dir) {
  const names = new Set(namesIn(dir));
  let hits = 0;
  for (const hint of GAME_ROOT_HINTS) {
    if (names.has(hint)) hits += 1;
  }
  return hits >= 1;
}

function findPayloadRoot(extractRoot) {
  if (looksLikeGameRoot(extractRoot)) return extractRoot;

  const entries = fs.readdirSync(extractRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && GAME_FOLDER_NAMES.has(entry.name.toLowerCase())) {
      return path.join(extractRoot, entry.name);
    }
  }

  const dirs = entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== "__macosx");
  if (dirs.length === 1 && looksLikeGameRoot(path.join(extractRoot, dirs[0].name))) {
    return path.join(extractRoot, dirs[0].name);
  }

  for (const entry of dirs) {
    const child = path.join(extractRoot, entry.name);
    if (looksLikeGameRoot(child)) return child;
  }

  return extractRoot;
}

async function unwrapNested(extractDir, payloadRoot) {
  const files = await listFiles(payloadRoot);
  const archives = files.filter((file) => /\.(zip|oiv|rar|7z)$/i.test(file));
  const others = files.filter((file) => !/\.(zip|oiv|rar|7z)$/i.test(file) && !isJunk(file));
  if (!archives.length || archives.length > 8 || others.length > 12) return payloadRoot;

  const nestedRoot = path.join(extractDir, "_nested");
  await fs.promises.mkdir(nestedRoot, { recursive: true });
  for (const archive of archives) {
    const dest = path.join(nestedRoot, slugPack(path.basename(archive)));
    try {
      await extractArchive(path.join(payloadRoot, archive), dest);
    } catch {
      /* keep going; the outer files may still install */
    }
  }
  const nestedPayload = findPayloadRoot(nestedRoot);
  const nestedFiles = await listFiles(nestedPayload);
  return nestedFiles.length > 0 ? nestedPayload : payloadRoot;
}

function finishPlan({ id, archiveName, extractDir, payloadRoot, files }) {
  if (files.length === 0) {
    throw new Error("That folder or archive was empty.");
  }

  if (files.some((file) => /^gta5_enhanced\.exe$/i.test(path.basename(file)))) {
    throw new Error("That looks like a full GTA V Enhanced folder. Drop the downloaded LSPDFR pack, not your game install.");
  }

  const mapped = buildPlanFiles({
    files,
    archiveName,
    payloadRoot,
    assemblyCopies: readAssemblyCopies(payloadRoot),
  });

  if (!mapped.copies.length) {
    throw new Error("No installable LSPDFR or GTA files were found in that folder.");
  }

  const guarded = applyGenericInstallerArchiveGuard(mapped.copies);
  if (guarded.archiveRequired && !guarded.copies.length) {
    throw new Error(guarded.reason);
  }

  return {
    id,
    archiveName,
    extractDir,
    payloadRoot: mapped.payloadRoot,
    files: guarded.copies.map((copy) => copy.to),
    copies: guarded.copies,
    fileCount: guarded.copies.length,
    folders: mapped.destinations,
    kinds: mapped.kinds,
    kindLabels: mapped.kindLabels,
    notes: mapped.notes,
    dlcPacks: mapped.dlcPacks,
    warnings: mapped.warnings,
    fromFolder: !extractDir,
  };
}

async function analyzeFolder(folderPath, stagingRoot) {
  const archiveName = path.basename(folderPath);
  const id = uniqueId(archiveName);
  let payloadRoot = findPayloadRoot(folderPath);
  const extractDir = path.join(stagingRoot, id);
  payloadRoot = await unwrapNested(extractDir, payloadRoot);
  const usedStaging = path
    .resolve(payloadRoot)
    .toLowerCase()
    .startsWith(path.resolve(extractDir).toLowerCase());
  const files = await listFiles(payloadRoot);
  return finishPlan({
    id,
    archiveName,
    extractDir: usedStaging ? extractDir : null,
    payloadRoot,
    files,
  });
}

async function analyze(sourcePath, stagingRoot) {
  if (!exists(sourcePath)) {
    throw new Error("That file or folder no longer exists.");
  }

  const stat = await fs.promises.stat(sourcePath);
  if (stat.isDirectory()) {
    return analyzeFolder(sourcePath, stagingRoot);
  }

  if (!/\.(zip|rar|7z|oiv|exe)$/i.test(sourcePath)) {
    throw new Error("Drop the LSPDFR folder or file (zip, rar, 7z, oiv, or the downloaded pack).");
  }

  const id = uniqueId(path.basename(sourcePath));
  const extractDir = path.join(stagingRoot, id);
  if (exists(extractDir)) {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
  }

  try {
    await extractArchive(sourcePath, extractDir);
  } catch (error) {
    throw new Error(
      /\.exe$/i.test(sourcePath)
        ? "Could not unpack that installer. If it is not the official LSPDFR setup, extract it first and drop the folder."
        : error.message || "Could not unpack that file."
    );
  }
  let payloadRoot = findPayloadRoot(extractDir);
  payloadRoot = await unwrapNested(extractDir, payloadRoot);
  return finishPlan({
    id,
    archiveName: path.basename(sourcePath),
    extractDir,
    payloadRoot,
    files: await listFiles(payloadRoot),
  });
}

const SKIP_ROOT_MIRROR = new Set([
  "xinput1_4.dll",
  "newtonsoft.json.dll",
  "lspd first response.dll",
]);

function writeIfMissing(file, contents) {
  if (exists(file)) return;
  fs.writeFileSync(file, contents, "utf8");
}

function repairLspdfrLayout(sandboxPath) {
  const plugins = path.join(sandboxPath, "plugins");
  const pluginDeps = path.join(plugins, "LSPDFR");
  fs.mkdirSync(plugins, { recursive: true });
  fs.mkdirSync(pluginDeps, { recursive: true });

  writeIfMissing(
    path.join(plugins, "LSPD First Response.dll.config"),
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1">
      <probing privatePath="LSPDFR"/>
    </assemblyBinding>
  </runtime>
</configuration>
`
  );

  writeIfMissing(
    path.join(sandboxPath, "RAGEPluginHook.exe.config"),
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1">
      <probing privatePath="Plugins;Plugins\\LSPDFR;lspdfr"/>
    </assemblyBinding>
  </runtime>
</configuration>
`
  );

  const strayJson = path.join(pluginDeps, "Newtonsoft.Json.dll");
  if (exists(strayJson)) {
    try {
      fs.rmSync(strayJson, { force: true });
    } catch {
      /* ignore */
    }
  }

  let names = [];
  try {
    names = fs.readdirSync(pluginDeps);
  } catch {
    names = [];
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".dll") && !lower.endsWith(".dll.config")) continue;
    if (SKIP_ROOT_MIRROR.has(lower)) continue;
    if (!RPH_ROOT_DLLS.has(lower) && !/^(ddsconvert|discord|lms\.|easyhook|gwen|slimdx|mono\.|fw1|system\.valuetuple|microsoft\.)/i.test(lower)) {
      continue;
    }
    const src = path.join(pluginDeps, name);
    const dest = path.join(sandboxPath, name);
    try {
      fs.copyFileSync(src, dest);
    } catch {
      /* file may be locked by a running game */
    }
  }
  environmentInventory.invalidate({ dutyPath: sandboxPath });
}

async function mirrorRageDepsToPlugins(sandboxPath) {
  repairLspdfrLayout(sandboxPath);
}

async function replaceWithCopy(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (exists(dest)) {
    await fs.promises.rm(dest, { force: true });
  }
  await fs.promises.copyFile(src, dest);
}

async function commit({ plan, sandboxPath, officialPath, onProgress }) {
  if (!isEnhancedFolder(sandboxPath)) {
    throw new Error("Create the LSPDFR folder before installing mods.");
  }

  const backupRoot = path.join(tactixDir(sandboxPath), "backups", plan.id);
  const installed = [];
  const copies = plan.copies || (plan.files || []).map((rel) => ({ from: rel, to: rel }));

  for (let i = 0; i < copies.length; i += 1) {
    const relFrom = copies[i].from;
    const relTo = copies[i].to;
    const src = path.join(plan.payloadRoot, relFrom);
    const dest = safeJoin(sandboxPath, relTo);

    if (/^(dinput8|xinput1_4)\.dll$/i.test(path.basename(relTo)) && exists(dest)) {
      try {
        if (fs.statSync(dest).size > fs.statSync(src).size * 2) {
          continue;
        }
      } catch {
        /* if we cannot compare, install normally */
      }
    }
    if (/^nativetrainer\.asi$/i.test(path.basename(relTo))) {
      continue;
    }
    if (/\.(yft|ytd)$/i.test(relFrom) || /\.(yft|ytd)$/i.test(relTo)) {
      continue;
    }

    if (exists(dest)) {
      const backup = path.join(backupRoot, relTo);
      await fs.promises.mkdir(path.dirname(backup), { recursive: true });
      try {
        await fs.promises.copyFile(dest, backup);
      } catch {
        /* backup is best-effort */
      }
    }

    await replaceWithCopy(src, dest);
    installed.push(relTo.replace(/\//g, "\\"));

    if (onProgress && (i % 10 === 0 || i === copies.length - 1)) {
      onProgress({ done: i + 1, total: copies.length, file: relTo, phase: "install" });
    }
  }

  if ((plan.kinds || []).some((kind) => kind === "lspdfr" || kind === "rage")) {
    await mirrorRageDepsToPlugins(sandboxPath);
  }

  const dlc = dlclist.registerPacks(sandboxPath, plan.dlcPacks || []);

  const record = {
    id: plan.id,
    name: plan.archiveName.replace(/\.(zip|rar|7z|oiv)$/i, ""),
    archiveName: plan.archiveName,
    enabled: true,
    installedAt: new Date().toISOString(),
    files: installed,
    fileCount: installed.length,
    kinds: plan.kinds || [],
    dlcPacks: plan.dlcPacks || [],
    dlcRegistered: dlc.added || [],
    officialPath,
  };

  registry.add(sandboxPath, record);

  try {
    if (plan.extractDir) {
      await fs.promises.rm(plan.extractDir, { recursive: true, force: true });
    }
  } catch {
    /* leftover staging is harmless */
  }

  environmentInventory.invalidate({ dutyPath: sandboxPath });
  return record;
}

async function restoreOfficialLink(officialPath, sandboxPath, rel) {
  const officialFile = path.join(officialPath, rel);
  const dest = safeJoin(sandboxPath, rel);
  if (!exists(officialFile)) return false;
  if (exists(dest)) await fs.promises.rm(dest, { force: true });
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.link(officialFile, dest);
  } catch {
    await fs.promises.copyFile(officialFile, dest);
  }
  return true;
}

async function uninstall(sandboxPath, officialPath, modId) {
  const data = registry.load(sandboxPath);
  const mod = data.mods.find((item) => item.id === modId);
  if (!mod) throw new Error("Mod not found.");

  const backupRoot = path.join(tactixDir(sandboxPath), "backups", modId);

  for (const rel of mod.files || []) {
    const dest = safeJoin(sandboxPath, rel);
    const others = registry.ownersOf(sandboxPath, rel).filter((item) => item.id !== modId);
    if (others.length > 0) continue;

    if (exists(dest)) {
      await fs.promises.rm(dest, { force: true });
    }

    const restored = officialPath ? await restoreOfficialLink(officialPath, sandboxPath, rel) : false;
    if (!restored) {
      const backup = path.join(backupRoot, rel);
      if (exists(backup)) {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(backup, dest);
      }
    }
  }

  try {
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (mod.dlcPacks?.length) {
    const stillUsed = new Set();
    for (const other of registry.load(sandboxPath).mods) {
      if (other.id === modId) continue;
      for (const pack of other.dlcPacks || []) stillUsed.add(String(pack).toLowerCase());
    }
    const removable = mod.dlcPacks.filter((pack) => !stillUsed.has(String(pack).toLowerCase()));
    dlclist.unregisterPacks(sandboxPath, removable);
  }

  registry.remove(sandboxPath, modId);
  environmentInventory.invalidate({ dutyPath: sandboxPath });
  return { id: modId };
}

async function setEnabled(sandboxPath, officialPath, modId, enabled) {
  const data = registry.load(sandboxPath);
  const mod = data.mods.find((item) => item.id === modId);
  if (!mod) throw new Error("Mod not found.");
  if (mod.enabled === enabled) return mod;

  const disabledRoot = path.join(tactixDir(sandboxPath), "disabled", modId);

  if (!enabled) {
    for (const rel of mod.files || []) {
      const dest = safeJoin(sandboxPath, rel);
      const others = registry
        .ownersOf(sandboxPath, rel)
        .filter((item) => item.id !== modId && item.enabled !== false);
      if (others.length > 0) continue;
      if (!exists(dest)) continue;

      const parked = path.join(disabledRoot, rel);
      await fs.promises.mkdir(path.dirname(parked), { recursive: true });
      await fs.promises.copyFile(dest, parked);
      await fs.promises.rm(dest, { force: true });
      if (officialPath) await restoreOfficialLink(officialPath, sandboxPath, rel);
    }
    if (mod.dlcPacks?.length) {
      const stillUsed = new Set();
      for (const other of registry.load(sandboxPath).mods) {
        if (other.id === modId || other.enabled === false) continue;
        for (const pack of other.dlcPacks || []) stillUsed.add(String(pack).toLowerCase());
      }
      dlclist.unregisterPacks(
        sandboxPath,
        mod.dlcPacks.filter((pack) => !stillUsed.has(String(pack).toLowerCase()))
      );
    }
  } else {
    for (const rel of mod.files || []) {
      const parked = path.join(disabledRoot, rel);
      if (!exists(parked)) continue;
      const dest = safeJoin(sandboxPath, rel);
      await replaceWithCopy(parked, dest);
    }
    try {
      await fs.promises.rm(disabledRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (mod.dlcPacks?.length) dlclist.registerPacks(sandboxPath, mod.dlcPacks);
  }

  const updated = registry.update(sandboxPath, modId, { enabled });
  environmentInventory.invalidate({ dutyPath: sandboxPath });
  return updated;
}

async function discardStaging(extractDir) {
  if (extractDir && exists(extractDir)) {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
  }
}

module.exports = { analyze, commit, uninstall, setEnabled, discardStaging, repairLspdfrLayout, extractArchive };
