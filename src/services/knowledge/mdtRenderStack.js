const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fileVersionReader = require("../fileVersionReader");

const EXPECTED_RAWCANVAS = "0.4.3.0";
const UI_LIBS = [
  { name: "RawCanvasUI.dll", expectedVersion: EXPECTED_RAWCANVAS },
  { name: "IPT.Common.dll", expectedVersion: "1.5.0.5" },
  { name: "RAGENativeUI.dll", expectedVersion: null },
  { name: "CalloutInterfaceAPI.dll", expectedVersion: "1.0.3.0" },
];

const SEARCH_RELS = ["", "plugins", path.join("plugins", "LSPDFR")];

const RENDER = {
  INPUT_DETECTED: "MDT_INPUT_DETECTED",
  CANVAS_INITIALIZED: "MDT_CANVAS_INITIALIZED",
  RENDER_ATTEMPTED: "MDT_RENDER_ATTEMPTED",
  RENDER_CONFIRMED: "MDT_RENDER_CONFIRMED",
  RENDER_FAILED: "MDT_RENDER_FAILED",
  UNVERIFIED: "UNVERIFIED",
};

const DRAW_SUCCESS = /RawCanvasUI.{0,80}(?:frame presented|draw complete|rendered successfully)/i;
const QUEUE_FAIL = /D3D12 command queue does not belong to the D3D12 device/i;
const HOOK_FILES = ["dxgi.dll", "d3d11.dll", "d3d12.dll", "ReShade64.dll", "ReShade.ini"];

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function hashFile(abs) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").toUpperCase();
  } catch {
    return "";
  }
}

function relOf(dutyPath, abs) {
  return path.relative(dutyPath, abs).replace(/\\/g, "/");
}

function findCopies(dutyPath, fileName) {
  const duty = String(dutyPath || "");
  const out = [];
  if (!duty) return out;
  for (const folder of SEARCH_RELS) {
    const abs = folder ? path.join(duty, folder, fileName) : path.join(duty, fileName);
    if (!exists(abs)) continue;
    const st = fs.statSync(abs);
    out.push({
      rel: relOf(duty, abs),
      abs,
      size: st.size,
      sha256: hashFile(abs),
    });
  }
  return out;
}

function inventoryUiLibraries(dutyPath, { readVersion } = {}) {
  const reader = readVersion || ((file) => fileVersionReader.readFileVersion(file));
  const libraries = UI_LIBS.map((lib) => {
    const copies = findCopies(dutyPath, lib.name);
    const versions = copies.map((copy) => {
      const meta = reader(copy.abs) || {};
      return {
        ...copy,
        fileVersion: meta.fileVersion || null,
        productVersion: meta.productVersion || null,
      };
    });
    const hashes = new Set(versions.map((row) => row.sha256).filter(Boolean));
    const root = versions.find((row) => row.rel.toLowerCase() === lib.name.toLowerCase()) || versions[0] || null;
    const version = root && (root.fileVersion || root.productVersion);
    return {
      name: lib.name,
      expectedVersion: lib.expectedVersion,
      version: version || null,
      mismatch: Boolean(lib.expectedVersion && version && version !== lib.expectedVersion),
      copies: versions,
      duplicate: versions.length > 1,
      identicalDuplicates: versions.length > 1 && hashes.size === 1,
      loadedRel: root ? root.rel : null,
      loadedSha256: root ? root.sha256 : "",
    };
  });
  return {
    rawCanvas: libraries.find((row) => row.name === "RawCanvasUI.dll"),
    libraries,
  };
}

function hookFilesPresent(dutyPath) {
  const duty = String(dutyPath || "");
  return HOOK_FILES.filter((name) => exists(path.join(duty, name)));
}

function overlaySnapshot(status = {}) {
  const rows = [
    { name: "NVIDIA Overlay", running: Boolean(status.nvidiaOverlay) },
    { name: "NVIDIA Share", running: Boolean(status.nvidiaShare) },
    { name: "Discord", running: Boolean(status.discord) },
    { name: "Steam overlay", running: Boolean(status.steamOverlay) },
    { name: "RTSS", running: Boolean(status.rtss) },
    { name: "MSI Afterburner", running: Boolean(status.afterburner) },
    { name: "Razer Cortex", running: Boolean(status.razerCortex) },
  ];
  return {
    rows,
    anyRunning: rows.some((row) => row.running),
    names: rows.filter((row) => row.running).map((row) => row.name),
  };
}

function parseGraphics(logText) {
  const blob = String(logText || "");
  const rph = (blob.match(/RAGE Plugin Hook v([\d.]+)/i) || [])[1] || "";
  const gta = (blob.match(/Product version:\s*([\d.]+)/i) || [])[1] || "";
  const dx12 = /\[d3d12\]|Initializing D3D11 Renderer|D3D11On12|D3D12 command queue/i.test(blob);
  const queueFail = QUEUE_FAIL.test(blob);
  return {
    rphVersion: rph,
    gtaBuild: gta,
    api: dx12 ? "DX12" : /Initializing Direct3D 11|d3d11\.dll/i.test(blob) ? "DX11" : "UNKNOWN",
    d3d11On12: /D3D11On12|Initializing D3D11 Renderer/i.test(blob),
    queueFail,
    queueError: queueFail ? firstLine(blob, QUEUE_FAIL) : "",
  };
}

function firstLine(text, pattern) {
  const hit = String(text || "")
    .split(/\r?\n/)
    .find((line) => pattern.test(line));
  return hit ? hit.replace(/^\[[^\]]+\]\s*/, "").trim().slice(0, 240) : "";
}

function classifyRender(logText) {
  const blob = String(logText || "");
  const inputDetected = /RawCanvasUI.{0,40}isInteractive to True/i.test(blob);
  const canvasInitialized = /RawCanvasUI.{0,80}canvas updated bounds/i.test(blob);
  const queueFail = QUEUE_FAIL.test(blob);
  const drawOk = DRAW_SUCCESS.test(blob);
  const renderAttempted = canvasInitialized || inputDetected;
  let status = RENDER.UNVERIFIED;
  if (drawOk && !queueFail) status = RENDER.RENDER_CONFIRMED;
  else if (queueFail && (canvasInitialized || inputDetected)) status = RENDER.RENDER_FAILED;
  else if (inputDetected) status = RENDER.INPUT_DETECTED;
  else if (canvasInitialized) status = RENDER.CANVAS_INITIALIZED;
  return {
    input: inputDetected ? "DETECTED" : "UNVERIFIED",
    canvas: canvasInitialized ? "INITIALIZED" : "UNVERIFIED",
    rendering: status === RENDER.RENDER_CONFIRMED ? "WORKING" : status === RENDER.RENDER_FAILED ? "FAILED" : "UNVERIFIED",
    status,
    inputDetected,
    canvasInitialized,
    renderAttempted,
    renderConfirmed: status === RENDER.RENDER_CONFIRMED,
    renderFailed: status === RENDER.RENDER_FAILED,
    lastError: queueFail ? firstLine(blob, QUEUE_FAIL) : "",
  };
}

function suggestedFix({ render, overlays, inventory, hookFiles, verified = null, frameGen = null }) {
  if (verified && verified.verified && frameGen && !frameGen.enabled) {
    return "NONE. Keep FSR3 frame generation off so the MDT stays visible.";
  }
  if (verified && verified.verified && frameGen && frameGen.enabled) {
    return "FSR3 frame generation was turned back on. Turn it off again to keep the MDT visible.";
  }
  if (render && render.renderConfirmed) return "NONE";
  if (overlays && overlays.anyRunning) {
    return "Play LSPDFR already closes NVIDIA Overlay during the hook. Close the other detected overlays for one session, then hold NumPad 6 again.";
  }
  if (hookFiles && hookFiles.length) {
    return `A third-party graphics hook file is in the Duty root (${hookFiles.join(", ")}). Move it out temporarily and relaunch.`;
  }
  if (inventory && inventory.rawCanvas && inventory.rawCanvas.mismatch) {
    return `RawCanvasUI ${inventory.rawCanvas.version} does not match the Callout Interface 1.4.1 expected ${EXPECTED_RAWCANVAS}. Restore the shipped 0.4.3.0 copy.`;
  }
  if (render && render.renderFailed) {
    return "Rage Plugin Hook’s D3D11-on-12 overlay cannot attach the D3D12 command queue to the swap-chain device. FSR3 frame generation is a reversible test only — it is not a proven MDT fix. F8 still works.";
  }
  return "Hold NumPad 6 after going on duty. If the tablet stays blank, the Rage Plugin Hook overlay is not drawing.";
}

function withTemporaryFile(file, nextContents, fn) {
  const abs = String(file || "");
  const existed = exists(abs);
  const backup = existed ? fs.readFileSync(abs) : null;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, nextContents);
    return fn();
  } finally {
    if (existed) fs.writeFileSync(abs, backup);
    else {
      try {
        fs.rmSync(abs, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  EXPECTED_RAWCANVAS,
  UI_LIBS,
  RENDER,
  inventoryUiLibraries,
  findCopies,
  overlaySnapshot,
  hookFilesPresent,
  parseGraphics,
  classifyRender,
  suggestedFix,
  withTemporaryFile,
};
