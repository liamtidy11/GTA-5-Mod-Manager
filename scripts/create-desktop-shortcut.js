const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const icon = path.join(root, "build", "icon.ico");
const desktop = path.join(os.homedir(), "Desktop");
const shortcut = path.join(desktop, "GTA V Mod Manager.lnk");

if (!fs.existsSync(electron)) {
  throw new Error("Electron is not installed. Run npm install first.");
}
if (!fs.existsSync(icon)) {
  throw new Error("build/icon.ico is missing. Run node scripts/write-app-icon.js first.");
}
fs.mkdirSync(desktop, { recursive: true });

const ps = `
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut(${JSON.stringify(shortcut)})
$link.TargetPath = ${JSON.stringify(electron)}
$link.Arguments = "."
$link.WorkingDirectory = ${JSON.stringify(root)}
$link.IconLocation = ${JSON.stringify(icon)}
$link.Description = "GTA V Mod Manager"
$link.WindowStyle = 1
$link.Save()
`;

const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || "Could not create the desktop shortcut.");
}
console.log(`Desktop shortcut: ${shortcut}`);
