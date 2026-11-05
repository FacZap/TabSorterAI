// Minimal Messages API client. Plain fetch: the extension has no bundler, so
// the SDK can't be imported. One request, JSON-schema output, parsed result.

const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 60_000;

export class ClaudeError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "auth" | "network" | "api" | "output"
  }
}

function headers(apiKey, betas) {
  const h = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // Requests carry a chrome-extension:// Origin; without this the API
    // rejects them as browser-originated.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (betas.length) h["anthropic-beta"] = betas.join(",");
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Builds the model-specific parts of the body. Haiku 4.5 takes no effort
// setting; the larger models think adaptively by default, so ask for low
// effort (tab sorting is not hard) and leave room for the thinking tokens.
function buildBody({ model, system, user, schema, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };
  const betas = [];
  if (!model.startsWith("claude-haiku")) {
    body.max_tokens = Math.max(maxTokens * 2, 16000);
    body.output_config.effort = "low";
  }
  if (model === "claude-opus-5") {
    // On a safety decline the API retries on a fallback model instead of
    // returning an empty refusal.
    body.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  return { body, betas };
}

export async function callClaude({ apiKey, model, system, user, schema, maxTokens }) {
  if (!apiKey) throw new ClaudeError("No API key set. Add one in Options.", "auth");
  const { body, betas } = buildBody({ model, system, user, schema, maxTokens });

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: headers(apiKey, betas),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new ClaudeError("Claude took longer than 60 s. Try fewer tabs.", "network");
      if (attempt === 0) { await sleep(1000); continue; }
      throw new ClaudeError(`Network error: ${e.message}`, "network");
    }
    clearTimeout(timer);

    if (res.ok) return parseMessage(await res.json());

    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const wait = Number(res.headers.get("retry-after"));
      await sleep((wait > 0 ? Math.min(wait, 20) : 2) * 1000);
      continue;
    }
    let detail = "";
    try { detail = (await res.json()).error?.message ?? ""; } catch { /* not JSON */ }
    if (res.status === 401) throw new ClaudeError("API key rejected (401). Check it in Options.", "auth");
    throw new ClaudeError(`Claude API error ${res.status}${detail ? `: ${detail}` : ""}`, "api");
  }
}

export function parseMessage(msg) {
  if (msg.stop_reason === "refusal") {
    throw new ClaudeError("Claude declined this request.", "output");
  }
  if (msg.stop_reason === "max_tokens") {
    throw new ClaudeError("Claude's answer was cut off. Try fewer tabs.", "output");
  }
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { data: JSON.parse(text), usage: msg.usage, model: msg.model };
  } catch {
    throw new ClaudeError("Claude returned something that isn't valid JSON.", "output");
  }
}

// Cheap key check for the Options page: model lookup costs no tokens.
export async function testKey(apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/models/claude-haiku-4-5", {
    headers: headers(apiKey, []),
  });
  if (res.ok) return true;
  if (res.status === 401) throw new ClaudeError("Key rejected (401).", "auth");
  throw new ClaudeError(`Unexpected response ${res.status}.`, "api");
}
