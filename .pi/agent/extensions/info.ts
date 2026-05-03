/**
 * Info Extension
 *
 * Provides a `/info` command that displays a summary of the current Pi session:
 *   - All registered tools (active / inactive)
 *   - All available skills
 *   - All prompt templates
 *   - Context files loaded into the prompt (AGENTS.md, etc.)
 *   - Session metadata (CWD, entries count, session file)
 *
 * Press "f" to toggle full mode (system prompt + not-found context files).
 */

import type {
  ExtensionAPI,
  ToolInfo,
  SlashCommandInfo,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  Key,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function discoverContextFiles(
  cwd: string,
  homeDir: string,
): Array<{ path: string; exists: boolean }> {
  const files: Array<{ path: string; exists: boolean }> = [];
  const seen = new Set<string>();

  const add = (path: string) => {
    if (!path) return;
    const resolved = path.startsWith("/")
      ? path
      : path.startsWith("~/")
        ? `${homeDir}${path.slice(1)}`
        : `${cwd}/${path}`;
    const normalized = resolved.replace(/\/+/g, "/").replace(/\/$/, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      files.push({ path: normalized, exists: existsSync(normalized) });
    }
  };

  let dir = cwd;
  while (dir && dir !== "/") {
    add(`${dir}/AGENTS.md`);
    add(`${dir}/.pi/AGENTS.md`);
    add(`${dir}/.agents/AGENTS.md`);
    add(`${dir}/CLAUDE.md`);
    const parent = dir.substring(0, dir.lastIndexOf("/"));
    if (!parent) break;
    dir = parent;
  }

  if (homeDir) {
    add(`${homeDir}/.pi/agent/AGENTS.md`);
  }

  return files;
}

/* ------------------------------------------------------------------ */
/*  Data gathering                                                    */
/* ------------------------------------------------------------------ */

interface InfoData {
  tools: { name: string; description: string; active: boolean; source: string }[];
  skills: { name: string; description: string; path: string; scope: string }[];
  prompts: { name: string; description: string; path: string; scope: string }[];
  extCommands: { name: string; description: string }[];
  contextFiles: { path: string; exists: boolean }[];
  systemPromptLength: number;
  fullSystemPrompt: string;
  cwd: string;
  sessionFile: string | undefined;
  entriesCount: number;
}

function gatherInfoData(
  allTools: ToolInfo[],
  activeNames: string[],
  commands: SlashCommandInfo[],
  contextFiles: Array<{ path: string; exists: boolean }>,
  systemPrompt: string,
  cwd: string,
  sessionFile: string | undefined,
  entriesCount: number,
): InfoData {
  const activeSet = new Set(activeNames);

  return {
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description || "",
      active: activeSet.has(t.name),
      source: t.sourceInfo.source,
    })),
    skills: commands
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name,
        description: c.description || "",
        path: c.sourceInfo.path,
        scope: c.sourceInfo.scope,
      })),
    prompts: commands
      .filter((c) => c.source === "prompt")
      .map((c) => ({
        name: c.name,
        description: c.description || "",
        path: c.sourceInfo.path,
        scope: c.sourceInfo.scope,
      })),
    extCommands: commands
      .filter((c) => c.source === "extension")
      .map((c) => ({
        name: c.name,
        description: c.description || "",
      })),
    contextFiles,
    systemPromptLength: systemPrompt.length,
    fullSystemPrompt: systemPrompt,
    cwd,
    sessionFile,
    entriesCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Info display component — fixed-height viewport, wraps long lines   */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 25; // physical lines visible at once

class InfoView {
  private data: InfoData;
  private theme: Theme;
  private showFull = false;

  // Two-layer content: logical (themed, unwrapped) → physical (wrapped to width)
  private logicalLines: string[] = [];
  private wrappedLines: string[] = [];
  private lastWidth = -1;

  // Scroll position in physical (wrapped) line units
  private viewOffset = 0;

  constructor(data: InfoData, theme: Theme) {
    this.data = data;
    this.theme = theme;
    this.rebuild(true);
  }

  /** Rebuild logical lines from data. Call on mode toggle. */
  rebuild(resetScroll = false) {
    if (resetScroll) this.viewOffset = 0;
    this.logicalLines = this.buildLines();
    this.lastWidth = -1; // force re-wrap on next render
  }

  /** Re-wrap logical → physical when terminal width changes. */
  private rewrap(width: number) {
    if (width === this.lastWidth) return;
    this.lastWidth = width;
    this.wrappedLines = [];
    for (const line of this.logicalLines) {
      const wrapped = wrapTextWithAnsi(line, width);
      if (wrapped.length === 0) {
        this.wrappedLines.push("");
      } else {
        for (const w of wrapped) {
          this.wrappedLines.push(w);
        }
      }
    }
  }

  private clamp() {
    const total = this.wrappedLines.length;
    if (this.viewOffset < 0) this.viewOffset = 0;
    if (total > 0 && this.viewOffset >= total) this.viewOffset = total - 1;
  }

  render(width: number): string[] {
    this.rewrap(width);
    this.clamp();

    const total = this.wrappedLines.length;
    if (total === 0) return [""];

    const endLine = Math.min(this.viewOffset + PAGE_SIZE, total);
    const visible = this.wrappedLines.slice(this.viewOffset, endLine);

    // Scroll indicator header
    const atTop = this.viewOffset === 0;
    const atBottom = endLine >= total;
    const scrollInfo = atTop
      ? "▲ top"
      : atBottom
        ? "▼ bottom"
        : `${this.viewOffset + 1}–${endLine} / ${total}`;
    const headerBar = `  ${scrollInfo} ${"─".repeat(Math.max(width - scrollInfo.length - 5, 1))}`;

    const result: string[] = [];
    result.push(truncateToWidth(this.theme.fg("dim", headerBar), width));

    // Content — padded to PAGE_SIZE for a stable fixed height
    for (const line of visible) {
      result.push(line);
    }
    for (let i = visible.length; i < PAGE_SIZE; i++) {
      result.push("");
    }

    // Footer
    const footer = "  [q/Esc] close  |  [↑↓] scroll  |  [Space/PgDn] page  |  [f/Tab] full/summary  |  [Home/End]";
    result.push(truncateToWidth(this.theme.fg("dim", footer), width));

    return result;
  }

  handleInput(data: string): boolean {
    if (data == null || typeof data !== "string") return false;

    const total = this.wrappedLines.length;

    if (matchesKey(data, Key.up)) {
      this.viewOffset = Math.max(0, this.viewOffset - 1);
      return true;
    } else if (matchesKey(data, Key.down)) {
      this.viewOffset = Math.min(Math.max(0, total - 1), this.viewOffset + 1);
      return true;
    } else if (matchesKey(data, Key.pageUp)) {
      this.viewOffset = Math.max(0, this.viewOffset - PAGE_SIZE);
      return true;
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
      this.viewOffset = Math.min(Math.max(0, total - 1), this.viewOffset + PAGE_SIZE);
      return true;
    } else if (matchesKey(data, Key.home)) {
      this.viewOffset = 0;
      return true;
    } else if (matchesKey(data, Key.end)) {
      this.viewOffset = Math.max(0, total - 1);
      return true;
    }

    return false;
  }

  toggleFull(): void {
    this.showFull = !this.showFull;
    this.rebuild(); // preserve viewOffset — no resetScroll
  }

  invalidate() {
    this.lastWidth = -1; // force re-wrap on next render
  }

  private buildLines(): string[] {
    const { data, theme, showFull } = this;
    const L: string[] = [];

    // Header
    const modeLabel = showFull ? "FULL" : "SUMMARY";
    L.push("");
    L.push(theme.fg("accent", theme.bold(`  /info  ·  ${modeLabel}  ·  [f/Tab] toggle  ·  [q/Esc] close`)));
    L.push("  " + theme.fg("accent", "━".repeat(50)));
    L.push("");

    /* --- Tools --- */
    L.push(theme.fg("accent", theme.bold("  ▸ Registered Tools")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));

    const builtIn = data.tools.filter((t) => t.source === "built-in");
    const extTools = data.tools.filter((t) => t.source !== "built-in");

    if (builtIn.length > 0) {
      L.push(theme.fg("muted", "  built-in:"));
      for (const t of builtIn) {
        const status = t.active
          ? theme.fg("success", "✓ active")
          : theme.fg("muted", "○ inactive");
        const desc = showFull && t.description ? ` — ${t.description}` : "";
        L.push(`    ${status} ${t.name}${desc}`);
      }
    }

    if (extTools.length > 0) {
      L.push(theme.fg("muted", "  extension:"));
      for (const t of extTools) {
        const status = t.active
          ? theme.fg("success", "✓ active")
          : theme.fg("muted", "○ inactive");
        const desc = showFull && t.description ? ` — ${t.description}` : "";
        L.push(`    ${status} ${t.name}${desc}`);
      }
    }

    if (data.tools.length === 0) {
      L.push(theme.fg("dim", "    (none)"));
    }

    const activeCount = data.tools.filter((t) => t.active).length;
    L.push(theme.fg("dim", `  Total: ${data.tools.length}  |  Active: ${activeCount}  |  Inactive: ${data.tools.length - activeCount}`));
    L.push("");

    /* --- Skills --- */
    L.push(theme.fg("accent", theme.bold("  ▸ Available Skills")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));

    if (data.skills.length > 0) {
      const byScope: Record<string, typeof data.skills> = {};
      for (const s of data.skills) {
        if (!byScope[s.scope]) byScope[s.scope] = [];
        byScope[s.scope].push(s);
      }
      for (const [scope, skills] of Object.entries(byScope)) {
        L.push(theme.fg("muted", `  [${scope}]`));
        for (const s of skills) {
          const rawDesc = s.description || "";
          const truncatedDesc = rawDesc.length > 70 ? rawDesc.slice(0, 70) + "…" : rawDesc;
          const desc = rawDesc ? ` — ${showFull ? rawDesc : truncatedDesc}` : "";
          L.push(`    /skill:${s.name}${desc}`);
          L.push(theme.fg("dim", `      ${s.path}`));
        }
      }
    } else {
      L.push(theme.fg("dim", "    (none)"));
    }
    L.push(theme.fg("dim", `  Total: ${data.skills.length}`));
    L.push("");

    /* --- Prompt templates --- */
    L.push(theme.fg("accent", theme.bold("  ▸ Prompt Templates")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));

    if (data.prompts.length > 0) {
      const byScope: Record<string, typeof data.prompts> = {};
      for (const p of data.prompts) {
        if (!byScope[p.scope]) byScope[p.scope] = [];
        byScope[p.scope].push(p);
      }
      for (const [scope, prompts] of Object.entries(byScope)) {
        L.push(theme.fg("muted", `  [${scope}]`));
        for (const p of prompts) {
          const rawDesc = p.description || "";
          const truncatedDesc = rawDesc.length > 70 ? rawDesc.slice(0, 70) + "…" : rawDesc;
          const desc = rawDesc ? ` — ${showFull ? rawDesc : truncatedDesc}` : "";
          L.push(`    /${p.name}${desc}`);
          L.push(theme.fg("dim", `      ${p.path}`));
        }
      }
    } else {
      L.push(theme.fg("dim", "    (none)"));
    }
    L.push(theme.fg("dim", `  Total: ${data.prompts.length}`));
    L.push("");

    /* --- Extension commands --- */
    L.push(theme.fg("accent", theme.bold("  ▸ Extension Commands")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));

    if (data.extCommands.length > 0) {
      for (const c of data.extCommands) {
        const desc = c.description ? ` — ${c.description}` : "";
        L.push(`    /${c.name}${desc}`);
      }
    } else {
      L.push(theme.fg("dim", "    (none)"));
    }
    L.push(theme.fg("dim", `  Total: ${data.extCommands.length}`));
    L.push("");

    /* --- Context files (loaded only in summary; not-found only in full) --- */
    const loaded = data.contextFiles.filter((cf) => cf.exists);
    const notFound = data.contextFiles.filter((cf) => !cf.exists);

    if (loaded.length > 0 || (showFull && notFound.length > 0)) {
      L.push(theme.fg("accent", theme.bold("  ▸ Context Files")));
      L.push("  " + theme.fg("dim", "─".repeat(45)));
      L.push(theme.fg("muted", "  (AGENTS.md, CLAUDE.md, etc.)"));

      if (loaded.length > 0) {
        L.push(theme.fg("muted", "  loaded:"));
        for (const cf of loaded) {
          L.push(`    ${theme.fg("success", "✓")} ${cf.path}`);
        }
      }

      if (showFull && notFound.length > 0) {
        L.push(theme.fg("muted", "  not found:"));
        for (const cf of notFound) {
          L.push(`    ${theme.fg("muted", "○")} ${cf.path}`);
        }
      }

      const loadedCount = loaded.length;
      L.push(theme.fg("dim", `  Loaded: ${loadedCount}${showFull && notFound.length > 0 ? `  |  Not found: ${notFound.length}` : ""}`));
      L.push("");
    }

    /* --- System prompt stats --- */
    L.push(theme.fg("accent", theme.bold("  ▸ System Prompt")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));
    const approxTokens = Math.ceil(data.systemPromptLength / 4);
    L.push(`  Length: ${data.systemPromptLength.toLocaleString()} characters`);
    L.push(`  Est. tokens: ~${approxTokens.toLocaleString()}`);
    L.push("");

    /* --- Session --- */
    L.push(theme.fg("accent", theme.bold("  ▸ Session")));
    L.push("  " + theme.fg("dim", "─".repeat(45)));
    L.push(`  CWD: ${data.cwd}`);
    if (data.sessionFile) {
      L.push(`  Session: ${data.sessionFile}`);
    }
    L.push(`  Entries: ${data.entriesCount}`);
    L.push("");

    /* --- Full system prompt (only in full mode) --- */
    if (showFull) {
      L.push(theme.fg("accent", theme.bold("  ▸ Full System Prompt")));
      L.push("  " + theme.fg("dim", "─".repeat(45)));
      L.push("");
      L.push("  " + "─".repeat(42));
      for (const line of data.fullSystemPrompt.split("\n")) {
        L.push(`  ${line}`);
      }
      L.push("  " + "─".repeat(42));
      L.push("");
    }

    L.push(theme.fg("dim", "  ─".repeat(40)));
    L.push("");

    return L;
  }
}

/* ------------------------------------------------------------------ */
/*  Extension factory                                                 */
/* ------------------------------------------------------------------ */

export default function infoExtension(pi: ExtensionAPI) {
  pi.registerCommand("info", {
    description: "Show session info: tools, skills, prompts, context files",
    handler: async (_args, ctx) => {
      // Gather data
      const allTools: ToolInfo[] = pi.getAllTools();
      const activeNames: string[] = pi.getActiveTools();
      const commands: SlashCommandInfo[] = pi.getCommands();
      const systemPrompt = ctx.getSystemPrompt();
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      const contextFiles = discoverContextFiles(ctx.cwd, homeDir);

      const infoData = gatherInfoData(
        allTools,
        activeNames,
        commands,
        contextFiles,
        systemPrompt,
        ctx.cwd,
        ctx.sessionManager.getSessionFile(),
        ctx.sessionManager.getEntries().length,
      );

      // Short summary notification
      const skillCount = infoData.skills.length;
      const promptCount = infoData.prompts.length;
      ctx.ui.notify(
        `/info: ${infoData.tools.length} tools, ${skillCount} skills, ${promptCount} prompts`,
        "info",
      );

      // Show in a scrollable dialog with "f" to toggle full mode
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const view = new InfoView(infoData, theme);

        return {
          render(width: number) {
            return view.render(width);
          },
          invalidate() {
            view.invalidate();
          },
          handleInput(data: string) {
            if (data == null || typeof data !== "string") return;

            // Capture as early as possible — before any other key handling
            if (
              data === "f" || data === "F" ||
              data === "tab" || data === "Tab" || matchesKey(data, Key.tab)
            ) {
              view.toggleFull();
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
              done(undefined);
              return;
            }

            const changed = view.handleInput(data);
            if (changed) {
              _tui.requestRender();
            }
          },
        };
      });
    },
  });
}
