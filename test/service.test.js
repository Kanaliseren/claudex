import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installService, stopService } from "../src/service.js";
import { resolvePaths } from "../src/paths.js";
import { temporaryRoot } from "../test-support/helpers.js";

test("systemd setup enables and restarts the service", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  paths.systemdUnit = join(root, "systemd", "claudex.service");
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };

  await installService(paths, { platform: "linux", runCommand });

  const unit = await readFile(paths.systemdUnit, "utf8");
  assert.doesNotMatch(unit, /^WorkingDirectory=/m);

  assert.deepEqual(calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "claudex.service"],
    ["systemctl", "--user", "restart", "claudex.service"],
  ]);
});

test("failed initial setup can stop its package-owned service", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLIPROXY_OAUTH_HOME: root }, home: root, platform: "linux" });
  paths.systemdUnit = join(root, "claudex.service");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(paths.systemdUnit, "[Unit]\n");
  const calls = [];

  await stopService(paths, {
    platform: "linux",
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls[0].args, ["--user", "stop", "claudex.service"]);
  assert.equal(calls[0].options.allowFailure, true);
});

test("proxy upgrades restart an existing dependent quota hub without rewriting it", async (t) => {
  const root = await temporaryRoot(t);
  const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root, platform: "linux" });
  const { atomicWrite } = await import("../src/util.js");
  const { restartService } = await import("../src/service.js");
  await atomicWrite(paths.systemdUnit, "proxy");
  await atomicWrite(paths.hubSystemdUnit, "existing hub");
  const calls = [];
  await restartService(paths, { platform: "linux", runCommand: async (command, args) => { calls.push([command, ...args]); return { code: 0 }; } });
  assert.deepEqual(calls, [["systemctl", "--user", "restart", "claudex.service", "claudex-hub.service"]]);
  assert.equal(await readFile(paths.hubSystemdUnit, "utf8"), "existing hub");
});
