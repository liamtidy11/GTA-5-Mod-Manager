// First-party OPEN/unencrypted RPF7 header constants.
// Format knowledge is public (magic, 16-byte header, 16-byte entries).
// This file does not include encryption keys or third-party source.

const RPF7_MAGIC = 0x52504637;
const ENC_NONE = 0x00000000;
const ENC_OPEN = 0x4e45504f;
const ENC_AES = 0x0ffffff9;
const ENC_NG = 0x0fefffff;
const DIR_MARK = 0x7fffff00;
const SECTOR = 512;

const LIMITS = {
  maxEntries: 200000,
  maxNamesBytes: 8 * 1024 * 1024,
  maxReadBytes: 32 * 1024 * 1024,
  maxUncompressed: 64 * 1024 * 1024,
};

function encryptionName(value) {
  if (value === ENC_NONE) return "NONE";
  if (value === ENC_OPEN) return "OPEN";
  if (value === ENC_AES) return "AES";
  if (value === ENC_NG) return "NG";
  return "UNKNOWN";
}

function isPlainEncryption(value) {
  return value === ENC_NONE || value === ENC_OPEN;
}

module.exports = {
  RPF7_MAGIC,
  ENC_NONE,
  ENC_OPEN,
  ENC_AES,
  ENC_NG,
  DIR_MARK,
  SECTOR,
  LIMITS,
  encryptionName,
  isPlainEncryption,
};
