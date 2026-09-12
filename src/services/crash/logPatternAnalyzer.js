const PATTERNS = [
  {
    id: "PLUGIN_EXCEPTION",
    strength: "VERY_STRONG",
    regex: /(?:unhandled exception|exception thrown|threw an exception).*?\b([A-Za-z][A-Za-z0-9._-]{1,}\.(?:dll|asi))\b/i,
    named: true,
  },
  {
    id: "PLUGIN_EXCEPTION_PREFIX",
    strength: "VERY_STRONG",
    regex: /\b([A-Za-z][A-Za-z0-9._-]{1,}\.(?:dll|asi))\s+(?:threw an exception|unhandled exception|fatal error)/i,
    named: true,
  },
  {
    id: "FATAL_PLUGIN",
    strength: "VERY_STRONG",
    regex: /failed to load plugin[:\s]+\b([A-Za-z][A-Za-z0-9._-]{1,}\.(?:dll|asi))\b/i,
    named: true,
  },
  {
    id: "DLL_LOAD_FAILURE",
    strength: "VERY_STRONG",
    regex: /(?:could not load file or assembly|filenotfoundexception|could not load).*?\b([A-Za-z][A-Za-z0-9._-]{1,}\.(?:dll|asi))\b/i,
    named: true,
  },
  {
    id: "MISSING_DEPENDENCY",
    strength: "STRONG",
    regex: /(?:could not load file or assembly|missing dependency|could not find).{0,40}(LemonUI|RAGENativeUI|iFruitAddon2)[^\r\n]*/i,
    named: true,
  },
  {
    id: "TIMEOUT",
    strength: "MEDIUM",
    regex: /plugin timeout|timed out while loading|PluginTimeoutThreshold/i,
    named: false,
  },
  {
    id: "FATAL_RPH",
    strength: "STRONG",
    regex: /unhandled exception in rage plugin hook|ragepluginhook(?:\.exe)? has crashed/i,
    named: false,
  },
  {
    id: "LSPDFR_INIT_FAILURE",
    strength: "STRONG",
    regex: /failed to load plugin.*lspd first response|lspd first response.*unhandled exception/i,
    named: false,
  },
  {
    id: "GRAPHICS_D3D",
    strength: "STRONG",
    regex: /\[d3d12\]|d3d12|nvcamera|device removed|dxgi_error|overlay injection/i,
    named: false,
  },
  {
    id: "ACCESS_VIOLATION",
    strength: "MEDIUM",
    regex: /access violation|0xc0000005/i,
    named: false,
  },
  {
    id: "FILE_NOT_FOUND",
    strength: "MEDIUM",
    regex: /file not found|filenotfoundexception/i,
    named: false,
  },
  {
    id: "INVALID_CONFIG",
    strength: "MEDIUM",
    regex: /invalid (?:config|configuration|xml)|configuration error/i,
    named: false,
  },
];

function analyzeLogText(text) {
  const blob = String(text || "");
  const matches = [];
  const named = [];
  for (const pattern of PATTERNS) {
    const hit = blob.match(pattern.regex);
    if (!hit) continue;
    const name = pattern.named && hit[1] ? String(hit[1]).trim() : "";
    matches.push({
      id: pattern.id,
      strength: pattern.strength,
      excerpt: hit[0].slice(0, 180),
      name,
    });
    if (name) named.push(name);
  }
  return {
    matches,
    namedModules: [...new Set(named)],
    lastLoaded: lastLoadedPlugin(blob),
  };
}

function lastLoadedPlugin(text) {
  const lines = String(text || "").split(/\r?\n/);
  let last = "";
  for (const line of lines) {
    if (/unhandled exception|fatal error|failed to load plugin|has crashed/i.test(line)) break;
    const loaded = line.match(/Loading plugin from path:.*[\\/]([A-Za-z0-9._-]+\.(?:dll|asi))/i);
    if (loaded) last = loaded[1];
  }
  return last;
}

module.exports = { PATTERNS, analyzeLogText, lastLoadedPlugin };
