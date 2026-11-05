# Request logging

Stores every request and response that goes through the claudex proxy in a
local ClickHouse, with secrets redacted, so you can search past Claude and
Codex traffic. Off by default. Linux x64 only for now (the tap build is pinned
for `linux-x64` in `channel/stable.json`).

```
Claude Code / Codex ──► CLIProxyAPI ──► Anthropic / OpenAI
                          │ claudex-tap (in-process, copy-only)
                          ▼ unix socket, drops when busy
                       collector ──► ClickHouse ◄── deriver
                       (container, no internet)
```

| Part | What it is |
|---|---|
| `tap/` → `claudex-tap.so` | Our CLIProxyAPI plugin, ~350 lines, no dependencies. Each hook reserves room in a 64 MiB budget before copying its payload, queues it and returns an empty result, so requests and responses are never changed. One goroutine writes the queue to the collector's socket; when the collector is down or slow, events are dropped (and announced to the collector later) and the proxy never waits. It never calls back into the proxy, and shutdown releases everything. |
| collector | The third-party [clickhouse-sink](https://github.com/api-token/Cli-Proxy-API-Management-Center/tree/68c9bb8c701f2ed229e989a07f6d1ef1ec79da7a/plugins/clickhouse-sink) capture, redaction and writer at a pinned commit, plus `clickhouse-sink.patch`, run as its own process. It writes `requests` and `usage`. A crash, stall or memory blow-up here only loses log rows. |
| deriver | From the same pinned source. Fills `request_facts` and the `messages` / `request_summary` views. |
| `compose.yaml` | ClickHouse 26.8 LTS on `127.0.0.1:8123`, the collector and the deriver. The collector and deriver sit on an internal network with no route out, and their writer user cannot use `url()`, `remote()` or `file()`. |
| `users.xml` | `claudex_writer` (collector and deriver) and `claudex_reader` (read-only, 60 s / 20 MB / 4 GB limits). No password-less `default` user. |

## Setup

```sh
# 1. Passwords: owner-only files, never in the repo or the proxy config.
(cd ~/.config/claudex && for f in clickhouse-password clickhouse-reader-password; do
  [ -e "$f" ] || (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$f")
done)

# 2. The tap's socket directory, owner-only.
install -d -m 700 ~/.local/state/claudex/tap

# 3. ClickHouse, the collector and the deriver (from this directory).
CLAUDEX_UID=$(id -u) CLAUDEX_GID=$(id -g) docker compose up -d --build

# 4. Build the tap (checks the recorded checksum) and install it as the only
#    library in ~/.local/share/claudex/plugins/.
./build-plugin.sh

# 5. Enable it. This restarts claudex.service, which interrupts running agents.
claudex configure --request-log
```

`claudex configure --no-request-log` turns it off. The plugin directory must
hold only `claudex-tap.so` with the pinned checksum: `configure --request-log`
refuses otherwise, and any other config write (for example `claudex update`)
pauses logging instead (`plugins.enabled: false`) so the proxy is never blocked.
On `claudex update`, the isolated canary first boots the new proxy with the tap
and checks that the host registered it; if not, it checks the proxy without
plugins and activates it with logging paused, with a warning. After rebuilding
the tap, `claudex configure --request-log` resumes logging.

The proxy copies plugins into `TMPDIR` before loading them, so the systemd
unit sets an owner-only `TMPDIR` (refreshed on every claudex restart). The
collector accepts no traffic until every file in the config and auth
directories has been read, so no row is redacted against a partial secret set.

## Searching

Use `claudex_reader`. Start with `messages`, then `request_facts` or
`request_summary`; fetch raw `requests` bodies one `request_id` at a time.
Ready-made queries: the plugin's
[`queries.sql`](https://github.com/api-token/Cli-Proxy-API-Management-Center/blob/68c9bb8c701f2ed229e989a07f6d1ef1ec79da7a/plugins/clickhouse-sink/queries.sql).

```sh
# -K reads the credentials from a pipe, so the password never appears in ps.
curl -s -K <(printf 'user = "claudex_reader:%s"\n' "$(cat ~/.config/claudex/clickhouse-reader-password)") \
  http://127.0.0.1:8123/ --data-binary \
  "SELECT started_at, role, substring(text, 1, 200) FROM cliproxy.messages WHERE text ILIKE '%migration%' ORDER BY started_at DESC LIMIT 20"
```

## Disk use and retention

Agents resend the whole conversation on every turn, so raw request bodies grow
with the square of a session's length (a busy day here is ~2 billion input
tokens, ~8 GB of raw JSON). The stack keeps what matters and drops the rest:

- `messages` / `request_facts` keep each turn's new input and the reply once,
  forever. Images, files and encrypted reasoning become placeholders there.
- `usage` and the metadata columns of `requests` stay forever.
- Raw `request_body`, `response_body` and `response_chunks` expire 14 days
  after their day; with daily partitions a day's bodies expire together.
- ClickHouse's own metric and trace tables are off (`config.xml`); they would
  otherwise add several GB a day. `query_log` keeps 7 days, server log files
  2 × 50 MB, and each container's Docker log 3 × 10 MB.
- The collector and deriver have Go memory limits under their container
  limits, so a burst slows them down instead of getting them killed.

Expect roughly 20–40 GB for the 14-day raw window and 5–15 GB a year of
derived data. Never run the deriver's `--rebuild` once raw bodies have expired:
it would re-derive those requests from empty bodies and lose their messages.

## Local patch

`clickhouse-sink.patch` adapts and hardens the pinned source after review:

- collector mode (`collector.go`, build tag `collector`): the sink reads the
  tap's frames from a unix socket instead of running inside the proxy;
- every string field of a usage or request row is redacted (`source` can fall
  back to the client API key, `session_id` can carry a client header);
- the known-secret set only grows, so a credential file read mid-rewrite or a
  rotated OAuth token is never forgotten; files are re-checked every 5 s;
- captures are capped (64 MiB per request, 512 MiB in flight), the ClickHouse
  client ignores redirects and proxy variables, and ClickHouse error text, which
  can quote rejected rows, is not logged;
- raw bodies expire after 14 days, with daily partitions;
- a `tap.dropped` announcement marks in-flight requests with
  `[clickhouse-sink: events lost, capture incomplete]` in `error`; so does a
  completion whose request never arrived;
- the collector only accepts the tap's methods and waits for a complete secret
  set before listening.

## What is not covered

- Secrets the redactor cannot recognise: values not in the config or auth
  directories that match no gitleaks rule, secrets inside images, a
  pattern-matched secret that only appears base64-encoded, and JSON that spells
  a secret with `\uXXXX` escapes.
- A request whose capture is dropped (over a size cap, or while the collector
  is down) keeps no messages for that turn; requests that are entirely lost
  leave no row at all, only the drop counts in the proxy and collector logs.
- CLIProxyAPI's own error logs (`<auth dir>/logs/error-*.log`) still contain
  unredacted request bodies; that is upstream behaviour, independent of this.
- When the dashboard is enabled, CLIProxyAPI's management API can install
  plugins, bypassing the pin. Anyone with the management key already has the
  OAuth tokens.

## Upgrading

- The proxy: `claudex update` as usual; its canary reports whether the tap
  still loads.
- The tap: after reviewing a change under `tap/`, run `build-plugin.sh
  --print-sha256`, record the checksum in `channel/stable.json`, then install.
- clickhouse-sink: change the commit in `sink.Dockerfile`, review the upstream
  diff, re-apply the patch, then `docker compose up -d --build`.
