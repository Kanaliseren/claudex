# Removing the CLIProxyAPI fork

Reviewed 2026-09-05. Use official CLIProxyAPI **v7.2.151**, commit
`5208aec703b5ce7e3445f6e9d91cc13b3e78003a`. The model-catalog gap that required
the Claudex fork is fixed upstream; keeping a separate binary build is no longer
necessary for the four configured model routes.

## Evidence

The fork commit `2af596f087d63d1bd144349744e1f812ce40d0d5` adds Fable 5.1
to the embedded catalog, injects that model when absent from a refreshed catalog,
tests the injection, and changes release workflows. It does not add a separate
protocol translator. [Fork changes](https://github.com/Kanaliseren/CLIProxyAPI/commit/2af596f087d63d1bd144349744e1f812ce40d0d5).

Both the official release's embedded catalog and the remote model catalog at
`f1d6988816c14dd2634610fee1920407a5443f06` contain:

| Claudex route | Upstream model | Catalog availability |
| --- | --- | --- |
| Fable | `claude-fable-5-1` | Claude |
| Opus | `claude-opus-5` | Claude |
| Sol | `gpt-5.6-sol` | Codex Team, Plus, Pro |
| Terra | `gpt-5.6-terra` | Codex Free, Team, Plus, Pro |

Sources: [embedded catalog](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/registry/models/models.json),
[remote catalog snapshot](https://github.com/router-for-me/models/blob/f1d6988816c14dd2634610fee1920407a5443f06/models.json).
Catalog presence establishes routing metadata, not account entitlement or a
successful provider request.

Upstream loads the embedded catalog at startup, refreshes it immediately in the
background, then refreshes every three hours. Failed fetches preserve the current
catalog. Successful refreshes replace it and notify affected provider registrations.
The official Claude getter does not retain the fork's unconditional Fable fallback.
Therefore a future valid upstream catalog that removes Fable could remove its
registration; neither audited catalog has that problem.
[Updater](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/registry/model_updater.go),
[model getters](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/registry/model_definitions.go).

## Tool Search limitation

The native Claude executor explicitly remaps tool references in Tool Search
results, including streaming responses and conversation history. Upstream has
focused tests for these paths.
[Implementation](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/runtime/executor/claude_executor_request.go),
[tests](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/runtime/executor/claude_executor_request_remap_test.go).

The Claude-to-Codex translator has no equivalent Tool Search conversion: it
removes `defer_loading`, converts non-web-search tool declarations to functions,
and retains only text and images from mixed tool-result content arrays. A tool
reference alongside text is consequently omitted. This source review does not
establish end-to-end Tool Search compatibility for Sol/Terra sessions. The fork
does not patch this translator, so retaining it would not resolve the limitation.
[Codex translator](https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/translator/codex/claude/codex_claude_request.go).

## Verification scope

The official v7.2.151 release binary passed the local Codex access canary during
this migration. Native Claude runtime requests were deliberately not run because
the available Claude subscription is exhausted. Native Opus/Fable compatibility
here is supported by catalog and source inspection, not a fresh live-provider
test. The upstream Go tests cited above were inspected, not executed in this audit.

Removing the fork delegates proxy fixes and binary releases to upstream. It does
not make arbitrary future releases automatically compatible; preserve checksum
verification, a candidate canary, and rollback when updating.
