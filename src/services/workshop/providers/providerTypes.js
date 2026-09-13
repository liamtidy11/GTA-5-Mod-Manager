const PROVIDERS = {
  LOCAL_CATALOG: "LOCAL_CATALOG",
  LCPDFR: "LCPDFR",
  GITHUB: "GITHUB",
};

const CAPABILITIES = {
  SEARCH: "SEARCH",
  LIST: "LIST",
  DETAILS: "DETAILS",
  VERSION_CHECK: "VERSION_CHECK",
  SCREENSHOTS: "SCREENSHOTS",
  OPEN_SOURCE_PAGE: "OPEN_SOURCE_PAGE",
  DIRECT_DOWNLOAD: "DIRECT_DOWNLOAD",
};

const CATEGORIES = [
  "ESSENTIAL",
  "FRAMEWORK",
  "POLICE_INTERACTION",
  "BACKUP",
  "DISPATCH",
  "MDT",
  "CALLOUTS",
  "TRAFFIC",
  "IMMERSION",
  "EMS_FIRE",
  "UTILITY",
  "GRAPHICS",
  "VEHICLE",
  "EUP",
  "AUDIO",
  "OTHER",
];

const ENHANCED = ["VERIFIED", "LIKELY", "UNKNOWN", "LEGACY_ONLY", "INCOMPATIBLE"];

const SOURCE_HOSTS = new Set([
  "www.lcpdfr.com",
  "lcpdfr.com",
  "github.com",
  "www.github.com",
  "ragepluginhook.net",
  "www.ragepluginhook.net",
  "www.bejoijo.com",
  "bejoijo.com",
  "sites.google.com",
]);

const DEFAULT_CAPABILITIES = {
  SEARCH: false,
  LIST: false,
  DETAILS: false,
  VERSION_CHECK: false,
  SCREENSHOTS: false,
  OPEN_SOURCE_PAGE: true,
  DIRECT_DOWNLOAD: false,
};

const USER_AGENT = "GTA5ModManager/1.0 (personal; +https://github.com/liamtidy11/GTA-5-Mod-Manager)";

function emptyCapabilities(overrides = {}) {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

function isAllowedSourceUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:") return false;
    return SOURCE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

module.exports = {
  PROVIDERS,
  CAPABILITIES,
  CATEGORIES,
  ENHANCED,
  SOURCE_HOSTS,
  DEFAULT_CAPABILITIES,
  USER_AGENT,
  emptyCapabilities,
  isAllowedSourceUrl,
};
