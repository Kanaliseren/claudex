import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readProxyKey, readProxySummary, renderProxyConfig, writeProxyConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { atomicWrite, run, shellQuote } from "../src/util.js";
import { claudeEnvironment, runClaude, writeClaudeWrapper } from "../src/wrapper.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

const manifest = fixtureManifest();

test("stable channel routes Sonnet and Haiku through Codex while Opus and Fable stay native", async () => {
  const stable = JSON.parse(
    await readFile(fileURLToPath(new URL("../channel/stable.json", import.meta.url)), "utf8"),
  );

  assert.deepEqual(stable.models.astra.aliases, ["claude-sonnet-5"]);
  assert.equal(stable.models.astra.upstream, "gpt-6-astra");
  assert.equal(stable.models.sol.alias, "claude-haiku-4-5");
  assert.equal(stable.models.sol.upstream, "gpt-5.6-sol");
  assert.equal(stable.models.opus.upstream, "claude-opus-5");
  assert.equal(stable.models.fable.upstream, "claude-fable-5-1");
});

test("setup config is loopback-only and preserves its generated key", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  const first = await writeProxyConfig(paths, manifest, { port: 18417 });
  const second = await writeProxyConfig(paths, manifest, { port: 18418 });
  const summary = await readProxySummary(paths.proxyConfig);

  assert.equal(first.proxyKey, second.proxyKey);
  assert.equal(await readProxyKey(paths.proxyConfig), first.proxyKey);
  const config = await readFile(paths.proxyConfig, "utf8");
  assert.match(config, /name: "gpt-6-astra"\n      alias: "claude-sonnet-5"/);
  assert.match(config, /name: "gpt-5\.6-sol"\n      alias: "claude-haiku-4-5"/);
  assert.match(config, /user-agent: "claude-cli\/2\.1\.257 \(external, cli\)"/);
  assert.doesNotMatch(config, /alias: "claude-opus-5"/);
  assert.doesNotMatch(config, /alias: "claude-fable-5-1"/);
  assert.deepEqual(summary, {
    host: "127.0.0.1",
    port: 18418,
    authDir: paths.authDir,
    remoteManagementDisabled: true,
    tlsDisabled: true,
  });
});

test("config summary decodes a quoted Windows auth path", async (t) => {
  const root = await temporaryRoot(t);
  const configPath = `${root}/windows.yaml`;
  const authDir = "C:\\Users\\example\\AppData\\Local\\cliproxy-oauth\\auth";
  const yaml = renderProxyConfig({
    paths: { authDir },
    manifest,
    port: 18417,
    proxyKey: "test-key",
  });
  await atomicWrite(configPath, yaml);

  assert.equal((await readProxySummary(configPath)).authDir, authDir);
});

test("Claude wrapper feature-detects flags and keeps ToolSearch enabled for future versions", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  await writeProxyConfig(paths, manifest, { port: 19223 });
  await writeClaudeWrapper(paths, manifest, { platform: "linux" });
  const wrapper = await readFile(paths.wrapper, "utf8");

  assert.match(wrapper, /ANTHROPIC_BASE_URL='http:\/\/127\.0\.0\.1:19223'/);
  assert.match(wrapper, /--exclude-dynamic-system-prompt-sections/);
  assert.match(wrapper, /--append-system-prompt/);
  assert.match(wrapper, /export ENABLE_TOOL_SEARCH=true/);
  assert.doesNotMatch(wrapper, /unset ENABLE_TOOL_SEARCH/);
  assert.doesNotMatch(wrapper, /local-[a-f0-9]{64}/);
});

test("Claude command keeps the proxy ToolSearch override on an untested future version", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  await writeProxyConfig(paths, manifest, { port: 19224 });
  let invocation;
  const runCommand = async (_binary, args, options) => {
    if (args[0] === "--help") {
      return { code: 0, stdout: "--append-system-prompt --exclude-dynamic-system-prompt-sections", stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: "99.0.0 (Claude Code)", stderr: "" };
    invocation = { args, options };
    return { code: 0, stdout: "", stderr: "" };
  };

  assert.equal(await runClaude(paths, manifest, ["-p", "hello"], { runCommand }), 0);
  assert.equal(invocation.options.env.ENABLE_TOOL_SEARCH, "true");
  assert.equal(invocation.options.env.ANTHROPIC_MODEL, "gpt-6-astra");
  assert.equal(invocation.options.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
  assert.equal(invocation.options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "80");
  assert.deepEqual(invocation.args.slice(-2), ["-p", "hello"]);
});

test("installed wrappers pass the same model budgets and capabilities as direct launches", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await writeProxyConfig(paths, manifest);
  const expected = await claudeEnvironment(paths, manifest);
  const fake = `${root}/claude`;
  const capture = `${root}/capture.mjs`;
  await atomicWrite(capture, `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(name => [name, process.env[name]]))));\n`);
  await atomicWrite(fake, `#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(capture)}\n`, 0o700);
  await writeClaudeWrapper(paths, manifest);
  const result = await run(paths.wrapper, [], { env: { CLAUDE_CODE_BINARY: fake } });
  assert.deepEqual(JSON.parse(result.stdout), expected);

  await writeClaudeWrapper(paths, manifest, { platform: "win32" });
  const windows = await readFile(paths.wrapper, "utf8");
  for (const name of Object.keys(expected).filter((name) => name.includes("MODEL") || name.includes("CONTEXT") || name.includes("COMPACT"))) {
    assert.ok(windows.includes(`set "${name}=${expected[name]}"`), name);
  }
});
