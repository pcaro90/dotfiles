/**
 * Double Ctrl+D to exit.
 *
 * Pi exits on a single Ctrl+D as soon as the prompt is empty. This extension
 * requires a second Ctrl+D within one second instead:
 *
 *   • Ctrl+D with text  — keeps the shell-style delete-character-forward
 *   • Ctrl+D on empty   — arms the exit and shows a hint
 *   • Ctrl+D again <1 s — exits through Pi's normal graceful shutdown
 *
 * The double-press only applies to the prompt editor. Inside selectors and
 * overlays (e.g. Ctrl+D to delete a session in /resume) it is untouched.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const WINDOW_MS = 1000;
const HINT = "Ctrl+D again to exit";
const STATUS_KEY = "double-ctrl-d-exit";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Armed while the hint timer runs.
		let armed: ReturnType<typeof setTimeout> | undefined;

		const disarm = () => {
			clearTimeout(armed);
			armed = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		};

		class DoubleCtrlDEditor extends CustomEditor {
			override handleInput(data: string) {
				if (!matchesKey(data, Key.ctrl("d")) || this.getText().length > 0) {
					if (armed) disarm();
					super.handleInput(data);
				} else if (armed) {
					disarm();
					if (this.onCtrlD) this.onCtrlD();
					else ctx.shutdown();
				} else {
					ctx.ui.setStatus(STATUS_KEY, HINT);
					armed = setTimeout(disarm, WINDOW_MS);
				}
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new DoubleCtrlDEditor(tui, theme, keybindings));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
