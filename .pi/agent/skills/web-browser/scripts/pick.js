#!/usr/bin/env node
import {
  cli,
  evaluate,
  helpRequested,
  isMain,
  parseTab,
  readSessionState,
  takeValue,
} from "./shared.js";
import { withPage } from "./page.js";
import { domSource } from "./dom.js";
export const usage =
  "Usage: pick.js 'Message for the human' [--tab NUMBER|TARGET_ID] [--max-chars N]\nRequires session.js start --headed and a human at the display. Ctrl/Cmd+click adds, Enter finishes, Escape cancels. Timeout: 5 minutes.";
function picker(message) {
  return new Promise((resolve, reject) => {
    const selections = [],
      outlined = new Map();
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const highlight = document.createElement("div");
    overlay.append(highlight);
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;bottom:20px;left:20px;z-index:2147483647;background:#17212b;color:white;padding:16px;font:14px sans-serif";
    banner.textContent =
      message + " · Ctrl/Cmd+click adds, Enter finishes, Escape cancels";
    document.body.append(overlay, banner);
    const cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      overlay.remove();
      banner.remove();
      for (const [el, old] of outlined) el.style.outline = old;
    };
    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const move = (event) => {
      const el = event.composedPath()[0];
      if (!el?.getBoundingClientRect || el === banner) return;
      const rect = el.getBoundingClientRect();
      highlight.style.cssText = `position:fixed;border:2px solid #399bff;background:#399bff22;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
    };
    const click = (event) => {
      if (event.target === banner) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const el = event.composedPath()[0];
      if (!el || outlined.has(el)) return;
      selections.push({
        tag: el.tagName.toLowerCase(),
        selector: suggest(el),
        text: (el.innerText || "").trim().slice(0, 120),
      });
      if (!(event.ctrlKey || event.metaKey)) {
        finish(selections);
        return;
      }
      outlined.set(el, el.style.outline);
      el.style.outline = "3px solid #10b981";
      banner.textContent = `${selections.length} selected; Enter to finish, Escape to cancel`;
    };
    const key = (event) => {
      if (
        event.key === "Escape" ||
        (event.key === "Enter" && selections.length)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(event.key === "Escape" ? null : selections);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Picker timed out; use read.js --forms for non-interactive inspection",
        ),
      );
    }, 300000);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  });
}
export async function main(argv) {
  if (helpRequested(argv)) return usage;
  let tab;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tab") tab = parseTab(takeValue(argv, i++, "--tab"));
    else if (argv[i].startsWith("--"))
      throw new Error(`Unknown option ${argv[i]}`);
    else words.push(argv[i]);
  }
  if (!words.length) throw new Error(usage);
  if (readSessionState()?.headless !== false)
    throw new Error(
      "Picker requires a headed managed browser and a human. Use read.js --forms, or restart with --headed.",
    );
  return withPage({ tab }, async (page) => {
    const value = await evaluate(
      page.cdp,
      page.sessionId,
      `(()=>{${domSource}\nreturn (${picker.toString()})(${JSON.stringify(words.join(" "))});})()`,
      305000,
    );
    return `tab ${page.tab}\n${JSON.stringify(value)}`;
  });
}
if (isMain(import.meta.url)) await cli(main);
