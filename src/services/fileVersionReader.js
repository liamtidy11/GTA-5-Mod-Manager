const fs = require("fs");
const path = require("path");

// Reads Windows PE version resources without executing or LoadLibrary-ing the
// target. Only the PE headers + the RT_VERSION resource bytes are read.
// Tests inject a mock via setAdapter().

const VERSION_CACHE = new Map();
const MAX_VERSION_BLOB = 256 * 1024;

let adapter = null;

function setAdapter(fn) {
  adapter = typeof fn === "function" ? fn : null;
}

function resetAdapter() {
  adapter = null;
}

function clearCache() {
  VERSION_CACHE.clear();
}

function cacheKey(filePath, stat) {
  return `${path.resolve(filePath).toLowerCase()}|${stat.size}|${Number(stat.mtimeMs)}`;
}

function empty(reason) {
  return {
    fileVersion: null,
    productVersion: null,
    productName: null,
    companyName: null,
    reason: reason || "NONE",
  };
}

function readU16(buf, off) {
  if (off + 2 > buf.length) return 0;
  return buf.readUInt16LE(off);
}

function readU32(buf, off) {
  if (off + 4 > buf.length) return 0;
  return buf.readUInt32LE(off);
}

function readExact(fd, offset, size) {
  if (size <= 0 || size > 8 * 1024 * 1024) return null;
  const buf = Buffer.alloc(size);
  const n = fs.readSync(fd, buf, 0, size, offset);
  return n === size ? buf : buf.subarray(0, n);
}

function rvaToOffset(sections, rva) {
  for (const sec of sections) {
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + Math.max(sec.virtualSize, sec.sizeOfRawData)) {
      return sec.pointerToRawData + (rva - sec.virtualAddress);
    }
  }
  return null;
}

function parseSections(header, sectionTableOff, numSections) {
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const off = sectionTableOff + i * 40;
    if (off + 40 > header.length) break;
    sections.push({
      virtualSize: readU32(header, off + 8),
      virtualAddress: readU32(header, off + 12),
      sizeOfRawData: readU32(header, off + 16),
      pointerToRawData: readU32(header, off + 20),
    });
  }
  return sections;
}

function walkVersionRva(rsrc, rvaBase, offset, depth) {
  if (depth > 4 || offset + 16 > rsrc.length) return null;
  const named = readU16(rsrc, offset + 12);
  const ids = readU16(rsrc, offset + 14);
  const count = named + ids;
  let found = null;
  for (let i = 0; i < count; i += 1) {
    const entryOff = offset + 16 + i * 8;
    if (entryOff + 8 > rsrc.length) break;
    const name = readU32(rsrc, entryOff);
    const data = readU32(rsrc, entryOff + 4);
    const wantType = depth === 0;
    if (wantType && (name & 0x80000000) === 0 && name !== 16) continue;
    if (data & 0x80000000) {
      found = walkVersionRva(rsrc, rvaBase, data & 0x7fffffff, depth + 1);
    } else if (data + 8 <= rsrc.length) {
      found = { dataRva: readU32(rsrc, data), size: readU32(rsrc, data + 4) };
    }
    if (found) return found;
  }
  return found;
}

function pad32(off) {
  return (off + 3) & ~3;
}

function readWideZ(buf, off) {
  let end = off;
  while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  return { text: buf.toString("utf16le", off, end), next: pad32(end + 2) };
}

function fourPart(ms, ls) {
  return `${(ms >>> 16) & 0xffff}.${ms & 0xffff}.${(ls >>> 16) & 0xffff}.${ls & 0xffff}`;
}

function parseVersionBlob(blob) {
  if (!blob || blob.length < 40) return empty("UNSUPPORTED_VERSION_RESOURCE");
  const key = readWideZ(blob, 6);
  if (!/VS_VERSION_INFO/i.test(key.text)) return empty("UNSUPPORTED_VERSION_RESOURCE");

  let off = pad32(key.next);
  const valueLength = readU16(blob, 2);
  let fileVersion = null;
  let productVersion = null;
  if (valueLength >= 52 && off + 52 <= blob.length && readU32(blob, off) === 0xfeef04bd) {
    fileVersion = fourPart(readU32(blob, off + 8), readU32(blob, off + 12));
    productVersion = fourPart(readU32(blob, off + 16), readU32(blob, off + 20));
    off = pad32(off + valueLength);
  }

  const strings = {};
  const scanStrings = (start, length) => {
    const end = Math.min(blob.length, start + length);
    let i = start;
    while (i + 6 < end) {
      const wLength = readU16(blob, i);
      const wValueLength = readU16(blob, i + 2);
      const wType = readU16(blob, i + 4);
      if (wLength < 6) break;
      const name = readWideZ(blob, i + 6);
      let value = "";
      if (wType === 1 && wValueLength > 0) {
        const bytes = Math.min(wValueLength * 2, end - name.next);
        value = blob.toString("utf16le", name.next, name.next + bytes).replace(/\0+$/, "");
      }
      if (name.text) strings[name.text] = value;
      const next = i + wLength;
      if (next <= i) break;
      i = pad32(next);
    }
  };

  // Remaining children are StringFileInfo / VarFileInfo.
  while (off + 6 < blob.length) {
    const wLength = readU16(blob, off);
    if (wLength < 6) break;
    const childKey = readWideZ(blob, off + 6);
    if (/StringFileInfo/i.test(childKey.text)) {
      scanStrings(pad32(childKey.next), wLength - (pad32(childKey.next) - off));
    }
    const next = off + wLength;
    if (next <= off) break;
    off = pad32(next);
  }

  return {
    fileVersion: strings.FileVersion || fileVersion,
    productVersion: strings.ProductVersion || productVersion,
    productName: strings.ProductName || null,
    companyName: strings.CompanyName || null,
    reason: strings.FileVersion || fileVersion || productVersion ? "OK" : "NO_VERSION",
  };
}

function readPeVersion(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const header = readExact(fd, 0, 4096);
    if (!header || header.length < 64 || header.toString("ascii", 0, 2) !== "MZ") {
      return empty("NOT_PE");
    }
    const eLfanew = readU32(header, 0x3c);
    if (eLfanew + 24 > header.length) return empty("MALFORMED_PE");
    if (header.toString("ascii", eLfanew, eLfanew + 4) !== "PE\0\0") return empty("MALFORMED_PE");

    const coff = eLfanew + 4;
    const numSections = readU16(header, coff + 2);
    const optSize = readU16(header, coff + 16);
    const opt = coff + 20;
    const magic = readU16(header, opt);
    const dataDirOff = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
    if (dataDirOff < 0) return empty("MALFORMED_PE");
    const rsrcRva = readU32(header, dataDirOff + 16);
    const rsrcSize = readU32(header, dataDirOff + 20);
    if (!rsrcRva || !rsrcSize) return empty("NO_VERSION");

    const sectionTable = opt + optSize;
    const need = sectionTable + numSections * 40;
    const fullHeader = need <= header.length ? header : readExact(fd, 0, need);
    if (!fullHeader) return empty("MALFORMED_PE");
    const sections = parseSections(fullHeader, sectionTable, numSections);
    const rsrcOff = rvaToOffset(sections, rsrcRva);
    if (rsrcOff == null) return empty("MALFORMED_PE");

    const rsrc = readExact(fd, rsrcOff, Math.min(rsrcSize, 1024 * 1024));
    if (!rsrc) return empty("MALFORMED_PE");
    const loc = walkVersionRva(rsrc, rsrcRva, 0, 0);
    if (!loc || !loc.size) return empty("NO_VERSION");
    const blobOff = rvaToOffset(sections, loc.dataRva);
    if (blobOff == null) return empty("MALFORMED_PE");
    const blob = readExact(fd, blobOff, Math.min(loc.size, MAX_VERSION_BLOB));
    return parseVersionBlob(blob);
  } catch (error) {
    const code = error && error.code;
    if (code === "EACCES" || code === "EPERM") return empty("ACCESS_DENIED");
    if (code === "EBUSY" || code === "EAGAIN") return empty("LOCKED");
    if (code === "ENOENT") return empty("MISSING");
    return empty("MALFORMED_PE");
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readFileVersion(filePath) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (adapter) {
      try {
        return adapter(filePath) || empty("NONE");
      } catch {
        return empty("ADAPTER_ERROR");
      }
    }
    return empty(error && error.code === "ENOENT" ? "MISSING" : "ACCESS_DENIED");
  }

  const key = cacheKey(filePath, stat);
  if (VERSION_CACHE.has(key)) {
    return { ...VERSION_CACHE.get(key), cached: true };
  }

  let result;
  if (adapter) {
    try {
      result = adapter(filePath) || empty("NONE");
    } catch {
      result = empty("ADAPTER_ERROR");
    }
  } else {
    result = readPeVersion(filePath);
  }
  VERSION_CACHE.set(key, result);
  return { ...result, cached: false };
}

module.exports = {
  readFileVersion,
  setAdapter,
  resetAdapter,
  clearCache,
  parseVersionBlob,
};
