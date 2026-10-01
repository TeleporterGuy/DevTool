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
