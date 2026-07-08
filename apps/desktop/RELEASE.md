# Desktop App Release Process

## Quick Start

From the monorepo root:

```bash
./apps/desktop/create-release.sh
```

The script will:
1. Show current version and prompt for new version (patch/minor/major/custom)
2. Update `package.json` version
3. Create and push a `desktop-v<version>` tag
4. Monitor the GitHub Actions build
5. Create a **draft release** for review

### Options

```bash
# Interactive version selection (recommended)
./apps/desktop/create-release.sh

# Explicit version
./apps/desktop/create-release.sh 0.0.50

# Auto-publish (skip draft)
./apps/desktop/create-release.sh --publish
./apps/desktop/create-release.sh 0.0.50 --publish
```

To publish a draft:

```bash
gh release edit desktop-v0.0.50 --draft=false
```

### Requirements

- GitHub CLI (`gh`) installed and authenticated
- Clean git working directory

## Manual Release

If you prefer not to use the script:

```bash
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

This creates a draft release. Publish it manually at GitHub Releases.

## Auto-update

Auto-update is DISABLED for the v1 public launch (see
`src/main/lib/auto-updater.ts`, `AUTO_UPDATE_ENABLED = false`). Once enabled, the
app checks for updates at launch and every few hours using the public repo's
Releases. Replace `ade` (and confirm the owner) below:

- **macOS manifest**: `https://github.com/per-simmons/damon-ade/releases/latest/download/latest-mac.yml`
- **Linux manifest**: `https://github.com/per-simmons/damon-ade/releases/latest/download/latest-linux.yml`
- **Windows manifest**: `https://github.com/per-simmons/damon-ade/releases/latest/download/latest.yml`
- **macOS installer**: `https://github.com/per-simmons/damon-ade/releases/latest/download/ADE-arm64.dmg`
- **Linux installer**: `https://github.com/per-simmons/damon-ade/releases/latest/download/ADE-x64.AppImage`
- **Windows installer**: `https://github.com/per-simmons/damon-ade/releases/latest/download/ADE-x64.exe`

The workflow creates stable-named copies (without version) so these URLs always point to the latest build.

To turn auto-update on: set `RELEASE_REPO_NAME` and flip `AUTO_UPDATE_ENABLED`
to `true` in `src/main/lib/auto-updater.ts`, then ship a build.

## Code Signing

macOS code signing uses these repository secrets:

- `MAC_CERTIFICATE` / `MAC_CERTIFICATE_PASSWORD`
- `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID`

Windows code signing uses the standard electron-builder variables when present:

- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`
- or `CSC_LINK` / `CSC_KEY_PASSWORD`
- or Azure Trusted Signing variables

## Local Testing

```bash
cd apps/desktop
bun run clean:dev
bun run compile:app
bun run package
```

Output: `apps/desktop/release/`

Linux output should include:

- `*.AppImage`
- `*-linux.yml` (auto-update manifest)

Windows output should include:

- `ADE-<version>-x64.exe`
- `latest.yml` (auto-update manifest)

## Troubleshooting

- **Linux auto-update not working**: Verify `release/*-linux.yml` is uploaded to the GitHub release
- **Windows auto-update not working**: Verify `release/latest.yml` and the matching `.exe` are uploaded to the GitHub release
- **Build icon warnings/failures**: Add icons under `src/resources/build/icons/` (`icon.icns`, `icon.ico`, optional Linux `.png`)
- **Native module errors**: Ensure `node-pty` is in externals in both `electron.vite.config.ts` and `electron-builder.ts`
- **Windows symlink errors while packaging**: Run from Developer Mode/elevated shell, or leave executable editing disabled for unsigned local builds
