/** In-page helpers shared by reads and actions. >>> explicitly enters an open shadow root. */
export function domHelpers() {
  const queryAll = (selector, root = document) => {
    const parts = selector.split(/\s*>>>\s*/);
    let roots = [root];
    for (let i = 0; i < parts.length - 1; i++)
      roots = roots.flatMap((root) =>
        [...root.querySelectorAll(parts[i])]
          .map((node) => node.shadowRoot)
          .filter(Boolean),
      );
    return roots.flatMap((root) => [...root.querySelectorAll(parts.at(-1))]);
  };
  const one = (selector) => {
    const found = queryAll(selector);
    if (found.length !== 1)
      throw new Error(
        found.length
          ? `Ambiguous selector (${found.length} matches): ${selector}. Use read.js --forms for a unique selector.`
          : `No element matches ${selector}. Use read.js --forms or --links.`,
      );
    return found[0];
  };
  const deepAll = (selector, root = document) => {
    const found = [...root.querySelectorAll(selector)];
    if (root.shadowRoot) found.push(...deepAll(selector, root.shadowRoot));
    for (const node of root.querySelectorAll("*"))
      if (node.shadowRoot) found.push(...deepAll(selector, node.shadowRoot));
    return found;
  };
  const suggest = (el) => {
    const root = el.getRootNode();
    const unique = (selector) => {
      try {
        const all = root.querySelectorAll(selector);
        return all.length === 1 && all[0] === el;
      } catch {
        return false;
      }
    };
    let selector;
    if (el.id && unique("#" + CSS.escape(el.id)))
      selector = "#" + CSS.escape(el.id);
    if (!selector && el.name) {
      const candidate =
        el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
      if (unique(candidate)) selector = candidate;
    }
    if (!selector) {
      const parts = [];
      let node = el;
      while (node?.nodeType === 1) {
        const siblings = [...(node.parentNode?.children || [])].filter(
          (other) => other.tagName === node.tagName,
        );
        parts.unshift(
          node.tagName.toLowerCase() +
            (siblings.length > 1
              ? `:nth-of-type(${siblings.indexOf(node) + 1})`
              : ""),
        );
        const candidate = parts.join(" > ");
        if (unique(candidate)) {
          selector = candidate;
          break;
        }
        node = node.parentElement;
      }
    }
    if (!selector) throw new Error("Could not construct a unique selector");
    return root.host ? suggest(root.host) + " >>> " + selector : selector;
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0" &&
      (typeof el.checkVisibility !== "function" ||
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    );
  };
  return { one, queryAll, deepAll, suggest, visible };
}
export const domSource = `const {one, queryAll, deepAll, suggest, visible} = (${domHelpers.toString()})();`;
