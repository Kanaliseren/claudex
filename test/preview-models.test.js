import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadManifest, validateManifest } from "../src/manifest.js";
import { validateUpstreamModels } from "../src/promotion.js";
import { diagnose } from "../src/doctor.js";
import { integrateT3 } from "../src/integrations.js";
import { resolvePaths } from "../src/paths.js";
import { writeProxyConfig } from "../src/config.js";
import { saveState } from "../src/state.js";
import { temporaryRoot } from "../test-support/helpers.js";

test("preview model preparation preserves working routes and distinguishes catalog readiness", async (t) => {
  const manifest = await loadManifest();
  manifest.models.opus55.preview = true;
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
  await writeProxyConfig(paths, manifest);
  await saveState(paths, { sharedProxy: { url: "http://127.0.0.1:8317" } });
  const configPath = join(root, "t3.json");
  await writeFile(configPath, JSON.stringify({
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    providerInstances: { claudeAgent: { environment: [], config: { customModels: ["claude-opus-5"] } } },
  }));
  await integrateT3(paths, manifest, configPath);
  await integrateT3(paths, manifest, configPath);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.defaultModelSelection.model, "claude-opus-5");
  assert.equal(config.providerInstances.claudeAgent.config.customModels.filter((id) => id === "claude-opus-5-5").length, 1);
  assert.equal(manifest.models.opus.upstream, "claude-opus-5");
  assert.equal(manifest.models.opus55.upstream, "claude-opus-5-5");

  const required = Object.values(manifest.models).filter((model) => !model.preview).map((model) => model.alias);
  const check = (ids) => diagnose(paths, manifest, {
    live: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) }),
    runCommand: async () => ({ code: 0, stdout: "2.1.257 --append-system-prompt", stderr: "" }),
  });
  const pending = await check(required);
  assert.equal(pending.ok, true);
  assert.equal(pending.checks.find((entry) => entry.name === "Claude Opus 5.5").status, "warn");
  const ready = await check([...required, "claude-opus-5-5"]);
  assert.equal(ready.checks.find((entry) => entry.name === "Claude Opus 5.5").status, "pass");
  assert.equal((await check([])).ok, false);

  const catalog = { claude: [{ id: "claude-opus-5" }, { id: "claude-fable-5-1" }], "codex-pro": [{ id: "gpt-6-astra" }, { id: "gpt-5.6-sol" }] };
  assert.doesNotThrow(() => validateUpstreamModels(manifest, catalog));
  manifest.models.opus55.preview = false;
  assert.throws(() => validateUpstreamModels(manifest, catalog), /missing configured model: opus55/);
  manifest.models.opus55.preview = "true";
  assert.throws(() => validateManifest(manifest), /invalid models.opus55.preview/);
});
