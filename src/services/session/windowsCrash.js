const { execFileSync } = require("child_process");

function collectWindowsCrash(options = {}) {
  if (options.skip === true) return [];
  if (options.adapter) return options.adapter() || [];
  try {
    const out = execFileSync(
      "wevtutil",
      [
        "qe",
        "Application",
        "/q:*[System[(Level=2) and TimeCreated[timediff(@SystemTime) <= 7200000]]]",
        "/f:text",
        "/c:6",
      ],
      { windowsHide: true, encoding: "utf8", timeout: 2500 }
    );
    return parseWerText(out);
  } catch {
    return [];
  }
}

function parseWerText(text) {
  const blob = String(text || "");
  if (!/GTA5_Enhanced|RagePluginHook|RAGEPluginHook/i.test(blob)) return [];
  const faultingApp = (blob.match(/Faulting application name:\s*([^\r\n,]+)/i) || [])[1] || "";
  const faultingModule = (blob.match(/Faulting module name:\s*([^\r\n,]+)/i) || [])[1] || "";
  const exceptionCode = (blob.match(/Exception code:\s*([^\r\n,]+)/i) || [])[1] || "";
  if (!faultingApp && !exceptionCode) return [];
  return [
    {
      faultingApplication: faultingApp.trim(),
      faultingModule: faultingModule.trim(),
      exceptionCode: exceptionCode.trim(),
    },
  ];
}

module.exports = { collectWindowsCrash, parseWerText };
