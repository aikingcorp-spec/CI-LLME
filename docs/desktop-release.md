# Desktop releases

## Public Windows and Linux channel

The desktop uses the public generic feed configured in
`apps/desktop/package.json`. A private repository release cannot serve that feed
to unauthenticated customers. Windows NSIS and Linux packages can be distributed
without a Windows signing certificate; configured publisher verification and
download checksum verification remain enabled.

1. Build the pinned source with the packaging workflows in CI-LLME. Retain the
   installers, blockmaps and `latest*.yml` artifacts from the same source revision.
2. Run the packaged-resource and update-feed digest checks. Exercise manual IPC
   checks in an installed app with background checks disabled. Check corrupt-file
   rejection separately; a successful build is insufficient.
3. Upload new versioned artifacts without replacing previous files. Fetch each
   public artifact and compare its complete size and digest with the CI artifact.
4. Publish the checksum index and latest platform feeds only after those checks.
   Exclude `/desktop/latest.yml`, `/desktop/latest-linux.yml` and
   `/desktop/SHA256SUMS.txt` from broad installer cache rules. Respect their
   `no-cache, max-age=0, must-revalidate` policy and purge any cached 404 responses.
   Verify canonical and cache-busted feed URLs return the same current content.
5. Verify an installed app can check the public HTTPS feed. Update only the
   landing's version, URLs, sizes and hashes after the artifacts are available.

Packaged versions from 0.3.8 permit manual checks, downloads and restart/install
inside the app. Background checks still require the existing explicit opt-in.
An older installed native executable that blocks the manual action and lacks
`app-update.yml` needs a one-time native upgrade or supported local configuration;
publishing a feed alone cannot alter that executable. Do not add a remote command
endpoint to bypass this limitation.

Rollback restores previous app/service artifacts and landing pointers. Retain
versioned download files and additive database migrations. Restore prior feed
metadata, or remove a newly introduced feed when none existed, then purge only
the affected metadata URLs. Do not force installed clients to downgrade.

## Signed release workflow

The `release-desktop` workflow builds, signs, notarizes, attests, and publishes
the Electron app from a `vMAJOR.MINOR.PATCH` tag on `main`. Publishing the
Docker images triggers from the same tag. This workflow's repository publication
does not replace the public-channel publication above. The current distribution
uses CI-LLME for actively requested CI; do not trigger source-repository tag CI
as part of that path.

## Repository secrets

macOS (required):

| Secret | Value |
| --- | --- |
| `DESKTOP_MAC_CSC_LINK` | Base64 of the `Developer ID Application` certificate exported as `.p12` |
| `DESKTOP_MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_ID` | App Store Connect API key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | Issuer ID shown on App Store Connect > Users and Access > Integrations |
| `APPLE_API_KEY_P8` | Contents of the `AuthKey_*.p8` file |

The API key needs the Developer role. The workflow writes it to a mode 600 file
in the runner's temp directory for the packaging step and deletes it afterwards.

`patches/app-builder-lib@26.15.3.patch` carries electron-builder PR #10101:
without it `CSC_LINK` signing fails while creating the temporary keychain. Drop
the patch once an electron-builder release includes that fix.

Windows (optional):

| Secret | Value |
| --- | --- |
| `DESKTOP_WIN_CSC_LINK` | Base64 of the Authenticode certificate as `.p12`/`.pfx` |
| `DESKTOP_WIN_CSC_KEY_PASSWORD` | Its password |

When `DESKTOP_WIN_CSC_LINK` is unset the Windows build and its release assets
are skipped. macOS and Linux always build, and the release is only published
when every platform that was built produced its installer and update feed.

Set a secret from a file without echoing it:

```sh
base64 -i devid.p12 | gh secret set DESKTOP_MAC_CSC_LINK
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

## Cut a release

1. Bump `version` in `apps/desktop/package.json` on `main`.
2. Tag that commit `v<version>` and push the tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The workflow refuses tags that do not match the desktop version, are not on
`main`, or are not newer than the latest published release.
