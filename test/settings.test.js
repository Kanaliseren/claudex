import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
    dashboard: true, managementKey: hash, sessionAffinity: true, strategy: "fill-first", clickhouse: null,
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

test("ClickHouse logging renders the pinned sink with file-based secrets and survives regeneration", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const library = Buffer.from("reviewed build");
  const fixture = fixtureManifest();
  const manifest = {
    ...fixture,
    proxy: { ...fixture.proxy, assets: { [platformKey()]: { url: "https://example.invalid/proxy", sha256: "0".repeat(64) } } },
    plugins: { "clickhouse-sink": { assets: { [platformKey()]: { sha256: createHash("sha256").update(library).digest("hex") } } } },
  };
  await writeProxyConfig(paths, manifest);
  const clickhouse = { url: "http://127.0.0.1:8123", database: "cliproxy" };

  await assert.rejects(configure(paths, manifest, { clickhouse }), /not installed/);
  await mkdir(paths.pluginsDir, { recursive: true });
  await writeFile(join(paths.pluginsDir, "clickhouse-sink.so"), "tampered build");
  await assert.rejects(configure(paths, manifest, { clickhouse }), /checksum mismatch/);
  await writeFile(join(paths.pluginsDir, "clickhouse-sink.so"), library);
  await writeFile(paths.clickhousePassword, "pw-from-file-0123456789\n", { mode: 0o644 });
  await assert.rejects(configure(paths, manifest, { clickhouse }), /owner-only/);
  await chmod(paths.clickhousePassword, 0o600);

  await configure(paths, manifest, { clickhouse });
  await writeProxyConfig(paths, manifest);
  const config = await readFile(paths.proxyConfig, "utf8");
  assert.ok(config.endsWith(`
plugins:
  enabled: true
  dir: ${JSON.stringify(paths.pluginsDir)}
  configs:
    clickhouse-sink:
      enabled: true
      url: "http://127.0.0.1:8123"
      database: "cliproxy"
      username: "claudex_writer"
      password: "pw-from-file-0123456789"
      redact-files:
        - ${JSON.stringify(paths.configDir)}
        - ${JSON.stringify(paths.authDir)}
`));
  assert.deepEqual((await readProxyOptions(paths.proxyConfig)).clickhouse, clickhouse);
  assert.equal((await checkUpdate(paths, manifest)).configMatchesChannel, true);

  await configure(paths, manifest, { clickhouse: null });
  assert.doesNotMatch(await readFile(paths.proxyConfig, "utf8"), /plugins:|pw-from-file/);
});
