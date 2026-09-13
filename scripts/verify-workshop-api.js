const { apiStatus, smokeMetadata } = require("../src/services/workshop/providers/lcpdfrProvider");

// Read-only capability check. Does not download a binary and does not call
// undocumented LCPDFR endpoints. A key may be passed as LCPDFR_API_KEY.

const key = process.env.LCPDFR_API_KEY || "";
const status = apiStatus({ apiKey: key });
const smoke = smokeMetadata({ apiKey: key });

console.log("Workshop LCPDFR API smoke (read-only)");
console.log(`configured: ${status.configured}`);
console.log(`status: ${status.status}`);
console.log(`canList: ${status.canList}`);
console.log(`canGetDetails: ${status.canGetDetails}`);
console.log(`canDirectDownload: ${status.canDirectDownload}`);
console.log(`smoke: ${smoke.reason}`);
if (status.message) console.log(status.message);

if (smoke.reason === "API_KEY_MISSING") {
  console.log("No key set. Local catalog remains the Browse Mods source.");
  process.exit(0);
}

if (smoke.requested) {
  console.error("Smoke test must not request undocumented endpoints.");
  process.exit(1);
}

process.exit(0);
