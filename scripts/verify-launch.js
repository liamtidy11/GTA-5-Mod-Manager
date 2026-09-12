const fs = require("fs");
const path = require("path");
const { verifyLaunchIntegrity, verifyMapping } = require("../src/services/launchguard");

function readConfig() {
  const file = path.join(process.env.APPDATA || "", "GTA 5 Mod Manager", "config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function fallbackSandbox() {
  return path.join(__dirname, "..", "Grand Theft Auto V Enhanced - LSPDFR");
}

const cfg = readConfig();
const sandboxPath = cfg.sandboxPath || fallbackSandbox();
const officialPath = cfg.officialPath || "";
const mapping = verifyMapping();
const result = verifyLaunchIntegrity(sandboxPath, officialPath);

console.log(`Duty folder: ${sandboxPath}`);
if (officialPath) console.log(`Online folder: ${officialPath}`);
console.log("");

if (!mapping.ok) {
  console.log("FAIL  Install mapping leaked support DLLs or misplaced the plugin.");
  if (mapping.leaked.length) console.log(`      ${mapping.leaked.join(", ")}`);
  if (mapping.pluginDest) console.log(`      plugin -> ${mapping.pluginDest}`);
}

for (const row of result.checks) {
  const mark = row.ok ? "OK  " : row.level === "bad" ? "FAIL" : "WARN";
  console.log(`${mark}  ${row.title}: ${row.detail}`);
}

console.log("");
console.log(result.summary);

if (!mapping.ok || !result.ok) {
  process.exit(1);
}
