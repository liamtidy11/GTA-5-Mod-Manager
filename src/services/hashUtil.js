const fs = require("fs");
const crypto = require("crypto");

// Small, dependency-free hashing helpers used for file ownership and
// verifying that a transactional copy landed byte-for-byte.

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashString(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function hashFileSync(filePath) {
  const buffer = fs.readFileSync(filePath);
  return hashBuffer(buffer);
}

function safeHashFileSync(filePath) {
  try {
    return hashFileSync(filePath);
  } catch {
    return null;
  }
}

module.exports = { hashBuffer, hashString, hashFileSync, safeHashFileSync };
