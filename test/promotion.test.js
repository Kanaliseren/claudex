import test from "node:test";
import assert from "node:assert/strict";
import { promoteProxy } from "../src/promotion.js";
import { fixtureManifest } from "../test-support/helpers.js";

test("proxy promotion replaces every pinned asset from release metadata", () => {
  const tag = "v7.2.147-claudex.1";
  const file = (platform) => `cli-proxy-api-${platform}.gz`;
  const asset = (platform) => ({
    platform,
    file: file(platform),
    sha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 123,
  });
  const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
  const metadata = {
    schemaVersion: 1,
    version: tag,
    commit: "c".repeat(40),
    assets: Object.fromEntries(platforms.map((platform) => [platform, asset(platform)])),
  };

  const promoted = promoteProxy(fixtureManifest(), metadata, {
    tag,
    claudeVersion: "2.1.258",
    repository: "Kanaliseren/CLIProxyAPI",
  });

  assert.equal(promoted.proxy.version, tag);
  assert.equal(promoted.proxy.upstreamVersion, "v7.2.147");
  assert.deepEqual(promoted.compatibility.claudeCode.tested, ["2.1.257", "2.1.258"]);
  assert.equal(promoted.proxy.assets["linux-x64"].url, `https://github.com/Kanaliseren/CLIProxyAPI/releases/download/${tag}/${file("linux-x64")}`);
});
