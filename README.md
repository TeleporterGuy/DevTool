# DevTool

A desktop application for managing development workspaces. Organize projects, tasks, and tabs in a unified interface with integrated terminals, editors, browsers, and AI tool support.

Built with Electron, React, and TypeScript.

**This repository** is a fork of [join3r/claude-project](https://github.com/join3r/claude-project). join3r has said it may be forked and modified freely. All work stays on **this** repo ([TeleporterGuy/DevTool](https://github.com/TeleporterGuy/DevTool)); do not open PRs against upstream. Direction: Pi as the primary agent, primarily on Windows (Git Bash, portable Node, conda, Jupyter, Python and Markdown language servers). How to progress is in [ROADMAP.md](./ROADMAP.md).

## Features

**Project Management** -- Add, organize, and switch between projects. Group projects into folders. Support for local directories, remote SSH projects, and shell command projects.

**Task Organization** -- Create tasks within projects. Each task maintains its own set of tabs and layout state independently.

**Split-Pane Layout** -- Horizontal split view with independent left and right panes. Drag tabs between panes.

**Terminal Tabs** -- Full terminal emulation via xterm.js and node-pty. On Windows, tabs are **Git Bash** only (auto-detected `Git\bin\bash.exe`; optional path in Settings). PowerShell and Command Prompt are not offered. WebGL-accelerated rendering, scrollback preservation, search, clipboard integration, and copy-on-select.

**Browser Tabs** -- Embedded Chromium browser with URL bar, navigation, and DevTools. SOCKS proxy support for remote project access.

**Editor Tabs** -- Monaco editor with syntax highlighting, configurable fonts, line numbers, minimap, word wrap, and auto-save.

**Diff Viewer** -- Git diff visualization with side-by-side rendering and whitespace options.

**AI Tool Integration** -- Dedicated tabs for Pi (primary), Claude Code, and Codex. Hook server enables bidirectional communication with AI tools running in terminals.

**Remote SSH Projects** -- Connect to remote machines via SSH with port forwarding, SOCKS proxy tunneling, key authentication, health checks, and auto-reconnection.

**Git Worktree Management** -- Create and delete isolated git worktrees for branch work directly from the UI.

**File Browser** -- Integrated file tree panel for browsing and opening files.

**Git Status** -- Display current branch, changed files, and diffs.

**Multi-Window** -- Open multiple application windows with independent state.

### Install

```bash
npm install
```

This installs dependencies and rebuilds native modules (`node-pty`) for Electron.

`npm warn deprecated …` lines (for example `glob`, `inflight`, `rimraf`, `boolean`) come from Electron / electron-builder, not from DevTool itself. They do not fail the install. An `electron-winstaller` ignored-scripts warning is also expected until a Windows *installer* is needed; the portable folder path below does not use it.

#### Windows from source (admin required)

Compiling `node-pty` for Electron uses MSBuild. That needs **Visual Studio 2022 Build Tools** (or full VS) with the Desktop C++ workload, **Python** (for node-gyp), and **administrator rights** to install or modify those tools. Git Bash / MinGW cannot replace MSVC here. There is no portable Spectre CRT zip.

1. Install [Build Tools for Visual Studio 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe) if the Visual Studio Installer is missing. The installer itself requires admin.
2. Modify the **same** VS instance node-gyp will use (on this fork that is often **Build Tools 2022**, not Community, if both are installed).
3. Workload: **Desktop development with C++**.
4. Individual components → search **Spectre** → install **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)** (`Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`).

Elevated Command Prompt (adjust `--installPath` if `vswhere` shows a different instance):

```bat
"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vs_installer.exe" modify ^
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" ^
  --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre ^
  --passive --norestart --wait
```

Libs should exist at `...\VC\Tools\MSVC\<version>\lib\spectre\x64`. Check:

```bat
"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -products * -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath
```

Then from the repo (Git Bash is fine):

```bash
npm install
```

If you added Spectre **after** a failed install, you do not need to delete `node_modules`. Re-run:

```bash
npx @electron/rebuild -m .
```

**MSB8040** (“Spectre-mitigated libraries are required”) means that component is still missing. Do not disable Spectre in `node-pty`’s `binding.gyp`.

Opening a Pi (or Claude/Codex) tab can fail with **Cannot create process, error code: 2** if Windows cannot find the CLI, or **error code: 193** if DevTool tries to CreateProcess a `.cmd` shim directly. Electron does not see Git Bash’s PATH, and npm’s `pi` is usually `pi.cmd`. Set **Settings → AI Tools → Command path** after enabling the tool, or put npm’s global bin on PATH (`%AppData%\npm`). DevTool wraps `.cmd` through `cmd.exe`.

New **Terminal** tabs on Windows are **Git Bash** (`Git\bin\bash.exe --login -i`), including when you start `DevTool.exe` or `npm run dev` from Explorer or cmd — the app does not rely on an inherited `SHELL`. Leave the Git Bash path empty in **Settings → Terminal** to auto-detect, or Browse to a `bash.exe`. PowerShell and Command Prompt are out of scope on this fork. SSH tabs still use the remote `$SHELL`.

Without admin, without the Visual Studio Installer, or without those Spectre libs, **from-source `npm install` cannot succeed** on Windows. Use a pre-built folder instead.

#### Windows without admin (pre-built portable folder)

A machine that *does* have admin + VS produces an unpacked app. Recipients copy that folder and run it. They never compile and never run `npm install`.

On the build machine (Windows x64, after a successful `npm install` as above):

```bash
npm run build:win
```

That writes a portable directory (typically `dist/win-unpacked`). Zip that folder and give it to the locked-down PC. Run `DevTool.exe` from inside it. Keep a portable Node zip next to it if you want `node` on PATH for terminals later (Settings → Node directory).

Limits of this path:

- It is **run-only**. You cannot `npm run dev` or change the Electron native addon without a VS build machine.
- Architecture must match (x64 build for x64 Windows).
- This is a folder, not a Setup.exe. `electron-winstaller` stays unapproved until an installer is actually required. The portable `DevTool.exe` is unsigned (`signAndEditExecutable` is off so the build does not need Windows code-sign tools).

### Development

```bash
npm run dev
```

Starts the app in development mode with hot reload. On Windows this still needs the from-source native rebuild above.

### Build

```bash
npm run build          # Production JS/CSS bundle only
npm run build:win      # Portable Windows folder (dist/win-unpacked)
npm run build:mac      # Package macOS app
npm run build:linux    # Package Linux app
```

### Install (build + system install)

```bash
./scripts/install.sh
```

Builds and installs the app system-wide. Supports macOS (arm64) and Linux (x86_64, arm64). On macOS it copies to `/Applications`, on Linux it installs to `/opt/DevTool` with a desktop entry and `/usr/local/bin/devtool` symlink. Windows uses `npm run build:win` and copying `dist/win-unpacked` instead.

### Test

```bash
npm test               # Run tests
npm run test:watch     # Run tests in watch mode
```

## License

[MIT](./LICENSE). Original work by [join3r](https://github.com/join3r); this fork by [TeleporterGuy](https://github.com/TeleporterGuy).