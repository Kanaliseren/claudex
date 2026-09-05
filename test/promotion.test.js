import test from "node:test";
import assert from "node:assert/strict";
import { upstreamAssets, upstreamRepository } from "../src/promotion.js";

function releaseFixture() {
  const suffixes = ["linux_amd64.tar.gz", "linux_aarch64.tar.gz", "darwin_amd64.tar.gz", "darwin_aarch64.tar.gz", "windows_amd64.zip"];
  const assets = suffixes.map((suffix) => {
    const name = `CLIProxyAPI_7.2.151_${suffix}`;
    return { name, size: 123, browser_download_url: `https://github.com/${upstreamRepository}/releases/download/v7.2.151/${name}` };
  });
  return { release: { tag_name: "v7.2.151", assets }, checksums: assets.map(({ name }) => `${"a".repeat(64)}  ${name}`).join("\n") };
}

test("official releases map all supported platforms with archive checksums", () => {
  const { release, checksums } = releaseFixture();
  const assets = upstreamAssets(release, checksums);
  assert.equal(Object.keys(assets).length, 5);
  assert.equal(assets["linux-arm64"].compression, "tar.gz");
  assert.equal(assets["win32-x64"].compression, "zip");
  assert.equal(assets["win32-x64"].executable, "cli-proxy-api.exe");
  assert.equal(assets["linux-x64"].archiveSha256, "a".repeat(64));
});

test("promotion refuses missing checksums, substituted URLs, and prereleases", () => {
  const { release, checksums } = releaseFixture();
  assert.throws(() => upstreamAssets(release, checksums.split("\n").slice(1).join("\n")), /missing verified/);
  assert.throws(() => upstreamAssets({ ...release, prerelease: true }, checksums), /stable upstream/);
  release.assets[0].browser_download_url = "https://example.invalid/substitute";
  assert.throws(() => upstreamAssets(release, checksums), /missing verified/);
});

test("a release missing a configured native or Codex model cannot be promoted", async () => {
  const { validateUpstreamModels } = await import("../src/promotion.js");
  const { fixtureManifest } = await import("../test-support/helpers.js");
  const manifest = fixtureManifest();
  const catalog = { claude: [{ id: "claude-opus-5" }, { id: "claude-fable-5-1" }], "codex-pro": [{ id: "gpt-6-astra" }, { id: "gpt-5.6-sol" }] };
  assert.doesNotThrow(() => validateUpstreamModels(manifest, catalog));
  catalog.claude.pop();
  assert.throws(() => validateUpstreamModels(manifest, catalog), /missing configured model: fable/);
});
