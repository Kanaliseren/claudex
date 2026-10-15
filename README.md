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
claudex hub [--install [--port PORT]] [--json]
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
2.1.300 automatically compacts around **239,000 tokens**, leaving roughly 33,000
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

`update` and `upgrade` stage the newest compatibility-tested CLIProxyAPI build bundled with Claudex.
`integrate t3` also registers native manifest models that T3 has not bundled yet.

Claudex never installs, updates or pins Claude Code and leaves its native
auto-updater untouched. Update it through that auto-updater, T3's provider update,
`claude update`, or `claude install <version>`. Newer releases than the tested
matrix keep working; `doctor` only notes that they are untested.

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

Claudex 0.8.0 bundles official CLIProxyAPI `v8.0.28`, supporting the current v8
management dashboard and the v0 API used by existing clients. GPT-6.1 Sol and
native Opus 5.5 passed live text and Read-tool sessions through Claude Code
2.1.300. Local probes verify the configured context budget, proactive compaction,
summary continuation, and native parent/Sonnet subagent behavior. All five
platform archives and executable checksums are verified. Prior validation
versions remain in the manifest.

On Linux, `claudex hub --install` installs a small loopback adapter for the stock
management API and backs up an existing legacy hub. It requests full Claude usage
first, preserving model-specific limits (including Fable), extra usage and other
provider fields. Only when the usage endpoint returns 429 does it fall back to
normal model response headers. Both the 5-hour and weekly observations must be
at most 15 minutes old and their windows must not have reset. It preserves
observation times. If recent headers are unavailable, one tiny Haiku request
(one output token) obtains fresh quota headers for that specific account.
This consumes a small amount of subscription quota;
concurrent refreshes share the pending probe. Completed responses are not cached
in the hub. Header observations may omit extra
usage, reset grants and some model-specific windows; grant queries and reset
operations always reach the original provider. Reset counts and model-specific
limits can still be unavailable while their provider endpoint is throttled;
the adapter cannot reconstruct missing fields from general quota headers.

`claudex dashboard` and `integrate t3 --with-hub` use an installed adapter; without
one, the official management API or existing legacy hub remains available.
`hub` shows its URL without printing the management key. Proxy upgrades restart
an existing systemd hub without rewriting its files. Rerun `hub --install` after
updating Claudex to refresh the adapter. `--without-hub` removes only T3's usage
source. Remote dashboards must forward the adapter port to use it.

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

### Use the quota that expires first

With two or more accounts from the same provider (Claude or Codex), the installed
quota adapter (`claudex hub --install`) routes new work to the account whose weekly
window resets soonest, because that quota is lost first if unused. Every five
minutes it reads each account's weekly reset and sets CLIProxyAPI's built-in
per-account `priority` (the highest priority is used first). Accounts without a
running weekly window come after accounts with one, followed by exhausted
accounts and accounts whose credentials are rejected. The proxy's own cooldown handles 5-hour and weekly 429s by
failing over to the next priority until the limit resets.

Reset times come from recent model-response headers when available, otherwise
from the provider usage endpoint, reused for up to 30 minutes. Lower-priority
accounts sit idle and have no recent headers, so when the usage endpoint is
throttled and an account's reset is not yet known, the adapter sends the same
one-output-token Haiku probe the dashboard uses, once until that reset is known.
Probing an unused account starts its weekly window. If an account's usage is
still unreadable, or no reset is known, that provider's priorities stay
unchanged until a later pass. With session
affinity, existing conversations stay on their account until the binding expires
(one hour) or that account fails; new conversations use the new order. The adapter
owns `priority` for these providers, so manual priorities are replaced. Set
`"expiryRouting": false` in `quota-hub.json` and restart the hub to disable it.

## Opus 5.5

Opus 5.5 uses native Claude OAuth through CLIProxyAPI, without a model alias or
payload workaround.

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
