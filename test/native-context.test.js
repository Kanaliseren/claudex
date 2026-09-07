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

// Opt-in: runs the installed Claude binary against a local mock, never a provider.
// Exercise the real Workflow, effort selection, and compaction implementation.
test("native Workflow workers retain effort and compact within the 272K budget", {
  skip: process.env.CLAUDEX_TEST_NATIVE !== "1", timeout: 30_000,
}, async (t) => {
  const root = await temporaryRoot(t);
  const fixture = join(root, "fixture.txt");
  await writeFile(fixture, "Synthetic context fixture.\n");
  const workers = new Map([
    ["gpt-6-astra", { effort: "high", turns: 0, compacted: false, continued: false }],
    ["gpt-5.6-sol", { effort: "low", turns: 0, compacted: false, continued: false }],
  ]);
  const failures = [];
  let started = false;
  let sequence = 0;
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
      const worker = workers.get(body.model);
      if (worker && messages.includes("Your task is to create a detailed summary of the conversation")) {
        assert.equal(worker.turns, 2, "compact after 221K, not the preceding 219K request");
        worker.compacted = true;
        reply(text(`<summary>COMPACT_PROBE_${body.model}. Finish the assigned task.</summary>`));
        return;
      }
      // Native session-title and other auxiliary requests have no tools.
      if (!body.tools?.length) {
        reply(text('{"title":"Native context probe"}'));
        return;
      }
      if (worker) {
        assert.equal(body.output_config?.effort, worker.effort);
        assert.equal(body.thinking?.type, "adaptive");
        worker.turns += 1;
        if (worker.turns <= 2) {
          reply([{ type: "tool_use", id: `toolu_read_${sequence}`, name: "Read", input: { file_path: fixture } }],
            worker.turns === 1 ? 219000 : 221000);
        } else {
          assert.ok(worker.compacted);
          assert.ok(messages.includes(`COMPACT_PROBE_${body.model}`), "continue with the compacted summary");
          worker.continued = true;
          reply(text("PROBE_DONE"));
        }
        return;
      }
      if (!started) {
        assert.ok(body.tools.some((tool) => tool.name === "Workflow"));
        started = true;
        reply([{ type: "tool_use", id: "toolu_workflow", name: "Workflow", input: {
          script: `export const meta = { name: 'native-context-probe', description: 'Verify native context and effort', phases: [{ title: 'Probe' }] };
return await parallel([
  () => agent('Read the fixture and finish.', { label: 'astra-high', model: 'sonnet', effort: 'high' }),
  () => agent('Read the fixture and finish.', { label: 'sol-low', model: 'haiku', effort: 'low' })
]);`,
        } }]);
        return;
      }
      const task = messages.match(/Task ID:\s*(\w+)/)?.[1];
      const waited = body.messages.some((message) => Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_use" && block.name === "TaskOutput"));
      if (task && !waited) {
        reply([{ type: "tool_use", id: "toolu_wait", name: "TaskOutput", input: { task_id: task, block: true, timeout: 10000 } }]);
      } else {
        assert.ok([...workers.values()].every((worker) => worker.continued));
        reply(text("WORKFLOW_DONE"));
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
  // Avoid user credentials or inherited context overrides affecting the fixture.
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  for (const name of ["DISABLE_COMPACT", "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"]) delete env[name];
  const child = spawn(process.env.CLAUDE_CODE_BINARY || "claude", [
    "-p", "Run the native workflow probe.", "--model", "claude-fable-5-1[1m]", "--effort", "high",
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
  assert.equal(result.result, "WORKFLOW_DONE");
  for (const [model, worker] of workers) {
    assert.ok(worker.compacted && worker.continued, model);
    assert.equal(result.modelUsage[model].contextWindow, 272000);
  }
  assert.equal(result.modelUsage["claude-fable-5-1[1m]"].contextWindow, 1000000);
});

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
