const fs = require("fs");
const path = require("path");

function libraryPath(root) {
  return path.join(root, "library.json");
}

function empty() {
  return { schemaVersion: 1, favorites: [], collections: [] };
}

function load(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(root), "utf8"));
    return {
      schemaVersion: 1,
      favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String) : [],
      collections: Array.isArray(raw.collections)
        ? raw.collections
            .map((row) => ({
              id: String(row.id || "").trim(),
              name: String(row.name || "").trim(),
              workshopIds: Array.isArray(row.workshopIds) ? row.workshopIds.map(String) : [],
            }))
            .filter((row) => row.id && row.name)
        : [],
    };
  } catch {
    return empty();
  }
}

function save(root, data) {
  fs.mkdirSync(root, { recursive: true });
  const next = {
    schemaVersion: 1,
    favorites: [...new Set((data.favorites || []).map(String))],
    collections: (data.collections || []).map((row) => ({
      id: row.id,
      name: row.name,
      workshopIds: [...new Set(row.workshopIds || [])],
    })),
  };
  const tmp = `${libraryPath(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, libraryPath(root));
  return next;
}

function isFavorite(root, workshopId) {
  return load(root).favorites.includes(String(workshopId));
}

function toggleFavorite(root, workshopId) {
  const db = load(root);
  const id = String(workshopId || "");
  if (!id) return db;
  const set = new Set(db.favorites);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  db.favorites = [...set];
  return save(root, db);
}

function createCollection(root, name) {
  const db = load(root);
  const label = String(name || "").trim();
  if (!label) throw new Error("A collection name is required.");
  const id = `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.collections.push({ id, name: label, workshopIds: [] });
  return save(root, db);
}

function addToCollection(root, collectionId, workshopId) {
  const db = load(root);
  const col = db.collections.find((row) => row.id === collectionId);
  if (!col) throw new Error("That collection was not found.");
  if (workshopId && !col.workshopIds.includes(workshopId)) col.workshopIds.push(workshopId);
  return save(root, db);
}

function removeFromCollection(root, collectionId, workshopId) {
  const db = load(root);
  const col = db.collections.find((row) => row.id === collectionId);
  if (!col) return db;
  col.workshopIds = col.workshopIds.filter((id) => id !== workshopId);
  return save(root, db);
}

function deleteCollection(root, collectionId) {
  const db = load(root);
  db.collections = db.collections.filter((row) => row.id !== collectionId);
  return save(root, db);
}

module.exports = {
  libraryPath,
  load,
  save,
  isFavorite,
  toggleFavorite,
  createCollection,
  addToCollection,
  removeFromCollection,
  deleteCollection,
};
