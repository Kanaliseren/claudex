import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connectShared } from "../src/shared.js";
import { setup, upgrade, login, rollback } from "../src/lifecycle.js";
import { configure } from "../src/settings.js";
import { integrateT3 } from "../src/integrations.js";
import { resolvePaths } from "../src/paths.js";
import { atomicWrite, exists } from "../src/util.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

test("shared clients use existing accounts and T3 aliases without owning the proxy", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const manifest = fixtureManifest();
  const calls = [];
  await connectShared(paths, manifest, { port: 8317, proxyKey: "test-inbound", managementKey: "test-admin" }, {
    fetchImpl: async (url, options) => { calls.push([url, options.headers.Authorization]); return { ok: true }; },
  });
  assert.deepEqual(calls, [
    ["http://127.0.0.1:8317/v1/models", "Bearer test-inbound"],
    ["http://127.0.0.1:8317/v0/management/auth-files", "Bearer test-admin"],
  ]);
  assert.equal(await exists(paths.authDir), false);
  assert.equal(await exists(paths.currentBinary), false);
  const settings = `${root}/t3.json`;
  await atomicWrite(settings, JSON.stringify({ providerInstances: { claudeAgent: { environment: [] } } }));
  await integrateT3(paths, manifest, settings, { includeHub: true });
  const config = JSON.parse(await readFile(settings, "utf8"));
  const env = Object.fromEntries(config.providerInstances.claudeAgent.environment.map(({ name, value }) => [name, value]));
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-6-astra");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-5.6-sol");
  assert.deepEqual(config.providerInstances.claudeAgent.config.customModels, ["gpt-6-astra", "gpt-5.6-sol", "claude-opus-5", "claude-fable-5-1"]);
  assert.equal(config.usageLimitSources.claudex.managementKey, "test-admin");
  for (const action of [() => setup(paths, manifest), () => upgrade(paths, manifest), () => rollback(paths), () => login(paths), () => configure(paths, manifest)]) {
    await assert.rejects(action(), /shared proxy/);
  }
});

test("a rejected shared connection leaves no usable client config", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await assert.rejects(connectShared(paths, fixtureManifest(), { port: 8317, proxyKey: "bad", managementKey: "bad" }, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
  assert.equal(await exists(paths.proxyConfig), false);
  assert.equal(await exists(paths.stateFile), false);
});
