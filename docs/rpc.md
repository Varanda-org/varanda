# varanda — UI <-> node RPC contract, version 1 (normative)

This document is the single normative reference for `@varanda/rpc` (`packages/rpc`): the JSON contract between the user interface (React Native app, web) and a Varanda node, which is the in-app Bare worklet (over IPC), `varanda-serve` (over a loopback WebSocket) or the browser node of `@varanda/web-member` (in memory, in the same page). Names, values, shapes, messages and constants are exact. Record formats, reason strings, the feed and the sync rules are those of `docs/protocol.md` (cited below as "protocol §n"); this document only says how they travel.

Conventions: CommonJS ES2020 with `'use strict'`, standard style, zero dependencies, no Node built-ins and no `Buffer` (the package loads unchanged in a Metro / react-native-web bundle, in Node >= 20 and in Bare; it uses only `Uint8Array`, `DataView`, `ArrayBuffer.isView` and `setTimeout`; UTF-8 is encoded and decoded in pure JS, section 3, because `TextEncoder` / `TextDecoder` support in Hermes and Bare is unverified). Code and identifiers in English; every message a user can see is pt-BR. Tests use brittle (`npm test -w packages/rpc`).

Terms: `key` = `hex64` = exactly 64 lowercase hex characters; `ref` = `'<hex64>:<seq>'` with canonical decimal `seq` (no leading zero, a safe integer); "chars" = Unicode code points (`Array.from(s).length`, exactly as `packages/core/lib/records.js` measures them); "bytes" = bytes of the UTF-8 encoding.

## 1. Envelopes

Every message is ONE JSON object of one of three kinds. The protocol version is `v: 1`.

```json
{ "v": 1, "id": 7, "method": "post.create", "params": { "text": "olá" } }
{ "v": 1, "id": 7, "ok": true, "result": { "seq": 3, "ref": "<hex64>:3" } }
{ "v": 1, "id": 7, "ok": false, "error": { "code": "USAGE", "message": "registro inválido: text-length" } }
{ "v": 1, "event": "sync.event", "seq": 1, "data": { "runId": 1, "line": "sync ready" } }
```

- Request: exactly the keys `v`, `id`, `method`, `params`. `params` is always present and is a plain object (`{}` when the method takes none).
- Response: exactly `v`, `id`, `ok`, `result` when `ok` is `true`; exactly `v`, `id`, `ok`, `error` when `ok` is `false`. `result` is always a plain object. `error` has exactly `code` (a wire code, section 7) and `message` (a string of at most `MAX_ERROR_MESSAGE` = 200 UTF-16 units).
- Event: exactly `v`, `event`, `seq`, `data`; `data` is a plain object whose keys are fixed per event (section 6).
- `id` is a safe integer in `1..2147483647` (`MAX_ID`) chosen by the client and unique among ITS pending requests; an id may be reused once its response arrived. `seq` starts at 1 on every connection and increases by exactly 1 per event sent.
- Rejected (code `USAGE`): any key other than the listed ones at any level of an envelope (`error`, `data`, and `params` through the per-method key sets of section 5), a missing key, `v !== 1`, a bad `id`, an unknown method (prototype names such as `toString` are unknown), a non-object or array `params`, an array or `null` where an object is required, a non-plain object, and a request whose `id` is already pending on that connection (`'id repetido'`).
- `validateRequest(obj)`, `validateResponse(obj)`, `validateEvent(obj)` return `{ ok: true, value }` (a fresh envelope; for a request, `value.params` is the normalized params of section 5 with defaults filled in) or `{ ok: false, code: 'USAGE', message }`, and never throw, whatever the input (hostile getters and proxies included). Messages name a field, never echo a value.

## 2. Limits (`lib/limits.js`, all exported)

| Constant | Value | Meaning |
| --- | --- | --- |
| `PROTOCOL` | 1 | envelope `v` and `session.open` result |
| `MAX_ID` | 2147483647 | largest request id |
| `MAX_REQUEST` | 65536 | bytes of one serialized request |
| `MAX_MESSAGE` | 262144 | bytes of one serialized response or event |
| `MAX_PENDING` | 8 | requests in flight per connection |
| `MAX_OUTBOUND` | 1048576 | bytes a server may have queued to one client before it drops the connection (enforced by the transports) |
| `MAX_LIST` | 100 | entries of a capped result list |
| `MAX_LINE` | 512 | chars of an event `line` and of a SyncResult error string |
| `MAX_TOKEN_TEXT` | 64 | chars of a key or reason inside a capped SyncResult |
| `MAX_TOKEN` | 256 | chars of a `session.open` token |
| `MAX_CERT_BYTES` | 4096 | bytes of `JSON.stringify(cert)` in `cert.add` |
| `MAX_SYNC_RESULT` | 258048 | bytes of a capped SyncResult (`MAX_MESSAGE - 4096`) |
| `DEFAULT_TIMEOUT_MS` | 30000 | client request timeout |
| `MAX_NAME`, `MAX_BIO`, `MAX_TEXT` | 80, 280, 1000 | chars, same values as `records.js` |
| `LOG_LIMIT_DEFAULT`, `LOG_LIMIT_MAX` | 20, 42 | `log.read` page |
| `FEED_LIMIT_DEFAULT`, `FEED_LIMIT_MAX` | 30, 35 | `feed.read` page |
| `FOLLOW_LIMIT_DEFAULT`, `FOLLOW_LIMIT_MAX` | 100, 500 | `follow.list` page |
| `SYNC_TIMEOUT_MIN`, `SYNC_TIMEOUT_MAX`, `SYNC_TIMEOUT_DEFAULT` | 1000, 600000, 30000 | `sync.start` `timeoutMs` (ms) |

- Capped lists: a result list marked "capped" below holds at most `MAX_LIST` entries and travels with an integer `<name>Truncated` = the number of entries cut (`0` when none). `capList(list, max = MAX_LIST)` -> `{ list, truncated }` is the pure helper (first `max` entries, always a copy; a non-array is `[]`).
- Oversized response: a response whose serialization exceeds `MAX_MESSAGE` is replaced by `{ ok: false, error: { code: 'USAGE', message: 'resposta grande demais' } }` with the same id (the dispatcher does this, section 8). An oversized event is replaced by the event `warning` `{ line: 'evento grande demais' }` with the same `seq`.
- Worst-case response sizes (checked by `test/sizes.test.js`). The most expensive character on the wire is a lone surrogate: `records.js` counts it as one char and accepts it in names and texts (a peer can write it), and `JSON.stringify` writes it as `\udXXX`, 6 bytes. A 4-byte UTF-8 character costs 4 bytes, `"` and `\` 2 bytes, LF (`\n`) 2 bytes; every other character JSON escapes (C0 controls) or `jsonLine` escapes (DEL, C1, U+2028/9, bidi controls) is forbidden in names and texts. Every other field takes its maximum: hex64 keys, `seq` = 9007199254740991, `at` = `'+275760-09-13T00:00:00.000Z'` (the longest canonical ISO), `id` = `MAX_ID`, and `skipped` / `future` full (100 entries each, reason `untrusted-association`).
  - `feed.read`: one item (80-char name, 1000-char text, a reply) is at most 6,746 bytes; the envelope with full `skipped` and `future` lists is 19,349 bytes. 35 items = 255,493 bytes (fits, 6,651 bytes to spare); 36 items = 262,240 bytes (does not fit), so `FEED_LIMIT_MAX` = 35. With 4-byte characters instead of lone surrogates an item is at most 4,586 bytes and 50 items would be 248,649 bytes, but the lone-surrogate case decides. FeedItems carry no bio.
  - `log.read`: one entry (a post record of 1000 chars with a reply) is at most 6,206 bytes on the wire; a profile record (80-char name, 280-char bio) is at most about 2.3 KB and a certificate record has fixed-size fields, so posts are the worst case. 42 entries = 260,830 bytes (fits, 1,314 bytes to spare); 43 do not, so `LOG_LIMIT_MAX` = 42. An `invalid` entry (`{ seq, reason }`) is smaller than any entry it replaces in the window.
  - `follow.list`: 500 keys = 33,581 bytes (about 13% of `MAX_MESSAGE`).
- No method takes a filesystem path, a data dir, an association key, a bootstrap list, a DHT host, a secret key or a limit override. Those are node configuration, fixed when the node starts; a request carrying any of them fails on the unknown key.

## 3. Framing

### IPC (byte stream: the in-app worklet)

Each message is a 4-byte unsigned big-endian length followed by exactly that many bytes of UTF-8 JSON (the envelope). There is no other framing and no token (section 11).

UTF-8 codec (`lib/text.js`, pure JS):

- `utf8Encode(str)` -> `Uint8Array`. A lone surrogate in the JS string is written as U+FFFD (`EF BF BD`), exactly like `TextEncoder`; a surrogate pair is one 4-byte character. (Envelopes never reach it with a lone surrogate: `JSON.stringify` escapes them as `\udXXX`.)
- `utf8Decode(bytes)` -> string, strict: overlong forms (`C0`, `C1`, `E0 80..9F`, `F0 80..8F`), surrogates U+D800-U+DFFF (`ED A0..BF`), code points above U+10FFFF (`F4 90..`, `F5..FF`), truncated sequences and stray continuation bytes throw `TypeError('UTF-8 inválido')`. A BOM is kept as U+FEFF (and then fails `JSON.parse`). Its accept/reject decisions and output are identical to `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` (checked by `test/utf8.test.js` on an edge-case table and a seeded fuzz of 5,000 byte strings).

- `encodeFrame(obj, max = MAX_MESSAGE)` -> `Uint8Array`. Throws `RpcError` `USAGE` when `obj` is not a plain object (`'mensagem não é um objeto'`) or its body exceeds `max` bytes (`'mensagem grande demais'`).
- `createFrameDecoder({ max = MAX_MESSAGE, onMessage, onError })` -> `{ push(chunk), failed }`. `push` accepts any `ArrayBufferView` and handles any chunking: a header split across chunks, several frames in one chunk, one byte at a time. The length is checked against `max` BEFORE the body buffer is allocated, so the decoder never allocates more than `max` bytes for a body (plus its fixed 4-byte header buffer).
- Protocol errors: length 0, length > `max`, invalid UTF-8 (`utf8Decode` above), invalid JSON, a top level that is not a plain object, or a chunk that is not an `ArrayBufferView`. On the first one `onError({ code: 'USAGE', message })` is called ONCE, the decoder enters its failed state (`failed === true`) and every later `push` is ignored. The transport MUST then close the stream. Frames fully decoded before the error were already delivered.
- The node decodes with `max = MAX_REQUEST`; the UI decodes with `max = MAX_MESSAGE`.

### WebSocket (`varanda-serve`)

One text frame per message, no length prefix. A binary frame is a protocol error (the transport closes the connection).

- `parseMessage(text, max = MAX_MESSAGE)` -> `{ ok: true, value }` or `{ ok: false, code: 'USAGE', message }`: a non-string is rejected; then the UTF-8 byte length of `text` is checked against `max` (computed without allocating, a lone surrogate counting 3 bytes); then `JSON.parse`; then the top level must be a plain object. Never throws. The server parses with `max = MAX_REQUEST`.

### In memory (the browser node)

The browser node (`packages/web-member/lib/node.js`, loaded by the web app as `varanda-node.js`) and the page's client exchange exactly what the WebSocket carries: one JSON text per envelope, in both directions, delivered asynchronously (the app uses a microtask). The node parses each request with `parseMessage(text, MAX_REQUEST)` and the client each response or event with `parseMessage(text, MAX_MESSAGE)`; a request that does not parse closes the connection, as on the WebSocket. No object is shared between the two sides. One connection at a time: a second `connect` closes the first.

## 4. Session

- `session.open` MUST be the first request on a connection. Any other method before a successful `session.open` -> `UNAUTHORIZED` `'sessão não aberta'`. A second `session.open` -> `USAGE` `'sessão já aberta'`.
- Token rule: a dispatcher created with `token` = a string (WebSocket) requires `params.token` and compares it with `tokensEqual`; one created with `token: null` (IPC) requires the open to carry NO token, and any token given is rejected. A failed open answers `UNAUTHORIZED` `'token inválido'`, then the dispatcher closes itself and calls `onProtocolError`; the transport closes the connection (one guess per connection).
- Events are sent only after a successful `session.open`.

## 5. Methods

Mutating methods (`MUTATING`, exported as a frozen array; test with `isMutating(method)`): `identity.create`, `cert.add`, `profile.set`, `post.create`, `post.reply`, `follow.add`, `follow.remove`, `sync.start`, `sync.stop`, `node.close`. All others are reads.

Params have an exact key set: every key not listed for the method -> `USAGE` `'parâmetro desconhecido'`; a missing required key -> `'parâmetro obrigatório: <name>'`; a wrong type or bound -> `'parâmetro inválido: <name>'`. Defaults listed below are filled in by `validateRequest` / `validateParams(method, params)` before the handler runs; the client sends the params exactly as given.

Results keep the field names of the CLI `--json` output (protocol §7, `apps/cli/lib/commands/member.js`). Results are produced by the node (T6); the dispatcher checks only that a result is a plain object and fits `MAX_MESSAGE`.

### 5.1 `session.open`

- Params: `{ token?: string, 1..256 chars }`.
- Result: `{ protocol: 1 }`. Handled by the dispatcher itself; it never reaches a handler.

### 5.2 `node.info`

- Params: `{}`.
- Result: `{ publicKey: hex64 | null, memberCert: boolean, followCount: integer, sync: SyncState, publicDht: boolean }`.
  - `publicKey`: the own diary key, `null` when no identity was created yet.
  - `memberCert`: block 0 of the own diary holds a member certificate that passes `certForKey` against the trust root.
  - `followCount`: `follows.json` length.
  - `sync`: as `sync.status` (5.16).
  - `publicDht`: `true` when the node was started against the public DHT (no bootstrap override). Always `false` for the browser node, which uses no DHT (its only peer is the configured seeder).
- It carries no path, no secret, no association key, no bootstrap list and no DHT host.

### 5.3 `identity.create`

- Params: `{}` (the association is node configuration).
- Result: `{ publicKey: hex64, association: hex64 }`, as `id create --json`. Idempotent: same key on every call. Never a secret key.

### 5.4 `identity.show`

- Params: `{}`.
- Result: `{ publicKey: hex64, association: hex64 }`, as `id show --json`. No identity -> `NOT_FOUND` `'identidade não encontrada'`.

### 5.5 `cert.add`

- Params: `{ cert: object }`: a plain object with `JSON.stringify(cert)` at most `MAX_CERT_BYTES` (4096) bytes. Only shape and size are checked here; the node verifies it (`certForKey` against the trust root, `cert.member` = own key).
- Result: `{ seq: 0 }`, as `cert add --json` (an identical block 0 already present is ok without append). Expected errors: `USAGE` `'certificado inválido (<reason>)'`, `USAGE` `'certificado já gravado'`.

### 5.6 `profile.set`

- Params: `{ name: string 1..80 chars, bio?: string 0..280 chars }`; `bio` defaults to `''`.
- Result: `{ seq, ref }`. (`profile set --json` prints only `{ seq }`; `ref` = `'<own hex64>:<seq>'` is added so the three publishing methods share one shape.)
- Control characters are checked by the node's record builder (`USAGE` `'registro inválido: control-chars'`), not here.

### 5.7 `post.create`

- Params: `{ text: string 1..1000 chars }`.
- Result: `{ seq, ref }`, as `post --json`.

### 5.8 `post.reply`

- Params: `{ to: ref with seq >= 1, text: string 1..1000 chars }` (lowercase hex, canonical seq; block 0 is never a post).
- Result: `{ seq, ref }`, as `reply --json`.
- 5.6 to 5.8 require block 0: `USAGE` `'grave o certificado de membro antes de publicar'`; an invalid record: `USAGE` `'registro inválido: <reason>'`.

### 5.9 `follow.add` / 5.10 `follow.remove`

- Params: `{ key: hex64 }`.
- Result: `{ changed: boolean, followCount: integer }`: `changed` as in `follow` / `unfollow --json`, `followCount` = the length of `follows.json` after the call. The CLI's `follows` list is deliberately NOT returned, so a change that was written can never be turned into an oversized-response error; the UI re-reads `follow.list`. Expected errors: `USAGE` `'não é possível seguir a própria chave'`, `USAGE` `'limite de diários seguidos atingido'`.

### 5.11 `follow.list`

- Params: `{ offset?: integer >= 0 (safe), limit?: integer 1..500 }`; `offset` defaults to 0, `limit` to 100.
- Result: `{ follows: [hex64], total: integer }`: `follows` = `readFollows(dataDir).slice(offset, offset + limit)` (the stored order, sorted per protocol §1); `total` = the whole list length. An `offset` at or past `total` gives `follows: []`.

### 5.12 `log.read`

- Params: `{ author?: hex64, limit?: integer 1..42 }`; `author` absent = the own diary; `limit` defaults to 20.
- Result: `{ key: hex64, entries: [{ seq, record }], invalid: [{ seq, reason }], entriesTruncated: integer }`.
  - The node takes the newest `limit` blocks of the log (`seq` from `length - limit` to `length - 1`), ascending by `seq`. Each block that passes `validRecordCopy(record, seq)` goes to `entries` with that copy; each other block goes to `invalid` with its `seq` and a reason code only (`validateRecord`'s reason, `'malformed'` for a block `decodeBlock` refused). A block that fails validation is NEVER returned as text (A8).
  - `entriesTruncated` = the number of older blocks not in the window (`max(0, length - limit)`). v1 has no offset: only the newest page is readable.
  - Same rules as `log --json`: local data only; an author with no local data -> `NOT_FOUND` `'sem dados locais para este diário'` and no core is created.
- Size: `LOG_LIMIT_MAX` entries always fit `MAX_MESSAGE` (section 2).

### 5.13 `feed.read`

- Params: `{ limit?: integer 1..35 }`, default 30. `FEED_LIMIT_MAX` = 35 pages always fit `MAX_MESSAGE` (section 2).
- Result: `{ items: [FeedItem], skipped: [{ key, reason }], skippedTruncated, future: [ref], futureTruncated }`, as `feed --json` plus the two counts.
  - `items`: `buildFeed`'s FeedItem objects unchanged (protocol §7 "FeedItem": `{ author, name, seq, at, text, replyTo }`, ascending by `(at, author, seq)`, the LAST `limit` kept).
  - `skipped` (capped): followed logs not shown, with the reasons of protocol §7 `feed` (`no-cert`, `not-in-log`, `member-mismatch`, `untrusted-association`, `bad-signature`, `malformed`, `fork`).
  - `future` (capped): references of future-dated posts (protocol §2 R5.10). Uncapped it grows without bound (Verified V9: `limit: 1` with 4,000 future posts gave 287 KB).
  - The CLI's stderr warnings (bad `follows.json` entries, skipped logs, future posts) are not events here; the lists carry the same information.

### 5.14 `sync.start`

- Params: `{ once?: boolean, timeoutMs?: integer 1000..600000 }`; `once` defaults to `false`; `timeoutMs` is allowed only with `once: true` (else `USAGE` `'timeoutMs só com once'`) and then defaults to 30000.
- Result: `{ runId: integer }`, returned as soon as the run has started (it does not wait for the run). `runId` is a safe integer in `1..MAX_ID`, new for every run of the node. A `sync.started` event (section 6) is emitted for the run before this response.
- No identity yet -> `NOT_FOUND` `'identidade não encontrada'` (no run is started, no event).
- A second `sync.start` while a run is active -> `USAGE` `'sincronização já em andamento'`. The bootstrap, DHT host and association are node configuration.

### 5.15 `sync.stop`

- Params: `{}`.
- Result: `{ stopped: boolean }`: `true` when a run was active and was asked to stop (its `sync.stopped` event, reason `'stopped'`, is sent before this response: the node awaits the run), `false` when no run was active. A stopped continuous run is not restarted.

### 5.16 `sync.status`

- Params: `{}`.
- Result (SyncState): `{ state: 'idle' }` or `{ state: 'running', runId, once }`.

### 5.17 `node.close` (IPC only)

- Params: `{}`.
- Result: `{ closed: true }`.
- Offered only by the in-app worklet (`apps/app/worklet/main.js`), next to the session's handlers; the node session itself (`session.handlers`), `varanda-serve` and the browser node do not register it, so over the WebSocket it reaches no handler and the dispatcher answers `INTERNAL` `'erro interno'` (section 8, step 6).
- The worklet detaches and closes the node session (any running sync is stopped and awaited, every store is closed and the data-dir lock released), then sends this response, then ends its side of the IPC stream and ignores every later frame. The host terminates the worklet after the response; only a received response means a clean stop, after which the next worklet needs no lock takeover (`recover`). Needed because the bare-kit IPC has no end-of-stream signal from the React Native side.

### Errors common to every method

- The data dir held by another process, or the node session in its error state -> `LOCKED` (message `'diretório de dados em uso'` for the lock). A request reaching a closed node session -> `LOCKED` `'sessão encerrada'`.
- A method that needs an identity before one exists -> `NOT_FOUND` `'identidade não encontrada'`.
- Anything else unexpected -> `INTERNAL` `'erro interno'`.

## 6. Events

| Event | `data` (exact keys) |
| --- | --- |
| `sync.started` | `{ runId, once: boolean }` |
| `sync.event` | `{ runId, line: string <= MAX_LINE chars }` |
| `sync.stopped` | `{ runId, reason: 'done' \| 'stopped' \| 'preempted' \| 'timeout' \| 'error', result?: SyncResult }` |
| `warning` | `{ line: string <= MAX_LINE chars }` |

- `sync.started`: emitted every time a run starts, whether from `sync.start` or from the node restarting a continuous run after a preemption (section 6.1); `once` is the run's mode. With `sync.stopped` it lets the UI track the sync state from events alone: a run is active between its `sync.started` and its `sync.stopped`.

- `sync.event` `line` = the human stdout line the CLI prints for that `runSync` event (protocol §7 `sync`: `sync ready`, `peer member <peerKey8>`, `peer seeder <peerKey8>` / `... não verificado`, `admitted <key> <length>`, `rejected <key> <reason>`, `withdrawn <key> <peerKey8> <reason>`, `have <key> <length>`, `downloaded <key> <length>`), built with `safe()` exactly as `apps/cli/lib/commands/sync.js` `formatEvent` does. An event with no stdout line is not sent.
- `warning` `line` = a line the CLI prints on stderr, escaped with `safe()`: the `runSync` `log` lines (`aviso: ...`; a line that contains `/`, `\` or a run of 16+ hex digits, i.e. a raw error message that may carry a path or key material, keeps its prefix up to the first `': '` after `aviso: ` and ends with `': erro interno'`, and the full line goes only to the host's `onInternalError`), `aviso: diário <key8> ignorado (<reason>)` for a `skipped` event, and, before a `sync.stopped` with reason `'error'`, `'erro: ' + message` (a message that passes the section 7 safety rule, else `'erro: erro interno'`).
- `sync.stopped`: emitted once per run when it ends. Reasons: `'stopped'` = ended by `sync.stop`, by the connection closing or by the node session closing; `'preempted'` = the node paused the run to serve a request (or because the app went to the background, section 6.1); `'timeout'` = a `once` run ended at its deadline (`result.ok === false` with `errors[0]` = `'sem pares'` or starting with `'tempo esgotado'`); `'done'` = any other resolved run; `'error'` = `runSync` threw (no `result`). `result` is present only for a resolved `once` run (whatever the reason, `'stopped'` and `'preempted'` included), and is the SyncResult passed through `capSyncResult` (below).
- Lines and reasons are human text the node already escaped with `safe()` (A8). The UI still renders every line as text only (never markup) and through `displayText` (section 10).
- A run's events may reach the client before the `sync.start` response; the UI keys them by `runId`.

### 6.1 Preemption (the node session, `packages/core/lib/session.js`)

Every member operation opens the store and takes the data-dir lock, and a running sync holds that lock (protocol §9). The node therefore serves requests strictly one at a time, and before any request that opens the store (every member method, and `node.info` / `sync.start` while the own identity is not yet known to the session) it aborts the running sync and awaits it (`sync.stopped` with reason `'preempted'`). After the request, a continuous run (`once: false`) that the user did not stop is restarted with a new `runId` (`sync.started`, sent before that response); when several requests are queued the run is preempted once and restarted after the last of them. A `node.info` that preempted the run reports the restarted run in its `sync` field. A preempted `once` run is over: it is not restarted. `sync.status`, `sync.stop` and a `node.info` served from the session's cache never preempt. While the app is in the background (the host suspends the session) the run is paused the same way and restarted on resume; requests sent meanwhile wait.

The browser node's session (`packages/web-member/lib/session.js`) follows the same rules (one request at a time, the same preemption and restart, the same events), because two Hypercore instances on the same browser storage would corrupt it; it has no suspend and resume. Its run (`packages/web-member/lib/sync.js`) has one peer, the seeder at the configured address, re-dialled with a backoff (1 s doubling to 30 s) while the run lasts. Its `sync.event` lines are the ones above except `withdrawn`, and its `peer` line always names the endpoint at the configured address (anything but a verified seeder is then dropped); its own `warning` lines are `aviso: sem conexão com o semeador; nova tentativa em <n> s` and `aviso: o endereço configurado não respondeu como um semeador verificado (<key8>)`. In its SyncResult, `peers` and `seeders` are 0 or 1 (the verified seeder link), and an endpoint that fails the seeder check adds `semeador não verificado` to `errorsSoft`. The seeder address never appears in an event, a result or an error.

### Capped SyncResult (`capSyncResult(result)`)

The SyncResult of protocol §6 reshaped so that a `sync.stopped` event always fits `MAX_MESSAGE` (pure; the input is not mutated):

```
{ ok, peers, seeders, admitted, rejected: null | reason, seederConfirmed,
  downloaded: { hex64: contiguousLength }, downloadedTruncated,
  unadvertised: [hex64], unadvertisedTruncated,
  skipped: [{ key, reason }], skippedTruncated,
  errors: [string], errorsTruncated,
  errorsSoft: [string], errorsSoftTruncated }
```

- Every list is capped to `MAX_LIST` entries with its `<name>Truncated` count; `downloaded` keeps the `MAX_LIST` smallest keys (sorted), the rest counted in `downloadedTruncated`.
- Strings are clipped to `MAX_LINE` chars (`errors`, `errorsSoft`) or `MAX_TOKEN_TEXT` chars (keys, reasons, `rejected`); a clipped string ends with U+2026.
- If the serialization still exceeds `MAX_SYNC_RESULT` bytes, `errorsSoft`, `errors`, `skipped` and then `unadvertised` are emptied in that order, each moving its whole length into its Truncated count, until it fits.
- `ok`, `peers`, `seeders`, `admitted`, `seederConfirmed` keep their meaning (protocol §6, `seederConfirmed` included).

## 7. Error codes

| Code | On the wire | Meaning |
| --- | --- | --- |
| `USAGE` | yes | bad request or bad params; too many pending (`'pedidos demais em andamento'`); duplicate id (`'id repetido'`); oversized response (`'resposta grande demais'`); a state conflict the user caused (sections 5.5 to 5.14) |
| `UNAUTHORIZED` | yes | no `session.open` yet, or a failed one |
| `LOCKED` | yes | the data dir is held by another process, or the node session is in its error state |
| `NOT_FOUND` | yes | no identity yet, unknown author |
| `INTERNAL` | yes | anything unexpected; always the generic message `'erro interno'`, never a path or a stack |
| `TIMEOUT` | no (client only) | no response within the client timeout |
| `CLOSED` | no (client only) | the connection was lost or the client closed |

- Messages are pt-BR, short and MUST never contain a filesystem path or key material (A6). The dispatcher enforces a backstop: a message that is not a string of 1..200 UTF-16 units, or contains `/` or `\`, or a run of 16 or more hex digits, is replaced by the generic message of its code (`USAGE` `'pedido inválido'`, `UNAUTHORIZED` `'não autorizado'`, `LOCKED` `'diretório de dados em uso'`, `NOT_FOUND` `'não encontrado'`, `INTERNAL` `'erro interno'`). An 8-hex `key8` is allowed.
- Exports: the seven codes as constants, `ERROR_CODES`, `WIRE_CODES`, `CLIENT_CODES`, `GENERIC_MESSAGES`, `MAX_ERROR_MESSAGE`, `class RpcError extends Error { code, uncertain }`, `isSafeMessage(message)`, `toWireError(err)` -> `{ code, message }` (never throws).

## 8. Server dispatcher (`createServerDispatcher`)

`createServerDispatcher({ handlers, send, token = null, onProtocolError = () => {} })` -> `{ receive(obj), emit(event, data), close(), opened, closed, pending }`, one per connection. `handlers` maps a method name to `async (params) => result`; `send(message, text)` delivers one envelope (`text` is its JSON serialization, for transports that want it). Throws `TypeError` for a missing `handlers` / `send` or an empty-string token.

`receive(obj)` (an already decoded envelope):

1. Validate the envelope and params (sections 1, 5). Invalid with a usable, not-pending `id` -> `USAGE` response with that id; otherwise (no usable id) `onProtocolError({ code: 'USAGE', message })`, and the transport MUST close the connection.
2. A pending `id` -> `USAGE` `'id repetido'` (the original request is not affected).
3. `session.open` -> section 4, answered here.
4. Not open yet -> `UNAUTHORIZED` `'sessão não aberta'`.
5. `MAX_PENDING` requests already in flight -> `USAGE` `'pedidos demais em andamento'` at once; the handler is not called.
6. No handler for the method -> `INTERNAL`.
7. Call `handlers[method](normalizedParams)` asynchronously. Its value (a plain object; `undefined` or anything else -> `INTERNAL`) is sent as the result, size-checked (`'resposta grande demais'`, section 2); a result that cannot be serialized -> `INTERNAL`. A throw or rejection becomes `toWireError(err)`: `err.code` if it is a wire code other than `INTERNAL`, with its message if that passes the section 7 safety rule; otherwise `INTERNAL` `'erro interno'`.

`emit(event, data)` sends `{ v: 1, event, seq: <next>, data }` only after a successful `session.open`; an invalid event (unknown name, wrong `data` keys) is dropped; an oversized one is replaced by `warning` `{ line: 'evento grande demais' }` with that seq. Returns `true` when the requested event was sent.

`close()` stops everything: later `receive`, `emit` and the responses of handlers still running are no-ops. A throwing `send` never breaks the dispatcher.

## 9. Client (`createClient`)

`createClient({ send, timeoutMs = 30000 })` -> `{ request(method, params = {}), receive(obj), on(event, fn), close(), closed, pending }`.

- `request` returns a Promise of the result. Before sending it validates the envelope and params locally (`USAGE`, nothing sent), enforces `MAX_PENDING` (`USAGE` `'pedidos demais em andamento'`, nothing sent) and `MAX_REQUEST` (`USAGE` `'pedido grande demais'`). Ids increase from 1, wrap after `MAX_ID` and skip pending ids.
- `receive(obj)` routes a response by id (an unknown id is ignored, and so is any response once its request timed out) and an event to the `on(event, fn)` listeners as `fn(data, envelope)` (a throwing listener is ignored). Returns `false` for anything ignored. `on` returns an `off()` function.
- An error response rejects with `RpcError(code, message)`, `uncertain: false`.
- Timeout (`timeoutMs`, per request) -> `RpcError` `TIMEOUT`; `close()` (connection lost) rejects every pending request with `CLOSED`; a `send` that throws rejects that request with `CLOSED`. For a mutating method these carry `uncertain: true` (it may or may not have happened); for a read `uncertain: false`. Requests made after `close()` reject `CLOSED`, `uncertain: false` (never sent).
- **Never resend**: the client never retries or resends a request on its own. After an `uncertain` failure the UI re-reads state (for example `log.read`, `follow.list`, `sync.status`) before offering the action again.
- A request that timed out on the client may still be in flight on the server and still counts toward the server's `MAX_PENDING` until it answers.

## 10. Display rule (A8): `displayText(value, { multiline = false } = {})`

The single escaper the UI uses for EVERY peer-derived string (names, bios, post text, keys, reasons, event lines, error messages). Each unsafe code point becomes U+FFFD:

- C0 controls U+0000-U+001F, except U+000A (LF) when `multiline: true` (post text and bio only);
- DEL U+007F and C1 U+0080-U+009F;
- U+2028, U+2029;
- the bidi controls U+202A-U+202E and U+2066-U+2069;
- the direction marks U+200E, U+200F and U+061C (beyond `safe.js`);
- a lone surrogate U+D800-U+DFFF (records accept one, section 2; a well-formed surrogate pair is one code point and is kept).

This is the `isUnsafe` set of `packages/core/lib/safe.js` plus the three marks and lone surrogates. Non-strings are converted with `String()`; a value whose conversion throws gives `''`. Pure, total, never throws. The UI renders the output as plain text only.

## 11. Security rules

- IPC carries no token: the channel is private to the app process (the worklet is spawned by it). Its dispatcher is created with `token: null`. The browser node's in-memory channel has no token either (`token: null`): it never leaves the page.
- The browser node is opened by `VarandaWebNode.start({ association, seederUrl })` (`packages/web-member/web/node.js`) before any RPC: it takes the exclusive Web Lock `varanda-node`, so a second tab of the same browser is refused (`'outra aba já usa o Varanda neste navegador'`, code `LOCKED`) before a session exists. The handle it returns exposes only `connect` and `close`.
- The WebSocket is `varanda-serve`'s job (T7): it binds loopback only, checks the `Host` and `Origin` headers, requires a token in `session.open` (high-entropy, compared with `tokensEqual`), rejects binary frames, parses with `parseMessage(text, MAX_REQUEST)` and drops a client whose queued outbound bytes exceed `MAX_OUTBOUND`.
- `tokensEqual(a, b)` is constant-time over the longer length: no early exit on the first difference or on a length mismatch; a length mismatch or a non-string gives `false`.
- Results and messages never carry a filesystem path, a secret key, the bootstrap list or the DHT host (section 5.2, section 7).
- Any protocol error (section 3, a failed `session.open`, an envelope without a usable id) closes the connection; nothing is resent.

## 12. Module exports (`require('@varanda/rpc')`)

`index.js` re-exports: every constant of section 2; every export of section 7; `METHODS` (array), `MUTATING` (frozen array), `isMethod`, `isMutating`, `validateParams`, `isKey`, `isRef(str, minSeq = 1)`; `EVENTS` (`['sync.started', 'sync.event', 'sync.stopped', 'warning']`), `STOP_REASONS` (`['done', 'stopped', 'preempted', 'timeout', 'error']`), `validateRequest`, `validateResponse`, `validateEvent`; `encodeFrame`, `createFrameDecoder`, `parseMessage`; `displayText`, `utf8ByteLength`, `utf8Encode`, `utf8Decode`, `clipText(str, max)`; `tokensEqual`; `capList`, `capSyncResult`; `createServerDispatcher`, `createClient`. Files: `lib/limits.js`, `lib/errors.js`, `lib/methods.js`, `lib/envelope.js`, `lib/framing.js`, `lib/text.js`, `lib/token.js`, `lib/server.js`, `lib/client.js`.

## 13. Known limits (v1)

- Paging beyond the newest page is out of scope for v1: `feed.read` returns the newest `limit` items (at most 35) and `log.read` the newest `limit` blocks (at most 42), with no offset or cursor. Only `follow.list` pages (`offset`, `limit`).
- The page maxima are derived from the worst case of section 2 (lone surrogates at every record limit). Ordinary pages are far smaller; the maxima only guarantee that no page a peer can craft exceeds `MAX_MESSAGE`.
