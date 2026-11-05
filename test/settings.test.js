import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configure, dashboardSummary } from "../src/settings.js";
import { readProxyKey, readProxyOptions, readProxySummary, writeProxyConfig } from "../src/config.js";
import { platformKey, resolvePaths } from "../src/paths.js";
import { checkUpdate } from "../src/update-check.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

test("dashboard and sticky routing survive regeneration and upstream key hashing", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const manifest = fixtureManifest();
  await writeProxyConfig(paths, manifest);
  const proxyKey = await readProxyKey(paths.proxyConfig);
  await configure(paths, manifest, { dashboard: true, sessionAffinity: true, strategy: "fill-first" });
  const key = (await readFile(paths.dashboardKey, "utf8")).trim();
  assert.ok(Buffer.byteLength(key) <= 72, "upstream bcrypt accepts at most 72 bytes");
  assert.notEqual(key, proxyKey);
  const summary = await dashboardSummary(paths);
  assert.equal(summary.enabled, true);
  assert.equal(summary.sessionAffinity, true);
  assert.equal(summary.strategy, "fill-first");
  assert.ok(!JSON.stringify(summary).includes(key));
  // CLIProxyAPI replaces the plaintext management key with a bcrypt hash on startup.
  const hash = "$2a$10$example-test-hash";
  await writeFile(paths.proxyConfig, (await readFile(paths.proxyConfig, "utf8")).replace(key, hash));
  await writeProxyConfig(paths, manifest);
  assert.deepEqual(await readProxyOptions(paths.proxyConfig), {
    dashboard: true, managementKey: hash, sessionAffinity: true, strategy: "fill-first", requestLog: false,
  });
  assert.equal(await readProxyKey(paths.proxyConfig), proxyKey);
  assert.equal((await readProxySummary(paths.proxyConfig)).remoteManagementDisabled, true);
  await configure(paths, manifest, { dashboard: false, sessionAffinity: false });
  assert.equal((await readProxyOptions(paths.proxyConfig)).managementKey, "");
  await configure(paths, manifest, { dashboard: true });
  assert.equal((await readProxyOptions(paths.proxyConfig)).managementKey, key);
});

test("a failed service restart restores the prior configuration", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const manifest = fixtureManifest();
  await writeProxyConfig(paths, manifest);
  paths.systemdUnit = paths.proxyConfig;
  const previous = await readFile(paths.proxyConfig, "utf8");
  await assert.rejects(configure(paths, manifest, {
    dashboard: true, platform: "linux", runCommand: async () => { throw new Error("restart failed"); },
  }), /restart failed/);
  assert.equal(await readFile(paths.proxyConfig, "utf8"), previous);
});

test("request logging renders only the pinned tap and survives regeneration", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const library = Buffer.from("reviewed build");
  const fixture = fixtureManifest();
  const manifest = {
    ...fixture,
    proxy: { ...fixture.proxy, assets: { [platformKey()]: { url: "https://example.invalid/proxy", sha256: "0".repeat(64) } } },
    plugins: { "claudex-tap": { assets: { [platformKey()]: { sha256: createHash("sha256").update(library).digest("hex") } } } },
  };
  await writeProxyConfig(paths, manifest);
  const tap = join(paths.pluginsDir, "claudex-tap.so");

  await assert.rejects(configure(paths, manifest, { requestLog: true }), /must hold only claudex-tap\.so/);
  await mkdir(join(paths.pluginsDir, "linux", "amd64"), { recursive: true });
  await writeFile(tap, "tampered build");
  await assert.rejects(configure(paths, manifest, { requestLog: true }), /checksum mismatch/);
  await writeFile(tap, library);
  // The proxy also loads <dir>/<os>/<arch>, where a versioned file would win.
  await writeFile(join(paths.pluginsDir, "linux", "amd64", "claudex-tap-v9.so"), "shadow");
  await assert.rejects(configure(paths, manifest, { requestLog: true }), /must hold only/);
  await rm(join(paths.pluginsDir, "linux"), { recursive: true });

  await configure(paths, manifest, { requestLog: true });
  await writeProxyConfig(paths, manifest);
  const config = await readFile(paths.proxyConfig, "utf8");
  assert.ok(config.endsWith(`
plugins:
  enabled: true
  dir: ${JSON.stringify(paths.pluginsDir)}
  configs:
    claudex-tap:
      enabled: true
      socket: ${JSON.stringify(paths.tapSocket)}
`));
  assert.equal((await readProxyOptions(paths.proxyConfig)).requestLog, true);
  assert.equal((await checkUpdate(paths, manifest)).configMatchesChannel, true);

  await configure(paths, manifest, { requestLog: false });
  assert.doesNotMatch(await readFile(paths.proxyConfig, "utf8"), /plugins:/);
});
