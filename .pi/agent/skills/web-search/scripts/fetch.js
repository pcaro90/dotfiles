#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(SKILL_DIR, ".env");
const API_URL = "https://api.tavily.com/extract";

function readDotEnv(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing config file: ${file}\nCopy .env.example to .env and set TAVILY_API_KEY.`);
  }

  const env = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function usage() {
  console.log(`Usage: fetch.js <url> [url...] [options]

Options:
  --query <text>             Rerank extracted chunks for this intent
  --chunks <num>             Chunks per source when --query is used (1-5, default: 3)
  --depth <depth>            basic | advanced (default: basic)
  --format <format>          markdown | text (default: markdown)
  --timeout <seconds>        Extraction timeout, 1-60 seconds
  --max-chars <num>          Max chars per URL (default: 12000)
  --usage                    Include credit usage when returned

Examples:
  fetch.js https://example.com/article
  fetch.js https://example.com/a https://example.com/b --max-chars 8000
  fetch.js https://example.com/article --query "installation steps" --chunks 3
`);
}

function takeValue(args, index, flag) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index + 1];
}

function parseArgs(argv) {
  const opts = {
    depth: "basic",
    format: "markdown",
    chunks: 3,
    maxChars: 12000,
    includeUsage: false,
  };
  const urls = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--query") {
      opts.query = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--chunks") {
      opts.chunks = parseInt(takeValue(argv, i, arg), 10);
      i++;
    } else if (arg === "--depth") {
      opts.depth = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--format") {
      opts.format = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--timeout") {
      opts.timeout = Number(takeValue(argv, i, arg));
      i++;
    } else if (arg === "--max-chars") {
      opts.maxChars = parseInt(takeValue(argv, i, arg), 10);
      i++;
    } else if (arg === "--usage") {
      opts.includeUsage = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      urls.push(arg);
    }
  }

  if (!urls.length) throw new Error("Missing URL");
  if (urls.length > 20) throw new Error("Tavily Extract accepts at most 20 URLs per request");
  if (!Number.isFinite(opts.chunks) || opts.chunks < 1 || opts.chunks > 5) throw new Error("--chunks must be 1-5");
  if (!Number.isFinite(opts.maxChars) || opts.maxChars < 1) throw new Error("--max-chars must be a positive number");
  if (opts.timeout != null && (!Number.isFinite(opts.timeout) || opts.timeout < 1 || opts.timeout > 60)) {
    throw new Error("--timeout must be between 1 and 60 seconds");
  }
  return { urls, opts };
}

function compact(value, maxChars) {
  if (value == null) return "";
  const text = String(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n[... truncated ${text.length - maxChars} chars ...]`;
}

function errorMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  return data.detail?.error || data.error || data.message || JSON.stringify(data);
}

async function main() {
  const { urls, opts } = parseArgs(process.argv.slice(2));
  const env = readDotEnv(ENV_PATH);
  const provider = (env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
  if (provider !== "tavily") {
    throw new Error(`Unsupported WEB_SEARCH_PROVIDER=${provider}. This skill currently implements provider=tavily.`);
  }
  const apiKey = env.TAVILY_API_KEY;
  if (!apiKey || apiKey.includes("YOUR_API_KEY")) {
    throw new Error(`TAVILY_API_KEY is missing in ${ENV_PATH}`);
  }

  const body = {
    urls: urls.length === 1 ? urls[0] : urls,
    extract_depth: opts.depth,
    format: opts.format,
    include_usage: opts.includeUsage,
  };
  if (opts.query) {
    body.query = opts.query;
    body.chunks_per_source = opts.chunks;
  }
  if (opts.timeout != null) body.timeout = opts.timeout;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70000),
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${errorMessage(data)}`);
  }

  const results = data.results || [];
  if (!results.length) console.log("No content extracted.");

  results.forEach((result, index) => {
    console.log(`--- Page ${index + 1} ---`);
    console.log(`URL: ${result.url || ""}`);
    if (result.favicon) console.log(`Favicon: ${result.favicon}`);
    if (result.images && result.images.length) console.log(`Images: ${result.images.join(", ")}`);
    console.log("Content:");
    console.log(compact(result.raw_content || "", opts.maxChars));
    console.log("");
  });

  const failed = data.failed_results || [];
  failed.forEach((result, index) => {
    console.log(`--- Failed ${index + 1} ---`);
    console.log(`URL: ${result.url || ""}`);
    console.log(`Error: ${result.error || "Unknown error"}`);
    console.log("");
  });

  if (data.response_time != null) console.log(`Response time: ${data.response_time}s`);
  if (data.usage) console.log(`Usage: ${JSON.stringify(data.usage)}`);
  if (data.request_id) console.log(`Request ID: ${data.request_id}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
