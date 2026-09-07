#!/usr/bin/env node
import { statSync } from "node:fs";
import path from "node:path";
import {
  cli,
  evaluate,
  helpRequested,
  integerOption,
  isMain,
  parseTab,
  safeUrl,
  secondsOption,
  sleep,
  takeValue,
} from "./shared.js";
import { deviceArgs, deviceNote } from "./devices.js";
import { readiness, withPage } from "./page.js";
import { domSource } from "./dom.js";
import { dismissConsent } from "./consent.js";

export const usage = `Usage: act.js click|hover|type|press|select|check|scroll|upload|consent
  [--target CSS] [--text VALUE] [--key KEY] [--modifiers ctrl,alt,shift,meta]
  [--clear] [--slow] [--delta PIXELS] [--file PATH (repeatable) | --files A,B]
  [--reject | --accept] [--wait none|domcontentloaded|load|MILLISECONDS]
  [--timeout SECONDS] [--dialog dismiss|accept] [--tab NUMBER|TARGET_ID]
  [--device PRESET|none | --viewport WIDTHxHEIGHT[@DPR]] [--max-chars N]
Consent defaults to reject; native dialogs default to dismiss/cancel (never implicit approval).
type inserts text; --clear replaces the field first. --slow sends per-character key events.
scroll without target wheels the viewport; --target alone brings the element into view.
select supports native selects; check supports native checkboxes/radios (true|false).
>>> enters open shadow roots. Hidden file inputs are supported. Read after acting to verify.`;
const actions = [
  "click",
  "hover",
  "type",
  "press",
  "select",
  "check",
  "scroll",
  "upload",
  "consent",
];
export function parseModifiers(value = "") {
  const flags = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  return value
    .split(",")
    .filter(Boolean)
    .reduce((result, flag) => {
      flag = flag.trim().toLowerCase();
      if (!flags[flag]) throw new Error(`Unknown modifier ${flag}`);
      return result | flags[flag];
    }, 0);
}
export function parseActArgs(argv) {
  const parsed = deviceArgs(argv);
  argv = parsed.argv;
  const [action, ...rest] = argv;
  if (!actions.includes(action))
    throw new Error(`Action must be ${actions.join(", ")}`);
  const options = {
    action,
    modifiers: 0,
    files: [],
    slow: false,
    clear: false,
    accept: false,
    wait: "none",
    timeoutMs: 15000,
    dialog: "dismiss",
    device: parsed.device,
  };
  let consentMode;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (["--target", "--text", "--key", "--wait", "--dialog"].includes(arg))
      options[arg.slice(2)] = takeValue(rest, i++, arg);
    else if (arg === "--modifiers")
      options.modifiers = parseModifiers(takeValue(rest, i++, arg));
    else if (arg === "--delta") {
      const value = takeValue(rest, i++, arg);
      if (!/^-?\d+$/.test(value) || Math.abs(Number(value)) > 100000)
        throw new Error(
          "--delta must be an integer between -100000 and 100000",
        );
      options.delta = Number(value);
    } else if (arg === "--file")
      options.files.push(path.resolve(takeValue(rest, i++, arg)));
    else if (arg === "--files")
      options.files.push(
        ...takeValue(rest, i++, arg)
          .split(",")
          .filter(Boolean)
          .map((file) => path.resolve(file.trim())),
      );
    else if (arg === "--slow") options.slow = true;
    else if (arg === "--clear") options.clear = true;
    else if (arg === "--accept" || arg === "--reject") {
      if (consentMode && consentMode !== arg)
        throw new Error("Use --accept or --reject, not both");
      consentMode = arg;
      options.accept = arg === "--accept";
    } else if (arg === "--timeout")
      options.timeoutMs = secondsOption(takeValue(rest, i++, arg), arg);
    else if (arg === "--tab") options.tab = parseTab(takeValue(rest, i++, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.target && !["press", "scroll", "consent"].includes(action))
    throw new Error(`${action} requires --target`);
  if (["type", "select"].includes(action) && options.text === undefined)
    throw new Error(`${action} requires --text`);
  if (
    action === "check" &&
    options.text !== undefined &&
    !["true", "false"].includes(options.text)
  )
    throw new Error("check --text must be true or false");
  if (action === "press" && !options.key)
    throw new Error("press requires --key");
  if (action === "upload" && !options.files.length)
    throw new Error("upload requires --file or --files");
  if (!/^(none|domcontentloaded|load)$/.test(options.wait))
    integerOption(options.wait, "--wait milliseconds", 0, 300000);
  if (!["accept", "dismiss"].includes(options.dialog))
    throw new Error("--dialog must be accept or dismiss");
  return options;
}
const knownKeys = {
  enter: ["Enter", 13, "\r"],
  tab: ["Tab", 9],
  escape: ["Escape", 27],
  esc: ["Escape", 27],
  backspace: ["Backspace", 8],
  delete: ["Delete", 46],
  space: ["Space", 32, " "],
  arrowleft: ["ArrowLeft", 37],
  arrowup: ["ArrowUp", 38],
  arrowright: ["ArrowRight", 39],
  arrowdown: ["ArrowDown", 40],
  home: ["Home", 36],
  end: ["End", 35],
  pageup: ["PageUp", 33],
  pagedown: ["PageDown", 34],
};
export function keyDescriptor(key) {
  const known = knownKeys[key.toLowerCase().replace(/[-_ ]/g, "")];
  if (known)
    return {
      key: known[0] === "Space" ? " " : known[0],
      code: known[0],
      keyCode: known[1],
      ...(known[2] ? { text: known[2] } : {}),
    };
  if ([...key].length !== 1) throw new Error(`Unsupported key: ${key}`);
  const upper = key.toUpperCase();
  return {
    key,
    code: /^[A-Z]$/.test(upper)
      ? `Key${upper}`
      : /^\d$/.test(key)
        ? `Digit${key}`
        : "",
    keyCode: /^[A-Z\d]$/.test(upper) ? upper.charCodeAt(0) : 0,
    text: key,
  };
}
export async function sendKey(session, descriptor, modifiers = 0) {
  const params = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    modifiers,
  };
  await session.cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      ...params,
      ...(descriptor.text && !(modifiers & 7) ? { text: descriptor.text } : {}),
    },
    session.sessionId,
  );
  await session.cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...params },
    session.sessionId,
  );
}
function located(selector, requireHit) {
  const el = one(selector);
  el.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
  if (!visible(el))
    throw new Error(
      "Element is not visible; inspect a screenshot or its visible label",
    );
  if (el.disabled || el.getAttribute("aria-disabled") === "true")
    throw new Error("Element is disabled");
  const box = el.getBoundingClientRect();
  const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
  const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
  if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight)
    throw new Error("Element is outside the viewport after scrolling");
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
  }
  let contained = hit;
  while (contained && contained !== el)
    contained = contained.parentElement || contained.getRootNode()?.host;
  if (requireHit && !contained)
    throw new Error(
      "Element is covered by another element; dismiss the overlay or inspect a screenshot",
    );
  const editable =
    !el.readOnly &&
    (el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" &&
        ![
          "button",
          "submit",
          "reset",
          "checkbox",
          "radio",
          "file",
          "image",
          "hidden",
          "range",
          "color",
        ].includes(el.type)));
  return {
    x,
    y,
    tag: el.tagName.toLowerCase(),
    editable,
    checked: typeof el.checked === "boolean" ? el.checked : null,
    type: el.type || "",
  };
}
const inPage = (session, source) =>
  evaluate(session.cdp, session.sessionId, `(()=>{${domSource}\n${source}})()`);
async function mouse(session, point, modifiers, hover = false) {
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y, modifiers },
    session.sessionId,
  );
  if (hover) return;
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers,
    },
    session.sessionId,
  );
  await session.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers,
    },
    session.sessionId,
  );
}
export async function perform(session, options) {
  const selector = JSON.stringify(options.target);
  if (options.action === "consent")
    return dismissConsent(session.cdp, session.sessionId, options.accept);
  if (options.action === "upload") {
    for (const file of options.files) {
      try {
        if (!statSync(file).isFile()) throw new Error();
      } catch {
        throw new Error(
          `Upload file does not exist or is not a regular file: ${file}`,
        );
      }
    }
    const result = await session.cdp.send(
      "Runtime.evaluate",
      {
        expression: `(()=>{${domSource}\nconst el=one(${selector}); if(el.type!=="file")throw new Error("Target is not a file input"); return el;})()`,
        returnByValue: false,
      },
      session.sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          "Cannot locate file input",
      );
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error("Could not resolve file input");
    try {
      await session.cdp.send(
        "DOM.setFileInputFiles",
        { files: options.files, objectId },
        session.sessionId,
      );
    } finally {
      await session.cdp
        .send("Runtime.releaseObject", { objectId }, session.sessionId)
        .catch(() => {});
    }
    const count = await inPage(
      session,
      `return one(${selector}).files.length;`,
    );
    if (count !== options.files.length)
      throw new Error(`Upload verification failed: ${count} files attached`);
    return `attached ${count} file(s)`;
  }
  if (options.action === "press" && !options.target) {
    await sendKey(session, keyDescriptor(options.key), options.modifiers);
    return `pressed ${options.key}`;
  }
  let box;
  if (options.target)
    box = await inPage(
      session,
      `return (${located.toString()})(${selector},${!["scroll", "press", "select"].includes(options.action)});`,
    );
  if (options.action === "scroll") {
    if (options.target && options.delta === undefined)
      return "scrolled target into view";
    const point =
      box ||
      (await evaluate(
        session.cdp,
        session.sessionId,
        "({x:innerWidth/2,y:innerHeight/2})",
      ));
    await session.cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: 0,
        deltaY: options.delta ?? 600,
      },
      session.sessionId,
    );
    await sleep(150);
    return `scrolled by ${options.delta ?? 600}px`;
  }
  if (options.action === "click" || options.action === "hover") {
    await mouse(session, box, options.modifiers, options.action === "hover");
    return `${options.action} on ${box.tag}`;
  }
  if (options.action === "check") {
    if (!["checkbox", "radio"].includes(box.type))
      throw new Error("check requires a native checkbox/radio");
    const wanted = options.text !== "false";
    if (box.checked === wanted)
      return `already ${wanted ? "checked" : "unchecked"}`;
    if (box.type === "radio" && !wanted)
      throw new Error(
        "Uncheck a radio by selecting another radio in its group",
      );
    await mouse(session, box, options.modifiers);
    const actual = await inPage(session, `return one(${selector}).checked;`);
    if (actual !== wanted)
      throw new Error("Checkbox did not reach the requested state");
    return wanted ? "checked" : "unchecked";
  }
  if (options.action === "press") {
    await inPage(session, `one(${selector}).focus();`);
    await sendKey(session, keyDescriptor(options.key), options.modifiers);
    return `pressed ${options.key} in ${box.tag}`;
  }
  if (options.action === "type") {
    if (!box.editable)
      throw new Error(
        "type requires an editable input, textarea or contenteditable element; use press for custom keyboard interactions",
      );
    await mouse(session, box, 0);
    if (options.clear) {
      await sendKey(
        session,
        keyDescriptor("a"),
        process.platform === "darwin" ? 4 : 2,
      );
      await sendKey(session, keyDescriptor("Backspace"));
    }
    if (options.slow) {
      for (const character of options.text)
        await sendKey(session, keyDescriptor(character));
    } else
      await session.cdp.send(
        "Input.insertText",
        { text: options.text },
        session.sessionId,
      );
    return `typed ${[...options.text].length} character(s)${options.clear ? " (replaced)" : " (inserted)"}; verify with read.js --forms`;
  }
  if (options.action === "select") {
    const value = await inPage(
      session,
      `const el=one(${selector});
      if(el.tagName!=="SELECT") throw new Error("select requires a native select; use type for inputs");
      const wanted=${JSON.stringify(options.text)};
      const matches=[...el.options].filter(o=>o.value===wanted || o.textContent.trim()===wanted);
      if(matches.length!==1)throw new Error("Option missing or ambiguous; use its exact value");
      if(matches[0].disabled)throw new Error("Option is disabled");
      el.value=matches[0].value; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
      return el.value===matches[0].value;`,
    );
    if (!value) throw new Error("Selected value did not persist");
    return "selected option; verify with read.js --forms";
  }
}
export async function runAct(options) {
  return withPage(options, async (page) => {
    const mode = /^\d+$/.test(options.wait) ? "none" : options.wait;
    const waiter = readiness(page.cdp, page.sessionId, mode, options.timeoutMs);
    try {
      const result = await perform(page, options);
      await waiter.promise;
      if (/^\d+$/.test(options.wait)) await sleep(Number(options.wait));
      const state = await evaluate(
        page.cdp,
        page.sessionId,
        "({url:location.href,title:document.title})",
      );
      return `tab ${page.tab} · ${deviceNote(page.device)}\n${result}\nnow: ${safeUrl(state.url)} · ${state.title}`;
    } finally {
      waiter.cancel();
    }
  });
}
export const main = (argv) =>
  helpRequested(argv) ? usage : runAct(parseActArgs(argv));
if (isMain(import.meta.url)) await cli(main);
