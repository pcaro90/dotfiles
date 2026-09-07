#!/usr/bin/env node
import {
  Cdp,
  cli,
  evaluate,
  helpRequested,
  isMain,
  listPageTargets,
  normalizeUrl,
  parseTab,
  safeUrl,
  secondsOption,
  takeValue,
  withLock,
} from "./shared.js";
import { deviceArgs, deviceNote } from "./devices.js";
import { navigate, withPage } from "./page.js";
export { navigate } from "./page.js";
export const usage = `Usage: nav.js URL [--new] [--tab NUMBER|TARGET_ID]
  [--wait none|domcontentloaded|load] [--until CSS] [--timeout SECONDS]
  [--device PRESET|none | --viewport WIDTHxHEIGHT[@DPR]] [--max-chars N]
Wait defaults to load, timeout to 30s. --until shares the same total readiness budget.
For SPAs or long-loading pages use --wait none --until <selector>.`;
export function parseNavArgs(argv) {
  const parsed = deviceArgs(argv);
  const options = {
    newTab: false,
    wait: "load",
    timeoutMs: 30000,
    device: parsed.device,
  };
  const urls = [];
  argv = parsed.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--new") options.newTab = true;
    else if (arg === "--tab") options.tab = parseTab(takeValue(argv, i++, arg));
    else if (arg === "--until") options.until = takeValue(argv, i++, arg);
    else if (arg === "--timeout")
      options.timeoutMs = secondsOption(takeValue(argv, i++, arg), arg);
    else if (arg === "--wait") {
      options.wait = takeValue(argv, i++, arg);
      if (!["none", "domcontentloaded", "load"].includes(options.wait))
        throw new Error("--wait must be none, domcontentloaded or load");
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else urls.push(arg);
  }
  if (urls.length !== 1) throw new Error("Exactly one URL is required");
  if (options.newTab && options.tab !== undefined)
    throw new Error("Use --new or --tab, not both");
  options.url = normalizeUrl(urls[0]);
  return options;
}
export async function runNav(options) {
  if (options.newTab) {
    options = {
      ...options,
      tab: await withLock("action", async () => {
        const cdp = await Cdp.open();
        try {
          const { targetId } = await cdp.send("Target.createTarget", {
            url: "about:blank",
          });
          await listPageTargets(cdp);
          return targetId;
        } finally {
          cdp.close();
        }
      }),
    };
  }
  return withPage(options, async (page) => {
    const result = await navigate(page.cdp, page.sessionId, options);
    const state = await evaluate(
      page.cdp,
      page.sessionId,
      "({url:location.href,title:document.title,ready:document.readyState,width:innerWidth})",
    );
    return `tab ${page.tab} · ${safeUrl(state.url)}\ntitle: ${state.title}\nready: ${state.ready} · waited ${result.waited} (${result.navigatedMs}ms)\n${deviceNote(page.device)} · actual CSS width: ${state.width}`;
  });
}
export const main = (argv) =>
  helpRequested(argv) ? usage : runNav(parseNavArgs(argv));
if (isMain(import.meta.url)) await cli(main);
