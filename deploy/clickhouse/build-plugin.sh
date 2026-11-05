#!/usr/bin/env bash
# Builds clickhouse-sink.so from the commit and Go image pinned in
# channel/stable.json, runs its tests, and installs it next to the proxy
# binary. Linux only: the official proxy is glibc + cgo, and the Debian
# bookworm builder links against an older glibc than the host, so the
# library loads on newer distributions too.
#
# Usage: deploy/clickhouse/build-plugin.sh [--print-sha256]
#   --print-sha256  build and print the checksum without installing (for
#                   recording a new pin in channel/stable.json).
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
read -r repository commit subdir builder recorded < <(node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const m = JSON.parse(await readFile(process.argv[1], "utf8"));
  const p = m.plugins["clickhouse-sink"];
  console.log(p.repository, p.commit, p.path, p.builder, p.assets["linux-x64"]?.sha256 ?? "-");
' "$repo_root/channel/stable.json")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone -q --filter=blob:none --no-checkout "https://github.com/$repository.git" "$work/src"
git -C "$work/src" checkout -q "$commit"
mkdir -p "$work/out"

# Fixed paths, -trimpath and an empty build ID make the output reproducible.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOMODCACHE=/tmp/gomod \
  -v "$work/src:/src:ro" -v "$work/out:/out" -w "/src/$subdir" "$builder" \
  sh -c 'go test ./... >/out/test.log 2>&1 || { cat /out/test.log; exit 1; }
         go build -trimpath -buildvcs=false -buildmode=c-shared -ldflags=-buildid= -o /out/clickhouse-sink.so .'

sha=$(sha256sum "$work/out/clickhouse-sink.so" | cut -d' ' -f1)
if [[ "${1:-}" == "--print-sha256" ]]; then echo "$sha"; exit 0; fi
if [[ "$sha" != "$recorded" ]]; then
  echo "checksum $sha does not match channel/stable.json ($recorded); not installing" >&2
  exit 1
fi

dest="${XDG_DATA_HOME:-$HOME/.local/share}/claudex/plugins"
install -d -m 700 "$dest"
install -m 644 "$work/out/clickhouse-sink.so" "$dest/clickhouse-sink.so.tmp"
mv "$dest/clickhouse-sink.so.tmp" "$dest/clickhouse-sink.so"
echo "installed $dest/clickhouse-sink.so ($sha)"
