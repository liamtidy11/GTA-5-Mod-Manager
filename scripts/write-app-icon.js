const fs = require("fs");
const path = require("path");

// Windows ICO that embeds the PNG (Vista+). Used for the window, taskbar, and desktop shortcut.

const pngPath = path.join(__dirname, "..", "build", "icon.png");
const icoPath = path.join(__dirname, "..", "build", "icon.ico");

function pngToIco(png, dest) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(dest, Buffer.concat([header, png]));
}

if (!fs.existsSync(pngPath)) {
  throw new Error("build/icon.png is missing.");
}
pngToIco(fs.readFileSync(pngPath), icoPath);
console.log(`Wrote ${icoPath}`);
