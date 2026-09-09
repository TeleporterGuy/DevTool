# Security audit (company-deploy readiness)

Snapshot of what this fork actually is, from a security point of view, before putting it on company machines. Dated against **`0.3.0`** (Phase 1 shipped). Not a pentest. Not a promise that later phases stay clean.

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project). Work stays on [TeleporterGuy/DevTool](https://github.com/TeleporterGuy/DevTool). Product direction is in [ROADMAP.md](./ROADMAP.md).

---

## What you are deploying

DevTool is a **privileged workstation orchestrator**, not a sandboxed product and not an agent runtime. Treat it like “a terminal + SSH + git + file tree + an embedded browser + a host for Pi/Claude/Codex,” all running **as the logged-in user**.

It will:

- Spawn Git Bash (and agent CLIs) with the user’s environment.
- Read, write, create, rename, and delete files under a project cwd.
- Commit / push / discard via git.
- Open SSH ControlMaster sessions, local port forwards, and a SOCKS proxy for the in-app browser.
- Inject Claude hooks into the project’s `.claude/settings.local.json` and load a Pi status extension.
- Persist layout, notes, and **full terminal scrollback** under `~/.devtool` (packaged) or `~/.devtool-dev` (dev).

It will **not**:

- Sandbox Pi (or Claude/Codex). Models, API keys, and base URL stay in Pi’s own config (Phase 0.5).
- Add SSO, audit logs, DLP, or an update channel.
- Replace company SSH/PKI policy. Host-key checking is TOFU (`accept-new`).

If “an AI CLI with the developer’s credentials, on company source” is already a no, this app does not make that safer. If that is already accepted for a normal Git Bash window, the rest of this file is the *extra* surface DevTool adds.

**1.0.0** in the roadmap is “something you would tell a friend to unzip.” Company IT is a higher bar than that.

---

## Threat model (what to worry about)

| Attacker / situation | Why it matters here |
| --- | --- |
| Malicious or compromised **web page** in an in-app browser tab | Renderer has `webviewTag` and a large IPC surface (spawn, file I/O, git, SSH). |
| **Local** process or another user on the same machine | Hook server is unauthenticated HTTP on `127.0.0.1`. Config/scrollback are plaintext. |
| Process on an **SSH remote** (shared Linux box) | Hook port is reverse-forwarded (`ssh -R`). Pi extension is written under `/tmp`. |
| **Network** MITM on first SSH connect | `StrictHostKeyChecking=accept-new` trusts the first host key it sees. |
| **Supply chain / stale Chromium** | Electron **35.7.5** is end-of-support. Windows `DevTool.exe` is **unsigned**. |
| The **agent itself** | By design it can read `.env`, run commands, and `git push`. Policy problem, not a missing `if`. |

Out of scope for this snapshot: a full dependency CVE dump, physical theft of an unlocked laptop (same as any editor), and “make Pi unable to see the repo.”

---

## Already in decent shape

Keep these; do not regress them.

- Preload uses `contextBridge`. `openExternal` allows only `http:` / `https:`.
- File-tree create / rename / delete goes through `resolveSafeProjectPath` (`src/main/project-fs-path.ts`) and rejects `..` / other-drive escapes **relative to the given project cwd**.
- Workspace delete refuses to recursively remove a path that is not a registered git worktree.
- Hook HTTP server binds **`127.0.0.1`**, not all interfaces. SOCKS and SSH `-L` are localhost-style binds by default.
- Markdown preview is sanitized with DOMPurify.
- Chrome DevTools Protocol (`DEVTOOL_CDP_PORT`) is opt-in; packaged runs do not open it.
- SSH remote commands are mostly `execFile` plus quoting (`shellQuote` in `ssh-connection-manager.ts`), not a local `sh -c` string built from untrusted pieces.
- Dev and packaged config dirs are split on purpose (`src/main/config-dir.ts`).
- Spectre-mitigated `node-pty` builds stay on; do not strip that to make compile easier (see README).
- Do not `chmod +s` `chrome-sandbox` (AGENTS.md).

---

## Findings

Severity is “what a company security review usually does with it,” not CVSS. **Blocker** = typical IT will not put this in Software Center as-is. **High** = fix or write an exception before a real rollout. **Medium** = do before you call it boring. **Policy** = code cannot save you; someone has to accept it.

### Blocker

**Unsigned Windows portable folder.** `package.json` sets `signAndEditExecutable: false`. `npm run build:win` yields `dist/win-unpacked` with no Authenticode publisher. SmartScreen, AppLocker, WDAC, and “who shipped this?” all fire. There is no installer, no auto-update, no Electron fuses (`onlyLoadAppFromAsar`, `embeddedAsarIntegrityValidation`, `runAsNode`, cookie encryption). Anyone who can write into that folder can replace binaries.

### High

**Electron 35.7.5 is end-of-support.** No more security patches on that line. Chromium 134 is behind current stables. Scanners will flag this even if you never demonstrate an exploit.

**Renderer / webview hardening is below Electron baseline.** Main window sets `sandbox: false` and `webviewTag: true` and does not set `contextIsolation` / `nodeIntegration` explicitly (`src/main/index.ts`). There is no CSP in `src/renderer/index.html`, no `will-attach-webview` / `web-contents-created` lock, no `setWindowOpenHandler`, no guest `webpreferences` on `<webview>`. DevTools are always available (app menu and the browser-tab button). Local browser tabs use the default session; new tabs default to `https://www.google.com`. Remote tabs use `persist:browser-${projectId}` plus SOCKS through the SSH host — company browsing can egress via that box.

**Hook server is unauthenticated localhost HTTP, then reverse-tunneled.** `src/main/hook-server.ts` accepts any POST to `/hook/{session-start,working,stopped,notification}` if `X-Tab-Id` is set. No shared secret, no body-size cap. SSH connect does `-R 0:localhost:<hookPort>`, so a process on the remote that can hit the allocated port can spoof inbox/status. Remote Pi extension path is `/tmp/devtool-<user>/pi-status-extension.mjs` — on a shared host, `/tmp` pre-create / symlink races can plant code Pi will load.

**SSH trust is TOFU, not company PKI.** Master, SOCKS, and spawn args use `StrictHostKeyChecking=accept-new`. First connection to the wrong host is remembered. No SSH CA, no pinned `UserKnownHostsFile`, no `IdentitiesOnly`. `projects.json` stores host / user / port / **path** to a key file. Control sockets live under `~/.devtool/ssh/` created with default umask (often `0755`).

**Privileged IPC is a wide main-process API.** After XSS or a webview escape, the renderer can already do what the user can do. Extra problems even then:

| Channel | Issue |
| --- | --- |
| `pty-spawn` | Arbitrary process; `extraEnv` is passed through (e.g. `LD_PRELOAD` / `NODE_OPTIONS`). |
| `fb-*` / git ops | Traversal is relative to **whatever cwd the renderer sent**, not an allow-list of known projects. |
| `hooks-inject` | Writes `.claude/settings.local.json` in any directory. |
| `scrollback-save` | `tabId` is joined into a filename with no sanitization (`src/main/scrollback-storage.ts`). UI uses UUIDs; main does not require that. |

Git `add` / `checkout` / `show` correctly use `--` (option injection), but paths are not forced under the project root.

**Secrets sit in plaintext home files.** Packaged: `~/.devtool`. Dev: `~/.devtool-dev`. Expect `projects.json`, `notes.json`, `scrollback/*.txt` (full agent/terminal output), `debug.log` (hook payloads), `backups/projects-*.json`. The Files tree lists `.env` and `.git` on purpose (Phase 1.1). No `chmod 700` on the config dir. Browser cookies live in Electron `userData`, a second location. Idle-task cleanup (off by default) can delete git worktrees — keep it off on shared machines.

### Medium

**macOS entitlements are wide** (if you ever ship Mac): hardened runtime is on, but JIT, unsigned executable memory, and `disable-library-validation` are enabled, plus mic/camera for agent voice. Linux `scripts/install.sh` copies to `/opt/DevTool`; do not setuid `chrome-sandbox` to chase sandbox errors.

**Supply chain / build machine.** From-source Windows still needs admin + VS 2022 + Spectre libs. Recipients of the portable folder skip compile (good). `npm install` still runs native rebuilds. Pin and vendor if you need a reproducible internal build. Leave `electron-winstaller` unapproved until you have signing.

**Claude hooks can be left on disk** if the app crashes before cleanup. They call `curl` at `localhost:<port>/hook/...`. Harmless if the port is dead; surprising if another DevTool instance reused a port (unlikely with `listen(0)` but not a protocol secret).

### Policy (accept or do not deploy)

Pi/Claude/Codex run as the user, in the project or worktree, with network. DevTool does not hold inference keys (good) and does not redact, log, or block `git push`, secret reads, or calls to internal APIs. Extra `aiToolArgs` are extra CLI flags, not a proxy.

Same review you would do for “developers already run Pi in Git Bash on laptops.” This app hosts that; it does not wrap it in a jail.

---

## Company-control gaps (not code bugs)

Typical IT checklist items this repo does not provide:

- SSO / device identity / “who ran this”
- Audit trail of SSH, git push, or agent sessions
- Network allow-list (browser + agent + SOCKS)
- Data classification for scrollback and notes
- Supported update / CVE process
- Encryption at rest for `~/.devtool`
- Two instances on the same config dir: last writer wins on `projects.json` (see AGENTS.md)

---

## Suggested order if you want to deploy anyway

Work in this order so each step is demoable. Do not start Phase 4 LSP work instead of this if company deploy is the goal.

1. **Policy accept.** User-equivalent agent + terminal + SSH. If that’s a no, stop. Write down: approved models, no prod creds in the tree, idle cleanup off, remotes you will allow SOCKS through.
2. **Sign the Windows build** (or wrap it in your internal installer) and **upgrade Electron** off the 35.x EOS line. Turn on Electron fuses when you package. Until then, treat `dist/win-unpacked` as a known-hash exception, not a general-install package.
3. **Harden Electron.** CSP on the renderer; `will-attach-webview` / `web-contents-created` so guests cannot get Node; explicit `contextIsolation` + `nodeIntegration: false`; packaged DevTools off or behind a flag; don’t default new browser tabs at Google.
4. **Hook authentication** (shared secret on POSTs) and **stop writing the Pi extension under `/tmp`**. Tighten SSH: known_hosts or CA, `IdentitiesOnly=yes`, control-socket dir `0700`. Do not reverse-forward the hook port to untrusted shared remotes.
5. **Config dir `0700`**, sanitize scrollback `tabId`, bind file/git IPC cwd to projects the app already knows. Optional: drop `extraEnv` to an allow-list (`DEVTOOL_TAB_ID`, `DEVTOOL_HOOK_PORT`).
6. **Pilot** a small group. DLP/backup tools should know about `~/.devtool` and Electron `userData`. SSH only to hosts you trust. Watch leftover `.claude/settings.local.json` hooks.

Highest-leverage engineering pass (bounded, unlike “make the agent safe”): **steps 3–5**.

---

## Code map (where to look)

| Area | Where |
| --- | --- |
| Window / webPreferences | `src/main/index.ts` |
| IPC surface | `src/main/app-runtime.ts`, `src/preload/index.ts` |
| Hook HTTP | `src/main/hook-server.ts`, `src/main/hook-injector.ts` |
| Pi extension path | `src/main/pi-extension-injector.ts` |
| SSH / SOCKS / tunnels | `src/main/ssh-connection-manager.ts` |
| File tree bounds | `src/main/project-fs-path.ts`, `src/main/file-browser-fs.ts` |
| Scrollback files | `src/main/scrollback-storage.ts` |
| Config dir | `src/main/config-dir.ts`, `src/main/storage.ts` |
| Embedded browser | `src/renderer/components/BrowserTab.tsx` |
| Packaging / signing | `package.json` `build.win` |

---

## How this file relates to the roadmap

Roadmap phases (conda, Jupyter, LSP) add more child processes and another browser use. They do not remove anything above. Do not declare Phase 2–4 “company ready” without revisiting this file.

Parking-lot ideas that would *increase* surface if pulled in: native notebook kernels, Windows OpenSSH as a second remote stack, extra LSPs talking stdio as the same user.

This audit is a snapshot at `0.3.0`. When a numbered hardening pass lands, note it here the same way the roadmap notes closeout — one paragraph, what changed, what is still open.
