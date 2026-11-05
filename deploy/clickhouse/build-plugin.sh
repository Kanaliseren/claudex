#!/usr/bin/env bash
# Builds claudex-tap.so from deploy/clickhouse/tap in the Go image pinned in
# channel/stable.json, runs its tests offline, checks the build against the
# recorded checksum, and installs it as the only library in the proxy's
# plugin directory. Linux only: the official proxy is glibc + cgo, and the
# Debian bookworm builder links against an older glibc than current hosts.
#
# Usage: deploy/clickhouse/build-plugin.sh [--print-sha256]
#   --print-sha256  build and print the checksum without installing (to record
#                   a new pin in channel/stable.json after reviewing the tap).
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
read -r builder recorded dest < <(node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const [manifestPath, pathsModule] = process.argv.slice(1);
  const pin = JSON.parse(await readFile(manifestPath, "utf8")).plugins["claudex-tap"];
  const { resolvePaths } = await import(pathsModule);
  console.log(pin.builder, pin.assets["linux-x64"]?.sha256 ?? "-", resolvePaths().pluginsDir);
' "$repo_root/channel/stable.json" "$repo_root/src/paths.js")

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# The tap has no dependencies, so the build needs no network. Fixed paths,
# -trimpath and an empty build ID make the output reproducible.
docker run --rm --network none -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/gocache \
  -v "$repo_root/deploy/clickhouse/tap:/src:ro" -v "$out:/out" -w /src "$builder" \
  sh -c 'go vet ./... && go test -race -count=1 ./... >/out/test.log 2>&1 || { cat /out/test.log; exit 1; }
         go build -trimpath -buildvcs=false -buildmode=c-shared -ldflags=-buildid= -o /out/claudex-tap.so .'

sha=$(sha256sum "$out/claudex-tap.so" | cut -d' ' -f1)
if [[ "${1:-}" == "--print-sha256" ]]; then echo "$sha"; exit 0; fi
if [[ "$sha" != "$recorded" ]]; then
  echo "checksum $sha does not match channel/stable.json ($recorded); not installing" >&2
  exit 1
fi

install -d -m 700 "$dest"
install -m 644 "$out/claudex-tap.so" "$dest/.claudex-tap.so.tmp"
mv "$dest/.claudex-tap.so.tmp" "$dest/claudex-tap.so"
echo "installed $dest/claudex-tap.so ($sha)"
