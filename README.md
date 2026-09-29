# Claudex

Run Claude Code through local Codex and Claude OAuth sessions. Claudex safely installs
and manages the CLIProxyAPI bridge used by Claude Code, Paseo, and T3 Code. Sonnet
routes to GPT-6.1 Sol; all other models use their normal Claude routes, context
windows, and compaction behavior.

OAuth credentials are created locally on every machine. They are never bundled,
uploaded, copied between users, or printed by this package.

## Install

Use Node.js 24 and Claude Code (Node.js 20 remains supported). On a Mac, follow the
[short setup guide](docs/mac-setup.md).

For a Mac connected to the shared riz-server environment, use the
[Dren handoff](docs/dren-mac-handoff.md): one proxy manages the subscriptions,
while each Unix user has their own Claude Code and T3 client configuration.

```bash
npm install -g github:Kanaliseren/claudex
claudex setup
claudex login codex
claudex run sol
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
claudex run <sol|opus|opus55|fable> [--] [CLAUDE OPTIONS...]
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
claudex run sol
claudex run opus
claudex run sol -- --print "Explain this function" --output-format json
```

`models` lists the configured proxy aliases and upstream models, marking unvalidated preview entries;
it does not contact a provider or verify login. `run` selects that model through
Claude Code's `--model` flag using the upstream ID for one session and forwards the remaining arguments
unchanged. An explicit later `--model` flag can override the named choice. It
preserves Claude Code's exit status and leaves installed routing and integrations
unchanged. GPT-6.1 Sol uses Codex OAuth; Opus and Fable use native Claude OAuth.
`claudex claude` launches with Claude Code's normal default model.

### Context and compaction

The only Codex alias is `claude-sonnet-5-5` → `gpt-6.1-sol`. Choose Sonnet in
Claude Code or run `claudex run sol`. The `sonnet` selector uses the GPT provider
ID, with effort and thinking capabilities enabled.

The OAuth route has a configured **272,000-token context cap**. Claude Code
2.1.284 automatically compacts around **239,000 tokens**, leaving roughly 33,000
tokens for output and compaction. It resumes from the generated summary before
reaching the cap. Using the provider ID avoids inheriting Sonnet's native 1M
window; Codex context-limit errors alone do not trigger Claude's reactive
compaction. Do not select `sonnet[1m]` for this route, as that explicitly requests
a larger window.

Haiku, Opus, Fable, and the default model retain normal Claude behavior. The
context setting applies to custom models; native Claude models retain their own
windows. There is no global compaction percentage override.

In T3, select `gpt-6.1-sol` for this route as the main model. Claude's `sonnet`
selector uses the same settings in native subagents.

After upgrading the package, run `claudex update` (or reconnect a shared client)
and rerun `claudex integrate t3` or `claudex integrate paseo`. Integration clears
legacy model and compaction overrides, removes retired GPT registrations, and
migrates retired GPT defaults. Start a new provider session to pick up the
refreshed environment.

Verify Sonnet effort forwarding, proactive compaction, summary continuation,
and a native parent with a Sonnet subagent against a local mock endpoint
(no subscription requests):

```bash
CLAUDEX_TEST_NATIVE=1 node --test test/native-context.test.js
```

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
- Remote management: disabled. The local control panel is opt-in and requires a separate management key.
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

The current channel uses official CLIProxyAPI `v7.3.13`. GPT-6.1 Sol text requests
passed a live Codex OAuth check; local Claude Code 2.1.284 probes verify the configured context budget and
proactive compaction. Native Opus 5.5 text, tool use, and a Claude
Code 2.1.280 session passed without model overrides; Opus 5 remained usable.
The upstream hybrid MCP tool-name regression tests also passed with the reported
Supabase tool-name pattern. Prior validation versions remain in the manifest.

The local quota-hub script and configuration, when already installed, remain
independent of the package. Proxy upgrades restart an existing systemd quota hub
with its proxy and preserve its files and T3 settings.
`hub` shows the existing hub URL without printing its management key.
`integrate t3 --with-hub` connects the official management API when the dashboard
is enabled, or the legacy quota hub otherwise; `--without-hub` removes only
its T3 usage source. Neither option provisions a new hub server.

Maintainers: follow [`docs/updating.md`](docs/updating.md) when promoting a proxy
or Claude Code release.

This project is separate from StringKe's similarly named Claudex. See the
[source comparison](docs/claudex-comparison.md) for the replacement assessment
and the CLI conveniences adapted here.

## Multiple accounts and the dashboard

Add another Claude account by running `claudex login claude` again and selecting
the second account in the browser. Each distinct Claude account is stored separately.
Current T3 reads accounts and usage through the official management API. Enable
the dashboard below, then run `claudex integrate t3 --with-hub` to connect it.
Each account appears separately in T3's Limits view. The legacy quota hub remains
available for older clients.

Enable the official CLIProxyAPI dashboard and keep conversations on the same
available account with:

```bash
claudex configure --dashboard --session-affinity
claudex dashboard
```

The command reports the dashboard URL and a private management-key file path.
Use that key to sign into the dashboard, then open **OAuth** to add an account or
**Quota Management** to inspect usage. The proxy and dashboard remain bound to
loopback. On a remote server, forward the proxy port over SSH and open the
forwarded URL locally. Never paste the management key or OAuth callback into chat.

Round-robin distributes new sessions between eligible accounts. For a primary /
backup arrangement, use `claudex configure --strategy fill-first`. Session
bindings retain their account where possible, with failover when unavailable.
Opus and Fable use Claude accounts; the GPT-6.1 Sol route uses Codex.

`claudex configure --no-dashboard` disables the dashboard and management API.
`--no-session-affinity` disables session binding. Claudex preserves these supported
settings across setup and updates; arbitrary edits in the panel's YAML editor
are not preserved by Claudex configuration regeneration.

## Opus 5.5

Claudex 0.7.5 bundles official CLIProxyAPI v7.3.13 with native Opus 5.5
support and the fix for hybrid MCP tool names in Claude OAuth streaming responses.
Claude Code 2.1.280 was checked with native Opus 5.5 text, tool use, and a CLI
session. The Codex OAuth canaries from that release predate the current model route.

`claudex run opus55` selects `claude-opus-5-5`; `claudex run opus` keeps Opus 5.
`claudex integrate t3` registers both models without changing the default.

```bash
claudex update
claudex integrate t3
claudex doctor --live
claudex run opus55
```

Updating regenerates the managed proxy configuration and removes the temporary
Opus 5.5 alias/payload workaround. Native support no longer needs that override.
Run updates during an idle window: activating a new proxy restarts the shared
service and can interrupt requests from every connected user.
