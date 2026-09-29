import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePaths } from "../src/paths.js";
import { writeProxyConfig } from "../src/config.js";
import { claudeEnvironment } from "../src/wrapper.js";
import { fixtureManifest, temporaryRoot } from "../test-support/helpers.js";

// Opt-in: exercise Claude's actual Sonnet compaction against a local mock.
// Only the Sonnet selector is pinned; other models retain native Claude behavior.
for (const model of ["sonnet", "claude-fable-5-1[1m]"]) {
  test(`${model} compacts within GPT-6.1 Sol input limits and continues from the summary`, {
    skip: process.env.CLAUDEX_TEST_NATIVE !== "1", timeout: 30_000,
  }, async (t) => {
    const root = await temporaryRoot(t);
    const fixture = join(root, "fixture.txt");
    await writeFile(fixture, "Synthetic context fixture.\n");
    const failures = [];
    let workflowStarted = false;
    let turns = 0;
    let compacted = false;
    let continued = false;
    let contextRejected = false;
    let sequence = 0;
    let finishWorker;
    const workerFinished = new Promise((resolve) => { finishWorker = resolve; });
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const id = `msg_probe_${++sequence}`;
        const reply = (content, inputTokens = 1000) => sendMessage(response, body, id, content, inputTokens);
        const text = (value) => [{ type: "text", text: value }];
        const messages = JSON.stringify(body.messages);
        if (messages.includes("Your task is to create a detailed summary of the conversation")) {
          assert.equal(turns, 2, "compact after 240K, not the preceding 238K request");
          compacted = true;
          reply(text("<summary>COMPACT_PROBE_SONNET. Finish the assigned task.</summary>"));
          return;
        }
        // Ignore Claude's auxiliary title requests.
        if (!body.tools?.length) {
          reply(text('{"title":"Native Sonnet context probe"}'));
          return;
        }
        if (body.model === "claude-fable-5-1") {
          if (!workflowStarted) {
            workflowStarted = true;
            assert.ok(body.tools.some((tool) => tool.name === "Workflow"));
            reply([{ type: "tool_use", id: "toolu_workflow", name: "Workflow", input: {
              script: `export const meta = { name: 'sonnet-context-probe', description: 'Verify Sonnet context', phases: [{ title: 'Probe' }] };
  return await agent('Read the fixture and finish.', { model: 'sonnet', effort: 'low' });`,
            } }]);
            return;
          }
          let timer;
          await Promise.race([workerFinished, new Promise((resolve) => { timer = setTimeout(resolve, 10000); })]);
          clearTimeout(timer);
          assert.ok(compacted && continued, messages.slice(-1500));
          reply(text("WORKFLOW_DONE"));
          return;
        }
        assert.equal(body.model, manifest.models.sol.upstream);
        assert.equal(body.output_config?.effort, "low");
        assert.equal(body.thinking?.type, "adaptive");
        turns += 1;
        if (turns <= 2) {
          reply([{ type: "tool_use", id: `toolu_read_${sequence}`, name: "Read", input: { file_path: fixture } }],
            turns === 1 ? 238000 : 240000);
        } else if (!compacted && !contextRejected) {
          // Simulate the Codex error that would otherwise leave Claude stuck.
          contextRejected = true;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: {
            type: "invalid_request_error", message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
          } }));
        } else {
          assert.ok(compacted);
          assert.ok(messages.includes("COMPACT_PROBE_SONNET"), "continue with the compacted summary");
          continued = true;
          finishWorker();
          reply(text("PROBE_DONE"));
        }
      } catch (error) {
        failures.push(error);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "native probe failed" } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const paths = resolvePaths({ env: { CLAUDEX_HOME: root }, home: root });
    const manifest = fixtureManifest();
    await writeProxyConfig(paths, manifest, { port: server.address().port });
    const env = { ...process.env, ...(await claudeEnvironment(paths, manifest)), CLAUDE_CONFIG_DIR: join(root, "claude") };
    delete env.CLAUDECODE;
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
    // Isolate the native defaults from the developer's own model and context settings.
    for (const name of [
      "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "DISABLE_COMPACT", "DISABLE_AUTO_COMPACT",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    ]) delete env[name];
    Object.assign(env, await claudeEnvironment(paths, manifest));
    const child = spawn(process.env.CLAUDE_CODE_BINARY || "claude", [
      "-p", "Read the fixture and finish.", "--model", model, "--effort", "low",
      "--dangerously-skip-permissions", "--no-session-persistence", "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--output-format", "json",
    ], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill());
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.deepEqual(failures, []);
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.is_error, false, result.result);
    assert.equal(result.result, model === "sonnet" ? "PROBE_DONE" : "WORKFLOW_DONE");
    if (model !== "sonnet") assert.equal(result.modelUsage[model].contextWindow, 1000000);
    assert.ok(compacted && continued);
    assert.equal(contextRejected, false, "compact before a Codex context-limit error");
    assert.equal(result.modelUsage[manifest.models.sol.upstream].contextWindow, 272000);
  });
}

function sendMessage(response, body, id, content, inputTokens) {
  const usage = { input_tokens: inputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content, stop_reason: stopReason, usage }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type, data = {}) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  content.forEach((block, index) => {
    emit("content_block_start", { index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index, delta: block.type === "tool_use"
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } });
    emit("content_block_stop", { index });
  });
  emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
  emit("message_stop");
  response.end();
}
