import { chmod, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractExecutable } from "./archive.js";
import { assetForPlatform } from "./manifest.js";
import {
  atomicCopy,
  download,
  ensureDir,
  exists,
  sanitizeReleasePart,
  sha256File,
  run,
} from "./util.js";

export async function inspectBinary(path, manifest, { runCommand = run } = {}) {
  if (!(await exists(path))) throw new Error(`CLIProxyAPI binary not found: ${path}`);
  if (process.platform !== "win32") await chmod(path, 0o755);
  const result = await runCommand(path, ["-h"], { allowFailure: true, timeout: 15_000 });
  const help = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut || !help.trim()) throw new Error(`cannot inspect CLIProxyAPI binary: ${path}`);
  const missing = manifest.compatibility.cliProxyAPI.requiredCapabilities.filter(
    (capability) => !help.includes(capability),
  );
  if (missing.length > 0) {
    throw new Error(`CLIProxyAPI binary is missing required capabilities: ${missing.join(", ")}`);
  }
  return { help, sha256: await sha256File(path) };
}

export async function stageRelease(paths, manifest, { binary, target, runCommand = run } = {}) {
  const version = sanitizeReleasePart(manifest.proxy.version);
  let expectedSha;
  let sourceDescription;
  let asset;
  if (binary) {
    const sourceInspection = await inspectBinary(binary, manifest, { runCommand });
    expectedSha = sourceInspection.sha256;
    sourceDescription = `local:${basename(binary)}`;
  } else {
    asset = assetForPlatform(manifest, target);
    expectedSha = asset.sha256;
    sourceDescription = asset.url;
  }

  const releaseDir = join(paths.releasesDir, `${version}-${expectedSha.slice(0, 12)}`);
  const destination = join(releaseDir, paths.executable);
  await ensureDir(releaseDir);
  if (!(await exists(destination)) || (await sha256File(destination)) !== expectedSha) {
    if (binary) await atomicCopy(binary, destination);
    else await downloadRelease(asset, destination);
  }

  const inspection = await inspectBinary(destination, manifest, { runCommand });
  if (inspection.sha256 !== expectedSha) {
    throw new Error(
      `checksum mismatch for ${manifest.proxy.version}: expected ${expectedSha}, got ${inspection.sha256}`,
    );
  }
  return {
    version: manifest.proxy.version,
    commit: manifest.proxy.commit,
    path: destination,
    sha256: inspection.sha256,
    source: sourceDescription,
    installedAt: new Date().toISOString(),
  };
}

async function downloadRelease(asset, destination) {
  if (!asset.compression) {
    await download(asset.url, destination);
    return;
  }
  const archive = `${destination}.${process.pid}.download.${asset.compression}`;
  const extracted = `${destination}.${process.pid}.extracted`;
  try {
    await download(asset.url, archive);
    const archiveSize = (await stat(archive)).size;
    if (archiveSize !== asset.archiveBytes) {
      throw new Error(`release archive size mismatch: expected ${asset.archiveBytes}, got ${archiveSize}`);
    }
    const archiveSha = await sha256File(archive);
    if (archiveSha !== asset.archiveSha256) {
      throw new Error(`release archive checksum mismatch: expected ${asset.archiveSha256}, got ${archiveSha}`);
    }
    await extractExecutable(archive, extracted, asset);
    if ((await sha256File(extracted)) !== asset.sha256) throw new Error("extracted executable checksum mismatch");
    if (process.platform !== "win32") await chmod(extracted, 0o755);
    await rename(extracted, destination);
  } finally {
    await rm(archive, { force: true }).catch(() => {});
    await rm(extracted, { force: true }).catch(() => {});
  }
}

export async function activateRelease(paths, release) {
  await atomicCopy(release.path, paths.currentBinary);
  const activeSha = await sha256File(paths.currentBinary);
  if (activeSha !== release.sha256) throw new Error("activated CLIProxyAPI checksum does not match staged release");
  return activeSha;
}
