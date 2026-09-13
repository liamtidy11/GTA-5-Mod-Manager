const { emptyCapabilities, PROVIDERS } = require("./providerTypes");

function createProvider({ id, name, capabilities = {}, list, search, details, openSourcePage } = {}) {
  const caps = emptyCapabilities(capabilities);
  return {
    id: id || PROVIDERS.LOCAL_CATALOG,
    name: name || id || "Provider",
    capabilities: caps,
    canList: caps.LIST === true,
    canGetDetails: caps.DETAILS === true,
    canDirectDownload: caps.DIRECT_DOWNLOAD === true,
    list: typeof list === "function" ? list : async () => [],
    search: typeof search === "function" ? search : async (query, rows) => rows || [],
    details: typeof details === "function" ? details : async () => null,
    openSourcePage: typeof openSourcePage === "function" ? openSourcePage : async () => ({ opened: false }),
  };
}

module.exports = { createProvider };
