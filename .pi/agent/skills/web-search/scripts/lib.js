// Shared helpers for search.js and fetch.js: configuration, provider HTTP calls and URL handling.

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const PROVIDERS = ["exa", "tinyfish", "tavily"];
const ENV_NAMES = { exa: "EXA_API_KEY", tinyfish: "TINYFISH_API_KEY", tavily: "TAVILY_API_KEY" };

function loadKeys() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Missing config file: ${ENV_PATH}. Copy .env.example to .env and set at least one API key.`);
  }
  const env = {};
  for (const raw of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  const keys = {};
  for (const provider of PROVIDERS) {
    const value = env[ENV_NAMES[provider]];
    if (value && !value.includes("YOUR_API_KEY")) keys[provider] = value;
  }
  if (!Object.keys(keys).length) throw new Error(`No API key configured in ${ENV_PATH} (EXA_API_KEY, TINYFISH_API_KEY, TAVILY_API_KEY).`);
  return keys;
}

function redact(text, keys) {
  for (const key of Object.values(keys)) if (key) text = text.split(key).join("[redacted]");
  return text;
}

// POST when a body is given, GET otherwise. Throws with a short, key-free message.
async function requestJson(provider, url, body, keys, timeoutMs) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (provider === "tavily") headers.Authorization = `Bearer ${keys.tavily}`;
  else headers["X-API-Key"] = keys[provider];
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !Array.isArray(data.results)) throw new Error("Unexpected response shape");
    return data;
  } catch (error) {
    throw new Error(`${provider}: ${redact(error.message, keys)}`);
  }
}

const TRACKING = /^(utm_.*|fbclid|gclid|srsltid|tl)$/i;

// Remove fragments and tracking/translation parameters; keep everything meaningful.
function cleanUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return value;
  }
}

// Key used only for deduplication.
function urlKey(value) {
  try {
    const url = new URL(cleanUrl(value));
    const host = url.hostname.toLowerCase().replace(/^(www|old)\./, "");
    return `${host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return value;
  }
}

function hostMatches(value, domain) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function oneLine(text, max) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trim()}…` : flat;
}

module.exports = { PROVIDERS, loadKeys, requestJson, cleanUrl, urlKey, hostMatches, oneLine };
