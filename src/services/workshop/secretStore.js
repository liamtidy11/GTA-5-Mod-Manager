const fs = require("fs");
const path = require("path");

function secretsPath(root) {
  return path.join(root, "secrets.json");
}

function empty() {
  return { schemaVersion: 1, lcpdfrApiKey: null };
}

function loadRaw(root) {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(secretsPath(root), "utf8")) };
  } catch {
    return empty();
  }
}

function saveRaw(root, data) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${secretsPath(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, lcpdfrApiKey: data.lcpdfrApiKey || null }, null, 2)}\n`);
  fs.renameSync(tmp, secretsPath(root));
}

function createSecretStore(root, cipher) {
  const available = () => Boolean(cipher && typeof cipher.encrypt === "function" && typeof cipher.decrypt === "function" && (cipher.available ? cipher.available() : true));

  function setLcpdfrKey(key) {
    if (!available()) {
      const error = new Error("Windows encryption is not available, so the API key was not saved.");
      error.code = "ENCRYPTION_UNAVAILABLE";
      throw error;
    }
    const trimmed = String(key || "").trim();
    if (!trimmed) {
      saveRaw(root, { lcpdfrApiKey: null });
      return { configured: false };
    }
    saveRaw(root, { lcpdfrApiKey: { encoding: "safeStorage", value: cipher.encrypt(trimmed) } });
    return { configured: true };
  }

  function getLcpdfrKey() {
    if (!available()) return "";
    const raw = loadRaw(root).lcpdfrApiKey;
    if (!raw || !raw.value) return "";
    try {
      return String(cipher.decrypt(raw.value) || "");
    } catch {
      return "";
    }
  }

  function configured() {
    const raw = loadRaw(root).lcpdfrApiKey;
    return Boolean(raw && raw.value);
  }

  return { available, setLcpdfrKey, getLcpdfrKey, configured, path: secretsPath(root) };
}

function memoryCipher() {
  return {
    available: () => true,
    encrypt: (value) => Buffer.from(String(value), "utf8").toString("base64"),
    decrypt: (value) => Buffer.from(String(value), "base64").toString("utf8"),
  };
}

module.exports = { createSecretStore, memoryCipher, secretsPath };
