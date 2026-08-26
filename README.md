# mcp-worker-starter

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for Cloudflare Workers.
Zero dependencies, one file, plain POST.

I run an MCP server in production that exposes live business data to Claude over authenticated
tools. This is that server with the business logic taken out and the scar tissue left in.

The happy path of an MCP server is about forty lines. The parts worth publishing are the three
traps below, because each one is silent, and one of them took down two of my products.

---

## The 405 that costs you an outage

MCP clients open a `GET` with `Accept: text/event-stream` to listen for server-pushed messages.
If your server does not speak SSE, the protocol says answer **405**. That status is the signal
for *do not open this again*.

I answered `200` with a friendly JSON body instead, because a 200 felt more helpful than an error.

The client read that 200 as a stream that had died, and reconnected. Immediately. With no
backoff, and with no error surfaced anywhere I was looking.

**201,936 requests in one day.** It burned the daily request quota of the entire Cloudflare
account, which took down a second, completely unrelated product that happened to share it. The
MCP server itself never logged a single error, because from its side nothing was wrong. It was
answering every request correctly, 201,936 times.

A `200` where the protocol expects `405` is not a friendlier answer. It is an infinite loop with
good manners.

```ts
if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
  return new Response(JSON.stringify({ error: "This server does not expose an SSE stream. Use POST." }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
  });
}
```

## Notifications have no id, and must get no body

A JSON-RPC notification is fire-and-forget. It arrives without an `id` and the caller is not
waiting for an answer. Reply with `{"jsonrpc":"2.0","result":{}}` and strict clients treat the
exchange as malformed, because you answered something nobody asked.

`202` with an empty body is the correct "received, nothing to say".

```ts
if (id === undefined || id === null) return new Response(null, { status: 202 });
```

## Echo the client's protocolVersion

On `initialize`, send back the `protocolVersion` the client offered rather than hardcoding your
own. Hardcoding gives you a handshake that works today and quietly stops working the week the
client updates. Fall back to a default only when the client names none.

---

## Use it

```bash
npm install
npx wrangler dev
```

```bash
curl -s http://localhost:8787 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

Deploy:

```bash
npx wrangler deploy
```

Then add the deployed URL as an MCP server in your client. It speaks POST.

## Add your own tools

Edit the `TOOLS` array in [`src/index.ts`](src/index.ts). Two rules that matter more than they look:

- **`description` is the prompt.** The model picks tools by reading it. Write it for a reader who
  cannot see your code and will not read the schema twice.
- **Return data, not prose.** The model is better at describing your JSON than you are at
  guessing what it wants to say about it.

## Auth and rate limiting

Both are off by default so the starter runs with no setup.

**Token auth** turns on when you set `MCP_TOKEN`. Requests must then present
`Authorization: Bearer <token>`.

```bash
npx wrangler secret put MCP_TOKEN
```

**Hourly rate limiting** turns on when you bind a KV namespace as `RATE_LIMIT`. Default cap is
300 requests per hour. In production I cap per tenant rather than globally, keyed on whatever
identifies the caller.

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "your-kv-namespace-id"
```

A rate limit is not paranoia here. Trap one is exactly the shape of failure a cap would have
caught in minutes instead of a day.

## What this is not

Not an SDK, not a framework, and not trying to be. If you want batteries, use the official
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) or Cloudflare's
[Agents SDK](https://developers.cloudflare.com/agents/).

This is for the case where you want to read the whole server in one sitting and know exactly what
it does.

## Tests

```bash
npm test
```

Covers the handshake, the tool round-trip, and each of the three traps, because a regression on
any of them is invisible until it is expensive.

## License

MIT
