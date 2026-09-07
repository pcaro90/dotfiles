#!/usr/bin/env node
import {
  cli,
  compact,
  evaluate,
  helpRequested,
  integerOption,
  isMain,
  parseTab,
  privateWrite,
  render,
  safeUrl,
  takeValue,
  wrapJavaScript,
} from "./shared.js";
import { deviceArgs, deviceNote } from "./devices.js";
import { withPage } from "./page.js";
import { domSource } from "./dom.js";

export const usage = `Usage: read.js [--links|--forms|--headings|--html|--expr JS]
  [--selector CSS] [--filter TEXT] [--limit N] [--max-chars N]
  [--show-values] [--out FILE] [--tab NUMBER|TARGET_ID]
  [--device PRESET|none | --viewport WIDTHxHEIGHT[@DPR]]
Default: main text; 80 items, 6000 chars INCLUDING headers/notice.
--out writes the full filtered result (0600), with no content preview.
Password/hidden values are masked unless --show-values. Arbitrary --expr/HTML may contain other secrets.
Selectors can use >>> to enter open shadow roots. Cross-origin frames require explicit CDP inspection.`;
export function parseReadArgs(argv) {
  const parsed = deviceArgs(argv);
  const options = {
    mode: "text",
    limit: 80,
    maxChars: 6000,
    showValues: false,
    device: parsed.device,
  };
  argv = parsed.argv;
  let modeSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (
      ["--links", "--forms", "--headings", "--html", "--expr"].includes(arg)
    ) {
      if (modeSet) throw new Error("Choose one read mode");
      modeSet = true;
      options.mode = arg.slice(2);
      if (arg === "--expr") options.expr = takeValue(argv, i++, arg);
    } else if (["--selector", "--filter", "--out"].includes(arg))
      options[arg.slice(2)] = takeValue(argv, i++, arg);
    else if (arg === "--limit")
      options.limit = integerOption(takeValue(argv, i++, arg), arg, 1, 10000);
    else if (arg === "--max-chars")
      options.maxChars = integerOption(
        takeValue(argv, i++, arg),
        arg,
        128,
        1000000,
      );
    else if (arg === "--tab") options.tab = parseTab(takeValue(argv, i++, arg));
    else if (arg === "--show-values") options.showValues = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.mode === "expr" && (options.selector || options.filter))
    throw new Error("--expr cannot be combined with --selector or --filter");
  return options;
}
function readPage(options) {
  // Helpers are injected by buildScript; this function executes only in the browser.
  const root = options.selector ? one(options.selector) : document;
  const chosen = (selector) => [
    ...(root.matches?.(selector) ? [root] : []),
    ...deepAll(selector, root),
  ];
  const normalize = (text) => (text || "").replace(/\s+/g, " ").trim();
  if (options.mode === "forms")
    return chosen(
      "input,select,textarea,button,[role=button],[role=checkbox],[role=textbox]",
    ).map((el) => {
      const type = (el.type || el.getAttribute("role") || "").toLowerCase();
      const raw = typeof el.value === "string" ? el.value : "";
      const secret = ["password", "hidden"].includes(type);
      return {
        tag: el.tagName.toLowerCase(),
        type,
        name: el.name || "",
        placeholder: el.placeholder || el.getAttribute("aria-label") || "",
        label: normalize(el.labels?.[0]?.innerText),
        value:
          secret && !options.showValues
            ? raw
              ? `••• (${raw.length} chars, not shown)`
              : ""
            : raw,
        ...(typeof el.checked === "boolean" ? { checked: el.checked } : {}),
        disabled: !!el.disabled,
        visible: visible(el),
        text: normalize(el.innerText).slice(0, 120),
        selector: suggest(el),
      };
    });
  if (options.mode === "links")
    return chosen("a[href]")
      .map((el, i) => ({
        n: i + 1,
        text: normalize(el.innerText || el.getAttribute("aria-label")).slice(
          0,
          140,
        ),
        href: el.href,
        selector: suggest(el),
      }))
      .filter((link) => /^https?:/.test(link.href));
  if (options.mode === "headings")
    return chosen("h1,h2,h3,h4,h5,h6")
      .filter(visible)
      .map((el) => ({
        level: Number(el.tagName[1]),
        text: normalize(el.innerText),
        selector: suggest(el),
      }));
  const content =
    root === document
      ? options.mode === "text"
        ? document.querySelector("main,article,[role=main]") || document.body
        : document.body
      : root;
  if (!content) return "";
  if (options.mode === "html") {
    const clone = content.cloneNode(true);
    if (!options.showValues) {
      const secret = 'input[type="password" i],input[type="hidden" i]';
      const sources = [
        ...(content.matches(secret) ? [content] : []),
        ...content.querySelectorAll(secret),
      ];
      const copies = [
        ...(clone.matches(secret) ? [clone] : []),
        ...clone.querySelectorAll(secret),
      ];
      sources.forEach((source, i) =>
        copies[i].setAttribute("value", source.value ? "••• (not shown)" : ""),
      );
    }
    return clone.outerHTML;
  }
  return (content.innerText ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function buildScript(options) {
  if (options.mode === "expr") return wrapJavaScript(options.expr).expression;
  return `(()=>{${domSource}\nreturn (${readPage.toString()})(${JSON.stringify(options)});})()`;
}
export function formatRead(value, options) {
  const list = ["links", "forms", "headings"].includes(options.mode);
  let full, body;
  const matches = (item) =>
    !options.filter ||
    render(item).toLowerCase().includes(options.filter.toLowerCase());
  if (list) {
    const items = value.filter(matches);
    full = items.map(render).join("\n");
    body = items.slice(0, options.limit).map(render).join("\n");
    if (items.length > options.limit)
      body += `\n[${items.length - options.limit} more of ${items.length} items; raise --limit or use --out]`;
  } else {
    full = render(value);
    if (options.filter) full = full.split("\n").filter(matches).join("\n");
    body = full;
  }
  return { full, body: compact(body, options.maxChars) };
}
export async function runRead(options) {
  const result = await withPage(options, async (page) => {
    const value = await evaluate(
      page.cdp,
      page.sessionId,
      buildScript(options),
      30000,
    );
    const { body, full } = formatRead(value, options);
    const header = `tab ${page.tab} · ${safeUrl(page.url)} · ${page.title}\n${deviceNote(page.device)} · mode: ${options.mode}`;
    if (options.out)
      return `${header}\nwrote: ${privateWrite(options.out, full)} (${full.length} chars; no preview)`;
    return `${header}\n\n${body}`;
  });
  return compact(result, options.maxChars);
}
export async function main(argv, maxChars = 6000) {
  if (helpRequested(argv)) return usage;
  return runRead({ ...parseReadArgs(argv), maxChars });
}
if (isMain(import.meta.url)) await cli(main);
