const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { isEnhancedFolder, isLegacyFolder, exists, ENHANCED_EXE, defaultSandboxPath } = require("./paths");

const STEAM_ENHANCED_DIR = "Grand Theft Auto V Enhanced";
const STEAM_APP_ID = "3240220";

function queryReg(key, valueName) {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", key, "/v", valueName],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const match = String(stdout).match(/REG_\w+\s+(.+)/);
        resolve(match ? match[1].trim() : null);
      }
    );
  });
}

function parseSteamLibraries(vdfText) {
  const libraries = [];
  const pathMatches = [...vdfText.matchAll(/"path"\s+"([^"]+)"/gi)];
  for (const match of pathMatches) {
    libraries.push(match[1].replace(/\\\\/g, "\\"));
  }
  if (libraries.length === 0) {
    const legacy = [...vdfText.matchAll(/"\d+"\s+"([^"]+)"/g)];
    for (const match of legacy) {
      if (/^[A-Za-z]:/.test(match[1])) libraries.push(match[1].replace(/\\\\/g, "\\"));
    }
  }
  return [...new Set(libraries)];
}

async function findSteamEnhanced() {
  const steamPath =
    (await queryReg("HKCU\\Software\\Valve\\Steam", "SteamPath")) ||
    (await queryReg("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"));
  if (!steamPath) return null;

  const libraries = [steamPath.replace(/\//g, "\\")];
  const vdf = path.join(libraries[0], "steamapps", "libraryfolders.vdf");
  if (exists(vdf)) {
    try {
      libraries.push(...parseSteamLibraries(fs.readFileSync(vdf, "utf8")));
    } catch {
      /* ignore parse errors */
    }
  }

  for (const library of libraries) {
    const candidate = path.join(library, "steamapps", "common", STEAM_ENHANCED_DIR);
    if (isEnhancedFolder(candidate)) {
      return { path: candidate, launcher: "steam" };
    }
    const manifest = path.join(library, "steamapps", `appmanifest_${STEAM_APP_ID}.acf`);
    if (exists(manifest)) {
      const text = fs.readFileSync(manifest, "utf8");
      const dirMatch = text.match(/"installdir"\s+"([^"]+)"/);
      if (dirMatch) {
        const installed = path.join(library, "steamapps", "common", dirMatch[1]);
        if (isEnhancedFolder(installed)) {
          return { path: installed, launcher: "steam" };
        }
      }
    }
  }
  return null;
}

async function findRockstarEnhanced() {
  const keys = [
    "HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTAV Enhanced",
    "HKCU\\SOFTWARE\\Rockstar Games\\GTAV Enhanced",
    "HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V Enhanced",
  ];
  for (const key of keys) {
    const folder =
      (await queryReg(key, "InstallFolder")) ||
      (await queryReg(key, "Install Path")) ||
      (await queryReg(key, "InstallFolderSteam"));
    if (folder && isEnhancedFolder(folder)) {
      return { path: folder, launcher: "rockstar" };
    }
  }
  return null;
}

function findEpicEnhanced() {
  const dat = path.join(
    process.env.ProgramData || "C:\\ProgramData",
    "Epic",
    "UnrealEngineLauncher",
    "LauncherInstalled.dat"
  );
  if (!exists(dat)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(dat, "utf8"));
    const list = data.InstallationList || [];
    for (const item of list) {
      const location = item.InstallLocation || "";
      const name = `${item.AppName || ""} ${item.ArtifactId || ""} ${location}`.toLowerCase();
      if (
        isEnhancedFolder(location) &&
        (name.includes("enhanced") || name.includes("gtavenhanced") || name.includes("3240220"))
      ) {
        return { path: location, launcher: "epic" };
      }
    }
    for (const item of list) {
      if (isEnhancedFolder(item.InstallLocation)) {
        return { path: item.InstallLocation, launcher: "epic" };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function findCommonFolders() {
  const drives = "CDEFGH".split("").map((letter) => `${letter}:\\`);
  const suffixes = [
    path.join("Program Files", "Rockstar Games", "Grand Theft Auto V Enhanced"),
    path.join("Program Files", "Epic Games", "GTAVEnhanced"),
    path.join("Program Files (x86)", "Steam", "steamapps", "common", STEAM_ENHANCED_DIR),
    path.join("SteamLibrary", "steamapps", "common", STEAM_ENHANCED_DIR),
    path.join("Games", "Grand Theft Auto V Enhanced"),
  ];
  for (const drive of drives) {
    for (const suffix of suffixes) {
      const candidate = path.join(drive, suffix);
      if (isEnhancedFolder(candidate)) {
        const launcher = candidate.toLowerCase().includes("steam")
          ? "steam"
          : candidate.toLowerCase().includes("epic")
            ? "epic"
            : "rockstar";
        return { path: candidate, launcher };
      }
    }
  }
  return null;
}

function inferLauncher(folder) {
  const lower = folder.toLowerCase();
  if (lower.includes("steamapps") || lower.includes("\\steam\\")) return "steam";
  if (lower.includes("epic games") || exists(path.join(folder, ".egstore"))) return "epic";
  if (lower.includes("rockstar")) return "rockstar";
  return "unknown";
}

async function detect() {
  return (
    (await findSteamEnhanced()) ||
    (await findRockstarEnhanced()) ||
    findEpicEnhanced() ||
    findCommonFolders()
  );
}

function inspect(folder) {
  if (!folder || !exists(folder)) {
    return { ok: false, reason: "Folder does not exist." };
  }
  if (isLegacyFolder(folder)) {
    return {
      ok: false,
      reason: "That is GTA V Legacy. This manager only supports GTA V Enhanced (GTA5_Enhanced.exe).",
    };
  }
  if (!isEnhancedFolder(folder)) {
    return {
      ok: false,
      reason: `Could not find ${ENHANCED_EXE} in that folder.`,
    };
  }
  return {
    ok: true,
    path: folder,
    launcher: inferLauncher(folder),
    hasPlayExe: exists(path.join(folder, "PlayGTAV.exe")),
    suggestedSandbox: defaultSandboxPath(folder),
  };
}

module.exports = {
  detect,
  inspect,
  inferLauncher,
  STEAM_APP_ID,
};
