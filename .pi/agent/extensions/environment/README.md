# Environment

One execution router for Pi's `read`, `write`, `edit`, `bash`, and user `!` commands.

| Mode | Execution |
| --- | --- |
| **bubble** (default for a new session) | Local Bubblewrap namespaces, explicit filesystem allowlist, clean environment. |
| **direct** | Local host, with the user's ordinary permissions. |
| **ssh** | Remote account and working directory, without a remote sandbox. |

`codemode` stays enabled and calls the same routed tools. Bash's input schema is unchanged.
The existing `questionnaire` tool is unaffected. `grep`, `find`, `ls`, and PowerShell tools
are disabled; use Bash for listing and searching.

## Start and switch

```sh
pi
pi --direct
pi --ssh user@host
pi --ssh user@host:/remote/path
```

`--ssh` and `--direct` are mutually exclusive. Explicit flags select the target on process
startup. Without flags, a resumed session restores its saved Environment policy; a new
session starts in bubble mode. `/reload` preserves the current policy instead of reapplying
startup flags. Sessions without saved Environment state use the supplied flags.
IPv6 targets use `user@[address]:/path`.

Inside Pi:

```text
/env                              Interactive environment/resource panel
/env status                       Compact target and policy summary
/env status full                  Full RO/RW inventory and path aliases
/env bubble                       Switch to local bubble
/env direct                       Switch to unrestricted local execution
/env ssh user@host:/path           Switch to SSH after checking the destination
/env resources                    Inspect grants; select one to remove it
/env skills                       Select skills offered in SSH mode
/env refresh                      Apply config.json toolchain roots; retain session grants
/env reset                        Restore default bubble policy
```

Target changes require an idle agent and no active tool operation. Stop the current turn
or wait for it to finish, then switch. Failed target changes keep the previous target.
Failed initial setup blocks execution; it never silently runs on the host instead.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **Ctrl+1** | Toggle the personal SSH agent (all identities) in bubble mode. |
| **Ctrl+2** | Toggle full Docker daemon access in bubble mode. |
| **Ctrl+Tab** | Toggle local **bubble ↔ direct** mode; direct is unrestricted local execution. |

These are explicit user actions, without an extra confirmation dialog. Capability toggles
use the same validation and session persistence as `/env allow`/`revoke`; a failed grant
changes neither the policy nor the indicator. Rapid presses are serialized, and pending
actions cannot spill into a replacement session. They affect new operations only and may
be used during a turn. Mode changes still require an idle agent, retain existing grants,
and never automatically leave SSH. The shortcuts do not recover blocked initialization.

The footer shows actual current grants: **🫧**, **🫧 🔑**, **🫧 🐳**, or **🫧 🔑 🐳**.
Direct and SSH retain **💻** and **🌐 host:path**; their host/remote permissions are not
controlled by the bubble capability toggles.

**Terminal compatibility:** Pi recognizes these keys via Kitty/CSI-u or xterm
`modifyOtherKeys`. Foot supports these protocols; fish needs no extra bindings while Pi
owns terminal input. Plain `1`, `2`, Tab and Ctrl+Space/NUL are not accepted as substitutes.
A desktop/terminal shortcut that intercepts the chord must be changed separately.

For tmux (tested with 3.8), extended keys must reach the application. If necessary, add to
your tmux configuration on each relevant host; Environment does not edit it automatically:

```tmux
set -s extended-keys on
set -as terminal-features ',foot*:extkeys'
```

If an SSH connection starts *inside another tmux*, its remote client may see
`TERM=tmux-256color`; configure that tmux layer too, with a matching `tmux*:extkeys`
terminal-feature entry. Pi accepts both tmux's `csi-u` and `xterm` extended-key formats.
After changing terminal options, reattach/restart Pi if needed to renegotiate keyboard
reporting. See `man 7 foot-ctlseqs` and tmux's `extended-keys`/`terminal-features` options.

## Configuration

Edit **`~/.pi/agent/extensions/environment/config.json`**. System and user installations
share one RO root list; there is no separate trust level based on how a tool was installed:

```json
{
  "toolchain": {
    "includePath": true,
    "roots": [
      "/usr",
      "/opt",
      "~/.nimble",
      "~/.zvm",
      "~/.rustup",
      "~/.local/pipx",
      "~/.local/share/uv/tools",
      "~/.local/share/pnpm",
      "~/src/3rd/radare2"
    ]
  },
  "sshAgentSocket": "/run/user/1000/gcr/ssh"
}
```

`includePath` adds existing absolute PATH directories and executable symlink targets not
already covered by a root. Relative PATH entries, `/`, and the complete home are not
implicitly granted; an explicit root may expose them. Roots use absolute or `~/` paths.
Missing optional installations are skipped. Descendants already covered by another root
are pruned, so whole Nim/radare2 installations replace many individual executable entries.
Selected loader, DNS, certificate and account files in `/etc` remain internal runtime
resources. No shell expansion or commands are evaluated in this JSON file.

New sessions use the current config. Existing sessions keep their saved profile until
**`/env refresh`** (also available in the panel). Refresh replaces the profile defaults,
retains explicit RO/RW grants, aliases, agent/Docker/MCP permissions and the execution mode,
and applies to new operations only. It reapplies configured defaults, including defaults
previously removed from the session. `/env reset` additionally discards session grants.
State saved by early versions of Environment, without this profile metadata, is rejected
on restore like any invalid state; `/env reset` restores the defaults.

Agent selection is read for each new execution independently of profile refresh. Unknown
keys, relative roots, invalid JSON or a missing config file produce explicit errors, not
unrestricted fallback. The router is registered before loading the configuration so a bad
file cannot leave Pi's host tools accidentally active. `/env status full` shows the config
path; `/env direct` can be selected explicitly to repair a broken config if necessary.

## Bubble resources

New sessions start with:

- The local project root and host **`/tmp` shared RW**.
- Configured toolchain roots, selected runtime/DNS/certificate files, and optionally PATH
  directories and executable symlink targets **RO**. System/user installations use the same policy.
- **All loaded local skill directories RO**, independently of the SSH skill selection.
- A **session-private home and caches**, mounted at the usual home path. Storage lives below
  `/tmp/pi-environment-<uid>/<session-hash>/home` and is reused across calls and reloads.
- A fresh procfs and minimal `/dev`, isolated PID/IPC/user namespaces, no capabilities,
  and no inherited arbitrary environment variables or shell startup hooks.
- **Open network**, including services reachable from the host network. There is no
  destination/domain filtering in this version.
- Personal SSH agent, Docker socket, and external MCP tool calls **off**.

Skills retain the absolute names Pi advertises, even if their directories are symlinks
into another repository. Both the real target and the advertised name are available RO;
an independently linked instruction file is exposed as well. This works whether the
workspace is the skill repository, the skill registry, or neither, without exposing the
whole host home or `~/.pi/agent`. Automatic aliases are derived resources, not new session
grants. Ordinary skill files inherit an explicitly granted RW skill directory.

RO permits execution as well as reading; it does not change a file's Unix execute bits.
Unlisted host paths are unavailable. An apparently empty home path is the private home,
not a read-only view of the host home. User-selected workspace/grants can override it.

There is deliberately **no special protected profile for `~/.pi/agent`**. If it is your
workspace, its files, credentials, configuration, extensions and sessions are writable
like any other project. This is intentional, not a credential boundary for that workspace.

```text
/env allow ro /srv/reference
/env allow rw "/srv/build results"
/env allow ssh-agent
/env allow docker
/env allow mcp docs
/env revoke rw "/srv/build results"
/env revoke ssh-agent
/env revoke docker
/env revoke mcp docs
```

Grant an existing directory when the desired file does not exist yet. File and directory
grants are canonicalized and preserve explicitly requested symlink names as aliases (for
example, `~/.ssh/config` pointing into another directory). Merely having a symlink in a
workspace does not expose its unmounted destination. More-specific RO/RW mounts override parent mounts. Removing a
grant does not remove access inherited from a broader grant. Missing/stale paths can still
be revoked through `/env resources` or `/env revoke`; `/env reset` is another recovery path.

The **personal SSH agent is all-or-nothing**, without copying private keys into the
bubble. Docker grants access to the local Unix socket and, when present, `~/.docker` RO;
it is full daemon access, not command filtering. Known SSH/Docker socket paths are masked
when disabled even if a broad mount such as `/tmp` would expose them. Other sockets/files
under shared `/tmp` are intentionally not comprehensively filtered. SSH aliases and host
verification files are separate filesystem resources: grant RO to `~/.ssh/config`,
`~/.ssh/known_hosts` and any included configuration as needed. The agent capability alone
does not mount private key files or the complete `~/.ssh` directory.

The agent source is selected in this order:

1. **The Pi host process's `SSH_AUTH_SOCK`, when defined.** Even an empty or stale value
   wins; the extension never silently switches to a different agent/identity set.
2. **`sshAgentSocket` in config.json**, only if that variable is absent. `null` disables
   the fallback. The supplied config uses your local GCR/KeePassXC socket.

If SSH/tmux did not inherit the desktop variable but the socket exists on the same host,
the fallback works without agent forwarding, a tmux query, or a shell startup hook. Detection
is not authorization: `/env allow ssh-agent` or `request_access` must still grant access.
The bubble mounts only that socket at **`/run/environment/ssh-agent.sock`** and exports that
internal path as `SSH_AUTH_SOCK`. The host SSH backend uses the same selection independently
of whether the bubble has a grant; an unavailable agent does not disable OpenSSH's normal
key-file authentication. Direct mode retains its normal host environment.

Each new operation resolves the source again; an operation's mount/environment snapshot
uses one source consistently. Recreating a socket at the same path can serve later operations
without restarting Pi. Errors distinguish an absent source, empty environment value, a
nonexistent socket path, and a path that is not a socket.

Each operation uses an immutable policy snapshot and each subprocess gets a new bubble.
Grant/revoke affects new operations only. Existing executions retain their original access.
A Bash call is ephemeral: its PID namespace is torn down when its main shell exits, including
background children. There is no persistent task/server manager in this version. The
filesystem project, shared `/tmp`, and session-private home preserve data between calls.

The model receives actionable bubble errors. Some Bash errors cannot reliably distinguish
an unexposed path from an actually missing file; those preserve the original error and
explain the possibility instead of claiming a definite permission denial.

## Model permission requests

`request_access` asks for one or more local bubble resources and a reason. The user can
allow, deny, or adjust paths and RO/RW access before confirming. There is no automatic
command retry and the tool cannot switch to direct mode. It is `model-only`, so it remains
a direct user-interaction tool even with `codemode.only`; scripts cannot invoke it.
Concurrent requests are serialized. Without a dialog-capable UI, requests fail closed;
user `/env allow` commands can configure non-interactive/RPC sessions explicitly.

## SSH and local context

Local `AGENTS.md` and other project instructions remain exactly as Pi loaded them. The
local session root is not changed to the remote directory. Only the structured `cwd` field
and available skills are adjusted; the complete system prompt is never replaced.

By default, SSH offers skills without a `scripts/` directory. `/env skills` can enable or
disable individual skills. This filters the model's skill list; it does not erase already
loaded instructions or unregister Pi's `/skill:name` commands. Only explicit absolute
paths under a loaded, selected skill directory are local read exceptions. Existing local
Pi temporary artifacts (`/tmp/pi-bash-*`, `/tmp/pi-codemode-*`, etc.) are also read locally.
Relative paths, `~/` paths and other absolute paths refer to the remote host. A host symlink
outside the known skill directories does not turn a remote path into a local read.

`write` and `edit` always target SSH in this mode, even if the remote filename happens to
match a local skill path. Classifying ordinary remote paths and absolute remote commands
must not resolve them against the host filesystem: the host's `/root` permissions have no
bearing on the remote account's `/root`.

An explicitly enabled skill's script can run in the **local bubble** via a standalone
absolute-path invocation, for example `python3 /absolute/skill/scripts/task.py`. It is never
sent to the SSH host. Compound local/remote commands or ambiguous mentions of local skill
paths are rejected with guidance to separate the calls/use `read`. There is no new Bash
`target` parameter and no substring-based fallback to unrestricted host execution. Local
resource grants in SSH mode apply to these auxiliary bubble executions.

Sessions initially created in SSH omit only Pi's structured `docs` section from outgoing
model context. Local project instructions are retained. The omission preference stays
fixed across hot mode changes. Opaque/custom full system prompts are not reparsed.

## Persistence and context

State is stored as `environment-state` custom entries in Pi's session JSONL. It includes
target, RO/RW grants, capabilities and SSH skill selection. Resume, reload, fork and tree
navigation use the current branch's saved state. The global config defines the baseline
profile and agent fallback; grants remain in the session JSONL, not in a separate global
permissions file. Profile provenance and explicit RO grants are recorded so refresh can
preserve them even when a broader root temporarily covers them. This state is intentionally
editable if its session file is in an accessible workspace.

Each change persists the policy and updates the footer immediately, but queues no model
message. Before the next input, Environment compares it with the last policy communicated
to the model and emits at most one `environment-change` snapshot. Two opposite toggles
produce no notice. Set ordering and profile bookkeeping do not count as permission changes.
Successful `request_access` results include the current snapshot themselves, so no extra
notice follows a grant already reported to the model.

The comparison baseline lives in message/result details, follows the active branch and
survives reload. Initial state, compaction, or an older session without this metadata gets
one hidden snapshot; initialization failures remain visible. Existing messages are never
rewritten or filtered to coalesce notices: updates only append to context, preserving its
cached prefix. This does not guarantee cache hits from the provider.

The footer uses **🫧** (bubble), **💻** (direct), **🌐 host:path** (SSH), or **⛔ /env** (blocked),
without an `Env:` label or redundant local path. In bubble mode, **🔑** and **🐳** appear beside
**🫧** while their respective grants are enabled.

Transcript messages collapse to one line and can be expanded. Model-facing messages summarize the RO inventory instead of listing every installed toolchain path;
`/env resources`, `/env status full`, and "Show full status" retain the full details.

## MCP and other extensions

Pi's native MCP support remains in charge of server configuration and discovery (`/mcp`).
In bubble mode, an MCP tool/resource call needs an explicit grant for its server, including
nested calls from `codemode`. A server grant is a trusted **external capability**, not a
promise that the server runs inside Bubblewrap or on the SSH target. Unscoped resource
listing is blocked; specify an authorized server.

This gate controls calls, **not startup of already configured MCP servers**. Pi and trusted
extensions/stdio MCP servers remain host processes. Other unknown custom tools are blocked
in bubble mode until an adapter is implemented. In direct/SSH mode, external integrations
retain their own normal execution environment, independently of the workspace target.

## Development

The extension uses Pi's exported operation interfaces and preserves built-in schemas,
renderers, image reading, structured codemode output, exact multi-edit behavior and mutation
queues. File tools use local hashed proxy names bound to their actual target for native
path normalization and mutation queue keys. Remote paths such as `/root/file` are not
canonicalized or probed against the host filesystem by those native helpers.

Development dependencies are optional for Pi itself, which supplies the extension imports.
For reproducible checks:

```sh
cd ~/.pi/agent/extensions/environment
bun install --ignore-scripts --frozen-lockfile
bun run typecheck
bun test tests
```

Tests exercise real Bubblewrap, the four Pi tools, actual QuickJS codemode calls, sockets,
policy snapshots, branch restoration, CLI/SSH routing and the jiti loader. SSH transport
is normally tested with a local fixture, not a live infrastructure connection. Namespace-
separating fixtures cover skills-loaded routing, inaccessible local parent directories,
symlink/name collisions and relative paths instead of assuming both hosts share a filesystem.
Private-home skill regressions exercise `before_agent_start`, symlinked directories/files,
reference/script assets and a registry outside the workspace; SSH skill selection must not
filter the bubble's loaded skills. Mount-plan fixtures are separate from real bwrap boundary tests.
Separate RPC
tests launch the actual Node CLI and exercise `--direct`, `--ssh`, conflicting flags,
configuration errors, non-destructive profile refresh, and agent source priority/dynamic
fallback changes without model requests. The interactive panel uses standard TUI/RPC dialogs.

Run the full suite **from the host/direct mode**: a bubble deliberately disables nested
user namespaces, so it cannot launch the additional Bubblewrap environments used by the
boundary tests. Presentation and actual-CLI fixture tests can run from a bubble:

```sh
bun test tests/presentation.test.ts tests/cli.test.ts
```

For an explicitly authorized live destination, opt in from a host terminal with working
SSH authentication (the checks only run `pwd` and `hostname`, including `host:/tmp`):

```sh
PI_ENVIRONMENT_LIVE_SSH=moriapulsar bun test tests/cli.test.ts
```
