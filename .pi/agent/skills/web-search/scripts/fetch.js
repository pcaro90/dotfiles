#!/usr/bin/env node
// Extract readable page content, trying Exa, then TinyFish, then Tavily for each URL that fails.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PROVIDERS, loadKeys, requestJson, urlKey } = require("./lib.js");

const USAGE = `Usage: fetch.js <url> [url...]

Fetches up to 20 public URLs as live Markdown. Long pages are truncated in the
output and saved in full to a local file whose path is printed.`;

const MIN_USABLE_CHARS = 300;
const CHALLENGE = /^(#+\s*)?(just a moment|verify you are human|prove your humanity|access denied|attention required|uh oh!)/im;
const OUTPUT_DIR = path.join(os.tmpdir(), "pi-web-fetch");

function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) { console.log(USAGE); process.exit(0); }
  const unknown = argv.find(arg => arg.startsWith("-"));
  if (unknown) throw new Error(`Unknown option: ${unknown}\n\n${USAGE}`);
  const urls = [...new Set(argv)];
  if (!urls.length) throw new Error(`Missing URL\n\n${USAGE}`);
  if (urls.length > 20) throw new Error("At most 20 URLs per call");
  for (const url of urls) {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(`Not an HTTP(S) URL: ${url}`);
  }
  return urls;
}

// Each extractor returns Map<requestedUrl, { text, title } | { error }>.
function collect(urls, results, failures) {
  const byKey = new Map(urls.map(url => [urlKey(url), url]));
  const find = value => (urls.includes(value) ? value : byKey.get(urlKey(value || "")));
  const pages = new Map();
  for (const { url, text, title } of results) {
    const requested = find(url);
    if (requested) pages.set(requested, { text: text || "", title: title || "" });
  }
  for (const { url, error } of failures) {
    const requested = find(url);
    if (requested && !pages.has(requested)) pages.set(requested, { error });
  }
  for (const url of urls) if (!pages.has(url)) pages.set(url, { error: "no content returned" });
  return pages;
}

const extract = {
  async exa(urls, keys) {
    const body = { urls, text: true, maxAgeHours: 0, livecrawlTimeout: 30000 };
    const data = await requestJson("exa", "https://api.exa.ai/contents", body, keys, 45000);
    const failures = (data.statuses || []).filter(s => s.status !== "success")
      .map(s => ({ url: s.id, error: [s.error?.tag, s.error?.httpStatusCode].filter(Boolean).join(" ") || "error" }));
    return collect(urls, data.results.map(r => ({ url: r.id || r.url, text: r.text, title: r.title })), failures);
  },
  async tinyfish(urls, keys) {
    const pages = new Map();
    // TinyFish accepts at most 10 URLs per request.
    const batches = [];
    for (let i = 0; i < urls.length; i += 10) batches.push(urls.slice(i, i + 10));
    await Promise.all(batches.map(async batch => {
      const body = { urls: batch, format: "markdown", ttl: 0, per_url_timeout_ms: 45000 };
      const data = await requestJson("tinyfish", "https://api.fetch.tinyfish.ai", body, keys, 60000);
      const failures = (data.errors || []).map(e => ({ url: e.url, error: [e.error, e.status].filter(Boolean).join(" ") }));
      for (const [url, page] of collect(batch, data.results, failures)) pages.set(url, page);
    }));
    return pages;
  },
  async tavily(urls, keys) {
    const body = { urls, format: "markdown", timeout: 30 };
    const data = await requestJson("tavily", "https://api.tavily.com/extract", body, keys, 40000);
    const results = data.results.map(r => ({ url: r.url, text: r.raw_content, title: r.title }));
    return collect(urls, results, data.failed_results || []);
  },
};

function problem(page) {
  if (page.error) return page.error;
  const text = page.text.trim();
  if (CHALLENGE.test(text.slice(0, 300))) return "bot challenge or error page";
  if (text.length < MIN_USABLE_CHARS) return `only ${text.length} chars`;
  return undefined;
}

function saveFull(url, page) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { hostname, pathname } = new URL(url);
  const slug = `${hostname}${pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80);
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 8);
  const file = path.join(OUTPUT_DIR, `${slug}-${hash}.md`);
  fs.writeFileSync(file, `${page.title ? `# ${page.title}\n\n` : ""}Source: ${url}\n\n${page.text}\n`);
  return file;
}

async function main() {
  const urls = parseArgs(process.argv.slice(2));
  const keys = loadKeys();
  const state = new Map(urls.map(url => [url, { page: undefined, fallback: undefined, errors: [] }]));

  for (const provider of PROVIDERS.filter(p => keys[p])) {
    const todo = urls.filter(url => !state.get(url).page);
    if (!todo.length) break;
    let pages;
    try {
      pages = await extract[provider](todo, keys);
    } catch (error) {
      for (const url of todo) state.get(url).errors.push(error.message);
      continue;
    }
    for (const [url, page] of pages) {
      const entry = state.get(url);
      const issue = problem(page);
      if (!issue) entry.page = { ...page, provider };
      else {
        entry.errors.push(`${provider}: ${issue}`);
        // Keep the longest imperfect text in case no provider does better.
        if (page.text && page.text.trim().length > (entry.fallback?.text.trim().length || 0)) entry.fallback = { ...page, provider };
      }
    }
  }

  const previewChars = urls.length === 1 ? 15000 : 6000;
  const blocks = [];
  let succeeded = 0;
  for (const url of urls) {
    const { page, fallback, errors } = state.get(url);
    const chosen = page || fallback;
    const lines = [`=== ${url}`];
    if (!chosen) {
      lines.push(`Error: no provider could extract this page (${errors.join("; ")})`);
      blocks.push(lines.join("\n"));
      continue;
    }
    succeeded++;
    lines.push(`Provider: ${chosen.provider}`);
    if (!page) lines.push(`Warning: possibly incomplete or not the real page (${errors.join("; ")})`);
    if (chosen.title) lines.push(`Title: ${chosen.title}`);
    const text = chosen.text.trim();
    lines.push("", text.slice(0, previewChars));
    if (text.length > previewChars) {
      lines.push("", `[Truncated: showed ${previewChars} of ${text.length} chars. Full text: ${saveFull(url, chosen)}]`);
    }
    blocks.push(lines.join("\n"));
  }
  console.log(blocks.join("\n\n"));
  if (!succeeded) process.exit(1);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
