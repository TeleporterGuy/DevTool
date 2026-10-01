# Phase 5 — Windows test plan

For a Claude session (or a human) on the **Windows build machine** (VS 2022 Build Tools + Spectre libs, Git Bash, admin available for `npm ci` only). Branch: `phase5-packaging`. Context: [ROADMAP.md](./ROADMAP.md) → Phase 5 → Status.

What this branch changed, in one line each:
- App icon (`build/icon.png`, from join3r's iOS icon) wired into electron-builder and `BrowserWindow`.
- `app.setName('DevTool')`, userData pinned to its old path, `setAppUserModelId('com.devtool.app')` (`com.devtool.app.dev` in dev).
- `win.signAndEditExecutable: true` with **no certificate** — rcedit stamps icon + version resources, exe stays unsigned. Sign hook `scripts/sign-win.cjs` is a no-op unless `DEVTOOL_SIGN_CMD` is set.
- `npm run build:win:setup` → per-user NSIS `DevTool-Setup-<v>.exe` + portable zip. `npm run build:win` (portable folder) unchanged.
- Update checker: Settings → Updates, Help → Check for Updates…. Unsigned builds only announce and open the release page.

Ground rules:
- Do **not** set `DEVTOOL_SIGN_CMD` or pass `--signed`. There is no certificate.
- Do **not** run `npm run release:win` without `--no-upload` (it creates a GitHub Release).
- Do not commit build output (`dist/`, `out/`).
- If something fails, capture the exact error text before changing anything.

---

## 0. Setup

```bash
git fetch origin && git checkout phase5-packaging && git pull
```

```bash
npm ci
```

Expect: exits 0. If `npm ci` complains the lockfile is out of sync, **stop and report** — the lockfile was regenerated with npm 12 on macOS; do not run `npm install` to "fix" it.

```bash
npm run typecheck && npm run lint && npm test
```

Expect: typecheck clean, lint 0 errors (warnings OK), all tests pass (`tests/updates.test.ts` included; live notebook tests skip unless `NOTEBOOK_LIVE=1`).

## 1. Portable folder — the risky step

```bash
npm run build:win
```

**Risk:** with `signAndEditExecutable: true`, electron-builder downloads `winCodeSign` to run rcedit. Older versions failed to extract it without symlink rights (Developer Mode / admin) — that is why it was `false` before.

- **If the build fails** on winCodeSign / symlink / 7z extraction: record the error, then apply the fallback in §6 and rebuild.
- **If it succeeds:** check the exe resources (PowerShell is fine for inspection here):

```powershell
(Get-Item dist\win-unpacked\DevTool.exe).VersionInfo | Format-List ProductName,FileDescription,ProductVersion,LegalCopyright,CompanyName
```

Expect: `ProductName` and `FileDescription` = `DevTool` (not `Electron`), `ProductVersion` = `0.5.1`, `LegalCopyright` mentions join3r and TeleporterGuy.

```powershell
Get-AuthenticodeSignature dist\win-unpacked\DevTool.exe | Format-List Status
```

Expect: `NotSigned` (correct — no cert).

Then run `dist\win-unpacked\DevTool.exe` and check by eye (ask the user for a screenshot if you cannot see the screen):
- Explorer shows the DevTool icon (indigo rounded square, white `>`, green `_`) on `DevTool.exe`, not the Electron atom.
- Taskbar button and window title-bar icon are the DevTool icon.
- Task Manager → Processes lists **DevTool**.
- A Git Bash terminal tab opens and a Pi tab starts — nothing regressed in spawning.

## 2. Installer

```bash
npm run build:win:setup
```

Expect in `dist\`: `DevTool-Setup-0.5.1.exe`, `DevTool-Setup-0.5.1.exe.blockmap`, `DevTool-0.5.1-win.zip`, `latest.yml`.

Install as a **normal user, no elevation** (double-click). SmartScreen warns (unsigned): More info → Run anyway. Check:
- No UAC prompt. Installer offers an install directory; default is `%LOCALAPPDATA%\Programs\DevTool`.
- Start Menu has **DevTool** with the DevTool icon; it launches the app. No desktop shortcut.
- `%LOCALAPPDATA%\Programs\DevTool\resources\app-update.yml` exists and names `owner: TeleporterGuy`, `repo: DevTool`.
- Pin the running app to the taskbar, quit, launch from Start Menu: it lands on the **same** pinned button (AppUserModelId matches the shortcut), not a second one.
- Settings and projects are the user's normal `~/.devtool` ones (installed build = packaged config dir).

## 3. Update check (installed copy)

- Settings → **Updates**: shows `DevTool 0.5.1`, the "Check for updates automatically" toggle (on), and the manual-mode helper text ("This build does not replace itself…").
- Click **Check now** → "DevTool is up to date." (the fork has no GitHub releases yet; that must read as up to date, not an error).
- Help → **Check for Updates…** → dialog "DevTool is up to date".
- Toggle off, restart the app, confirm the toggle stays off.
- Offline (disable network) → Check now → shows "Could not check for updates: …" and the app keeps working.

Optional, only if the user wants it: publish a throwaway pre-release tag higher than 0.5.1 on the fork, Check now → "x.y.z is available" + **Open release page** opens the browser on that tag. Delete the test release afterwards.

## 4. Uninstall

Settings → Apps → DevTool → Uninstall (no admin prompt). Expect: `%LOCALAPPDATA%\Programs\DevTool` gone, Start Menu entry gone, **`~/.devtool` and `~/.devtool/backups` untouched**.

## 5. Dev run

```bash
npm run dev
```

- Window and taskbar show the DevTool icon.
- Dev taskbar button does **not** group with an installed/pinned DevTool (dev uses `com.devtool.app.dev`).
- Settings → Updates says "Update checks are off in development runs."
- Dev still uses `~/.devtool-dev` (not the installed app's data).

## 6. Fallback if §1 fails on winCodeSign

Keep the exe unsigned but stamp it without winCodeSign:

1. In `package.json` → `build.win`: set `signAndEditExecutable` back to `false`, keep `icon`.
2. Add devDependency `rcedit` **without rewriting the lockfile in an incompatible way** (if local npm reformats `package-lock.json` heavily, report instead of committing).
3. Add `scripts/win-rcedit.cjs` as `build.afterPack`: on `context.electronPlatformName === 'win32'`, run rcedit on `<appOutDir>/DevTool.exe` with `--set-icon build/icon.ico` (generate the .ico from `build/icon.png`, or let electron-builder's `build/icon.ico` output be reused), `--set-version-string ProductName DevTool`, `FileDescription DevTool`, `LegalCopyright <build.copyright>`, `--set-file-version` / `--set-product-version` = package version.
4. Rebuild §1 and §2, rerun the checks. Commit on `phase5-packaging` and push.

## Report back

Short list, one line per section: pass / fail + the exact error or a screenshot for any fail. Note whether §6 was needed. Commit fixes (if any) on `phase5-packaging` and push.

---

## Results — Windows 11 Pro 26200, 2026-10-01 (Node 24.18.1, npm 11.16.0)

§6 **was needed**. Fix in `0e237ac`.

- **§0 Setup — pass, with caveats.** `npm ci` exits 0 with the lockfile as-is. Typecheck clean, lint 0 errors (55 warnings), `tests/updates.test.ts` passes. 15 tests fail, all in `tests/ipc-path-allowlist.test.ts`, every one `EPERM: operation not permitted, symlink …`: this account cannot create symlinks (no Developer Mode). That file is not touched by this branch, so the failures are not a Phase 5 regression. Environment note: the Claude Code shell sets `NoDefaultCurrentDirectoryInExePath=1`, which makes node-pty's gyp step fail with `'GetCommitHash.bat' is not recognized`; install and builds were run with that variable unset.
- **§1 Portable folder — fail, then pass after §6.** With `signAndEditExecutable: true`: `ERROR: Cannot create symbolic link : A required privilege is not held by the client. : …\winCodeSign\…\darwin\10.12\lib\libcrypto.dylib` (same for `libssl.dylib`). On Windows the download comes from electron-builder's own `app-builder rcedit` step. After §6: ProductName / FileDescription / CompanyName / InternalName = `DevTool`, OriginalFilename `DevTool.exe`, ProductVersion `0.5.1.0`, copyright names join3r and TeleporterGuy, `NotSigned`. Explorer, taskbar and title bar show the DevTool icon; Task Manager lists DevTool; Git Bash and Pi tabs start.
- **§2 Installer — pass.** All four artifacts built. No UAC prompt, default `%LOCALAPPDATA%\Programs\DevTool`, Start Menu entry with icon, no desktop shortcut, `app-update.yml` names TeleporterGuy/DevTool, pinning lands on the same button, normal `~/.devtool` projects load.
- **§3 Update check — pass, one transient failure.** The first Check now showed "The operation was aborted due to timeout". In `debug.log`, that error was logged about 30 s after the automatic first check would have started, so it was most likely that one request timing out, with the click waiting on it. It did not come back: 3 checks in a row through the same API returned up to date (642 / 109 / 112 ms), and Help → Check for Updates… worked. Toggle off persists across restart. The offline check was not run (remote session); a unit test covers a failed lookup becoming the error state.
- **§4 Uninstall — pass.** No admin prompt. Install folder, Start Menu entry and uninstall registry key are gone; `~/.devtool` and its backups are kept.
- **§5 Dev run — pass.** DevTool icon on window and taskbar, separate taskbar button from the installed pin, update mode `none` ("off in development runs"), logs to `~/.devtool-dev`.

§6 as implemented: `signAndEditExecutable: false`, devDependency `rcedit` (lockfile change only adds packages), `scripts/win-rcedit.cjs` as `build.afterPack`. It reuses electron-builder's converted `.ico`, also overwrites Electron's leftover `GitHub, Inc.` / `electron.exe` strings, and runs `scripts/sign-win.cjs` on `DevTool.exe`. That last part goes beyond the plan: with exe editing off, electron-builder only signs the NSIS installer and uninstaller, which would have broken `release:win --signed`'s `signtool verify` on the app exe.
