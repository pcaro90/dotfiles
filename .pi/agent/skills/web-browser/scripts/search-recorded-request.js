#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RECORD_ROOT = join(homedir(), ".cache", "agent-web", "records");

function printUsage() {
  console.log("Usage: search-recorded-request.js <query> [--file <file>] [--dir <dir>] [--limit <n>] [--json] [--case-sensitive]");
  console.log("");
  console.log("Searches requests recorded by record.js.");
  console.log("");
  console.log("Options:");
  console.log("  --file <file>       Search one JSONL record file");
  console.log("  --dir <dir>         Search JSONL files under a directory");
  console.log("  --limit <n>         Maximum number of matches to print (default: 20)");
  console.log("  --json              Print full matching records as JSONL");
  console.log("  --case-sensitive    Use case-sensitive matching");
  console.log("  --help              Show this help");
  console.log("");
  console.log("Examples:");
  console.log("  search-recorded-request.js login");
  console.log("  search-recorded-request.js password --json");
  console.log("  search-recorded-request.js auth --file /tmp/login-record.jsonl");
}

function parseArgs(argv) {
  const options = {
    query: null,
    file: null,
    dir: RECORD_ROOT,
    limit: 20,
    json: false,
    caseSensitive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path");
      options.file = resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--dir requires a path");
      options.dir = resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a number");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--limit must be a positive integer");
      options.limit = parsed;
      i += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--case-sensitive") {
      options.caseSensitive = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (!options.query) {
      options.query = arg;
      continue;
    }

    options.query += ` ${arg}`;
  }

  if (!options.query) {
    throw new Error("query is required");
  }

  return options;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function findJsonlFiles(dir) {
  if (!existsSync(dir)) return [];

  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(path);
    }
  }

  return results.sort((a, b) => (statSafe(b)?.mtimeMs || 0) - (statSafe(a)?.mtimeMs || 0));
}

function readRecords(filePath) {
  const data = readFileSync(filePath, "utf8");
  const records = [];

  data.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      records.push({ filePath, lineNumber: index + 1, record });
    } catch {
      // Ignore malformed lines so one bad record does not hide useful matches.
    }
  });

  return records;
}

function flattenForSearch(value, prefix = "") {
  const out = [];

  if (value == null) return out;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push({ field: prefix || "value", value: String(value) });
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push(...flattenForSearch(item, `${prefix}[${index}]`));
    });
    return out;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      out.push(...flattenForSearch(child, childPrefix));
    }
  }

  return out;
}

function makeMatcher(query, caseSensitive) {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (value) => {
    const haystack = caseSensitive ? String(value) : String(value).toLowerCase();
    return haystack.includes(needle);
  };
}

function snippet(value, query, caseSensitive, radius = 80) {
  const text = String(value).replace(/\s+/g, " ");
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);

  if (index === -1) {
    return text.length > radius * 2 ? `${text.slice(0, radius * 2)}...` : text;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function summarize(record) {
  const contentType =
    headerValue(record.extraRequestHeaders, "content-type") ||
    headerValue(record.requestHeaders, "content-type") ||
    null;
  const status = record.response?.status ?? record.extraResponseStatusCode ?? "unknown";
  return {
    method: record.method || "?",
    url: record.url || "?",
    status,
    resourceType: record.resourceType || null,
    contentType,
    requestId: record.requestId || null,
  };
}

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("✗", e.message);
    printUsage();
    process.exit(1);
  }
})();

const files = options.file ? [options.file] : findJsonlFiles(options.dir);

if (files.length === 0) {
  console.error(`✗ No record files found in ${options.file || options.dir}`);
  process.exit(1);
}

const matcher = makeMatcher(options.query, options.caseSensitive);
const matches = [];

for (const file of files) {
  if (!existsSync(file)) continue;

  for (const item of readRecords(file)) {
    const fields = flattenForSearch(item.record);
    const matchedFields = fields.filter((field) => matcher(field.value));

    if (matchedFields.length > 0) {
      matches.push({ ...item, matchedFields });
      if (matches.length >= options.limit) break;
    }
  }

  if (matches.length >= options.limit) break;
}

if (options.json) {
  for (const match of matches) {
    console.log(JSON.stringify({
      file: match.filePath,
      line: match.lineNumber,
      matchedFields: match.matchedFields.map((field) => field.field),
      ...match.record,
    }));
  }
  process.exit(0);
}

console.log(`matches: ${matches.length}${matches.length >= options.limit ? ` (limited to ${options.limit})` : ""}`);

matches.forEach((match, index) => {
  const summary = summarize(match.record);
  console.log("");
  console.log(`[${index + 1}] ${summary.method} ${summary.url}`);
  console.log(`    file: ${match.filePath}:${match.lineNumber}`);
  console.log(`    status: ${summary.status}`);
  if (summary.resourceType) console.log(`    resourceType: ${summary.resourceType}`);
  if (summary.contentType) console.log(`    content-type: ${summary.contentType}`);
  if (summary.requestId) console.log(`    requestId: ${summary.requestId}`);
  console.log(`    matched fields: ${match.matchedFields.slice(0, 8).map((field) => field.field).join(", ")}`);

  for (const field of match.matchedFields.slice(0, 5)) {
    console.log(`    ${field.field}: ${snippet(field.value, options.query, options.caseSensitive)}`);
  }

  if (match.matchedFields.length > 5) {
    console.log(`    ... ${match.matchedFields.length - 5} more matched field(s)`);
  }
});

if (matches.length > 0) {
  console.log("");
  console.log("Print full matching records with:");
  const sourceArg = options.file ? `--file ${JSON.stringify(options.file)}` : `--dir ${JSON.stringify(options.dir)}`;
  console.log(`  ./scripts/search-recorded-request.js ${JSON.stringify(options.query)} ${sourceArg} --json`);
}
