#!/usr/bin/env node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, assetForPlatform } from "../src/manifest.js";
import { extractExecutable } from "../src/archive.js";
import { download, sha256File } from "../src/util.js";

const manifest = await loadManifest();
const root = await mkdtemp(join(tmpdir(), "claudex-assets-"));
try {
  for (const platform of Object.keys(manifest.proxy.assets)) {
    const [os, arch] = platform.split("-");
    const asset = assetForPlatform(manifest, { platform: os, arch });
    const archive = join(root, `${platform}.${asset.compression}`);
    const executable = join(root, `${platform}.binary`);
    await download(asset.url, archive);
    if ((await stat(archive)).size !== asset.archiveBytes) throw new Error(`${platform} archive size mismatch`);
    if (await sha256File(archive) !== asset.archiveSha256) throw new Error(`${platform} archive checksum mismatch`);
    await extractExecutable(archive, executable, asset);
    if (await sha256File(executable) !== asset.sha256) throw new Error(`${platform} executable checksum mismatch`);
    console.log(`${platform}: archive and executable verified`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
