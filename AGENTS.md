# Workboard

A pinnable desktop board that surfaces your assigned tickets and spins up per-ticket worktrees, virtual desktops, and dev environments to parallelize agent-driven work.

Electron + TypeScript desktop app. `tsc` compiles `src/` to `dist/`, electron-builder packages installers, and the release pipeline ships them for Windows, macOS, and Linux and registers the app in the marketplace.

## Contracts an agent won't infer from the tree

- **Release is tag + GitHub Release + marketplace dispatch.** `release.yml` (manual: Actions -> release -> `version=X.Y.Z`) validates semver, stamps the version, matrix-builds installers per OS, creates the tag `workboard--vX.Y.Z` on the release commit, publishes a GitHub Release with the installers attached, then POSTs an `app-release` dispatch to `Seretos/agent-marketplace`. Unlike the plugin templates there is **no orphan release branch** — apps tag straight on `main`, so `assets/icon.png` and `description.md` already live at the tagged commit and their `raw.githubusercontent.com/${repo}/${TAG}/...` URLs resolve.
- **Version is pipeline-owned.** The `version` in `package.json` is a `0.0.0` placeholder; the workflow input is the source of truth and the stamp never lands on `main`. Don't hand-bump it.
- **Required secret:** `MARKETPLACE_DISPATCH_TOKEN` — fine-grained PAT, `Contents: RW` + `Pull requests: RW` on `Seretos/agent-marketplace` only.
- **`assets/icon.png` and `description.md` are release artifacts.** The dispatch payload sends them as `icon` and `description_url` raw URLs at the tag (`raw.githubusercontent.com/${repo}/${TAG}/assets/icon.png` and `.../description.md`). Both must exist at the release commit on `main`. Ship `assets/icon.png` from day one and fill in `description.md`'s Key Features before cutting v0.0.1, or the marketplace listing has no image / blurb.
- **Installers are the `downloads` map.** electron-builder is configured with a deterministic `artifactName` (`${name}-${version}-${os}.${ext}`) so the release-asset filenames are predictable. `release.yml` uploads each installer as a GitHub Release asset and builds the `downloads` payload object mapping `windows`/`macos`/`linux` -> `https://github.com/${repo}/releases/download/${TAG}/<artifactName>`. If you change the targets (and thus the extensions: exe/dmg/AppImage) or the `artifactName`, update the URL computation in `release.yml` and `dispatch.yml` to match.
