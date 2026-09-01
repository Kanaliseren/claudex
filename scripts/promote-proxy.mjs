#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { promoteProxy } from "../src/promotion.js";

const [tag, ...options] = process.argv.slice(2);
const claudeIndex = options.indexOf("--claude");
const claudeVersion = claudeIndex >= 0 ? options[claudeIndex + 1] : undefined;
if (!tag || !/^v\d+\.\d+\.\d+-claudex\.\d+$/.test(tag) || !/^\d+\.\d+\.\d+$/.test(claudeVersion ?? "")) {
  throw new Error("usage: npm run promote:proxy -- v<upstream>-claudex.<n> --claude <version>");
}

const repository = "Kanaliseren/CLIProxyAPI";
const releaseBase = `https://github.com/${repository}/releases/download/${tag}`;
const metadata = await json(`${releaseBase}/claudex-assets.json`);

const manifestUrl = new URL("../channel/stable.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const promoted = promoteProxy(manifest, metadata, { tag, claudeVersion, repository });
await writeFile(manifestUrl, `${JSON.stringify(promoted, null, 2)}\n`);
console.log(`Promoted ${tag} with Claude Code ${claudeVersion}.`);

async function json(url) {
  const response = await fetch(url, { headers: { "user-agent": "claudex-promotion" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
