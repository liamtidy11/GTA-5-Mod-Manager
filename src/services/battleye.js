const fs = require("fs");
const path = require("path");
const { exists } = require("./paths");

const FLAG = "-nobattleye";
const STEAM_APP = "3240220";
const BE_WRAPPER = "GTA5_Enhanced_BE.exe";
const BE_PARKED = "GTA5_Enhanced_BE.exe.tactix-off";

function commandLinePath(folder) {
  return path.join(folder || "", "commandline.txt");
}

function argsPath(folder) {
  return path.join(folder || "", "args.txt");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeText(file, text) {
  try {
    fs.writeFileSync(file, text, "utf8");
    return true;
  } catch {
    return false;
  }
}

function hasFlag(text) {
  return new RegExp(`(?:^|\\s)${FLAG}\\b`, "i").test(text || "");
}

function addFlag(text) {
  if (hasFlag(text)) return String(text || "").trim() ? `${String(text).trim()}\n` : `${FLAG}\n`;
  return `${String(text || "").trim()}\n${FLAG}\n`.trimStart();
}

function stripFlag(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !new RegExp(`^${FLAG}$`, "i").test(line.trim()))
    .join("\n")
    .trim();
}

function setFolderFlag(folder, off) {
  if (!folder || !exists(folder)) return false;
  const files = [commandLinePath(folder), argsPath(folder)];
  let ok = true;
  for (const file of files) {
    const next = off ? addFlag(readText(file)) : stripFlag(readText(file));
    if (next) {
      if (!writeText(file, `${next}\n`)) ok = false;
    } else if (exists(file)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        ok = false;
      }
    }
  }
  return ok;
}

function parkWrapper(sandboxPath, off) {
  if (!sandboxPath) return false;
  const live = path.join(sandboxPath, BE_WRAPPER);
  const parked = path.join(sandboxPath, BE_PARKED);
  try {
    if (off && exists(live) && !exists(parked)) {
      fs.renameSync(live, parked);
      return true;
    }
    if (!off && exists(parked) && !exists(live)) {
      fs.renameSync(parked, live);
      return true;
    }
    return exists(off ? parked : live) || (!off && !exists(parked));
  } catch {
    return false;
  }
}

function findSteamUserConfigs() {
  const configs = [];
  const steamPath =
    queryRegSync("HKCU\\Software\\Valve\\Steam", "SteamPath") ||
    queryRegSync("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  if (!steamPath) return configs;
  const userdata = path.join(String(steamPath).replace(/\//g, "\\"), "userdata");
  if (!exists(userdata)) return configs;
  try {
    for (const id of fs.readdirSync(userdata)) {
      const file = path.join(userdata, id, "config", "localconfig.vdf");
      if (exists(file)) configs.push(file);
    }
  } catch {
    /* ignore */
  }
  return configs;
}

function queryRegSync(key, valueName) {
  try {
    const { execFileSync } = require("child_process");
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

function setSteamLaunchOptions(off) {
  const needle = `"${STEAM_APP}"`;
  let changed = 0;
  for (const file of findSteamUserConfigs()) {
    let text = readText(file);
    if (!text.includes(needle)) continue;
    const blockRe = new RegExp(`("${STEAM_APP}"\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})`);
    const match = text.match(blockRe);
    if (!match) continue;
    let body = match[2];
    if (off) {
      if (/"LaunchOptions"\s+"[^"]*"/i.test(body)) {
        body = body.replace(/"LaunchOptions"\s+"[^"]*"/i, `"LaunchOptions"\t\t"${FLAG}"`);
      } else {
        body += `\n\t\t\t\t\t\t"LaunchOptions"\t\t"${FLAG}"`;
      }
    } else {
      body = body.replace(/\n?\s*"LaunchOptions"\s+"[^"]*"/i, "");
    }
    const next = text.replace(blockRe, `${match[1]}${body}${match[3]}`);
    if (next !== text && writeText(file, next)) changed += 1;
  }
  return changed > 0;
}

function setOff({ sandboxPath, officialPath }) {
  const steps = {
    sandboxCommand: setFolderFlag(sandboxPath, true),
    officialCommand: setFolderFlag(officialPath, true),
    steamLaunch: setSteamLaunchOptions(true),
    parkedWrapper: parkWrapper(sandboxPath, true),
  };
  return { off: true, steps, ok: steps.sandboxCommand };
}

function setOn({ sandboxPath, officialPath }) {
  const steps = {
    officialCommand: setFolderFlag(officialPath, false),
    steamLaunch: setSteamLaunchOptions(false),
    sandboxKeptOff: setFolderFlag(sandboxPath, true),
    wrapperRestoredOnOfficialOnly: true,
  };
  return { off: false, steps, ok: true };
}

function status({ sandboxPath, officialPath }) {
  const sandbox = hasFlag(readText(commandLinePath(sandboxPath)));
  const official = hasFlag(readText(commandLinePath(officialPath)));
  return { sandboxOff: sandbox, officialOff: official };
}

module.exports = {
  FLAG,
  setOff,
  setOn,
  status,
};
