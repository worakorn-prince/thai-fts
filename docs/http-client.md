# thai-fts HTTP client adapter (`thaifts-server`)

The `thaifts-server` engine is a thin, fetch-based client for the REST API
server shipped in `thai-fts/server`. The server hosts any registered engines
(memory today, FTS5 via the same process) behind a small HTTP surface; the
client lets any Node ≥ 18 process talk to it with the usual async engine
contract — no SDK, no extra dependencies, no auth flows beyond a static API
key.

## Setup

Boot a server hosting a memory engine:

```js
import { createServer } from "thai-fts/server";

const srv = await createServer({
  port: 8787,
  host: "127.0.0.1",
  engines: [{ name: "mem", factory: "createMemoryEngine" }],
});
```

Connect a client from any process:

```js
import { createThaiFtsServerEngine } from "thai-fts";

const engine = createThaiFtsServerEngine({
  endpoint: "http://127.0.0.1:8787",
});

await engine.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
const hits = await engine.search("ติดตั้ง");
engine.close();
```

Or through the registry:

```js
import { createAsyncEngine } from "thai-fts";

const engine = createAsyncEngine("thaifts-server", {
  endpoint: "http://127.0.0.1:8787",
});
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | — (required) | Server root URL, e.g. `http://localhost:8787`. Trailing slashes are trimmed. A missing/empty endpoint throws `TypeError`. |
| `engine` | `string` | server default | Hosted engine name. When set, every request targets `/engines/<engine>/...`; when omitted, the shorthand paths resolve to the server's default engine. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer <key>` on every request. |
| `tone` | `"strict" \| "loose" \| "both"` | server default | Per-search default; a per-call option overrides it. |
| `limit` | `number` | server default | Per-search default hit limit; a per-call option overrides it. |

The remaining search options (`prefix`, `offsets`, `allTerms`, `titleWeight`)
are forwarded per call. `prefix` and `titleWeight` work when the hosted
engine supports them; `offsets` is **not supported over HTTP** (see below).

## REST mapping

The client methods map to the server endpoints like this (with `engine`
option set, prefix every path with `/engines/<engine>`):

| Client method | HTTP request |
|---|---|
| `add(doc)` | `POST /add` — body: the document. Server answers `201 { ok, id }`. |
| `addMany(docs)` | `POST /addMany` — body: the array. An **empty array is sent too** (the server answers `201 { ok, added: 0 }`). |
| `remove(id)` | `DELETE /remove/:id`. Absent ids are a 200 no-op. |
| `update(doc)` | `PUT /update` — server-side upsert (`201`-style `200 { ok, id }`). |
| `search(query, opts)` | `POST /searchWithMeta` — the flat options object (real booleans) with `q`; the `truncated` flag is dropped from the result. |
| `searchWithMeta(query, opts)` | `POST /searchWithMeta` — same request, plus `{ hits, truncated }`. |
| `close()` | Synchronous, local only — no HTTP request. Every later use throws `"Search engine is closed"`. |

Hits coming back carry `id`, `rank`, `snippet` and `meta` (with `method`,
`channel`, and optionally `truncated`). Document ids round-trip through a
local id tracker, so numeric ids stay numeric in results even though the
server hands them back as strings.

## Limitations over HTTP (documented, not faked)

- **Verified raw offsets are unsupported.** The server strips
  `quote`/`start`/`end`/`occurrences` from every hit, so `offsets: true`
  cannot be honored. Use a local engine (fts5/memory) when you need verified
  raw-text offsets.
- **`truncated` defaults to `false`** when the response omits the flag.
- Engine state is server-side: `close()` only seals the client; it does not
  stop the hosted engine.

## Error semantics

Any non-2xx response rejects with an `Error` whose message follows the
shared HTTP adapter format:

```
HTTP <status> from <method> <url>: <body excerpt (first 200 chars)>
```

Notable server statuses: `404` for an unknown engine name (e.g.
`engine: "nope"`), `400` for missing `q` or a malformed body on the POST
search paths, bad search params on the **GET** path (`q` required, `limit` a
positive integer), `405` for a wrong method, `413` when the body exceeds
1 MiB, and `500` when the hosted engine itself is closed.

Caveat: on the POST search paths (`POST /search` / `POST /searchWithMeta`),
a malformed `limit` (not a positive integer) currently falls through the
server's client-error mapping and surfaces as `500` rather than `400`. The
client adapter treats any non-2xx the same way (rejects), so behavior is
correct from the caller's side; a server-side fix would change the status
only.
