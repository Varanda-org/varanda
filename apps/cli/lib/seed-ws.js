'use strict'

const http = require('node:http')
const nodeCrypto = require('node:crypto')
const path = require('node:path')
const { WebSocketServer, createWebSocketStream } = require('ws')
const { MAX_EXTERNAL_FRAME } = require('@varanda/core/lib/seeder')
const { MEDIA_BLOCK_BYTES, validShareCover } = require('@varanda/core/lib/records')
const { stillImageSize } = require('@varanda/core/lib/still-image')
const { feira, garden: gardenRules, mediaBounds } = require('@varanda/rpc')
const { renderListingPage, renderNotFound, renderSitemap } = require('./feira-page')
const { renderPostPage, postPreviewData, postPhotos } = require('./post-page')

// WebSocket entry of `seed --ws-port` (docs/protocol.md section 7): a phase 0
// spike that lets a browser-held member replicate through the seeder. Each
// WebSocket on /seeder is handed, as a raw duplex, to Seeder#acceptStream,
// which runs the Noise handshake keyed with the seeder key. The bytes on the
// socket are that Noise stream: a TLS proxy may forward them but must not
// terminate Noise.
//
// Members stay unauthenticated by design (the announce, docs/protocol.md
// section 6), but the entry must not be reachable by arbitrary web pages:
// WebSockets are not subject to CORS, so any page in a browser on this host
// could otherwise open ws://127.0.0.1:<port>/seeder. Two checks guard it:
// - Host (DNS-rebinding defence): the Host header must name this listener,
//   <bound host>:<port> (IPv6 bracketed), plus localhost / 127.0.0.1 / [::1]
//   on the same port when the bind is loopback; otherwise 421.
// - Origin: a request without an Origin header (a non-browser client: the
//   CLI, Node, native apps) is accepted; one with an Origin must be in the
//   allow-list (`origins`, exact origins), otherwise 403. Without `origins`,
//   the default allows any http origin on a loopback hostname (any port), so
//   the loopback spike page works and public pages are refused. There is no
//   CLI flag for `origins` yet: the public deployment PR adds --ws-origin to
//   allow the PWA's origin.
// The seeder also caps external sockets on its own (Seeder#maxExternal,
// VARANDA_MAX_EXTERNAL), so these clients never starve swarm peers, and
// shares those slots by client address (clientAddress below: behind Caddy,
// the X-Forwarded-For it sets). Nothing is logged per connection and no
// address is ever logged or stored.
//
// One TCP listener carries the WebSocket sockets, /media, /index and Caddy's
// keep-alive connections, so its socket cap (server.maxConnections, see
// socketCap) only bounds file descriptors: it is sized above the sum of the
// seeder's external cap and the /media and /index in-flight caps. The
// seeder's acceptStream is what refuses members beyond maxExternal.
//
// The same listener serves media blocks over plain HTTP (Caddy's
// `handle /media/*` proxies here): GET|HEAD /media/<D>/<K>/<start>/<blocks>,
// D the diary key and K the media core key (lower-case hex64), start >= 1 and
// 1 <= blocks <= MEDIA_MAX_BLOCKS as canonical decimals, no query string.
// The Host check runs first (421), any other method on /media is 405, and
// anything that does not match exactly, or that Seeder#mediaRead declines
// (no D <-> K binding, D blocked, a block not local, or no mediaRead at all),
// is the same 404 'não encontrado': the answer never says why, and neither
// the path nor any key is ever echoed or logged. A hit is 200, immutable
// application/octet-stream with an exact Content-Length, streamed block by
// block with backpressure (a write returning false waits for 'drain') and
// abandoned when the client goes away. Load is bounded globally, never per
// client address (the project does not handle addresses): at most
// MEDIA_MAX_IN_FLIGHT responses at once and a token bucket of MEDIA_RATE
// requests per second (burst MEDIA_BURST); beyond either, 503 'ocupado' with
// Retry-After: 1. A response still running after MEDIA_DEADLINE_MS is
// destroyed, so slow readers cannot hold the in-flight slots forever.
//
// The same listener also answers the seeder's engagement index (Caddy's
// `handle /index/*` proxies here; packages/core/lib/engagement-index.js), an
// in-memory index rebuilt at start that only says WHERE TO LOOK (refs, seq
// hints, counts) and carries honest `indexing` / `complete` flags; nodes
// fetch and verify every post from the diary itself. GET|HEAD only, on the
// same discipline as /media: Host first (421), other methods 405, a strict
// regex on the raw URL, and anything else, a seeder without the index
// methods, a null answer or a throw, the same generic 404. Routes:
// - /index/post/<author>/<seq>[/<cursor>] (cursor `<atMs>.<author>.<seq>`,
//   the last reply of the previous page) -> Seeder#indexPost;
// - /index/roda/<author>/<seq>[/<cursor>] (cursor as for /index/post, the
//   last row of the previous page) -> Seeder#indexRoda: `{ ref, root, top,
//   items: [{ ref, to }] (at most 50, parents before children; `to` the
//   parent ref), next, total, authors, indexing, complete }`, checked key by
//   key (anything else is the generic 404);
// - /index/counts/<ref>,<ref>,... (1..INDEX_MAX_REFS refs) -> indexCounts;
// - /index/member/<author>[/<before>] -> indexMember (its answer carries, for a page only, the
//   page hint page, closed, moved);
// - /index/page-end/<author> -> indexPageEnd -> null | { endSeq } (the seq of
//   the first verified page-close or page-moved, or null): a pointer page.feed
//   fetches and verifies itself (docs/protocol.md §12);
// - /index/search/<segment> (1..4 tokens of [a-z0-9]{1,20} joined by '-',
//   the folded search text) -> indexSearch(segment) -> null | { members:
//   [{ author, profileSeq, usernameSeq, [page, closed, moved] }] (at most 20), more, indexing,
//   complete }; a query with no hit is 200 with members: [].
// - /index/topic/<tokens>[/<cursor>] -> Seeder#indexTopic: tokens are
//   folded [a-z0-9] words of 2..32 chars joined by a literal '+', 1..8 of
//   them (the client folds; '%2B', uppercase, accents or a query string
//   never match, nothing is decoded here); the cursor `<atMs>.<author>.<seq>`
//   is the last candidate the previous page examined. The answer is
//   `{ items: [ref] (<= 30), next: cursor | null, authors: { hex64:
//   { profileSeq, usernameSeq } }, indexing, complete }`; an unknown word is
//   a 200 with empty items, a malformed path the generic 404. Unlike
//   ordinary browsing, which the browser computes from replicated diaries,
//   the submitted words DO reach the seeder here; they are never logged nor
//   echoed by the seeder; Caddy's error log can still record the URI when
//   proxying fails (docs/protocol.md).
// - /index/topic-trend -> Seeder#indexTopicTrend: `{ topics: [{ tag,
//   authors }] (at most 10), indexing, complete }` on the public index budget.
// - /index/group/<G>[/<after>] -> Seeder#indexGroup: `{ kind, visibility,
//   join, name, creator, rootServed, writers: [{ key, diary, length,
//   signed, seq, left }] (at most 64), next, indexing, complete }` (`length`
//   is the downloaded prefix, `signed` the signed length); the header fields
//   are null until the seeder has verified the root's header (they stay
//   while a writer of G is served after the root was purged or refused, with
//   rootServed false and creator null), `name` stays null for a private root.
//   `community` is the parent community the header names (hex64; null for a
//   community root or an unverified header) and `attached` whether that
//   community's catalogue hints attach the group. A community's writers are
//   its root and its community writers.
//   /index/groups/<D> -> indexGroups: `{ groups: [{ group, writer, seq,
//   left }] (one per group, at most 64), indexing, complete }`.
//   /index/group-search/<segment> (the segment as in /index/search) ->
//   indexGroupSearch: `{ groups: [{ group, name, writerCount }], more,
//   indexing, complete }` (at most 20), public groups only. Names are the
//   root header's peer text, returned as data (clients render them through
//   displayText). Like the topic words, the segment reaches the seeder and
//   is never logged or echoed.
//   /index/group-browse/members|recent|trending -> indexGroupBrowse:
//   `{ groups: [{ group, name, creator, community, communityName,
//   writerCount, created, active }] (at most 20), more, indexing,
//   complete }`, the public groups attached to a served community, by
//   member count, by creation date or by recently active diaries (`active`
//   is that count in trending, a hint from author-declared dates). /index/public-groups/<D>[/<after>] -> indexPublicGroups:
//   `{ groups: [{ group, name, creator, community, communityName,
//   writerCount }] (at most 32, key order), next, hidden, indexing,
//   complete }`, the open public groups D takes part in (each community's
//   Geral left out); `next` is null or the last row's key. Both use the
//   public budget, never the triage one.
// - /index/community/<C> -> Seeder#indexCommunity: `{ name, join, creator,
//   members, groups: [{ group, visibility, join, name, writerCount }]
//   (attached groups, key order, at most 32; name and writerCount null for
//   a private group), next, indexing, complete }`; `next` is null or the
//   last row's key. /index/community/<C>/groups/<cursor> ->
//   indexCommunityGroups: `{ groups, next, indexing, complete }`, the rows
//   after the cursor. A blocked key or one that is no community root here
//   is the generic 404.
// - /index/likes|reposts/<author>/<seq>[/<cursor>] -> Seeder#indexEngagers
//   (at most 20 like/repost record refs, newest first by the engager's at).
// - /index/follows/<author> -> Seeder#indexFollowCounts (`{ seguindo,
//   seguidores, indexing, complete }`) and
//   /index/follows/<author>/seguindo|seguidores[/<cursor>] (cursor
//   `<atMs>.<key>`, no seq: a follow pair is unique by key) ->
//   Seeder#indexFollows (at most 20 rows, newest first). Follower counts
//   and lists are public by decision; the seeder parses the cursor.
// - /index/testimonials/<owner> -> Seeder#indexTestimonials: `{ shown:
//   [{ seq, from, wseq }], pending: [{ from, seq }], indexing, complete }`
//   (at most 64 of each, newest first): `seq` the owner's testimonial-show
//   block, `from` / `wseq` and pending rows a writer's testimonial block.
//   Pointers only, rebuilt here field by field: the text and the sealed
//   box never leave the seeder; the node reads and verifies every block.
// - /index/scraps/<owner>[/<cursor>] -> Seeder#indexScraps: `{ scraps:
//   [{ author, seq, followSeq }], hides: [seq], wall: seq | null, next,
//   indexing, complete }` (at most 50 rows, newest first; at most 1000
//   hides). The seeder applies the owner's wall policy, hides, the reply
//   exception and the caps at read time; followSeq is the owner's follow
//   block for that writer or null. The cursor is `<atMs>.<author>.<seq>`
//   (as in /index/post) and `next` the same shape or null; any other
//   segment after the owner is 400 'pedido inválido', never 404, so a
//   client tells a bad cursor from an unknown owner.
// - /index/garden/<owner> -> Seeder#indexGarden: `{ on: seq | null, state:
//   seq | null, helps: [{ author, seq, followSeq }], given: [seq], indexing,
//   complete }` (Varandinha; at most GARDEN_HELP_ROWS helps and given): the
//   owner's newest live garden block (on or off) and garden-state block,
//   the neighbours' garden-help blocks inside the reader window with the
//   seq of each helper's live follow of the owner, and the owner's own help
//   seqs. /index/garden/<owner>/rua[/<key>] -> Seeder#indexGardenStreet:
//   `{ items: [{ key, on, state }], next, indexing, complete }` (at most
//   GARDEN_STREET_PAGE rows), the open balconies of the keys the owner
//   follows, key order, strictly after the cursor key; `next` is null or a
//   key. /index/garden/<owner>/mimos -> Seeder#indexGardenStall: `{ decor:
//   seq | null, pending: [{ author, followSeq, seq }], shelf: [{ from, gseq,
//   seq }], indexing, complete }` (Barraquinha and Enfeites; at most
//   GARDEN_GIFT_ROWS pending and GARDEN_SHELF_ROWS shelf rows): the owner's
//   newest live garden-decor block, the open mimos addressed to the owner
//   with the seq of each giver's live follow of the owner, and the owner's
//   takes (seq) of a giver's gift (from, gseq). Any other segment after the
//   owner is 400 'pedido inválido'.
//   Pointers only, checked against the exact shape: an extra key, a
//   duplicate or an oversized list is the generic 404, never trimmed.
// - /index/profile/<author> -> Seeder#indexProfile: `{ about: seq | null,
//   mood: seq | null, fans: { count, indexing }, top: { seq, back:
//   { <friend>: seq | null } } | null, visits: seq | null, garden: seq |
//   null, indexing, complete }`, the author's newest live profile-about,
//   mood, top-friends, visits and garden blocks (perfil rico, melhores
//   amigos, visitas, Varandinha; visits and garden are pointers only, the
//   node peeks the block and checks on, so an off block still has a seq), the claimed number of fas and, per listed friend, the
//   friend's live follow block of the author (at most MAX_TOP_FRIENDS). The
//   object is open: later features add pointers and readers ignore keys they
//   do not know, so profileBody keeps only the keys it lists. While the
//   author's own diary is still being indexed or scanned (fail closed)
//   about, mood, top, visits and garden are null, indexing and fans.indexing are true and
//   complete is false; otherwise complete is true and indexing is the global
//   flag. Pointers only; the node verifies.
// - /index/fans/<author>[/<atMs>.<key>] -> Seeder#indexFans: `{ author,
//   items: [{ key, seq, at }], next, total, authors, indexing, complete }`,
//   the author's fas newest first (at most 20 rows), the rows, cursor and
//   flags of /index/follows/<author>/seguidores without `kind`; seq and at
//   point at the fan's own block. Rebuilt here field by field.
// - /index/poll/<author>/<seq> -> Seeder#indexPoll: `{ totals: [n, ...],
//   indexing, complete }`, the claimed votes per option of the diary poll
//   post <seq> of <author> (2..4 integers; `[]` while the author's own diary
//   is still being indexed, with complete false). Totals are claims: a
//   client shows them as such and verifies 'quem votou' itself. A post that
//   is not a live poll post (deleted included) is the generic 404.
// - /index/poll/<author>/<seq>/<pick>[/<atMs>.<key>] -> Seeder#indexPollVoters:
//   `{ items: [{ key, seq, at }], next, total, authors, indexing, complete }`,
//   the voters whose live pick is <pick> (0..3), newest first (at most 20
//   rows), the rows, cursor and flags of /index/fans without `author`; seq
//   and at point at the voter's own `choice` block, which the node peeks
//   and verifies. A pick the poll has no option for is a 404. Rebuilt here
//   field by field.
// - /index/events/<author>[/<before>] -> Seeder#indexEvents: `{ posts: [seq],
//   next, total, indexing, complete }`, the seqs of the author's event posts
//   (Eventos) newest first, strictly below <before> (a canonical seq, no
//   leading zero), at most EVENT_ROWS_MAX per page; `next` is the <before> of
//   the following page or null. Pointers only: the title, place and dates
//   stay in the diary, which the node reads and verifies (the shared
//   isEvent). RSVP totals and voters are the /index/poll routes (picks 0 and
//   1). While the author's own diary is still being indexed or scanned: no
//   rows, indexing true, complete false. A malformed segment after the
//   author is the generic 404. Rebuilt here field by field.
// - /index/follow/<author>/<target> -> Seeder#indexFollowSeq: `{ seq:
//   seq | null, indexing }`, the author's live follow block of target.
//   Both rebuilt here field by field; both spend the index budget.
// Answers are JSON (no-store, nosniff) of at most INDEX_MAX_BODY bytes by
// construction (page sizes bound every list; apps/cli/test/seed-ws.test.js
// proves the worst case); HEAD sends the headers only. Load has its own
// global caps: INDEX_MAX_IN_FLIGHT answers at once (a slot is held until the
// response closes) and INDEX_RATE requests per second (burst INDEX_BURST),
// else 503 'ocupado'; a response still open after INDEX_DEADLINE_MS is
// destroyed. Duplicate refs in /index/counts collapse before the seeder is
// asked. Nothing is logged and nothing of the path is echoed.
//
// The listener also serves the chunks of encrypted DM media (Caddy's
// `handle /blob/*` proxies here, as /media): GET|HEAD /blob/<id>/<index>,
// id the blob id (lower-case hex64) and index a canonical decimal, no query
// string. Seeder#blobChunk(idHex, index) hands back the stored frame of a
// COMPLETE blob only, exactly as stored (it is ciphertext under a key only
// the DM carries); an unknown or incomplete blob, an index at or past the
// blob's count, a seeder without the blob pool (--no-dm) and a query string
// (even an empty '?') are all the same 404 'não encontrado' with no-store,
// so the answer never says whether the id exists. No auth and no cookie are
// read or set; a hit is 200 application/octet-stream, nosniff, with
// Cache-Control: private, max-age=604800 (7 days, shorter than the 14 the pool keeps a blob), so
// a shared cache never keeps it. Host first (421), other methods 405. The
// load is the /media budget itself (its in-flight cap and its token bucket,
// shared), so the socket cap below stays right. Nothing is logged: no id, no
// index, no address.
//
// Finally, and only when startSeedWs is given a `triageToken`, the listener
// answers GET /moderation-post/<D>/<seq> for the account service's report
// triage. A report carries the reporter's quote, which the reporter chose;
// judging that text would let anyone frame an author with words the author
// never wrote (packages/core/lib/report.js). Triage must judge the block the
// author signed, and this seeder already holds it: Seeder#postBlock hands
// out raw blocks 0 and <seq> of D when both are local, D is admitted,
// served, gated and not blocked, and nothing changed while it read. The
// answer is JSON { v: 1, fork, length, block0, block } (blocks base64) of
// at most POST_MAX_BODY bytes; whatever the record is (a post, a profile),
// the account service decodes and classifies it.
// Trust boundary: these are the raw bytes this seeder's own Hypercore
// verified when they arrived, not a portable proof (no signature or tree
// nodes travel with them). The account service trusts this local seeder
// plus the token-authenticated loopback for authenticity; its own
// re-validation only guards against malformed or wrong-type records.
// Exposure: the public never reaches this path. Caddy proxies only
// /seeder, /account/*, /media/*, /blob/* and /index/* to this listener
// (deploy/seeder/Caddyfile), and this route is deliberately not added
// there. The token still gates it because "loopback" is not "trusted":
// any local process, and any browser page through a DNS-rebinding or a
// mis-set proxy, could otherwise enumerate what the seeder holds. The
// `Authorization: Bearer <token>` header is read only on this path; both
// sides are hashed with sha256 to a fixed length before
// crypto.timingSafeEqual, so a wrong-length header neither throws nor
// returns early. Without a token the path is the generic 404 and no header
// is read. A wrong or missing token, a seeder without postBlock, a null
// answer, a throw or an oversized body are all the same 404 'não
// encontrado' (no-store, nosniff); a query string is 404, other methods
// (HEAD included) 405 with Allow: GET. Load has its own budget, never the
// /index or /media one: POST_MAX_IN_FLIGHT answers at once and POST_RATE
// per second (burst POST_BURST), else 503 'ocupado'; a response still open
// after POST_DEADLINE_MS is destroyed. The token, the path, the keys and
// the body are never logged.
//
// With the same token, GET /moderation-group-post/<W>/<seq> answers the
// account service's check of a GROUP report: Seeder#groupPostBlock reads
// block <seq> of served group core W (a member's writer or the root, header
// checked locally) and answers 200 JSON { group, diary, seq, texto,
// resposta } only when it validates as a group-post, so a group block is
// decided on the record the member signed, not on the reporter's quote. A
// group-sealed block of a private group answers { sealed: true, writer,
// diary, group, seq } and nothing else.
// Same token check, budget, deadline, 404 and silence as /moderation-post,
// and likewise never proxied by Caddy.
//
// With the same token, GET /moderation-listing/<D>/<seq> answers the
// current folded content of a Feira listing (Seeder#listingPublic, the root
// with its live edit) as JSON { title, text, priceLabel, city, uf, kind,
// status } (status null when unknown), so a listing report is judged on
// what the author signed. Anything that is not a live listing is the same
// 404; same token check, budget, deadline and silence as /moderation-post,
// never proxied.
//
// With the same token, GET /feira-listing/<D>/<seq> answers the account
// service's Feira entry (apps/cli/lib/account/feira-read.js): exactly
// { ok: true } when block <seq> is the root of a live listing of an
// admitted, served, visible diary (Seeder#listingPublic answers a card),
// else the same 404. Same token check, deadline and silence as
// /moderation-post, never proxied, absent without the token, but with its
// OWN budget (FEIRA_LISTING_MAX_IN_FLIGHT answers at once and
// FEIRA_LISTING_RATE per second, burst FEIRA_LISTING_BURST, else 503): the
// Feira entry is reached by people who are not members yet, so it must
// never spend the report triage's /moderation-post slots or tokens.
//
// The Feira (docs/protocol.md "Feira") exists on this listener only when
// startSeedWs is given a `publicOrigin` (the https origin the public pages
// are served under); without one every route below is the generic 404.
// - /index/feira/<uf>/<city>/<kind>/<cat>[/<words>][/<cursor>] ->
//   Seeder#indexFeira (uf lower case on the wire, asked upper case; city a
//   key of 2..48 chars, checked after the match; kind todos, produto,
//   servico or procura; cat todas or a category; words as in /index/topic;
//   cursor `<atMs>.<author>.<seq>`). /index/feira/autor/<D>[/<cursor>] ->
//   indexFeiraAuthor and /index/feira/avaliacoes/<D>[/<cursor>] ->
//   indexFeiraRatings (items carry the rating block's ref only). Same
//   bucket, in-flight cap, deadline, 64 KiB cap and no-store as /index; the
//   words reach the seeder and are never logged or echoed.
// - GET|HEAD /f/<D>/<seq>: the public page of a listing
//   (apps/cli/lib/feira-page.js escapes every peer string), text/html,
//   no-store, nosniff, Referrer-Policy no-referrer, and X-Robots-Tag
//   noindex for a vendido listing; anything that is no live listing of a
//   visible diary (a post seq, a deleted root, a blocked diary) is the
//   not-found page with 404. Budget of /index.
// - GET|HEAD /f/<D>/<seq>/foto/<1..4> and /f/<D>/<seq>/capa (= foto 1): the
//   photo of the CURRENT content, assembled through Seeder#mediaRead and
//   served only when its size, sha256 and magic bytes (for an AVIF, the
//   whole container parsed) match the descriptor
//   (the declared mime is the Content-Type, exact Content-Length), else
//   404. An edit changes what the same URL serves, so it is no-store. Own
//   in-flight cap FEIRA_PHOTO_MAX_IN_FLIGHT and deadline
//   FEIRA_PHOTO_DEADLINE_MS, sharing the /media token bucket; the slot is
//   held until the response closes and the read settled.
// - GET|HEAD /f/sitemap.xml: the newest live, non-vendido listings of
//   visible diaries (Seeder#feiraRecent, at most FEIRA_SITEMAP_LIMIT) as
//   absolute URLs, application/xml, Cache-Control public, max-age=600,
//   in-flight FEIRA_SITEMAP_MAX_IN_FLIGHT, /index bucket.
// Other methods are 405 with Allow, a query string is 404, Host first
// (421). Nothing is logged: no path, key, word or title.
//
// The public page of a shared post (docs/protocol.md section 16) is on only
// when startSeedWs is given a `postsOrigin` (VARANDA_POSTS_ORIGIN), which is
// independent of `publicOrigin`: neither turns the other on. Every path
// under /p/ is answered here whatever the switch says, so Caddy's app
// fallback never serves one. GET|HEAD only (405 with Allow otherwise), Host
// first (421), and nothing is logged: no path, key, seq or address.
// - /p/policy: {"enabled":true|false}, no-store.
// - /p/<D>/<seq>: 200 with the page (apps/cli/lib/post-page.js escapes
//   every peer string), X-Robots-Tag noindex, nofollow, noarchive and
//   no-store, only when the switch is on and Seeder#postPublic answers.
//   Every other case (switch off, nothing shared, withdrawn, deleted,
//   unknown diary or closed or moved page, a non-canonical seq, no slot,
//   deadline passed) is ONE 302 to /publicacao/<D>/<seq> built from the
//   matched path only,
//   with the same headers and an empty body, so the answer is no oracle of
//   which posts exist or are shared. Own budget (POST_PAGE_MAX_IN_FLIGHT,
//   POST_PAGE_RATE per second, burst POST_PAGE_BURST, an answer within
//   POST_PAGE_DEADLINE_MS), never the Feira's.
// - /p/<D>/<seq>/previa (no query string): the page's JSON twin for the app
//   before sign-in, 200 {"post":<postPreviewData>} under exactly the page's
//   gate. Every other case is ONE 200 {"post":null} with the same headers
//   (application/json, nosniff, no-referrer, X-Robots-Tag, no-store), so it
//   is no oracle either. Own budget (POST_PREVIA_MAX_IN_FLIGHT,
//   POST_PREVIA_RATE per second, burst POST_PREVIA_BURST, an answer within
//   POST_PREVIA_DEADLINE_MS), never the page's nor the Feira's.
// - /p/<D>/<seq>/foto/<1..4>: photo n of what the page shows (postPhotos:
//   for a video post only its cover, never video bytes), checked as the
//   Feira photos are, and served only if postPublic still answers with the
//   same share after the bytes are read; else the generic 404. In-flight
//   POST_PHOTO_MAX_IN_FLIGHT, deadline POST_PHOTO_DEADLINE_MS, /media
//   token bucket.
// - /p/<D>/<seq>/capa (no query string): the post's share cover (the
//   newest live post-cover postPublic names), the page's og:image. Checked
//   as a photo, then held to validShareCover and to its JPEG frame size,
//   and served only if postPublic still answers with the same share and the
//   same cover after the bytes are read; else the generic 404. The photos'
//   in-flight cap, deadline and bucket.
// - anything else under /p/ is the generic 404.
const DEFAULT_HOST = '127.0.0.1'
const PATH = '/seeder'
const MAX_SOCKETS = 128
const HEADERS_TIMEOUT_MS = 4000
const CHECK_INTERVAL_MS = 1000
// How long a refused upgrade may take to flush its response, or a WebSocket
// refused by the seeder for capacity its 1013 close, before the socket is
// destroyed anyway.
const REFUSE_GRACE_MS = 1000
// How often a /seeder upgrade held while the seeder starts (startHoldMs)
// checks whether the seeder accepts streams yet.
const HOLD_CHECK_MS = 100

const MEDIA_PREFIX = '/media'
// Canonical decimals only (no sign, no leading zero); the digit caps keep the
// values safe integers before the range checks.
const MEDIA_RE = /^\/media\/([0-9a-f]{64})\/([0-9a-f]{64})\/([1-9][0-9]{0,14})\/([1-9][0-9]{0,2})$/
const MEDIA_MAX_BLOCKS = 256
const MEDIA_MAX_IN_FLIGHT = 16
const MEDIA_RATE = 64
const MEDIA_BURST = 128
const MEDIA_DEADLINE_MS = 120000
const MEDIA_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Accept-Ranges': 'none'
}

const BLOB_PREFIX = '/blob'
const BLOB_RE = /^\/blob\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,2})$/
const BLOB_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=604800',
  'Accept-Ranges': 'none'
}

const INDEX_PREFIX = '/index'
const INDEX_MAX_REFS = 31
const INDEX_POST_RE = /^\/index\/post\/([0-9a-f]{64})\/([1-9][0-9]{0,14})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const INDEX_RODA_RE = /^\/index\/roda\/([0-9a-f]{64})\/([1-9][0-9]{0,14})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
// A roda page lists at most RODA_ROWS_MAX messages and hints the authors of
// those rows plus the asked post, its root and its top.
const RODA_ROWS_MAX = 50
const RODA_AUTHORS_MAX = RODA_ROWS_MAX + 3
const RODA_KEYS = ['authors', 'complete', 'indexing', 'items', 'next', 'ref', 'root', 'top', 'total']
const RODA_ITEM_KEYS = ['ref', 'to']
const RODA_HINT_KEYS = ['profileSeq', 'usernameSeq']
const INDEX_REF_RE = /^[0-9a-f]{64}:[1-9][0-9]{0,14}$/
const INDEX_CURSOR_RE = /^[0-9]{1,16}\.([0-9a-f]{64})\.([1-9][0-9]{0,14})$/
// 1..INDEX_MAX_REFS refs `<hex64>:<seq>`, comma-separated, no trailing comma.
const INDEX_COUNTS_RE = /^\/index\/counts\/([0-9a-f]{64}:[1-9][0-9]{0,14}(?:,[0-9a-f]{64}:[1-9][0-9]{0,14}){0,30})$/
const INDEX_MEMBER_RE = /^\/index\/member\/([0-9a-f]{64})(?:\/([1-9][0-9]{0,14}))?$/
const INDEX_PAGE_END_RE = /^\/index\/page-end\/([0-9a-f]{64})$/
// 1..4 lowercase ascii tokens of 1..20 chars joined by single '-'.
const INDEX_SEARCH_RE = /^\/index\/search\/([a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3})$/
// 1..8 folded words of 2..32 [a-z0-9] chars joined by a literal '+', then an
// optional cursor `<atMs>.<author>.<seq>` as in INDEX_POST_RE.
const INDEX_TOPIC_RE = /^\/index\/topic\/([a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const INDEX_TOPIC_TREND_RE = /^\/index\/topic-trend$/
// Groups: the root key with an optional exclusive writer-key cursor, a
// diary key, and a search segment shaped as in INDEX_SEARCH_RE.
const INDEX_GROUP_RE = /^\/index\/group\/([0-9a-f]{64})(?:\/([0-9a-f]{64}))?$/
const INDEX_GROUPS_RE = /^\/index\/groups\/([0-9a-f]{64})$/
const INDEX_GROUP_SEARCH_RE = /^\/index\/group-search\/([a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3})$/
// Discovery lists: an order name, and a diary key with an optional
// exclusive group-key cursor.
const INDEX_GROUP_BROWSE_RE = /^\/index\/group-browse\/(members|recent|trending)$/
const INDEX_PUBLIC_GROUPS_RE = /^\/index\/public-groups\/([0-9a-f]{64})(?:\/([0-9a-f]{64}))?$/
const INDEX_COMMUNITY_RE = /^\/index\/community\/([0-9a-f]{64})$/
const INDEX_COMMUNITY_GROUPS_RE = /^\/index\/community\/([0-9a-f]{64})\/groups\/([0-9a-f]{64})$/
const INDEX_ENGAGERS_RE = /^\/index\/(likes|reposts)\/([0-9a-f]{64})\/([1-9][0-9]{0,14})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const INDEX_FOLLOW_COUNTS_RE = /^\/index\/follows\/([0-9a-f]{64})$/
const INDEX_FOLLOWS_RE = /^\/index\/follows\/([0-9a-f]{64})\/(seguindo|seguidores)(?:\/([0-9]{1,16}\.[0-9a-f]{64}))?$/
const INDEX_TESTIMONIALS_RE = /^\/index\/testimonials\/([0-9a-f]{64})$/
const TESTIMONIAL_ROWS_MAX = 64
const INDEX_SCRAPS_RE = /^\/index\/scraps\/([0-9a-f]{64})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
// Any path below an owner's recados that INDEX_SCRAPS_RE refuses: a
// malformed cursor (400).
const INDEX_SCRAPS_BAD_RE = /^\/index\/scraps\/[0-9a-f]{64}\//
const INDEX_GARDEN_RE = /^\/index\/garden\/([0-9a-f]{64})$/
const INDEX_GARDEN_STREET_RE = /^\/index\/garden\/([0-9a-f]{64})\/rua(?:\/([0-9a-f]{64}))?$/
const INDEX_GARDEN_MIMOS_RE = /^\/index\/garden\/([0-9a-f]{64})\/mimos$/
// Any path below an owner's balcony that the three above refuse (400).
const INDEX_GARDEN_BAD_RE = /^\/index\/garden\/[0-9a-f]{64}\//
const GARDEN_KEYS = ['complete', 'given', 'helps', 'indexing', 'on', 'state']
const GARDEN_HELP_KEYS = ['author', 'followSeq', 'seq']
const GARDEN_STREET_KEYS = ['complete', 'indexing', 'items', 'next']
const GARDEN_STREET_ITEM_KEYS = ['key', 'on', 'state']
const GARDEN_MIMOS_KEYS = ['complete', 'decor', 'indexing', 'pending', 'shelf']
const GARDEN_MIMO_KEYS = ['author', 'followSeq', 'seq']
const GARDEN_SHELF_KEYS = ['from', 'gseq', 'seq']
const INDEX_PROFILE_RE = /^\/index\/profile\/([0-9a-f]{64})$/
const INDEX_FANS_RE = /^\/index\/fans\/([0-9a-f]{64})(?:\/([0-9]{1,16}\.[0-9a-f]{64}))?$/
const FAN_ROWS_MAX = 20
const INDEX_POLL_RE = /^\/index\/poll\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const INDEX_POLL_VOTERS_RE = /^\/index\/poll\/([0-9a-f]{64})\/([1-9][0-9]{0,14})\/([0-3])(?:\/([0-9]{1,16}\.[0-9a-f]{64}))?$/
// Same value as POLL_MAX in @varanda/core/lib/records.js.
const POLL_OPTIONS_MAX = 4
// Same value as MAX_TOP_FRIENDS in @varanda/core/lib/records.js.
const TOP_FRIENDS_MAX = 8
const INDEX_EVENTS_RE = /^\/index\/events\/([0-9a-f]{64})(?:\/([1-9][0-9]{0,14}))?$/
// Same value as GROUP_EVENTS_LIMIT in @varanda/rpc lib/limits.js.
const EVENT_ROWS_MAX = 30
const INDEX_FOLLOW_RE = /^\/index\/follow\/([0-9a-f]{64})\/([0-9a-f]{64})$/
const SCRAP_ROWS_MAX = 50
const SCRAP_HIDES_MAX = 1000
const BAD_REQUEST = 'pedido inválido\n'
// Feira: uf (lower case on the wire), city key, kind, category, then optional
// title words as in INDEX_TOPIC_RE and an optional cursor as in INDEX_POST_RE.
const INDEX_FEIRA_RE = /^\/index\/feira\/([a-z]{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(todos|produto|servico|procura)\/(todas|[a-z]{2,16})(?:\/([a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}))?(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const INDEX_FEIRA_AUTHOR_RE = /^\/index\/feira\/autor\/([0-9a-f]{64})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const INDEX_FEIRA_RATINGS_RE = /^\/index\/feira\/avaliacoes\/([0-9a-f]{64})(?:\/([0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}))?$/
const FEIRA_CITY_MIN = 2
const FEIRA_CITY_MAX = 48
const SCRAP_CURSOR_RE = /^[0-9]{1,16}\.[0-9a-f]{64}\.[1-9][0-9]{0,14}$/
const BAD_CURSOR = Symbol('bad cursor')
const INDEX_MAX_IN_FLIGHT = 16
const INDEX_RATE = 32
const INDEX_BURST = 64
const INDEX_DEADLINE_MS = 30000
const INDEX_MAX_BODY = 65536
const INDEX_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

const POST_PREFIX = '/moderation-post'
const POST_RE = /^\/moderation-post\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const POST_MAX_IN_FLIGHT = 2
const POST_RATE = 4
const POST_BURST = 8
const POST_DEADLINE_MS = 5000
const POST_MAX_BODY = 65536
const GROUP_POST_PREFIX = '/moderation-group-post'
const HEX64_RE = /^[0-9a-f]{64}$/
const GROUP_POST_RE = /^\/moderation-group-post\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const TRIAGE_TOKEN_RE = /^[0-9a-f]{64}$/
const LISTING_MOD_PREFIX = '/moderation-listing'
const LISTING_MOD_RE = /^\/moderation-listing\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const FEIRA_LISTING_PREFIX = '/feira-listing'
const FEIRA_LISTING_RE = /^\/feira-listing\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const FEIRA_LISTING_MAX_IN_FLIGHT = 2
const FEIRA_LISTING_RATE = 4
const FEIRA_LISTING_BURST = 8

const FEIRA_PREFIX = '/f'
const FEIRA_PAGE_RE = /^\/f\/([0-9a-f]{64})\/([1-9][0-9]{0,14})$/
const FEIRA_FOTO_RE = /^\/f\/([0-9a-f]{64})\/([1-9][0-9]{0,14})\/foto\/([1-4])$/
const FEIRA_CAPA_RE = /^\/f\/([0-9a-f]{64})\/([1-9][0-9]{0,14})\/capa$/
const FEIRA_SITEMAP_RE = /^\/f\/sitemap\.xml$/
const FEIRA_PAGE_MAX_BODY = 65536
const FEIRA_PHOTO_MAX_IN_FLIGHT = 8
const FEIRA_PHOTO_DEADLINE_MS = 10000
const FEIRA_SITEMAP_MAX_IN_FLIGHT = 2
const FEIRA_SITEMAP_LIMIT = 5000
const PUBLIC_ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9][0-9]{0,4})?$/
const FEIRA_CAT_LABELS = {
  casa: 'Casa',
  roupa: 'Roupas',
  eletronicos: 'Eletrônicos',
  moveis: 'Móveis',
  infantil: 'Infantil',
  esporte: 'Esporte',
  veiculos: 'Veículos',
  comida: 'Comida',
  aulas: 'Aulas',
  beleza: 'Beleza',
  reparos: 'Reparos',
  outros: 'Outros'
}
// The declared mime must match the bytes: a peer chose both.
const IMAGE_MAGIC = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'image/gif': (b) => b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a'),
  // No fixed magic: the whole container must parse as an AVIF image.
  'image/avif': (b) => mediaBounds(b, 'image/avif') !== null
}
const FEIRA_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer'
}
const POSTS_PREFIX = '/p'
const POST_POLICY = '/p/policy'
// Any digit string, so a non-canonical seq still gets the uniform 302.
const POST_PAGE_RE = /^\/p\/([0-9a-f]{64})\/([0-9]+)$/
const POST_FOTO_RE = /^\/p\/([0-9a-f]{64})\/([1-9][0-9]{0,15})\/foto\/([1-4])$/
const POST_CAPA_RE = /^\/p\/([0-9a-f]{64})\/([1-9][0-9]{0,15})\/capa$/
// Any digit string, so a non-canonical seq still gets the uniform answer.
const POST_PREVIA_RE = /^\/p\/([0-9a-f]{64})\/([0-9]+)\/previa$/
const CANONICAL_SEQ_RE = /^[1-9][0-9]{0,15}$/
const POST_PAGE_MAX_BODY = 65536
const POST_PAGE_MAX_IN_FLIGHT = 4
const POST_PAGE_RATE = 8
const POST_PAGE_BURST = 16
const POST_PAGE_DEADLINE_MS = 5000
const POST_PHOTO_MAX_IN_FLIGHT = 4
const POST_PHOTO_DEADLINE_MS = 10000
const POST_PREVIA_MAX_BODY = 65536
const POST_PREVIA_MAX_IN_FLIGHT = 4
const POST_PREVIA_RATE = 8
const POST_PREVIA_BURST = 16
const POST_PREVIA_DEADLINE_MS = 5000
const POST_ROBOTS = 'noindex, nofollow, noarchive'
const POST_PREVIA_NONE = '{"post":null}'
const POST_PREVIA_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': POST_ROBOTS,
  'Cache-Control': 'no-store'
}

const sha256 = (value) => nodeCrypto.createHash('sha256').update(value).digest()

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// `keys` sorted: the object has exactly these own enumerable keys.
function exactKeys (o, keys) {
  if (!isPlainObject(o)) return false
  const got = Object.keys(o).sort()
  return got.length === keys.length && got.every((k, i) => k === keys[i])
}

const isIndexRef = (s) => typeof s === 'string' && INDEX_REF_RE.test(s)
const isHintSeq = (n) => n === null || (Number.isSafeInteger(n) && n >= 1)

// The secret-stream's per-frame authentication overhead, read from the
// sodium-secretstream that the installed @hyperswarm/secret-stream (the one
// @varanda/core uses) loads, so it follows the version actually in use.
function secretStreamAbytes () {
  const seederFile = require.resolve('@varanda/core/lib/seeder')
  const secretStream = require.resolve('@hyperswarm/secret-stream', { paths: [path.dirname(seederFile)] })
  const sodium = require.resolve('sodium-secretstream', { paths: [path.dirname(secretStream)] })
  return require(sodium).ABYTES
}

// The WebSocket message limit follows the seeder's frame guard, not a value
// of its own: NoiseSecretStream writes each secret-stream frame with one
// write and createWebSocketStream sends each write as ONE WebSocket message,
// so a legitimate member's message is one frame, and the guard (FrameGuard in
// packages/core/lib/seeder.js) accepts post-handshake frames whose declared
// length is up to MAX_EXTERNAL_FRAME (about 8 MiB: hypercore corks protomux,
// which flushes a corked batch only at MAX_BATCH = 8 MiB). A smaller limit
// here would close such a member with 1009 before the guard ever saw the
// frame. The message therefore carries the 3-byte length prefix plus a
// declared length of at most MAX_EXTERNAL_FRAME (which already includes the
// ABYTES tag); ABYTES is added again and a small margin on top so the
// WebSocket limit never undercuts the guard. The memory bound per connection
// is therefore about MAX_EXTERNAL_FRAME, the same as the guard's.
const FRAME_PREFIX_BYTES = 3
const PAYLOAD_MARGIN_BYTES = 1024
const MAX_PAYLOAD = MAX_EXTERNAL_FRAME + FRAME_PREFIX_BYTES + secretStreamAbytes() + PAYLOAD_MARGIN_BYTES

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']

// host:port as it appears in a Host header (IPv6 literals bracketed).
function authority (host, port) {
  return (host.includes(':') ? '[' + host + ']' : host) + ':' + port
}

function isLoopback (host) {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

// The Host values that name this listener (lower case).
function allowedHosts (configured, address, port) {
  const hosts = new Set([authority(address, port).toLowerCase(), authority(configured, port).toLowerCase()])
  if (isLoopback(address) || isLoopback(configured)) {
    for (const name of LOOPBACK_NAMES) hosts.add(name + ':' + port)
  }
  return hosts
}

const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

// A TCP peer address on loopback: 127.0.0.0/8, ::1 or IPv4-mapped 127.x.
function isLoopbackAddress (address) {
  if (typeof address !== 'string') return false
  const s = address.toLowerCase()
  if (s === '::1') return true
  return LOOPBACK_V4_RE.test(s.startsWith('::ffff:') ? s.slice(7) : s)
}

// The client address handed to Seeder#acceptStream, which shares its
// external slots by address. Behind Caddy every WebSocket arrives from
// loopback and Caddy sets X-Forwarded-For to the address it saw
// (deploy/seeder/Caddyfile); the last entry is the one the nearest proxy
// wrote, so earlier entries a client sent never count. A direct connection,
// or a loopback one without the header, uses the TCP peer. Used only in
// memory: never logged, stored or exposed.
function clientAddress (req) {
  const remote = req && req.socket ? req.socket.remoteAddress : undefined
  if (typeof remote !== 'string') return null
  const forwarded = req.headers ? req.headers['x-forwarded-for'] : undefined
  if (isLoopbackAddress(remote) && typeof forwarded === 'string') {
    return forwarded.split(',').pop().trim()
  }
  return remote
}

// A loopback connection with no X-Forwarded-For did not come through the
// proxy, which always sets it: a process on this host, such as the account
// service's page links. The seeder never displaces its slot.
function isLocalClient (req) {
  const remote = req && req.socket ? req.socket.remoteAddress : undefined
  const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : undefined
  return isLoopbackAddress(remote) && forwarded === undefined
}

// Normalizes an exact origin of the allow-list ('http://127.0.0.1:8790').
function normalizeOrigin (origin) {
  const url = new URL(origin)
  return url.protocol + '//' + url.host
}

// Origin policy: no Origin header (non-browser client) is accepted; 'null'
// and unparsable origins are refused; otherwise the origin must be in the
// explicit allow-list or, without one, be http on a loopback hostname.
function originAllowed (origin, allowList) {
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (allowList) return allowList.has(url.protocol + '//' + url.host)
  return url.protocol === 'http:' && LOOPBACK_NAMES.includes(url.hostname)
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function send (res, code, body, extra = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...BASE_HEADERS,
    ...extra
  })
  res.end(body)
}

const NOT_FOUND = 'não encontrado\n'
const BUSY = 'ocupado\n'

// A global token bucket: rate tokens per second, at most burst stored.
function tokenBucket (rate, burst) {
  let tokens = burst
  let last = Date.now()
  return () => {
    const now = Date.now()
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

// Resolves on 'drain' or once the response is closed, whichever comes first.
function drained (res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

const CLOSED = Symbol('closed')

// Writes the blocks one at a time, waiting for 'drain' whenever the socket
// buffer is full. The iterator is driven by hand so that each next() races
// the response's close (client gone or deadline): a stalled read never keeps
// the stream waiting, and the iterator's return() is called at once without
// being awaited. Every next() and return() goes through track(), which keeps
// the in-flight slot held until it settles, so a stalled read still counts
// against MEDIA_MAX_IN_FLIGHT. More or fewer bytes than announced destroy
// the response, so a client never takes a short or overlong body for a
// complete one.
async function streamBlocks ({ res, blocks, bytes, closed, isClosed, track }) {
  let it
  try {
    it = blocks[Symbol.asyncIterator]()
  } catch {
    return res.destroy()
  }
  const cancel = () => {
    try {
      if (typeof it.return === 'function') track(it.return())
    } catch {}
  }
  let sent = 0
  while (true) {
    let step
    try {
      step = track(it.next())
    } catch {
      res.destroy()
      return cancel()
    }
    const result = await Promise.race([
      step.then((value) => ({ value }), () => null),
      closed
    ])
    if (result === CLOSED || isClosed()) return cancel()
    if (result === null || !result.value || typeof result.value !== 'object') {
      res.destroy()
      return cancel()
    }
    if (result.value.done) break
    const block = result.value.value
    if (!(block instanceof Uint8Array)) {
      res.destroy()
      return cancel()
    }
    sent += block.byteLength
    if (sent > bytes) {
      res.destroy()
      return cancel()
    }
    if (!res.write(block)) await drained(res)
    if (isClosed()) return cancel()
  }
  if (sent !== bytes) return res.destroy()
  res.end()
}

// Writes the refusal and then destroys the socket: end() alone only closes
// the writable half, and after 'upgrade' the socket is no longer covered by
// the HTTP server's timeouts, so a client that never closes its side would
// hold it (and a maxConnections slot) forever. The unref'd timer destroys it
// even if the response never finishes flushing.
function refuse (socket, code, reason) {
  const body = reason + '\n'
  const timer = setTimeout(() => socket.destroy(), REFUSE_GRACE_MS)
  timer.unref()
  socket.once('close', () => clearTimeout(timer))
  try {
    socket.end('HTTP/1.1 ' + code + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ' +
      Buffer.byteLength(body) + '\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n' + body,
    () => socket.destroy())
  } catch {
    socket.destroy()
  }
}

// Listens on host:port (port 0: the system picks one) and resolves
// { host, port, close() } once listening; a listen error rejects (EADDRINUSE
// carries its code). seeder is a Seeder (stats(), acceptStream()). origins:
// optional array of exact browser origins allowed to connect (default: http
// on a loopback hostname, any port). The seeder's mediaRead(diaryHex,
// coreHex, start, blocks) -> null | { bytes, blocks } backs /media. media:
// optional overrides of the /media limits ({ maxInFlight, rate, burst,
// deadlineMs }), for tests; index: the same for the /index limits
// ({ maxInFlight, rate, burst }). sockets: optional socket cap of the
// listener (see socketCap). The seeder's indexPost(authorHex, seq,
// cursor), indexRoda(authorHex, seq, cursor), indexCounts(refs), indexMember(authorHex, before), indexPageEnd(authorHex),
// indexSearch(segment), indexEngagers(kind, authorHex, seq, cursor), indexEvents(authorHex, before) and
// indexTestimonials(ownerHex) ->
// null | plain object back /index; indexSearch's
// object is { members: [{ author, profileSeq, usernameSeq, [page, closed, moved] }] (at most 20),
// more, indexing, complete }. The search segment shares the index bucket
// and in-flight cap and is never logged or echoed. triageToken: optional
// 64 lower-case hex secret that enables /moderation-post (absent, null or
// '' leaves it a 404; any other value throws), backed by the seeder's
// postBlock(diaryHex, seq) -> null | { fork, length, block0, block }; post:
// overrides of its limits ({ maxInFlight, rate, burst, deadlineMs }), for
// tests. publicOrigin: null or an https origin that enables the Feira
// routes, backed by indexFeira, indexFeiraAuthor, indexFeiraRatings,
// listingPublic(hex, seq), mediaRead and feiraRecent(limit); feiraLimits:
// overrides ({ photoMaxInFlight, photoDeadlineMs, sitemapMaxInFlight,
// listingMaxInFlight, listingRate, listingBurst }), for tests. postsOrigin:
// null or an https origin that turns on the public post pages, backed by
// postPublic(hex, seq) and mediaRead; postsLimits: overrides
// ({ pageMaxInFlight, pageRate, pageBurst, pageDeadlineMs, photoMaxInFlight,
// photoDeadlineMs, previewMaxInFlight, previewRate, previewBurst,
// previewDeadlineMs }), for tests. startHoldMs (default 0): while the
// seeder's status is 'starting', a /seeder upgrade that passed the host, path
// and origin checks is held up to this long (at most maxExternal at once) and
// accepted as soon as the seeder accepts streams, instead of a 503 at once.
// The resolved object also has drain(): closes every /seeder WebSocket with
// 1012 'reiniciando' (see below) before the seeder shuts down.
// The listener's socket cap: `sockets` when it is an integer >= 1
// (VARANDA_MAX_SOCKETS), else room for every external WebSocket, every
// /media and /index response in flight and 64 more for keep-alives and
// requests being refused (32 + 16 + 16 + 64 = MAX_SOCKETS by default), never
// below MAX_SOCKETS, so lowering one cap never shrinks the listener. The
// POST_MAX_IN_FLIGHT /moderation-post answers, the Feira photo and
// sitemap slots and the post page, preview and photo slots fit in those 64.
function socketCap ({ maxExternal, mediaInFlight, indexInFlight, sockets = null }) {
  if (Number.isInteger(sockets) && sockets >= 1) return sockets
  return Math.max(MAX_SOCKETS, maxExternal + mediaInFlight + indexInFlight + 64)
}

function startSeedWs ({ host = DEFAULT_HOST, port, seeder, origins = null, media = {}, index = {}, sockets = null, triageToken = null, post = {}, publicOrigin = null, feiraLimits = {}, postsOrigin = null, postsLimits = {}, startHoldMs = 0 }) {
  if (publicOrigin !== null && publicOrigin !== undefined && (typeof publicOrigin !== 'string' || !PUBLIC_ORIGIN_RE.test(publicOrigin))) {
    throw new TypeError('publicOrigin inválido')
  }
  if (postsOrigin !== null && postsOrigin !== undefined && (typeof postsOrigin !== 'string' || !PUBLIC_ORIGIN_RE.test(postsOrigin))) {
    throw new TypeError('postsOrigin inválido')
  }
  const origin = publicOrigin || null
  const postsOn = postsOrigin || null
  const postPageMaxInFlight = postsLimits.pageMaxInFlight ?? POST_PAGE_MAX_IN_FLIGHT
  const postPageDeadlineMs = postsLimits.pageDeadlineMs ?? POST_PAGE_DEADLINE_MS
  const takePostPageToken = tokenBucket(postsLimits.pageRate ?? POST_PAGE_RATE, postsLimits.pageBurst ?? POST_PAGE_BURST)
  const postPhotoMaxInFlight = postsLimits.photoMaxInFlight ?? POST_PHOTO_MAX_IN_FLIGHT
  const postPhotoDeadlineMs = postsLimits.photoDeadlineMs ?? POST_PHOTO_DEADLINE_MS
  const postPreviewMaxInFlight = postsLimits.previewMaxInFlight ?? POST_PREVIA_MAX_IN_FLIGHT
  const postPreviewDeadlineMs = postsLimits.previewDeadlineMs ?? POST_PREVIA_DEADLINE_MS
  const takePostPreviewToken = tokenBucket(postsLimits.previewRate ?? POST_PREVIA_RATE, postsLimits.previewBurst ?? POST_PREVIA_BURST)
  let postPageInFlight = 0
  let postPhotoInFlight = 0
  let postPreviewInFlight = 0
  const photoMaxInFlight = feiraLimits.photoMaxInFlight ?? FEIRA_PHOTO_MAX_IN_FLIGHT
  const photoDeadlineMs = feiraLimits.photoDeadlineMs ?? FEIRA_PHOTO_DEADLINE_MS
  const sitemapMaxInFlight = feiraLimits.sitemapMaxInFlight ?? FEIRA_SITEMAP_MAX_IN_FLIGHT
  let photoInFlight = 0
  let sitemapInFlight = 0
  if (triageToken !== null && triageToken !== undefined && triageToken !== '' &&
    (typeof triageToken !== 'string' || !TRIAGE_TOKEN_RE.test(triageToken))) {
    throw new TypeError('triageToken inválido') // never echoes the value
  }
  // Only the hash is kept; the comparison is between two fixed-length digests.
  const tokenHash = triageToken ? sha256(triageToken) : null
  const postMaxInFlight = post.maxInFlight ?? POST_MAX_IN_FLIGHT
  const postDeadlineMs = post.deadlineMs ?? POST_DEADLINE_MS
  const takePostToken = tokenBucket(post.rate ?? POST_RATE, post.burst ?? POST_BURST)
  let postInFlight = 0
  const feiraListingMaxInFlight = feiraLimits.listingMaxInFlight ?? FEIRA_LISTING_MAX_IN_FLIGHT
  const takeFeiraListingToken = tokenBucket(feiraLimits.listingRate ?? FEIRA_LISTING_RATE, feiraLimits.listingBurst ?? FEIRA_LISTING_BURST)
  let feiraListingInFlight = 0
  const allowList = origins ? new Set(origins.map(normalizeOrigin)) : null
  const maxInFlight = media.maxInFlight ?? MEDIA_MAX_IN_FLIGHT
  const deadlineMs = media.deadlineMs ?? MEDIA_DEADLINE_MS
  const takeToken = tokenBucket(media.rate ?? MEDIA_RATE, media.burst ?? MEDIA_BURST)
  let inFlight = 0
  const indexMaxInFlight = index.maxInFlight ?? INDEX_MAX_IN_FLIGHT
  const indexDeadlineMs = index.deadlineMs ?? INDEX_DEADLINE_MS
  const takeIndexToken = tokenBucket(index.rate ?? INDEX_RATE, index.burst ?? INDEX_BURST)
  let indexInFlight = 0

  // The index call for a matched /index URL, or null when the URL matches no
  // route: [method name, arguments]. Numbers are canonical decimals of at
  // most 15 digits, so Number() is exact.
  function indexCall (url) {
    let m = INDEX_POST_RE.exec(url)
    if (m) return ['indexPost', [m[1], Number(m[2]), m[3] === undefined ? null : m[3]]]
    m = INDEX_RODA_RE.exec(url)
    if (m) return ['indexRoda', [m[1], Number(m[2]), m[3] === undefined ? null : m[3]], rodaBody]
    m = INDEX_ENGAGERS_RE.exec(url)
    if (m) return ['indexEngagers', [m[1], m[2], Number(m[3]), m[4] === undefined ? null : m[4]]]
    m = INDEX_COUNTS_RE.exec(url)
    if (m) return ['indexCounts', [[...new Set(m[1].split(','))]]] // duplicates collapse: each ref costs one lookup
    m = INDEX_MEMBER_RE.exec(url)
    if (m) return ['indexMember', [m[1], m[2] === undefined ? null : Number(m[2])]]
    m = INDEX_PAGE_END_RE.exec(url)
    if (m) return ['indexPageEnd', [m[1]]]
    m = INDEX_SEARCH_RE.exec(url)
    if (m) return ['indexSearch', [m[1]]]
    m = INDEX_TOPIC_RE.exec(url)
    if (m) return ['indexTopic', [m[1], m[2] === undefined ? null : m[2]]]
    if (INDEX_TOPIC_TREND_RE.test(url)) return ['indexTopicTrend', [], topicTrendBody]
    m = INDEX_GROUP_RE.exec(url)
    if (m) return ['indexGroup', [m[1], m[2] === undefined ? null : m[2]], groupBody]
    m = INDEX_GROUPS_RE.exec(url)
    if (m) return ['indexGroups', [m[1]]]
    m = INDEX_GROUP_SEARCH_RE.exec(url)
    if (m) return ['indexGroupSearch', [m[1]], searchBody]
    m = INDEX_GROUP_BROWSE_RE.exec(url)
    if (m) return ['indexGroupBrowse', [m[1]], browseBody]
    m = INDEX_PUBLIC_GROUPS_RE.exec(url)
    if (m) return ['indexPublicGroups', [m[1], m[2] === undefined ? null : m[2]], publicGroupsBody]
    m = INDEX_COMMUNITY_RE.exec(url)
    if (m) return ['indexCommunity', [m[1]], communityBody]
    m = INDEX_COMMUNITY_GROUPS_RE.exec(url)
    if (m) return ['indexCommunityGroups', [m[1], m[2]], communityGroupsBody]
    m = INDEX_FOLLOW_COUNTS_RE.exec(url)
    if (m) return ['indexFollowCounts', [m[1]]]
    m = INDEX_FOLLOWS_RE.exec(url)
    if (m) return ['indexFollows', [m[1], m[2], m[3] === undefined ? null : m[3]]]
    m = INDEX_TESTIMONIALS_RE.exec(url)
    if (m) return ['indexTestimonials', [m[1]], testimonialsBody]
    m = INDEX_SCRAPS_RE.exec(url)
    // The atMs of a cursor fits 16 digits but must stay a safe integer.
    if (m && (m[2] === undefined || Number.isSafeInteger(Number(m[2].split('.')[0])))) return ['indexScraps', [m[1], m[2] === undefined ? null : m[2]], scrapsBody]
    if (m || INDEX_SCRAPS_BAD_RE.test(url)) return BAD_CURSOR
    m = INDEX_GARDEN_STREET_RE.exec(url)
    if (m) return ['indexGardenStreet', [m[1], m[2] === undefined ? null : m[2]], gardenStreetBody]
    m = INDEX_GARDEN_MIMOS_RE.exec(url)
    if (m) {
      const owner = m[1]
      return ['indexGardenStall', [owner], (answer) => mimosBody(answer, owner)]
    }
    m = INDEX_GARDEN_RE.exec(url)
    if (m) {
      const owner = m[1]
      return ['indexGarden', [owner], (answer) => gardenBody(answer, owner)]
    }
    if (INDEX_GARDEN_BAD_RE.test(url)) return BAD_CURSOR
    m = INDEX_PROFILE_RE.exec(url)
    if (m) return ['indexProfile', [m[1]], profileBody]
    m = INDEX_FOLLOW_RE.exec(url)
    if (m) return ['indexFollowSeq', [m[1], m[2]], followSeqBody]
    m = INDEX_FANS_RE.exec(url)
    if (m) return ['indexFans', [m[1], m[2] === undefined ? null : m[2]], fansBody]
    m = INDEX_POLL_RE.exec(url)
    if (m) return ['indexPoll', [m[1], Number(m[2])], pollBody]
    m = INDEX_POLL_VOTERS_RE.exec(url)
    if (m) return ['indexPollVoters', [m[1], Number(m[2]), Number(m[3]), m[4] === undefined ? null : m[4]], pollVotersBody]
    m = INDEX_EVENTS_RE.exec(url)
    if (m) return ['indexEvents', [m[1], m[2] === undefined ? null : Number(m[2])], eventsBody]
    // Without a public origin the Feira has no public surface at all.
    if (origin === null) return null
    m = INDEX_FEIRA_AUTHOR_RE.exec(url)
    if (m) return ['indexFeiraAuthor', [m[1], m[2] === undefined ? null : m[2]]]
    m = INDEX_FEIRA_RATINGS_RE.exec(url)
    if (m) return ['indexFeiraRatings', [m[1], m[2] === undefined ? null : m[2]], ratingsBody]
    m = INDEX_FEIRA_RE.exec(url)
    if (m && m[2].length >= FEIRA_CITY_MIN && m[2].length <= FEIRA_CITY_MAX && feira.isUf(m[1].toUpperCase())) {
      return ['indexFeira', [m[1].toUpperCase(), m[2], m[3], m[4], m[5] === undefined ? null : m[5], m[6] === undefined ? null : m[6]]]
    }
    return null
  }

  // A rating row names only the rater's block; the reader fetches and
  // verifies it.
  function ratingsBody ({ items, next, authors, indexing, complete }) {
    return { items: items.map(({ ref }) => ({ ref })), next, authors, indexing, complete }
  }

  // Only the pointer fields: an unexpected row or field is a 404 (throw),
  // never echoed.
  function testimonialsBody ({ shown, pending, indexing, complete }) {
    if (!Array.isArray(shown) || !Array.isArray(pending) || shown.length > TESTIMONIAL_ROWS_MAX || pending.length > TESTIMONIAL_ROWS_MAX) throw new Error('index')
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    return {
      shown: shown.map(({ seq, from, wseq }) => {
        if (!seqOk(seq) || !seqOk(wseq) || typeof from !== 'string' || !HEX64_RE.test(from)) throw new Error('index')
        return { seq, from, wseq }
      }),
      pending: pending.map(({ from, seq }) => {
        if (!seqOk(seq) || typeof from !== 'string' || !HEX64_RE.test(from)) throw new Error('index')
        return { from, seq }
      }),
      indexing: indexing === true,
      complete: complete === true
    }
  }

  // Only the pointer fields, checked as the client checks them: an
  // unexpected row, a duplicate or a cursor of another shape is a 404.
  function scrapsBody ({ scraps, hides, wall, next, indexing, complete }) {
    if (!Array.isArray(scraps) || !Array.isArray(hides) || scraps.length > SCRAP_ROWS_MAX || hides.length > SCRAP_HIDES_MAX) throw new Error('index')
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    if (wall !== null && !seqOk(wall)) throw new Error('index')
    if (next !== null && (typeof next !== 'string' || !SCRAP_CURSOR_RE.test(next))) throw new Error('index')
    const seen = new Set()
    return {
      scraps: scraps.map(({ author, seq, followSeq }) => {
        if (typeof author !== 'string' || !HEX64_RE.test(author) || !seqOk(seq) || (followSeq !== null && !seqOk(followSeq))) throw new Error('index')
        const ref = author + ':' + seq
        if (seen.has(ref)) throw new Error('index')
        seen.add(ref)
        return { author, seq, followSeq }
      }),
      hides: hides.map((seq) => {
        if (!seqOk(seq)) throw new Error('index')
        return seq
      }),
      wall,
      next,
      indexing: indexing === true,
      complete: complete === true
    }
  }

  // Exactly the Varandinha pointers, checked as the node checks them: a help
  // from the owner, a duplicate, an extra key or an oversized list is a 404,
  // never a trimmed answer.
  function gardenBody (answer, owner) {
    if (!exactKeys(answer, GARDEN_KEYS)) throw new Error('index')
    const { on, state, helps, given, indexing, complete } = answer
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    if ((on !== null && !seqOk(on)) || (state !== null && !seqOk(state))) throw new Error('index')
    if (!Array.isArray(helps) || helps.length > gardenRules.GARDEN_HELP_ROWS || !Array.isArray(given) || given.length > gardenRules.GARDEN_HELP_ROWS) throw new Error('index')
    const refs = new Set()
    const rows = helps.map((row) => {
      if (!exactKeys(row, GARDEN_HELP_KEYS)) throw new Error('index')
      const { author, seq, followSeq } = row
      if (typeof author !== 'string' || !HEX64_RE.test(author) || author === owner || !seqOk(seq) || !seqOk(followSeq)) throw new Error('index')
      const ref = author + ':' + seq
      if (refs.has(ref)) throw new Error('index')
      refs.add(ref)
      return { author, seq, followSeq }
    })
    const seqs = new Set()
    for (const seq of given) {
      if (!seqOk(seq) || seqs.has(seq)) throw new Error('index')
      seqs.add(seq)
    }
    if (typeof indexing !== 'boolean' || typeof complete !== 'boolean') throw new Error('index')
    return { on, state, helps: rows, given: [...given], indexing, complete }
  }

  // Exactly one page of Varandas da rua: a duplicate key, an extra key or an
  // oversized page is a 404.
  function gardenStreetBody (answer) {
    if (!exactKeys(answer, GARDEN_STREET_KEYS)) throw new Error('index')
    const { items, next, indexing, complete } = answer
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    if (!Array.isArray(items) || items.length > gardenRules.GARDEN_STREET_PAGE) throw new Error('index')
    const keys = new Set()
    const rows = items.map((item) => {
      if (!exactKeys(item, GARDEN_STREET_ITEM_KEYS)) throw new Error('index')
      const { key, on, state } = item
      if (typeof key !== 'string' || !HEX64_RE.test(key) || keys.has(key) || !seqOk(on) || (state !== null && !seqOk(state))) throw new Error('index')
      keys.add(key)
      return { key, on, state }
    })
    if (next !== null && (typeof next !== 'string' || !HEX64_RE.test(next))) throw new Error('index')
    if (typeof indexing !== 'boolean' || typeof complete !== 'boolean') throw new Error('index')
    return { items: rows, next, indexing, complete }
  }

  // Exactly the Barraquinha and Enfeites pointers, checked as the node checks
  // them: a row naming the owner, a duplicate, an extra key or an oversized
  // list is a 404, never a trimmed answer.
  function mimosBody (answer, owner) {
    if (!exactKeys(answer, GARDEN_MIMOS_KEYS)) throw new Error('index')
    const { decor, pending, shelf, indexing, complete } = answer
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    if (decor !== null && !seqOk(decor)) throw new Error('index')
    if (!Array.isArray(pending) || pending.length > gardenRules.GARDEN_GIFT_ROWS || !Array.isArray(shelf) || shelf.length > gardenRules.GARDEN_SHELF_ROWS) throw new Error('index')
    const refs = new Set()
    const gifts = pending.map((row) => {
      if (!exactKeys(row, GARDEN_MIMO_KEYS)) throw new Error('index')
      const { author, seq, followSeq } = row
      if (typeof author !== 'string' || !HEX64_RE.test(author) || author === owner || !seqOk(seq) || !seqOk(followSeq)) throw new Error('index')
      const ref = author + ':' + seq
      if (refs.has(ref)) throw new Error('index')
      refs.add(ref)
      return { author, seq, followSeq }
    })
    const seqs = new Set()
    const takes = shelf.map((row) => {
      if (!exactKeys(row, GARDEN_SHELF_KEYS)) throw new Error('index')
      const { from, gseq, seq } = row
      if (typeof from !== 'string' || !HEX64_RE.test(from) || from === owner || !seqOk(gseq) || !seqOk(seq) || seqs.has(seq)) throw new Error('index')
      seqs.add(seq)
      return { seq, from, gseq }
    })
    if (typeof indexing !== 'boolean' || typeof complete !== 'boolean') throw new Error('index')
    return { decor, pending: gifts, shelf: takes, indexing, complete }
  }

  // The pointer keys known so far; a new key is added here when its feature
  // ships, an unknown one is never echoed.
  function profileBody ({ about, mood, fans = null, top = null, visits = null, garden = null, indexing, complete }) {
    const seqOk = (n) => n === null || (Number.isSafeInteger(n) && n >= 1)
    if (!seqOk(about) || !seqOk(mood) || !seqOk(visits) || !seqOk(garden)) throw new Error('index')
    let fanCount = null
    if (fans !== null) {
      if (typeof fans !== 'object' || !Number.isSafeInteger(fans.count) || fans.count < 0) throw new Error('index')
      fanCount = { count: fans.count, indexing: fans.indexing === true }
    }
    let pointers = null
    if (top !== null) {
      if (typeof top !== 'object' || !Number.isSafeInteger(top.seq) || top.seq < 1 || top.back === null || typeof top.back !== 'object') throw new Error('index')
      const keys = Object.keys(top.back)
      if (keys.length > TOP_FRIENDS_MAX) throw new Error('index')
      const back = {}
      for (const key of keys) {
        if (!HEX64_RE.test(key) || !seqOk(top.back[key])) throw new Error('index')
        back[key] = top.back[key]
      }
      pointers = { seq: top.seq, back }
    }
    return { about, mood, fans: fanCount, top: pointers, visits, garden, indexing: indexing === true, complete: complete === true }
  }

  // Only the follower-list fields, checked as the client checks them: a
  // malformed row, a duplicate key or the author itself is a 404.
  function fansBody ({ author, items, next, total, authors, indexing, complete }) {
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    const hintOk = (n) => n === null || seqOk(n)
    if (typeof author !== 'string' || !HEX64_RE.test(author) || !Array.isArray(items) || items.length > FAN_ROWS_MAX) throw new Error('index')
    if (!Number.isSafeInteger(total) || total < items.length || authors === null || typeof authors !== 'object') throw new Error('index')
    const seen = new Set()
    const rows = items.map(({ key, seq, at }) => {
      if (typeof key !== 'string' || !HEX64_RE.test(key) || key === author || seen.has(key) || !seqOk(seq) || typeof at !== 'string' || at.length > 32) throw new Error('index')
      seen.add(key)
      return { key, seq, at }
    })
    const hints = {}
    for (const key of seen) {
      const h = authors[key]
      if (h === null || typeof h !== 'object' || !hintOk(h.profileSeq) || !hintOk(h.usernameSeq)) throw new Error('index')
      hints[key] = { profileSeq: h.profileSeq, usernameSeq: h.usernameSeq }
    }
    let cursor = null
    if (next !== null) {
      if (typeof next !== 'object' || !Number.isSafeInteger(next.atMs) || next.atMs < 0 || typeof next.key !== 'string' || !HEX64_RE.test(next.key)) throw new Error('index')
      cursor = { atMs: next.atMs, key: next.key }
    }
    return { author, items: rows, next: cursor, total, authors: hints, indexing: indexing === true, complete: complete === true }
  }

  // Claimed totals: at most POLL_OPTIONS_MAX non-negative integers.
  function pollBody ({ totals, indexing, complete }) {
    if (!Array.isArray(totals) || totals.length > POLL_OPTIONS_MAX) throw new Error('index')
    const counts = totals.map((n) => {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('index')
      return n
    })
    return { totals: counts, indexing: indexing === true, complete: complete === true }
  }

  // The voter rows of one pick, checked as the client checks them: a
  // malformed row or a duplicate key is a 404.
  function pollVotersBody ({ items, next, total, authors, indexing, complete }) {
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    const hintOk = (n) => n === null || seqOk(n)
    if (!Array.isArray(items) || items.length > FAN_ROWS_MAX) throw new Error('index')
    if (!Number.isSafeInteger(total) || total < items.length || authors === null || typeof authors !== 'object') throw new Error('index')
    const seen = new Set()
    const rows = items.map(({ key, seq, at }) => {
      if (typeof key !== 'string' || !HEX64_RE.test(key) || seen.has(key) || !seqOk(seq) || typeof at !== 'string' || at.length > 32) throw new Error('index')
      seen.add(key)
      return { key, seq, at }
    })
    const hints = {}
    for (const key of seen) {
      const h = authors[key]
      if (h === null || typeof h !== 'object' || !hintOk(h.profileSeq) || !hintOk(h.usernameSeq)) throw new Error('index')
      hints[key] = { profileSeq: h.profileSeq, usernameSeq: h.usernameSeq }
    }
    let cursor = null
    if (next !== null) {
      if (typeof next !== 'object' || !Number.isSafeInteger(next.atMs) || next.atMs < 0 || typeof next.key !== 'string' || !HEX64_RE.test(next.key)) throw new Error('index')
      cursor = { atMs: next.atMs, key: next.key }
    }
    return { items: rows, next: cursor, total, authors: hints, indexing: indexing === true, complete: complete === true }
  }

  // Event post pointers: strictly descending seqs, at most EVENT_ROWS_MAX,
  // and a cursor that is one of them; anything else is a 404.
  function eventsBody ({ posts, next, total, indexing, complete }) {
    const seqOk = (n) => Number.isSafeInteger(n) && n >= 1
    if (!Array.isArray(posts) || posts.length > EVENT_ROWS_MAX || !Number.isSafeInteger(total) || total < posts.length) throw new Error('index')
    let prev = Infinity
    const seqs = posts.map((seq) => {
      if (!seqOk(seq) || seq >= prev) throw new Error('index')
      prev = seq
      return seq
    })
    if (next !== null && (!seqOk(next) || seqs.length === 0 || next !== seqs[seqs.length - 1])) throw new Error('index')
    return { posts: seqs, next, total, indexing: indexing === true, complete: complete === true }
  }

  function followSeqBody ({ seq, indexing }) {
    if (seq !== null && !(Number.isSafeInteger(seq) && seq >= 1)) throw new Error('index')
    return { seq, indexing: indexing === true }
  }

  // The seeder's group answers flattened into the wire shape. The root
  // header is null until the root is served.
  function groupBody ({ header, rootServed, community, attached, writers, next, indexing, complete }) {
    const h = header || {}
    return {
      kind: h.kind ?? null,
      visibility: h.visibility ?? null,
      join: h.join ?? null,
      name: h.visibility === 'private' ? null : h.name ?? null,
      creator: h.diary ?? null,
      rootServed: rootServed === true,
      community: typeof community === 'string' && HEX64_RE.test(community) ? community : null,
      attached: attached === true,
      writers,
      next,
      indexing,
      complete
    }
  }

  function topicTrendBody ({ topics, indexing, complete }) {
    return {
      topics: topics.map(({ tag, authors }) => ({ tag, authors })),
      indexing,
      complete
    }
  }

  function searchBody ({ groups, more, indexing, complete }) {
    return {
      groups: groups.map(({ group, name, members }) => ({ group, name: name ?? null, writerCount: members })),
      more,
      indexing,
      complete
    }
  }

  // The discovery rows, rebuilt field by field: whatever else the seeder
  // keeps on a row never reaches the wire.
  function browseBody ({ groups, more, indexing, complete }) {
    return {
      groups: groups.map(({ group, name, creator, community, communityName, members, created, active }) =>
        ({ group, name, creator, community, communityName, writerCount: members, created: created ?? null, active: active ?? null })),
      more,
      indexing,
      complete
    }
  }

  // `hidden` true means the diary opted out: no row and no cursor leave,
  // whatever the seeder answered.
  function publicGroupsBody ({ groups, next, hidden, indexing, complete }) {
    if (hidden === true) return { groups: [], next: null, hidden: true, indexing, complete }
    return {
      groups: groups.map(({ group, name, creator, community, communityName, members }) =>
        ({ group, name, creator, community, communityName, writerCount: members })),
      next,
      hidden: false,
      indexing,
      complete
    }
  }

  // A private group's row carries no name and no count. `next` is the last
  // row's key or null: readers reject any other cursor.
  function communityRows (groups) {
    return groups.map(({ group, visibility, join, name, writerCount }) => visibility === 'private'
      ? { group, visibility: 'private', join, name: null, writerCount: null }
      : { group, visibility: 'public', join, name: name ?? null, writerCount })
  }

  function communityNext (next, rows) {
    return next !== null && rows.length > 0 && next === rows[rows.length - 1].group ? next : null
  }

  function communityBody ({ name, join, creator, members, groups, next, indexing, complete }) {
    const rows = communityRows(groups)
    return {
      name: name ?? null,
      join: join === 'open' || join === 'approval' ? join : null,
      creator: typeof creator === 'string' && HEX64_RE.test(creator) ? creator : null,
      members,
      groups: rows,
      next: communityNext(next, rows),
      indexing,
      complete
    }
  }

  function communityGroupsBody ({ groups, next, indexing, complete }) {
    const rows = communityRows(groups)
    return { groups: rows, next: communityNext(next, rows), indexing, complete }
  }

  // The roda route is new, so its answer can be checked key by key from the
  // start: anything unexpected (an extra key, a row too many, a wrong type)
  // is the generic 404, and the body is rebuilt from fresh objects so
  // nothing the seeder adds can leak.
  function rodaBody (answer) {
    if (!exactKeys(answer, RODA_KEYS)) throw new Error('index')
    const { ref, root, top, items, next, total, authors, indexing, complete } = answer
    if (!isIndexRef(ref) || !isIndexRef(root) || !isIndexRef(top)) throw new Error('index')
    if (!Array.isArray(items) || items.length > RODA_ROWS_MAX) throw new Error('index')
    const rows = items.map((item) => {
      if (!exactKeys(item, RODA_ITEM_KEYS)) throw new Error('index')
      const { ref, to } = item
      if (!isIndexRef(ref) || !isIndexRef(to)) throw new Error('index')
      return { ref, to }
    })
    // The cursor names the last row listed; readers page from it.
    if (next !== null) {
      const c = typeof next === 'string' ? INDEX_CURSOR_RE.exec(next) : null
      if (c === null || rows.length === 0 || rows[rows.length - 1].ref !== c[1] + ':' + c[2]) throw new Error('index')
    }
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('index')
    if (!isPlainObject(authors)) throw new Error('index')
    const keys = Object.keys(authors)
    if (keys.length > RODA_AUTHORS_MAX) throw new Error('index')
    const hints = {}
    for (const key of keys) {
      const h = authors[key]
      if (!HEX64_RE.test(key) || !exactKeys(h, RODA_HINT_KEYS)) throw new Error('index')
      const { profileSeq, usernameSeq } = h
      if (!isHintSeq(profileSeq) || !isHintSeq(usernameSeq)) throw new Error('index')
      hints[key] = { profileSeq, usernameSeq }
    }
    if (typeof indexing !== 'boolean' || typeof complete !== 'boolean') throw new Error('index')
    return { ref, root, top, items: rows, next, total, authors: hints, indexing, complete }
  }

  // A null or non-object answer, a missing method, a throw or a rejection,
  // and a body over INDEX_MAX_BODY (never, by construction) are all 404.
  // The in-flight slot is held until the response is CLOSED (finished or
  // torn down) and the seeder call has settled, as for /media, so a client
  // that stops draining cannot let later requests past the cap; a response
  // still open after indexDeadlineMs is destroyed.
  async function serveIndex (req, res, call) {
    // The account service's group checks (Bearer triage token, verified as
    // for the moderation routes) use the moderation budget, so a public
    // flood of /index cannot starve them; a missing or wrong token is just a
    // public request. Same answer either way.
    const triage = tokenHash !== null && (call[0] === 'indexGroup' || call[0] === 'indexGroups') && triageAuthorized(req)
    if (triage) {
      if (!takePostToken() || postInFlight >= postMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
      postInFlight++
    } else {
      if (!takeIndexToken() || indexInFlight >= indexMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
      indexInFlight++
    }
    let resClosed = false
    let pending = true
    let released = false
    const release = () => {
      if (released || !resClosed || pending) return
      released = true
      if (triage) postInFlight--
      else indexInFlight--
    }
    const timer = setTimeout(() => res.destroy(), indexDeadlineMs)
    timer.unref()
    const closed = new Promise((resolve) => res.once('close', () => {
      resClosed = true
      clearTimeout(timer)
      release()
      resolve(CLOSED)
    }))
    const settled = () => {
      pending = false
      release()
    }
    let body = null
    try {
      const [name, args, shape] = call
      if (typeof seeder[name] === 'function') {
        // The slot follows the call's OWN settlement, not the race below: a
        // response destroyed at the deadline frees nothing while the seeder
        // is still working on it.
        const work = Promise.resolve().then(() => seeder[name](...args))
        work.then(settled, settled)
        const answer = await Promise.race([work, closed])
        if (answer !== CLOSED && answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
          const text = JSON.stringify(shape ? await shape(answer) : answer) + '\n'
          if (Buffer.byteLength(text) <= INDEX_MAX_BODY) body = text
        }
      } else {
        settled()
      }
    } catch {
      body = null
    }
    if (resClosed || res.destroyed || res.writableEnded) return
    if (body === null) return send(res, 404, NOT_FOUND)
    res.writeHead(200, { ...INDEX_HEADERS, 'Content-Length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // Constant-time check of `Authorization: Bearer <token>`: a missing or
  // malformed header compares the digest of '' instead, so every request
  // costs the same and nothing short-circuits on length.
  function triageAuthorized (req) {
    const header = req.headers.authorization
    const given = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    return nodeCrypto.timingSafeEqual(sha256(given), tokenHash)
  }

  // The answer of postBlock as the response body, or null (-> 404) when it
  // is not exactly the expected shape or would exceed POST_MAX_BODY.
  function postBody (answer) {
    if (answer === null || typeof answer !== 'object' || answer.fork !== 0) return null
    if (!Number.isSafeInteger(answer.length) || answer.length < 1) return null
    if (!(answer.block0 instanceof Uint8Array) || !(answer.block instanceof Uint8Array)) return null
    // Refuse oversized blocks BEFORE encoding: the seeder stores whatever a
    // custom client appended (only appendRecord caps a block), and base64 +
    // JSON.stringify of megabytes would run synchronously on this process.
    // Base64 grows 4/3, so raw bytes above 3/4 of the cap can never fit.
    if (answer.block0.byteLength + answer.block.byteLength > Math.floor(POST_MAX_BODY * 3 / 4)) return null
    const text = JSON.stringify({
      v: 1,
      fork: 0,
      length: answer.length,
      block0: Buffer.from(answer.block0.buffer, answer.block0.byteOffset, answer.block0.byteLength).toString('base64'),
      block: Buffer.from(answer.block.buffer, answer.block.byteOffset, answer.block.byteLength).toString('base64')
    }) + '\n'
    return Buffer.byteLength(text) <= POST_MAX_BODY ? text : null
  }

  // The answer of groupPostBlock as the response body, or null (-> 404) when
  // it is not exactly { group, diary, seq, texto, resposta } or would exceed
  // POST_MAX_BODY. JSON escapes the text; the account service renders it.
  function groupPostBody (answer) {
    if (answer === null || typeof answer !== 'object') return null
    // A sealed block of a private group: the structure only, never the
    // envelope (docs/protocol.md section 10, "Sealed reports").
    if (answer.sealed === true) {
      const { writer, diary, group, seq } = answer
      if (![writer, diary, group].every((k) => typeof k === 'string' && HEX64_RE.test(k))) return null
      if (!Number.isSafeInteger(seq) || seq < 1) return null
      return JSON.stringify({ sealed: true, writer, diary, group, seq }) + '\n'
    }
    const { group, diary, seq, texto, resposta } = answer
    if (typeof group !== 'string' || !HEX64_RE.test(group) || typeof diary !== 'string' || !HEX64_RE.test(diary)) return null
    if (!Number.isSafeInteger(seq) || seq < 1 || typeof texto !== 'string') return null
    let reply = null
    if (resposta !== null) {
      if (typeof resposta !== 'object' || typeof resposta.writer !== 'string' || !HEX64_RE.test(resposta.writer) ||
        !Number.isSafeInteger(resposta.seq) || resposta.seq < 0) return null
      reply = { writer: resposta.writer, seq: resposta.seq }
    }
    if (Buffer.byteLength(texto) > POST_MAX_BODY) return null
    const text = JSON.stringify({ group, diary, seq, texto, resposta: reply }) + '\n'
    return Buffer.byteLength(text) <= POST_MAX_BODY ? text : null
  }

  // Authentication runs before the budget, so callers without the token
  // cannot drain the account service's slots or tokens. The in-flight slot
  // is held until the response is closed AND postBlock has settled, as for
  // /index; a response still open after postDeadlineMs is destroyed.
  // `method` names the seeder call (postBlock or groupPostBlock), `toBody`
  // shapes its answer; the routes share the token and the 404, and all but
  // /feira-listing (`feiraBudget` true, its own bucket and cap) the budget.
  async function servePost (req, res, method, match, toBody, feiraBudget = false) {
    if (!triageAuthorized(req)) return send(res, 404, NOT_FOUND)
    if (feiraBudget) {
      if (!takeFeiraListingToken() || feiraListingInFlight >= feiraListingMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
      feiraListingInFlight++
    } else {
      if (!takePostToken() || postInFlight >= postMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
      postInFlight++
    }
    let resClosed = false
    let pending = true
    let released = false
    const release = () => {
      if (released || !resClosed || pending) return
      released = true
      if (feiraBudget) feiraListingInFlight--
      else postInFlight--
    }
    const timer = setTimeout(() => res.destroy(), postDeadlineMs)
    timer.unref()
    const closed = new Promise((resolve) => res.once('close', () => {
      resClosed = true
      clearTimeout(timer)
      release()
      resolve(CLOSED)
    }))
    const settled = () => {
      pending = false
      release()
    }
    let body = null
    try {
      if (typeof seeder[method] === 'function') {
        const work = Promise.resolve().then(() => seeder[method](match[1], Number(match[2])))
        work.then(settled, settled)
        const answer = await Promise.race([work, closed])
        if (answer !== CLOSED) body = toBody(answer)
      } else {
        settled()
      }
    } catch {
      body = null
    }
    if (resClosed || res.destroyed || res.writableEnded) return
    if (body === null) return send(res, 404, NOT_FOUND)
    res.writeHead(200, { ...INDEX_HEADERS, 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  // The current folded listing for the account service's report triage, so
  // a listing report is judged on what the author signed, not on the quote.
  function listingModBody (answer) {
    if (answer === null || typeof answer !== 'object' || answer.record === null || typeof answer.record !== 'object') return null
    const r = answer.record
    const place = r.place && typeof r.place === 'object' ? r.place : {}
    const text = JSON.stringify({
      title: typeof r.title === 'string' ? r.title : '',
      text: typeof r.text === 'string' ? r.text : '',
      priceLabel: feira.priceLabel(r.price, r.unit, r.kind),
      city: typeof place.city === 'string' ? place.city : '',
      uf: typeof place.uf === 'string' ? place.uf : '',
      kind: feira.isKind(r.kind) ? r.kind : null,
      status: feira.isStatus(answer.status) ? answer.status : null
    }) + '\n'
    return Buffer.byteLength(text) <= POST_MAX_BODY ? text : null
  }

  // The Feira entry's listing check: only whether listingPublic has a card.
  function feiraListingBody (answer) {
    if (answer === null || typeof answer !== 'object' || answer.record === null || typeof answer.record !== 'object') return null
    return '{"ok":true}\n'
  }

  // The listing's photo descriptors, at most four.
  function photosOf (record) {
    return Array.isArray(record.media) ? record.media.slice(0, 4) : []
  }

  function listingView (hex, seq, card) {
    const r = card.record
    const place = r.place && typeof r.place === 'object' ? r.place : {}
    const base = '/f/' + hex + '/' + seq
    return {
      title: r.title,
      text: r.text,
      priceLabel: feira.priceLabel(r.price, r.unit, r.kind),
      city: place.city,
      uf: place.uf,
      bairro: place.bairro,
      kind: r.kind,
      catLabel: Object.prototype.hasOwnProperty.call(FEIRA_CAT_LABELS, r.cat) ? FEIRA_CAT_LABELS[r.cat] : '',
      status: card.status,
      statusLabel: feira.statusLabel(card.status, r.kind),
      username: card.username,
      name: card.name,
      photoUrls: photosOf(r).map((_, i) => base + '/foto/' + (i + 1)),
      photoMimes: photosOf(r).map((d) => d && typeof d === 'object' && typeof d.mime === 'string' ? d.mime : ''),
      pageUrl: origin + base,
      enterUrl: origin + '/anuncio/' + hex + '/' + seq,
      appUrl: 'varanda:///anuncio/' + hex + '/' + seq
    }
  }

  // Runs `work` (which gets an isClosed probe) under a budget slot that is
  // released only once the response is closed AND the work has settled, as
  // for /index; a response still open after `deadline` is destroyed. The
  // answer is null when the response closed first.
  function slotted (res, deadline, onRelease, work) {
    let resClosed = false
    let pending = true
    let released = false
    const release = () => {
      if (released || !resClosed || pending) return
      released = true
      onRelease()
    }
    const timer = setTimeout(() => res.destroy(), deadline)
    timer.unref()
    const closed = new Promise((resolve) => res.once('close', () => {
      resClosed = true
      clearTimeout(timer)
      release()
      resolve(CLOSED)
    }))
    const settled = () => {
      pending = false
      release()
    }
    const job = Promise.resolve().then(() => work(() => resClosed))
    job.then(settled, settled)
    return Promise.race([job.catch(() => null), closed]).then((answer) => {
      if (answer === CLOSED || resClosed || res.destroyed || res.writableEnded) return CLOSED
      return answer
    })
  }

  function feiraNotFound (res, head) {
    const body = renderNotFound()
    res.writeHead(404, { ...FEIRA_PAGE_HEADERS, 'Content-Length': Buffer.byteLength(body) })
    res.end(head ? undefined : body)
  }

  async function serveFeiraPage (req, res, match) {
    if (!takeIndexToken() || indexInFlight >= indexMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    indexInFlight++
    const hex = match[1]
    const seq = Number(match[2])
    const answer = await slotted(res, indexDeadlineMs, () => { indexInFlight-- }, async () => {
      if (typeof seeder.listingPublic !== 'function') return null
      const card = await seeder.listingPublic(hex, seq)
      if (card === null || typeof card !== 'object' || card.record === null || typeof card.record !== 'object') return null
      const html = renderListingPage(listingView(hex, seq, card))
      if (typeof html !== 'string' || Buffer.byteLength(html) > FEIRA_PAGE_MAX_BODY) return null
      return { html, vendido: card.status === 'vendido' }
    })
    if (answer === CLOSED) return
    const head = req.method === 'HEAD'
    if (answer === null) return feiraNotFound(res, head)
    const extra = answer.vendido ? { 'X-Robots-Tag': 'noindex' } : {}
    res.writeHead(200, { ...FEIRA_PAGE_HEADERS, ...extra, 'Content-Length': Buffer.byteLength(answer.html) })
    res.end(head ? undefined : answer.html)
  }

  // The bytes of photo n of the CURRENT listing content, assembled from the
  // media core and checked against the descriptor (size, sha256) and the
  // declared mime (magic bytes), or null.
  async function photoBytes (hex, seq, n, isClosed) {
    if (typeof seeder.listingPublic !== 'function' || typeof seeder.mediaRead !== 'function') return null
    const card = await seeder.listingPublic(hex, seq)
    if (card === null || typeof card !== 'object' || card.record === null || typeof card.record !== 'object') return null
    return descriptorBytes(hex, photosOf(card.record)[n - 1], isClosed)
  }

  // The bytes of the still image descriptor `d` of diary `hex`, read through
  // mediaRead and checked against the descriptor (size, sha256) and the
  // declared mime (IMAGE_MAGIC), or null. Shared by the Feira and post photos.
  async function descriptorBytes (hex, d, isClosed) {
    if (typeof seeder.mediaRead !== 'function') return null
    if (!d || typeof d !== 'object' || !Object.prototype.hasOwnProperty.call(IMAGE_MAGIC, d.mime)) return null
    if (!Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > MEDIA_MAX_BLOCKS * MEDIA_BLOCK_BYTES) return null
    if (typeof d.sha256 !== 'string' || !HEX64_RE.test(d.sha256)) return null
    const read = await seeder.mediaRead(hex, d.core, d.start, d.blocks)
    if (!read || read.bytes !== d.bytes || !read.blocks || typeof read.blocks[Symbol.asyncIterator] !== 'function') return null
    const parts = []
    let total = 0
    const it = read.blocks[Symbol.asyncIterator]()
    try {
      while (true) {
        if (isClosed()) return null
        const step = await it.next()
        if (step.done) break
        if (!(step.value instanceof Uint8Array)) return null
        total += step.value.byteLength
        if (total > d.bytes) return null
        parts.push(step.value)
      }
    } finally {
      try {
        if (typeof it.return === 'function') it.return().catch(() => {})
      } catch {}
    }
    if (total !== d.bytes) return null
    const bytes = Buffer.concat(parts, total)
    if (sha256(bytes).toString('hex') !== d.sha256 || !IMAGE_MAGIC[d.mime](bytes)) return null
    return { bytes, mime: d.mime }
  }

  async function serveFeiraPhoto (req, res, match, n) {
    if (!takeToken() || photoInFlight >= photoMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    photoInFlight++
    const answer = await slotted(res, photoDeadlineMs, () => { photoInFlight-- },
      (isClosed) => photoBytes(match[1], Number(match[2]), n, isClosed))
    if (answer === CLOSED) return
    if (answer === null) return send(res, 404, NOT_FOUND)
    res.writeHead(200, {
      'Content-Type': answer.mime,
      'Content-Length': answer.bytes.byteLength,
      ...BASE_HEADERS,
      'Referrer-Policy': 'no-referrer'
    })
    res.end(req.method === 'HEAD' ? undefined : answer.bytes)
  }

  async function serveFeiraSitemap (req, res) {
    if (!takeIndexToken() || sitemapInFlight >= sitemapMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    sitemapInFlight++
    const answer = await slotted(res, indexDeadlineMs, () => { sitemapInFlight-- }, () => {
      const refs = typeof seeder.feiraRecent === 'function' ? seeder.feiraRecent(FEIRA_SITEMAP_LIMIT) : []
      const urls = []
      for (const ref of Array.isArray(refs) ? refs : []) {
        const m = typeof ref === 'string' ? /^([0-9a-f]{64}):([1-9][0-9]{0,14})$/.exec(ref) : null
        if (m) urls.push(origin + '/f/' + m[1] + '/' + m[2])
      }
      return renderSitemap(urls)
    })
    if (answer === CLOSED) return
    if (typeof answer !== 'string') return send(res, 404, NOT_FOUND)
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(answer),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=600'
    })
    res.end(req.method === 'HEAD' ? undefined : answer)
  }

  // GET|HEAD only, no query string; anything unmatched is the generic 404.
  function serveFeira (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
    const url = req.url
    if (FEIRA_SITEMAP_RE.test(url)) return serveFeiraSitemap(req, res)
    let m = FEIRA_PAGE_RE.exec(url)
    if (m) return serveFeiraPage(req, res, m)
    m = FEIRA_FOTO_RE.exec(url)
    if (m) return serveFeiraPhoto(req, res, m, Number(m[3]))
    m = FEIRA_CAPA_RE.exec(url)
    if (m) return serveFeiraPhoto(req, res, m, 1)
    return send(res, 404, NOT_FOUND)
  }

  // The one answer of every post page that shows nothing. Only the
  // regex-matched hex64 and digit string reach the Location, and no header
  // depends on why nothing is shown.
  function postAway (res, hex, digits) {
    res.writeHead(302, {
      Location: '/publicacao/' + hex + '/' + digits,
      'X-Robots-Tag': POST_ROBOTS,
      'Cache-Control': 'no-store',
      'Content-Length': 0
    })
    res.end()
  }

  // A usable postPublic answer: the shown post and the share that allows it.
  function shownPost (answer) {
    if (answer === null || typeof answer !== 'object' || answer.record === null || typeof answer.record !== 'object') return null
    if (!Number.isSafeInteger(answer.shareSeq)) return null
    return answer
  }

  // The size of the share cover /capa may serve for a shown post, or null.
  // A seeder from before the cover answers no `cover`, and the page then
  // names the image it named before.
  function shownCover (shown) {
    if (!Number.isSafeInteger(shown.coverSeq) || !validShareCover(shown.cover)) return null
    return { width: shown.cover.width, height: shown.cover.height }
  }

  async function servePostPage (req, res, hex, digits) {
    if (postsOn === null || typeof seeder.postPublic !== 'function') return postAway(res, hex, digits)
    const seq = Number(digits)
    if (!CANONICAL_SEQ_RE.test(digits) || !Number.isSafeInteger(seq)) return postAway(res, hex, digits)
    if (!takePostPageToken() || postPageInFlight >= postPageMaxInFlight) return postAway(res, hex, digits)
    postPageInFlight++
    // The answer is due by the deadline (then the 302); the slot stays held
    // until the lookup settles, and a response still open at twice the
    // deadline (a client that never reads) is destroyed.
    let timer = null
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), postPageDeadlineMs)
      timer.unref()
    })
    const answer = await Promise.race([late, slotted(res, postPageDeadlineMs * 2, () => { postPageInFlight-- }, async () => {
      const shown = shownPost(await seeder.postPublic(hex, seq))
      if (shown === null) return null
      const html = renderPostPage({ origin: postsOn, author: hex, seq, record: shown.record, name: shown.name, username: shown.username, cover: shownCover(shown) })
      if (typeof html !== 'string' || Buffer.byteLength(html) > POST_PAGE_MAX_BODY) return null
      return html
    })])
    clearTimeout(timer)
    if (answer === CLOSED || res.destroyed || res.writableEnded || res.headersSent) return
    if (answer === null) return postAway(res, hex, digits)
    res.writeHead(200, {
      ...FEIRA_PAGE_HEADERS,
      'X-Robots-Tag': POST_ROBOTS,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(answer)
    })
    res.end(req.method === 'HEAD' ? undefined : answer)
  }

  // The one shape of every preview answer: only the body says whether a post
  // is shown, and every case that shows nothing has the same body.
  function previewAnswer (req, res, body) {
    res.writeHead(200, { ...POST_PREVIA_HEADERS, 'Content-Length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // The page's gate, deadline and slot rules with the preview's own budget.
  async function servePostPreview (req, res, hex, digits) {
    if (postsOn === null || typeof seeder.postPublic !== 'function') return previewAnswer(req, res, POST_PREVIA_NONE)
    const seq = Number(digits)
    if (!CANONICAL_SEQ_RE.test(digits) || !Number.isSafeInteger(seq)) return previewAnswer(req, res, POST_PREVIA_NONE)
    if (!takePostPreviewToken() || postPreviewInFlight >= postPreviewMaxInFlight) return previewAnswer(req, res, POST_PREVIA_NONE)
    postPreviewInFlight++
    let timer = null
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), postPreviewDeadlineMs)
      timer.unref()
    })
    const answer = await Promise.race([late, slotted(res, postPreviewDeadlineMs * 2, () => { postPreviewInFlight-- }, async () => {
      const shown = shownPost(await seeder.postPublic(hex, seq))
      if (shown === null) return null
      const data = postPreviewData({ record: shown.record, name: shown.name, username: shown.username })
      if (data === null) return null
      const body = JSON.stringify({ post: data })
      if (typeof body !== 'string' || Buffer.byteLength(body) > POST_PREVIA_MAX_BODY) return null
      return body
    })])
    clearTimeout(timer)
    if (answer === CLOSED || res.destroyed || res.writableEnded || res.headersSent) return
    previewAnswer(req, res, answer === null ? POST_PREVIA_NONE : answer)
  }

  // Photo n of what the page shows, its bytes checked, and only if the same
  // share still allows the post once they are read (a withdrawal or a delete
  // during the read then serves nothing); else null.
  async function postPhotoBytes (hex, seq, n, isClosed) {
    const shown = shownPost(await seeder.postPublic(hex, seq))
    if (shown === null) return null
    const got = await descriptorBytes(hex, postPhotos(shown.record).items[n - 1], isClosed)
    if (got === null || isClosed()) return null
    const again = shownPost(await seeder.postPublic(hex, seq))
    if (again === null || again.shareSeq !== shown.shareSeq) return null
    return got
  }

  // The share cover of what the page shows, read like a photo and held to
  // validShareCover first (so at most MAX_SHARE_COVER_BYTES are read).
  // descriptorBytes checks size, hash and magic only, so the JPEG frame size
  // is checked here against the descriptor, which is what og:image:width and
  // og:image:height named. Served only if the same share AND the same cover
  // still stand once the bytes are read; else null.
  async function postCoverBytes (hex, seq, isClosed) {
    const shown = shownPost(await seeder.postPublic(hex, seq))
    if (shown === null || shownCover(shown) === null) return null
    const got = await descriptorBytes(hex, shown.cover, isClosed)
    if (got === null || isClosed() || got.mime !== 'image/jpeg') return null
    const size = stillImageSize(got.bytes, 'image/jpeg')
    if (size === null || size.width !== shown.cover.width || size.height !== shown.cover.height) return null
    const again = shownPost(await seeder.postPublic(hex, seq))
    if (again === null || again.shareSeq !== shown.shareSeq || again.coverSeq !== shown.coverSeq) return null
    return got
  }

  // A photo or the cover: `read(isClosed)` is postPhotoBytes or
  // postCoverBytes, under the same gate, bucket, slot and headers.
  async function servePostPhoto (req, res, hex, seq, read) {
    if (postsOn === null || typeof seeder.postPublic !== 'function' || !Number.isSafeInteger(seq)) return send(res, 404, NOT_FOUND)
    if (!takeToken() || postPhotoInFlight >= postPhotoMaxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    postPhotoInFlight++
    const answer = await slotted(res, postPhotoDeadlineMs, () => { postPhotoInFlight-- }, read)
    if (answer === CLOSED) return
    if (answer === null) return send(res, 404, NOT_FOUND)
    res.writeHead(200, {
      'Content-Type': answer.mime,
      'Content-Length': answer.bytes.byteLength,
      ...BASE_HEADERS,
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': POST_ROBOTS
    })
    res.end(req.method === 'HEAD' ? undefined : answer.bytes)
  }

  // Every path under /p/, whatever the switch says. The page matches the
  // path without its query, so a link a messenger decorated still lands; the
  // preview, the photos and the cover are no link anyone pastes, so they
  // match the whole URL.
  function servePosts (req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
    if (pathname === POST_POLICY) {
      const body = postsOn !== null ? '{"enabled":true}' : '{"enabled":false}'
      res.writeHead(200, { ...INDEX_HEADERS, 'Content-Length': Buffer.byteLength(body) })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    let m = POST_PAGE_RE.exec(pathname)
    if (m) return servePostPage(req, res, m[1], m[2])
    m = POST_PREVIA_RE.exec(req.url)
    if (m) return servePostPreview(req, res, m[1], m[2])
    m = POST_FOTO_RE.exec(req.url)
    if (m) {
      const [hex, seq, n] = [m[1], Number(m[2]), Number(m[3])]
      return servePostPhoto(req, res, hex, seq, (isClosed) => postPhotoBytes(hex, seq, n, isClosed))
    }
    m = POST_CAPA_RE.exec(req.url)
    if (m) {
      const [hex, seq] = [m[1], Number(m[2])]
      return servePostPhoto(req, res, hex, seq, (isClosed) => postCoverBytes(hex, seq, isClosed))
    }
    return send(res, 404, NOT_FOUND)
  }

  async function serveMedia (req, res, match) {
    const start = Number(match[3])
    const count = Number(match[4])
    if (!Number.isSafeInteger(start) || count > MEDIA_MAX_BLOCKS) return send(res, 404, NOT_FOUND)
    if (!takeToken() || inFlight >= maxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    // The slot is released once the response is closed AND every seeder
    // call it started (mediaRead, next(), return()) has settled.
    inFlight++
    let resClosed = false
    let pending = 0
    let released = false
    const release = () => {
      if (released || !resClosed || pending > 0) return
      released = true
      inFlight--
    }
    const track = (value) => {
      const promise = Promise.resolve(value)
      pending++
      promise.then(() => {}, () => {}).then(() => {
        pending--
        release()
      })
      return promise
    }
    const timer = setTimeout(() => res.destroy(), deadlineMs)
    timer.unref()
    const closed = new Promise((resolve) => res.once('close', () => {
      resClosed = true
      clearTimeout(timer)
      release()
      resolve(CLOSED)
    }))
    const isClosed = () => resClosed
    let read = null
    try {
      if (typeof seeder.mediaRead === 'function') {
        read = await Promise.race([track(seeder.mediaRead(match[1], match[2], start, count)), closed])
      }
    } catch {
      read = null
    }
    if (read === CLOSED || resClosed) return
    if (!read || !Number.isSafeInteger(read.bytes) || read.bytes < 0 || !read.blocks ||
      typeof read.blocks[Symbol.asyncIterator] !== 'function') {
      return send(res, 404, NOT_FOUND)
    }
    res.writeHead(200, { ...MEDIA_HEADERS, 'Content-Length': read.bytes })
    if (req.method === 'HEAD') return res.end()
    // Headers go out now, not with the first block, which may take a while.
    res.flushHeaders()
    await streamBlocks({ res, blocks: read.blocks, bytes: read.bytes, closed, isClosed, track })
  }
  // Synchronous read, but the slot is held until the response closes, as
  // for /media, so slow readers count against the shared cap.
  function serveBlob (req, res, match) {
    if (!takeToken() || inFlight >= maxInFlight) return send(res, 503, BUSY, { 'Retry-After': '1' })
    inFlight++
    let released = false
    const timer = setTimeout(() => res.destroy(), deadlineMs)
    timer.unref()
    res.once('close', () => {
      clearTimeout(timer)
      if (released) return
      released = true
      inFlight--
    })
    let frame = null
    try {
      if (typeof seeder.blobChunk === 'function') frame = seeder.blobChunk(match[1], Number(match[2]))
    } catch {
      frame = null
    }
    if (!(frame instanceof Uint8Array) || frame.byteLength === 0) return send(res, 404, NOT_FOUND)
    res.writeHead(200, { ...BLOB_HEADERS, 'Content-Length': frame.byteLength })
    if (req.method === 'HEAD') return res.end()
    res.end(frame)
  }

  // Filled once listening (port 0 case); no request arrives before that.
  let hosts = new Set()
  const hostOk = (req) => typeof req.headers.host === 'string' && hosts.has(req.headers.host.toLowerCase())

  // headersTimeout is only enforced when Node's connection check runs
  // (connectionsCheckingInterval, 30 s by default): check every second so an
  // incomplete request holds a slot for about HEADERS_TIMEOUT_MS, not 30 s.
  const server = http.createServer({ connectionsCheckingInterval: CHECK_INTERVAL_MS }, (req, res) => {
    req.resume()
    if (!hostOk(req)) {
      res.setHeader('Connection', 'close')
      return send(res, 421, 'host inválido\n')
    }
    const pathname = req.url.split('?')[0]
    if (pathname === PATH) return send(res, 426, 'atualização de protocolo necessária\n')
    if (pathname === MEDIA_PREFIX || pathname.startsWith(MEDIA_PREFIX + '/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
      const match = MEDIA_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return serveMedia(req, res, match).catch(() => res.destroy())
    }
    if (pathname === BLOB_PREFIX || pathname.startsWith(BLOB_PREFIX + '/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
      const match = req.url.includes('?') ? null : BLOB_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      try {
        return serveBlob(req, res, match)
      } catch {
        return res.destroy()
      }
    }
    if (pathname === INDEX_PREFIX || pathname.startsWith(INDEX_PREFIX + '/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'método não permitido\n', { Allow: 'GET, HEAD' })
      const call = indexCall(req.url)
      if (call === null) return send(res, 404, NOT_FOUND)
      if (call === BAD_CURSOR) return send(res, 400, BAD_REQUEST)
      return serveIndex(req, res, call).catch(() => res.destroy())
    }
    // Without a token this branch does not exist: the path falls through to
    // the generic 404 below and no header is read.
    if (tokenHash !== null && (pathname === POST_PREFIX || pathname.startsWith(POST_PREFIX + '/'))) {
      if (req.method !== 'GET') return send(res, 405, 'método não permitido\n', { Allow: 'GET' })
      const match = POST_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return servePost(req, res, 'postBlock', match, postBody).catch(() => res.destroy())
    }
    if (tokenHash !== null && (pathname === GROUP_POST_PREFIX || pathname.startsWith(GROUP_POST_PREFIX + '/'))) {
      if (req.method !== 'GET') return send(res, 405, 'método não permitido\n', { Allow: 'GET' })
      const match = GROUP_POST_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return servePost(req, res, 'groupPostBlock', match, groupPostBody).catch(() => res.destroy())
    }
    if (tokenHash !== null && (pathname === LISTING_MOD_PREFIX || pathname.startsWith(LISTING_MOD_PREFIX + '/'))) {
      if (req.method !== 'GET') return send(res, 405, 'método não permitido\n', { Allow: 'GET' })
      const match = LISTING_MOD_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return servePost(req, res, 'listingPublic', match, listingModBody).catch(() => res.destroy())
    }
    if (tokenHash !== null && (pathname === FEIRA_LISTING_PREFIX || pathname.startsWith(FEIRA_LISTING_PREFIX + '/'))) {
      if (req.method !== 'GET') return send(res, 405, 'método não permitido\n', { Allow: 'GET' })
      const match = FEIRA_LISTING_RE.exec(req.url)
      if (!match) return send(res, 404, NOT_FOUND)
      return servePost(req, res, 'listingPublic', match, feiraListingBody, true).catch(() => res.destroy())
    }
    // Without a public origin the Feira pages do not exist.
    if (origin !== null && pathname.startsWith(FEIRA_PREFIX + '/')) {
      return Promise.resolve().then(() => serveFeira(req, res)).catch(() => res.destroy())
    }
    if (pathname === POSTS_PREFIX || pathname.startsWith(POSTS_PREFIX + '/')) {
      return Promise.resolve().then(() => servePosts(req, res, pathname)).catch(() => res.destroy())
    }
    send(res, 404, NOT_FOUND)
  })
  const maxExternal = Number.isInteger(seeder.maxExternal) && seeder.maxExternal >= 1 ? seeder.maxExternal : 32
  server.maxConnections = socketCap({ maxExternal, mediaInFlight: maxInFlight, indexInFlight: indexMaxInFlight, sockets })
  server.headersTimeout = HEADERS_TIMEOUT_MS

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })

  // Sockets between the 'upgrade' event and either their hand-off to ws
  // (then tracked by wss.clients) or their destruction; close() destroys them.
  const upgrading = new Set()
  // Upgrades held while the seeder starts (a subset of upgrading), each with
  // its check timer; at most maxExternal at once.
  const held = new Map()
  // The stream handed to the seeder for each open /seeder WebSocket, so
  // drain() can stop the seeder writing to it.
  const streams = new Map()
  let closing = null
  let draining = null

  // Whether the seeder takes a stream now: accepting() when the seeder has
  // it (it accepts before its status turns 'ok'), else the status as before.
  const ready = () => {
    try {
      if (typeof seeder.accepting === 'function') return seeder.accepting() === true
      return seeder.stats().status === 'ok'
    } catch {
      return false
    }
  }
  const starting = () => {
    try {
      return seeder.stats().status === 'starting'
    } catch {
      return false
    }
  }
  const release = (socket) => {
    const timer = held.get(socket)
    if (timer === undefined) return
    clearInterval(timer)
    held.delete(socket)
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (closing) return socket.destroy()
    upgrading.add(socket)
    socket.once('close', () => {
      upgrading.delete(socket)
      release(socket)
    })
    if (!hostOk(req)) return refuse(socket, '421 Misdirected Request', 'host inválido')
    if (req.url.split('?')[0] !== PATH) return refuse(socket, '404 Not Found', 'não encontrado')
    if (!originAllowed(req.headers.origin, allowList)) return refuse(socket, '403 Forbidden', 'origem não permitida')
    const unavailable = () => refuse(socket, '503 Service Unavailable', 'indisponível')
    if (draining) return unavailable()
    if (ready()) return accept(req, socket, head)
    if (startHoldMs <= 0 || held.size >= maxExternal || !starting()) return unavailable()
    // Held in upgrading, so close() and drain() destroy it like any other
    // socket mid-upgrade; its 'close' listener above clears the timer.
    const deadline = Date.now() + startHoldMs
    const timer = setInterval(() => {
      if (closing || draining || socket.destroyed) return release(socket)
      if (ready()) {
        release(socket)
        return accept(req, socket, head)
      }
      // starting() is not re-read on each tick: ready() reads accepting(),
      // which is cheap, and only a seeder without it falls back to stats(),
      // which walks every served core. A seeder that fails to start has the
      // listener closed by its caller.
      if (Date.now() >= deadline) {
        release(socket)
        unavailable()
      }
    }, HOLD_CHECK_MS)
    timer.unref()
    held.set(socket, timer)
  })

  function accept (req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgrading.delete(socket)
      ws.on('error', () => {})
      if (closing || draining) return ws.terminate()
      let duplex
      // Set when the seeder refuses for capacity: the socket is then ours to
      // close with 1013 (try again later) instead of the bare 1006 a
      // terminate() gives, so the client can tell "full" from a network loss.
      // Also called, with reason 'connection-displaced', for a socket the
      // seeder already took and later gave up to make room for another
      // address (Seeder#acceptStream): the client backs off the same way.
      let refused = false
      const onRefuse = () => {
        if (refused) return
        refused = true
        // The duplex must not be destroyed before the close frame is out:
        // createWebSocketStream's _destroy calls ws.terminate() while the
        // WebSocket is still open. Nothing destroys it here until ws emits
        // 'close' (the listener below), when terminate() is a no-op. The
        // unref'd timer bounds how long a client that never answers the close
        // can keep the socket (ws's own close timeout is 30 s).
        // A displaced socket may still be writing (keep-alives, replication):
        // as in drain(), its writes are dropped from here on, so none reaches
        // ws.send on the CLOSING socket, errors the duplex and turns the
        // 1013 into a 1006.
        if (duplex) duplex._write = dropWrite
        const timer = setTimeout(() => ws.terminate(), REFUSE_GRACE_MS)
        timer.unref()
        ws.once('close', () => clearTimeout(timer))
        try {
          ws.close(1013, 'lotado')
        } catch {
          ws.terminate()
        }
      }
      try {
        duplex = createWebSocketStream(ws)
        duplex.on('error', () => {})
        streams.set(ws, duplex)
        // A closed WebSocket only ends the duplex's readable side; destroy it
        // so the seeder releases the connection slot at once.
        ws.once('close', () => {
          streams.delete(ws)
          duplex.destroy()
        })
        Promise.resolve(seeder.acceptStream(duplex, { onRefuse, address: clientAddress(req), local: isLocalClient(req) })).then((noise) => {
          if (!noise && !refused) ws.terminate()
        }, () => { if (!refused) ws.terminate() })
      } catch {
        if (!refused) ws.terminate()
      }
    })
  }

  // Drops a write the seeder makes after drain() began, as if it had been
  // sent, so it never reaches ws.send on a CLOSING WebSocket.
  const dropWrite = (chunk, encoding, callback) => callback()

  // Stops accepting connections; the promise settles once every open one
  // has ended. Shared by drain() and close(): a second server.close() on a
  // closed server only reports ERR_SERVER_NOT_RUNNING on a later 'close'
  // event, which never comes once the first 'close' has been emitted.
  let stopped = null
  const stopListening = () => {
    if (!stopped) stopped = new Promise((resolve) => server.close(() => resolve()))
    return stopped
  }

  // Closes every /seeder WebSocket with 1012 (service restart) instead of the
  // bare 1006 seeder.close() would give, so a client can tell a restart from
  // a network loss. Resolves once they are all closed, or after
  // REFUSE_GRACE_MS, terminating the ones whose client never answered.
  const drain = () => {
    if (draining) return draining
    if (closing) return closing
    // The port stops listening first, so the client's quick redial after the
    // 1012 meets a refused dial, which Caddy holds and retries for up to 5 s,
    // instead of a 503 for the whole of seeder.close(),
    // which Caddy passes on. /media, /blob and the other HTTP routes share
    // this port and are refused too from here on: the seeder is going away,
    // and Caddy answers 502 once its retry runs out.
    // Connections already open (the WebSockets below) are left to finish.
    stopListening()
    draining = new Promise((resolve) => {
      for (const socket of upgrading) socket.destroy()
      upgrading.clear()
      for (const socket of [...held.keys()]) release(socket)
      const open = []
      for (const ws of wss.clients) {
        if (ws.readyState === ws.CLOSED) continue
        open.push(ws)
        if (ws.readyState !== ws.OPEN) continue // already closing (a 1013): its own timer ends it
        // Same order as the 1013 path. The seeder's writes are cut off
        // first: a write after close() would make ws.send fail on the
        // CLOSING socket, the duplex would error and destroy itself, and
        // createWebSocketStream's _destroy terminates an unclosed WebSocket,
        // turning the 1012 back into a 1006. With _write dropped, nothing
        // destroys the duplex until ws emits 'close' (the listener in
        // accept()), when terminate() is a no-op. A write already handed to
        // ws.send went out on the socket before the close frame.
        const duplex = streams.get(ws)
        if (duplex) duplex._write = dropWrite
        try {
          ws.close(1012, 'reiniciando')
        } catch {
          ws.terminate()
        }
      }
      const gone = open.map((ws) => ws.readyState === ws.CLOSED ? null : new Promise((resolve) => ws.once('close', resolve)))
      const timer = setTimeout(() => {
        for (const ws of open) ws.terminate()
      }, REFUSE_GRACE_MS)
      timer.unref()
      Promise.all(gone).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    return draining
  }

  const close = () => {
    if (closing) return closing
    closing = new Promise((resolve) => {
      stopListening().then(resolve)
      for (const socket of upgrading) socket.destroy()
      upgrading.clear()
      for (const socket of [...held.keys()]) release(socket)
      for (const ws of wss.clients) ws.terminate()
      server.closeAllConnections()
    })
    return closing
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', () => {})
      const address = server.address()
      hosts = allowedHosts(host, address.address, address.port)
      resolve({ host: address.address, port: address.port, close, drain })
    })
  })
}

module.exports = {
  startSeedWs,
  socketCap,
  clientAddress,
  isLocalClient,
  DEFAULT_HOST,
  MAX_SOCKETS,
  MAX_PAYLOAD,
  MEDIA_MAX_BLOCKS,
  MEDIA_MAX_IN_FLIGHT,
  MEDIA_RATE,
  MEDIA_BURST,
  MEDIA_DEADLINE_MS,
  BLOB_RE,
  INDEX_POST_RE,
  INDEX_RODA_RE,
  INDEX_COUNTS_RE,
  INDEX_MEMBER_RE,
  INDEX_SEARCH_RE,
  INDEX_TOPIC_RE,
  INDEX_TOPIC_TREND_RE,
  INDEX_GROUP_RE,
  INDEX_GROUPS_RE,
  INDEX_GROUP_SEARCH_RE,
  INDEX_GROUP_BROWSE_RE,
  INDEX_PUBLIC_GROUPS_RE,
  INDEX_COMMUNITY_RE,
  INDEX_COMMUNITY_GROUPS_RE,
  INDEX_ENGAGERS_RE,
  INDEX_FOLLOW_COUNTS_RE,
  INDEX_FOLLOWS_RE,
  INDEX_TESTIMONIALS_RE,
  INDEX_SCRAPS_RE,
  INDEX_GARDEN_RE,
  INDEX_GARDEN_STREET_RE,
  INDEX_GARDEN_MIMOS_RE,
  INDEX_PROFILE_RE,
  INDEX_FANS_RE,
  INDEX_POLL_RE,
  INDEX_POLL_VOTERS_RE,
  INDEX_EVENTS_RE,
  INDEX_FOLLOW_RE,
  INDEX_FEIRA_RE,
  INDEX_FEIRA_AUTHOR_RE,
  INDEX_FEIRA_RATINGS_RE,
  FEIRA_PAGE_RE,
  FEIRA_FOTO_RE,
  FEIRA_CAPA_RE,
  FEIRA_SITEMAP_RE,
  FEIRA_PHOTO_MAX_IN_FLIGHT,
  FEIRA_PHOTO_DEADLINE_MS,
  FEIRA_SITEMAP_MAX_IN_FLIGHT,
  POST_POLICY,
  POST_PAGE_RE,
  POST_FOTO_RE,
  POST_CAPA_RE,
  POST_PAGE_MAX_IN_FLIGHT,
  POST_PAGE_RATE,
  POST_PAGE_BURST,
  POST_PAGE_DEADLINE_MS,
  POST_PHOTO_MAX_IN_FLIGHT,
  POST_PHOTO_DEADLINE_MS,
  POST_PREVIA_RE,
  POST_PREVIA_MAX_IN_FLIGHT,
  POST_PREVIA_RATE,
  POST_PREVIA_BURST,
  POST_PREVIA_DEADLINE_MS,
  LISTING_MOD_RE,
  FEIRA_LISTING_RE,
  FEIRA_LISTING_MAX_IN_FLIGHT,
  FEIRA_LISTING_RATE,
  FEIRA_LISTING_BURST,
  INDEX_MAX_REFS,
  INDEX_MAX_IN_FLIGHT,
  INDEX_RATE,
  INDEX_BURST,
  INDEX_DEADLINE_MS,
  INDEX_MAX_BODY,
  POST_RE,
  POST_MAX_IN_FLIGHT,
  POST_RATE,
  POST_BURST,
  POST_DEADLINE_MS,
  POST_MAX_BODY,
  GROUP_POST_RE
}
