---
name: web-search
description: Use when the user asks to search the public web, find current facts or documentation, compare sources, or read/extract content from known URLs using non-interactive HTTP APIs. Prefer this over web-browser for ordinary search, static/public pages, and URL-to-markdown extraction. Do not use for clicking, forms, screenshots, logged-in browser sessions, JavaScript-dependent sites, console inspection, or network debugging.
compatibility: Requires Node.js 18+ with built-in fetch and a configured provider API key.
allowed-tools:
  - bash
---

# Web Search

Use local scripts for web search and URL extraction. The skill is provider-agnostic at the interface level; the current implementation uses Tavily through direct HTTP calls, with no official SDK and no shell environment variables.

Prefer this skill for public web search and non-interactive URL fetching. Use `web-browser` instead when the task needs browser behavior: JavaScript execution, clicks, forms, screenshots, cookies, logged-in browser state, console logs, or network inspection.

## Search workflow

1. Use search when you do not already know the exact URL, when the user asks for current information, or when you need candidate sources before reading pages:

   ```bash
   {baseDir}/scripts/search.js "query" -n 5
   ```

   **Success criteria:** The output contains ranked results with titles, URLs, snippets, and enough source detail to choose follow-up pages.

2. Keep search results small by default. Use `-n 3` to `-n 5` for normal work; use up to `-n 10` only when the user explicitly needs breadth. **Success criteria:** The returned output is concise enough to inspect without overwhelming the model context.

3. Add time, topic, or domain constraints only when useful:

   ```bash
   {baseDir}/scripts/search.js "query" --time-range week
   {baseDir}/scripts/search.js "query" --topic news
   {baseDir}/scripts/search.js "query" --include-domain docs.example.com
   {baseDir}/scripts/search.js "query" --exclude-domain reddit.com
   ```

   **Success criteria:** Constraints match the user's intent and do not accidentally hide relevant sources.

4. Use `--content` only when snippets are insufficient and you need page text inline with the search results:

   ```bash
   {baseDir}/scripts/search.js "query" -n 3 --content --max-chars 4000
   ```

   **Success criteria:** Raw page content is included only for a small result set and is truncated enough to avoid context bloat.

5. Use `--answer` only when a concise generated answer is useful; still cite URLs from the result list rather than relying only on the generated answer:
   ```bash
   {baseDir}/scripts/search.js "query" --answer basic
   ```
   **Success criteria:** Any final answer is grounded in listed URLs, not just the provider-generated summary.

## Fetch workflow

1. Use fetch when you already have a URL and need readable page content:

   ```bash
   {baseDir}/scripts/fetch.js https://example.com/article
   ```

   **Success criteria:** The output contains markdown or text content for the URL, plus failure details if extraction fails.

2. Fetch multiple URLs in one call only when the user asks for comparison or when the pages are short:

   ```bash
   {baseDir}/scripts/fetch.js https://example.com/a https://example.com/b --max-chars 8000
   ```

   **Success criteria:** Each page is clearly separated and the per-page truncation keeps output manageable.

3. Use query-focused extraction when only a specific part of a page matters:

   ```bash
   {baseDir}/scripts/fetch.js https://example.com/docs --query "installation steps" --chunks 3
   ```

   **Success criteria:** The returned chunks are relevant to the requested intent and smaller than a full-page fetch.

4. Use advanced extraction only when basic extraction misses tables, embedded content, or important page sections:
   ```bash
   {baseDir}/scripts/fetch.js https://example.com/page --depth advanced
   ```
   **Success criteria:** The higher-cost extraction is justified by better completeness.

## Command reference

Search:

```bash
{baseDir}/scripts/search.js "query" [options]
```

Common options:

- `-n <num>` — result count, default 5, max 20
- `--content` — include raw page content as markdown
- `--answer [basic|advanced]` — include provider-generated answer
- `--depth <ultra-fast|fast|basic|advanced>` — default `basic`
- `--topic <general|news|finance>` — default `general`
- `--time-range <day|week|month|year|d|w|m|y>` — freshness filter
- `--include-domain <domain>` / `--exclude-domain <domain>` — repeatable or comma-separated
- `--max-chars <num>` — max raw content chars per result, default 5000

Fetch:

```bash
{baseDir}/scripts/fetch.js <url> [url...] [options]
```

Common options:

- `--query <text>` — return chunks relevant to this intent
- `--chunks <num>` — chunks per source with `--query`, default 3, max 5
- `--depth <basic|advanced>` — default `basic`
- `--format <markdown|text>` — default `markdown`
- `--timeout <seconds>` — extraction timeout, 1-60
- `--max-chars <num>` — max chars per URL, default 12000

## Failure handling

- If the scripts report a missing API key, stop and tell the user to configure the skill using the human setup notes in `~/.pi/agent/README.md`; do not ask the user to export shell environment variables.
- If search returns weak results, retry with a richer natural-language query, domain filters, or a narrower time range.
- If fetch returns empty or failed content, try search for another source or retry fetch with `--depth advanced`.
- If the page requires login, browser interaction, or JavaScript-only workflows, use a browser automation skill instead.

**Success criteria:** Failures are handled with the smallest retry that can plausibly fix the problem, without switching tools or providers unnecessarily.
