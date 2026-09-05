# Claudex

Run Claude Code through local Codex and Claude OAuth sessions. Claudex safely installs
and manages the CLIProxyAPI bridge used by Claude Code, Paseo, and T3 Code. Sonnet
routes to GPT-6 Astra, Haiku routes to GPT-5.6 Sol, and Opus and Fable remain native
Claude models with their native context windows.

OAuth credentials are created locally on every machine. They are never bundled,
uploaded, copied between users, or printed by this package.

## Install

Requires Node.js 20+ and Claude Code. On a Mac, follow the
[short setup guide](docs/mac-setup.md).

```bash
npm install -g github:Kanaliseren/claudex
claudex setup
claudex login codex
claudex run astra
```

For native Opus and Fable 5.1, also run `claudex login claude` with your own
Claude account. `claudex login` is an alias for `claudex login codex`.

`setup` installs a checksum-pinned official CLIProxyAPI build, generates a
loopback-only configuration, installs a user service where supported, and
creates `~/.local/bin/claude-cliproxy`. Every person installs and logs in locally;
share this repository, not your OAuth files.

## Commands

```text
claudex setup [--binary PATH] [--port PORT] [--no-service]
claudex login [codex|claude] [--device]
claudex doctor [--json] [--live]
claudex update [--upstream | --binary PATH] [--check [--json]]
claudex upgrade [--upstream | --binary PATH] [--check [--json]]
claudex rollback
claudex integrate <paseo|t3|all> [--path PATH] [--with-hub|--without-hub]
claudex claude [CLAUDE OPTIONS...]
claudex run <astra|sol|opus|fable> [--] [CLAUDE OPTIONS...]
claudex models [--json]
claudex hub [--json]
claudex status [--json]
```

Set `CLAUDEX_HOME` to redirect every package-owned file into an isolated
directory. `CLIPROXY_OAUTH_HOME` remains available as a compatibility alias.
Existing installations continue using their current paths and service IDs, so
renaming Claudex does not invalidate local OAuth credentials.

## Choose a model for one session

```bash
claudex models
claudex run astra
claudex run opus
claudex run sol -- --print "Explain this function" --output-format json
```

`models` lists the aliases and upstream models in the bundled tested channel;
it does not contact a provider or verify login. `run` selects that model through
Claude Code's `--model` flag for one session and forwards the remaining arguments
unchanged. An explicit later `--model` flag can override the named choice. It
preserves Claude Code's exit status and leaves installed routing and integrations
unchanged. Astra and Sol use Codex OAuth; Opus and Fable use native Claude OAuth.
`claudex claude` continues to launch with the existing defaults.

## Upgrade policy

To follow official CLIProxyAPI releases without maintaining a fork or editing
release pins, run:

```bash
claudex update --upstream --check
claudex update --upstream
```

`--upstream` downloads the latest stable release directly from
`router-for-me/CLIProxyAPI`, verifies its published archive checksum, records the
extracted executable checksum, and requires an isolated local Codex OAuth canary
before activating a different binary. An exhausted Claude subscription is not
used by this canary. Failed candidates leave the current proxy active. A newer
installed proxy cannot be silently downgraded by an older bundled channel;
`rollback` is the explicit way back. This path follows upstream compatibility
work, but does not claim every new release has been tested with native Claude.

Archive extraction requires `tar` (included with current Windows releases).
Preparing all platforms' release pins on Linux/macOS also requires `unzip`.
Only the selected executable is extracted; upstream sample configs never replace
your installation's configuration.

Check the installed proxy binary and configuration against the latest Claudex
package's tested channel before installing:

```bash
npx --yes github:Kanaliseren/claudex update --check
```

`update --check --json` reports whether setup or an update is needed without
writing installation files, running Claude Code, starting services, or accessing
OAuth credentials. It detects configuration changes even when the proxy binary
has not changed. The check compares against the manifest bundled with the
invoked package; it does not check newer upstream proxy builds or Claude Code
versions. A successful check exits zero regardless of the recommended action.

Run the latest installer against an existing installation with:

```bash
npx --yes github:Kanaliseren/claudex update
```

`upgrade` remains an alias for existing scripts.

`update` and `upgrade` first update Claude Code through its native latest channel,
then stage the newest compatibility-tested CLIProxyAPI build bundled with Claudex.
`integrate t3` also registers native manifest models that T3 has not bundled yet.

Without `--upstream`, each package release pins exact binaries and checksums. `upgrade` stages the
candidate, checks required capabilities, runs an isolated OAuth canary when a
local credential is available, then atomically activates it. Failed candidates
leave the current release running.

Claude Code flags and provider integrations are capability-detected and preserve
unknown configuration fields. The wrapper keeps native Tool Search enabled for
future Claude Code releases because the pinned proxy build is the compatibility
boundary. Unsupported future configuration schemas fail without writing.

## Security model

- Proxy listener: `127.0.0.1` only.
- Remote management and the control panel: disabled.
- Config and OAuth files: user-only permissions.
- Inbound proxy key: random per installation.
- Upgrade canary: separate temporary auth directory with refresh tokens removed.
- No automatic credential sharing between machines or people.

## Compatibility

The exact tested matrix is in [`channel/stable.json`](channel/stable.json).
Scheduled CI detects new CLIProxyAPI releases, but proxy promotion stays gated
on the test suite, protocol capture, and a real local OAuth canary. New Claude
Code releases are used immediately and retain the Tool Search override required
for a custom proxy URL; `doctor` warns when a release has not yet been added to
the validation matrix.

The current channel uses official CLIProxyAPI `v7.2.151`. Its isolated Codex OAuth
canary passed on this migration. Native Claude model names and gateway settings
were checked against official documentation and upstream source; native Claude
inference was not tested because the local subscription was exhausted. Prior
Claude Code validation versions remain recorded in the manifest.

The local quota-hub script and configuration, when already installed, remain
independent of the package. Proxy upgrades restart an existing systemd quota hub
with its proxy and preserve its files and T3 settings.
`hub` shows the existing hub URL without printing its management key.
`integrate t3 --with-hub` connects an existing hub; `--without-hub` removes only
its T3 usage source. Neither option provisions a new hub server.

Maintainers: follow [`docs/updating.md`](docs/updating.md) when promoting a proxy
or Claude Code release.

This project is separate from StringKe's similarly named Claudex. See the
[source comparison](docs/claudex-comparison.md) for the replacement assessment
and the CLI conveniences adapted here.
