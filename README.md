# Workboard

A pinnable desktop board that surfaces your assigned tickets and spins up per-ticket worktrees, virtual desktops, and dev environments to parallelize agent-driven work.

Empty-but-runnable Electron + TypeScript desktop app scaffold. Ships installers for Windows, macOS, and Linux.

## Develop

Requires Node.js 20+.

```
npm install
npm run build   # tsc: src/ -> dist/
npm start       # electron .
```

## Package locally

```
npm run dist          # electron-builder for the current OS
npm run dist:win      # Windows NSIS installer
npm run dist:mac      # macOS dmg
npm run dist:linux    # Linux AppImage
```

Installers land in `release/` with deterministic names (`workboard-<version>-<os>.<ext>`).

## Releases

Releases are pipeline-owned. Run the `release` workflow (Actions -> release -> `version=X.Y.Z`); it stamps the version (CI only), builds installers per OS, creates the tag + GitHub Release, and dispatches the listing to the marketplace. See `.github/workflows/release.yml` and `AGENTS.md` for the contract. Never hand-bump `version` in `package.json`.
