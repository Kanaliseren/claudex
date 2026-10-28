# Updating Claudex

Claudex consumes official `router-for-me/CLIProxyAPI` releases. No proxy fork,
custom binary build, or fork-release workflow is required.

For a local installation, `claudex update --upstream` downloads the current
platform's official archive, verifies the published checksum, and boots it in an
isolated, credential-free canary before activating a different binary. Use
`--check` first to inspect the candidate without changing the installation.
Provider verification is separate and must be reported as unavailable when a
subscription cannot be used.

After installing a new Claudex package on Linux, run `claudex hub --install` to
refresh the quota adapter script, including expiry routing. It keeps the existing
`quota-hub.json` settings and backs up the previous script, unit and configuration.

To refresh the package's bundled channel:

1. Run `npm run promote:proxy -- latest` (or an exact `vX.Y.Z` tag). This reads
   official release metadata, verifies all five platform archives, and records
   both archive and extracted executable SHA-256 values.
2. Run `npm run check` and `npm run verify:assets`.
3. Check native model catalog and gateway compatibility against upstream source
   and Claude docs before local activation.
4. Commit the reviewed `channel/stable.json` and publish the package update.

Only add a Claude Code version to the tested matrix after the relevant runtime
checks; discovering a version or reading its documentation is not a runtime test.
The daily upstream watcher reports new proxy and Claude Code releases; it does
not deploy them. Local `update --upstream` removes the need to wait for a bundled
channel promotion.

Use `claudex rollback` to restore the previous proxy executable. Configuration
and integration rollback should use the local backup made before migration when
those files changed; the rollback command does not restore those files.
