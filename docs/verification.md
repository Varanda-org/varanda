# varanda — end-to-end verification

Date: 2026-10-22 (sections 1 to 5) and 2026-10-23 (section 6, the public DHT; section 7, the new app design on iOS). Every check below was run on one Mac. Logs and screenshots stayed in the verification sessions' scratchpads (not committed).

## Machine

| Item | Version |
|---|---|
| macOS | 15.7.3 (24G419) |
| Xcode | 26.2 (17C52) |
| CocoaPods | 1.16.2 |
| Simulator | iPhone 17 Pro, iOS 26.2 |
| Node.js | v26.10.0 |
| npm | 11.19.1 |

## 1. Clean baseline

| Command (repo root) | Outcome |
|---|---|
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 (`standard`, no findings) |
| `npm test` | exit 0: `packages/core` 7 files, `packages/rpc` 8 files, `apps/cli` 14 files, 0 failures, no `not ok` line |
| `npm run demo` | exit 0, `DEMO OK` |
| `node bin/varanda.js help` | exit 0; byte-identical (`cmp`, same SHA-1) to the README "Ajuda" fence |
| `node bin/varanda-serve.js --help` | exit 0; prints the option list |

## 2. iOS gate on the final code

Run after `npm ci` on the current client (recover defaults to true; an IPC that ends on its own terminates the worklet).

```sh
npm run link:addons -w apps/app      # exit 0, rocksdb/udx/sodium/bare-fs linked for every platform
npm run pack:worklet -w apps/app     # 1841105 bytes, 344 files, 38 linked addon entries; node scan clean
(cd apps/app/ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)   # exit 0
(cd apps/app/ios && xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug \
  -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build)   # BUILD SUCCEEDED
xcrun simctl install booted apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
EXPO_PUBLIC_VARANDA_GATE_URL=http://127.0.0.1:8790 npx expo start --port 8081 --clear   # from apps/app, no CI=1
npm run gate -- --device booted      # from apps/app, exit 0
```

Driver summary (trace lines omitted, long lines shortened):

```
[gate 15:14:02] PASS a: diag structuredClone=function O_NOFOLLOW=yes O_EXCL=yes bare=v1.33.4
[gate 15:14:02] PASS b: identity.create 017be000...
[gate 15:14:02] PASS c: cert.add seq 0, node.info memberCert true
[gate 15:14:02] PASS d: post.create 017be000...:1
[gate 15:14:02] data-dir lock before the kill: present; after the kill: present
[gate 15:14:05] PASS e: log.read after kill+relaunch: seq 1 "post do app (gate)" (2 entries, recover true)
[gate 15:14:21] PASS f: app sync once done (seederConfirmed true, downloaded {"660fd368...":2}); feed.read has the CLI peer post
[gate 15:14:28] PASS g: node.info after background/resume: publicKey 017be000, sync idle
[gate 15:14:37] PASS h: second worklet (no recover) node.info -> LOCKED; its node.close stop clean in 1 ms; first worklet still answers
[gate 15:14:37] PASS i: terminateNode clean in 1 ms; startNode without recover + node.info + log.read in 144 ms (2 entries)
GATE OK
```

Screenshot: `02-gate-ok.png` in the scratchpad.

## 3. Web: export, varanda-serve, member flow in a browser

```sh
cd apps/app && npx expo export --platform web     # "Exported: dist": apps/app/dist
```

Output: `dist/index.html` (1.2 KB), `dist/favicon.ico`, `dist/metadata.json` and one bundle `dist/_expo/static/js/web/index-<hash>.js` (428 KB). The output directory is `apps/app/dist`, as `--ui apps/app/dist` assumes; docs/development.md now says so.

Environment (all on loopback, data under the scratchpad):

```sh
node apps/cli/scripts/local-dht.js --port 49800
# association, seeder key + certificate, CLI member "Carla CLI" (assoc init, seed key,
# assoc certify-seeder, seed cert add, id create, assoc certify, cert add, profile set)
node bin/varanda.js seed --data <env>/seeder --association <assoc> --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1
node bin/varanda-serve.js --data <env>/web --association <assoc> --bootstrap 127.0.0.1:49800 \
  --dht-host 127.0.0.1 --port 8787 --ui apps/app/dist
```

varanda-serve printed its two lines once (`varanda-serve em http://127.0.0.1:8787`, `abra http://127.0.0.1:8787/#token=...`).

HTTP checks with curl: `/` and the JS bundle answer 200 with the CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ... connect-src 'self' ws://127.0.0.1:8787 ws://localhost:8787; frame-ancestors 'none'; ...`), `nosniff`, `no-referrer`, `DENY` and `no-store`. `Host: evil.com` -> 421, `POST /` -> 405, `/../package.json` (path as is) -> 404, `/qualquer` -> 200 (index.html fallback).

Browser: the built-in browser of the Claude desktop app (Chromium), opened on the printed URL. The page ran under the server's CSP (inline `expo-reset` style allowed by `style-src 'unsafe-inline'`; no CSP error blocked the app). Member flow, all through the UI:

| Step | Result |
|---|---|
| Token | After load: `location.href` = `http://127.0.0.1:8787/` (fragment removed), `localStorage` and `sessionStorage` empty, `document.cookie` empty, the token not in the DOM |
| Identidade | "criar identidade" -> key `d28af364...`; association shown |
| Certificate, invalid | another member's certificate (issued by the CLI for the CLI member) -> refused, "certificado inválido (member-mismatch)" |
| Certificate, valid | issued with `node bin/varanda.js assoc certify --member d28af364... --age-band 18+ --method stub` -> "certificado gravado", "certificado de membro: válido" |
| Perfil | "Wanda Web" / "membro pelo navegador" published (Diário #1) |
| Publicar | "ola do navegador (web 1)" (Diário #2) |
| Seguindo | followed the CLI member `de74d3f3...` |
| Sincronizar (uma vez) | `sync ready`, `peer seeder 2ad91b1c`, `admitted d28af364... 0`, `have d28af364... 3`, `downloaded de74d3f3... 3`, then "última execução 1: concluída" |
| A Rua | "Carla CLI · ola do terminal (cli 1)" and the own post |
| Reply | "responder" on the CLI post -> Diário #3 shows "resposta a de74d3f3:2"; A Rua shows the same line on the reply |
| 390 px | viewport 390x844: `scrollWidth` 390 (no horizontal page scroll); cards fit; the tab bar scrolls horizontally by design (`ScrollView horizontal`) |

## 4. Cross-platform P2P matrix (one local DHT, one certified seeder)

Members: the CLI member "Carla CLI" (`de74d3f3...`), the browser member "Wanda Web" (`d28af364...`, the varanda-serve node of section 3) and the iOS simulator member "Iara iPhone" (`5fb284f3...`). The iOS app was the member UI build: the same Debug binary, uninstalled and reinstalled (empty Documents), with Metro started without `EXPO_PUBLIC_VARANDA_GATE_URL` (`npx expo start --port 8081 --clear`, no CI=1). The Conectar screen got the association, bootstrap `127.0.0.1:49800` and DHT host `127.0.0.1`; the certificate was issued by `assoc certify` and typed into Identidade.

| Check | Result |
|---|---|
| Each member posts | CLI `ola do terminal (cli 1)`; web `ola do navegador (web 1)` and a reply to the CLI post; iOS `ola do iPhone (ios 1)` |
| Each follows the other two | CLI `follow` x2; web Seguindo x2 ("2 diários seguidos"); iOS Seguindo x2 |
| Sync, every post in every feed | After `sync --once` (CLI), "sincronizar uma vez" (web, iOS) in turn, the CLI `feed` lists all six posts of the three members (replies shown as `↳ de74d3f3#2` and `↳ d28af364#3`); web A Rua lists the same six; iOS A Rua lists the five posts by the others plus its own |
| Offline post | CLI `post 'feito offline no terminal (cli 2)'` with no sync running, then one `sync --once`: it appeared in iOS A Rua (during iOS's continuous sync; the CLI log shows `peer member 01cfc5b7`, a direct member connection) and in web A Rua after the next web sync |
| Reads and writes during a continuous sync | iOS "sincronizar sempre" (run 2 running), then A Rua (feed.read) and a reply `resposta do iPhone durante sync continuo` (post.reply) succeeded; Diário #3 shows it; the CLI and the web got it on their next sync |
| Force-kill and relaunch iOS | `xcrun simctl terminate` while the continuous sync held the lock, then `launch`: the app went straight to the member UI (saved config), same key `5fb284f3...`, certificate "válido", 2 follows, Diário #0 to #3 intact |
| Invalid certificate | web UI: "certificado inválido (member-mismatch)" (section 3); CLI `cert add` of another member's certificate: `erro: certificado inválido (member-mismatch)`, exit 1. The demo (section 1) also covers `untrusted-association` |

Screenshots: `04-ios-*.png` in the scratchpad.

### Defect found and fixed: smart quotes in the iOS certificate field

Typing the certificate JSON on iOS turned `"` into curly quotes (iOS smart punctuation; `autoCorrect={false}` does not turn it off), and "gravar certificado" answered "JSON inválido" (`04-ios-cert-smartquotes.png`). Pasting is not affected. Fix in `apps/app/src/screens/Identidade.js`: the curly double quotes (U+201C, U+201D, U+201E, U+201F, U+2033) are read as `"` before `JSON.parse`; a certificate holds only ASCII values, so nothing valid changes. After Fast Refresh the same typed text was accepted ("certificado gravado", `04-ios-cert-ok.png`). `apps/app` has no test script, so there is no regression test; `standard` passes on the file.

## 4b. UI resilience

| Check | How | Result |
|---|---|---|
| Web, takeover (4000) | Draft "rascunho que deve sobreviver" in Publicar, then a second browser tab opened on the same URL | First tab: banner "outra aba assumiu a conexão" + "reconectar"; the draft still in the field. "reconectar" in the first tab: banner gone, draft intact; the second tab then showed the same banner |
| Web, server stopped | Draft extended, then `kill -INT` on varanda-serve | Banner "a conexão com o nó foi encerrada"; "reconectar" while the server was down: "não foi possível abrir a conexão com o varanda-serve", draft intact. varanda-serve restarted on the same data dir with `VARANDA_SERVE_TOKEN` set to the same token (the page keeps the token only in memory), then "reconectar": connected (`session.open` ok, `sync.status` idle), draft intact. Afterwards the security audit removed `VARANDA_SERVE_TOKEN` (a fixed token would keep a URL in the browser history valid across restarts): a restart now prints a new URL, which the page must be reopened with |
| iOS, node ends on its own | A temporary dev-only hook (removed afterwards, see below) ended the client side of the IPC 40 s after the first `launch()` of the JS context, the same path as a framing error from the node (`ipc.end()` then `finish()`), while a continuous sync was running (run 1) | The UI left the ready state: banner "a conexão com o nó foi encerrada" + "reconectar"; Sincronizar went from "sincronizando (contínuo, execução 1)" to "parado" with the lines cleared. "reconectar": a new `session.open` (a fresh worklet), the banner left, and "sincronizar uma vez" completed on the new node ("última execução 1: concluída") |
| Reply line | | "resposta a de74d3f3:2" in web A Rua and Diário; "resposta a de74d3f3:2" in iOS A Rua; "resposta a d28af364:3" in iOS Diário and web A Rua |
| iOS "DHT pública" with bootstrap entries | Conexão tab, bootstrap `127.0.0.1:49800` present, switch turned on | The switch applies in the form: the bootstrap field greys out and the notice "O nó vai usar a DHT pública da internet para achar pares." appears (`04b-ios-public-dht-toggle.png`). "aplicar e reiniciar o nó" was NOT pressed, so the node never joined the public DHT; the switch was turned off again. What submit would send was checked with the app's own `checkForm` in Node, with the same form: `{ bootstrap: null, dhtHost: "127.0.0.1", allowPublicDht: true }` (accepted; the raw form without the submit's bootstrap blanking gives "bootstrap e DHT pública são exclusivos"). The node-side acceptance of that config was not exercised here (section 6 does) |

Simulator note: with `simctl`-injected input, the first tap on a button right after typing into a TextInput was often swallowed and a second tap was needed; `Page` already sets `keyboardShouldPersistTaps='handled'`. Not reproduced by hand, so it is recorded as a harness observation, not a defect.

## 5. Leak checks

- **Browser (WebSocket frames).** After the page loaded, `window.WebSocket` was wrapped in the page (from the browser tool, not in the app source) and "reconectar" was pressed, so every later connection was captured: 2 connections, 85 frames, 52 inbound (responses and events: `sync.started`, `sync.event`, `sync.stopped`), covering every method the UI used (`session.open`, `sync.status`, `node.info`, `identity.create`, `identity.show`, `cert.add`, `profile.set`, `post.create`, `post.reply`, `follow.add`, `follow.list`, `sync.start`, `feed.read`, `log.read`). Scan of the inbound text: no string containing `/` (no filesystem path), no `secret`/`privateKey`/`primaryKey`, not the token, not the bootstrap port 49800 and not `127.0.0.1` (no DHT host). The only 128-hex value was `signature` of the member certificate in `log.read`, which is public block-0 data. The first connection (before the wrap: `session.open`, `sync.status`, `node.info`) was not captured; the same three calls were captured on the second connection. A separate scripted WebSocket client was not run.
- **iOS (IPC frames).** Temporary `console.log('[T11-FRAME] ' + JSON.stringify(obj))` in the frame decoder of `apps/app/src/client/native.js`, read through Metro's log (90 captured inbound frames, `05-ios-frames.log` in the scratchpad), then removed. Same scan: no `/` string (no `Documents` path or data dir), no secret key name, no bootstrap or DHT host; the only 128-hex value was the certificate `signature`. Metro may not forward every console line, so 90 is what was captured, not a proven total.
- **varanda-serve output.** Both runs printed exactly two lines; the token appears once, in the `abra ...#token=` line, and never again after startup (`grep -c` of the token = 1 per log).
- **Temporary code removed.** `apps/app/src/client/native.js` was restored from a copy taken before the edits: `git diff` shows no change to it, and `grep -rn T11 apps packages` finds nothing.

## 6. Public DHT (issue #9)

Date: 2026-10-23, the same Mac, Node.js v24.22.1, npm 11.19.1, hyperdht 6.34.1, hyperswarm 4.17.2, at `main` 19e3744. Every process, the iOS simulator included (it shares the Mac's network stack), ran on this one Mac, behind one router and one public address. Distinct machines, networks and NAT or CGNAT between peers were not covered (issues #36 and #42).

### CLI

The README "DHT pública" path: no `local-dht.js`, `VARANDA_BOOTSTRAP` and `VARANDA_DHT_HOST` unset (`env` showed no `VARANDA_*`, and the timing wrapper also removed both from every child's environment), no `--bootstrap` and no `--dht-host`. An association, a certified seeder and two members (Alice, Bob), each in its own data dir, were set up offline with the README steps 2 to 4. Then every network command ran as its own process:

```sh
node bin/varanda.js seed --data <env>/seeder --association <assoc>
node bin/varanda.js sync --data <env>/alice --once --timeout-ms 30000
node bin/varanda.js follow --data <env>/bob --author <alice>
node bin/varanda.js sync --data <env>/bob --once --timeout-ms 30000
node bin/varanda.js feed --data <env>/bob
```

A small wrapper timed every output line from the process start (seconds below).

| Step (README 5 and 6) | Output | Exit |
|---|---|---|
| `seed` | `seed ready` 4.3 | stays up |
| Alice `sync --once` | `peer seeder 5a702e87` 3.3, `admitted 6186af23... 0` 3.4, `have 6186af23... 3` 3.4, `sync ready` 4.7, `sync done` 6.5 | 0 |
| Bob `follow` Alice, `sync --once` | `peer seeder 5a702e87` 3.1, `admitted 80450766... 0` 3.1, `downloaded 6186af23... 3` 3.1, `sync ready` 4.9, `sync done` 6.5 | 0 |
| Bob `feed` | Alice's post `primeira publicação pela DHT pública` | 0 |
| Bob `reply`, `sync --once` | `admitted 80450766... 1` 3.5, `have 80450766... 2` 3.5, `sync done` 7.0 | 0 |
| Alice `follow` Bob, `sync --once`, `feed` | `downloaded 80450766... 2` 3.6, `sync done` 6.8; the feed shows Bob's reply (`↳ 6186af23#2`) | 0 |

Then 30 more runs on the same seeder (Alice posts, Alice syncs, Bob syncs: 15 pairs) and 4 later runs (Bob after following the iPhone member below, Alice after a new post, Alice and Bob after the seeder restart below). All 38 `sync --once` runs:

| Measure | Value |
|---|---|
| Result | 36 `sync done` (exit 0), 2 `sync failed: sem pares` (exit 1) |
| First `peer seeder` (discovery) | 36 runs: min 2.9, median 3.8, max 31.0 |
| `admitted` after `peer seeder` | within 0.04 in 35 runs, 1.8 in one |
| `sync ready` (join and DHT flush) | 33 runs: min 4.7, median 7.0, 90th percentile 17.8, max 22.4 |
| `sync done` | 36 runs: min 6.2, median 9.0, max 32.6 |
| Ended only after the 30 s deadline | 4 runs (31.4 to 32.6), all `sync done` with `admitted` printed, none with `sync ready` |

The two failures:

- Bob: `sync ready` 20.6, then `aviso: par descartado (5a702e87): hello-timeout` 30.4 and `sync failed: sem pares` 31.5. A socket to the seeder opened but carried no hello; the seeder logged no `peer member` line during that run.
- Alice: no peer and no `sync ready`, `sync failed: sem pares` 32.4; the seeder logged nothing. Alice's next run (after one Bob run) ended `sync done` in 9.0.

Observations:

- `--once` cannot end before `sync ready`: the grace timer and the goal check start after the join and the DHT flush (`packages/core/lib/sync.js`). On the public DHT that flush, not the transfer, sets the run time: discovery and admission took a median 3.8 s, `sync ready` a median 7.0 s. When the flush outlasts `--timeout-ms`, the run ends at the deadline and still succeeds when its goals hold (the 4 runs above). The README's `--timeout-ms 30000` worked; a much shorter value would turn slow announces into failures.
- `downloaded <key> <length>` sometimes appears twice with the same length (2 CLI runs and the app run below). `packages/core/lib/sync.js` emits it both when the gate of a key completes and when the key grows. Cosmetic; not investigated further.

Seeder stop and restart:

- SIGINT to the `seed` process (forwarded to `node` by the timing wrapper, unlike the `pkill -f` note in "Not verified"): exit 0.
- Seeder down, Bob `sync --once`: `sync ready` 6.6, `sync failed: sem pares` 31.5, exit 1.
- The same `seed` command on the same data dir: `seed ready` 8.2. Alice (one new post): `admitted 6186af23... 19`, `have 6186af23... 20`, `sync done` 19.3. Bob: `downloaded 6186af23... 20`, `sync done` 20.6. SIGINT: exit 0 again.

### App (iOS simulator)

Built at the same commit with the section 2 steps: `npm ci`, `link:addons`, `pack:worklet` (1841148 bytes, 344 files, 38 linked addon entries; node scan clean), `pod install`, `xcodebuild` Debug (BUILD SUCCEEDED). The app was uninstalled, then installed; Metro ran without `EXPO_PUBLIC_VARANDA_GATE_URL` (member UI). iPhone 17 Pro simulator, iOS 26.2.

| Step | Result |
|---|---|
| Conectar | Association typed, bootstrap empty, "DHT pública" on (notice "O nó vai usar a DHT pública da internet para achar pares."), "endereço local da DHT" empty, "conectar": the member UI opened. `Documents/varanda-config.json` in the app container: `{"association":"<assoc>","bootstrap":null,"dhtHost":null,"allowPublicDht":true}`, which is only written after the node starts with it (docs/app.md) |
| Identidade | "criar identidade" -> `a08067be...`; the certificate from `assoc certify` was typed (iOS turned the quotes curly; the section 4 fix read them) -> "certificado de membro: válido" |
| Seguindo, Publicar | Alice and Bob followed ("2 diários seguidos"); `ola do iPhone pela DHT publica` -> "publicado" |
| Sincronizar uma vez | `peer seeder 5a702e87`, `admitted a08067be... 0`, `have a08067be... 2`, `downloaded 80450766... 2`, `downloaded 6186af23... 11`, `... 14`, `... 18`, `sync ready`; "última execução 1: concluída". The seeder logged the iPhone member about 5 s after the tap (wall clock, tap latency included) |
| A Rua | Alice's posts (`lote 10`, `lote 9`, ...) and the own post |
| CLI receives the iPhone post | After the app's run ended: Bob `follow a08067be...`, `sync --once` -> `admitted 80450766... 2`, `downloaded a08067be... 2`, `sync done` 7.7, exit 0; Bob's `feed` shows `ola do iPhone pela DHT publica` |

Screenshots: `09-ios-*.png` in the scratchpad.

Harness note: injected taps on the "DHT pública" switch were unreliable (once it showed on, then off again with no further tap). The state was checked on a screenshot before "conectar", and the saved config above confirms what the node received.

### Known defect reproduced: a loopback DHT host with the public DHT (issue #10)

Conexão tab, "DHT pública" still on, `127.0.0.1` typed in "endereço local da DHT", "aplicar e reiniciar o nó": accepted with no warning; the saved config became `{"bootstrap":null,"dhtHost":"127.0.0.1","allowPublicDht":true}`. "sincronizar uma vez" printed no line at all (not even `sync ready`) and ended "última execução 1: tempo esgotado"; the seeder logged no connection. With the field cleared and applied again (`dhtHost: null`), "sincronizar uma vez" printed `peer seeder 5a702e87`, `admitted a08067be... 2`, `downloaded 6186af23... 19` (a post Alice made meanwhile) and `sync ready`, and ended "concluída". The stale "sincronização única iniciada" notice also stayed on Sincronizar across both node restarts. Both are in issue #10; nothing was changed here.

## Not verified

- Android native run (no SDK or Java on this Mac).
- Real devices (iOS or Android); only the iPhone 17 Pro simulator.
- The public DHT between distinct machines or networks, or through NAT or CGNAT: section 6 joined it, but with every peer on one Mac (issues #36 and #42).
- The web client on the public DHT (`varanda-serve --public-dht`), and a continuous sync ("sincronizar sempre", `sync` without `--once`) on it.
- A scripted WebSocket client acting like the page (the real page in a browser was used instead).
- The exit code of `seed` and `local-dht.js` on SIGINT in this run: they were stopped with `pkill -INT -f`, which also signalled their wrapper shells, so the wrapper reported 1. The demo covers the seeder's SIGTERM exit 0.

## Residual risks

- Everything in the "Residual risks" list of [ios-gate.md](ios-gate.md) still applies (Android unverified, fs facade TOCTOU, Bare version split between bare-kit and bare-runtime, linked addons wiped by every install, dev reload can take over a live lock).
- **Public DHT with a loopback DHT host.** Turning on "DHT pública" keeps the "endereço local da DHT" field (`127.0.0.1` here) in the config. The README warns that a loopback DHT host keeps the DHT away from public peers. The form does not clear or warn about it. Section 6 reproduced it: the sync times out without a single line (issue #10). Fixed afterwards (#10): the form and the node session refuse a loopback DHT host with the public DHT, and a configuration saved before the fix loses only that host when the app reads it; checked on the simulator (the refusal in Conexão; a hand-written old config started on the public DHT and synced).
- **Public DHT reliability.** On one Mac, 2 of 38 `sync --once` runs found no usable peer within 30 s (`sem pares`) while the seeder was up, and 4 ran into the deadline because the DHT flush was slow. A person may need to sync again; across real networks the rate is unknown until #36 and #42.
- **Stale notices.** Screen-local notices outlive the state they describe: "sincronização contínua iniciada" stays after the node ended and the sync state was reset; "publicado" stays on the Responder screen. Cosmetic. Fixed afterwards (#10): a notice now belongs to the node run and to its screen context (the sync run, the post being answered) and is cleared when either ends; checked on the simulator ("iniciada" gone when the run ended, "publicado" gone on Responder, after cancelling and after a node restart).
- **Earlier app state.** The simulator still had a node and config from an earlier association; the app was uninstalled first. Changing association after an identity exists requires removing the app data by hand (by design: the association is read-only once an identity exists).

## Fixes made in this verification

- `apps/app/src/screens/Identidade.js`: curly double quotes typed by iOS smart punctuation are read as `"` before `JSON.parse` of the certificate (section 4).
- `docs/development.md`: the web export's output directory is stated (`apps/app/dist`, "Exported: dist") instead of "confirm the output directory".
- This file.

## Security audit fixes (after this verification)

The security audit of the branch (Claude and GPT; Grok's account was out of credit) found four verified issues, each rated high after triage. They were fixed after the checks above:

- **Android release signing** (`apps/app/android/app/build.gradle`): release builds were signed with the committed public debug keystore, so anyone could sign an "update" that reads the node's data. Release signing now comes only from `VARANDA_RELEASE_*` Gradle properties kept outside the repository, and a release build fails without them; debug builds use the `app.varanda.debug` application ID. Not built here (no Java).
- **Android backups** (`AndroidManifest.xml`, `app.json`): `allowBackup` was true, so the node's key material went to cloud backups. It is now false. Not built here.
- **iOS backups** (`apps/app/ios/Varanda/AppDelegate.swift`): `Documents/varanda` is marked as excluded from iCloud and device backups at launch. Checked on the iPhone 17 Pro simulator after a rebuild: `xattr -l` on the container's `Documents/varanda` shows `com.apple.metadata:com_apple_backup_excludeItem: com.apple.MobileBackup`, and `varanda-config.json` (not secret) is still backed up.
- **varanda-serve token** (`apps/cli/lib/serve/args.js`): a fixed `VARANDA_SERVE_TOKEN` would keep a URL left in the browser history valid across restarts. The variable is now refused and the token is generated on every start (`apps/cli/test/serve.test.js` covers both); the README advises a private window. This changes the 4b "server stopped" recovery: after a restart the page must be reopened with the new URL.

## 7. The new app design on the iOS simulator (2026-10-23)

The app with the design of [app-design.md](../apps/site/artwork/app-design.md) (three tabs, publish button and sheet, profile header, Ajustes), on the same Mac: Node.js v24.22.1, Xcode 26.2, CocoaPods 1.16.2, iPhone 17 Pro simulator on iOS 26.2. Branch `feat/app-new-design`, uncommitted working tree. Logs and screenshots stayed in the session scratchpad.

### Build

| Command | Outcome |
|---|---|
| `npm run link:addons -w apps/app` | exit 0 |
| `npm run pack:worklet -w apps/app` | exit 0; bundle 1 842 898 bytes, node scan clean |
| `cd apps/app && npx expo export --platform android` (after `pack:worklet`) | exit 0, Hermes bundle written to the ignored `dist/` |
| `cd apps/app && npx expo export --platform web` | exit 0 |
| `cd apps/app/ios && pod install` | exit 0; see the Podfile.lock note below |
| `xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build` | `BUILD SUCCEEDED` |
| `xcrun simctl uninstall booted app.varanda`, `install`, `launch` | fresh first run |

**Podfile.lock.** `pod install` rewrites two `SPEC CHECKSUMS` lines (`React-Core-prebuilt` and `ReactNativeDependencies`) in any checkout at another path. Both local podspecs take `source.http` from an absolute `file://` URL inside the checkout (`apps/app/ios/Pods/*-artifacts/*.tar.gz`), so their checksums follow the path. No pod and no version changed. The build ran with the rewritten lock, and the committed `Podfile.lock` was restored afterwards (`git show HEAD:apps/app/ios/Podfile.lock > apps/app/ios/Podfile.lock`).

### Walkthrough

The dataset was the one from the web run, reused: the local DHT on `127.0.0.1:49800`, the certified seeder, and three CLI members (Marília Prado, Seu Nelson, Bia Carvalho) with the posts of [screens.md](../apps/site/artwork/screens.md). Metro was started from `apps/app` without `EXPO_PUBLIC_VARANDA_GATE_URL` and without `CI=1`.

- **First run.** Conectar (association key, bootstrap `127.0.0.1:49800`, DHT host `127.0.0.1`) led to the Identidade setup step. "criar identidade" made the key. `assoc certify` produced the certificate JSON, which was pasted and saved with "gravar certificado". The tabs then appeared, opening on A Rua.
- **Diário › Editar perfil.** The name was Helena Dias with a bio. iOS autocorrect rewrote the typed bio, so it was pasted instead (the screens.md pitfall).
- **Seguindo.** The three keys. Names show after the first sync.
- **Chip › Sincronizar › "sincronizar uma vez".** The run was "concluída". A Rua reloaded on its own, and the chip read "sincronizado agora".
- **Reply to Bia's post** with "responder", then **post 5** with the publish button, then a second sync. The toast ("resposta publicada") showed above the tab bar.
- **"sincronizar sempre".** With the chip on "sincronizando…", two A Rua captures 20 s apart were byte-identical: no reload loop.
- **Ajustes › Conexão › "aplicar e reiniciar o nó".** The node restarted (the next sync was "execução 1"), connected and synced. "‹ Ajustes" went back, and "Fechar" or a swipe down closed the sheet.

### Design checks

- **Titles.** The top-bar titles and the profile name use SF Rounded (`ui-rounded`).
- **Safe areas.** The top bar sits below the Dynamic Island. The tab bar is 49 pt plus the home indicator (83 pt in all).
- **Publish button.** It sits 20 pt from the right and about 17 pt above the tab bar, with the green shadow.
- **Icons.** The Feather icons render (tabs, chip, gear, reply, Ajustes rows).
- **Publicar sheet.** It is a native page sheet: the screen behind dims. Swipe-down and "Cancelar" both keep the draft and the reply context. With the on-screen keyboard up, the ring and the counter stay visible. The input is bare text, with no box.
- **Diário header.** The band runs behind a light status bar, and the 88 pt avatar with its cream ring overlaps it. The native CSS gradient overlay rendered rather than the stripes: in the capture the band's colour changes across each pixel row (the 170° angle), which flat horizontal stripes cannot do.
- **Avatar colours.** They follow the first byte of the key mod 5: `4f` green, `ba` and `bf` orange, `c0` yellow.
- **Pull to refresh.** The pull gesture works on A Rua. The local reload ends before the spinner could be captured.
- **VoiceOver labels.** These were checked in the code only, not with VoiceOver: "publicar" (button), "sincronização: …" (chip), "responder a <nome>" (reply), "ajustes" (gear) and the tab names.

### Fixes made in this run

- `apps/app/src/screens/Publicar.js`:
  - The compose input is bare text (no border or background), and on the web it has no focus outline.
  - The uncertain-publish match window is now 2 s instead of 120 s. The node stamps `at` from the same clock while it handles the request, so an identical post made earlier no longer counts as this send.
- `apps/app/App.js`:
  - The toast sits above the tab bar.
  - The setup step uses the same centred 640-wide column as the tabs on the web.
  - The status bar stays light on Diário while a sheet is open: the iOS page sheet leaves it over the dimmed band.
- `apps/app/src/ui/PostRow.js`: the reply button's label names the author ("responder a <nome>").
- `apps/app/src/ui/Sheet.js`, `Ajustes.js` and `Perfil.js`: a sheet body colours down to the bottom edge, so Ajustes and Editar perfil no longer end in a white strip under their cream body.

### Final checks

`npm run lint` exit 0; `npm test` exit 0 (no `not ok`); `npm run demo` `DEMO OK`; `node apps/site/scripts/render-assets.js --check` ok (47 files); `git diff --check` clean. `git status` shows no generated file, and `Podfile.lock` is unchanged.

### Not run

- The Android native run (no SDK or Java on this Mac). Only the Android JS export was checked.
- The iOS gate (`EXPO_PUBLIC_VARANDA_GATE_URL`). The App.js gate branch is unchanged.
- VoiceOver itself, and real devices.

## 8. Browser member spike (2026-10-23)

### Summary

- Proven: a member whose key lives only in the browser (Hypercore 10, IndexedDB) replicates its diary through the seeder, and a CLI member (Hypercore 11) downloads it and verifies the seeder.
- Call: GO for the seeder path (G1 and G2 passed). The relay (G3) is technically proven but not production-ready.
- Main blocker found and fixed: `sodium-javascript` 0.8.0 lacks two functions the Noise handshake needs, so the browser could not connect. A small, differentially tested shim fixes it.
- Relay verdict: `@hyperswarm/dht-relay` 0.4.3 works in noncustodial mode only with an adapter on the relay side, and has a second defect that crashes the relay. The default custodial mode sends the secret key to the relay and is unacceptable.
- The spike is a private workspace (`@varanda/web-member`); nothing here ships to users yet.

### Machine and versions

macOS (Darwin 24.6.0), Node v24.22.1, npm 11.19.1. Browser: the Chromium-based built-in browser of the Claude desktop app.

| Library | Version |
|---|---|
| hypercore (`packages/web-member`, nested) | 10.38.2 |
| hypercore (root, seeder, CLI) | 11.39.0 |
| corestore | 7.15.0 |
| @hyperswarm/secret-stream | 6.9.2 |
| protomux | 3.13.0 |
| @hyperswarm/dht-relay | 0.4.3 |
| hyperdht | 6.34.1 |
| sodium-javascript | 0.8.0 (plus the shim, with @noble/curves 2.4.0) |
| esbuild | 0.28.2 |
| random-access-storage | 3.0.2 |

### What was built

- `packages/core/lib/admission.js`: the admission channel moved verbatim out of `net.js` (re-exported, exports unchanged, 25 keys). It reads the muxer from `socket.noiseStream.userData`, so it needs no hypercore, hyperdht or hyperswarm. A `browser` import condition in `packages/core/package.json` maps fs/path to throwing stubs. Test: `packages/core/test/browser-safe.test.js`.
- `Seeder#acceptStream(rawStream, { handshakeTimeoutMs = 10000 })` in `packages/core/lib/seeder.js`: a Noise responder keyed with `seeder-key.json` (members verify it as for swarm seeders); shares `MAX_CONNECTIONS` with swarm sockets; 10 s absolute handshake deadline; refused before ready; `close()` destroys these first. A frame guard sits in front of the responder: the two handshake frames are at most 1024 bytes each, every later frame at most 8 MiB + 64 KiB; violations drop the peer with reason `frame-limit`. Measured: handshake frames of 32 and 64 bytes; the largest legitimate later frame was 16,477 bytes. Tests: `apps/cli/test/seeder-stream.test.js` (7 tests).
- `varanda seed --ws-port <n> [--ws-host <ip>]` (`VARANDA_WS_PORT`, `VARANDA_WS_HOST`): off by default, `127.0.0.1` by default, path `/seeder`, header timeout 4 s, never logs a client address. No Origin allow-list: announce is unauthenticated by design (protocol.md), and the Noise handshake plus the seeder certificate authenticate the endpoint. Code: `apps/cli/lib/seed-ws.js`. Tests: `apps/cli/test/seed-ws.test.js` (8 tests).
- `packages/web-member`: `lib/member.js` (Hypercore 10 member), `lib/storage.js` (memory), `lib/idb-storage.js` (IndexedDB, whole-file rewrite), `lib/ws-stream.js`, `lib/seeder-link.js`, `lib/relay-link.js` (noncustodial relay client), `lib/sodium-browser.js` (the shim), `scripts/build.js`, `scripts/serve-spike.js`, `scripts/dht-relay.js`, `web/` (spike page, pt-BR), `test/` (CI) and `spike/relay-eval.test.js` (manual).

### G1: automated (CI), PASS

Test file: `packages/web-member/test/g1-seeder-ws.test.js` (30 asserts). An in-process Seeder (Hypercore 11) accepts a WebSocket through `Seeder#acceptStream`. A Hypercore 10 member with a fresh key pair and a certificate signed by `assoc init`'s association connects (seeder key pinned, certificate verified), is admitted, and posts "poste do navegador (spike)"; the seeder's copy has length 2. After the writer closes, the CLI binary (Hypercore 11) runs id create, assoc certify, cert add, follow, `sync --once` and `feed`: peer role seeder verified true, downloaded length 2, the post is in the feed. Negative case: a certificate from another association is rejected with `untrusted-association` and never admitted. `seed list` shows the key with length 2. Timings: connect to admitted 29-30 ms, connect to have 2 33-34 ms; the file takes about 1.6 s.

Compat-key finding (`packages/web-member/test/seeder-link.test.js`): Hypercore 10.38.2 defaults (`DIARY_OPTIONS = {}`) are compat mode: `core.key === keyPair.publicKey`, manifest version 1 default signer, and the json encoding stores exactly the `JSON.stringify` bytes that Hypercore 11 reads back. Hypercore 11 still verifies compat cores (`node_modules/hypercore/lib/verifier.js:44-54, 67-78`). The member certificate's `member` is that key.

### G2: Chromium, PASS (after the crypto shim)

Commands (all on 127.0.0.1, no public DHT):

```sh
node apps/cli/scripts/local-dht.js --port 49800
# assoc init, seed key, assoc certify-seeder, seed cert add
#   (association a11730fc..., seeder e900d8ba...)
node bin/varanda.js seed --data <seeder> --ws-port 8789 \
  --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1 --json
#   prints {"event":"ws","host":"127.0.0.1","port":8789}, then ready
node packages/web-member/scripts/build.js
node packages/web-member/scripts/serve-spike.js --port 8790
# open http://127.0.0.1:8790/
```

**First attempt failed** with "Noise handshake failed": the client closed the WebSocket before it opened. Root cause, reproduced in Node by mapping sodium-native to sodium-javascript: sodium-javascript 0.8.0 (the latest published, 2022) lacks `crypto_scalarmult_ed25519_BYTES` and `crypto_scalarmult_ed25519_noclamp`, which noise-curve-ed 2.1.0 needs for every Noise XX handshake. Block signing worked (storage and append worked), Noise did not. An audit of every sodium symbol used by both bundles found exactly these two missing.

**The shim** (user-approved): `packages/web-member/lib/sodium-browser.js` adds only those two on top of sodium-javascript, using the @noble/curves 2.4.0 ed25519 implementation and mirroring libsodium's contract byte for byte: canonical and on-curve decoding, the small-order blacklist, libsodium's main-subgroup check (which also accepts order-2L points, exactly like libsodium), no clamping, bit 255 cleared, and failure throws "failed to derive shared secret" like sodium-native 5.2.0. It is mapped only in the browser bundles, through an esbuild plugin. Differential tests against sodium-native (`packages/web-member/test/sodium-browser.test.js`, 7 tests, 193 asserts): 2048 random and 6 fixed valid cases are byte-for-byte equal; 260 order-2L points; 16 small-order, 7 non-canonical, 64 off-curve, 192 mixed-order and 5 zero/identity scalars all fail on both; 512 random pairs agree; a full Noise XX through the `@hyperswarm/secret-stream` shim to native passes in both roles. The shim is not constant-time (JS BigInt).

**Second attempt passed.** Page log:

- Key `d538bd1a...` created (the secret is only in IndexedDB `varanda-spike`/`identity`), diary opened.
- The member certificate issued by `assoc certify --member d538bd1a...` was pasted and written to block 0; the post "ola do navegador (web spike)" is block 1.
- Page reloaded: "chave encontrada" and "diário aberto (2 blocos)", read back from IndexedDB.
- "conectar ao semeador": "conectado; chave Noise do semeador e900d8ba...", "semeador verificado", "admitido", "have: o semeador tem 2 blocos".
- A post after the reload, "segundo post depois de recarregar (web spike)" (block 2, which proves the signing key persisted): "have: o semeador tem 3 blocos".

Seeder log: peer member, admitted d538bd1a... 0, have 2, have 3. A CLI member (id create, assoc certify, cert add, `follow --author d538bd1a...`, `sync --once --timeout-ms 30000`) exited 0 in about 0.65 s with:

```
{"event":"peer","role":"seeder",...,"verified":true}
{"event":"downloaded","key":"d538bd1a...","length":3}
{"ok":true,"peers":1,"seeders":1,...}
```

`feed` lists both browser posts. Console: no errors on the passing run. At 390 px wide there is no horizontal overflow (scrollWidth 390), localStorage is empty and no secret appears in the URL.

Bundle sizes (esbuild 0.28.2, minified IIFE): member bundle 505,039 bytes (148,968 gzip), against 430,462 (121,646 gzip) before the shim; relay bundle 373,939 bytes (110,986 gzip). Shims and aliases: the `events` package (3.3.0) for random-access-storage and hypercore 10; `random-access-file`, `crypto`, `worker_threads`, `fs`, `path`, `os` and `node:*` map to a throwing stub (never used at runtime).

CSP note: the spike page needs `'wasm-unsafe-eval'` in `script-src`, because sha512-wasm, sha256-wasm and blake2b-wasm compile WebAssembly at load (this allows WebAssembly compilation only, not eval). The later Caddy CSP must include it, or alias those packages to their JS fallbacks.

### G3: dht-relay, PASS in Node and in Chromium, with two upstream defects

**Node** (`packages/web-member/spike/relay-eval.test.js`), 7 runs: a Hypercore 10 member that reaches the DHT only through the relay, over a WebSocket, joins `topicFor(association)`; a Hypercore 11 follower (`runSync --once`, `writeFollows`, no seeder) connects directly (peer role member), the handshake hash is present, and it downloads 2 blocks.

```
RELAY_EVAL {"ok":true,"ms":173-196,"custody":"noncustodial","reason":""}
```

**Chromium:** the seeder was stopped; `node packages/web-member/scripts/dht-relay.js --port 8791 --host 127.0.0.1 --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1` ran. The page published a third post locally ("terceiro post, so pelo relay (web spike)", block 3, held only by the browser) and clicked "entrar pela DHT (relay)": "[relay] conectando ao relay (noncustodial)...", "[relay] anunciado no tópico da associação; procurando pares...". The CLI member's `sync --once` printed `{"event":"peer","role":"member","peerKey":"d538bd1a..."}`, `{"event":"downloaded","key":"d538bd1a...","length":4}` and `{"ok":true,"peers":1,"seeders":0,...}`; `feed` shows all three browser posts.

**Upstream defects in `@hyperswarm/dht-relay` 0.4.3** (its README says "experimental... Do not use it in production"):

1. Noncustodial announce and listen are broken with hyperdht 6.34.1. dht-relay's SigneeProxy (`lib/signee-proxy.js:20`) expects `signAnnounce(target, token, peerId, { peer: relayAddresses })`; hyperdht 6.34.1 passes an `ann` object whose peer is `{ publicKey, relayAddresses }` (hyperdht `index.js:478-489`, `lib/announcer.js:239-250`). The result is "uint must be positive" in the relay's `array(ipv4Address)` codec, nothing is announced, and the lookup measured NO-GO (`PEER_NOT_FOUND`). The package's default mode (custodial) works. The spike's relay script carries a small compatibility adapter that reshapes `ann` on the relay side; the client stays noncustodial.
2. The relay process crashes when an incoming relayed connection errors. `lib/server-proxy.js:92` (`onError`) sends `destroy { alias, error }` without `paired: true`, so the encoder reads `remoteAlias` (undefined) and throws "uint must be positive" synchronously inside an `'error'` handler: an uncaught exception that drops every session. Seen in the Chromium run right after the CLI follower finished its sync (the data had already been delivered). Not fixed in this PR: the relay script is spike-only and runs only when started by hand.

**Why custodial mode is unacceptable:** it sends the secret key to the relay, which contradicts "the key stays on the device".

### Review findings fixed in this PR

Cross-vendor review (GPT) found, and this PR fixed:

- A pre-auth 16 MiB frame allocation on the seeder's external path.
- A 16 KiB pre-connect budget that refused valid members (coalesced channel opens).
- Half-open refused upgrades exhausting connection slots.
- A WebSocket `maxPayload` smaller than legitimate batches.
- A header timeout enforced only every 30 s.
- Closed WebSockets holding a slot until the deadline.
- An unverified `have` resolving `waitServed`.
- Concurrent `setCert` calls writing two certificates.
- Reopen returning the wrong key pair.
- A certificate that stayed mutable after verification.
- No admission deadline.
- A relay crash on a duplicate public key (now `KEYPAIR_ALREADY_USED` is caught and only that session is refused).
- Announcements never renewed (now every 5 min; records expire after 20 min, hyperdht `index.js:614`).
- Timers still running after close.

The Grok review lane completed one of four attempts (the review of the web-member seeder link): one attempt failed to sign in and two hit the lane's turn limit, so the other reviews were cross-vendor with GPT only.

### Security audit (before the push)

Scope: the production code, scripts, spike page, manifests and lockfile of this change (30 files; tests and docs were read only for context). Auditors: Claude (brief-based), Claude's built-in security review, GPT (gpt-6-astra) and Grok (grok-4.7); every finding was checked against the code before it counted. OpenAI's Codex Security scanner was not run: one scan can use up the ChatGPT plan's quota on its own, and the GPT lane was still needed to review the fixes.

Verified findings, after merging duplicates and an upgrade-only triage (five were raised to high):

| Severity | Finding | Found by | Outcome |
|---|---|---|---|
| high | `seed --ws-port`: no `Host` / `Origin` check, so any web page in a browser on the seeder host could open `/seeder`, replicate the (network-public) diaries and hold the connection cap that WebSocket clients shared with swarm peers | Claude, Grok, built-in review | fixed: `Host` check (421), `Origin` allow-list for browser clients (403; loopback origins by default, Origin-less clients accepted), WebSocket clients capped at half the connection limit |
| high | spike dht-relay: silent WebSocket clients held every slot (the relay protocol's failsafe arms only after a ping/pong), no `Host` / `Origin` check, `--host` accepted any address | GPT, verifier | fixed: loopback-only `--host`, `Host` / `Origin` checks, a first-message deadline (10 s) and an idle deadline (45 s) |
| high | relay page: the diary's signing key was also the Noise and DHT key (cross-protocol reuse, non-constant-time DH with attacker-chosen points) | Claude, verifier | fixed: an ephemeral key pair per relay session |
| high | the page hook handed the member object (and its secret key) to any script; the secret key is stored unencrypted in IndexedDB | Claude, verifier | hook fixed (a frozen view with only `key`, `length` and `replicate`); **encryption at rest accepted as a known risk of this spike and deferred to PR 4** (decision 2026-10-23; design below) |
| high | the browser member replicated its diary before the seeder's certificate was verified | Grok | fixed: replication starts only after a verified seeder hello (tests with an impostor endpoint) |
| medium | a handshaken client can hold a frame of up to `MAX_EXTERNAL_FRAME` open (secret-stream allocates the declared length up front); dripping one body byte every < 30 s also keeps the external idle deadline from firing, so 32 such clients pin about 256 MiB and every WebSocket slot (swarm peers keep their half) | Claude (low), Grok re-audit (medium) | deferred to the hardening PR: a frame-completion deadline that body bytes do not refresh, and a lower frame limit until the peer has an admitted diary |
| high (re-audit) | the page hook's facade still let a page script reach the key pair through `replicate()` with its own muxer, contrary to its comment | Claude (re-audit) | same impact as the accepted key-at-rest risk (a same-origin script can read the key from IndexedDB): the comment now says the hook is not a security boundary; the hook goes away in PR 4, when the relay entry joins the page bundle |
| low (re-audit) | an external socket that sends a hello and goes silent kept a WebSocket slot for good | Claude (re-audit) | fixed: a 30 s inactivity deadline on external sockets after the handshake (live peers send keep-alives every 5 s) |
| medium (re-audit) | upstream dht-relay defect 2 above (`lib/server-proxy.js:91-93` sends `destroy` without `paired`, the encoder throws inside an `'error'` listener): any DHT peer that fails a relayed handshake stops the relay process; the script's `unhandledRejection` net does not catch a synchronous throw | Grok (re-audit) | deferred with the relay decision to the hardening PR (same reason as the next row) |
| medium (re-audit) | a third upstream dht-relay 0.4.3 defect: a duplicate `noiseReply` calls a cleared callback (`lib/handshake-proxy.js:63` sets `_onNoiseReply = null`, `lib/node-proxy.js:320` calls it again), and the uncaught `TypeError` stops the relay process | GPT (re-audit) | deferred with the relay decision to the hardening PR (patch, fork or drop dht-relay): the relay is a spike script, loopback-only, started by hand, never deployed |

The built-in review's single candidate (the missing `Origin` check) was discarded by its own false-positive filter on confidentiality grounds (diaries are public within the network, as on the swarm path) and kept by the brief-based audit for the availability and cross-site reachability it creates; it is the first row above.

### Limits and open risks

Deferred, not fixed in this PR:

- Two tabs on the same diary can overwrite each other's posts (the IndexedDB adapter rewrites whole files, with no cross-tab writer lock). Deferred to the key and backup PR (cross-tab Web Lock).
- The browser key is stored unencrypted in IndexedDB, by the page and inside Hypercore 10's own header; there is no export or backup yet (clearing site data loses the identity). Accepted for this spike (a loopback-only page, not distributed) and deferred to PR 4 with the passkey design below.
- The IndexedDB adapter rewrites whole files: fine for a spike, not for multi-MB diaries.
- `member.post()` does not enforce the diary quota (100,000 blocks / 64 MiB); the seeder would reject and purge on `quota`. The real browser session must enforce it.
- `ws-stream` drops buffered bytes on `end()` or `destroy()` before the socket opens.
- Relay page: "apagar tudo" does not leave the relay swarm, and the relay path does not announce to seeders (only direct member to member).
- A handshaken client can hold a declared frame of up to `MAX_EXTERNAL_FRAME` open without sending its body (no frame-completion deadline yet).
- Seeder WebSocket entry: a peer that completes a Noise handshake can make the seeder allocate up to about 8 MiB per frame (swarm sockets keep secret-stream's own 16 MiB behaviour); a concurrent swarm accept and `acceptStream` can both pass the cap (no lock); the transport is plain `ws://` on loopback until the TLS proxy (Caddy) PR.
- The shim's scalar multiplication is not constant-time; it mirrors libsodium's subgroup check, which accepts order-2L points (as libsodium itself does).
- dht-relay 0.4.3: the two upstream defects above, plus a third found by the security audit (a duplicate `noiseReply` stops the relay process); experimental; custodial mode leaks the secret key.
- A hosted PWA keeps the key on the device only as long as the served JavaScript is honest (whoever serves the page can change it).
- Hypercore 10 is the LTS line (wire-forward-compatible per the hypercore README) but receives fewer updates than 11.

### Go/no-go and estimates per later PR

**GO for the seeder path.** G1 and G2 passed; the browser-held key never leaves the device; the seeder admits and serves a Hypercore 10 diary to Hypercore 11 members. **The relay is not production-ready** with dht-relay 0.4.3 (two defects, one needing an adapter, one crashing the relay). That decision belongs to the hardening PR: fix upstream or fork, or keep the seeder-only path for the pilot.

The estimates below are rough, not measured (person-days with agent assistance):

| PR | Scope | Size |
|---|---|---|
| 2 | Browser node session behind `packages/rpc`, and `apps/app` web client using it instead of `varanda-serve` (dominated by porting the 15 RPC handlers onto Hypercore 10 and the browser storage, plus quotas and feeds) | medium, 3-5 d |
| 3 | PWA manifest, service worker, icons | small, 1-2 d |
| 4 | The key at rest protected with a passkey (WebAuthn PRF, design below), export and import of the wrapped key, a passphrase fallback, cross-tab lock | medium, 3-5 d |
| 5 | Caddy (automatic TLS) and compose serving the PWA and `wss:///seeder` on one origin, CSP with `'wasm-unsafe-eval'` | small, 1-2 d, plus the user's DNS and hosting steps |
| 6 | Hardening of the WebSocket entry for the internet, and the dht-relay decision | medium, 3-5 d |

### Next: the key at rest with a passkey (PR 4 design, decided 2026-10-23)

Decision: the member's key is protected at rest with a passkey through the WebAuthn PRF extension, so "Entrar com Google" means a passkey kept in the Google Password Manager (or iCloud Keychain, or a security key), not a Google sign-in (OIDC). An OIDC login proves who the person is but hands the page no secret, so encrypting with it would need a server that releases a wrapping key after the login: that server (and its operator) could then open the key and would learn which Google account belongs to which member. With the passkey, no server holds anything and Google never sees the key.

Design (to implement and verify in PR 4):

- **Enrolment.** `navigator.credentials.create()` with a discoverable credential (`residentKey: 'required'`), `userVerification: 'required'`, `user.id` = 16 random bytes (never an email or a Google identifier), `rp.id` = the PWA's domain (set by the hosting PR), and the `prf` extension with `eval.first` = a fixed salt (SHA-256 of `varanda/key-wrap/v1`). Some authenticators report `prf.enabled` at creation and return the PRF result only on `get()`, so enrolment ends with one `get()`.
- **Key derivation.** The 32-byte PRF output goes through HKDF-SHA-256 (a random 32-byte salt stored with the blob, info `varanda/diary-key-wrap/v1`) into a non-extractable AES-GCM-256 `CryptoKey`; the PRF output is never stored.
- **Wrapping.** The 64-byte Ed25519 secret key is encrypted with AES-GCM (random 96-bit IV) and stored in IndexedDB as `{ v: 1, credentialId, hkdfSalt, iv, ciphertext, publicKey }`. The plaintext key exists only in memory after an unlock.
- **Unlock.** On opening, `navigator.credentials.get()` with `allowCredentials: [credentialId]`, `userVerification: 'required'` and the same PRF salt (biometrics or PIN), then HKDF, then decrypt; the key stays in memory until the page closes.
- **Hypercore's own copy.** Hypercore 10 also persists the key pair in its header file. PR 4 must remove that copy: either a storage wrapper that encrypts the `header` file (or every file) with the same key, or opening the core in a way that keeps the secret key only in memory. The choice is measured in PR 4.
- **Recovery and other devices.** The passkey syncs through its provider, and the PRF output is deterministic per credential, so the same passkey unlocks the same wrapped blob on another device. The blob is exported and imported as a file or QR code (safe to keep anywhere, since it is encrypted). Losing both the passkey and every copy of the plaintext key loses the identity; this must be said plainly in the UI.
- **Fallback.** Where PRF is unavailable, a passphrase with a slow KDF (PBKDF2-SHA-256 with an iteration count from current OWASP guidance, or Argon2id through WASM; the numbers are to be checked when PR 4 is written).
- **What it protects against.** The key read from disk or from a copied browser profile, and other pages sharing the origin when the page is locked. **Not** against JavaScript served by the PWA's own origin while the key is unlocked (the hosted-PWA trust limit above), nor against a compromised device.
- **To verify in PR 4.** Browser and provider support for PRF (my understanding, not verified here: Chrome with Google Password Manager passkeys, and Safari 18 with iCloud Keychain, support it; Firefox and Windows Hello are uncertain); the exact `rp.id` once the domain exists; the UX of first enrolment and of a lost passkey.

### Not verified

- The public DHT (everything ran on a local DHT bound to 127.0.0.1).
- Real TLS and Caddy (plain `ws://` on loopback only).
- Android and iOS Safari, and Firefox (only the Chromium-based built-in browser was used).
- Long-running sessions, and multi-MB diaries.
- Node 20 locally (Node v24.22.1 only; CI covers 20 and 24).
