const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { hashBuffer } = require("../hashUtil");
const { ArchiveError, CODES } = require("./archiveErrors");
const {
  RPF7_MAGIC,
  ENC_AES,
  ENC_NG,
  DIR_MARK,
  SECTOR,
  LIMITS,
  encryptionName,
  isPlainEncryption,
} = require("./rpf7OpenFormat");

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function readCString(names, offset) {
  if (offset < 0 || offset >= names.length) return "";
  let end = offset;
  while (end < names.length && names[end] !== 0) end += 1;
  return names.slice(offset, end).toString("utf8");
}

function sanitizeName(name) {
  const cleaned = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return "";
  if (cleaned.split("/").some((part) => part === ".." || part === ".")) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive entry name is not safe.", { file: cleaned });
  }
  return cleaned;
}

function identifyHeader(header, archivePath) {
  if (!header || header.length < 16) {
    throw new ArchiveError(CODES.INVALID_RPF, "File is too small to be an RPF archive.", { file: archivePath });
  }
  const magic = readU32(header, 0);
  if (magic !== RPF7_MAGIC) {
    if ([0x30465052, 0x32465052, 0x33465052, 0x34465052, 0x36465052, 0x52504638].includes(magic)) {
      throw new ArchiveError(CODES.UNSUPPORTED_RPF_VERSION, "This RPF version is not supported.", {
        file: archivePath,
        details: `magic=0x${magic.toString(16)}`,
      });
    }
    throw new ArchiveError(CODES.INVALID_RPF, "File is not a supported RPF archive.", { file: archivePath });
  }
  const entryCount = readU32(header, 4);
  const namesLength = readU32(header, 8);
  const encryption = readU32(header, 12);
  if (entryCount > LIMITS.maxEntries || namesLength > LIMITS.maxNamesBytes) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive table of contents exceeds safety limits.", {
      file: archivePath,
    });
  }
  if (!isPlainEncryption(encryption)) {
    throw new ArchiveError(
      CODES.ENCRYPTED_RPF_NOT_SUPPORTED,
      "Encrypted GTA archives cannot be read in this build.",
      { file: archivePath, details: encryptionName(encryption) }
    );
  }
  return { magic, entryCount, namesLength, encryption };
}

function parseEntries(entryBytes, names, entryCount) {
  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    const off = i * 16;
    const chunk = entryBytes.subarray(off, off + 16);
    const word1 = readU32(chunk, 4);
    if (word1 === DIR_MARK) {
      entries.push({
        kind: "directory",
        name: sanitizeName(readCString(names, readU32(chunk, 0))),
        entriesIndex: readU32(chunk, 8),
        entriesCount: readU32(chunk, 12),
      });
      continue;
    }
    if ((word1 & 0x80000000) === 0) {
      const nameOffset = chunk.readUInt16LE(0);
      const fileSize = chunk[2] | (chunk[3] << 8) | (chunk[4] << 16);
      const fileOffset = chunk[5] | (chunk[6] << 8) | (chunk[7] << 16);
      entries.push({
        kind: "binary",
        name: sanitizeName(readCString(names, nameOffset)),
        compressedSize: fileSize,
        sector: fileOffset,
        size: readU32(chunk, 8),
        encrypted: readU32(chunk, 12) === 1,
      });
      continue;
    }
    const nameOffset = chunk.readUInt16LE(0);
    const fileSize = chunk[2] | (chunk[3] << 8) | (chunk[4] << 16);
    const fileOffset = (chunk[5] | (chunk[6] << 8) | (chunk[7] << 16)) & 0x7fffff;
    entries.push({
      kind: "resource",
      name: sanitizeName(readCString(names, nameOffset)),
      compressedSize: fileSize === 0xffffff ? 0 : fileSize,
      sector: fileOffset,
      size: fileSize === 0xffffff ? 0 : fileSize,
      encrypted: false,
    });
  }
  return entries;
}

function walkFiles(entries) {
  const files = [];
  const seen = new Set();

  function visit(index, prefix) {
    if (index < 0 || index >= entries.length || seen.has(index)) return;
    seen.add(index);
    const entry = entries[index];
    if (entry.kind === "directory") {
      const start = entry.entriesIndex;
      const end = start + entry.entriesCount;
      for (let i = start; i < end && i < entries.length; i += 1) {
        const child = entries[i];
        const next = child.name ? (prefix ? `${prefix}/${child.name}` : child.name) : prefix;
        if (child.kind === "directory") visit(i, next);
        else files.push({ ...child, path: next || child.name });
      }
      return;
    }
    files.push({ ...entry, path: prefix || entry.name });
  }

  if (entries[0] && entries[0].kind === "directory") visit(0, "");
  else {
    for (const entry of entries) {
      if (entry.kind !== "directory") files.push({ ...entry, path: entry.name });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function openTable(archivePath) {
  const fd = fs.openSync(archivePath, "r");
  try {
    const header = Buffer.alloc(16);
    const got = fs.readSync(fd, header, 0, 16, 0);
    if (got < 16) {
      throw new ArchiveError(CODES.INVALID_RPF, "File is too small to be an RPF archive.", { file: archivePath });
    }
    const ident = identifyHeader(header, archivePath);
    const tocBytes = ident.entryCount * 16;
    const table = Buffer.alloc(tocBytes + ident.namesLength);
    const read = fs.readSync(fd, table, 0, table.length, 16);
    if (read < table.length) {
      throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive table of contents is truncated.", { file: archivePath });
    }
    const entryBytes = table.subarray(0, tocBytes);
    const names = table.subarray(tocBytes);
    const entries = parseEntries(entryBytes, names, ident.entryCount);
    return {
      path: path.resolve(archivePath),
      name: path.basename(archivePath),
      encryption: encryptionName(ident.encryption),
      files: walkFiles(entries),
      size: fs.fstatSync(fd).size,
    };
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive could not be inspected.", {
      file: archivePath,
      details: error && error.message ? error.message : String(error),
    });
  } finally {
    fs.closeSync(fd);
  }
}

function inflateMaybe(bytes, expected) {
  if (expected && expected > LIMITS.maxUncompressed) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Uncompressed entry exceeds safety limits.");
  }
  try {
    return zlib.inflateSync(bytes);
  } catch {
    try {
      return zlib.inflateRawSync(bytes);
    } catch {
      return bytes;
    }
  }
}

function readFileBytes(archivePath, file) {
  if (file.encrypted) {
    throw new ArchiveError(CODES.ENCRYPTED_RPF_NOT_SUPPORTED, "Encrypted archive entries cannot be read in this build.");
  }
  const diskSize = file.compressedSize || file.size;
  if (!diskSize || diskSize > LIMITS.maxReadBytes) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive entry size is missing or exceeds safety limits.", {
      file: file.path,
    });
  }
  const offset = file.sector * SECTOR;
  const fd = fs.openSync(archivePath, "r");
  try {
    const buf = Buffer.alloc(diskSize);
    const got = fs.readSync(fd, buf, 0, diskSize, offset);
    if (got < diskSize) {
      throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive entry is truncated.", { file: file.path });
    }
    if (file.compressedSize && file.size && file.compressedSize !== file.size) {
      const inflated = inflateMaybe(buf, file.size);
      return file.size && inflated.length > file.size ? inflated.subarray(0, file.size) : inflated;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function hashOfFile(archivePath) {
  const fd = fs.openSync(archivePath, "r");
  try {
    const hash = require("crypto").createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    const size = fs.fstatSync(fd).size;
    while (pos < size) {
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!got) break;
      hash.update(buf.subarray(0, got));
      pos += got;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  identifyHeader,
  openTable,
  readFileBytes,
  hashOfFile,
  hashBuffer,
};
