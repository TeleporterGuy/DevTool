# Fork roadmap: Windows orchestrator for Pi

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project) (DevTool). join3r has said this fork may be modified freely. Upstream is a macOS/Linux **task multiplexer** for CLI coding agents (Claude Code, Codex, Pi), with SSH, git worktrees, and an inbox. It is not an IDE and not an agent runtime.

This fork keeps that orchestrator model, with **Pi** as the primary agent and Pi’s own settings preserved and first-class in the app. The aim is to make it **primarily for Windows**: Git Bash, a portable Node zip, conda environments, and Jupyter (in-app browser tab). Linting and similar agent tools stay in **Pi extensions**. Language servers are parked, not a numbered phase.

Do not try to become VS Code or Cursor. If a feature belongs in Pi, put it in Pi.

Company-deploy security snapshot (what this app actually is on a workstation): [SECURITY.md](./SECURITY.md).

---

## Product bet (do not revisit every phase)

- **Host**, do not replace, the agent. Pi remains a CLI TUI in a tab.
- **No VMs.** Local disk + existing SSH to Linux boxes is enough.
- **Git Bash** is the only Windows shell for interactive tabs. No PowerShell. No Command Prompt. (`cmd.exe` may still wrap `pi.cmd` for ConPTY; that is not a product terminal.)
- **Environments are spawn-time PATH/env**, not a conda GUI and not a Node version manager UI. Settings **Node directory** is a folder prepend, not a requirement for `DevTool.exe` to launch.
- **Pi owns inference.** Models, API, and base URL stay in Pi’s config. Do not add those fields to DevTool.
- **Monaco is enough for edit/view.** Deeper analysis belongs in Pi (and similar agent tools). Language servers are parked — optional sugar (hover, go-to, complete) only if Monaco-without-Pi becomes painful. Not a numbered phase; no minor reserved for them.
- **Jupyter starts as a browser tab** against a local JupyterLab in the project conda env. Native `.ipynb` is later-maybe, only if that is still not enough after Phase 4 — not a gate and not a numbered phase.

---

## Versioning (`0.x.y`)

Stay on **0.x** until the app is something you would tell a friend to unzip. **1.0.0** is that call, not “Phase 5 finished.”

`package.json` is **0.4.0** (Phase 3 done). Phase 2 landed without tagging `0.4.0` and stayed **0.3.2**, so Phase 3 uses that skipped minor instead of jumping to `0.5.0`. Shape:

| Part | Meaning |
| --- | --- |
| `0` | Pre-1.0. Breaking changes are allowed. |
| `x` (minor) | Bump when a **numbered phase is done**. |
| `y` (patch) | Bump for a **mid-phase build** you would actually copy (`dist/win-unpacked`, a git tag). Not every PR. |

Work inside a phase is `0.x.y`; shipping the phase is the next `0.(x+1).0`.

| State | Version |
| --- | --- |
| Phase 0 done | `0.2.0` |
| Phase 1 done | `0.3.0` |
| Phase 1.3 (Electron line) | `0.3.1` (tagged; not a numbered bump) |
| Phase 1.4 (Windows shortcut labels) | `0.3.2` (tagged; not a numbered bump) |
| Phase 2 done | stayed `0.3.2` (no `0.4.0` tag on this fork) |
| Phase 3 done | `0.4.0` |
| Phase 4 done | `0.5.0` |
| Phase 5 (packaging) | `0.6.0`+ (NSIS / signing / updater as you tag them) |

LSP is parked (see Ideas); it does not get a numbered phase or a minor. There is no Phase 6 until something else earns one. Phase 0.5 does not get a version. Ideas in the parking lot do not get a version until they are pulled into a phase.

---

## Current upstream (what you inherit)

Already useful, keep it:

- Projects, tasks, two-pane tabs, command palette, inbox (`working` / `needs you` / settled / snooze).
- Pi tab type: `pi` command, `--session-id`, bundled status extension (`-e`), hook server.
- Claude/Codex tabs (keep working; not the focus of this fork).
- File tree → Monaco editor (syntax + save, no LSP).
- Git status/diff/commit, worktrees, SSH remotes, embedded browser.

Known gaps this fork must treat as work, not surprises:

- Windows packaging is a portable folder (`npm run build:win` → `dist/win-unpacked`), not a Setup.exe. That folder stays the no-admin escape hatch. An installer is **Phase 5** (electron-builder NSIS, not `electron-winstaller`). From-source `npm install` on Windows still needs admin + VS Build Tools + Spectre libs (see README).
- Local Windows terminals are Git Bash (`Git\bin\bash.exe --login -i`, auto-detect; Settings can set a `bash.exe` path). PowerShell and Command Prompt are not product surfaces. Login-shell env **is** captured in `shell-env.ts`; do not copy that Unix PATH onto `process.env.PATH` (ConPTY `cmd.exe` lookup breaks — see AGENTS.md).
- POSIX assumptions: worktree paths, hook inject (`curl` + `python3`). Remote Pi extension lives under `$HOME/.devtool-remote/` (Phase 2 moved it off `/tmp`).

**Go/no-go:** if Git Bash + ConPTY + Pi TUI is unusable after Phase 0, stop. Nothing else in this plan can paper over a broken terminal.

---

## Phase 0 — Windows + Git Bash + PATH (make-or-break) — done (`0.2.0`)

**Outcome:** unzip-or-dev-run on Windows, open a task, get a Git Bash tab, run `pi` with the user’s existing Pi config, status dot still works.

Work items:

1. **Default shell on Windows** — done.  
   Resolve `Git\bin\bash.exe` (Program Files, user install, `PATH`; prefer `Git\bin` over `usr\bin`). Spawn with `--login -i`. Do not use inherited `SHELL`. Empty `defaultShell` auto-detects Git Bash. Override path is optional. New tabs only. PowerShell / Command Prompt are not Settings options.

2. **Spawn environment** — done for Phase 0.  
   Replace the “skip win32” shell-env path. Build env explicitly:
   - prepend portable Node directory
   - conda env prepend is **Phase 3**, not required for 0.2.0
   Apply the same env to terminal tabs **and** Pi/Claude/Codex tabs. Do not add inference URL/key vars here — Pi already has its own settings.

3. **node-pty** — done.  
   `@electron/rebuild` compiles ConPTY from source. That needs admin + VS 2022 Build Tools + **Spectre-mitigated libs** (`MSB8040` otherwise). Documented in README. Do not disable Spectre. Do not chase `chrome-sandbox` setuid (Linux-only). Locked-down PCs skip compile: consume `npm run build:win` output.

4. **Path and quoting** — done.  
   File-tree relatives and git porcelain use `/`. Worktree + nested project joins use win32 locally. `node-pty` `cwd` stays a Windows absolute path (ConPTY); Git Bash shows `/f/...` itself. Do not feed `/c/Users/...` to CreateProcess.

5. **Hooks on Windows** — done for local.  
   Claude inject uses `curl`. Git Bash usually has it; fail clearly if not. Pi extension is local `-e` (no `/tmp` required for local). SSH remotes can wait until after Phase 0.

6. **Packaging** — done for the portable folder.  
   `npm run build:win` runs `electron-builder --win --dir`. The exe is left unsigned so the build does not need winCodeSign / symlink privileges. Prefer “folder next to a Node zip” for locked-down PCs. This is **run-only**; git checkout + `npm run dev` still needs the VS machine. A per-user NSIS Setup.exe, signing, auto-update, and app icon are **Phase 5** (electron-builder NSIS, not `electron-winstaller`).

**Verify:** done on Windows (`npm run dev` → Git Bash tab → portable Node → Pi TUI + inbox status).

**Closeout:** done. `package.json` is **0.2.0**. License is **MIT** (`LICENSE`; copyright join3r and TeleporterGuy).

**Effort:** about 2–4 focused weeks. Next is Phase 1 (file explorer). Conda is Phase 3.

---

## Phase 0.5 — Do not duplicate Pi’s settings in DevTool — done (no version bump)

**Outcome:** DevTool hosts Pi; inference (models, API, base URL) stays in Pi’s own config. A Pi tab should behave like `pi` already does in Git Bash.

Work items:

- Do **not** add inference URL/key fields to DevTool. — done. Project settings only keep extra CLI flags (`aiToolArgs`).
- Per-project extra `pi` args already exist (`aiToolArgs`); keep that for CLI flags, not for wiring a proxy. — done.
- Keep using the existing Pi status extension; only thicken it if permission prompts are invisible in the inbox. — done (unchanged).

**Closeout:** done. Guardrail held; nothing to ship. `package.json` stays **0.2.0**. Next is Phase 1 (file explorer).

**Effort:** none as a feature. This phase is a guardrail so later work does not grow a second settings UI.

---

## Phase 1 — File explorer that can manage a tree — done (`0.3.0`)

Upstream tree can list and open files. Extend it; do not replace it.

**Outcome:** create / rename / delete files and folders, plus a quick filter in the Files panel. Optional: reveal in Git Bash.

Stay out of: full project search, git graph (see Ideas), VS Code-style explorer features. Handing the **folder** to an external IDE is Phase 1.2, not an in-app IDE.

Work items:

1. **CRUD** — create, rename, and delete files and folders from the Files tree (local projects only). **Landed.**
2. **Filter** — session filter box in the Files panel. **Landed.** (A per-project ignore list was added then removed.)
3. **Reveal in Git Bash** — open a terminal tab whose cwd is that folder. **Landed.**

**Verify:** done on Windows (CRUD / filter / 1.1 toolbar; Open in Cursor and VS Code for small folders and a large git repo). If VS Code seems to do nothing, leftover `Code.exe` processes can already own that folder — quit them in Task Manager and retry.

**Closeout:** done. Phase 1 shipped as **0.3.0**. Phase 1.3 tagged **0.3.1**. Phase 1.4 tagged **0.3.2**. Next is Phase 2 (hook auth + SSH trust). Conda is Phase 3.

**Effort:** 1–2 weeks. Mid-phase **0.2.2** / **0.2.3** followed 1.1 polish. Shipped as **0.3.0** after Windows verify.

---

## Phase 1.1 — Files panel polish (mid-phase)

Not a new numbered phase. Same explorer; small UX follow-ups before `0.3.0`.

Work items:

1. **New file / New folder toolbar** — icon buttons above the filter (VS Code-like; room to add more later). **Landed.**
2. **Reconsider the ignore list** — dropped. The Files tree lists every name, including `.env` / `.git`.

Shipped in **0.3.0**.

---

## Phase 1.2 — Open workspace in an external IDE (mid-phase) — landed

Not a new numbered phase. Same explorer closeout in `0.3.0`: DevTool hosts Pi and the tree; heavier editing happens in the user’s real IDE. This is a **handover**, not a fourth Files/Git/Notes view.

**Chrome:** one control in the **content toolbar** — the row that already has Files, Git, Notes (and the split-pane toggle). Sit it in that cluster, after the panel tabs and before the split button. Click = configured default editor; chevron = other configured editors. It is an action (spawn and leave), so it must not look like a panel tab. Icon: Lucide `ExternalLink` (box + arrow **up-right**), tooltip “Open in {default}”. Secondary: folder context menu next to Reveal in Git Bash, and palette commands (`Open in Cursor`, …). Local projects only. Open the **project folder** (task worktree when that is the cwd), not a single file. **Landed.**

**Settings (required).** Today Settings has Appearance / Terminal / Editor & Diff / AI Tools / Sidebar / Tasks. Editor & Diff is Monaco-only (“Applies to Monaco-backed file editor and diff tabs”). Do **not** overload that copy. Add a second group on that same tab — **External IDEs** — or a small extra settings tab if the list UI needs room. No new Settings category for two binaries.

Minimum fields (same pattern as Git Bash path + Browse on the Terminal tab):

- List of editors: display name, executable path, optional extra args.
- Which one is the **default**.
- Browse (pick the `.exe`) and a **Detect** action for `code` / `cursor` on PATH (VS Code / Cursor first cut).
- Hide or disable the toolbar control when the list is empty, with a tooltip that points at Settings.

Persist on `AppConfig` (app-wide, not per-project). Spawn the process with the folder as the argument (`code <abs-path>` / `cursor <abs-path>`). Do not invent protocol-URL settings unless Detect needs them.

**Spyder** is a conda CLI in the project env. Out of 1.2; pick it up after Phase 3.

**Effort:** small spawn + Settings list + one toolbar split button. Landed in `0.2.y`; shipped in **0.3.0** after Windows verify. Spawn `Code.exe` / `Cursor.exe` (not `cursor.cmd`). If a large repo does not appear in VS Code, quit leftover `Code.exe` processes and retry.

---

## Phase 1.3 — Supported Electron line + blank browser tab (mid-phase) — done (`0.3.1`)

Not a new numbered phase. Tagged **`0.3.1`** after Windows verify. `package.json` minor stays **0.3** until Phase 2.

**Outcome:** `npm run dev` and `npm run build:win` run Electron **43.6.0**. A new browser tab is `about:blank`, not Google. The in-app **webview stays**.

Work items:

1. **Supported major** — landed. Electron **35.7.5 → 43.6.0**. `node-pty` rebuilds via `@electron/rebuild` (direct dep) and a `node-abi` override. `allowScripts` pin is `electron@43.6.0`. `ensure-electron.mjs` runs `install.js` because Electron 42+ skips its own postinstall download.

2. **Keep the webview; guest pages do not get Node** — landed. Explicit `contextIsolation` / `nodeIntegration: false` on the DevTool UI window. `will-attach-webview` strips guest preload/Node. `<webview webpreferences="… nodeIntegration=no …">`. Packaged DevTools stay. CSP still out.

3. **Default browser page is blank** — landed. `BLANK_BROWSER_URL` / `about:blank`. Bare hosts still become `https://…`. Old tabs that stored Google keep that URL until navigated away.

4. **Signing stays considered, not required** — unchanged. `signAndEditExecutable: false`.

**Verify:** done on Windows (`npm install` → `npm run dev` → Git Bash → Pi TUI + hook status dot → blank Browser tab + navigate → Open in VS Code). SSH not part of this closeout. `npm run build:win` is the tagged copy.

**Closeout:** done. `package.json` was **0.3.1**. Next was Phase 1.4 (Windows shortcut labels), then Phase 2 (hooks + SSH).

---

## Phase 1.4 — Windows shortcut map and labels (mid-phase) — done (`0.3.2`)

Not a new numbered phase. Tagged **`0.3.2`**. `package.json` minor stays **0.3** until Phase 2. The Electron menu already uses `CmdOrCtrl`; this is the **visible** map, not new bindings.

**Outcome:** every shortcut that already exists is listed once (menu, palette, tooltips, tab chrome, settings copy) with its **Windows** equivalent, and the UI on Windows shows that map. No new shortcuts. Do not invent a keybinding editor.

Work items:

1. **Inventory what is already bound.** **Landed.** Menu accelerators in `src/main/index.ts`, renderer handlers (`ContentArea`, editor save/preview, palette), and hardcoded ⌘ copy (tab bar, Settings, Browser tab). Files/Git chrome had none.

2. **Visualize Windows keys in the UI.** **Landed.** `src/shared/shortcut-label.ts` formats Electron accelerators. On `win32`, tooltips, palette rows, and titles use `Ctrl` / `Alt` / `Shift`. macOS keeps ⌘. Open Settings stays Mac-only (`Cmd+,`); the palette does not claim `Ctrl+,` on Windows.

Stay out of: remapping, user-defined keys, PowerShell chords, teaching Git Bash its own readline bindings.

**Verify:** labels covered in unit tests on Windows (`Ctrl+W` / `Ctrl+T` / `Ctrl+D` chrome, palette `Ctrl+B`, Open Settings has no `⌘,`). Bindings unchanged.

**Closeout:** done. `package.json` is **0.3.2**. Next is Phase 2 (hooks + SSH).

**Effort:** a short pass. Tagged **0.3.2**.

---

## Phase 2 — Hook authentication + SSH trust — done (`0.3.2`, no minor bump)

Completely new session. Do not mix this with the Electron bump. Landed as a patch on **`0.3.2`** (no numbered bump). **`0.4.0`** is Phase 3 (conda).

The inbox status dot is a local HTTP server (`src/main/hook-server.ts`) on `127.0.0.1` plus, for remotes, `ssh -R` to that port. Pi’s remote helper is written under `$HOME/.devtool-remote/`. SSH uses the user’s `~/.ssh/known_hosts` and `accept-new` for first connect; Remote directory is required. Details: [SECURITY.md](./SECURITY.md).

**Outcome:** a random local process (or a process on the SSH host) cannot spoof inbox events without a secret DevTool minted. Remote Pi code is not planted via `/tmp`. New SSH sessions use `~/.ssh/known_hosts` (no DevTool `UserKnownHostsFile` / `IdentitiesOnly`) and a `0700` control-socket directory.

Work items:

1. **Hook shared secret.** **Landed.** Per-process token when the hook server starts. Pi extension and Claude `curl` hooks send `X-Devtool-Token`. Server rejects POSTs without it (401). Body capped at 64 KiB (413). Bind stays `127.0.0.1`. The reverse forward stays — the secret is what makes a shared remote less able to spoof the inbox.

2. **Pi extension off `/tmp`.** **Landed.** Write `pi-status-extension.mjs` under `$HOME/.devtool-remote/` with directory mode `0700`. Claude remote inject stays in `remoteDir/.claude/` (never `/tmp`). Local `-e` path is already asar-unpacked; left as-is.

3. **SSH (join3r follow-up `ec077fc`).** **Landed, then aligned with upstream.** Control-socket dir `<config dir>/ssh` is still `0700`. Host keys use `~/.ssh/known_hosts` (`StrictHostKeyChecking=accept-new`; a *changed* key fails with a message that names that file). No `IdentitiesOnly`. Remote directory is required (no `$HOME` probe / `projects.json` write-back). A full SSH CA can wait for a company install.

Stay out of: config-dir `0700` for all of `~/.devtool`, scrollback `tabId` sanitizing, IPC cwd allow-list (deferred). Stay out of conda.

**Verify:** unit tests cover 401/413, remote Pi path, `~/.ssh/known_hosts` / no `IdentitiesOnly`, required remote dir, and 0700 sockets. Local Pi/Claude status dots and a Windows Git Bash pass still need a machine check.

**Closeout:** landed. `package.json` stays **0.3.2** (no numbered bump this pass). Next is Phase 3 (conda spawn picker).

**Effort:** about a week. Windows + Git Bash local hooks, then one Linux SSH box.

---

## Phase 3 — Conda as a spawn picker — done (`0.4.0`)

Was Phase 2. **Outcome:** pick an env per project. Every local PTY inherits it (later Jupyter children too). No env-create/delete UI.

Work items:

1. **Detect conda** — done. Anaconda / Miniconda / Miniforge / micromamba via `CONDA_EXE` / PATH / well-known install dirs (including when Electron's PATH is thin).
2. **List + persist** — done. Project Settings dropdown on local projects; value is the env **prefix** (unique), label is the name. Persist `condaEnvPrefix` plus `condaEnvName`. Remote and shell-command projects stay out (those PTYs are not a local conda).
3. **Activate** — dual path, not PATH-prepend only.

   - **Pi / Claude / Codex** (spawned as binaries, not through Git Bash): PATH prepend + `CONDA_*`, same pattern as Settings → Node directory. Do **not** `eval "$(conda shell.bash hook)"` — that hook would miss CreateProcess agent tabs. Prepend env dirs first (`prefix`, Windows `Library\\…\\bin` / `Scripts` / `bin`, Unix `prefix/bin`), then install `condabin`/`Scripts` so `conda.exe` still resolves when the shell function is missing. Sets `CONDA_PREFIX` / `CONDA_DEFAULT_ENV` only when the prefix still looks like a conda env and at least one PATH dir exists. Portable Node stays **first**.
   - **Interactive terminals**: login shell still runs (conda init often `conda activate base`), then wrap with `conda activate` for the project env (`CONDA_AUTO_ACTIVATE_BASE=false`). macOS: `zsh -l -i -c '…; exec zsh -i'`. Windows Git Bash: `bash --login -i -c` then `exec bash --rcfile <Node mkdtemp file> -i` so conda init in `.bash_profile` is not dropped by a non-login inner shell. The rcfile is created from Node; if temp creation fails the wrap is skipped (fail closed — no guessable `$$` path).

   Spawn prefers a still-valid saved prefix; name lookup is a fallback and is unique-only (Windows case-insensitive only when a single env matches). Apply to terminal **and** agent tabs (project id is passed on local spawn). Later Jupyter children can reuse `getShellEnv(..., { condaEnv })`.

**Verify:** unit tests cover detection, `conda env list --json` / filesystem listing, dead cache vs live prefix, Windows PATH order, Node-dir remaining first, `process.env.PATH` not overwritten, Windows wrap script never embedding a `$$` temp name, and Project Settings saving prefix+name. `which python` / `python -c "import sys; print(sys.prefix)"` in a Windows Git Bash tab is a **human check still required**.

**Known limits**

- Older macOS conda init can hardcode `conda activate base` after the inner `exec zsh -i`; the wrap sources `conda.sh` again before activate, but exotic rc files may still fight it.
- Env deleted or renamed after save: spawn ignores a dead prefix (then unique name / null). Settings keeps a “(saved)” option until refresh.
- Pi/Claude/Codex are PATH + `CONDA_*` only — packages that need `etc/conda/activate.d` hooks may differ from a fully activated terminal.
- micromamba-only: list and PATH prepend can work while shell `conda activate` no-ops (`micromamba activate` is tried; still fail-soft).
- Custom installs outside well-known roots need `conda env list`, `~/.conda/environments.txt`, or PATH/`CONDA_EXE`.
- Already-open tabs keep the old env until a **new** tab.

**Closeout:** done. `package.json` is **0.4.0**. Next is Phase 4 (Jupyter via the browser tab). Spyder as an external IDE can follow this, still out of 1.2.

**Effort:** 1–2 weeks. Windows + Git Bash activation is the only tricky part. Ships as **`0.4.0`**.

---

## Phase 4 — Jupyter via the browser tab

Was Phase 3. **Outcome:** command “Open JupyterLab for this project” starts (or reuses) a server in the conda env and opens an existing **browser tab**. SOCKS/SSH later if needed.

Do **not** build a native notebook editor here. The browser tab is still the Phase 1.3 webview (blank default, no Node in the guest). There is no Phase 4.5. Native `.ipynb` stays in the parking lot until JupyterLab-in-browser has been tried and is still not enough.

**Effort:** days to a week if conda spawn works. Ships as **`0.5.0`**.

---

## Phase 5 — Packaging / distribution

Was going to sit behind language servers as a later phase. LSP is parked, so packaging is the next numbered phase. **Packaging only.** Native `.ipynb` is not a gate and is not scheduled here.

**Outcome:** Windows users who cannot `npm install` get a real install path, without dropping the portable folder. App no longer looks like stock Electron.

Work items, in this order:

1. **Keep the portable folder.** `npm run build:win` → `dist/win-unpacked` stays the no-admin escape hatch. Do not delete it when an installer lands. Recipients who cannot run Setup.exe still copy a folder and run `DevTool.exe`.
2. **NSIS Setup.exe** via electron-builder (`--win nsis`, not `electron-winstaller`). Default **per-user** (no admin), Start Menu shortcut. Machine-wide / Program Files is optional later, not the default.
3. **Authenticode signing** after the installer exists. Unsigned Setup.exe is a worse first impression than an unsigned folder; do not ship NSIS as the recommended path until signing is in reach, unless IT already accepts unsigned.
4. **Auto-update** (GitHub Releases + electron-updater, or equivalent) after signing. Unsigned auto-update is not worth it.
5. **App icon** — replace the Electron/default icon on the exe, installer, and Start Menu.

Software Center / MSI may be a **separate IT artifact**, not this phase’s default output.

Stay out of: native notebook editor, language servers, conda GUI, a second Windows shell.

**Effort:** installer first is days to a couple of weeks; signing + updater depend on the certificate. Ships as **`0.6.0`+** (tag slices as you actually copy them).

---

## Ideas (not sequenced)

Parking lot. Do not start these instead of the numbered phases. Several items already have a home:

| Idea | Where it lives |
| --- | --- |
| Supported Electron line + blank browser tab | Phase 1.3 |
| Map existing shortcuts and show Windows keys (Ctrl, not ⌘) | Phase 1.4 |
| Hook auth + Pi off `/tmp` + SSH via `~/.ssh/known_hosts` (required remote dir) | Phase 2 |
| Conda env on spawn | Phase 3 |
| JupyterLab in a browser tab | Phase 4 |
| Language servers (Python, Markdown) | Parked. Monaco covers edit/view; analysis belongs in Pi. Optional sugar only if Monaco-without-Pi is painful. No minor reserved. |
| Native notebook cells + kernel | Parked. After Phase 4, only if JupyterLab-in-browser is still not enough. Not a gate. Not Phase 4.5. Not packaging. |
| Windows installer + Authenticode + auto-update + app icon | Phase 5 |
| Open workspace in VS Code / Cursor | Phase 1.2 |
| Spyder as an external IDE | after Phase 3 |
| Config-dir `0700`, scrollback id, IPC cwd allow-list | Parking lot (deferred; not packaging) |
| Machine-wide / Program Files install | Optional later; Phase 5 default is per-user NSIS |
| Software Center / MSI | Separate IT artifact, not the Phase 5 default |

**Language servers (Python and Markdown).** Parked, not a numbered phase. Monaco already highlights and saves. Hover / go-to / complete would be sugar; diagnostics and deeper analysis belong in Pi extensions. A spike (`monaco-languageclient` + JSON-RPC stdio, `pylsp` or `pyright` in the same conda env, Windows paths that round-trip) is only worth it if people are living in Monaco without a Pi tab. Out of scope even then: every language, debugger, refactor-rename-across-repo, duplicating Pi-quality diagnostics. No minor is reserved for this. Phase 5 is packaging, not LSP.

**Native `.ipynb` cells in a tab** (kernel via `jupyter_client` in the conda env). Parked. The product bet is Jupyter as a browser tab (Phase 4). Revisit only after that is daily-driver and still not enough. Do not schedule a Phase 4.5 to sneak it in before packaging.

**TypeScript/JavaScript LSP** if the Node zip is the runtime. Same parking lot as Python/Markdown LSP, not a follow-on phase.

**Windows OpenSSH** for the existing remote-project flow (separate from Git Bash local). Parking lot.

**Search-in-files, extra pane layouts.** Parking lot.

**Git tree.** A branch/commit graph in the UI (log, parents, maybe checkout). Useful for “where am I” without leaving DevTool. Phase 1 explicitly stays out of a git graph so the file explorer does not grow into an IDE. If it happens, it is later-maybe: read-only first, no rebase UI. Not packaging. No Phase 6 until something earns it.

**Generate commit message with a specified agent.** Pre-fill the existing git commit box from Pi (or Claude/Codex) given the staged diff. Low confidence this needs a DevTool feature: you can already ask Pi in a tab to write the message and paste it. Only worth it if the commit UI is used a lot and the round-trip is annoying. Prefer “use the project’s default agent” over a per-commit picker.

**Open this workspace in an external IDE.** Sequenced as **Phase 1.2**. Spyder waits for conda (Phase 3).

Explicit non-goals unless the product bet changes: cloud VMs, embedding Pi’s UI, replacing Pi extensions with Electron linters, PowerShell, full Windows “IDE.”

---

## Suggested order of PRs / commits on this fork

Keep upstream `master` as a remote (`upstream`) and rebase or merge periodically. Land work in this order so each PR is demoable:

1. Windows shell resolution + Git Bash PTY + documented rebuild. **Done** (Git Bash default + Settings presets; portable Node PATH and rebuild docs landed earlier).
2. Configurable spawn PATH (portable Node) + env passthrough. **Done.**
3. Win dir packaging notes / script. **Done.** (`npm run build:win` → `dist/win-unpacked`.) Keep this folder when Phase 5 adds an installer.
4. File explorer CRUD. **Done** in `0.3.0` (filter, Reveal in Git Bash, 1.1 toolbar, 1.2 external IDE handover; ignore list removed).
5. Open workspace in external IDE (Phase 1.2: toolbar split button + Settings list). **Done** in `0.3.0`.
6. Supported Electron line + blank browser tab (Phase 1.3). **Done** in `0.3.1`.
7. Windows shortcut map + labels (Phase 1.4). **Done** in `0.3.2`.
8. Hook authentication + SSH trust (Phase 2). **Done** in `0.3.2` (no minor bump).
9. Conda env picker on spawn (Phase 3). **Done** in `0.4.0`.
10. JupyterLab browser-tab launcher (Phase 4). Ships as `0.5.0`.
11. Packaging (Phase 5): keep portable `dist/win-unpacked`, then per-user NSIS Setup.exe + Start Menu, then Authenticode, then auto-update, app icon. Ships as `0.6.0`+. Do not insert native notebooks or LSP between 10 and 11.

Skip a step only if the previous phase already includes it by accident (e.g. PATH work that makes conda trivial).

---

## How to work on this fork

Work happens **only** on this repository: [TeleporterGuy/DevTool](https://github.com/TeleporterGuy/DevTool). Do not open pull requests against [join3r/claude-project](https://github.com/join3r/claude-project). If a PR is created (local, GitHub, Cursor cloud, or any other agent), its base must be **this fork** (`origin`, usually `master` or a branch on TeleporterGuy/DevTool).

Fetching upstream is for optionally merging their changes in, not for contributing back.

```text
GitHub (origin):  https://github.com/TeleporterGuy/DevTool
Local:            this tree
Upstream (read):  https://github.com/join3r/claude-project
```

```bash
git remote add upstream https://github.com/join3r/claude-project.git
git fetch upstream
```

Upstream will keep moving on macOS/Linux agent-host features. Prefer merging `upstream/master` after Phase 0 so Windows fixes do not bit-rot. If a merge fights POSIX-only code, isolate Windows behind `process.platform === 'win32'` rather than forking every file.

Work machine constraints to re-test every phase: Git Bash, portable Node zip, Pi (whatever setup already works in a Git Bash terminal), conda. Do not declare a phase done from macOS alone.

---

## Effort snapshot (solo, evenings, one Windows box)

| Phase | Ships as | What “done” means | Rough time |
| --- | --- | --- | --- |
| 0 | `0.2.0` (shipped) | Git Bash + Pi in DevTool on Windows | 1–2 months calendar / 2–4 weeks focused |
| 0.5 | (no bump, done) | No DevTool inference UI (Pi keeps its settings) | n/a |
| 1 | `0.3.0` (shipped) | File tree CRUD + 1.2 external IDE handover | 1–2 weeks |
| 1.3 | `0.3.1` (shipped) | Supported Electron + blank browser tab (webview stays) | a few evenings to a week |
| 1.4 | `0.3.2` (shipped) | Existing shortcuts listed and shown as Windows keys | a short pass |
| 2 | stayed `0.3.2` (no `0.4.0` tag) | Hook secret + Pi extension off `/tmp`; SSH uses `~/.ssh/known_hosts` | ~1 week |
| 3 | `0.4.0` (shipped) | Conda picker on spawn | 1–2 weeks |
| 4 | `0.5.0` | JupyterLab in a browser tab | days |
| 5 | `0.6.0`+ | Portable folder kept; per-user NSIS Setup.exe; then Authenticode; then auto-update; app icon | installer in days–weeks; signing/updater depend on the cert |

Language servers and native notebooks stay in the parking lot. They are not numbered phases. There is no Phase 6 until something else earns one.

A year of evenings can yield a personal orchestrator. It will not become Cursor. That is success.
