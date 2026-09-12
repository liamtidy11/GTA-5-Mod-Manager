const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { shell } = require("electron");
const { exists, isEnhancedFolder, RPH_EXE, PLAY_EXE, ENHANCED_EXE } = require("./paths");
const battleye = require("./battleye");
const permissions = require("./permissions");
const overlays = require("./overlays");
const { repairLspdfrLayout } = require("./installer");

const DUTY_PROCESSES = [
  "RAGEPluginHook.exe",
  "GTA5_Enhanced.exe",
  "GTA5_Enhanced_BE.exe",
  "PlayGTAV.exe",
  "GTA5.exe",
];

const HOOK_BLOCKERS = ["RazerCortex.exe"];

const STEAM_ENHANCED = "steam://run/3240220";
const EPIC_ENHANCED =
  "com.epicgames.launcher://apps/8769e24080ea413b8ebca3f1b8c50951?action=launch&silent=true";

function findRage(sandboxPath) {
  const names = [RPH_EXE, "RAGEPluginHook.exe", "ragepluginhook.exe"];
  for (const name of names) {
    const full = path.join(sandboxPath, name);
    if (exists(full)) return full;
  }
  try {
    const match = fs.readdirSync(sandboxPath).find((name) => /^ragepluginhook\.exe$/i.test(name));
    if (match) return path.join(sandboxPath, match);
  } catch {
    /* ignore */
  }
  return null;
}

function patchRageIni(sandboxPath) {
  const file = path.join(sandboxPath, "RagePluginHook.ini");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }

  const set = (section, key, value) => {
    const sectionRe = new RegExp(`\\[${section}\\]`, "i");
    const keyRe = new RegExp(`^${key}=.*$`, "im");
    if (keyRe.test(text)) {
      text = text.replace(keyRe, `${key}=${value}`);
      return;
    }
    if (sectionRe.test(text)) {
      text = text.replace(sectionRe, `[${section}]\r\n${key}=${value}`);
      return;
    }
    text = `${text.trim()}\r\n[${section}]\r\n${key}=${value}\r\n`;
  };

  set("Miscellaneous", "PluginTimeoutThreshold", "60000");
  set("Miscellaneous", "ConsoleKey", "F4");
  set("Variables", "CommandLineArguments", "");
  set("Variables", "AdditionalCommandlineArguments", "");
  try {
    fs.writeFileSync(file, text.trim() + "\r\n", "utf8");
  } catch {
    /* ignore */
  }
}

function ensureSteamAppId(folder) {
  try {
    fs.writeFileSync(path.join(folder, "steam_appid.txt"), "3240220\n", "utf8");
  } catch {
    /* ignore */
  }
}

function ensureSkipDirectStorageCheck(folder) {
  const marker = path.join(folder, "skipdscheck");
  if (exists(marker)) return;
  try {
    fs.writeFileSync(marker, "Allows Rage Plugin Hook to start if DirectStorageFix is not installed yet.\n", "utf8");
  } catch {
    /* ignore */
  }
}

function closeDutyProcesses() {
  const closed = [];
  for (const image of [...DUTY_PROCESSES, ...HOOK_BLOCKERS]) {
    try {
      execFileSync("taskkill", ["/IM", image, "/F"], { windowsHide: true, stdio: "ignore" });
      closed.push(image);
    } catch {
      /* not running */
    }
  }
  return closed;
}

function hardlinkCount(file) {
  try {
    const out = execFileSync("fsutil", ["hardlink", "list", file], {
      windowsHide: true,
      encoding: "utf8",
    });
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return 1;
  }
}

function materializeSandboxLaunchers(sandboxPath, officialPath) {
  const names = [ENHANCED_EXE, PLAY_EXE, "dstorage.dll", "steam_api64.dll"];
  for (const name of names) {
    const dest = path.join(sandboxPath, name);
    const src = path.join(officialPath || "", name);
    if (!exists(dest) || !exists(src) || hardlinkCount(dest) < 2) continue;
    const tmp = `${dest}.tactix-copy`;
    try {
      fs.copyFileSync(src, tmp);
      fs.unlinkSync(dest);
      fs.renameSync(tmp, dest);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function startDetached(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: false,
    });
    child.once("error", (error) => {
      reject(new Error(`Could not start ${path.basename(command)}: ${error.message}`));
    });
    child.once("spawn", () => {
      const pid = child.pid;
      child.unref();
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          resolve({ pid, alive: true });
        } catch {
          resolve({ pid, alive: false });
        }
      }, 1500);
    });
  });
}

async function launchOnline({ officialPath, sandboxPath, launcher }) {
  if (!isEnhancedFolder(officialPath)) {
    throw new Error("Official Enhanced folder is not set or is invalid.");
  }

  battleye.setOn({ officialPath, sandboxPath });

  if (launcher === "steam") {
    await shell.openExternal(STEAM_ENHANCED);
    return { mode: "online", via: "steam" };
  }

  if (launcher === "epic") {
    await shell.openExternal(EPIC_ENHANCED);
    return { mode: "online", via: "epic" };
  }

  const play = path.join(officialPath, PLAY_EXE);
  const exe = path.join(officialPath, ENHANCED_EXE);
  if (exists(play)) {
    await startDetached(play, [], officialPath);
    return { mode: "online", via: "playgtav" };
  }
  await startDetached(exe, [], officialPath);
  return { mode: "online", via: "enhanced-exe" };
}

async function launchLspdfr({ sandboxPath, officialPath }) {
  if (!isEnhancedFolder(sandboxPath)) {
    throw new Error("Create the LSPDFR folder first.");
  }
  const rph = findRage(sandboxPath);
  if (!rph) {
    throw new Error(
      "RagePluginHook.exe is not in the LSPDFR folder yet. Drop the LSPDFR setup into GTA 5 Mod Manager first."
    );
  }

  ensureSteamAppId(sandboxPath);
  battleye.setOff({ sandboxPath, officialPath });
  repairLspdfrLayout(sandboxPath);
  patchRageIni(sandboxPath);
  ensureSkipDirectStorageCheck(sandboxPath);
  materializeSandboxLaunchers(sandboxPath, officialPath);
  closeDutyProcesses();
  overlays.suppressOverlaysDuringHook();

  const elevated = await permissions.launchRage({ sandboxPath, officialPath });
  if (elevated.ok) {
    return { mode: "lspdfr", via: elevated.via, pid: null };
  }

  const result = await startDetached(rph, [], sandboxPath);
  if (!result.alive) {
    throw new Error(
      elevated.canceled
        ? "Windows asked for permission and it was declined. Click Yes, then try Play LSPDFR again."
        : "Rage Plugin Hook did not stay open. Close leftover GTA windows, click Yes if Windows asks, and try Play LSPDFR again."
    );
  }
  return { mode: "lspdfr", via: "rage-plugin-hook", pid: result.pid };
}

function openFolder(folder) {
  if (!folder || !exists(folder)) {
    throw new Error("That folder does not exist yet.");
  }
  return shell.openPath(folder);
}

module.exports = { launchOnline, launchLspdfr, openFolder };
