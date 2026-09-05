# Claudex comparison

Maintenance follow-up: this is not a claim that this package has universally
better code. StringKe has tests and broader features, but its latest release and
main commit remain dated February 27, 2026, with compatibility fixes submitted in
July still open. For lower maintenance, this change now consumes official
CLIProxyAPI releases and offers `update --upstream`; it removes the proxy-fork
dependency rather than expanding our own translator.
[StringKe releases](https://github.com/StringKe/claudex/releases),
[open compaction fix](https://github.com/StringKe/claudex/pull/6),
[open Responses fix](https://github.com/StringKe/claudex/pull/9).

Reviewed 2026-09-05. Keep **Kanaliseren/claudex** for the existing Codex + Claude,
T3 Code, and Paseo workflow. Borrow the convenient model-selection and read-only
update-check commands. **StringKe/claudex** offers broader provider management,
but replacing this package with it would be a migration to a different proxy,
configuration format, authentication store, and integration model.

This is a source review, not a live provider benchmark. Neither StringKe's
installer nor its OAuth flows were executed. No running proxy, credential store,
application integration, or service was changed for this comparison. The existing
package's compatibility matrix is repository evidence, not a new live test.

## Compared revisions

- [Kanaliseren/claudex `231d19c`](https://github.com/Kanaliseren/claudex/tree/231d19c58f1767a696733f9fa1bf5cc9708a52fd), package version 0.3.1, before the companion improvements.
- [StringKe/claudex `a1eb959`](https://github.com/StringKe/claudex/tree/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea), Cargo package version 0.2.4, the project linked from [claudex.space](https://claudex.space/en/).

## Which is better for what?

| Concern | Kanaliseren/claudex | StringKe/claudex |
| --- | --- | --- |
| Main job | Manage a pinned CLIProxyAPI bridge and integrations | Implement a Rust translation proxy and multi-provider manager |
| Existing model workflow | Codex-backed Sonnet/Haiku plus native Opus/Fable | Named provider profiles, model overrides, configurable Haiku/Sonnet/Opus slots |
| Integrations | Explicit T3 Code and Paseo configuration adapters | Claude Code launcher; no corresponding T3/Paseo adapters found |
| Provider breadth | Package workflow exposes Codex and Claude OAuth | Anthropic, Chat Completions, Responses adapters; many endpoint and OAuth profiles |
| Operations | User service, checksummed releases, candidate canary, rollback, doctor | Proxy daemon, configuration commands, TUI, GitHub self-update |
| Best fit | Preserve the current focused workflow | Explore many API providers and local model endpoints |

Sources: [our configuration](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/config.js),
[our integrations](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/integrations.js),
[our lifecycle](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/lifecycle.js),
[StringKe CLI](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/cli.rs),
[StringKe configuration](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/config/mod.rs),
[StringKe adapters](https://github.com/StringKe/claudex/tree/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/adapter).

## Why a direct replacement is a poor fit

StringKe launches a provider-specific endpoint at
`http://127.0.0.1:13456/proxy/<profile>`. For a Claude subscription profile, its
launcher deliberately bypasses that proxy and relies on Claude Code's own OAuth.
Our wrapper instead uses one CLIProxyAPI endpoint, routes Sonnet/Haiku to Codex,
and preserves the native Claude models. StringKe's slot mappings change model
names; they do not recreate our cross-provider routing contract. A replacement
would need explicit compatibility work for that behavior and the application
integrations. [StringKe launcher](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/process/launch.rs),
[our wrapper](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/wrapper.js),
[our model manifest](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/channel/stable.json).

The same executable name hides incompatible state. StringKe discovers TOML/YAML
profile configuration and loads OAuth from native CLI files and its own keyring
entries. Our package owns a CLIProxyAPI YAML configuration, release/state
directories, and local provider credential files. Replacing the executable does
not migrate any of this. [StringKe configuration discovery](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/config/mod.rs),
[StringKe credential sources](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/oauth/source.rs),
[our paths](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/paths.js).

## Source findings that affect the choice

- **Our proxy defaults are more restrictive.** We generate a random inbound key,
  bind only to loopback, and disable remote management and request logging.
  StringKe defaults to loopback too, but its inspected router and request handler
  do not validate an inbound key; the launcher supplies a fixed passthrough token.
  The handler logs credential prefixes and, at debug level, request-body snippets;
  debug is its configuration default. This is a source-level risk assessment,
  not evidence of a compromised installation.
  [Our defaults](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/src/config.js),
  [StringKe router](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/mod.rs),
  [handler](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/handler.rs),
  [defaults](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/config/mod.rs).
- **The advertised dashboard does not establish working usage accounting.** Its
  entry point creates a fresh metrics store, separate from the proxy's store;
  the proxy handler records zero tokens for requests. The UI exists, but these
  paths do not prove meaningful proxy token totals in that UI.
  [Entry point](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/main.rs),
  [proxy state](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/mod.rs),
  [request accounting](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/handler.rs).
- **The context features change request semantics.** Compression replaces
  conversation history, sharing injects other profiles' context, and RAG sends
  file chunks to the configured embedding endpoint. The classifier likewise
  calls a configured Chat Completions endpoint. They can use local services,
  but the implementation is not inherently local-only. These are substantial
  behavioral choices, not free upgrades to an OAuth bridge.
  [Context processing](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/proxy/context_engine.rs),
  [RAG](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/context/rag.rs),
  [classifier](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/router/classifier.rs).

## Selected improvements

Adapt the following ideas to our existing architecture:

1. `claudex models [--json]`: display the bundled named routes and actual upstream
   models. This describes configuration; it does not claim that a provider login
   or live model request succeeds.
2. `claudex run <sol|terra|opus|fable> [--] ...`: select a named model for one
   launch, keeping the existing proxy, defaults, and native Claude argument path.
3. `claudex update --check [--json]`: compare the local installation with the
   executing package's bundled stable channel without installing or restarting
   anything. This intentionally preserves our promotion policy. Use the latest
   GitHub package when checking against its latest bundled manifest; a local
   package cannot discover a newer manifest without obtaining it.

The ideas come from StringKe's profile launcher and separate update-check mode;
they are independent implementations, not a port of its Rust proxy.
[Launcher](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/process/launch.rs),
[update check](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/src/update.rs),
[our promotion policy](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/docs/updating.md).

## License

Both repositories carry MIT licenses. StringKe's license permits copying and
modification subject to retaining its copyright and permission notice in copies
or substantial portions. The selected work borrows command concepts rather than
copying its implementation; any later source reuse should retain the required
notice. [StringKe license](https://github.com/StringKe/claudex/blob/a1eb95957e71ab85d91aae8cdc3b7bb78bd4e9ea/LICENSE),
[our license](https://github.com/Kanaliseren/claudex/blob/231d19c58f1767a696733f9fa1bf5cc9708a52fd/LICENSE).
