const fs = require("fs");
const path = require("path");
const { RPF7_MAGIC, ENC_OPEN, DIR_MARK, SECTOR } = require("./rpf7OpenFormat");

// Writes independently generated OPEN RPF7 archives for tests.
// Dummy text only. Not a production writer and not used on real GTA files.

function basename(rel) {
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function parentOf(rel) {
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function buildNodes(files) {
  const dirs = new Set([""]);
  const fileMap = new Map();
  for (const [rel, raw] of Object.entries(files)) {
    const norm = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = norm.split("/").filter(Boolean);
    let walk = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      walk = walk ? `${walk}/${parts[i]}` : parts[i];
      dirs.add(walk);
    }
    fileMap.set(norm, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8"));
  }
  const children = new Map();
  for (const dir of dirs) children.set(dir, []);
  for (const dir of dirs) {
    if (dir === "") continue;
    const parent = parentOf(dir);
    children.get(parent).push({ kind: "dir", key: dir, name: basename(dir) });
  }
  for (const [rel] of fileMap) {
    const parent = parentOf(rel);
    children.get(parent).push({ kind: "file", key: rel, name: basename(rel) });
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { children, fileMap };
}

function writeOpenRpf7(filePath, files) {
  const { children, fileMap } = buildNodes(files);
  const laid = [{ kind: "dir", key: "", name: "", entriesIndex: 0, entriesCount: 0 }];

  function fillDeep(dirIndex) {
    const node = laid[dirIndex];
    const kids = children.get(node.key) || [];
    node.entriesIndex = laid.length;
    node.entriesCount = kids.length;
    const childIdx = [];
    for (const kid of kids) {
      childIdx.push(laid.length);
      if (kid.kind === "dir") laid.push({ kind: "dir", key: kid.key, name: kid.name, entriesIndex: 0, entriesCount: 0 });
      else laid.push({ kind: "file", key: kid.key, name: kid.name, bytes: fileMap.get(kid.key) });
    }
    for (const i of childIdx) {
      if (laid[i].kind === "dir") fillDeep(i);
    }
  }

  fillDeep(0);

  const names = [];
  const nameOffset = new Map();
  function putName(name) {
    if (nameOffset.has(name)) return nameOffset.get(name);
    const off = names.reduce((sum, row) => sum + Buffer.byteLength(row) + 1, 0);
    nameOffset.set(name, off);
    names.push(name);
    return off;
  }
  for (const node of laid) putName(node.name);

  const namesBuf = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from(n, "utf8"), Buffer.from([0])])));
  const entryCount = laid.length;
  const prefixLen = 16 + entryCount * 16 + namesBuf.length;
  const dataStart = Math.ceil(prefixLen / SECTOR) * SECTOR;
  const entries = Buffer.alloc(entryCount * 16);
  let sector = dataStart / SECTOR;
  const payloads = [];

  for (let i = 0; i < laid.length; i += 1) {
    const node = laid[i];
    const off = i * 16;
    if (node.kind === "dir") {
      entries.writeUInt32LE(putName(node.name), off);
      entries.writeUInt32LE(DIR_MARK, off + 4);
      entries.writeUInt32LE(node.entriesIndex, off + 8);
      entries.writeUInt32LE(node.entriesCount, off + 12);
    } else {
      const nOff = putName(node.name);
      const size = node.bytes.length;
      entries.writeUInt16LE(nOff, off);
      entries[off + 2] = size & 0xff;
      entries[off + 3] = (size >> 8) & 0xff;
      entries[off + 4] = (size >> 16) & 0xff;
      entries[off + 5] = sector & 0xff;
      entries[off + 6] = (sector >> 8) & 0xff;
      entries[off + 7] = (sector >> 16) & 0xff;
      entries.writeUInt32LE(size, off + 8);
      payloads.push({ sector, bytes: node.bytes });
      sector += Math.max(1, Math.ceil(size / SECTOR) || 1);
    }
  }

  const header = Buffer.alloc(16);
  header.writeUInt32LE(RPF7_MAGIC, 0);
  header.writeUInt32LE(entryCount, 4);
  header.writeUInt32LE(namesBuf.length, 8);
  header.writeUInt32LE(ENC_OPEN, 12);
  const prefix = Buffer.concat([header, entries, namesBuf]);
  const end = payloads.reduce((max, row) => Math.max(max, row.sector * SECTOR + row.bytes.length), dataStart);
  const out = Buffer.alloc(Math.max(end, dataStart));
  prefix.copy(out);
  for (const row of payloads) row.bytes.copy(out, row.sector * SECTOR);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out);
  return filePath;
}

module.exports = { writeOpenRpf7 };
