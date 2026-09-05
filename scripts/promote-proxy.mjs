#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { prepareUpstreamManifest } from "../src/promotion.js";
import { atomicWrite } from "../src/util.js";
import { fileURLToPath } from "node:url";

const [tag = "latest", ...extra] = process.argv.slice(2);
if (extra.length) throw new Error("usage: npm run promote:proxy -- [latest|v<upstream>]");
const path = fileURLToPath(new URL("../channel/stable.json", import.meta.url));
const manifest = JSON.parse(await readFile(path, "utf8"));
const candidate = await prepareUpstreamManifest(manifest, tag);
await atomicWrite(path, `${JSON.stringify(candidate, null, 2)}\n`, 0o644);
console.log(`Prepared official ${candidate.proxy.version}; run checks and the local Codex canary before activation.`);
