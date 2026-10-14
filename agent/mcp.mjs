#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createEchoTools } from "./tools.mjs";

let current = null;
const tools = createEchoTools({ getSession: () => current, setSession: value => { current = value; } });
const byName = new Map(tools.map(tool => [tool.name, tool]));
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function failure(id, error) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error?.message || error) } }); }

async function dispatch(request) {
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") return result(request.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo-local-agent", version: "0.1.0" },
    });
    if (request.method === "ping") return result(request.id, {});
    if (request.method === "tools/list") return result(request.id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
    if (request.method === "tools/call") {
      const tool = byName.get(request.params?.name);
      if (!tool) throw new Error("Unknown Echo tool.");
      try {
        const value = await tool.run(request.params?.arguments || {});
        return result(request.id, { content: [{ type: "text", text: JSON.stringify(value) }] });
      } catch (error) {
        return result(request.id, { isError: true, content: [{ type: "text", text: String(error?.message || error) }] });
      }
    }
    failure(request.id, "Unknown method.");
  } catch (error) { failure(request.id, error); }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try { await dispatch(JSON.parse(line)); }
  catch (error) { process.stderr.write(`Invalid MCP request: ${String(error?.message || error)}\n`); }
}
