const fs = require("fs");
const path = require("path");
const { safeJoin, exists } = require("./paths");
const protectedFiles = require("./protectedFiles");
const manifestStore = require("./manifestStore");
const { safeHashFileSync } = require("./hashUtil");

// Compares a planned set of copies against the current Duty folder and the
// installed-mod manifests, producing a per-file conflict report and an overall
// severity. Read-only: it never writes to disk.

const { SEVERITY, maxSeverity } = protectedFiles;

function normDest(rel) {
  return String(rel || "").replace(/\\/g, "/").toLowerCase();
}

function sameContent(absA, absB, sizeA, sizeB) {
  if (typeof sizeA === "number" && typeof sizeB === "number" && sizeA !== sizeB) return false;
  const ha = safeHashFileSync(absA);
  const hb = safeHashFileSync(absB);
  return Boolean(ha && hb && ha === hb);
}

// copies: [{ rel, destination, sourceAbs, size }]
// options: { dutyPath, dataDir, officialPath?, legacyOwnersOf?(destRel)=>[{id,name}] }
function detect(copies, { dutyPath, dataDir, officialPath = "", legacyOwnersOf = null } = {}) {
  const items = [];
  let severity = "NONE";
  let addCount = 0;
  let replaceCount = 0;
  let skipCount = 0;

  const push = (item) => {
    items.push(item);
    severity = maxSeverity(severity, item.level);
  };

  // Never operate on the clean Online install.
  if (officialPath && path.resolve(dutyPath).toLowerCase() === path.resolve(officialPath).toLowerCase()) {
    push({
      level: "BLOCKED",
      code: "online-target",
      message: "The install target is the clean Online install. Smart Install never writes there.",
      files: [],
    });
    return { severity, items, addCount, replaceCount, skipCount, plan: [] };
  }

  // Detect two incoming files aimed at the same destination.
  const destSeen = new Map();
  for (const c of copies) {
    const key = normDest(c.destination);
    destSeen.set(key, (destSeen.get(key) || 0) + 1);
  }

  const plan = [];

  for (const c of copies) {
    const destRel = c.destination;
    let destAbs;
    try {
      destAbs = safeJoin(dutyPath, destRel.replace(/\//g, path.sep));
    } catch {
      push({
        level: "BLOCKED",
        code: "unsafe-path",
        message: `Blocked unsafe destination path: ${destRel}`,
        files: [destRel],
      });
      continue;
    }

    const existingSize = exists(destAbs) ? (() => {
      try { return fs.statSync(destAbs).size; } catch { return null; }
    })() : null;

    // Protected / blocked / risky files are skipped, never overwritten.
    const prot = protectedFiles.evaluate({
      destRel,
      incomingSize: c.size,
      existingSize,
    });
    if (prot.skip) {
      skipCount += 1;
      push({
        level: prot.severity,
        code: prot.kind,
        message: `${destRel}: ${prot.reason}`,
        files: [destRel],
        skip: true,
      });
      plan.push({ ...c, action: "skip", reason: prot.reason, severity: prot.severity });
      continue;
    }

    // Duplicate destination inside this same archive.
    if ((destSeen.get(normDest(destRel)) || 0) > 1) {
      push({
        level: "WARNING",
        code: "duplicate-destination",
        message: `Two files in this pack map to ${destRel}. The last one would win.`,
        files: [destRel],
      });
    }

    if (existingSize !== null) {
      // File already present in the Duty folder.
      if (sameContent(destAbs, c.sourceAbs, existingSize, c.size)) {
        push({
          level: "SAFE_REPLACEMENT",
          code: "identical",
          message: `${destRel} is already present and identical.`,
          files: [destRel],
        });
        plan.push({ ...c, action: "noop", severity: "SAFE_REPLACEMENT" });
        continue;
      }

      const smartOwners = manifestStore.ownersOf(dataDir, destRel);
      const legacyOwners = legacyOwnersOf ? legacyOwnersOf(destRel) : [];
      const owners = [...smartOwners.map((m) => m.name || m.id), ...legacyOwners.map((m) => m.name || m.id)];
      if (owners.length) {
        push({
          level: "WARNING",
          code: "owned-by-other",
          message: `${destRel} is currently provided by: ${owners.join(", ")}. It will be replaced (a backup is kept).`,
          files: [destRel],
        });
      } else {
        push({
          level: "WARNING",
          code: "overwrite",
          message: `${destRel} already exists and will be replaced (a backup is kept).`,
          files: [destRel],
        });
      }
      replaceCount += 1;
      plan.push({ ...c, action: "replace", severity: "WARNING" });
    } else {
      addCount += 1;
      plan.push({ ...c, action: "add", severity: "NONE" });
    }
  }

  return { severity, items, addCount, replaceCount, skipCount, plan };
}

module.exports = { detect, SEVERITY, maxSeverity };
