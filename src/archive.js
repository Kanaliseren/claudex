import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// Stream only the selected executable; never unpack archive paths into the installation.
export async function extractExecutable(archive, destination, asset) {
  if (asset.compression === "gzip") {
    await pipeline(createReadStream(archive), createGunzip(), createWriteStream(destination, { flags: "wx", mode: 0o755 }));
    return;
  }
  if (!["tar.gz", "zip"].includes(asset.compression) || !/^cli-proxy-api(?:\.exe)?$/.test(asset.executable ?? "")) {
    throw new Error("unsupported release archive or executable name");
  }
  const useUnzip = asset.compression === "zip" && process.platform !== "win32";
  const child = spawn(useUnzip ? "unzip" : "tar", useUnzip
    ? ["-p", archive, asset.executable]
    : ["-xOf", archive, asset.executable], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`archive extraction failed (exit ${code})`)));
  });
  try {
    await Promise.all([completed, pipeline(child.stdout, createWriteStream(destination, { flags: "wx", mode: 0o755 }))]);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
