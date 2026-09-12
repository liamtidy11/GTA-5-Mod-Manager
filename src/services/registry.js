const fs = require("fs");
const path = require("path");
const { tactixDir, exists } = require("./paths");

function registryFile(sandboxPath) {
  return path.join(tactixDir(sandboxPath), "mods.json");
}

function load(sandboxPath) {
  const file = registryFile(sandboxPath);
  if (!exists(file)) return { mods: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.mods)) data.mods = [];
    return data;
  } catch {
    return { mods: [] };
  }
}

function save(sandboxPath, data) {
  const dir = tactixDir(sandboxPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFile(sandboxPath), JSON.stringify(data, null, 2), "utf8");
}

function add(sandboxPath, record) {
  const data = load(sandboxPath);
  data.mods = data.mods.filter((mod) => mod.id !== record.id);
  data.mods.unshift(record);
  save(sandboxPath, data);
  return record;
}

function update(sandboxPath, id, patch) {
  const data = load(sandboxPath);
  const mod = data.mods.find((item) => item.id === id);
  if (!mod) return null;
  Object.assign(mod, patch);
  save(sandboxPath, data);
  return mod;
}

function remove(sandboxPath, id) {
  const data = load(sandboxPath);
  const mod = data.mods.find((item) => item.id === id);
  data.mods = data.mods.filter((item) => item.id !== id);
  save(sandboxPath, data);
  return mod;
}

function ownersOf(sandboxPath, relPath) {
  const data = load(sandboxPath);
  const needle = relPath.replace(/\//g, "\\").toLowerCase();
  return data.mods.filter((mod) =>
    (mod.files || []).some((file) => file.replace(/\//g, "\\").toLowerCase() === needle)
  );
}

module.exports = { load, save, add, update, remove, ownersOf, registryFile };
