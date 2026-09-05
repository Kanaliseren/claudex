import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractExecutable } from "../src/archive.js";
import { assetForPlatform } from "../src/manifest.js";
import { run } from "../src/util.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

for (const compression of ["gzip", "tar.gz", "zip"]) {
  test(`extract only the executable from ${compression}`, async (t) => {
    const root = await temporaryRoot(t);
    const binary = "synthetic executable\n";
    const executable = "cli-proxy-api";
    const archive = join(root, `release.${compression}`);
    await writeFile(join(root, executable), binary);
    await writeFile(join(root, "config.yaml"), "must not be installed");
    if (compression === "gzip") await writeFile(archive, gzipSync(binary));
    else if (compression === "tar.gz") await run("tar", ["-czf", archive, executable, "config.yaml"], { cwd: root });
    else if (process.platform === "win32") await run("tar", ["-a", "-cf", archive, executable, "config.yaml"], { cwd: root });
    else await run("zip", ["-q", archive, executable, "config.yaml"], { cwd: root });
    const output = join(root, "extracted");
    await extractExecutable(archive, output, { compression, executable });
    assert.equal(await readFile(output, "utf8"), binary);
    assert.equal(await readFile(join(root, "config.yaml"), "utf8"), "must not be installed");
    await assert.rejects(extractExecutable(archive, output, { compression, executable }), /EEXIST|premature close/i);
  });
}

test("archive manifests reject path traversal and invalid sizes", () => {
  const manifest = fixtureManifest();
  const asset = { url: "https://example.invalid", sha256: "a".repeat(64), archiveSha256: "b".repeat(64), archiveBytes: 10, compression: "tar.gz", executable: "../cli-proxy-api" };
  manifest.proxy.assets["linux-x64"] = asset;
  assert.throws(() => assetForPlatform(manifest, { platform: "linux", arch: "x64" }), /invalid executable/);
  asset.executable = "cli-proxy-api";
  asset.archiveBytes = -1;
  assert.throws(() => assetForPlatform(manifest, { platform: "linux", arch: "x64" }), /invalid archive/);
});

for (const mismatch of ["archive", "executable"]) {
  test(`${mismatch} checksum mismatch fails before executing the candidate`, async (t) => {
    const root = await temporaryRoot(t);
    const { createHash } = await import("node:crypto");
    const { resolvePaths } = await import("../src/paths.js");
    const { stageRelease } = await import("../src/binary.js");
    const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
    const archive = gzipSync("untrusted executable");
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const manifest = fixtureManifest();
    manifest.proxy.assets["linux-x64"] = {
      url: `data:application/gzip;base64,${archive.toString("base64")}`,
      sha256: mismatch === "executable" ? "0".repeat(64) : hash("untrusted executable"),
      archiveSha256: mismatch === "archive" ? "0".repeat(64) : hash(archive),
      archiveBytes: archive.length,
      compression: "gzip",
    };
    let executions = 0;
    await assert.rejects(stageRelease(paths, manifest, {
      target: { platform: "linux", arch: "x64" },
      runCommand: async () => { executions += 1; throw new Error("must not execute"); },
    }), /checksum mismatch/);
    assert.equal(executions, 0);
  });
}
