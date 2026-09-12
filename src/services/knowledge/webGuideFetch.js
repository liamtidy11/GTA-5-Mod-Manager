const { stripHtml, extractSteps, urlsFromText } = require("./packInstructions");

const ALLOWED_HOSTS = new Set([
  "policing-redefined.netlify.app",
  "www.lcpdfr.com",
  "lcpdfr.com",
  "www.gta5-mods.com",
  "gta5-mods.com",
  "github.com",
  "raw.githubusercontent.com",
]);

const MAX_BYTES = 350_000;
const TIMEOUT_MS = 8000;

function allowedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function pickUrls(candidates = []) {
  return [...new Set(candidates.filter(allowedUrl))].slice(0, 2);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "GTA-V-Mod-Manager-personal/1.0" },
    });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return "";
    const type = String(res.headers.get("content-type") || "");
    if (type && !/text|html|xml|json|markdown/i.test(type)) return "";
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGuides(candidates = []) {
  const urls = pickUrls(candidates);
  const pages = [];
  for (const url of urls) {
    const raw = await fetchText(url);
    if (!raw) continue;
    const text = stripHtml(raw);
    const steps = extractSteps(text);
    pages.push({
      url,
      steps,
      urls: urlsFromText(raw).filter(allowedUrl),
    });
  }
  return pages;
}

module.exports = { allowedUrl, pickUrls, fetchGuides, ALLOWED_HOSTS };
