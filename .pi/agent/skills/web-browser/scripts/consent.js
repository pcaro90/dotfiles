import { evaluate, attach } from "./shared.js";
import { domSource } from "./dom.js";

/** Conservative exact labels in a consent context, plus narrowly-scoped CMP selectors. */
function consentInPage(accept) {
  const normalize = (value) =>
    (value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.!]+$/, "")
      .trim()
      .toLowerCase();
  const labels = accept
    ? [
        "accept all cookies",
        "accept cookies",
        "accept all",
        "allow all",
        "aceptar todas las cookies",
        "aceptar todas",
        "aceptar todo",
        "aceptar",
        "alle akzeptieren",
        "tout accepter",
        "accepter tout",
        "accetta tutti",
        "aceitar tudo",
      ]
    : [
        "reject all cookies",
        "reject all",
        "reject optional",
        "reject non-essential",
        "only necessary",
        "necessary only",
        "essentials only",
        "rechazar todas las cookies",
        "rechazar todas",
        "rechazar todo",
        "rechazar",
        "solo necesarias",
        "solo las necesarias",
        "alle ablehnen",
        "tout refuser",
        "refuser tout",
        "rifiuta tutti",
        "rejeitar tudo",
      ];
  const cmp = [
    [
      "#onetrust-banner-sdk",
      "#onetrust-accept-btn-handler",
      "#onetrust-reject-all-handler",
    ],
    [
      "#CybotCookiebotDialog",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "#CybotCookiebotDialogBodyButtonDecline",
    ],
    [
      "#didomi-host",
      "#didomi-notice-agree-button",
      "#didomi-notice-disagree-button",
    ],
    [
      "#usercentrics-root",
      "[data-testid=uc-accept-all-button]",
      "[data-testid=uc-deny-all-button]",
    ],
  ];
  const buttons = deepAll(
    "button,a,[role=button],input[type=submit],input[type=button]",
  ).filter((el) => visible(el) && !el.disabled);
  const context = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 7; depth++) {
      if (node === document.body || node === document.documentElement)
        return false;
      const attrs = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute?.("aria-label") || ""}`;
      if (/cookie|consent|gdpr|onetrust|didomi|usercentrics/i.test(attrs))
        return true;
      if (
        node.getAttribute?.("role") === "dialog" &&
        /cookie|consent/i.test(node.textContent || "")
      )
        return true;
      node = node.parentElement || node.getRootNode()?.host;
    }
    return false;
  };
  for (const [rootSelector, yes, no] of cmp) {
    for (const root of deepAll(rootSelector)) {
      const button = deepAll(accept ? yes : no, root).find(
        (el) => visible(el) && !el.disabled,
      );
      if (button) {
        button.click();
        return {
          clicked: normalize(button.innerText || button.value),
          provider: rootSelector,
        };
      }
    }
  }
  const candidates = buttons.filter((el) => {
    const label = normalize(
      el.innerText || el.value || el.getAttribute("aria-label"),
    );
    // A full "... cookies" label is explicit; short labels additionally need a consent container.
    return labels.includes(label) && (context(el) || /cookies/.test(label));
  });
  if (candidates.length !== 1)
    return {
      clicked: "",
      reason: candidates.length
        ? "multiple consent candidates; inspect before clicking"
        : "no conservative consent match",
    };
  const button = candidates[0];
  const label = normalize(
    button.innerText || button.value || button.getAttribute("aria-label"),
  );
  button.click();
  return { clicked: label, provider: "contextual exact match" };
}
export function consentExpression(accept) {
  return `(()=>{${domSource}\nreturn (${consentInPage.toString()})(${Boolean(accept)});})()`;
}
export async function dismissConsent(cdp, sessionId, accept = false) {
  const expression = consentExpression(accept);
  const main = await evaluate(cdp, sessionId, expression);
  if (main.clicked)
    return `consent ${accept ? "accept" : "reject"}: clicked "${main.clicked}" in page (${main.provider})`;
  const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
  const frames = [];
  const visit = (tree) => {
    for (const child of tree.childFrames || []) {
      frames.push(child.frame.id);
      visit(child);
    }
  };
  visit(frameTree);
  let skipped = 0;
  for (const frameId of frames) {
    let frameSession = sessionId;
    try {
      let world;
      try {
        world = await cdp.send(
          "Page.createIsolatedWorld",
          { frameId, worldName: "agent-web-consent" },
          frameSession,
          2000,
        );
      } catch {
        frameSession = await attach(cdp, frameId);
        world = await cdp.send(
          "Page.createIsolatedWorld",
          { frameId, worldName: "agent-web-consent" },
          frameSession,
          2000,
        );
      }
      const result = await cdp.send(
        "Runtime.evaluate",
        {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
        },
        frameSession,
        2000,
      );
      if (result.exceptionDetails) {
        skipped++;
        continue;
      }
      if (result.result?.value?.clicked)
        return `consent ${accept ? "accept" : "reject"}: clicked "${result.result.value.clicked}" in iframe ${frameId}`;
    } catch {
      skipped++;
    }
  }
  return `No consent clicked: ${main.reason}. ${skipped ? `${skipped} inaccessible frame(s) skipped. ` : ""}Inspect read.js --forms or shot.js; do not broaden matching to arbitrary OK/Continue buttons.`;
}
