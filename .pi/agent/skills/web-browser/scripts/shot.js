#!/usr/bin/env node
import {
  artifactPath,
  cli,
  evaluate,
  helpRequested,
  isMain,
  parseTab,
  privateWrite,
  takeValue,
} from "./shared.js";
import { deviceArgs, deviceNote } from "./devices.js";
import { withPage } from "./page.js";
import { domSource } from "./dom.js";
export const usage = `Usage: shot.js [--full-page | --selector CSS] [--out FILE]
  [--device PRESET|none | --viewport WIDTHxHEIGHT[@DPR]] [--tab NUMBER|TARGET_ID]
  [--max-chars N]
--device/--viewport are temporary for this capture; previous tab preferences are restored.
PNG files use 0600 permissions. Open the printed path with read to inspect the image.
Captures are limited to 40 million device pixels; full-page height to 20000 CSS pixels.`;
export function parseShotArgs(argv) {
  const parsed = deviceArgs(argv);
  argv = parsed.argv;
  const options = { fullPage: false, device: parsed.device };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full-page") options.fullPage = true;
    else if (["--selector", "--out"].includes(arg))
      options[arg.slice(2)] = takeValue(argv, i++, arg);
    else if (arg === "--tab") options.tab = parseTab(takeValue(argv, i++, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.fullPage && options.selector)
    throw new Error("Use --full-page or --selector, not both");
  return options;
}
export function elementClip(box, scroll, page) {
  if (
    ![box.width, box.height, page.width, page.height].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    throw new Error("Screenshot region is hidden, empty, or invalid");
  const x = Math.max(0, scroll.x + box.x),
    y = Math.max(0, scroll.y + box.y);
  const width = Math.min(box.width, page.width - x),
    height = Math.min(box.height, page.height - y);
  if (width <= 0 || height <= 0)
    throw new Error("Screenshot region lies outside the document");
  return { x, y, width, height, scale: 1 };
}
export async function runShot(options) {
  return withPage({ ...options, temporary: true }, async (page) => {
    const { cdp, sessionId } = page;
    const viewport = await evaluate(
      cdp,
      sessionId,
      "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
    );
    let box, scroll;
    if (options.selector) {
      box = await evaluate(
        cdp,
        sessionId,
        `(()=>{${domSource}\nconst el=one(${JSON.stringify(options.selector)}); if(!visible(el))throw new Error("Element is not visible"); el.scrollIntoView({block:"start",behavior:"instant"}); const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
      );
      scroll = await evaluate(cdp, sessionId, "({x:scrollX,y:scrollY})");
    }
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
    const size = metrics.cssContentSize;
    let clip;
    if (box) clip = elementClip(box, scroll, size);
    else if (options.fullPage)
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      };
    const width = clip?.width ?? viewport.width,
      height = clip?.height ?? viewport.height;
    if (
      (options.fullPage && height > 20000) ||
      width * height * viewport.dpr ** 2 > 40000000
    )
      throw new Error(
        "Screenshot would exceed the pixel budget; use --selector or scroll and capture smaller regions",
      );
    const { data } = await cdp.send(
      "Page.captureScreenshot",
      {
        format: "png",
        ...(clip ? { clip } : {}),
        captureBeyondViewport: !!clip,
      },
      sessionId,
      30000,
    );
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG")
      throw new Error("Chrome returned an invalid PNG");
    const file = privateWrite(
      options.out || artifactPath("shot", "png"),
      bytes,
    );
    return `${file}\ntab ${page.tab} · PNG ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)} pixels · ${deviceNote(page.device)}${options.device !== undefined ? " (temporary)" : ""}`;
  });
}
export const main = (argv) =>
  helpRequested(argv) ? usage : runShot(parseShotArgs(argv));
if (isMain(import.meta.url)) await cli(main);
