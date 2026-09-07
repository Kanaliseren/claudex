import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeProxyConfig } from "../src/config.js";
import { integratePaseo, integrateT3 } from "../src/integrations.js";
import { resolvePaths } from "../src/paths.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

test("Paseo integration preserves unknown fields and creates a backup", async (t) => {
  const root = await temporaryRoot(t);
  const manifest = fixtureManifest();
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  await writeProxyConfig(paths, manifest, { port: 18417 });
  const configPath = join(root, "paseo.json");
  const original = {
    futureRoot: { keep: true },
    agents: { providers: { claude: { order: 3, futureProviderField: [1, 2], env: { KEEP_ME: "yes" } } } },
  };
  await writeFile(configPath, JSON.stringify(original), { mode: 0o644 });

  const result = await integratePaseo(paths, manifest, configPath);
  const updated = JSON.parse(await readFile(configPath, "utf8"));
  const backup = JSON.parse(await readFile(result.backup, "utf8"));

  assert.deepEqual(backup, original);
  assert.deepEqual(updated.futureRoot, original.futureRoot);
  assert.deepEqual(updated.agents.providers.claude.futureProviderField, [1, 2]);
  assert.equal(updated.agents.providers.claude.env.KEEP_ME, "yes");
  assert.equal(updated.agents.providers.claude.command, paths.wrapper);
  assert.equal(updated.agents.providers.claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18417");
  if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("T3 integration updates only the Claude environment and protects the token", async (t) => {
  const root = await temporaryRoot(t);
  const manifest = fixtureManifest();
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  const { proxyKey } = await writeProxyConfig(paths, manifest, { port: 18418 });
  const configPath = join(root, "t3.json");
  const original = {
    providerInstances: {
      claudeAgent: {
        driver: "claudeAgent",
        future: 42,
        config: { futureConfig: true, customModels: ["company-private-model"] },
        environment: [
          { name: "KEEP_ME", value: "yes", sensitive: false },
          { name: "ANTHROPIC_AUTH_TOKEN", value: "old", sensitive: true, valueRedacted: true },
          { name: "ANTHROPIC_API_KEY", value: "stale", sensitive: true, valueRedacted: true },
        ],
      },
      futureProvider: { keep: true },
    },
  };
  await writeFile(configPath, JSON.stringify(original), { mode: 0o644 });

  await integrateT3(paths, manifest, configPath);
  const updated = JSON.parse(await readFile(configPath, "utf8"));
  const env = Object.fromEntries(updated.providerInstances.claudeAgent.environment.map((entry) => [entry.name, entry]));

  assert.equal(updated.providerInstances.claudeAgent.future, 42);
  assert.deepEqual(updated.providerInstances.claudeAgent.config, {
    futureConfig: true,
    customModels: ["company-private-model", "gpt-6-astra", "gpt-5.6-sol", "claude-opus-5", "claude-fable-5-1"],
  });
  assert.deepEqual(updated.providerInstances.futureProvider, { keep: true });
  assert.equal(env.KEEP_ME.value, "yes");
  assert.equal(env.ANTHROPIC_BASE_URL.value, "http://127.0.0.1:18418");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN.value, proxyKey);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN.sensitive, true);
  // A redacted value is a secret-store reference in T3, not an inline credential.
  assert.equal(env.ANTHROPIC_AUTH_TOKEN.valueRedacted, undefined);
  assert.equal(env.ANTHROPIC_API_KEY.value, proxyKey);
  assert.equal(env.ANTHROPIC_API_KEY.sensitive, true);
  assert.equal(env.ANTHROPIC_API_KEY.valueRedacted, undefined);
  assert.equal(env.ANTHROPIC_MODEL.value, manifest.models.astra.upstream);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL.value, manifest.models.astra.upstream);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL.value, manifest.models.sol.upstream);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS.value, "272000");
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE.value, "87.3015873015873");
  assert.match(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES.value, /adaptive_thinking/);
  assert.match(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES.value, /effort/);
  assert.equal(env.ENABLE_TOOL_SEARCH.value, "true");
  assert.equal(env.API_TIMEOUT_MS.value, "3000000");
  if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("unknown T3 schema fails before writing", async (t) => {
  const root = await temporaryRoot(t);
  const manifest = fixtureManifest();
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  await writeProxyConfig(paths, manifest);
  const configPath = join(root, "t3-unknown.json");
  const original = '{"providerInstances":{"claudeAgent":{"environment":{"future":true}}}}\n';
  await writeFile(configPath, original, { mode: 0o600 });

  await assert.rejects(integrateT3(paths, manifest, configPath), /environment must be an array/);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("existing quota hub can be attached and removed without changing other usage sources", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await writeProxyConfig(paths, fixtureManifest());
  const configPath = join(root, "t3-settings.json");
  const { atomicWrite } = await import("../src/util.js");
  await atomicWrite(paths.hubConfig, JSON.stringify({ host: "127.0.0.1", port: 8318, authDir: paths.authDir, managementKey: "test-hub-key" }));
  await atomicWrite(configPath, JSON.stringify({ providerInstances: { claudeAgent: { environment: [] } }, usageLimitSources: { other: { enabled: true } } }));
  await integrateT3(paths, fixtureManifest(), configPath, { includeHub: true });
  let config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.usageLimitSources.claudex.managementKey, "test-hub-key");
  assert.deepEqual(config.usageLimitSources.other, { enabled: true });
  await integrateT3(paths, fixtureManifest(), configPath, { removeHub: true });
  config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.usageLimitSources, { other: { enabled: true } });
});

test("T3 uses official account management when the dashboard is enabled", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await writeProxyConfig(paths, fixtureManifest(), { dashboard: true, managementKey: "$2a$10$stored-hash", port: 18417 });
  await writeFile(paths.dashboardKey, "test-dashboard-key\n", { mode: 0o600 });
  const configPath = join(root, "t3-settings.json");
  await writeFile(configPath, JSON.stringify({ providerInstances: { claudeAgent: { environment: [] } }, usageLimitSources: { other: { enabled: true } } }));
  await integrateT3(paths, fixtureManifest(), configPath, { includeHub: true });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.usageLimitSources.claudex.url, "http://127.0.0.1:18417");
  assert.equal(config.usageLimitSources.claudex.managementKey, "test-dashboard-key");
  assert.deepEqual(config.usageLimitSources.other, { enabled: true });
});

test("legacy T3 settings gain a Claude instance without changing other providers", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await writeProxyConfig(paths, fixtureManifest());
  const file = join(root, 'legacy-t3.json');
  const providers = { codex: { enabled: true, future: 'keep' }, claudeAgent: { binaryPath: '/custom/claude', future: 42 } };
  await writeFile(file, JSON.stringify({ providers, environmentIcon: 'server' }));
  await integrateT3(paths, fixtureManifest(), file);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(config.providers, providers);
  assert.equal(config.environmentIcon, 'server');
  assert.equal(config.providerInstances.claudeAgent.driver, 'claudeAgent');
  assert.equal(config.providerInstances.claudeAgent.config.binaryPath, '/custom/claude');
  assert.equal(config.providerInstances.claudeAgent.config.future, 42);
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const entry = config.providerInstances.claudeAgent.environment.find((entry) => entry.name === name);
    assert.equal(entry.sensitive, true);
    assert.equal(entry.valueRedacted, undefined);
    assert.ok(entry.value.length > 0);
  }
});
