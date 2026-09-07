import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.js";
import { resolvePaths } from "../src/paths.js";
import { writeProxyConfig } from "../src/config.js";
import { saveState } from "../src/state.js";
import { checkUpdate } from "../src/update-check.js";
import { atomicWrite, run, sha256File, shellQuote } from "../src/util.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

const cli = fileURLToPath(new URL("../bin/claudex.js", import.meta.url));

test("models and update --check work without setup and do not create installation files", async (t) => {
  const root = await temporaryRoot(t);
  const env = { CLAUDEX_HOME: root, CLAUDE_CODE_BINARY: join(root, "must-not-run") };
  const models = await run(process.execPath, [cli, "models", "--json"], { env });
  const manifest = await loadManifest();
  assert.deepEqual(JSON.parse(models.stdout).map(({ name, alias, upstream }) => ({ name, alias, upstream })),
    Object.entries(manifest.models).map(([name, model]) => ({ name, alias: model.alias, upstream: model.upstream })));
  const checked = await run(process.execPath, [cli, "update", "--check", "--json"], { env });
  assert.deepEqual(JSON.parse(checked.stdout), {
    installed: false,
    installedVersion: null,
    channelVersion: manifest.proxy.version,
    binaryMatchesChannel: false,
    configMatchesChannel: false,
    action: "setup",
  });
  assert.deepEqual(await readdir(root), []);
});

test("update checks compare actual binary and config without modifying them", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const manifest = fixtureManifest();
  await atomicWrite(paths.currentBinary, "tested binary");
  const sha256 = await sha256File(paths.currentBinary);
  const target = { platform: "linux", arch: "x64" };
  manifest.proxy.assets["linux-x64"] = { url: "https://example.invalid/not-downloaded", sha256 };
  await writeProxyConfig(paths, manifest);
  await saveState(paths, { activeRelease: { version: "v-test", sha256 } });
  const beforeState = await readFile(paths.stateFile, "utf8");
  const beforeConfig = await readFile(paths.proxyConfig, "utf8");

  assert.equal((await checkUpdate(paths, manifest, { target })).action, "none");
  const nextManifest = structuredClone(manifest);
  nextManifest.models.astra.aliases.push("claude-sonnet-future");
  const configUpdate = await checkUpdate(paths, nextManifest, { target });
  assert.equal(configUpdate.binaryMatchesChannel, true);
  assert.equal(configUpdate.configMatchesChannel, false);
  assert.equal(configUpdate.action, "update");

  await atomicWrite(paths.currentBinary, "different binary despite matching saved state");
  const binaryUpdate = await checkUpdate(paths, manifest, { target });
  assert.equal(binaryUpdate.binaryMatchesChannel, false);
  assert.equal(binaryUpdate.configMatchesChannel, true);
  assert.equal(binaryUpdate.action, "update");
  assert.equal(await readFile(paths.stateFile, "utf8"), beforeState);
  assert.equal(await readFile(paths.proxyConfig, "utf8"), beforeConfig);
  await writeProxyConfig(paths, manifest, { dashboard: true, managementKey: "$2a$10$test-hash", sessionAffinity: true });
  const hashedConfig = (await readFile(paths.proxyConfig, "utf8")).split("\n").filter((line) => line.trim()).join("\n");
  await atomicWrite(paths.proxyConfig, hashedConfig);
  assert.equal((await checkUpdate(paths, manifest, { target })).configMatchesChannel, true);
});

test("invalid run names and unsafe check combinations fail before invoking Claude or setup", async (t) => {
  const root = await temporaryRoot(t);
  const env = { CLAUDEX_HOME: root, CLAUDE_CODE_BINARY: join(root, "must-not-run") };
  for (const args of [["run"], ["run", "constructor"], ["run", "unknown"], ["setup", "--check"], ["update", "--check", "--binary", "custom"], ["update", "--json"]]) {
    const result = await run(process.execPath, [cli, ...args], { env, allowFailure: true });
    assert.equal(result.code, 1, args.join(" "));
    assert.doesNotMatch(result.stderr, /ENOENT|must-not-run/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("named launches select each manifest model, pass Claude flags through, and preserve exit codes", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  const manifest = await loadManifest();
  await writeProxyConfig(paths, manifest);
  const configBefore = await readFile(paths.proxyConfig, "utf8");
  const fake = join(root, "fake-claude");
  const capture = join(root, "capture.mjs");
  await atomicWrite(capture, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;\n');
  await atomicWrite(fake, `#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo '--append-system-prompt --exclude-dynamic-system-prompt-sections'\n  exit 0\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(capture)} "$@"\n`, 0o700);
  const env = { CLAUDEX_HOME: root, CLAUDE_CODE_BINARY: fake };
  for (const [name, model] of Object.entries(manifest.models)) {
    const result = await run(process.execPath, [cli, "run", name, "--", "--print", "prompt with spaces", "--output-format", "json"], { env, allowFailure: true });
    assert.equal(result.code, 7);
    const args = JSON.parse(result.stdout);
    assert.deepEqual(args.slice(-6), ["--model", model.alias, "--print", "prompt with spaces", "--output-format", "json"]);
    assert.ok(args.includes("--append-system-prompt"));
    assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
  }
  const legacy = await run(process.execPath, [cli, "claude", "--", "--print", "unchanged"], { env, allowFailure: true });
  assert.equal(legacy.code, 7);
  assert.deepEqual(JSON.parse(legacy.stdout).slice(-2), ["--print", "unchanged"]);
  assert.equal(await readFile(paths.proxyConfig, "utf8"), configBefore);
});

test("existing hub inspection never prints its management key", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await atomicWrite(paths.hubConfig, JSON.stringify({ host: "127.0.0.1", port: 8318, authDir: paths.authDir, managementKey: "test-secret-do-not-print" }));
  const result = await run(process.execPath, [cli, "hub", "--json"], { env: { CLAUDEX_HOME: root } });
  assert.deepEqual(JSON.parse(result.stdout), { url: "http://127.0.0.1:8318" });
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret|managementKey/);
});
