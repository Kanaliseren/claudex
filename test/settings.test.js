import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { configure, dashboardSummary } from "../src/settings.js";
import { readProxyKey, readProxyOptions, readProxySummary, writeProxyConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
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
    dashboard: true, managementKey: hash, sessionAffinity: true, strategy: "fill-first",
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
