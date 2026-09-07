#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  cacheRoot,
  cli,
  helpRequested,
  integerOption,
  isMain,
  privateWrite,
  safeUrl,
  takeValue,
} from "./shared.js";
export const usage = `Usage: search.js QUERY [--file FILE | --dir DIR] [--limit N]
  [--case-sensitive] [--out FILE] [--max-chars N]
Searches NDJSON trace files retrospectively.
Defaults: trace artifacts below BROWSER_HOME, newest files first, 20 matches.
Only safe summaries are printed; full matches require --out (0600), with no preview.
Malformed lines are counted and skipped. --limit also limits exported matches.`;
function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesBelow(file)
      : entry.isFile() && entry.name.endsWith(".ndjson")
        ? [file]
        : [];
  });
}
export async function main(argv) {
  if (helpRequested(argv)) return usage;
  const options = { limit: 20, caseSensitive: false },
    query = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--file", "--dir", "--out"].includes(arg))
      options[arg.slice(2)] = path.resolve(takeValue(argv, i++, arg));
    else if (arg === "--limit")
      options.limit = integerOption(takeValue(argv, i++, arg), arg, 1, 10000);
    else if (arg === "--case-sensitive") options.caseSensitive = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else query.push(arg);
  }
  if (!query.length) throw new Error("A search query is required");
  if (options.file && options.dir)
    throw new Error("Use --file or --dir, not both");
  const files = options.file
    ? [options.file]
    : (options.dir
        ? filesBelow(options.dir)
        : filesBelow(path.join(cacheRoot(), "artifacts"))
      ).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length)
    throw new Error(
      "No trace files found. Use trace.js first, or --file <existing.ndjson>.",
    );
  const needle = options.caseSensitive
    ? query.join(" ")
    : query.join(" ").toLowerCase();
  const matches = [],
    summaries = [];
  let malformed = 0,
    limited = false;
  for (const file of files) {
    if (options.out === path.resolve(file))
      throw new Error("Search output must not overwrite an input file");
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let number = 0;
    try {
      for await (const line of lines) {
        number++;
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          malformed++;
          continue;
        }
        if (
          !(options.caseSensitive ? line : line.toLowerCase()).includes(needle)
        )
          continue;
        matches.push({ sourceFile: file, sourceLine: number, record: entry });
        summaries.push(
          `${file}:${number} · ${entry.method || entry.kind || entry.type || "record"} ${entry.status ?? entry.response?.status ?? ""} ${entry.url ? safeUrl(entry.url) : "(details not printed)"}`,
        );
        if (matches.length >= options.limit) {
          limited = true;
          break;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (limited) break;
  }
  const out = options.out
    ? privateWrite(
        options.out,
        matches.map((entry) => JSON.stringify(entry)).join("\n") +
          (matches.length ? "\n" : ""),
      )
    : null;
  return `matches: ${matches.length}${limited ? " (limit reached; more may exist)" : ""}; malformed lines skipped: ${malformed}\n${out ? `wrote full matches: ${out} (sensitive; no preview)` : summaries.join("\n")}`;
}
if (isMain(import.meta.url)) await cli(main);
