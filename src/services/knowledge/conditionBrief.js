const MAX_INPUT = 7000;

function buildPrompt(analysis = {}) {
  const counts = analysis.counts || {};
  const advice = (analysis.advice || []).join("\n");
  const rows = (analysis.summary || analysis.rows || [])
    .slice(0, 40)
    .map((row) => `${row.status} | ${row.source || ""} | ${row.name || row.installId || "Mod"} | ${(row.reasons || [])[0] || ""}`)
    .join("\n");
  return [
    "Write 4 to 8 short sentences about this GTA V Enhanced Duty folder.",
    "Only use the supplied lamp results. Do not invent mods, files, keys, or downloads.",
    "Never suggest installing into the official Online or Steam folder.",
    "Do not claim you can edit code, browse the web, or act like a general coding agent.",
    `Counts: healthy ${counts.HEALTHY || 0}, attention ${counts.WARNING || 0}, broken ${counts.BROKEN || 0}, disabled ${counts.DISABLED || 0}.`,
    advice,
    rows,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_INPUT);
}

function parseBrief(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:[-*•]|\d{1,2}[.)-])\s*/, "").trim())
    .filter((line) => line.length >= 12 && line.length <= 280)
    .slice(0, 8)
    .join(" ");
}

async function brief({ apiKey, apiUrl, analysis }) {
  const key = String(apiKey || "").trim();
  if (!key) return "";
  const endpoint = String(apiUrl || "").trim() || "https://api.openai.com/v1/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You restate local GTA V Duty mod lamp results in plain English. Never invent facts.",
          },
          { role: "user", content: buildPrompt(analysis) },
        ],
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseBrief(text);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { brief, buildPrompt, parseBrief };
