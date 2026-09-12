const MAX_INPUT = 8000;

function buildPrompt({ name, packSteps, localSteps, webSteps }) {
  const chunks = [
    `Mod: ${name || "Unknown pack"}`,
    "Audience: personal GTA V Enhanced LSPDFR Duty folder only. Never the official Online/Steam folder.",
    packSteps.length ? `From the pack:\n- ${packSteps.join("\n- ")}` : "",
    localSteps.length ? `From local notes:\n- ${localSteps.join("\n- ")}` : "",
    webSteps.length ? `From public pages:\n- ${webSteps.join("\n- ")}` : "",
  ].filter(Boolean);
  return [
    "Summarize how to install this LSPDFR mod as 4 to 8 short steps.",
    "Only use the supplied notes. Do not invent files, keys, or downloads.",
    "Say when a required plugin is missing. Prefer Duty-folder wording.",
    chunks.join("\n\n"),
  ].join("\n\n").slice(0, MAX_INPUT);
}

function parseSteps(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:[-*•]|\d{1,2}[.)-])\s*/, "").trim())
    .filter((line) => line.length >= 8 && line.length <= 280)
    .slice(0, 8);
}

async function summarize({ apiKey, apiUrl, name, packSteps, localSteps, webSteps }) {
  const key = String(apiKey || "").trim();
  if (!key) return [];
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
          { role: "system", content: "You write short LSPDFR install steps. Never suggest modifying GTA Online." },
          { role: "user", content: buildPrompt({ name, packSteps, localSteps, webSteps }) },
        ],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseSteps(text);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { summarize, parseSteps, buildPrompt };
