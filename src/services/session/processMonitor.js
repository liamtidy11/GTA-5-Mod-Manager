const { execFileSync } = require("child_process");

const KNOWN_IMAGES = [
  "RagePluginHook.exe",
  "RAGEPluginHook.exe",
  "GTA5_Enhanced.exe",
  "GTA5_Enhanced_BE.exe",
  "PlayGTAV.exe",
  "NVIDIA Overlay.exe",
  "NVIDIA Share.exe",
  "RazerCortex.exe",
  "Discord.exe",
  "RTSS.exe",
  "MSIAfterburner.exe",
];

const RPH_IMAGES = ["RagePluginHook.exe", "RAGEPluginHook.exe"];
const GTA_IMAGES = ["GTA5_Enhanced.exe", "GTA5_Enhanced_BE.exe"];

function parseTasklist(output, image) {
  const rows = [];
  const pattern = new RegExp(`^${image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)`, "im");
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) rows.push({ image, pid: Number(match[1]), running: true });
  }
  return rows;
}

function listImage(image) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return parseTasklist(out, image);
  } catch {
    return [];
  }
}

function systemAdapter() {
  return {
    listKnown(images = KNOWN_IMAGES) {
      const found = [];
      for (const image of images) found.push(...listImage(image));
      return found;
    },
  };
}

function createFakeAdapter(initial = []) {
  const procs = new Map();
  for (const row of initial) procs.set(row.image.toLowerCase(), { ...row, running: row.running !== false });

  return {
    listKnown(images = KNOWN_IMAGES) {
      return [...procs.values()].filter((row) => row.running && images.some((name) => name.toLowerCase() === row.image.toLowerCase()));
    },
    setRunning(image, running, extras = {}) {
      const key = image.toLowerCase();
      const current = procs.get(key) || { image, pid: extras.pid || 1000 };
      procs.set(key, { ...current, ...extras, image, running: Boolean(running) });
    },
    exit(image, exitCode = 0) {
      const key = image.toLowerCase();
      const current = procs.get(key);
      if (current) procs.set(key, { ...current, running: false, exitCode, exitedAt: extrasNow() });
    },
  };
}

function extrasNow() {
  return new Date().toISOString();
}

function snapshotKnown(adapter, images = KNOWN_IMAGES) {
  const listed = adapter.listKnown(images);
  return images.map((image) => {
    const hit = listed.find((row) => row.image.toLowerCase() === image.toLowerCase());
    return {
      image,
      running: Boolean(hit),
      pid: hit ? hit.pid : null,
    };
  });
}

function findRunning(snapshot, names) {
  return (snapshot || []).find((row) => row.running && names.some((name) => name.toLowerCase() === row.image.toLowerCase())) || null;
}

module.exports = {
  KNOWN_IMAGES,
  RPH_IMAGES,
  GTA_IMAGES,
  parseTasklist,
  systemAdapter,
  createFakeAdapter,
  snapshotKnown,
  findRunning,
};
