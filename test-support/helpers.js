import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "claudex-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function fixtureManifest() {
  return {
    schemaVersion: 1,
    proxy: { version: "v-test", upstreamVersion: "v-test", commit: "abc", repository: "example/repo", tag: "v-test", assets: {} },
    models: {
      astra: {
        upstream: "gpt-6-astra",
        alias: "claude-sonnet-5",
        aliases: ["claude-sonnet-5"],
        displayName: "Astra",
      },
      sol: { upstream: "gpt-5.6-sol", alias: "claude-haiku-4-5", displayName: "Sol" },
      opus: { upstream: "claude-opus-5", alias: "claude-opus-5", displayName: "Opus" },
      fable: { upstream: "claude-fable-5-1", alias: "claude-fable-5-1", displayName: "Fable" },
    },
    compatibility: {
      claudeCode: {
        tested: ["2.1.257"],
        requiredCapabilities: ["--append-system-prompt"],
        optionalCapabilities: ["--exclude-dynamic-system-prompt-sections"],
      },
      cliProxyAPI: { requiredCapabilities: ["-codex-login", "-codex-device-login", "-config"] },
    },
  };
}
