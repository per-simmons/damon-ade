# Windows distribution

The desktop app is packaged as an x64, assisted NSIS installer. Local packaging
is offline and unsigned by default; signing, update metadata, and GitHub
publication are separate opt-in release concerns.

## Local unsigned build

From `apps/desktop`, prepare the application and create the installer:

```powershell
bun run prebuild
bun run package:win
```

The installer is written to `release/ADE-Setup-<version>-x64.exe`. This path
does not discover a certificate, generate update metadata, or publish files.
Unsigned installers are suitable for smoke testing, but Windows SmartScreen may
warn users and they should not be presented as production releases.

## Optional router services

The ADE installer does not bundle third-party service executables. Cloudflare
tunnels, Tailscale Serve, and the external Headroom compressor are optional and
must be installed separately when those features are needed. The dashboard and
gateway report a service error without changing certificates, DNS, or system
settings when an executable is unavailable.

Run this preflight in PowerShell before enabling the corresponding service:

```powershell
Get-Command cloudflared -ErrorAction SilentlyContinue
Get-Command tailscale -ErrorAction SilentlyContinue
Get-Command headroom -ErrorAction SilentlyContinue
```

An explicit executable path can also be supplied to the gateway service start
endpoint. ADE starts these processes without a shell, redacts credentials from
diagnostics, and stops managed service processes when the app exits. Privileged
MITM, certificate, and DNS changes remain disabled unless a future signed admin
executor receives explicit user consent.

## Code signing

Production releases should use an Authenticode code-signing certificate issued
to the publishing organization. Do not commit certificate files, passwords, or
tokens. Put them in the CI secret store and expose them only to the Windows
release job.

Set the explicit signing switch and one of electron-builder's supported
certificate sources:

```powershell
$env:ADE_WINDOWS_SIGN = "true"
$env:WIN_CSC_LINK = "C:\secure\ade-code-signing.pfx"
$env:WIN_CSC_KEY_PASSWORD = "<secret supplied by CI>"
$env:ADE_WINDOWS_PUBLISHER_NAME = "<exact certificate subject>" # optional
```

`WIN_CSC_LINK` may also contain a CI-provided base64 value or secure URL as
supported by electron-builder. `CSC_LINK` and `CSC_KEY_PASSWORD` are accepted as
fallbacks. A certificate from the Windows certificate store can instead be
selected with `WIN_CSC_NAME` (or `CSC_NAME`). The config fails before packaging
when signing is requested without a certificate source, or when file-based
signing has no password. `ADE_WINDOWS_PUBLISHER_NAME`, when set, must match the
certificate subject electron-builder should accept.

Validate a PFX before adding it to CI:

```powershell
certutil -dump C:\secure\ade-code-signing.pfx
```

Check that it contains a private key, is currently valid, has the Code Signing
enhanced key usage, chains to a trusted public CA, and that the subject is the
intended publisher. After building, verify both the app executable and installer:

```powershell
Get-AuthenticodeSignature .\release\win-unpacked\ADE.exe | Format-List
Get-AuthenticodeSignature .\release\ADE-Setup-*-x64.exe | Format-List
```

Both signatures must report `Status: Valid`. Keep timestamping enabled through
electron-builder's defaults so signatures remain verifiable after certificate
expiry. Never use a generated self-signed certificate for public distribution.

## Updates and publication

Publication is disabled unless all of these are set:

```powershell
$env:ADE_PUBLISH = "true"
$env:ADE_PUBLISH_OWNER = "<GitHub owner or organization>"
$env:ADE_PUBLISH_REPO = "<GitHub repository>"
$env:GH_TOKEN = "<token supplied by CI>" # GITHUB_TOKEN is also accepted
```

Only this mode configures the GitHub provider and generates channel update
metadata such as `latest.yml`. The token needs only the repository permissions
required to create or update releases and upload assets. Use a short-lived CI
token where possible.

`bun run release:win` intentionally requires both publication and signing. It
fails early if either configuration is incomplete. To produce signed artifacts
for manual review without uploading them, set the signing variables and run:

```powershell
bun run package -- --win --x64
```

## CI release checklist

1. Run on a clean Windows x64 runner and install the locked dependencies.
2. Run `bun run prebuild`, then `bun run validate:windows-config`.
3. Expose certificate and GitHub secrets only for the release step.
4. Run `bun run release:win` only for an approved tag or release workflow.
5. Require the job to pass the Authenticode checks above.
6. Confirm the release contains the versioned NSIS installer, its block map, and
   `latest.yml` before making the release public.
7. Install, launch, update, and uninstall on a clean supported Windows VM.

For unsigned CI smoke tests, leave all release secrets unset and run
`bun run package:win`. This keeps pull-request and local builds independent of
release credentials.
