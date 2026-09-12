const fs = require("fs");
const path = require("path");
const {
  exists,
  isEnhancedFolder,
  sameVolume,
  walkFiles,
  tactixDir,
  ENHANCED_EXE,
} = require("./paths");
const environmentInventory = require("./environmentInventory");

async function create({ officialPath, sandboxPath, mode = "linked", onProgress }) {
  if (!isEnhancedFolder(officialPath)) {
    throw new Error("Official folder is not GTA V Enhanced.");
  }
  const officialResolved = path.resolve(officialPath).toLowerCase();
  const sandboxResolved = path.resolve(sandboxPath).toLowerCase();
  if (officialResolved === sandboxResolved) {
    throw new Error("The LSPDFR folder must be different from the Online folder.");
  }
  if (
    sandboxResolved.startsWith(officialResolved + path.sep) ||
    officialResolved.startsWith(sandboxResolved + path.sep)
  ) {
    throw new Error("The LSPDFR folder cannot sit inside the Online folder, or the other way around.");
  }

  const linked = mode === "linked";
  if (linked && !sameVolume(officialPath, sandboxPath)) {
    throw new Error(
      "Linked copy must stay on the same drive as the official install. Pick a folder on the same drive, or use a full copy."
    );
  }

  await fs.promises.mkdir(sandboxPath, { recursive: true });
  await fs.promises.mkdir(tactixDir(sandboxPath), { recursive: true });

  const files = await walkFiles(officialPath);
  const total = files.length;
  let done = 0;
  let linkedCount = 0;
  let copiedCount = 0;

  for (const rel of files) {
    const src = path.join(officialPath, rel);
    const dest = path.join(sandboxPath, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    if (exists(dest)) {
      done += 1;
      if (onProgress && done % 40 === 0) {
        onProgress({ done, total, file: rel, phase: "clone" });
      }
      continue;
    }

    if (linked) {
      try {
        await fs.promises.link(src, dest);
        linkedCount += 1;
      } catch {
        await fs.promises.copyFile(src, dest);
        copiedCount += 1;
      }
    } else {
      await fs.promises.copyFile(src, dest);
      copiedCount += 1;
    }

    done += 1;
    if (onProgress && (done % 25 === 0 || done === total)) {
      onProgress({ done, total, file: rel, phase: "clone" });
    }
  }

  if (!isEnhancedFolder(sandboxPath)) {
    throw new Error("Sandbox was created but GTA5_Enhanced.exe is missing.");
  }

  environmentInventory.invalidate({ dutyPath: sandboxPath });
  return {
    sandboxPath,
    fileCount: total,
    linkedCount,
    copiedCount,
    mode: linked ? "linked" : "full",
  };
}

function status(officialPath, sandboxPath) {
  return {
    officialReady: isEnhancedFolder(officialPath),
    sandboxReady: isEnhancedFolder(sandboxPath),
    hasRage: exists(path.join(sandboxPath || "", "RagePluginHook.exe")),
    officialExe: officialPath ? path.join(officialPath, ENHANCED_EXE) : "",
    sandboxExe: sandboxPath ? path.join(sandboxPath, ENHANCED_EXE) : "",
  };
}

module.exports = { create, status };
