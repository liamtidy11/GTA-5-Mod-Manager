const fs = require("fs");
const path = require("path");
const packInstructions = require("./packInstructions");
const webGuideFetch = require("./webGuideFetch");
const guideSummarizer = require("./guideSummarizer");

const GUIDE_PATH = path.join(__dirname, "..", "..", "data", "installGuides.json");

let cached = null;

function compact(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function loadGuides() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(GUIDE_PATH, "utf8"));
  } catch {
    cached = { guides: [] };
  }
  return cached;
}

function matchGuide({ recognition = {}, archiveName = "", scan } = {}) {
  const hay = [
    recognition.modId,
    recognition.name,
    archiveName,
    ...((scan && scan.usableFiles) || []).map((f) => (typeof f === "string" ? f : f.base || f.rel)),
  ]
    .map(compact)
    .filter(Boolean)
    .join(" ");
  for (const guide of loadGuides().guides || []) {
    const keys = [guide.id, guide.title, ...(guide.aliases || [])].map(compact).filter((k) => k.length >= 4);
    if (keys.some((key) => hay.includes(key))) return guide;
  }
  return null;
}

function uniqueSteps(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const step of list || []) {
      const key = compact(step);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(step);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

async function advise({
  scan,
  recognition = {},
  archiveName = "",
  lookup = false,
  apiKey = "",
  apiUrl = "",
  fetchPages = webGuideFetch.fetchGuides,
  summarize = guideSummarizer.summarize,
} = {}) {
  const pack = packInstructions.extract(scan);
  const local = matchGuide({ recognition, archiveName, scan });
  const sourceUrls = [...(local && local.sources ? local.sources : []), ...pack.urls];
  let web = [];
  if (lookup) {
    web = await fetchPages(sourceUrls);
  }
  const webSteps = web.flatMap((page) => page.steps || []);
  let steps = uniqueSteps([local && local.steps, pack.steps, webSteps]);
  let usedAi = false;
  if (apiKey && (steps.length || pack.docs.length || local)) {
    const aiSteps = await summarize({
      apiKey,
      apiUrl,
      name: (local && local.title) || recognition.name || archiveName,
      packSteps: pack.steps,
      localSteps: (local && local.steps) || [],
      webSteps,
    });
    if (aiSteps.length) {
      steps = aiSteps;
      usedAi = true;
    }
  }
  const sources = [];
  if (local) sources.push("Local notes");
  if (pack.docs.length) sources.push(`Pack files (${pack.docs.join(", ")})`);
  for (const page of web) sources.push(page.url);

  return {
    title: (local && local.title) || recognition.name || "",
    matchedId: (local && local.id) || recognition.modId || null,
    steps,
    needs: (local && local.needs) || [],
    conflicts: (local && local.conflicts) || [],
    sources,
    usedAi,
    lookedOnline: Boolean(lookup && web.length),
    packDocs: pack.docs,
  };
}

module.exports = { advise, matchGuide, loadGuides, uniqueSteps };
