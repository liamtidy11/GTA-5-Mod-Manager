const fs = require("fs");
const path = require("path");

function appIconPath() {
  const ico = path.join(__dirname, "..", "..", "build", "icon.ico");
  const png = path.join(__dirname, "..", "..", "build", "icon.png");
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return "";
}

module.exports = { appIconPath };
