# ClickHouse request logging

Stores every request and response that goes through the claudex proxy in a
local ClickHouse, with secrets redacted, so you can search past Claude and
Codex traffic. Off by default. Linux x64 only for now: the plugin build is
pinned for `linux-x64` in `channel/stable.json`.

| Part | What it is |
|---|---|
| `clickhouse-sink.so` | Third-party CLIProxyAPI plugin ([source](https://github.com/api-token/Cli-Proxy-API-Management-Center/tree/68c9bb8c701f2ed229e989a07f6d1ef1ec79da7a/plugins/clickhouse-sink)), pinned by commit and checksum, built with `clickhouse-sink.patch`. Runs inside the proxy, only observes traffic, redacts secrets, writes `requests` and `usage`. |
| `compose.yaml` | ClickHouse 26.8 LTS on `127.0.0.1:8123`, plus the plugin's deriver, which fills `request_facts` and the `messages` and `request_summary` views. The deriver has no network route except ClickHouse. |
| `users.xml` | `claudex_writer` (plugin and deriver) and `claudex_reader` (read-only, 60 s / 20 MB / 4 GB limits). No password-less `default` user. |

## Setup

```sh
# 1. Passwords: owner-only files, never in the repo.
(cd ~/.config/claudex && for f in clickhouse-password clickhouse-reader-password; do
  [ -e "$f" ] || (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$f")
done)

# 2. ClickHouse and the deriver (from this directory).
CLAUDEX_UID=$(id -u) CLAUDEX_GID=$(id -g) docker compose up -d --build

# 3. Build the plugin from the pinned commit (checks the recorded checksum)
#    and install it to ~/.local/share/claudex/plugins/.
./build-plugin.sh

# 4. Enable it. This restarts claudex.service, which interrupts running agents.
claudex configure --clickhouse http://127.0.0.1:8123
```

`claudex configure --no-clickhouse` turns it off again. The stack uses the
`cliproxy` database; `--clickhouse-database NAME` also needs the grants in
`users.xml` and the deriver's `CLICKHOUSE_DB` changed to match. Both passwords sit in
the claudex config directory, which the plugin and the deriver read for
redaction, so they are redacted like the OAuth tokens.

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

## What is not covered

- Secrets the redactor cannot recognise: values not in the config or auth
  directories that match no gitleaks rule, secrets inside images, and a
  pattern-matched secret that only appears base64-encoded.
- CLIProxyAPI's own error logs (`<auth dir>/logs/error-*.log`) still contain
  unredacted request bodies; that is upstream behaviour, independent of this.
- A stream chunk that carries part of a split secret is stored as the redaction
  marker instead of its JSON, so the raw chunk list is not exact for those chunks.

## Local patch

`clickhouse-sink.patch` hardens the pinned plugin after review: each request's
capture is capped at 64 MiB (512 MiB across in-flight requests; larger ones are
stored as metadata only), the ClickHouse client ignores redirects and proxy
environment variables, the usage `source` and `base_url` fields are redacted
(`source` can fall back to the client API key), and ClickHouse error text, which
can quote rejected rows, no longer reaches the proxy log.

## Upgrading the plugin

Change `plugins["clickhouse-sink"].commit` (and the deriver Dockerfile's `ADD`
line), review the diff, re-apply the patch, then run `build-plugin.sh --print-sha256` and record the
checksum. claudex refuses to enable a library whose checksum does not match.
