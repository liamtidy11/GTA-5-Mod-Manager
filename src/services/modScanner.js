const fs = require("fs");
const path = require("path");
const { isJunk } = require("./modtypes");
const { isGameTreeDirName } = require("./knowledge/gameTreeNormalize");

// Scans a staged (already extracted) folder and produces a structured picture
// of its contents for the classifier and conflict detector. Read-only.

const README_RE = /^(readme|read me|install|installation|how ?to|instructions)/i;
const FULL_GAME_MARKERS = ["gta5_enhanced.exe", "gta5.exe", "playgtav.exe"];

// Folders that mean "the payload is already correctly structured". We must not
// collapse into these, or we would strip the destination prefix (e.g. plugins/).
const STRUCTURE_DIRS = new Set([
  "plugins",
  "lspdfr",
  "scripts",
  "els",
  "lml",
  "mods",
  "update",
  "x64",
  "dlcpacks",
  "common",
  "audio",
]);

function normSlash(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Descend through wrapper folders like "MyMod v1.2/MyMod/..." so the scan sees
// the real payload root. Stops as soon as a level contains files.
function collapseSingleRoot(root) {
  let current = root;
  for (let i = 0; i < 8; i += 1) {
    const entries = listDir(current).filter((e) => e.name.toLowerCase() !== "__macosx");
    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile() && !isJunk(e.name));
    if (files.length === 0 && dirs.length === 1 && !STRUCTURE_DIRS.has(dirs[0].name.toLowerCase())) {
      current = path.join(current, dirs[0].name);
      continue;
    }
    break;
  }
  return current;
}

function preferGameTree(root) {
  const hint = listDir(root).find((entry) => entry.isDirectory() && isGameTreeDirName(entry.name));
  return hint ? path.join(root, hint.name) : root;
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of listDir(dir)) {
      if (entry.name.toLowerCase() === "__macosx") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readReadme(root, files) {
  const candidate = files.find((f) => {
    const base = path.basename(f.rel);
    return README_RE.test(base) && /\.(txt|md|rtf|nfo)$/i.test(base);
  });
  if (!candidate) return "";
  try {
    return fs.readFileSync(path.join(root, candidate.rel), "utf8").slice(0, 20000);
  } catch {
    return "";
  }
}

function readReadmeInDir(dir) {
  const hit = listDir(dir).find((entry) => entry.isFile() && README_RE.test(entry.name) && /\.(txt|md|rtf|nfo)$/i.test(entry.name));
  if (!hit) return "";
  try {
    return fs.readFileSync(path.join(dir, hit.name), "utf8").slice(0, 20000);
  } catch {
    return "";
  }
}

// Scans a folder. Returns:
//   { root, files:[{rel,base,ext,size,junk}], usableFiles, readmeText,
//     extensions:[...], isFullGame, empty }
function scan(folderPath) {
  const collapsed = collapseSingleRoot(folderPath);
  const root = preferGameTree(collapsed);
  const absFiles = walk(root);
  const files = absFiles.map((abs) => {
    const rel = normSlash(path.relative(root, abs));
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      /* ignore */
    }
    return {
      rel,
      base: path.basename(rel),
      ext: path.extname(rel).toLowerCase(),
      size,
      junk: isJunk(rel),
    };
  });

  const usableFiles = files.filter((f) => !f.junk);
  const extensions = [...new Set(files.map((f) => f.ext).filter(Boolean))];
  const isFullGame = files.some((f) => FULL_GAME_MARKERS.includes(f.base.toLowerCase()));
  const readmeText = [readReadmeInDir(folderPath), readReadmeInDir(collapsed), readReadmeInDir(path.dirname(root)), readReadme(root, files)]
    .filter(Boolean)
    .join("\n\n");

  return {
    root,
    files,
    usableFiles,
    readmeText,
    extensions,
    isFullGame,
    empty: usableFiles.length === 0,
  };
}

module.exports = { scan, collapseSingleRoot, preferGameTree, normSlash };
