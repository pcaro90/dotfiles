#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(SKILL_DIR, ".env");
const API_URL = "https://api.tavily.com/search";

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
  console.log(`Usage: search.js <query> [options]

Options:
  -n <num>                    Number of results (default: 5, max: 20)
  --content                   Include raw page content as markdown
  --answer [basic|advanced]   Include a generated answer (default: basic)
  --depth <depth>             ultra-fast | fast | basic | advanced (default: basic)
  --topic <topic>             general | news | finance (default: general)
  --time-range <range>        day | week | month | year | d | w | m | y
  --start-date <YYYY-MM-DD>   Return results after this date
  --end-date <YYYY-MM-DD>     Return results before this date
  --include-domain <domain>   Restrict to domain (repeatable or comma-separated)
  --exclude-domain <domain>   Exclude domain (repeatable or comma-separated)
  --country <country>         Boost results from country, e.g. spain
  --max-chars <num>           Max raw content chars per result (default: 5000)
  --usage                     Include credit usage when returned

Examples:
  search.js "rust async best practices" -n 5
  search.js "latest TypeScript release" --time-range week
  search.js "React server components" --content -n 3
`);
}

function takeValue(args, index, flag) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index + 1];
}

function addDomains(target, value) {
  for (const part of value.split(",")) {
    const domain = part.trim();
    if (domain) target.push(domain);
  }
}

function parseArgs(argv) {
  const opts = {
    maxResults: 5,
    depth: "basic",
    topic: "general",
    includeRawContent: false,
    includeAnswer: false,
    includeDomains: [],
    excludeDomains: [],
    maxChars: 5000,
    includeUsage: false,
  };
  const queryParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "-n") {
      opts.maxResults = parseInt(takeValue(argv, i, arg), 10);
      i++;
    } else if (arg === "--content") {
      opts.includeRawContent = true;
    } else if (arg === "--answer") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        opts.includeAnswer = next;
        i++;
      } else {
        opts.includeAnswer = "basic";
      }
    } else if (arg === "--depth") {
      opts.depth = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--topic") {
      opts.topic = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--time-range") {
      opts.timeRange = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--start-date") {
      opts.startDate = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--end-date") {
      opts.endDate = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--include-domain") {
      addDomains(opts.includeDomains, takeValue(argv, i, arg));
      i++;
    } else if (arg === "--exclude-domain") {
      addDomains(opts.excludeDomains, takeValue(argv, i, arg));
      i++;
    } else if (arg === "--country") {
      opts.country = takeValue(argv, i, arg);
      i++;
    } else if (arg === "--max-chars") {
      opts.maxChars = parseInt(takeValue(argv, i, arg), 10);
      i++;
    } else if (arg === "--usage") {
      opts.includeUsage = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("Missing query");
  if (!Number.isFinite(opts.maxResults)) throw new Error("-n must be a number");
  opts.maxResults = Math.max(1, Math.min(opts.maxResults, 20));
  if (!Number.isFinite(opts.maxChars) || opts.maxChars < 1) throw new Error("--max-chars must be a positive number");
  return { query, opts };
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
  const { query, opts } = parseArgs(process.argv.slice(2));
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
    query,
    search_depth: opts.depth,
    topic: opts.topic,
    max_results: opts.maxResults,
    include_answer: opts.includeAnswer,
    include_raw_content: opts.includeRawContent ? "markdown" : false,
    include_usage: opts.includeUsage,
  };
  if (opts.timeRange) body.time_range = opts.timeRange;
  if (opts.startDate) body.start_date = opts.startDate;
  if (opts.endDate) body.end_date = opts.endDate;
  if (opts.includeDomains.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains.length) body.exclude_domains = opts.excludeDomains;
  if (opts.country) body.country = opts.country;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${errorMessage(data)}`);
  }

  console.log(`Query: ${data.query || query}`);
  if (data.answer) console.log(`\nAnswer:\n${compact(data.answer, opts.maxChars)}\n`);

  const results = data.results || [];
  if (!results.length) {
    console.log("No results found.");
  }

  results.forEach((result, index) => {
    console.log(`--- Result ${index + 1} ---`);
    console.log(`Title: ${result.title || ""}`);
    console.log(`URL: ${result.url || ""}`);
    if (typeof result.score === "number") console.log(`Score: ${result.score}`);
    if (result.content) console.log(`Snippet: ${compact(result.content, 1500)}`);
    if (result.raw_content) console.log(`Content:\n${compact(result.raw_content, opts.maxChars)}`);
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
