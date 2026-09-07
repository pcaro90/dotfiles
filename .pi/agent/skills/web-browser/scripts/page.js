import {
  Cdp,
  attach,
  evaluate,
  listPageTargets,
  selectPageTarget,
  updateState,
  sleep,
  withLock,
} from "./shared.js";
import { applyDevice, readActiveDevice, storeActiveDevice } from "./devices.js";

/** Subscribe before Page.enable/actions. Never implicitly approve a native confirmation. */
export function handleDialogs(cdp, sessionId, policy = "dismiss") {
  const messages = [],
    pending = new Set();
  const off = cdp.on("Page.javascriptDialogOpening", (event, from) => {
    if (from !== sessionId) return;
    messages.push(
      `${event.type} ${policy === "accept" ? "accepted" : "dismissed"}`,
    );
    const work = cdp
      .send(
        "Page.handleJavaScriptDialog",
        { accept: policy === "accept" },
        sessionId,
        3000,
      )
      .catch((error) =>
        messages.push(`dialog handling failed: ${error.message}`),
      )
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  return {
    messages,
    async finish() {
      await Promise.allSettled([...pending]);
      off();
    },
  };
}
export async function withPage(locator, action) {
  return withLock("action", async () => {
    const cdp = await Cdp.open();
    let dialogs;
    try {
      const pages = await listPageTargets(cdp);
      const { target, tab } = selectPageTarget(pages, locator.tab);
      const sessionId = await attach(cdp, target.targetId);
      dialogs = handleDialogs(cdp, sessionId, locator.dialog);
      await cdp.send("Page.enable", {}, sessionId);
      const previous = readActiveDevice(target.targetId);
      const device = locator.device === undefined ? previous : locator.device;
      await applyDevice(cdp, sessionId, device);
      if (!locator.temporary && locator.device !== undefined)
        storeActiveDevice(target.targetId, device);
      updateState((state) => {
        state.activeTargetId = target.targetId;
      });
      try {
        const result = await action({
          cdp,
          sessionId,
          targetId: target.targetId,
          tab,
          url: target.url,
          title: target.title,
          device,
        });
        await dialogs.finish();
        return typeof result === "string" && dialogs.messages.length
          ? `${result}\nnative dialogs: ${dialogs.messages.join("; ")}`
          : result;
      } finally {
        if (locator.temporary && locator.device !== undefined)
          await applyDevice(cdp, sessionId, previous);
      }
    } finally {
      if (dialogs) await dialogs.finish();
      cdp.close();
    }
  });
}

/** Cancellable, session-scoped event subscription. No orphan timeout after a failed action. */
export function readiness(cdp, sessionId, mode, timeoutMs) {
  let cancel = () => {};
  if (mode === "none")
    return { promise: Promise.resolve("not waited"), cancel };
  const event =
    mode === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
  const promise = new Promise((resolve, reject) => {
    const off = cdp.on(event, (_params, from) => {
      if (from === sessionId) {
        cancel();
        resolve(mode);
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for ${mode}; try --wait none --until <selector>.`,
        ),
      );
    }, timeoutMs);
    cancel = () => {
      off();
      clearTimeout(timer);
    };
  });
  promise.catch(() => {});
  return { promise, cancel };
}
export async function waitForSelector(cdp, sessionId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (
        await evaluate(
          cdp,
          sessionId,
          `!!document.querySelector(${JSON.stringify(selector)})`,
          Math.max(1, deadline - Date.now()),
        )
      )
        return;
    } catch (error) {
      if (
        !/context.*(destroyed|not found)|Cannot find context/i.test(
          error.message,
        )
      )
        throw error;
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for selector ${selector}`);
}

/** Wait for this navigation's loader, not an unrelated old load event. Handles hash navigation. */
export async function navigate(cdp, sessionId, options) {
  const deadline = Date.now() + options.timeoutMs;
  await cdp.send(
    "Page.setLifecycleEventsEnabled",
    { enabled: true },
    sessionId,
  );
  const events = new Set();
  const off = cdp.on("Page.lifecycleEvent", (event, from) => {
    if (from === sessionId) events.add(`${event.loaderId}:${event.name}`);
  });
  try {
    const started = Date.now();
    const result = await cdp.send(
      "Page.navigate",
      { url: options.url },
      sessionId,
      Math.max(1, deadline - Date.now()),
    );
    if (result.errorText)
      throw new Error(`Navigation failed: ${result.errorText}`);
    if (result.isDownload)
      throw new Error(
        "Navigation became a download; use direct HTTP or inspect browser download state.",
      );
    const name =
      options.wait === "domcontentloaded" ? "DOMContentLoaded" : "load";
    let waited = options.wait;
    if (options.wait !== "none") {
      if (!result.loaderId) waited = "same-document (no load event)";
      else {
        while (!events.has(`${result.loaderId}:${name}`)) {
          if (Date.now() >= deadline)
            throw new Error(
              `Timed out waiting for ${options.wait}; inspect with read.js or use --wait none --until <selector>.`,
            );
          await sleep(20);
        }
      }
    }
    if (options.until)
      await waitForSelector(
        cdp,
        sessionId,
        options.until,
        Math.max(1, deadline - Date.now()),
      );
    return { waited, navigatedMs: Date.now() - started };
  } finally {
    off();
  }
}
