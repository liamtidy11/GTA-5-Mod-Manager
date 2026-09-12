const { execFileSync, spawn } = require("child_process");

const OVERLAY_IMAGES = ["NVIDIA Overlay.exe", "NVIDIA Share.exe"];
const ANSEL_GTA = "HKCU\\Software\\NVIDIA Corporation\\Ansel\\Grand Theft Auto V Enhanced";

function processRunning(image) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return new RegExp(image.replace(/\./g, "\\."), "i").test(out);
  } catch {
    return false;
  }
}

function closeGraphicsOverlays() {
  const closed = [];
  for (const image of OVERLAY_IMAGES) {
    try {
      execFileSync("taskkill", ["/IM", image, "/F"], { windowsHide: true, stdio: "ignore" });
      closed.push(image);
    } catch {
      /* not running */
    }
  }
  return closed;
}

function disableAnselForGta() {
  try {
    execFileSync("reg", ["add", ANSEL_GTA, "/v", "FreestyleEnabled", "/t", "REG_SZ", "/d", "False", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    execFileSync("reg", ["add", ANSEL_GTA, "/v", "Enable", "/t", "REG_DWORD", "/d", "0", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function suppressOverlaysDuringHook() {
  const closed = closeGraphicsOverlays();
  disableAnselForGta();
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "$deadline = (Get-Date).AddSeconds(50); while ((Get-Date) -lt $deadline) { Get-Process -Name 'NVIDIA Overlay','NVIDIA Share' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }",
    ],
    { windowsHide: true, detached: true, stdio: "ignore" }
  );
  child.unref();
  return { closed };
}

function overlayStatus() {
  return {
    nvidiaOverlay: processRunning("NVIDIA Overlay.exe"),
    nvidiaShare: processRunning("NVIDIA Share.exe"),
  };
}

module.exports = {
  OVERLAY_IMAGES,
  closeGraphicsOverlays,
  suppressOverlaysDuringHook,
  overlayStatus,
};
