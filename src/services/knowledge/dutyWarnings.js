const fs = require("fs");
const path = require("path");
const launchArgs = require("../launchArgs");
const inventoryXml = require("./inventoryXml");
const outfitCheck = require("./outfitCheck");
const dutyLogScan = require("./dutyLogScan");

const CALLOUT_FAIL_WARN = 3;
const BACKUP_SESSION_WARN = 2;

function readLogText(dutyPath) {
  if (!dutyPath) return "";
  try {
    return dutyLogScan.joinLogFiles(dutyLogScan.collectLogFiles({ dutyPath }, dutyPath));
  } catch {
    try {
      return fs.readFileSync(path.join(dutyPath, "RagePluginHook.log"), "utf8");
    } catch {
      return "";
    }
  }
}

function splitSessions(text) {
  const parts = String(text || "").split(/Started new log on/i);
  return parts.map((part) => part.trim()).filter((part) => part.length > 40);
}

function countCalloutFailures(text) {
  const counts = new Map();
  const re = /attempted to start callout\s+(.+?)\s+but nothing happened/gi;
  let match;
  while ((match = re.exec(text || ""))) {
    const name = match[1].trim();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

function backupManagerHits(text) {
  const sessions = splitSessions(text);
  const sessionHits = sessions.filter((session) => /NotImplementedException/i.test(session) && /BackupManager\.cs/i.test(session)).length;
  const lineHits = (String(text || "").match(/NotImplementedException/gi) || []).length && /BackupManager\.cs/i.test(text)
    ? (String(text || "").match(/BackupManager\.cs/gi) || []).length
    : 0;
  return { sessionHits, lineHits };
}

function weaponSkinDutyCrash(text) {
  const blob = String(text || "");
  return (
    /UNHANDLED EXCEPTION DURING GAME FIBER TICK/i.test(blob) &&
    /WeaponSkin/i.test(blob) &&
    /Forced termination/i.test(blob)
  );
}

function d3dCrashCorrelated(text) {
  const blob = String(text || "");
  const debug = /Address mismatch:|\[d3d12\]/i.test(blob);
  if (!debug) return { debug: false, crash: false };
  const crash =
    /\[d3d12\].{0,80}(?:failed|fatal|crash)/i.test(blob) ||
    (/\[d3d12\] Hooking game swap chain/i.test(blob) && !/\[d3d12\] Hooked/i.test(blob) && /(?:fatal|crash|terminated)/i.test(blob));
  return { debug: true, crash };
}

function item(id, status, title, detail) {
  return { id, status, title, detail };
}

function summarize({ dutyPath = "", logText = null, repairInventory = false } = {}) {
  const text = logText == null ? readLogText(dutyPath) : String(logText || "");
  const items = [];

  const dups = launchArgs.findDutyDuplicateFlags(dutyPath);
  if (dups.length) {
    items.push(item("nobattleye", "WARNING", `Duplicate launch argument detected: ${dups[0].flag}`, `${dups.map((row) => `${row.flag} ×${row.count}`).join(", ")}. Keep BattlEye off, but pass each flag once.`));
  } else if (/specified twice/i.test(text) && /nobattleye/i.test(text)) {
    items.push(item("nobattleye", "FIXED", "Duplicate `-nobattleye`", "The current command line has the flag once. An older log still mentions the duplicate."));
  }

  if (repairInventory && dutyPath) {
    try {
      inventoryXml.repairFile(dutyPath);
    } catch {
      /* leave the file for review */
    }
  }
  const inventory = inventoryXml.validateFile(dutyPath);
  if (!inventory.missing && inventory.issues && inventory.issues.length) {
    const first = inventory.issues[0];
    items.push(item("inventory-xml", "WARNING", first.detail || "inventory.xml invalid chance", "Review lspdfr/data/inventory.xml. No guessed chance values were written."));
  } else if (/Failed to parse\s+as chance/i.test(text)) {
    items.push(item("inventory-xml", "FIXED", "inventory.xml invalid chance", "Blank chance attributes were repaired or are no longer present."));
  }

  const outfits = outfitCheck.inspect(dutyPath, text);
  if (outfits.logMissingUndefined.length || outfits.missingDefs.length) {
    const name = outfits.logMissingUndefined[0] || outfits.missingDefs[0];
    items.push(item("outfit", "WARNING", `Missing LSPDFR outfit definition: ${name}`, "agency.xml references this outfit and outfits.xml does not define it. No replacement was invented."));
  } else if (outfits.logMissingDefined.length) {
    items.push(item("outfit", "WARNING", `LSPDFR could not apply outfit ${outfits.logMissingDefined[0]}`, "The name is still defined in outfits.xml. The saved character look may not match. Files were left unchanged."));
  }

  for (const row of countCalloutFailures(text)) {
    if (row.count >= CALLOUT_FAIL_WARN) {
      items.push(item(`callout-${row.name}`, "WARNING", `${row.name} failed to start ${row.count} times`, "Repeated across recent Duty logs. The callout was not disabled."));
    } else {
      items.push(item(`callout-${row.name}`, "MONITOR", `${row.name} failed to start ${row.count} time${row.count === 1 ? "" : "s"}`, "One-off callout start failures stay informational."));
    }
  }

  const backup = backupManagerHits(text);
  if (backup.sessionHits >= BACKUP_SESSION_WARN || backup.lineHits >= 4) {
    items.push(item("backupmanager", "WARNING", "Repeated LSPDFR BackupManager exception", `${backup.sessionHits} session(s), ${backup.lineHits} BackupManager.cs line(s). Not attributed to Policing Redefined.`));
  } else if (backup.sessionHits || backup.lineHits) {
    items.push(item("backupmanager", "MONITOR", "LSPDFR BackupManager exception", `${backup.lineHits || backup.sessionHits} NotImplementedException line(s) in BackupManager. Tracked only.`));
  }

  if (/IPT\.Common/i.test(text)) {
    const pluginFailed = /(?:CalloutInterface|GrammarPolice)\s+dependency\s+\S+\s+is not available/i.test(text);
    const iptException = /IPT\.Common[^\n]{0,80}(?:Exception|failed to initialize)/i.test(text) && !/Cannot create an abstract class/i.test(text);
    items.push(
      item(
        "ipt-common",
        pluginFailed || iptException ? "WARNING" : "INFO",
        "IPT.Common messages",
        pluginFailed || iptException
          ? "IPT.Common noise coincided with a plugin init failure."
          : "Grammar Police / Callout Interface kept loading. Abstract-class / debug lines are informational."
      )
    );
  }

  if (weaponSkinDutyCrash(text)) {
    items.push(
      item(
        "lspdfr-duty-weaponskin",
        "WARNING",
        "LSPDFR crashed while going on duty",
        "LSPDFR loaded, then died in WeaponSkin.FromWeapon before any plugin could start. inventory.xml and the plugin pack are valid. This is an LSPDFR Enhanced weapon-tint native crash, not a missing mod file. Go on duty again without a weapon in hand."
      )
    );
  }

  const gfx = d3dCrashCorrelated(text);
  if (gfx.debug) {
    items.push(
      item(
        "d3d-debug",
        gfx.crash ? "WARNING" : "INFO",
        gfx.crash ? "D3D hook failed" : "D3D debug messages",
        gfx.crash
          ? "D3D/address lines lined up with a graphics hook failure."
          : "Address mismatch / D3D12 debug lines are not treated as a crash."
      )
    );
  }

  return {
    items,
    inventory,
    outfits,
    duplicates: dups,
  };
}

function functionTestChecks(dutyPath, logText) {
  const summary = summarize({ dutyPath, logText, repairInventory: false });
  const checks = [];
  const dups = summary.duplicates || [];
  checks.push({
    id: "launch-args",
    ok: dups.length === 0,
    level: dups.length ? "warn" : "ok",
    title: "Launch arguments",
    detail: dups.length
      ? `Duplicate launch argument detected: ${dups[0].flag}`
      : "Duty command-line flags are unique.",
  });

  const inv = summary.inventory || {};
  checks.push({
    id: "inventory-xml",
    ok: Boolean(inv.missing || inv.ok),
    level: inv.missing || inv.ok ? "ok" : "warn",
    title: "inventory.xml",
    detail: inv.missing
      ? "lspdfr/data/inventory.xml is not present."
      : inv.ok
        ? "inventory.xml chance values are valid numbers."
        : (inv.issues && inv.issues[0] && inv.issues[0].detail) || "inventory.xml has an invalid chance value.",
  });

  const outfits = summary.outfits || {};
  const missing = (outfits.logMissingUndefined || []).concat(outfits.missingDefs || []);
  checks.push({
    id: "outfit-defs",
    ok: missing.length === 0,
    level: missing.length ? "warn" : "ok",
    title: "LSPDFR outfits",
    detail: missing.length
      ? `Missing LSPDFR outfit definition: ${missing[0]}`
      : "Referenced agency outfits have definitions in outfits.xml.",
  });

  const dutyCrash = (summary.items || []).some((item) => item.id === "lspdfr-duty-weaponskin");
  checks.push({
    id: "lspdfr-duty-weaponskin",
    ok: !dutyCrash,
    level: dutyCrash ? "warn" : "ok",
    title: "LSPDFR go on duty",
    detail: dutyCrash
      ? "Last session: LSPDFR crashed in WeaponSkin while going on duty. Plugins never loaded."
      : "No WeaponSkin go-on-duty crash in the current log.",
  });

  return { checks, dutyWarnings: summary.items };
}

module.exports = {
  CALLOUT_FAIL_WARN,
  BACKUP_SESSION_WARN,
  summarize,
  functionTestChecks,
  countCalloutFailures,
  backupManagerHits,
  d3dCrashCorrelated,
  weaponSkinDutyCrash,
  splitSessions,
};
