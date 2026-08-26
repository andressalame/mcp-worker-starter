import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const URL = "https://example.com/";

async function post(body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(headers: Record<string, string> = {}) {
  const request = new Request(URL, { method: "GET", headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("handshake", () => {
  it("echoes the protocolVersion the client offers", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toHaveProperty("tools");
  });

  it("falls back to a default when the client names no version", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2024-11-05");
  });

  it("answers ping", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await res.json()).result).toEqual({});
  });
});

describe("tools", () => {
  it("lists tools with an inputSchema each", async () => {
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const { result } = await res.json();
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("round-trips a tool call", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hola" } },
    });
    const { result } = await res.json();
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: "hola" });
  });

  it("returns an unknown tool as isError, not as a protocol error", async () => {
    // The model can read and recover from this. A JSON-RPC error just aborts the turn.
    const res = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
  });
});

describe("trap 1 — notifications get no body", () => {
  it("answers 202 with an empty body and no id", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("trap 2 — SSE GET must be 405", () => {
  it("answers 405 to Accept: text/event-stream", async () => {
    // A 200 here makes the client read a dead stream and reconnect with no backoff.
    // That is the loop that produced 201,936 requests in a day.
    const res = await get({ accept: "text/event-stream" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("still serves a helpful 200 to a human opening the URL in a browser", async () => {
    const res = await get({ accept: "text/html" });
    expect(res.status).toBe(200);
    expect((await res.json()).how_to_use).toContain("POST");
  });
});

describe("errors", () => {
  it("returns -32700 on invalid JSON", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("returns -32601 on an unsupported method", async () => {
    const res = await post({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect((await res.json()).error.code).toBe(-32601);
  });

  it("rejects anything other than GET or POST", async () => {
    const request = new Request(URL, { method: "DELETE" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });
});
