import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { platformKey } from "./paths.js";

const bundledManifest = fileURLToPath(new URL("../channel/stable.json", import.meta.url));

export async function loadManifest(path = bundledManifest) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("unsupported channel manifest schema");
  for (const field of ["version", "commit", "repository", "tag", "assets"]) {
    if (manifest.proxy?.[field] === undefined) throw new Error(`channel manifest missing proxy.${field}`);
  }
  for (const model of ["sol", "terra", "opus", "fable"]) {
    if (!manifest.models?.[model]?.upstream || !manifest.models?.[model]?.alias) {
      throw new Error(`channel manifest missing models.${model}`);
    }
    if (manifest.models[model].aliases !== undefined) {
      if (!Array.isArray(manifest.models[model].aliases) || manifest.models[model].aliases.some((alias) => typeof alias !== "string" || !alias)) {
        throw new Error(`channel manifest has invalid models.${model}.aliases`);
      }
    }
  }
  const testedClaude = manifest.compatibility?.claudeCode?.tested;
  if (!Array.isArray(testedClaude) || testedClaude.length === 0) {
    throw new Error("channel manifest must contain a tested Claude Code version");
  }
  return manifest;
}

export function assetForPlatform(manifest, target) {
  const key = platformKey(target);
  const asset = manifest.proxy.assets[key];
  if (!asset?.url || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) {
    throw new Error(`stable channel has no verified asset for ${key}`);
  }
  if (asset.compression !== undefined && asset.compression !== "gzip") {
    throw new Error(`stable channel has unsupported compression for ${key}`);
  }
  if (asset.compression === "gzip") {
    if (!/^[a-f0-9]{64}$/.test(asset.archiveSha256 ?? "") || !Number.isSafeInteger(asset.archiveBytes)) {
      throw new Error(`stable channel has invalid archive metadata for ${key}`);
    }
  }
  return { key, ...asset };
}
