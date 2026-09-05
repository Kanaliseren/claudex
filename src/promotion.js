import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExecutable } from "./archive.js";
import { download, sha256File } from "./util.js";
import { platformKey } from "./paths.js";

export const upstreamRepository = "router-for-me/CLIProxyAPI";
const targets = {
  "linux-x64": "linux_amd64.tar.gz",
  "linux-arm64": "linux_aarch64.tar.gz",
  "darwin-x64": "darwin_amd64.tar.gz",
  "darwin-arm64": "darwin_aarch64.tar.gz",
  "win32-x64": "windows_amd64.zip",
};

export function upstreamAssets(release, checksums) {
  const tag = release.tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || release.draft || release.prerelease) {
    throw new Error("expected an official stable upstream release");
  }
  const hashes = new Map(checksums.trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(\S+)$/);
    if (!match) throw new Error("invalid upstream checksum list");
    return [match[2], match[1]];
  }));
  return Object.fromEntries(Object.entries(targets).map(([platform, suffix]) => {
    const name = `CLIProxyAPI_${tag.slice(1)}_${suffix}`;
    const asset = release.assets.find((entry) => entry.name === name);
    const url = `https://github.com/${upstreamRepository}/releases/download/${tag}/${name}`;
    if (!asset || asset.browser_download_url !== url || !hashes.has(name) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`missing verified upstream asset: ${platform}`);
    }
    return [platform, {
      url,
      compression: suffix.endsWith(".zip") ? "zip" : "tar.gz",
      executable: platform.startsWith("win32-") ? "cli-proxy-api.exe" : "cli-proxy-api",
      archiveSha256: hashes.get(name),
      archiveBytes: asset.size,
    }];
  }));
}

export function validateUpstreamModels(manifest, catalog) {
  const native = new Set((catalog.claude ?? []).map((model) => model.id));
  const codex = new Set(Object.entries(catalog).filter(([name]) => name.startsWith("codex-")).flatMap(([, models]) => models.map((model) => model.id)));
  for (const [name, model] of Object.entries(manifest.models)) {
    const available = name === "sol" || name === "terra" ? codex : native;
    if (!available.has(model.upstream)) throw new Error(`upstream catalog is missing configured model: ${name} (${model.upstream})`);
  }
}

// Downloads are verified and inspected as data; foreign-platform executables never run.
export async function prepareUpstreamManifest(manifest, tag = "latest", { currentPlatformOnly = false } = {}) {
  if (tag !== "latest" && !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("invalid upstream release tag");
  const release = await githubJson(`releases/${tag === "latest" ? "latest" : `tags/${tag}`}`);
  const commit = await githubJson(`commits/${release.tag_name}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha ?? "")) throw new Error("invalid upstream release commit");
  const catalogFile = await githubJson(`contents/internal/registry/models/models.json?ref=${commit.sha}`);
  if (catalogFile.encoding !== "base64") throw new Error("unsupported upstream catalog encoding");
  validateUpstreamModels(manifest, JSON.parse(Buffer.from(catalogFile.content, "base64").toString("utf8")));
  const checksumResponse = await fetch(`https://github.com/${upstreamRepository}/releases/download/${release.tag_name}/checksums.txt`);
  if (!checksumResponse.ok) throw new Error(`upstream checksums returned HTTP ${checksumResponse.status}`);
  const assets = upstreamAssets(release, await checksumResponse.text());
  if (currentPlatformOnly) {
    const current = platformKey();
    for (const platform of Object.keys(assets)) if (platform !== current) delete assets[platform];
  }
  const root = await mkdtemp(join(tmpdir(), "claudex-upstream-"));
  try {
    for (const [platform, asset] of Object.entries(assets)) {
      const archive = join(root, `${platform}.${asset.compression}`);
      const executable = join(root, `${platform}.binary`);
      await download(asset.url, archive);
      if ((await stat(archive)).size !== asset.archiveBytes || await sha256File(archive) !== asset.archiveSha256) {
        throw new Error(`upstream archive verification failed: ${platform}`);
      }
      await extractExecutable(archive, executable, asset);
      asset.sha256 = await sha256File(executable);
    }
    return {
      ...manifest,
      proxy: {
        version: release.tag_name,
        upstreamVersion: release.tag_name,
        repository: upstreamRepository,
        commit: commit.sha,
        tag: release.tag_name,
        assets,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com/repos/${upstreamRepository}/${path}`, {
    headers: { "user-agent": "claudex-promotion", ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
  });
  if (!response.ok) throw new Error(`upstream metadata returned HTTP ${response.status}`);
  return response.json();
}
