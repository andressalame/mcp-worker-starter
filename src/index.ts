/**
 * A minimal Model Context Protocol server for Cloudflare Workers.
 *
 * Zero dependencies. One file. Streamable-HTTP transport over plain POST.
 *
 * The interesting parts are not the happy path, they are the three traps
 * documented inline below. Each one cost me something real in production.
 */

export interface Env {
  /** Optional. When set, every request must present this bearer token. */
  MCP_TOKEN?: string;
  /** Optional KV namespace used for the hourly rate limit. Omit to disable. */
  RATE_LIMIT?: KVNamespace;
}

/** JSON-RPC 2.0 error codes we actually use. */
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** Protocol version we fall back to when the client does not name one. */
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const SERVER_INFO = {
  name: "mcp-worker-starter",
  version: "1.0.0",
  title: "MCP Worker Starter",
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, env: Env) => Promise<unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  handler: ToolHandler;
}

/**
 * Replace these with your own. Two rules that matter more than they look:
 *
 * 1. `description` is the prompt. The model picks tools by reading it, so write
 *    it for a reader who cannot see your code and will not read the schema twice.
 * 2. Return data, not prose. The model is better at describing your JSON than
 *    you are at guessing what it wants to say about it.
 */
const TOOLS: Tool[] = [
  {
    name: "echo",
    description:
      "Return the text you send, unchanged. Useful for checking that the connection and auth work end to end.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo back." },
      },
      required: ["text"],
    },
    handler: async (args) => ({ echo: String(args.text ?? "") }),
  },
  {
    name: "server_time",
    description:
      "Return the server's current time in ISO 8601 UTC. Use it when you need a timestamp the user's machine cannot be trusted to provide.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ now: new Date().toISOString() }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  // TRAP 1 — Notifications have no id and MUST NOT get a JSON-RPC body back.
  // A notification is fire-and-forget. Answering one with {"result": ...} makes
  // strict clients treat the exchange as malformed. 202 with an empty body is
  // the correct "received, nothing to say" reply.
  if (id === undefined || id === null) return new Response(null, { status: 202 });
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/**
 * Hourly cap per token, backed by KV. Returns true when the caller is over.
 * Disabled when no KV namespace is bound, so the starter runs with no setup.
 */
async function overRateLimit(env: Env, key: string, limit: number): Promise<boolean> {
  if (!env.RATE_LIMIT) return false;
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const bucket = `rl:${key}:${hour}`;
  const used = Number((await env.RATE_LIMIT.get(bucket)) ?? 0);
  if (used >= limit) return true;
  // 2h TTL so the bucket outlives the hour it belongs to and then disappears.
  await env.RATE_LIMIT.put(bucket, String(used + 1), { expirationTtl: 7200 });
  return false;
}

function authorize(request: Request, env: Env): boolean {
  if (!env.MCP_TOKEN) return true; // no token configured, open server
  const header = request.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  if (presented.length !== env.MCP_TOKEN.length) return false;
  // Constant-time-ish compare. Length is already leaked above, which is fine,
  // but do not let the byte comparison short-circuit on the first mismatch.
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.MCP_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorize(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET") {
      // TRAP 2 — This is the one that cost me a production outage.
      //
      // MCP clients open a GET with `Accept: text/event-stream` to listen for
      // server-pushed messages. If your server does not speak SSE, the spec
      // says answer 405. That is the signal for "do not open this again".
      //
      // I returned a friendly 200 JSON instead. The client read it as a stream
      // that had died, and reconnected immediately, with no backoff and no
      // error surfaced anywhere. 201,936 requests in one day burned the daily
      // request quota of the whole Cloudflare account and took down two
      // unrelated products that happened to share it.
      //
      // A 200 where the protocol expects 405 is not a friendlier answer. It is
      // an infinite loop with good manners.
      if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(
          JSON.stringify({ error: "This server does not expose an SSE stream. Use POST." }),
          {
            status: 405,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              allow: "POST",
            },
          },
        );
      }
      // A plain GET is a human pasting the URL into a browser. Be useful to them.
      return json({
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        tools: TOOLS.map((t) => t.name),
        how_to_use: "Add this URL as an MCP server in your client. It speaks POST.",
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (await overRateLimit(env, "mcp", 300)) {
      return json({ error: "Too many requests this hour." }, 429);
    }

    const rpc = (await request.json().catch(() => null)) as {
      method?: unknown;
      id?: unknown;
      params?: Record<string, unknown>;
    } | null;

    if (!rpc || typeof rpc !== "object") {
      return rpcError(null, PARSE_ERROR, "Invalid JSON");
    }

    const method = String(rpc.method ?? "");
    const id = rpc.id;

    try {
      if (method === "initialize") {
        return rpcResult(id, {
          // TRAP 3 — Echo the client's protocolVersion when it sends one.
          // Hardcoding your own is how you get a handshake that works today and
          // silently stops working when the client updates.
          protocolVersion:
            (rpc.params?.protocolVersion as string) ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }

      if (method === "ping") return rpcResult(id, {});

      // Notifications are fire-and-forget. See TRAP 1.
      if (method.startsWith("notifications/")) return rpcResult(undefined, {});

      if (method === "tools/list") {
        return rpcResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      }

      if (method === "tools/call") {
        const name = String(rpc.params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);

        // An unknown tool is a tool-level error, not a protocol error. Return it
        // inside the result with isError so the model can read it and recover,
        // instead of a JSON-RPC error that just aborts the turn.
        if (!tool) {
          return rpcResult(id, {
            content: [{ type: "text", text: `No such tool: ${name}` }],
            isError: true,
          });
        }

        const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
        const data = await tool.handler(args, env);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 1) }],
        });
      }

      return rpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`);
    } catch (err) {
      console.error("mcp", err);
      // Never leak the exception text to the caller. Log it, return a shape the
      // client can handle.
      return rpcError(id, INTERNAL_ERROR, "Internal error");
    }
  },
};
