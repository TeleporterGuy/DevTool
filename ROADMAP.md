# Fork roadmap: Windows orchestrator for Pi

This repository is a fork of [join3r/claude-project](https://github.com/join3r/claude-project) (DevTool). join3r has said this fork may be modified freely. Upstream is a macOS/Linux **task multiplexer** for CLI coding agents (Claude Code, Codex, Pi), with SSH, git worktrees, and an inbox. It is not an IDE and not an agent runtime.

This fork keeps that orchestrator model, with **Pi** as the primary agent and Pi’s own settings preserved and first-class in the app. The aim is to make it **primarily for Windows**: Git Bash, a portable Node zip, conda environments, Jupyter, and a small set of language servers (Python and Markdown). Linting and similar agent tools stay in **Pi extensions**.

Do not try to become VS Code or Cursor. If a feature belongs in Pi, put it in Pi.

---

## Product bet (do not revisit every phase)

- **Host**, do not replace, the agent. Pi remains a CLI TUI in a tab.
- **No VMs.** Local disk + existing SSH to Linux boxes is enough.
- **Git Bash** is the only Windows shell for interactive tabs. No PowerShell. No Command Prompt. (`cmd.exe` may still wrap `pi.cmd` for ConPTY; that is not a product terminal.)
- **Environments are spawn-time PATH/env**, not a conda GUI and not a Node version manager UI. Settings **Node directory** is a folder prepend, not a requirement for `DevTool.exe` to launch.
- **Pi owns inference.** Models, API, and base URL stay in Pi’s config. Do not add those fields to DevTool.
- **LSP is optional sugar** (hover, go-to, complete) for a small set: Python and Markdown. Diagnostics can stay in Pi.
- **Jupyter starts as a browser tab** against a local JupyterLab. Native `.ipynb` is a later phase, not a gate.

---

## Versioning (`0.x.y`)

Stay on **0.x** until the app is something you would tell a friend to unzip. **1.0.0** is that call, not “Phase 5 finished.”

`package.json` is **0.2.0** (Phase 0 done). Shape:

| Part | Meaning |
| --- | --- |
| `0` | Pre-1.0. Breaking changes are allowed. |
| `x` (minor) | Bump when a **numbered phase is done**. |
| `y` (patch) | Bump for a **mid-phase build** you would actually copy (`dist/win-unpacked`, a git tag). Not every PR. |

Work inside a phase is `0.x.y`; shipping the phase is the next `0.(x+1).0`.

| State | Version |
| --- | --- |
| Phase 0 done | `0.2.0` |
| Phase 1 in progress / done | `0.2.y` → `0.3.0` |
| Phase 2 done | `0.4.0` |
| Phase 3 done | `0.5.0` |
| Phase 4 done | `0.6.0` |
| Phase 5 slices | keep bumping `0.6.y` / `0.7.0` as you tag them |

Phase 0.5 does not get a version. Ideas in the parking lot do not get a version until they are pulled into a phase.

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
- Local Windows terminals are Git Bash (`Git\bin\bash.exe --login -i`, auto-detect; Settings can set a `bash.exe` path). PowerShell and Command Prompt are not product surfaces. Login-shell env **is** captured in `shell-env.ts`; do not copy that Unix PATH onto `process.env.PATH` (ConPTY `cmd.exe` lookup breaks — see AGENTS.md).
- POSIX assumptions: worktree paths, hook inject (`curl` + `python3`), remote Pi extension under `/tmp/...`.

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
   - conda env prepend is **Phase 2**, not required for 0.2.0
   Apply the same env to terminal tabs **and** Pi/Claude/Codex tabs. Do not add inference URL/key vars here — Pi already has its own settings.

3. **node-pty** — done.  
   `@electron/rebuild` compiles ConPTY from source. That needs admin + VS 2022 Build Tools + **Spectre-mitigated libs** (`MSB8040` otherwise). Documented in README. Do not disable Spectre. Do not chase `chrome-sandbox` setuid (Linux-only). Locked-down PCs skip compile: consume `npm run build:win` output.

4. **Path and quoting** — done.  
   File-tree relatives and git porcelain use `/`. Worktree + nested project joins use win32 locally. `node-pty` `cwd` stays a Windows absolute path (ConPTY); Git Bash shows `/f/...` itself. Do not feed `/c/Users/...` to CreateProcess.

5. **Hooks on Windows** — done for local.  
   Claude inject uses `curl`. Git Bash usually has it; fail clearly if not. Pi extension is local `-e` (no `/tmp` required for local). SSH remotes can wait until after Phase 0.

6. **Packaging** — done.  
   `npm run build:win` runs `electron-builder --win --dir` (portable folder). The exe is left unsigned so the build does not need winCodeSign / symlink privileges. Approve `electron-winstaller` only if an installer is required. Prefer “folder next to a Node zip” for locked-down PCs. This is **run-only**; git checkout + `npm run dev` still needs the VS machine.

**Verify:** done on Windows (`npm run dev` → Git Bash tab → portable Node → Pi TUI + inbox status).

**Closeout:** done. `package.json` is **0.2.0**. License is **MIT** (`LICENSE`; copyright join3r and TeleporterGuy).

**Effort:** about 2–4 focused weeks. Next is Phase 1 (file explorer). Conda is Phase 2.

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

## Phase 1 — File explorer that can manage a tree

Upstream tree can list and open files. Extend it; do not replace it.

**Outcome:** create / rename / delete files and folders, plus a quick filter in the Files panel. Optional: reveal in Git Bash.

Stay out of: full project search, git graph (see Ideas), VS Code-style explorer features.

Work items:

1. **CRUD** — create, rename, and delete files and folders from the Files tree (local projects only). **Landed.**
2. **Filter** — session filter box in the Files panel. **Landed.** (A per-project ignore list was added then removed.)
3. **Reveal in Git Bash** — open a terminal tab whose cwd is that folder. **Landed.**

**Effort:** 1–2 weeks. Mid-phase **0.2.2** follows 1.1 polish. Ships as **0.3.0** when verified on Windows.

---

## Phase 1.1 — Files panel polish (mid-phase)

Not a new numbered phase. Same explorer; small UX follow-ups before `0.3.0`.

Work items:

1. **New file / New folder toolbar** — icon buttons above the filter (VS Code-like; room to add more later). **Landed.**
2. **Reconsider the ignore list** — dropped. The Files tree lists every name, including `.env` / `.git`.

`package.json` is **0.2.3**. **0.3.0** still waits on Windows verify of the full Phase 1 explorer.

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

## Ideas (not sequenced)

Parking lot. Do not start these instead of the numbered phases. Several items already have a home:

| Idea | Where it lives |
| --- | --- |
| Conda env on spawn | Phase 2 |
| JupyterLab in a browser tab | Phase 3 |
| Language servers (Python, Markdown) | Phase 4 |
| Native notebook cells + kernel | Phase 5 |

**Git tree.** A branch/commit graph in the UI (log, parents, maybe checkout). Useful for “where am I” without leaving DevTool. Phase 1 explicitly stays out of a git graph so the file explorer does not grow into an IDE. If it happens, it is Phase 5-or-later: read-only first, no rebase UI.

**Generate commit message with a specified agent.** Pre-fill the existing git commit box from Pi (or Claude/Codex) given the staged diff. Low confidence this needs a DevTool feature: you can already ask Pi in a tab to write the message and paste it. Only worth it if the commit UI is used a lot and the round-trip is annoying. Prefer “use the project’s default agent” over a per-commit picker.

---

## Suggested order of PRs / commits on this fork

Keep upstream `master` as a remote (`upstream`) and rebase or merge periodically. Land work in this order so each PR is demoable:

1. Windows shell resolution + Git Bash PTY + documented rebuild. **Done** (Git Bash default + Settings presets; portable Node PATH and rebuild docs landed earlier).
2. Configurable spawn PATH (portable Node) + env passthrough. **Done.**
3. Win dir packaging notes / script. **Done.** (`npm run build:win` → `dist/win-unpacked`.)
4. File explorer CRUD. **Landed** (filter, Reveal in Git Bash, 1.1 toolbar; ignore list removed). Verify on Windows before bumping to `0.3.0`.
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

| Phase | Ships as | What “done” means | Rough time |
| --- | --- | --- | --- |
| 0 | `0.2.0` (shipped) | Git Bash + Pi in DevTool on Windows | 1–2 months calendar / 2–4 weeks focused |
| 0.5 | (no bump, done) | No DevTool inference UI (Pi keeps its settings) | n/a |
| 1 | `0.2.2` → `0.3.0` | File tree CRUD (`0.2.2` = ignore removed + explorer toolbar) | 1–2 weeks |
| 2 | `0.4.0` | Conda picker on spawn | 1–2 weeks |
| 3 | `0.5.0` | JupyterLab in a browser tab | days |
| 4 | `0.6.0` | Usable Python and Markdown LSPs | 1–2 months |
| 5 | `0.7.0`+ | Native notebooks / extra LSPs | open-ended |

A year of evenings can yield a personal orchestrator. It will not become Cursor. That is success.
