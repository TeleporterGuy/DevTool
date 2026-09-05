# Fork roadmap: Windows orchestrator for Pi

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project) (DevTool). join3r has said this fork may be modified freely. Upstream is a macOS/Linux **task multiplexer** for CLI coding agents (Claude Code, Codex, Pi), with SSH, git worktrees, and an inbox. It is not an IDE and not an agent runtime.

This fork keeps that orchestrator model, with **Pi** as the primary agent and Pi’s own settings preserved and first-class in the app. The aim is to make it **primarily for Windows**: Git Bash, a portable Node zip, conda environments, Jupyter, and a small set of language servers (Python and Markdown). Linting and similar agent tools stay in **Pi extensions**.

Do not try to become VS Code or Cursor. If a feature belongs in Pi, put it in Pi.

---

## Product bet (do not revisit every phase)

- **Host**, do not replace, the agent. Pi remains a CLI TUI in a tab.
- **No VMs.** Local disk + existing SSH to Linux boxes is enough.
- **Git Bash** is the only first-class Windows shell. No PowerShell. `cmd.exe` is a last-resort fallback, not a product surface.
- **Environments are spawn-time PATH/env**, not a conda GUI and not a Node version manager UI. Settings **Node directory** is a folder prepend, not a requirement for `DevTool.exe` to launch.
- **Pi owns inference.** Models, API, and base URL stay in Pi’s config. Do not add those fields to DevTool.
- **LSP is optional sugar** (hover, go-to, complete) for a small set: Python and Markdown. Diagnostics can stay in Pi.
- **Jupyter starts as a browser tab** against a local JupyterLab. Native `.ipynb` is a later phase, not a gate.

---

## Current upstream (what you inherit)

Already useful, keep it:

- Projects, tasks, two-pane tabs, command palette, inbox (`working` / `needs you` / settled / snooze).
- Pi tab type: `pi` command, `--session-id`, bundled status extension (`-e`), hook server.
- Claude/Codex tabs (keep working; not the focus of this fork).
- File tree → Monaco editor (syntax + save, no LSP).
- Git status/diff/commit, worktrees, SSH remotes, embedded browser.

Known gaps this fork must treat as work, not surprises:

- Windows packaging is a portable folder (`npm run build:win` → `dist/win-unpacked`), not a Setup.exe. `electron-winstaller` stays unapproved until an installer is required. From-source `npm install` on Windows still needs admin + VS Build Tools + Spectre libs (see README).
- Local Windows terminals default to Git Bash (`Git\bin\bash.exe --login -i`, auto-detect; Settings can pick PowerShell/cmd or a `bash.exe` path). Login-shell env **is** captured in `shell-env.ts`; do not copy that Unix PATH onto `process.env.PATH` (ConPTY `cmd.exe` lookup breaks — see AGENTS.md).
- POSIX assumptions: worktree paths, hook inject (`curl` + `python3`), remote Pi extension under `/tmp/...`.
- README still mentions OpenCode; code has Pi, not OpenCode.

**Go/no-go:** if Git Bash + ConPTY + Pi TUI is unusable after Phase 0, stop. Nothing else in this plan can paper over a broken terminal.

---

## Phase 0 — Windows + Git Bash + PATH (make-or-break)

**Outcome:** unzip-or-dev-run on Windows, open a task, get a Git Bash tab, run `pi` with the user’s existing Pi config, status dot still works.

Work items:

1. **Default shell on Windows** — done.  
   Resolve `Git\bin\bash.exe` (Program Files, user install, `PATH`; prefer `Git\bin` over `usr\bin`). Spawn with `--login -i`. Do not use inherited `SHELL`. Settings: Git Bash / PowerShell / Command Prompt; empty `defaultShell` auto-detects Git Bash. Override path is optional. New tabs only.

2. **Spawn environment**  
   Replace the “skip win32” shell-env path. Build env explicitly:
   - prepend portable Node directory
   - prepend selected conda env (`Scripts` / `Library/bin` as needed)
   Apply the same env to terminal tabs **and** Pi/Claude/Codex tabs. Do not add inference URL/key vars here — Pi already has its own settings.

3. **node-pty**  
   `@electron/rebuild` compiles ConPTY from source. That needs admin + VS 2022 Build Tools + **Spectre-mitigated libs** (`MSB8040` otherwise). Documented in README. Do not disable Spectre. Do not chase `chrome-sandbox` setuid (Linux-only). Locked-down PCs skip compile: consume `npm run build:win` output.

4. **Path and quoting**  
   Audit cwd, worktrees, file-browser reads, git IPC for `\` vs `/`. Git Bash wants Unix-style paths for `cwd` where possible (`/c/Users/...`).

5. **Hooks on Windows**  
   Claude inject uses `curl`. Git Bash usually has it; fail clearly if not. Pi extension is local `-e` (no `/tmp` required for local). SSH remotes can wait until after Phase 0.

6. **Packaging**  
   `npm run build:win` runs `electron-builder --win --dir` (portable folder). Approve `electron-winstaller` only if an installer is required. Prefer “folder next to a Node zip” for locked-down PCs. This is **run-only**; git checkout + `npm run dev` still needs the VS machine.

**Verify:** `npm run dev` on Windows → Git Bash tab → `node -v` from the zip → `pi` TUI draws and uses the same models/setup as a normal Git Bash `pi` → inbox status on `agent_start` / `agent_end`.

**Effort:** about 2–4 focused weeks. Do not start Phase 2+ until this is true on Windows, not only on macOS/Linux.

---

## Phase 0.5 — Do not duplicate Pi’s settings in DevTool

**Outcome:** DevTool hosts Pi; inference (models, API, base URL) stays in Pi’s own config. A Pi tab should behave like `pi` already does in Git Bash.

Work items:

- Do **not** add inference URL/key fields to DevTool.
- Per-project extra `pi` args already exist (`aiToolArgs`); keep that for CLI flags, not for wiring a proxy.
- Keep using the existing Pi status extension; only thicken it if permission prompts are invisible in the inbox.

**Effort:** none as a feature. This phase is a guardrail so later work does not grow a second settings UI.

---

## Phase 1 — File explorer that can manage a tree

Upstream tree can list and open files. Extend it; do not replace it.

**Outcome:** create / rename / delete files and folders, sensible ignore, quick filter. Optional: reveal in Git Bash.

Stay out of: full project search, git graph, VS Code-style explorer features.

**Effort:** 1–2 weeks.

---

## Phase 2 — Conda as a spawn picker

**Outcome:** pick an env per project (or task). Every PTY and later LSP/Jupyter child inherits it. No env-create/delete UI.

Work items:

- Detect `conda` (Anaconda / Miniconda / micromamba if easy).
- List envs, persist name on the project.
- Activate the Git Bash way: `eval "$(conda shell.bash hook)"` + `conda activate <name>`, or prepend env paths. Prefer one method and test with `which python` / `python -c "import sys; print(sys.prefix)"`.

**Effort:** 1–2 weeks. Windows + Git Bash activation is the only tricky part.

---

## Phase 3 — Jupyter via the browser tab

**Outcome:** command “Open JupyterLab for this project” starts (or reuses) a server in the conda env and opens an existing **browser tab**. SOCKS/SSH later if needed.

Do **not** build a native notebook editor here.

**Effort:** days to a week if conda spawn works.

---

## Phase 4 — Language servers (Python and Markdown)

**Outcome:** Monaco talks to a small set of servers — Python (`pylsp` or `pyright` in the **same conda env** as the terminals) and Markdown. Hover, go-to-definition, completion. Windows paths must round-trip.

Out of scope: every language, debugger, refactor-rename-across-repo, Pi-quality diagnostics duplication.

Stack hint: `monaco-languageclient` + JSON-RPC stdio. Kill the server when the project/env changes.

**Effort:** 1–3 months for “actually usable,” not “hello world.” Only start after Phases 0–2 are daily-driver quality.

---

## Phase 5 — Later, maybe

Only after the above is boring and stable:

- Native `.ipynb` cells in a tab (kernel via `jupyter_client` in the conda env).
- TypeScript/JavaScript LSP if the Node zip is the runtime.
- Windows OpenSSH for the existing remote-project flow (separate from Git Bash local).
- Search-in-files, extra pane layouts.

Explicit non-goals unless the product bet changes: cloud VMs, embedding Pi’s UI, replacing Pi extensions with Electron linters, PowerShell, full Windows “IDE.”

---

## Suggested order of PRs / commits on this fork

Keep upstream `master` as a remote (`upstream`) and rebase or merge periodically. Land work in this order so each PR is demoable:

1. Windows shell resolution + Git Bash PTY + documented rebuild. **Done** (Git Bash default + Settings presets; portable Node PATH and rebuild docs landed earlier).
2. Configurable spawn PATH (portable Node) + env passthrough.
3. Win dir packaging notes / script.
4. File explorer CRUD.
5. Conda env picker on spawn.
6. JupyterLab browser-tab launcher.
7. Python and Markdown LSP spike, then harden.

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

| Phase | What “done” means | Rough time |
| --- | --- | --- |
| 0 | Git Bash + Pi in DevTool on Windows | 1–2 months calendar / 2–4 weeks focused |
| 0.5 | No DevTool inference UI (Pi keeps its settings) | n/a |
| 1 | File tree CRUD | 1–2 weeks |
| 2 | Conda picker on spawn | 1–2 weeks |
| 3 | JupyterLab in a browser tab | days |
| 4 | Usable Python and Markdown LSPs | 1–2 months |
| 5 | Native notebooks / extra LSPs | open-ended |

A year of evenings can yield a personal orchestrator. It will not become Cursor. That is success.
