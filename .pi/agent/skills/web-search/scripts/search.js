#!/usr/bin/env node
// Search Exa, TinyFish and Tavily in parallel and merge the results by reciprocal rank fusion.

const { PROVIDERS, loadKeys, requestJson, cleanUrl, urlKey, hostMatches, oneLine } = require("./lib.js");

const USAGE = `Usage: search.js "query" [options]

Options:
  -n <num>              Results to show (default 10, max 20)
  --domain <domain>     Only results from this domain (repeatable or comma-separated)
  --since <when>        day | week | month | year | YYYY-MM-DD`;

const DAYS = { day: 1, week: 7, month: 30, year: 365 };
// TinyFish snippets are clean search-engine excerpts; Exa highlights are choppier; Tavily's are often page chrome.
const SNIPPET_ORDER = ["tinyfish", "exa", "tavily"];

function parseArgs(argv) {
  const opts = { n: 10, domains: [], since: undefined };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else if (arg === "-n") opts.n = Number(value());
    else if (arg === "--domain") opts.domains.push(...value().split(",").map(d => d.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean));
    else if (arg === "--since") opts.since = value();
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  const query = words.join(" ").trim();
  if (!query) throw new Error(`Missing query\n\n${USAGE}`);
  if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 20) throw new Error("-n must be an integer between 1 and 20");
  if (opts.since && !DAYS[opts.since] && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error("--since must be day, week, month, year or YYYY-MM-DD");
  return { query, opts };
}

function sinceDate(since) {
  return DAYS[since] ? new Date(Date.now() - DAYS[since] * 86400000) : new Date(`${since}T00:00:00Z`);
}

// Each provider returns a list of { url, title, snippet, date } in its own rank order.
const search = {
  async exa(query, opts, keys) {
    const body = { query, type: "fast", numResults: 10, contents: { highlights: { maxCharacters: 400 } } };
    if (opts.domains.length) body.includeDomains = opts.domains;
    if (opts.since) body.startPublishedDate = sinceDate(opts.since).toISOString();
    const data = await requestJson("exa", "https://api.exa.ai/search", body, keys, 20000);
    return data.results.map(r => ({ url: r.url, title: r.title, snippet: (r.highlights || []).join(" … "), date: r.publishedDate }));
  },
  async tinyfish(query, opts, keys) {
    const params = new URLSearchParams({ query });
    if (opts.domains.length) params.set("include_domains", opts.domains.join(","));
    if (DAYS[opts.since]) params.set("recency_minutes", String(DAYS[opts.since] * 1440));
    else if (opts.since) params.set("after_date", opts.since);
    const data = await requestJson("tinyfish", `https://api.search.tinyfish.ai?${params}`, undefined, keys, 20000);
    return data.results.map(r => ({ url: r.url, title: r.title, snippet: r.snippet, date: r.date }));
  },
  async tavily(query, opts, keys) {
    const body = { query, search_depth: "advanced", max_results: 10 };
    if (opts.domains.length) body.include_domains = opts.domains;
    if (DAYS[opts.since]) body.time_range = opts.since;
    else if (opts.since) body.start_date = opts.since;
    const data = await requestJson("tavily", "https://api.tavily.com/search", body, keys, 30000);
    return data.results.map(r => ({ url: r.url, title: r.title, snippet: r.content, date: r.published_date }));
  },
};

// Reciprocal rank fusion: results found by several providers rise; ties keep provider order.
// Lists arrive in PROVIDERS order, so titles and dates come from the first provider that has one.
function merge(lists) {
  const merged = new Map();
  for (const [provider, results] of lists) {
    results.forEach((result, index) => {
      if (!result.url) return;
      const key = urlKey(result.url);
      const entry = merged.get(key) || { ...result, url: cleanUrl(result.url), score: 0, providers: [], snippets: {} };
      entry.score += 1 / (60 + index + 1);
      entry.providers.push(provider);
      if (!entry.date && result.date) entry.date = result.date;
      if (!entry.title && result.title) entry.title = result.title;
      if (result.snippet) entry.snippets[provider] = result.snippet;
      merged.set(key, entry);
    });
  }
  for (const entry of merged.values()) entry.snippet = SNIPPET_ORDER.map(p => entry.snippets[p]).find(Boolean) || "";
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function formatDate(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value || "") ? value.slice(0, 10) : value || "";
}

async function main() {
  const { query, opts } = parseArgs(process.argv.slice(2));
  const keys = loadKeys();
  const providers = PROVIDERS.filter(p => keys[p]);
  const settled = await Promise.allSettled(providers.map(p => search[p](query, opts, keys)));

  const lists = [];
  const notes = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") lists.push([providers[i], outcome.value]);
    else notes.push(`${outcome.reason.message}`);
  });
  if (!lists.length) throw new Error(`All search providers failed:\n${notes.join("\n")}`);

  let results = merge(lists);
  if (opts.domains.length) results = results.filter(r => opts.domains.some(d => hostMatches(r.url, d)));
  results = results.slice(0, opts.n);

  const lines = [`Query: ${query}`];
  for (const note of notes) lines.push(`Note: provider failed (${oneLine(note, 200)})`);
  if (!results.length) lines.push("", "No results found.");
  results.forEach((r, i) => {
    lines.push("", `${i + 1}. ${oneLine(r.title || r.url, 200)}`, `   ${r.url}`);
    lines.push(`   ${[formatDate(r.date), r.providers.join(", ")].filter(Boolean).join(" · ")}`);
    if (r.snippet) lines.push(`   ${oneLine(r.snippet, 300)}`);
  });
  console.log(lines.join("\n"));
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
