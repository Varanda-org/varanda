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
| `MEDIA_BLOCK_BYTES`, `MAX_MEDIA_BLOCKS`, `MAX_MEDIA_PER_POST`, `MAX_MEDIA_ITEM_BLOCKS`, `MAX_MEDIA_DIMENSION` | 32768, 8192, 4, 256, 16384 | media descriptors, same values as `records.js` (protocol §2) |
| `MEDIA_MIMES` | `['image/jpeg', 'image/png', 'image/webp', 'image/gif']` | descriptor `mime` |
| `LOG_LIMIT_DEFAULT`, `LOG_LIMIT_MAX` | 20, 36 | `log.read` page |
| `FEED_LIMIT_DEFAULT`, `FEED_LIMIT_MAX` | 30, 31 | `feed.read` page |
| `PEEK_LIMIT_DEFAULT`, `PEEK_LIMIT_MAX` | 30, 31 | `peek.read` page (`PEEK_LIMIT_MAX` = `FEED_LIMIT_MAX`, its own name) |
| `NOTICES_LIMIT_DEFAULT`, `NOTICES_LIMIT_MAX` | 30, 64 | `notices.list` page |
| `PROFILE_LIMIT_MAX` | 100 | `profile.read` authors |
| `ENGAGEMENT_LIMIT_MAX` | 62 | `engagement.read` refs |
| `PEEK_SEQS_MAX` | 36 | `diary.peek` seqs |
| `PEEK_TIMEOUT_MS` | 8000 | `diary.peek` deadline (ms) of the browser node |
| `FOLLOW_LIMIT_DEFAULT`, `FOLLOW_LIMIT_MAX` | 100, 500 | `follow.list` page |
| `SYNC_TIMEOUT_MIN`, `SYNC_TIMEOUT_MAX`, `SYNC_TIMEOUT_DEFAULT` | 1000, 600000, 30000 | `sync.start` `timeoutMs` (ms) |

- Capped lists: a result list marked "capped" below holds at most `MAX_LIST` entries and travels with an integer `<name>Truncated` = the number of entries cut (`0` when none). `capList(list, max = MAX_LIST)` -> `{ list, truncated }` is the pure helper (first `max` entries, always a copy; a non-array is `[]`).
- Oversized response: a response whose serialization exceeds `MAX_MESSAGE` is replaced by `{ ok: false, error: { code: 'USAGE', message: 'resposta grande demais' } }` with the same id (the dispatcher does this, section 8). An oversized event is replaced by the event `warning` `{ line: 'evento grande demais' }` with the same `seq`.
- Worst-case response sizes (checked by `test/sizes.test.js`). The most expensive character on the wire is a lone surrogate: `records.js` counts it as one char and accepts it in names and texts (a peer can write it), and `JSON.stringify` writes it as `\udXXX`, 6 bytes. A 4-byte UTF-8 character costs 4 bytes, `"` and `\` 2 bytes, LF (`\n`) 2 bytes; every other character JSON escapes (C0 controls) or `jsonLine` escapes (DEL, C1, U+2028/9, bidi controls) is forbidden in names and texts. Every other field takes its maximum: hex64 keys, `seq` = 9007199254740991, `at` = `'+275760-09-13T00:00:00.000Z'` (the longest canonical ISO), `id` = `MAX_ID`, and `skipped` / `future` full (100 entries each, reason `untrusted-association`), and every post carries `MAX_MEDIA_PER_POST` (4) descriptors with the longest `mime` and the widest number in every field (one descriptor 242 bytes, the list of 4 is 973 bytes).
  - `feed.read`: one item (`kind`, 80-char name, 20-char username, 1000-char text, a reply, `quote: null`, 4 descriptors) is at most 7,790 bytes; a quote item (`replyTo: null` and a `quote`) is never larger and a repost item is smaller. 31 items = 260,838 bytes (fits, 1,306 bytes to spare); 32 items = 268,628 bytes (does not fit), so `FEED_LIMIT_MAX` = 31. With 4-byte characters instead of lone surrogates 32 items would be 199,508 bytes, but the lone-surrogate case decides. FeedItems carry no bio. (Re-measured when items gained `kind` and `quote`.)
  - `peek.read`: a PeekItem is a `feed.read` item plus `round` (<= 100000), so its worst case is a post with a reply or a quote ref (never both; a repost item is smaller); the envelope adds `next` (a cursor with the widest `round`, `at`, `author` and `seq`) and `diaries` / `skipped` of 4096. 31 items = 242,215 bytes with lone surrogates (fits, 19,929 bytes to spare). There is no `skipped` / `future` list, so it has more margin than `feed.read`; `PEEK_LIMIT_MAX` = `FEED_LIMIT_MAX` = 31 and the "one more does not fit" boundary is not asserted. (Re-measured when items gained `kind` and `quote`.)
  - `log.read`: one entry (a quote record of 1000 chars, with `replyTo: null`, a `quote` and 4 descriptors, 13 bytes more than a reply record) is at most 7,201 bytes on the wire; a profile record (80-char name, 280-char bio) is at most about 2.3 KB and a certificate record has fixed-size fields, so posts are the worst case. 36 entries = 259,414 bytes (fits, 2,730 bytes to spare); 37 = 266,615 bytes do not, so `LOG_LIMIT_MAX` = 36. (Before media the maxima were 35 and 42.) An `invalid` entry (`{ seq, reason }`) is smaller than any entry it replaces in the window.
  - `diary.peek`: 36 entries of worst-case quote records plus a profile (80-char name, 280-char bio) and a 20-char username = 261,642 bytes (fits, 502 bytes to spare); every split of the 36 requested seqs between `entries`, `invalid` and `missing` is at most that, so `PEEK_SEQS_MAX` = 36.
  - `engagement.read`: 62 liked and 62 reposted refs = 10,483 bytes.
  - `notices.list`: 64 notices (80-char name of lone surrogates, the longest username, a cursor and the flags) = 42,256 bytes (about 16% of `MAX_MESSAGE`).
  - `profile.read`: one profile (hex64 author, 80-char name, 20-char username, 280-char bio) is at most 2,290 bytes; the envelope with empty lists is 71 bytes. 100 profiles = 229,170 bytes (fits, 32,974 bytes to spare); the largest count that fits is 114 (261,244 bytes; 115 = 263,535 bytes does not), so `PROFILE_LIMIT_MAX` = 100 leaves a margin. A `missing` entry (a hex64 key, 66 bytes) is smaller than the profile it replaces, and duplicates are folded, so `profiles` plus `missing` never exceed 100 entries.
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

Mutating methods (`MUTATING`, exported as a frozen array; test with `isMutating(method)`): `identity.create`, `cert.add`, `profile.set`, `username.add`, `post.create`, `post.reply`, `post.quote`, `like.set`, `repost.set`, `follow.add`, `follow.remove`, `sync.start`, `sync.stop`, `node.close`. All others are reads (`account.sign` and `report.sign` sign but write nothing, 5.18 and 5.20).

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

- Params: `{ text: string 0..1000 chars, media?: [MediaDescriptor] }`: `media` is 1..`MAX_MEDIA_PER_POST` (4) descriptors with exactly the keys and ranges of protocol §2 (a sparse array is invalid); without `media` the text must have at least 1 char (`'parâmetro inválido: text'`), with it the text may be empty (a photo-only post).
- Result: `{ seq, ref }`, as `post --json`.

### 5.8 `post.reply`

- Params: `{ to: ref with seq >= 1, text: string 0..1000 chars, media?: [MediaDescriptor] }` (lowercase hex, canonical seq; block 0 is never a post), with the same `text` / `media` rule as 5.7.
- Result: `{ seq, ref }`, as `reply --json`.
- 5.6 to 5.8 require block 0: `USAGE` `'grave o certificado de membro antes de publicar'`; an invalid record: `USAGE` `'registro inválido: <reason>'`.
- `media` (5.7, 5.8): the descriptors come from the browser node's upload control (section 11), never from the bytes over RPC. The browser node accepts a descriptor only when it points into one of this device's own media cores that the own diary declares among its latest `media-core` records, with every block local and the byte count and SHA-256 matching; otherwise `USAGE` `'mídia inválida'` and nothing is appended. A post with media is never queued in the app's outbox (it needs the seeder now). The core node and `varanda-serve` answer `USAGE` `'mídia disponível só na versão web'` for any `media`, before anything is opened.

### 5.9 `follow.add` / 5.10 `follow.remove`

- Params: `{ key: hex64 }`.
- Result: `{ changed: boolean, followCount: integer }`: `changed` as in `follow` / `unfollow --json`, `followCount` = the length of `follows.json` after the call. The CLI's `follows` list is deliberately NOT returned, so a change that was written can never be turned into an oversized-response error; the UI re-reads `follow.list`. Expected errors: `USAGE` `'não é possível seguir a própria chave'`, `USAGE` `'limite de diários seguidos atingido'`.
- Follows are public and shared by every device of the member: the change is also written to the own diary as a `follow` record (protocol §2). The core node appends it in the same call once block 0 exists (protocol §7 `follow`). The browser node needs the identity unlocked (locked -> `USAGE` `'identidade bloqueada: entre com a passkey'`) and is local-first: the call answers at once (kv `follows` and `followsPending` change together), and every queued change is signed with the identity key (Ed25519 over the UTF-8 of `'varanda-follow-op-v1\n' + key + '\n' + ('1' | '0') + '\n' + at + '\n' + <own key>`); the queue keeps one change per key (the newest wins) and at most `MAX_INVENTORY - 1` changes. The session later appends the pending changes as `follow` records itself, through the write gate and a push, only while the identity is unlocked and block 0 exists, verifying each signature first: a change without a valid signature (for example one planted in the storage of a signed-out profile) is dropped and never signed into the diary, the same rule as the app's text outbox. The drain appends at most one change per key (the newest `at`) and skips any change whose key already has a diary `follow` record with an `at` at or after the change's `at`; the record reuses the change's own `at`, so a consumed or older change is never appended again (copies and replays are no-ops). The queue is capped at `MAX_INVENTORY - 1` both when read and when written (a "drain": coalesced, at most one queued, never while a user's once run is alive; a failure is the warning `aviso: seguidos ainda não enviados` and the changes stay pending, retried on the next own-synced of a continuous run at most 3 times in a row). A device's follows from before `follow` records existed are never published automatically (the old local list cannot be authenticated): the page asks the person through the handle's `follows` controls (section 11), and only the confirmed keys become signed changes; until then the device keeps its old list locally and its fold does not apply other devices' follows. A device with nothing to confirm marks itself done on its own. Changes made on another device arrive through the sync's fold (event `follows.changed`, section 6).

### 5.11 `follow.list`

- Params: `{ offset?: integer >= 0 (safe), limit?: integer 1..500 }`; `offset` defaults to 0, `limit` to 100.
- Result: `{ follows: [hex64], total: integer }`: `follows` = `readFollows(dataDir).slice(offset, offset + limit)` (the stored order, sorted per protocol §1); `total` = the whole list length. An `offset` at or past `total` gives `follows: []`.

### 5.12 `log.read`

- Params: `{ author?: hex64, limit?: integer 1..36, before?: integer >= 1 }`; `author` absent = the own diary; `limit` defaults to 20; `before` (an exclusive block-seq bound, safe integer) absent = the newest page. `0` is rejected (the window would be empty).
- Result: `{ key: hex64, entries: [{ seq, record }], invalid: [{ seq, reason }], entriesTruncated: integer }`.
  - The node takes `end = before === undefined ? length : min(before, length)` and the window of block seqs `max(0, end - limit) .. end - 1`, ascending by `seq` (a `before` past the length clamps to the newest page). Each block that passes `validRecordCopy(record, seq)` goes to `entries` with that copy; each other block goes to `invalid` with its `seq` and a reason code only (`validateRecord`'s reason, `'malformed'` for a block `decodeBlock` refused). A block that fails validation is NEVER returned as text (A8).
  - `entriesTruncated` = `max(0, end - limit)`, the number of blocks older than the window; `entriesTruncated === 0` means the window starts at the beginning of the diary. To page backwards, pass the lowest `seq` of the window (entries and invalid) as the next `before`.
  - Same rules as `log --json`: local data only; an author with no local data -> `NOT_FOUND` `'sem dados locais para este diário'` and no core is created.
- Size: `LOG_LIMIT_MAX` entries always fit `MAX_MESSAGE` (section 2).

### 5.13 `feed.read`

- Params: `{ limit?: integer 1..31, before?: { at, author, seq } }`, `limit` default 30. `FEED_LIMIT_MAX` = 31 pages always fit `MAX_MESSAGE` (section 2).
- `before` (absent = the newest page) has exactly the keys `at` (a canonical ISO string, `new Date(at).toISOString() === at`, at most 32 chars), `author` (lowercase hex64) and `seq` (a safe integer >= 1). With `before`, only items strictly before the cursor in feed order `(Date.parse(at), author, seq)` are considered and the LAST `limit` of them are returned (`buildFeed`'s `before`). The UI copies the cursor from the oldest item it holds; pages never overlap (feed order is total), and a page with fewer than `limit` items is the last. A sync between two requests may add older items, which later pages include; newer ones need a reload of the newest page. Cursors are navigation bounds, not snapshots: moderation (blocklist, revoked issuers) is re-checked on every request.
- Result: `{ items: [FeedItem], skipped: [{ key, reason }], skippedTruncated, future: [ref], futureTruncated }`, as `feed --json` plus the two counts.
  - `items`: `buildFeed`'s FeedItem objects unchanged (protocol §7 "FeedItem": a post item `{ kind: 'post', author, name, username, seq, at, text, replyTo, quote, media }`, never both `replyTo` and `quote`, or a repost item `{ kind: 'repost', author, name, username, seq, at, to, text: null, replyTo: null, quote: null, media: null }`, one per target the author still reposts; ascending by `(at, author, seq)`, the LAST `limit` kept). The UI renders a repost item as the ORIGINAL post `to` (read with `diary.peek`, or `log.read` on the core node) under 'Nome republicou', and every action on it targets the original. `media` is a copy of the post's descriptors, or `null`; a reader fetches the bytes itself (the hosted web app over the seeder's `/media` route, protocol §7 "Seeder media route", verifying length and SHA-256 against the descriptor).
  - `username: string | null`: the name in the highest-sequence `username` record whose issuer delegation and signature verify for the configured association and whose member is the diary key (`latestUsername`, `packages/core/lib/username.js`). It matches `/^[a-z][a-z0-9_]{2,19}$/` and is not six hex characters. No verified record means `null`; neither the member certificate nor `profile.name` supplies this field. Both v1 and v2 diaries can carry it. A rename updates the handle on every post in that diary once the record is synced.
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

### 5.18 `account.sign`

- Params: `{ phase, nonce, username, sub }`, all required, nothing else: `phase` one of `'reserve'`, `'finish'`, `'rename'`; `nonce` matches `/^[A-Za-z0-9_-]{43,128}$/` (the account service's base64url nonce); `username` matches `/^[a-z][a-z0-9_]{2,19}$/` and is not 6 hex characters (it would read like the fallback handle `'@' + key.slice(0, 6)`); `sub` is `''` for `'reserve'` and `'rename'` and, for `'finish'` only, the Google subject: 1..255 printable ASCII characters without space (`/^[\x21-\x7e]{1,255}$/`, so it can never contain the LF separator). A phase/sub mismatch -> `USAGE` `'parâmetro inválido: sub'`. Not mutating.
- The caller never passes the member, the association or any bytes: the node fills in `member` = its own diary key and `association` = its configured association, and signs exactly the UTF-8 bytes of these seven fields joined by LF (`0x0a`), no trailing LF (`accountLinkPayload`, `packages/core/lib/account-link.js`):

  ```
  varanda-account-link-v1
  <phase>
  <nonce>
  <member hex64>
  <username>
  <association hex64>
  <sub>          ('' for reserve and rename)
  ```

  The prefix separates this statement from every other signature of the protocol (member and issuer certificates, Hypercore blocks).
- Result: `{ signature: hex128 }`, the Ed25519 signature by the identity key; never the payload or a key. The account service checks it with `verifyAccountLink(fields, signature)`, using `member` as the public key.
- Browser node (`packages/web-member/lib/session.js`): the diary key is the raw Ed25519 public key of the passkey-derived pair, so it signs. It opens no diary, does not preempt or start a sync, appends nothing and contacts no one. No identity -> `NOT_FOUND` `'identidade não encontrada'`; locked -> `USAGE` `'identidade bloqueada: entre com a passkey'`; a pair for another diary -> `USAGE` `'passkey não corresponde ao diário guardado'`.
- Node session (`packages/core/lib/session.js`: the Bare worklet and `varanda-serve`): a Hypercore 11 diary key is not the signer's raw public key (protocol §1), so a signature could never verify against it: always `USAGE` `'assinatura disponível só no navegador'`, with or without an identity, and nothing is opened.

### 5.19 `username.add`

- Params: `{ record: object }`, nothing else: a plain object with `JSON.stringify(record)` at most 2048 bytes (`MAX_USERNAME_RECORD_BYTES` in `lib/methods.js`; larger -> `USAGE` `'parâmetro inválido: record'`). Only shape and size are checked here. Mutating.
- The record is an issuer-signed `username` record (docs/protocol.md section 3, "Username record"; `createUsernameRecord` in `packages/core/lib/cert.js`), as the account service returns it. The node verifies it with `verifyUsernameRecord(record, <own diary key>, <association>)`: exact shape, `member` = the own key, `association` = the configured association (the trust root), the embedded issuer delegation signed by the association and the record signed by the issuer. Anything else -> `USAGE` `'registro de nome inválido'` and nothing is written.
- Order: the newest `username` record by seq is the displayed name, so the record is compared with the diary's latest verified username record (`latestUsernameRecord` over the own entries, `packages/core/lib/username.js`), after the write gate in the browser node (below). Deep-equal to the latest -> `{ changed: false, username }`, nothing written (the browser node still retries an outstanding push, below). `date` earlier than the latest record's `date`, or the same `date` with a different record (two records of the same instant cannot be ordered) -> `USAGE` `'registro de nome antigo'`, nothing written: an earlier name would revert a rename. Otherwise a plain copy of the record (exactly its nine keys) is appended at the next seq (a `username` record is valid only at seq >= 1: before the member certificate, `USAGE` `'grave o certificado de membro antes de publicar'`) and the result is `{ changed: true, username, seq }`; a rename is a newer record appended this way.
- Browser node (`packages/web-member/lib/session.js`): a diary write like `profile.set` (section 11): no identity -> `NOT_FOUND` `'identidade não encontrada'`; locked -> `USAGE` `'identidade bloqueada: entre com a passkey'`; then the catch-up through the write gate (with the gate on and no seeder reachable, `USAGE` `'sincronize com o semeador antes de publicar'`), so a record another device already published arrives before the comparison and is not appended again; then the comparison, the append and the push. A record equal to the latest is not written, but while the seeder is not known to hold the local length a push runs anyway: a push that failed after the append is retried by handing the same record in again.
- Node session (`packages/core/lib/session.js`): the same verification, idempotence and `'registro de nome antigo'`, an identity required (`NOT_FOUND` without one), no write gate. A Hypercore 11 diary key is not the account-link signer (5.18), so the account service normally issues no record for it and the answer is `USAGE` `'registro de nome inválido'`.

### 5.20 `report.sign`

- Params: `{ nonce, target, seq?, reason, text?, quote? }`, nothing else: `nonce` matches `/^[A-Za-z0-9_-]{43,128}$/` (the account service's base64url nonce); `target` the reported diary key (lowercase hex64); `seq` optional, an integer `1..99999` (`MAX_LOG_BLOCKS - 1`: seq 0 is the member certificate), present for a report of that post and absent for a report of the whole account; `reason` one of `'spam'`, `'assedio'`, `'ilegal'`, `'outro'`; `text` the reporter's own words, `0..280` code points (default `''`); `quote` the reported post's text, `0..MAX_TEXT` (1000) code points (default `''`). A quote without `seq` -> `USAGE` `'quote só com seq'`; `seq` with an empty (or absent) quote is allowed (the report of a photo-only post, whose text is empty). Not mutating.
- The caller never passes the member, the association, a digest or any bytes: the node fills in `member` = its own diary key and `association` = its configured association, and signs exactly the UTF-8 bytes of these nine lines joined by LF (`0x0a`), no trailing LF (`reportPayload`, `packages/core/lib/report.js`):

  ```
  varanda-report-v1
  <nonce>
  <member hex64>
  <association hex64>
  <target hex64>
  <seq>          (canonical decimal, no leading zero; '' for an account report)
  <reason>
  <digest(text)>
  <digest(quote)>
  ```

  `digest(s)` is the lowercase hex of the plain BLAKE2b-256 hash (`hypercore-crypto` `hash`) of the UTF-8 bytes of `s`; `''` hashes too (`0e5751c0…`). The digests keep any LF inside a post out of the framing. The prefix separates this statement from every other signature of the protocol (certificates, account links, moderation requests, Hypercore blocks).
- `report.js` refuses (`TypeError`) more than the RPC layer: `member === target`; a control character, DEL, C1, U+2028/U+2029 or a bidi control in `text` (and in `quote`, where LF is allowed); and a `text` or `quote` that is not well formed (`String.prototype.isWellFormed()` false: a lone surrogate encodes to the same UTF-8 bytes as U+FFFD, so the digest would not bind the exact string). The app therefore sends `quote = post.text.toWellFormed()`, and the same for the report text.
- Result: `{ signature: hex128 }`, the Ed25519 signature by the identity key; never the payload or a key. The account service checks it with `verifyReport(fields, signature)`, using `member` as the public key. The signature proves that the reporter attested this text and this quote to the association's account service; it does NOT prove that the reported diary contains the quote (the moderator checks the diary).
- Browser node (`packages/web-member/lib/session.js`): signs like `account.sign` (5.18): it opens no diary, does not preempt or start a sync, appends nothing and contacts no one. No identity -> `NOT_FOUND` `'identidade não encontrada'`; locked -> `USAGE` `'identidade bloqueada: entre com a passkey'`; a pair for another diary -> `USAGE` `'passkey não corresponde ao diário guardado'`; `target` = the own key -> `USAGE` `'não é possível denunciar a própria chave'`; a statement `report.js` refuses -> `USAGE` `'denúncia inválida'`.
- Node session (`packages/core/lib/session.js`): as 5.18, always `USAGE` `'assinatura disponível só no navegador'`, with or without an identity, and nothing is opened.

### 5.21 `profile.read`

- Params: `{ authors: [hex64] }`, nothing else: 1..`PROFILE_LIMIT_MAX` (100) lowercase hex64 keys; duplicates are allowed and folded. Not mutating.
- Result: `{ profiles: [{ author, name: string | null, username: string | null, bio: string | null }], missing: [hex64] }`, one entry per distinct author, in first-occurrence order within each list.
  - An author is in `profiles` when `feed.read` would show its diary: the own key always; a followed or unfollowed replica with local data that passes `skipReason` (not blocked, no fork, a valid block-0 certificate for the association, issuer not revoked). `name` and `bio` come from the newest valid `profile` record of the WHOLE local log (`latestProfile`; none -> `null`, `null`); `username` = `latestUsername` (the newest candidate only, verified with the enforced revoked-issuer set; otherwise `null`).
  - Every other author is in `missing`: no local replica, blocked, fork, certificate failure, revoked issuer. The result never says why.
- No identity -> `NOT_FOUND` `'identidade não encontrada'`. Local data only: it never creates a core and works while the browser identity is locked. Like every member read it preempts a running sync (section 6.1), so a screen asks for all its authors in one batch.
- A node that predates this method answers `USAGE` `'método desconhecido'`; the app treats that as "no profiles available".
- Size: `PROFILE_LIMIT_MAX` profiles always fit `MAX_MESSAGE` (section 2).

### 5.22 `peek.read`

- Params: `{ limit?: integer 1..31, after?: { round, at, author, seq } }`, `limit` default 30 (`PEEK_LIMIT_DEFAULT`, `PEEK_LIMIT_MAX`). Not mutating. `after` has exactly the keys `round` (a safe integer >= 0), `at` (a canonical ISO string, at most 32 chars), `author` (lowercase hex64) and `seq` (a safe integer >= 1). Absent = the first page, which rebuilds the snapshot.
- Result: `{ items: [PeekItem], next: PeekCursor | null, diaries: integer, skipped: integer, incomplete: boolean }`.
  - `PeekItem` = FeedItem (5.13: a post item with `media`, `replyTo` and `quote`, or a repost item with `to`) plus `round`. Replies, quotes and reposts in effect are publications like any post; the app resolves the parent of a reply, the quoted post and a repost's original with `diary.peek` (5.27), as in A Rua. Images of peeked posts are fetched by the app over the existing `/media` route exactly as for A Rua (the seeder serves them only while the diary<->core binding holds and the diary is not blocked). No new event (`EVENTS` also has `'follows.changed'`, unrelated).
  - `diaries`: candidate diaries of the snapshot (advertised by the seeder with length >= 2, not followed, not blocked; the own diary is a candidate, so the person sees their own publications here).
  - `skipped`: candidates left out by a problem (block 0 unavailable or failing the certificate gate, blocked or revoked issuer, fork, quota, a block over 16 KiB, a block that did not arrive), or whose scan reached the 64-block cap without finding a publication. A diary with nothing to show (only a profile or likes, or shorter than 2 blocks) and one followed after the snapshot was built are not counted.
  - `incomplete`: true when the seeder's inventory did not complete (`remoteHave.size < remoteCount` at the 5 s timeout, protocol §5), the 25 s page deadline cut a fetch, the 16 MiB page byte budget was reached (it counts received raw bytes), or a diary's scan reached the 64-block cap before supplying its posts (it may hold older publications behind likes and other records).
- THE RULE: round `r` (r = 0, 1, 2) holds the (r+1)-th highest-seq publication of every candidate diary ("most recent" = last written; a publication is a `post`, reply and quote included, or a `repost` still in effect, the last operation per target winning within the fetched tail; likes are never shown). The Espiadinha ends after round 3 (`PEEK_MAX_ROUNDS` = 3), so no diary shows more than 3 publications. Page order is (`round` asc, `at` desc, `author` asc); a page holds the items strictly after `after`; `next` = the cursor of the last item when the page is full, `null` on the last page (a page shorter than `limit` is the last, as 5.13). The pt-BR sentence the app shows (`PEEK_RULE`): "A Espiadinha mostra a publicação mais recente de cada diário que você não segue, o seu incluído, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos."
- Cursors are navigation bounds, not snapshots (as 5.13): the node keeps an in-memory snapshot for at most 5 minutes; `after` absent rebuilds it from a fresh inventory (the previous snapshot is kept until the new one exists, so a failed refresh does not strand the list); an `after` on a missing or expired snapshot is refused with USAGE 'A lista expirou; atualize para continuar.' before any link is opened, instead of rebuilding (the app keeps its rows and asks for a pull to refresh). Follows and the stored blocklist snapshot are re-applied on every request, including continuation pages.
- Moderation: on every request, including continuation pages served from the snapshot, the node re-verifies each diary's block-0 certificate AND its username record against the current revoked-issuer set (a v1 certificate survives an issuer revocation, `packages/core/lib/cert.js`, but a username record from a revoked issuer must read as `null`, `packages/core/lib/username.js`).
- Where it runs: browser node only (`packages/web-member/lib/peek.js`): a short-lived second WebSocket link to the configured seeder (ephemeral Noise key, hello with an empty inventory, no announce, no `varanda/blocklist/1`), the seeder's inventory, then block 0 of each candidate (the gate), then blocks 1..2 and the newest 8 (older ones 8 at a time, up to 64 per diary) through Hypercore replication into memory cores. Nothing is written to storage; it works with the identity locked, like every read.
- Errors: no identity -> `NOT_FOUND` `'identidade não encontrada'`; no verified seeder within 15 s -> `USAGE` `'sem conexão com o semeador'`; a concurrent `peek.read` -> `USAGE` `'espiadinha já em andamento'`; node session -> `USAGE` `'Espiadinha disponível só no navegador'`; an older node -> `USAGE` `'método desconhecido'` (as 5.21). The app shows the web-only notice for the last two.
- Unlike other member reads it does NOT preempt a running sync (6.1): it opens no storage core (the browser session's preemption exists only because two Hypercore instances on one storage corrupt it); only the own-key lookup runs on the serialized chain (it may preempt once when the key is not yet cached).
- Trust: every block is verified by Hypercore against the author key. The tail window is computed from the SIGNED length Hypercore verifies with block 0 (the memory core's length after the block-0 get, as the quarantine reads it, `packages/web-member/lib/sync.js`), never from the length the seeder advertises in its hello (`admission.js` copies it unsigned); the advertised length only selects candidates (>= 2). The seeder can withhold (inventory, blocks, a shorter length, or an older signed state it kept), which it can already do to A Rua, but cannot forge a post, cannot pick an older post as the newest, cannot bypass the block-0 gate (verified locally with the stored revoked-issuer set) and cannot unblock anyone (stored signed blocklist).
- Privacy: the link sends an empty inventory and no announce, but it requests the complement of the follow set, which the seeder already learns from the sync link's inventory on the same IP (protocol §5 "Bounded inventory"); the seeder logs one `peer` event per link with an ephemeral key; nothing new is stored on any server.
- Cost: 1 WebSocket + Noise + hello/inventory (~85 bytes per entry), then per candidate one channel open and <= 11 block requests in two phases (block 0, then the window), 16 diaries in parallel; ~3-5 s for 300 diaries at 50 ms RTT; 4096 diaries may hit the deadline or the byte budget -> `incomplete`. Candidates are fetched in a random order per snapshot, so a cut falls on random diaries, never systematically on the same ones.
- Memory: parsed posts (<= 1000 chars) and at most 64 records per diary, raw buffers dropped after each window. Memory cores use 64 KiB pages (`random-access-memory` defaults to 1 MiB pages); between pages the node keeps only block 0, profile and username records and the posts and reposts among the at most 64 fetched blocks per diary (`retainRecords`), within `PEEK_SNAPSHOT_MAX_BYTES` = 33554432 (32 MiB) of retained records; beyond it fetching stops and the page is `incomplete`.
- Size: `PEEK_LIMIT_MAX` items always fit `MAX_MESSAGE` (section 2).

### 5.23 `post.quote`

- Params: `{ to: ref with seq >= 1, text: string 1..1000 chars, media?: [MediaDescriptor] }`, nothing else (the text is required even with `media`). Mutating.
- Result: `{ seq }`. Appends a quote record (protocol §2: a `post` with `quote` = `to` and `replyTo: null`).
- Browser node: the `post.reply` path (unlocked identity, write gate, append, push; `media` checked as in 5.8). Core node: `media` -> `USAGE` `'mídia disponível só na versão web'` before anything is opened; no write gate. Block 0 is required (`'grave o certificado de membro antes de publicar'`). The app never queues a quote in its outbox: it needs a connection.

### 5.24 `like.set` / 5.25 `repost.set`

- Params: `{ to: ref with seq >= 1, on: boolean }`, nothing else. Mutating.
- Result: `{ seq: integer | null, on: boolean, changed: boolean }`. Idempotent: the own diary's current state (`engagementState`, protocol §2: the last operation per target wins) is compared first; when it already is `on`, nothing is written, `changed` is `false` and `seq` is that of the existing effective record (`null` if there never was one). Otherwise one `like` / `repost` record is appended, `changed: true`, `seq` its block. Liking or reposting an own post is allowed.
- Browser node: the `post.reply` path (unlocked, write gate, append, push); a call that writes nothing still pushes while the seeder is not known to hold the local length. Core node: the same toggle, no write gate. Block 0 is required.

### 5.26 `engagement.read`

- Params: `{ refs: [ref] }`, nothing else: 1..`ENGAGEMENT_LIMIT_MAX` (62) distinct refs with seq >= 1 (a duplicate -> `'parâmetro inválido: refs'`). Not mutating.
- Result: `{ liked: [ref], reposted: [ref] }`: the subsets of `refs` (request order) that the OWN diary currently likes / reposts. Other people's engagement is not here (counts come from the seeder index, protocol §7 "Seeder index route").
- Local data only; works while the browser identity is locked. Like every member read it preempts a running sync (6.1), so the app calls it before its peeks.

### 5.27 `diary.peek`

- Params: `{ author: hex64, seqs: [integer >= 1], profileSeq?: integer >= 1, usernameSeq?: integer >= 1 }`, nothing else: `seqs` 1..`PEEK_SEQS_MAX` (36), strictly ascending (so distinct). Not mutating.
- Result: `{ key, length, entries: [{ seq, record }], invalid: [seq], missing: [seq], profile: { name, bio } | null, username: string | null }`. Each requested seq lands in exactly one list: `entries` (a block that passed `validRecordCopy`, the copy), `invalid` (a block that failed; never returned as text, A8) or `missing` (not available within the deadline, or beyond the length the node may read). `length` = the length of the core read. `profile` = the block at `profileSeq` if it is a valid `profile` record, else `null`; `username` = the block at `usernameSeq` only if it is a `username` record for `author` that verifies (`verifyUsernameRecord` with the configured association and the revoked issuers; no fallback to an earlier record), else `null`. The hints come from the seeder index: which record is the latest is the seeder's claim.
- Browser node (`packages/web-member/lib/session.js`, protocol §6 "Browser node on-demand reads"): outside the serial chain, like `peek.read` (5.22). It is served by the running sync's verified seeder link, never preempts it and never restarts a run itself (a restart beside a `withStore` write could corrupt the storage). At most 2 peeks in flight (`USAGE` `'ocupado'` beyond). When no verified run is live it queues a serial no-op (so `restartWhenIdle` restarts a wanted continuous run safely) and waits up to `PEEK_TIMEOUT_MS` (8 s); then `NOT_FOUND` `'semeador indisponível'`, which the caller may retry. A peek the run drops while stopping (preempted by a write) is retried once on the next verified run within the same deadline. A blocked, ungated, forked or unknown author -> `NOT_FOUND` `'diário indisponível'` (never why). Nothing is stored. A closed session -> `LOCKED` `'sessão encerrada'`.
- Core node (`packages/core/lib/session.js`: native app, `varanda-serve`): always `USAGE` `'leitura sob demanda só na versão web'`, before anything is opened. The app then falls back to local data (`log.read` of followed diaries) with a note.
- Size: 36 worst-case entries with a profile and a username always fit `MAX_MESSAGE` (section 2).

A node that predates 5.23 to 5.27 answers `USAGE` `'método desconhecido'`.

### 5.28 `notices.list`

Who started following the caller and whom the caller does not follow yet ("follow-back notices"). Private to the caller; the result carries no count and no total.

- Params: `{ limit?: integer 1..64, after?: { at, key } }`, `limit` default 30 (`NOTICES_LIMIT_DEFAULT`, `NOTICES_LIMIT_MAX`). Not mutating. `after` has exactly the keys `at` (a canonical ISO string) and `key` (lowercase hex64); absent = the first page. A different key set is rejected as for every method.
- Result: `{ notices: [Notice], next: { at, key } | null, incomplete: boolean, supported: boolean }`.
  - `Notice` = `{ key: hex64, seq: integer >= 1, at: ISO string, name: string | null, username: string | null, seen: hex32 }`: `key` is the follower's diary key, `seq` the block of their signed `follow` record, `at` that record's `at`, `name` their profile name and `username` their verified username (both `null` when unknown; the app shows 'sem nome' for a missing name and never a key). There is no `count`, `total` or `unread` field anywhere.
  - `seen` is an opaque token, 32 lowercase hex: the first 32 hex of BLAKE2b (`hypercore-crypto` `hash`) over `'varanda-notices-seen-v1\n'`, the 32-byte identity seed and `<own>\n<key>:<seq>`, computed by the browser node for each returned row at return time. It is stable for one identity and one follow (the same `(key, seq)` gives the same token on every read and after a reload) and different for another follow or another identity. Being keyed by the identity secret, which exists only in the unlocked session, it cannot be linked to the follower's key without that secret. It exists so the app can remember which notices were seen without storing anything derivable from follower keys (which are public): whoever reads the origin's storage while the passkey is locked cannot confirm who followed (docs/app.md, Avisos). A lock in the middle of a read fails it like a locked proof.
  - Order: newest `at` first (by `Date.parse`), then `key` ascending; `after` is exclusive and `next` is the cursor of the last item when more rows may follow, `null` otherwise. Only `next === null` ends the list: a page may be short or even empty with a `next` (the read dropped rows already followed, blocked or unverifiable, or stopped after 8 seeder pages), and the caller continues from it; the app does so automatically up to 4 times per action (`readNotices` in `apps/app/src/notices.js`).
  - `incomplete`: true when the seeder's index was not complete (a cap was hit or a diary was still being scanned), the 25 s read deadline, the byte budget, the 8 seeder pages or the per-row block cap cut the read, or a block did not arrive.
  - `supported`: false (with `notices: []`, `next: null`) when the seeder does not open the notices channel (an older seeder); the app says so; its 5-minute poll keeps asking, so an upgraded seeder is picked up without a reload.
- Where it runs: browser node only (`packages/web-member/lib/notices.js`). Every row is verified in the browser against the follower's signed blocks before it is returned (protocol "Notices link"): the seeder can withhold a row but cannot add one. Rows already followed, blocked, the own key or listed twice never appear; follows and the stored blocklist are re-applied on every request, including rows served from the evidence cache.
- Errors: the node session (`packages/core/lib/session.js`, the CLI and `varanda-serve`) answers `USAGE` `'avisos disponíveis só no navegador'` without opening anything; a concurrent `notices.list` -> `USAGE` `'avisos já em andamento'`; no identity -> `NOT_FOUND` `'identidade não encontrada'`; the identity locked -> `USAGE` `'identidade bloqueada: entre com a passkey'` (the proof needs the identity key); no verified seeder within 15 s or a link lost under the read -> `USAGE` `'sem conexão com o semeador'`; an older node -> `USAGE` `'método desconhecido'` (as 5.21). The app shows the web-only notice for the first and the last.
- Like `peek.read` it does NOT preempt a running sync (6.1) and writes nothing; no new event. Disconnect, lock, reset and close abort a running read and free the slot at once.
- Size: `NOTICES_LIMIT_MAX` notices always fit `MAX_MESSAGE` (section 2, `test/sizes.test.js`).

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
| `follows.changed` | `{ count: integer >= 0 }` |

- `follows.changed` (browser node only): the follow set changed from the own diary, normally another device's `follow` records folded in by the sync; `count` is the new number of follows. The UI reloads A Rua and the follow count. The browser node also restarts its continuous run once per distinct folded diary length (coalesced), so the run follows the new set; a once run is never restarted. The core node never sends it.

- `sync.started`: emitted every time a run starts, whether from `sync.start` or from the node restarting a continuous run after a preemption (section 6.1); `once` is the run's mode. With `sync.stopped` it lets the UI track the sync state from events alone: a run is active between its `sync.started` and its `sync.stopped`.

- `sync.event` `line` = the human stdout line the CLI prints for that `runSync` event (protocol §7 `sync`: `sync ready`, `peer member <peerKey8>`, `peer seeder <peerKey8>` / `... não verificado`, `admitted <key> <length>`, `rejected <key> <reason>`, `withdrawn <key> <peerKey8> <reason>`, `have <key> <length>`, `downloaded <key> <length>`), built with `safe()` exactly as `apps/cli/lib/commands/sync.js` `formatEvent` does. An event with no stdout line is not sent.
- `warning` `line` = a line the CLI prints on stderr, escaped with `safe()`: the `runSync` `log` lines (`aviso: ...`; a line that contains `/`, `\` or a run of 16+ hex digits, i.e. a raw error message that may carry a path or key material, keeps its prefix up to the first `': '` after `aviso: ` and ends with `': erro interno'`, and the full line goes only to the host's `onInternalError`), `aviso: diário <key8> ignorado (<reason>)` for a `skipped` event, and, before a `sync.stopped` with reason `'error'`, `'erro: ' + message` (a message that passes the section 7 safety rule, else `'erro: erro interno'`).
- `sync.stopped`: emitted once per run when it ends. Reasons: `'stopped'` = ended by `sync.stop`, by the connection closing or by the node session closing; `'preempted'` = the node paused the run to serve a request (or because the app went to the background, section 6.1); `'timeout'` = a `once` run ended at its deadline (`result.ok === false` with `errors[0]` = `'sem pares'` or starting with `'tempo esgotado'`); `'done'` = any other resolved run; `'error'` = `runSync` threw (no `result`). `result` is present only for a resolved `once` run (whatever the reason, `'stopped'` and `'preempted'` included), and is the SyncResult passed through `capSyncResult` (below).
- Lines and reasons are human text the node already escaped with `safe()` (A8). The UI still renders every line as text only (never markup) and through `displayText` (section 10).
- A run's events may reach the client before the `sync.start` response; the UI keys them by `runId`.

### 6.1 Preemption (the node session, `packages/core/lib/session.js`)

Every member operation opens the store and takes the data-dir lock, and a running sync holds that lock (protocol §9). The node therefore serves requests strictly one at a time, and before any request that opens the store (every member method, and `node.info` / `sync.start` while the own identity is not yet known to the session) it aborts the running sync and awaits it (`sync.stopped` with reason `'preempted'`). After the request, a continuous run (`once: false`) that the user did not stop is restarted with a new `runId` (`sync.started`, sent before that response); when several requests are queued the run is preempted once and restarted after the last of them. A `node.info` that preempted the run reports the restarted run in its `sync` field. A preempted `once` run is over: it is not restarted. `sync.status`, `sync.stop` and a `node.info` served from the session's cache never preempt. While the app is in the background (the host suspends the session) the run is paused the same way and restarted on resume; requests sent meanwhile wait.

The browser node's session (`packages/web-member/lib/session.js`) follows the same rules (one request at a time, the same preemption and restart, the same events; the exceptions are `peek.read`, 5.22, which opens no storage core and serializes only its own-key lookup, `diary.peek`, 5.27, which runs beside the chain inside the running sync, and `notices.list`, 5.28, which, like `peek.read`, opens no storage core; none of them preempts the run), because two Hypercore instances on the same browser storage would corrupt it; it has no suspend and resume. Its run (`packages/web-member/lib/sync.js`) has one peer, the seeder at the configured address, re-dialled with a backoff (1 s doubling to 30 s) while the run lasts. Its `sync.event` lines are the ones above except `withdrawn`, and its `peer` line always names the endpoint at the configured address (anything but a verified seeder is then dropped); its own `warning` lines are `aviso: sem conexão com o semeador; nova tentativa em <n> s` and `aviso: o endereço configurado não respondeu como um semeador verificado (<key8>)`. In its SyncResult, `peers` and `seeders` are 0 or 1 (the verified seeder link), and an endpoint that fails the seeder check adds `semeador não verificado` to `errorsSoft`. The seeder address never appears in an event, a result or an error.

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
- The browser node is opened by `VarandaWebNode.start({ association, seederUrl })` (`packages/web-member/web/node.js`) before any RPC: it takes the exclusive Web Lock `varanda-node`, so a second tab of the same browser is refused (`'outra aba já usa o Varanda neste navegador'`, code `LOCKED`) before a session exists. The handle it returns exposes only `connect`, `close`, `identity` and `media` (frozen, no other member of the node is reachable from the page).
- The handle's `identity` API (the member's key comes from a WebAuthn passkey; `packages/web-member/web/node.js`): `identity.status()` -> `{ exists, publicKey, legacy, unlocked, synced, webauthn, prf: 'yes'|'no'|'unknown', rpId, rpIdError?, passkeyKnown, resumed }`; `identity.unlock({ register = false })` -> `{ publicKey, created, sessionSaved? }` or `{ pending: true }` (a creation whose PRF result needs a second step); `identity.complete()` -> `{ publicKey, created, sessionSaved? }`; `identity.lock()` (zero-fills the keys in memory; reads still work; the stored session survives it, so the next start resumes); `identity.signOut()` ('Sair', below); `identity.reset()` (deletes the diary, this device's media cores, the stored passkey record and the stored session).
- Staying signed in (`packages/web-member/lib/session-store.js`): after a successful unlock, and only then, the passkey's 32-byte PRF output (the root every member key is derived from) is stored in its own IndexedDB database `'varanda-session'` as ONE record `{ v: 1, rpId, credentialId, publicKey, iv, ciphertext, key }`: sealed with AES-GCM-256 under a fresh 12-byte IV and a `CryptoKey` generated with `extractable: false`, the additional data `'varanda/session/v1\n' + rpId + '\n' + publicKey` binding it to this rp.id and this identity. `start()` reopens it with NO WebAuthn call when the stored passkey record is for this rp.id, the stored diary exists and is not legacy, and the record names the same passkey and public key; then `status().resumed` is `true`. Loading fails closed: any problem (another version, rp.id or key, a malformed field, a failed decryption, an IndexedDB error) clears the record and leaves the node locked, so a transient IndexedDB error signs the person out once. A failure to save still unlocks, with `sessionSaved: false`. The stored session expires after 30 days without the app being opened: the passkey is then asked again, and every open refreshes the period. What it protects: the PRF output is never written in clear, no script can export the AES key, and the record alone, copied to another origin or identity, does not open. What it does NOT protect: the wrapping AES key lives in the same browser profile as the sealed PRF output, so a copy of the whole profile yields the identity until 'Sair' or 30 days idle; a script running on this origin can call decrypt with the stored key and act as the member (an XSS is a full compromise, as it already was while unlocked); and anyone holding the unlocked device or browser profile can post until 'Sair' or the expiry. This reverses the earlier rule that the key existed only in memory.
- 'Sair' (`identity.signOut()`) always locks. Two independent barriers make it stick: it first writes the kv marker `'signedOut'` in the node storage, which makes `start()` refuse (and clear again) any stored session until the next successful passkey ceremony saves a new one; then it deletes the record (and, if that fails, the whole `'varanda-session'` database). When both deletions fail it rejects with code `SIGNOUT_INCOMPLETE`, `'não foi possível sair por completo neste aparelho: tente de novo'`; the node is locked either way. `reset()` does the same.
- The handle's `media` API: `media.upload({ bytes, mime, width, height, onProgress })` -> the descriptor a later `post.create` / `post.reply` carries. It is a host control, not an RPC method, because one request is capped at `MAX_REQUEST` (64 KiB) and an item may be 8 MiB. `bytes` (1 byte to `MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES`), `mime` and the dimensions are checked and the bytes copied synchronously; then, serialized with the RPC requests: the identity must be unlocked with a media key and block 0 must exist (`'grave o certificado de membro antes de publicar'`), the SHA-256 is computed (WebCrypto), and the item is stored in this device's media core in `MEDIA_BLOCK_BYTES` blocks. The first upload of a device's media core first declares the core in the diary (one `media-core` record through the write gate and a push, so it needs the seeder) BEFORE any byte of the item is stored, so a failed first upload stores none of it; later uploads into a declared core need no network until the post. `onProgress` hears `0.25`, `0.75` and `1`; errors keep their `code` and `message`. Nothing about the bytes is logged.
- The handle's `follows` API (host controls, unlocked only, block 0 required): `follows.legacy()` -> `{ keys }`, the follows this device kept from before `follow` records existed that neither a `follow` record of the own diary nor a verified pending change mentions (sorted, at most `MAX_INVENTORY - 1`; `[]` once decided; an empty set marks the device done); `follows.confirmLegacy(keys)` -> `{ published }`: each key in both `keys` and that set is queued as a signed `on: true` change (appended by the drain under the replay rule of 5.9), every other legacy key leaves this device's list, and the device is marked done. `keys` must be at most `MAX_INVENTORY - 1` lowercase hex64 strings (else `TypeError('chaves inválidas')`); keys outside the set are ignored; errors keep their `code`. The app shows them as the Seguindo card "Pessoas que você seguia neste aparelho" (`docs/app.md`).
- Media keys: one media core per DEVICE, signed by a key pair derived from the PRF output and the per-device nonce of kv `'mediaDevice'` (protocol §1 "Web member storage"); the pair is handed in with the identity pair (`setKeyPair(pair, { media })`), lives only in memory and is zero-filled with it. A media core holds at most `MAX_MEDIA_BLOCKS` blocks / 256 MiB; when it is full uploads fail with `'espaço de fotos deste aparelho esgotado'` (no rotation yet). The app calls `media.upload` only when the person presses Publicar (attached photos stay in the page's memory until then); once called, the stored bytes are public and permanent in the core even if a later upload or the post fails, and then stay unreferenced.
- Replication of the own media cores: they are opened read-only (lazy storage) and replicated only on the verified seeder link, next to the diary; never announced, never downloaded into, never part of the goals. Push confirmation (the sync event `media-pushed`, diagnostic only, no line): a block counts as held when it is below the seeder peer's advertised contiguous length OR was served to it on this link (Hypercore 10.38.2 has no core-level remote length and the seeder does not re-advertise ranges it downloaded from us); "served" means sent with its proof, not proven stored. Once runs never wait for media; the app keeps a continuous run, which is where the confirmation arrives. Errors carry a `code`: `UNSUPPORTED`, `NO_PRF`, `CANCELLED`, `EXISTS`, `WEBAUTHN`, `MISMATCH` (the stored diary belongs to another key; `legacy: true` for a store from before the passkeys, whose stored secret the node wipes on its first open, after which the diary stays readable and is never writable; only `reset()` removes it) and `LOCKED` (another ceremony in flight); a `NO_PRF` from a passkey that was created anyway also carries `credentialId` and `userId`. These are the handle's own errors, not RPC error codes (section 7).
- Writes need the key: `cert.add`, `profile.set`, `username.add`, `post.create`, `post.reply`, `post.quote`, `like.set` and `repost.set` fail with `USAGE` `'identidade bloqueada: entre com a passkey'` while the identity is locked (and `NOT_FOUND` `'identidade não encontrada'` with no identity); with a key that does not match the stored diary, `USAGE` `'passkey não corresponde ao diário guardado'`; when the catch-up with the seeder cannot confirm the diary is current (no answer within 15 s, an inventory that completed only by timeout, or the client detached meanwhile), `USAGE` `'sincronize com o semeador antes de publicar'` (or `'conexão encerrada'`) and nothing is written. Each of them first catches up with the seeder (`sync.event` line `'sincronizando antes de publicar'`) and then pushes (`'enviando ao semeador'`); both are internal runs that emit the usual `sync.started` / `sync.event` / `sync.stopped` (`once: true`). Other lines the session may emit: `'diário próprio sincronizado (<n>)'`, `'diário próprio atrasado (<n>/<m>)'`, `'certificado recuperado do semeador'`. `identity.create` and `follow.*` are not gated (the browser node's follow drain runs the gate itself, 5.9); `follow.*` still needs the identity unlocked on the browser node.
- Results never carry a secret: the key pairs (identity and media) exist only inside the session (set by the handle's own `identity` code, zero-filled on lock, sign-out, reset and close), and no RPC result, event or `identity` return value contains them. The only secret at rest is the sealed PRF output of the stored session above (with its wrapping key in the same browser profile).
- The WebSocket is `varanda-serve`'s job (T7): it binds loopback only, checks the `Host` and `Origin` headers, requires a token in `session.open` (high-entropy, compared with `tokensEqual`), rejects binary frames, parses with `parseMessage(text, MAX_REQUEST)` and drops a client whose queued outbound bytes exceed `MAX_OUTBOUND`.
- `tokensEqual(a, b)` is constant-time over the longer length: no early exit on the first difference or on a length mismatch; a length mismatch or a non-string gives `false`.
- Results and messages never carry a filesystem path, a secret key, the bootstrap list or the DHT host (section 5.2, section 7).
- Any protocol error (section 3, a failed `session.open`, an envelope without a usable id) closes the connection; nothing is resent.

## 12. Module exports (`require('@varanda/rpc')`)

`index.js` re-exports: every constant of section 2 (including `PEEK_LIMIT_DEFAULT`, `PEEK_LIMIT_MAX`, `PROFILE_LIMIT_MAX`, `ENGAGEMENT_LIMIT_MAX`, `PEEK_SEQS_MAX`, `PEEK_TIMEOUT_MS`, `NOTICES_LIMIT_DEFAULT` and `NOTICES_LIMIT_MAX`); every export of section 7; `METHODS` (array), `MUTATING` (frozen array), `isMethod`, `isMutating`, `validateParams`, `isKey`, `isRef(str, minSeq = 1)`; `EVENTS` (`['sync.started', 'sync.event', 'sync.stopped', 'warning', 'follows.changed']`), `STOP_REASONS` (`['done', 'stopped', 'preempted', 'timeout', 'error']`), `validateRequest`, `validateResponse`, `validateEvent`; `encodeFrame`, `createFrameDecoder`, `parseMessage`; `displayText`, `utf8ByteLength`, `utf8Encode`, `utf8Decode`, `clipText(str, max)`; `tokensEqual`; `capList`, `capSyncResult`; `createServerDispatcher`, `createClient`. Files: `lib/limits.js`, `lib/errors.js`, `lib/methods.js`, `lib/envelope.js`, `lib/framing.js`, `lib/text.js`, `lib/token.js`, `lib/server.js`, `lib/client.js`.

## 13. Known limits (v1)

- `diary.peek` exists only on the browser node and only while a verified seeder link is live (5.27); the core node reads local data only.
- `feed.read` and `log.read` page BACKWARDS only, with `before` (5.12, 5.13); there is no forward or `since` paging (newer data needs a reload of the newest page). The page maxima are 31 items and 36 blocks (lowered from 35 and 42 when posts gained media). `follow.list` pages with `offset` and `limit`.
- The page maxima are derived from the worst case of section 2 (lone surrogates at every record limit, 4 maximal descriptors per post). Ordinary pages are far smaller; the maxima only guarantee that no page a peer can craft exceeds `MAX_MESSAGE`.
- `peek.read` (5.22): cost grows linearly with the number of admitted diaries (the page deadline and byte budget mark the page `incomplete`). Names are best effort: a profile or username outside blocks 1-2 and the fetched tail reads as 'sem nome' or the older handle. `at` is author-supplied. Rows already shown are not retracted when a new blocklist arrives until the next request (as `feed.read`). Candidates are fetched in a random order per snapshot, so a deadline or budget cut falls on random diaries.
- `peek.read` capacity: the peek link is one extra short-lived external socket per page; the seeder admits at most `maxExternal` = 32 external sockets by default (`packages/core/lib/seeder.js`, `MAX_CONNECTIONS` 64 in `packages/core/lib/admission.js`) and every hosted member already holds one for its sync, so with ~30 hosted members online a peek can be refused (`USAGE` `'sem conexão com o semeador'`; the person retries).
- `notices.list` (5.28) capacity: each read opens one extra short-lived external socket, like a peek, against the same `maxExternal` = 32 of the seeder, so a busy seeder can refuse it (`USAGE` `'sem conexão com o semeador'`; the app polls every 5 minutes and tries again). A seeder keeps its notices index in memory only, rebuilt from block 1 whenever a diary is served, with at most 4096 followed targets per author and 262144 fold entries in total (protocol "Notices channel"); beyond a cap the pages are `incomplete`.
