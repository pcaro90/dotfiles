# Completions for `pi`

# ── Commands ──────────────────────────────────────────────────────────
complete -c pi -f -n "__fish_use_subcommand" -a install    -d "Install extension source and add to settings"
complete -c pi -f -n "__fish_use_subcommand" -a remove     -d "Remove extension source from settings"
complete -c pi -f -n "__fish_use_subcommand" -a uninstall  -d "Alias for remove"
complete -c pi -f -n "__fish_use_subcommand" -a update     -d "Update pi and installed extensions"
complete -c pi -f -n "__fish_use_subcommand" -a list       -d "List installed extensions from settings"
complete -c pi -f -n "__fish_use_subcommand" -a config     -d "Open TUI to enable/disable package resources"

# ── Command options ───────────────────────────────────────────────────
# install / remove / uninstall accept a -l flag
complete -c pi -n "__fish_seen_subcommand_from install remove uninstall" -s l -d "Local mode"

# ── Options (with value) ──────────────────────────────────────────────
complete -c pi -l provider            -d "Provider name (default: google)" -r
complete -c pi -l model               -d "Model pattern or ID"             -r
complete -c pi -l api-key             -d "API key (defaults to env vars)"   -r
complete -c pi -l system-prompt       -d "System prompt text"              -r
complete -c pi -l append-system-prompt -d "Append text or file to system prompt" -r -F
complete -c pi -l mode                -d "Output mode"                     -xa "text json rpc"
complete -c pi -l session             -d "Use specific session file or partial UUID" -r -F
complete -c pi -l fork                -d "Fork session into a new session" -r -F
complete -c pi -l session-dir         -d "Directory for session storage"   -r -F
complete -c pi -l models              -d "Comma-separated model patterns for Ctrl+P cycling" -r
complete -c pi -l tools -s t          -d "Comma-separated tool allowlist"  -r
complete -c pi -l thinking            -d "Thinking level"                  -xa "off minimal low medium high xhigh"
complete -c pi -l extension -s e      -d "Load an extension file"          -r -F
complete -c pi -l skill               -d "Load a skill file or directory"  -r -F
complete -c pi -l prompt-template     -d "Load a prompt template"          -r -F
complete -c pi -l theme               -d "Load a theme file or directory"  -r -F
complete -c pi -l export              -d "Export session to HTML and exit" -r -F

# ── Boolean options (no value) ────────────────────────────────────────
complete -c pi -l print        -s p  -d "Non-interactive mode: process prompt and exit"
complete -c pi -l continue     -s c  -d "Continue previous session"
complete -c pi -l resume       -s r  -d "Select a session to resume"
complete -c pi -l no-session            -d "Don't save session (ephemeral)"
complete -c pi -l no-tools     -s nt -d "Disable all tools by default"
complete -c pi -l no-builtin-tools -s nbt -d "Disable built-in tools but keep extension tools"
complete -c pi -l no-extensions  -s ne -d "Disable extension discovery"
complete -c pi -l no-skills    -s ns -d "Disable skills discovery and loading"
complete -c pi -l no-prompt-templates  -s np -d "Disable prompt template discovery"
complete -c pi -l no-themes             -d "Disable theme discovery and loading"
complete -c pi -l no-context-files -s nc -d "Disable AGENTS.md and CLAUDE.md loading"
complete -c pi -l list-models           -d "List available models"
complete -c pi -l verbose               -d "Force verbose startup"
complete -c pi -l offline               -d "Disable startup network operations"
complete -c pi -l help         -s h  -d "Show help"
complete -c pi -l version      -s v  -d "Show version number"

# ── Extension CLI Flags ───────────────────────────────────────────────
complete -c pi -l ssh -s s         -d "SSH remote: user@host or user@host:/path"
complete -c pi -l wmode            -d "Default working mode" -xa "readonly normal berserker"

# ── Context-aware: suggest SSH hosts after `--ssh` or `-s` ────────────
complete -c pi \
    -n "string match -q -- (commandline --current-process --tokens-expanded --cut-at-cursor)[-1] '--ssh'" \
    -d "Remote host" \
    -xa "(__fish_print_hostnames)"

