import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installQuotaHub } from "../src/hub.js";
import { dashboardSummary } from "../src/settings.js";
import { integrateT3 } from "../src/integrations.js";
import { writeProxyConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { atomicWrite } from "../src/util.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

async function fixture(t) {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root, platform: "linux" });
  const manifest = fixtureManifest();
  await writeProxyConfig(paths, manifest, { dashboard: true, managementKey: "management-test-key" });
  await atomicWrite(paths.dashboardKey, "management-test-key\n");
  return { root, paths, manifest };
}

test("installing the adapter backs up the old hub and routes dashboard and T3 through it", async (t) => {
  const { root, paths, manifest } = await fixture(t);
  const scriptPath = join(paths.dataDir, "hub", "quota-hub.mjs");
  await atomicWrite(scriptPath, "old hub script");
  await atomicWrite(paths.hubConfig, JSON.stringify({ host: "127.0.0.1", port: 8318, authDir: paths.authDir, managementKey: "legacy-key" }));
  await atomicWrite(paths.hubSystemdUnit, "old hub unit");
  const calls = [];
  const result = await installQuotaHub(paths, manifest, { platform: "linux", runCommand: async (cmd, args) => calls.push([cmd, ...args]),
    fetchImpl: async (url, init) => { assert.equal(init.headers.Authorization, "Bearer management-test-key"); return Response.json({ files: [] }); } });
  assert.equal(result.url, "http://127.0.0.1:8318");
  assert.equal(await readFile(join(result.backup, "1.bak"), "utf8"), "old hub script");
  assert.equal(JSON.parse(await readFile(paths.hubConfig, "utf8")).upstreamUrl, "http://127.0.0.1:8317");
  assert.equal((await dashboardSummary(paths)).url, "http://127.0.0.1:8318/management.html");
  const settings = join(root, "t3-settings.json");
  await writeFile(settings, JSON.stringify({ providerInstances: { claudeAgent: { environment: [] } }, usageLimitSources: { other: { enabled: true } } }));
  await integrateT3(paths, manifest, settings, { includeHub: true });
  const sources = JSON.parse(await readFile(settings, "utf8")).usageLimitSources;
  assert.equal(sources.claudex.url, result.url);
  assert.deepEqual(sources.other, { enabled: true });
  assert.deepEqual(calls.at(-1), ["systemctl", "--user", "restart", "claudex-hub.service"]);
});

test("failed hub installation restores the existing script, unit and configuration", async (t) => {
  const { paths, manifest } = await fixture(t);
  const scriptPath = join(paths.dataDir, "hub", "quota-hub.mjs");
  const config = JSON.stringify({ host: "127.0.0.1", port: 8318, authDir: paths.authDir, managementKey: "legacy-key" });
  await atomicWrite(scriptPath, "old script");
  await atomicWrite(paths.hubSystemdUnit, "old unit");
  await atomicWrite(paths.hubConfig, config);
  await assert.rejects(installQuotaHub(paths, manifest, { platform: "linux", runCommand: async (cmd, args) => {
    if (args.includes("restart")) throw new Error("restart failed");
  } }), /restart failed/);
  assert.equal(await readFile(scriptPath, "utf8"), "old script");
  assert.equal(await readFile(paths.hubSystemdUnit, "utf8"), "old unit");
  assert.equal(await readFile(paths.hubConfig, "utf8"), config);
});
