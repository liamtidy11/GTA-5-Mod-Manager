const { PROVIDERS, emptyCapabilities, USER_AGENT } = require("./providerTypes");
const { createProvider } = require("./baseProvider");

// LCPDFR's current developer API is authenticated and subject to approval.
// This provider stores/uses a user-supplied key and will only call endpoints
// listed here. No third-party metadata routes are documented for this app yet,
// so SEARCH / LIST / DETAILS stay local-catalog-only. DIRECT_DOWNLOAD is always false.

const DOCUMENTED_METADATA_PATHS = [];

const MIN_INTERVAL_MS = 1500;

function createLcpdfrProvider({ apiKey = "", fetchImpl = null, now = () => Date.now(), lastCall = { at: 0 } } = {}) {
  const configured = Boolean(String(apiKey || "").trim());
  const canCallDocumented = configured && DOCUMENTED_METADATA_PATHS.length > 0 && typeof fetchImpl === "function";

  async function limited(fn) {
    const wait = MIN_INTERVAL_MS - (now() - (lastCall.at || 0));
    if (wait > 0) {
      const err = new Error("RATE_LIMITED");
      err.retryAfterMs = wait;
      throw err;
    }
    lastCall.at = now();
    return fn();
  }

  return createProvider({
    id: PROVIDERS.LCPDFR,
    name: "LCPDFR",
    capabilities: emptyCapabilities({
      SEARCH: canCallDocumented,
      LIST: canCallDocumented,
      DETAILS: canCallDocumented,
      VERSION_CHECK: canCallDocumented,
      SCREENSHOTS: false,
      OPEN_SOURCE_PAGE: true,
      DIRECT_DOWNLOAD: false,
    }),
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async details() {
      return null;
    },
  });
}

function apiStatus({ apiKey = "", encryptionAvailable = true } = {}) {
  if (!encryptionAvailable) {
    return { configured: false, status: "encryption_unavailable", canList: false, canGetDetails: false, canDirectDownload: false };
  }
  if (!String(apiKey || "").trim()) {
    return {
      configured: false,
      status: "not_configured",
      canList: false,
      canGetDetails: false,
      canDirectDownload: false,
      message: "No LCPDFR API key. Browse Mods uses the local catalog and official source links.",
    };
  }
  return {
    configured: true,
    status: "configured",
    canList: false,
    canGetDetails: false,
    canDirectDownload: false,
    message: "API key saved. Live LCPDFR listing is not enabled until LCPDFR documents metadata endpoints for this app.",
    userAgent: USER_AGENT,
  };
}

function smokeMetadata({ apiKey = "", fetchImpl = null } = {}) {
  if (!String(apiKey || "").trim()) return { ok: false, reason: "API_KEY_MISSING" };
  if (!DOCUMENTED_METADATA_PATHS.length) {
    return { ok: true, reason: "NO_DOCUMENTED_ENDPOINT", requested: false, canDirectDownload: false };
  }
  if (typeof fetchImpl !== "function") return { ok: false, reason: "NO_FETCH" };
  return { ok: false, reason: "NO_DOCUMENTED_ENDPOINT", requested: false };
}

module.exports = { createLcpdfrProvider, apiStatus, smokeMetadata, DOCUMENTED_METADATA_PATHS, USER_AGENT };
