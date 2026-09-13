const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  officialPath: "",
  sandboxPath: "",
  launcher: "unknown",
  cloneMode: "linked",
  setupComplete: false,
  // V6 personal settings.
  defaultProfileId: "",
  snapshotBeforeUpdate: true,
  snapshotBeforeRiskyInstall: true,
  smartPreviewDefault: false,
  sessionRetention: 40,
  autoSnapshotRetention: 15,
  openLastPage: false,
  lastPage: "dashboard",
  developerMode: false,
  theme: "dark",
  lookupInstallGuides: true,
  aiGuideEnabled: false,
  aiApiKey: "",
  aiApiUrl: "",
  workshopDownloadDirectory: "",
  workshopWatchDownloads: false,
  workshopCacheRetentionHours: 24,
  workshopOpenSourceLinks: true,
};

function configPath(userData) {
  return path.join(userData, "config.json");
}

function load(userData) {
  const file = configPath(userData);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(userData, next) {
  fs.mkdirSync(userData, { recursive: true });
  const merged = { ...load(userData), ...next };
  fs.writeFileSync(configPath(userData), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

module.exports = { load, save, DEFAULTS };
