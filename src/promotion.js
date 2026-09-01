const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];

export function promoteProxy(manifest, metadata, { tag, claudeVersion, repository }) {
  if (!/^v\d+\.\d+\.\d+-claudex\.\d+$/.test(tag) || !/^\d+\.\d+\.\d+$/.test(claudeVersion)) {
    throw new Error("invalid proxy tag or Claude Code version");
  }
  if (metadata.schemaVersion !== 1 || metadata.version !== tag || !/^[a-f0-9]{40}$/.test(metadata.commit ?? "")) {
    throw new Error("release metadata is invalid or does not match the requested tag");
  }

  const releaseBase = `https://github.com/${repository}/releases/download/${tag}`;
  const assets = Object.fromEntries(platforms.map((platform) => {
    const asset = metadata.assets?.[platform];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.archiveSha256) || !Number.isSafeInteger(asset.archiveBytes)) {
      throw new Error(`release metadata is missing a valid ${platform} asset`);
    }
    return [platform, {
      url: `${releaseBase}/${asset.file}`,
      sha256: asset.sha256,
      compression: "gzip",
      archiveSha256: asset.archiveSha256,
      archiveBytes: asset.archiveBytes,
    }];
  }));

  return {
    ...manifest,
    proxy: {
      version: tag,
      upstreamVersion: tag.replace(/-claudex\.\d+$/, ""),
      commit: metadata.commit,
      repository,
      tag,
      assets,
    },
    compatibility: {
      ...manifest.compatibility,
      claudeCode: {
        ...manifest.compatibility.claudeCode,
        tested: [...new Set([...manifest.compatibility.claudeCode.tested, claudeVersion])],
      },
    },
  };
}
