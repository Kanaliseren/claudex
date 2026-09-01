#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../channel/stable.json", import.meta.url), "utf8"));
const [proxy, claude] = await Promise.all([
  json("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"),
  json("https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest"),
]);
const testedProxy = manifest.proxy.upstreamVersion ?? manifest.proxy.version.replace(/-(?:cacheopt|claudex)\.\d+$/, "");
const testedClaude = manifest.compatibility.claudeCode.tested.at(-1);
const changes = [];
if (proxy.tag_name !== testedProxy) changes.push(`CLIProxyAPI ${testedProxy} -> ${proxy.tag_name}`);
if (claude.version !== testedClaude) changes.push(`Claude Code ${testedClaude} -> ${claude.version}`);
if (process.env.GITHUB_OUTPUT !== undefined) {
  console.log(`changed=${changes.length > 0}`);
  console.log(`summary=${changes.join(", ") || "no changes"}`);
} else {
  console.log(JSON.stringify({ changed: changes.length > 0, changes }, null, 2));
}

async function json(url) {
  const response = await fetch(url, { headers: { "user-agent": "claudex-upstream-watch" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
