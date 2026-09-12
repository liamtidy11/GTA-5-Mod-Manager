const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.join(__dirname, "..", "..", "data", "dependencyDownloads.json");
const UA = "GTA-V-Mod-Manager-personal/1.0";
const MAX_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 45000;

const HARD_BLOCK = new Set(["scripthookv", "scripthookvdotnet"]);

const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const PAGE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "lcpdfr.com",
  "www.lcpdfr.com",
  "gta5-mods.com",
  "www.gta5-mods.com",
]);

const API_HOSTS = new Set(["api.github.com"]);

const NEED_STATES = new Set(["MISSING", "VERSION_TOO_OLD"]);

let cached = null;

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function loadCatalog() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  } catch {
    cached = { items: [], blockedIds: [] };
  }
  return cached;
}

function isBlockedId(id) {
  const key = compact(id);
  if (!key) return false;
  if (HARD_BLOCK.has(key)) return true;
  return (loadCatalog().blockedIds || []).map(compact).includes(key);
}

function labelsOf(item) {
  return [item.id, item.name, ...(item.aliases || [])].filter(Boolean).map((v) => String(v).toLowerCase());
}

function findItem(query) {
  const needle = String(query || "").trim().toLowerCase();
  const packed = compact(needle);
  if (!needle) return null;
  return (
    (loadCatalog().items || []).find((item) => {
      const labels = labelsOf(item);
      return labels.includes(needle) || labels.map(compact).includes(packed);
    }) || null
  );
}

function httpsHost(value, hosts) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    return hosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isDownloadUrlAllowed(value) {
  return httpsHost(value, DOWNLOAD_HOSTS);
}

function isPageUrlAllowed(value) {
  return httpsHost(value, PAGE_HOSTS);
}

function isApiUrlAllowed(value) {
  return httpsHost(value, API_HOSTS);
}

function isGithubRepo(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || ""));
}

function canFetch(item) {
  return Boolean(item && (item.githubRepo || item.downloadUrl) && !isBlockedId(item.id));
}

function makeOffer(item, dep = {}) {
  const state = dep.state || "MISSING";
  return {
    id: item.id,
    name: item.name,
    sourceLabel: item.sourceLabel || "",
    note: item.note || "",
    pageUrl: isPageUrlAllowed(item.pageUrl) ? item.pageUrl : "",
    canDownload: canFetch(item) && state !== "DISABLED",
    state,
    kind: dep.kind || "REQUIRED",
  };
}

function offersFor(dependencies = []) {
  const out = [];
  const seen = new Set();
  for (const dep of dependencies || []) {
    const item = findItem(dep.modId) || findItem(dep.name);
    if (!item || isBlockedId(item.id) || seen.has(item.id)) continue;
    if (!NEED_STATES.has(dep.state) && dep.state !== "DISABLED") continue;
    seen.add(item.id);
    out.push(makeOffer(item, dep));
  }
  return out;
}

function offersForNames(names = []) {
  const out = [];
  const seen = new Set();
  for (const name of names || []) {
    const item = findItem(name);
    if (!item || isBlockedId(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(makeOffer(item, { state: "MISSING", kind: "REQUIRED" }));
  }
  return out;
}

function safeFileName(name) {
  const base = path.basename(String(name || "dependency.zip")).replace(/[^\w.\-]+/g, "_");
  return /\.(zip|rar|7z)$/i.test(base) ? base : `${base || "dependency"}.zip`;
}

async function resolveGithubAsset(item, fetchImpl) {
  if (item.downloadUrl && isDownloadUrlAllowed(item.downloadUrl) && !item.githubRepo) {
    return { url: item.downloadUrl, name: item.filename || `${item.id}.zip` };
  }
  if (!isGithubRepo(item.githubRepo)) {
    if (item.downloadUrl && isDownloadUrlAllowed(item.downloadUrl)) {
      return { url: item.downloadUrl, name: item.filename || `${item.id}.zip` };
    }
    throw new Error("That catalog entry is not a valid GitHub repository.");
  }
  const api = `https://api.github.com/repos/${item.githubRepo}/releases/latest`;
  if (!isApiUrlAllowed(api)) throw new Error("GitHub API URL rejected.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(api, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      if (item.downloadUrl && isDownloadUrlAllowed(item.downloadUrl)) {
        return { url: item.downloadUrl, name: item.filename || `${item.id}.zip` };
      }
      throw new Error("Could not look up the official GitHub release.");
    }
    const data = await res.json();
    const pattern = new RegExp(item.assetPattern || "\\.zip$", "i");
    const asset = (data.assets || []).find(
      (row) =>
        row &&
        pattern.test(row.name) &&
        /\.(zip|rar|7z)$/i.test(row.name) &&
        isDownloadUrlAllowed(row.browser_download_url)
    );
    if (!asset) {
      if (item.downloadUrl && isDownloadUrlAllowed(item.downloadUrl)) {
        return { url: item.downloadUrl, name: item.filename || `${item.id}.zip` };
      }
      throw new Error("The official release did not include a zip the manager can install.");
    }
    return { url: asset.browser_download_url, name: asset.name, size: Number(asset.size) || 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadArchive({ url, destPath, fetchImpl = fetch } = {}) {
  if (!isDownloadUrlAllowed(url)) {
    throw new Error("That download is not from an allowed official host.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "application/octet-stream" },
    });
    if (!res.ok) throw new Error("The official download failed.");
    const finalUrl = res.url || url;
    if (finalUrl && !isDownloadUrlAllowed(finalUrl)) {
      throw new Error("The download redirected off the allowed official hosts.");
    }
    const announced = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (announced > MAX_BYTES) throw new Error("That archive is larger than the manager will fetch.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("That archive is larger than the manager will fetch.");
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error("The download was not a zip archive.");
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return destPath;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("The official download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function copyMatching(fromDir, toDir, keepFiles) {
  const want = new Set((keepFiles || []).map((name) => String(name).toLowerCase()));
  const copied = [];
  const stack = [fromDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !want.has(entry.name.toLowerCase())) continue;
      fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(full, path.join(toDir, entry.name));
      copied.push(entry.name);
    }
  }
  return copied;
}

async function downloadTo({
  modId,
  destDir,
  fetchImpl = fetch,
  extractArchive = null,
} = {}) {
  const item = findItem(modId);
  if (!item) throw new Error("That dependency is not in the curated catalog.");
  if (isBlockedId(item.id)) throw new Error("That component cannot be downloaded by the manager.");
  if (!canFetch(item)) {
    throw new Error(`${item.name} has to be downloaded from its official page first.`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const source = await resolveGithubAsset(item, fetchImpl);
  const archivePath = path.join(destDir, safeFileName(source.name));
  await downloadArchive({ url: source.url, destPath: archivePath, fetchImpl });
  if ((item.keepFiles || []).length && typeof extractArchive === "function") {
    const extracted = path.join(destDir, `${item.id}-extracted`);
    const kept = path.join(destDir, `${item.id}-kept`);
    await extractArchive(archivePath, extracted);
    const files = copyMatching(extracted, kept, item.keepFiles);
    if (!files.length) {
      throw new Error(`The official ${item.name} archive did not contain the expected files.`);
    }
    return { path: kept, item, files, archivePath };
  }
  return { path: archivePath, item, files: [], archivePath };
}

module.exports = {
  loadCatalog,
  findItem,
  isBlockedId,
  isDownloadUrlAllowed,
  isPageUrlAllowed,
  isGithubRepo,
  offersFor,
  offersForNames,
  downloadArchive,
  downloadTo,
  copyMatching,
  resolveGithubAsset,
};
