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
- `Seeder#acceptStream(rawStream, { handshakeTimeoutMs = 10000 })` in `packages/core/lib/seeder.js`: a Noise responder keyed with `seeder-key.json` (members verify it as for swarm seeders); shares `MAX_CONNECTIONS` with swarm sockets; 10 s absolute handshake deadline; refused before ready; `close()` destroys these first. A frame guard sits in front of the responder: the two handshake frames are at most 1024 bytes each, every later frame at most 8 MiB + 64 KiB; violations drop the peer with reason `frame-limit`. Measured: handshake frames of 32 and 64 bytes; the largest legitimate later frame was 16,477 bytes. Tests: `packages/core/test/seeder-stream.test.js` (7 tests).
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
| high | the page hook handed the member object (and its secret key) to any script; the secret key is stored unencrypted in IndexedDB | Claude, verifier | hook fixed (a frozen view with only `key`, `length` and `replicate`); **encryption at rest accepted as a known risk of this spike and deferred to PR 4** (decision 2026-10-23; resolved in section 10: the key is derived from a passkey and never stored) |
| high | the browser member replicated its diary before the seeder's certificate was verified | Grok | fixed: replication starts only after a verified seeder hello (tests with an impostor endpoint) |
| medium | a handshaken client can hold a frame of up to `MAX_EXTERNAL_FRAME` open (secret-stream allocates the declared length up front); dripping one body byte every < 30 s also keeps the external idle deadline from firing, so 32 such clients pin about 256 MiB and every WebSocket slot (swarm peers keep their half) | Claude (low), Grok re-audit (medium) | amplified vector fixed in the seeder capacity PR (section 21): a frame-completion deadline that body bytes do not refresh, `min(120 s, 10 s + 1 s per 64 KiB)` of declared length, a 64 KiB/s minimum throughput (after 10 s of grace) for frames over 64 KiB left incomplete, and a 64 MiB budget charged only by those frames, which evicts the slowest stalled reservation instead of refusing a newcomer (reasons `frame-deadline` and `frame-budget`); a non-amplified, time-bounded ws buffer remains (see the residual bullet below). A lower frame limit until the peer has an admitted diary was not pursued |
| high (re-audit) | the page hook's facade still let a page script reach the key pair through `replicate()` with its own muxer, contrary to its comment | Claude (re-audit) | same impact as the accepted key-at-rest risk (a same-origin script can read the key from IndexedDB): the comment now says the hook is not a security boundary; the hook goes away in PR 4, when the relay entry joins the page bundle |
| low (re-audit) | an external socket that sends a hello and goes silent kept a WebSocket slot for good | Claude (re-audit) | fixed: a 30 s inactivity deadline on external sockets after the handshake (live peers send keep-alives every 5 s) |
| medium (re-audit) | upstream dht-relay defect 2 above (`lib/server-proxy.js:91-93` sends `destroy` without `paired`, the encoder throws inside an `'error'` listener): any DHT peer that fails a relayed handshake stops the relay process; the script's `unhandledRejection` net does not catch a synchronous throw | Grok (re-audit) | deferred with the relay decision to the hardening PR (same reason as the next row) |
| medium (re-audit) | a third upstream dht-relay 0.4.3 defect: a duplicate `noiseReply` calls a cleared callback (`lib/handshake-proxy.js:63` sets `_onNoiseReply = null`, `lib/node-proxy.js:320` calls it again), and the uncaught `TypeError` stops the relay process | GPT (re-audit) | deferred with the relay decision to the hardening PR (patch, fork or drop dht-relay): the relay is a spike script, loopback-only, started by hand, never deployed |

The built-in review's single candidate (the missing `Origin` check) was discarded by its own false-positive filter on confidentiality grounds (diaries are public within the network, as on the swarm path) and kept by the brief-based audit for the availability and cross-site reachability it creates; it is the first row above.

### Limits and open risks

Deferred, not fixed in this PR:

- Two tabs on the same diary can overwrite each other's posts (the IndexedDB adapter rewrites whole files, with no cross-tab writer lock). Deferred to the key and backup PR (cross-tab Web Lock).
- The browser key was stored unencrypted in IndexedDB, by the page and inside Hypercore 10's own header, with no export or backup. Accepted for this spike (a loopback-only page, not distributed); resolved in PR 4 by deriving the key from a passkey and storing none (section 10).
- The IndexedDB adapter rewrites whole files: fine for a spike, not for multi-MB diaries.
- `member.post()` does not enforce the diary quota (100,000 blocks / 64 MiB); the seeder would reject and purge on `quota`. The real browser session must enforce it.
- `ws-stream` drops buffered bytes on `end()` or `destroy()` before the socket opens.
- Relay page: "apagar tudo" does not leave the relay swarm, and the relay path does not announce to seeders (only direct member to member).
- Frame pinning (section 21): fixed for the amplified vector. FrameGuard gives each incomplete frame `frameDeadlineFor(len)` = `min(120 s, 10 s + 1 s per 64 KiB)` from its header (body bytes do not refresh it). Only a frame over `SMALL_FRAME_BYTES` (64 KiB) still incomplete at the end of a chunk is charged to the seeder's single `maxFrameMemory` budget (default `MAX_FRAME_MEMORY`, 64 MiB): it reserves its declared length until it completes or the guard is destroyed, and is checked every 10 s for 64 KiB/s on average after a 10 s grace (a drip dies at 20 s, not 120 s). When a reservation does not fit, the slowest reservation older than 1 s is evicted (`frame-budget`) and the reservation retried once; only then is the requester refused. Handshake frames, keep-alives and frames that arrive whole are never charged, so a filled budget can neither refuse new members nor drop admitted ones (re-audit HIGH, CWE-400: 8 stalled 8 MiB declarations used to fill the budget for ~40 bytes and drop everyone at their next frame for up to 120 s). The caps are independent (`maxConnections` for swarm sockets, `maxExternal` for external ones), so the shared-sum race is gone. Remaining, bounded but not zero: `ws` buffers a whole WebSocket message, up to `MAX_PAYLOAD` (about 8 MiB), before FrameGuard sees it. Those are bytes the client really sent (not amplified), the 10 s handshake and 30 s idle deadlines drop a socket that stalls, and a partial message delivers nothing to the secret stream, so a stalled message pins at most `MAX_PAYLOAD` per socket for 30 s. Worst-case receive memory is about `maxExternal` x `MAX_PAYLOAD` + `maxFrameMemory`; size them together (section 21).
- Seeder WebSocket entry: swarm sockets keep secret-stream's own 16 MiB behaviour; the transport is plain `ws://` on loopback until the TLS proxy (Caddy) PR. (The per-frame allocation by a handshaken peer and the shared-cap race are addressed in section 21.)
- The shim's scalar multiplication is not constant-time; it mirrors libsodium's subgroup check, which accepts order-2L points (as libsodium itself does).
- dht-relay 0.4.3: the two upstream defects above, plus a third found by the security audit (a duplicate `noiseReply` stops the relay process); experimental; custodial mode leaks the secret key.
- A hosted PWA keeps the key on the device only as long as the served JavaScript is honest (whoever serves the page can change it).
- Hypercore 10 is the LTS line (wire-forward-compatible per the hypercore README) but receives fewer updates than 11.

### Go/no-go and estimates per later PR

**GO for the seeder path.** G1 and G2 passed; the browser-held key never leaves the device; the seeder admits and serves a Hypercore 10 diary to Hypercore 11 members. **The relay is not production-ready** with dht-relay 0.4.3 (two defects, one needing an adapter, one crashing the relay). Decision (seeder capacity PR, section 21): the relay is not pursued for this launch (dht-relay 0.4.3 defects; the spike is loopback-only). The seeder WebSocket path is the production entry, and the relay spike script stays a documented experiment.

The estimates below are rough, not measured (person-days with agent assistance):

| PR | Scope | Size |
|---|---|---|
| 2 | Browser node session behind `packages/rpc`, and `apps/app` web client using it instead of `varanda-serve` (dominated by porting the 15 RPC handlers onto Hypercore 10 and the browser storage, plus quotas and feeds) | medium, 3-5 d |
| 3 | PWA manifest, service worker, icons | small, 1-2 d; shipped, with an offline outbox, in section 11 |
| 4 | Identity derived from a passkey (WebAuthn PRF): no key at rest, nothing to wrap or back up; write gate, push and own-diary recovery; hosted `/varanda.json` auto-connect. Built as section 10; export/import of a wrapped key and the passphrase fallback were dropped by that design | done, section 10 |
| 5 | Caddy (automatic TLS) and compose serving the PWA and `wss:///seeder` on one origin, CSP with `'wasm-unsafe-eval'` | small, 1-2 d, plus the user's DNS and hosting steps |
| 6 | Hardening of the WebSocket entry for the internet, and the dht-relay decision (decided: not pursued for this launch, see above) | medium, 3-5 d |

### Shipped: the key from a passkey (supersedes the PR 4 wrap design of 2026-10-23)

The first PR 4 design (an AES-GCM wrap of a stored Ed25519 key, under a key from the passkey's PRF, plus a passphrase fallback and an export of the wrapped blob) was replaced before it was built. The shipped design stores no key at all, so there is nothing to wrap, export or recover from a file. It is described and verified in section 10; in short:

- the diary's Ed25519 key pair is **derived** from the passkey's PRF output (HKDF-SHA-256 over a fixed PRF input, with fixed labels), so the same passkey gives the same identity on every device that has it;
- nothing is wrapped or stored: the secret key lives only in the session's closure while unlocked, and Hypercore's header is written with `secretKey: null`;
- a browser or password manager without PRF is blocked, with no fallback (a passphrase fallback would be a second, weaker identity);
- what it protects against: the key read from disk or from a copied browser profile (there is none there). It does **not** protect against JavaScript served by the app's own origin while the key is unlocked (the hosted-PWA trust limit above), nor against a compromised device.

### Not verified

- The public DHT (everything ran on a local DHT bound to 127.0.0.1).
- Real TLS and Caddy (plain `ws://` on loopback only).
- Android and iOS Safari, and Firefox (only the Chromium-based built-in browser was used).
- Long-running sessions, and multi-MB diaries.
- Node 20 locally (Node v24.22.1 only; CI covers 20 and 24).

## 9. Browser node session (PR 2, 2026-10-23)

### Summary

- The web build of `apps/app` now runs its member UI against a node that lives in the page: the browser session of `@varanda/web-member` (Hypercore 10, IndexedDB) behind `@varanda/rpc`'s `createServerDispatcher` and `createClient`, wired in memory (no network RPC), syncing only through the seeder's WebSocket entry (`seed --ws-port`).
- The person types the association key and the seeder's address in a web Conectar form; the key never leaves the browser. The varanda-serve mode stays (a page opened with `#token=...`); the native paths are unchanged.
- Verified by CI tests (below) and by a live run in Chromium against a CLI seeder and a CLI member on a local DHT: posts crossed both ways, the identity survived a reload, a second tab was refused, and a continuous run downloaded a new post live.

### Machine and versions

As section 8 (macOS, Node v24.22.1, the Chromium-based built-in browser of the Claude desktop app), plus Expo 55.0.31, react-native-web 0.21.3 and, for the tests only, fake-indexeddb 6.2.5.

### What was built

- `packages/web-member/lib/node-storage.js`: the node's storage. On IndexedDB (database `varanda-node`), each file of each core is kept in 16 KiB pages and a write persists only the pages it touched, in one transaction (the spike adapter rewrote whole files); a key-value area holds `config` and `follows`. A memory twin runs the Node tests.
- `lib/node-store.js` and `lib/member-ops.js`: the counterparts of `@varanda/core` `store.js` and `member.js` (same results, messages and rules), including the own diary limits (`MAX_BLOCK_BYTES`, `MAX_LOG_BLOCKS`, `MAX_LOG_BYTES` -> `'limite do diário atingido'`).
- `lib/sync.js`: the counterpart of `runSync` for one seeder over a WebSocket: the same follow states (pending, regate, active, failing, failed), the quarantine gate (block 0 fetched into a Hypercore 10 core in memory, verified with `certForKey` against the association, and the signed length and byteLength checked against the quota, before the replica is opened in the storage), the local re-gate, the fork and quota watchers, the same events and SyncResult. Nothing replicates before the seeder's hello verifies (`seederCertForKey` on its Noise key); an ephemeral Noise key per connection; re-dial with a backoff of 1 s doubling to 30 s.
- `lib/session.js`: the counterpart of `@varanda/core` `session.js` (one request at a time, preemption and restart of a continuous run, the error table, `publicDht: false`); `lib/node.js`: the dispatcher over a text port; `lib/seeder-url.js`: the address rule (ws/wss, no credentials, query or fragment).
- `web/node.js` and `scripts/build.js --node`: the bundle `varanda-node.js` (551,644 bytes, 167,724 gzip, the same forbidden-module check and sodium shim as the spike), which defines only `VarandaWebNode.start()` and takes the Web Lock `varanda-node` (a second tab gets `LOCKED`).
- `apps/app`: `src/client/mode.js` (varanda-serve when the page has `#token=`, else the browser node), `src/client/browser.js` (loads `/varanda-node.js` once and wires the client), `connect.web.js`, `configStore.web.js` (the non-secret configuration in `localStorage`), `checkWebForm` in `src/config.js`, the web Conectar form in `Conexao.js`; Metro now also blocks `packages/web-member`; scripts `build:node`, `web` and `export:web`.

### Automated (CI)

| File | Tests / asserts | What |
|---|---|---|
| `packages/web-member/test/session.test.js` | 10 / 97 | every handler the app uses, errors, the diary quota, a restart over the same storage, a timeout with no seeder (no address in any event), preemption and restart, connections |
| `test/sync-gate.test.js` | 2 / 22 | a fake seeder certified by the association serves a foreign-association diary, one with no certificate and one over the quota: none is stored; an impostor seeder gets no block and no announce |
| `test/node-storage.test.js` | 5 / 32 | paged files, cores, the key-value area and a Hypercore 10 diary reopened from IndexedDB (fake-indexeddb) |
| `test/node-bundle.test.js` | 1 / 15 | the built `varanda-node.js` evaluated as a script, over IndexedDB and a `WebSocket` global, admitted by a seeder and reopened |
| `test/session-e2e.test.js` | 1 / 43 | the web session and a CLI member exchange posts and a reply through a CLI seeder (`seed --ws-port 0`), about 2.8 s |
| `apps/app/test/config.test.js` | 7 / 77 | the web Conectar rules, checked against the node's address rule |

### Live run in Chromium

Commands (loopback only): `node apps/cli/scripts/local-dht.js --port 49811`; `assoc init`, `seed key`, `assoc certify-seeder`, `seed cert add`; a CLI member (`id create`, `assoc certify`, `cert add`, `profile set` "Caio do terminal", a post, `sync --once`); `seed --ws-port 8799 --bootstrap 127.0.0.1:49811 --dht-host 127.0.0.1 --json`; `npm run web -w apps/app`; the page at `http://localhost:8081`.

- Conectar (association, `ws://127.0.0.1:8799/seeder`) -> the Identity step; "criar identidade" -> key `a9a12e9b...`; the certificate from `assoc certify` pasted -> the tabs.
- Seguindo: followed the CLI key; a post "Primeira publicação feita do navegador!"; "sincronizar uma vez": `sync ready`, `peer seeder 5c4757ba`, `admitted a9a12e9b... 0`, `have a9a12e9b... 2`, `downloaded f87c20b0... 3`, run done. Seguindo then showed the name "Caio do terminal", and A Rua both posts.
- The CLI member followed the browser key: `sync --once` -> `downloaded {a9a12e9b...: 2}`, `seederConfirmed: true`; its `feed` lists the browser post.
- Reload: the node reopened from IndexedDB with the same identity, follows and replica; `localStorage` held only `varanda-web-config` (association and address); `sessionStorage` empty; one IndexedDB database, `varanda-node`; no console errors.
- A second tab: "outra aba já usa o Varanda neste navegador" in its Conectar.
- "sincronizar sempre", then a new CLI post synced to the seeder: the running browser run printed `have f87c20b0... 4` and `downloaded f87c20b0... 4` with no request from the page; "atualizar" showed the post (the request preempted the run, which restarted).
- At 375 px wide: no horizontal overflow (scrollWidth 375).
- The seeder's log names no client address (its only address is its own `ws` line).
- The app's Metro bundle (585 KB) contains no Hypercore or sodium code; the export copies `varanda-node.js` next to `index.html`.

### Decisions

- The session mirrors the core session's preemption: a member request stops a running sync and a continuous run restarts after it. Two Hypercore instances on one browser storage would corrupt it, and the app was built around that contract. Cost: during a continuous run each member request reconnects to the seeder.
- The node is a separate esbuild bundle loaded at run time, not part of the Metro bundle: the sodium shim, the `events` shim and the forbidden-module check already exist for esbuild, and Metro keeps blocking the node code.
- The node runs on the page's main thread (no Worker).
- A minimal cross-tab guard (the exclusive Web Lock) landed here rather than in PR 4, because two tabs on one IndexedDB diary corrupt it.

### Limits and open risks

- (At the time of this section) the key was still unencrypted in IndexedDB, with no backup or export. Superseded by section 10: the key is derived from a passkey and never stored; clearing site data does not lose the identity.
- Each file of an open diary is held whole in memory; `feed.read` opens every followed diary in turn.
- One seeder is the only peer: with it down, nothing syncs (no DHT, no relay).
- `ws://` is accepted for any host (the Noise stream is end-to-end encrypted and the seeder is verified by its certificate, but the WebSocket itself is not); an https page needs `wss://`, which only arrives with the hosting PR.
- Without the Web Locks API (old browsers) two tabs are not stopped.
- Hypercore verification and the sodium shim run on the main thread; a large first sync may stall the UI briefly.
- The hosted-PWA trust limit of section 8 holds: whoever serves the page can change its code.
- Found, not fixed (pre-existing, from the new design): on the web the Diário's gear is covered by the profile header row and does not open Ajustes; Ajustes is reachable from the sync chip.

### Not verified

- Firefox, Safari (desktop and iOS) and Chrome on Android.
- A static export served with a CSP (only the Expo dev server was used live; the export was built and inspected).
- TLS (`wss://`), a public host and the public DHT.
- Long sessions, multi-MB diaries and IndexedDB eviction under storage pressure.
- Node 20 locally (CI runs 20 and 24).

## 10. Identity from a passkey (PR 4, 2026-10-24)

### Summary

- The browser member's identity is **derived** from a WebAuthn passkey with the PRF extension; the key is never stored. The same passkey (for example in the Google Password Manager, which syncs it) opens the same identity on any device.
- On a hosted installation the page configures itself from `https://<host>/varanda.json`; the person only presses "Entrar".
- Writes are gated on catching up with the seeder and are pushed to it right after; a member on a new device recovers the own diary and certificate from the seeder.
- Verified by Node tests (below) and by a headless Chrome 156 run against a CLI seeder with a CDP virtual authenticator with PRF (scenarios A to I, below). Not verified on real devices or real providers: see the Human verification checklist.

### Design as built

- **Derivation (`packages/web-member/lib/passkey.js`, version 1).** `prf = PRF(credential, utf8('varanda/member-identity/prf/v1'))` (32 bytes); `seed = HKDF-SHA-256(ikm = prf, salt = utf8('varanda/member-identity/hkdf/v1'), info = utf8('varanda/member-identity/ed25519/v1'), 32 bytes)`; the key pair is `hypercore-crypto.keyPair(seed)` (Ed25519 from the seed). Nothing else enters it (not the challenge, credential id, rp.id, device or association). Changing any label changes every member's key. The labels are raw UTF-8 bytes so the ceremony options are built synchronously, inside the click.
- **Nothing wrapped or stored.** The pair is installed in the session by `setKeyPair` (copied synchronously, the caller zeroes its own copy), kept only in the session's closure, and zero-filled on lock, reset or close. The diary's Hypercore header is written with `secretKey: null`, and the session hands the pair to the core after it opens (Hypercore keeps it in memory only). The page never receives the key: no getter, no signing call, and RPC results never carry a secret. The only thing stored besides the diary is the non-secret record `{ v: 1, credentialId, rpId, userId }` in the key-value area (`passkey`).
- **No PRF, no identity.** A browser or password manager without PRF is blocked with `NO_PRF` and no fallback. A passkey that was created but gave no PRF stays in the manager; the page names it (the text says to delete the passkey "Varanda xxxxxx" from the password manager, where `xxxxxx` is the first six hex digits of its user handle) and excludes it from the next creation.
- **`rp.id` is the exact host** (`rpIdFor`: no widening to the registrable domain, no IP literal; development uses `localhost`). Why: the apex `varanda.app` is a separate GitHub Pages origin, and with a widened `rp.id` any origin under the apex could ask for this passkey's PRF. Consequence: the passkey is bound to the host. Moving the app to another host later needs WebAuthn Related Origin Requests from the old host (or the members lose the passkey's use on the new one); this is not built.
- **The passkey options.** Discoverable credential (`residentKey: 'required'`), `userVerification: 'required'`, `user.id` = 32 random bytes with the label `Varanda <6 hex>` (never an email or a Google identifier), timeout 120 s, PRF eval input as above. Some authenticators report PRF as enabled at creation and return the result only on `get()`: the creation then resolves `{ pending: true }` and a second click (`complete`) fetches it.
- **Write gate.** Before `cert.add`, `profile.set`, `post.create` and `post.reply` the session requires the key (`USAGE 'identidade bloqueada: entre com a passkey'`; `NOT_FOUND 'identidade não encontrada'` with no identity), then catches up with the seeder (an internal once run, event line `sincronizando antes de publicar`, default timeout `writeGateTimeoutMs = 15000`, skipped while a continuous run already has the own diary synced), writes, then pushes (`enviando ao semeador`; a continuous run is restarted to push instead). **Its limit, stated plainly:** the gate only narrows the window. Two devices that write at the same head within seconds of each other, or a device that is offline when it writes, can still fork the diary, and the seeder purges a forked diary (the fork watcher, as for any member). This is a known open risk for a future PR (a stronger writer lease or conflict handling), not solved here.
- **Own-diary recovery.** On a new device (or after clearing site data) the same passkey derives the same key; the session fetches the own diary and the member certificate from the seeder before any write (event lines `diário próprio sincronizado (<n>)`, `diário próprio atrasado (<n>/<m>)`, `certificado recuperado do semeador`).
- **Legacy store.** A store written before the passkeys (key kept in the browser) is never opened with a derived key. On its first open under this code the node wipes the stored secret (zero-filled, removed from the header, both oplog header slots rewritten and their tails zeroed; the decision reads both raw slots and their tails, so a wipe interrupted at any step is finished by the next open; `packages/web-member/lib/node-store.js` `scrubLegacySecret`): the diary stays readable and is never writable again. The page offers "apagar o diário e recomeçar", which calls `reset` (`deleteCore('diary')`). The old identity cannot be reconstructed and needs a new certificate; the operator removes the old key from the seeder with `seed drop`. `MISMATCH` (`'passkey não corresponde ao diário guardado'`) is raised when the stored diary belongs to another key; `legacy` is set for the old kind while the page stays open (after a reload the wiped store reports as a plain mismatch). This closes a finding of the security audit (raised to high): until this change the old secret stayed in IndexedDB until the member chose to reset.
- **Certificates never expire.** The old test identity's certificate stays valid and the seeder still holds its diary: the operator removes it with `seed drop`.
- **The PR B seam.** The certificate step (`CertificateStep` in the app) is where the future automatic certification attaches: it will need a domain-separated challenge signer in the node (so that the member can prove the key to the certifier without exposing it). Not built; the page still takes the certificate by paste.
- **Hosted configuration.** `deploy/seeder/Caddyfile` serves `/varanda.json` = `{"v":1,"association":"<VARANDA_ASSOCIATION>"}` (never an address: the page uses `wss://<its host>/seeder`); compose refuses to start without `VARANDA_ASSOCIATION` and `deploy.sh` refuses to deploy without a valid one and, when the Caddyfile has the handle, probes the body byte for byte. Local development keeps the manual Conectar form.

### Automated (CI)

`npm test -w packages/web-member` (14 test files, 0 failures) on the final code:

| File | Tests / asserts | What |
|---|---|---|
| `test/passkey.test.js` | 14 / 161 | a golden vector (fixed PRF, fixed seed and public key), the raw UTF-8 v1 labels, `rpIdFor`, `supportStatus`, the ceremony options, `register` (including pending then `completeRegistration`), `signIn`, the error mapping, zeroing |
| `test/node-storage.test.js` | 9 / 92 | the paged storage, a Hypercore 10 diary on IndexedDB that survives a close without its secret, a legacy store (secret in the header) whose secret is wiped on the first open (no IndexedDB page or memory file holds it afterwards), readable and never writable, a wipe cut short after its first header write, and one cut short before its tail writes, both finished by the next open (the decision reads both raw oplog header slots and their tails; no 8-byte window of the seed survives) |
| `test/session.test.js` | 16 / 176 | the RPC handlers and the session's passkey controls (`setKeyPair`, `clearKeyPair`, `identityStatus`, `reset`), mismatch and locked behaviour, the gate with an unreachable seeder, a client detaching during the gate (nothing written, no run restarted), a legacy store wiped on first open |
| `test/passkey-e2e.test.js` | 1 / 98 | two browser sessions with the same key pair through a CLI seeder: the write gate (catch-up first, refused when the seeder is unreachable), the push the seeder confirms, own-diary and certificate recovery on a fresh device, interleaved writes |
| `test/node-bundle.test.js` | 1 / 91 | the built `varanda-node.js` evaluated as a script with a faked `navigator.credentials`, over IndexedDB against a seeder: the frozen handle exposes only `connect`, `close` and `identity` (no getter, no signer) |
| `test/sync-gate.test.js` | 4 / 46 | the quarantine and quota gate; an inventory completed only by the timeout leaves the own diary unknown (no `done`, no write); a write pushes while the seeder has not confirmed the local length, an idempotent `cert.add` included |

`apps/app` `test/config.test.js` covers `hostedConfigOf` and `isHostedPage`.

### Browser end to end (headless Chrome 156, CDP virtual authenticator with PRF)

A production export served by a static server with the production CSP, a CLI seeder on a local DHT with `--ws-port`, `/varanda.json` served as in production. All nine scenarios passed:

| | Scenario | Result |
|---|---|---|
| A | First visit | the page configured itself from `/varanda.json` (no Conectar) and showed "Entrar" |
| B | "criar passkey" | a passkey with PRF created; identity key derived; the diary created |
| C | Certificate | the member certificate pasted and stored; the tabs appear |
| D | Post | published through the write gate and pushed: the seeder logged `admitted` and `have` for the member's key |
| E | Reload, then "entrar" | the same key, the same posts |
| F | "bloquear identidade" | the key dropped from memory and the page returned to Entrar |
| G | Authenticator without PRF | the notice, including the hint to delete the passkey "Varanda xxxxxx"; no identity created |
| H | A different authenticator (new passkey) | a different key from the first passkey's |
| I | Site data cleared, same passkey | key, posts and certificate recovered from the seeder in about 2 s |

The production CSP raised no violation in any scenario. The seeder log names no client address.

### Limits and open risks

- **Fork risk.** The write gate does not prevent two devices from forking the diary (see above). A fork gets the diary purged by the seeder. Open; a future PR.
- **Lost passkey = lost identity.** There is no recovery file, by design. The page says so.
- **One passkey, one identity.** The OS may offer another provider (an iPhone with iCloud Keychain); a passkey from another provider is another identity and needs a new certificate.
- **Host-bound.** A host move needs Related Origin Requests from the old host (not built).
- **Hosted-PWA trust limit.** Whoever serves the page can change its code; the key is in memory while unlocked.
- **The first deploy with this change runs the previous `deploy.sh`** (no `/varanda.json` probe, and a missing `VARANDA_ASSOCIATION` makes compose fail and roll back): the operator adds `VARANDA_ASSOCIATION` to the server's `deploy/seeder/.env` before the merge, and checks `/varanda.json` with curl after it.
- Real providers were not tried (only a virtual authenticator): whether Google Password Manager, iCloud Keychain, Windows Hello or Firefox return PRF is for the checklist below.

### Human verification

- [ ] `curl -i https://<host>/varanda.json` returns 200, `application/json`, `Cache-Control: no-store` and `{"v":1,"association":"<64 hex>"}` with the association the seeder trusts.
- [ ] Chrome on a computer with the Google Password Manager: first visit, "criar passkey", certificate, a post; the passkey is listed as `Varanda xxxxxx`.
- [ ] Reload, then "entrar": the same key and posts.
- [ ] Android with the same Google account: "entrar" gives the same key; the own diary and certificate are recovered; a post right after a post from the computer passes the gate without a fork.
- [ ] iPhone (Safari): which provider the OS offers (iCloud Keychain gives another identity); whether PRF works.
- [ ] A browser without PRF (for example Firefox, if it lacks it): the notice, no identity created.
- [ ] The old test identity: the page offers "apagar o diário e recomeçar"; after it, a new identity and a new certificate; the operator runs `seed drop` for the old key.

## 11. Offline PWA and outbox (web)

### Summary

- The hosted web app is installable and opens offline: a service worker precaches the shell of one release, and a person who has already entered once reads the three tabs from the diaries kept on the device, without waiting for the seeder.
- Posts and replies written while the node cannot publish go to an outbox kept on the device and are sent later through the same RPC methods; the diary stamps their date when they are really appended.
- Verified by Node tests (below). The browser end to end is **not run in CI**, and installation on real devices is for the Human verification checklist.

### Design as built

- **Files.** `apps/app/scripts/sw.js` (the worker template, never served as is), `apps/app/scripts/finish-web.js` (renders `dist/sw.js` after `expo export`), `apps/app/src/pwa-boot.js` (pure registration guard), `pwa.web.js` / `pwa.native.js`, `online.web.js` / `online.native.js`, `discovery.js`, `recoveryPolicy.js` and `persist.js`. The outbox: `apps/app/src/outbox.js` (pure rules, no imports), `outboxStore.web.js` / `outboxStore.native.js` (storage) and `outboxProvider.js` (React provider and the drain), used by `Publicar.js`, `Diario.js` and `Identidade.js`.
- **Build.** `npm run export:web` ends with `node scripts/finish-web.js`, which writes `dist/sw.js` and a `<meta name="varanda-release" content="<id>">` into `dist/index.html`. The id is the first 16 hex digits of a SHA-256 over the template and every file under `dist` (except `metadata.json`, `sw.js` and source maps), so any changed byte is a new release. The precache list holds `{ url, sha256 }` per file. A second run on the same `dist` is byte-identical. `deploy/seeder/build-web.sh` and `deploy.sh` require `sw.js` in the build.
- **Registration guard.** `pwaBoot` registers `/sw.js` (scope `/`, `updateViaCache: 'none'`) only in browser mode, on a hosted https page, when the document carries the release meta and the browser has service workers. It never unregisters anything: localhost, varanda-serve mode (same web client module) and a document without the meta neither register nor touch other registrations.
- **Worker strategy.** Install fetches every precache entry with `cache: 'reload'`, no credentials and `redirect: 'error'`, and checks each: HTTP ok, not opaque or redirected, not `text/html` (except `/index.html`, which must be HTML and carry this release's meta), and the SHA-256 equals the one in the list, `index.html` included. Only when all pass is anything stored; a store that fails half way is deleted. That content-type guard is what stops a hosting with an SPA fallback from caching `index.html` in place of a missing script. Fetch handling: navigations are network first, never stored, and fall back to this release's cached `index.html` when the fetch fails and also on a 404 or 5xx answer (a reload while a deploy empties the directory); `/varanda-node.js` is network first, with the cached copy on a failed fetch, on a 404/5xx or on an HTML answer; every other same-origin GET is cache first, and a miss goes to the network and is **not stored** (no runtime caching: a miss is a file outside this release's verified precache, for example a newer release's file still being copied, and keeping it could pin a broken file). HTML answered to a non-navigation request becomes a 503. `/varanda.json`, `/sw.js`, `/seeder` and `/seeder/...` are never intercepted; non-GET and cross-origin requests are left alone.
- **Cache naming and versioning.** One cache per release, `varanda-shell-<id>`. Activation deletes every `varanda-shell-*` cache except its own.
- **No `skipWaiting`, no `clients.claim`.** A new release installs in the background and waits until every window of the previous one is closed. Consequence: an open page never sees its caches change under it, and a person who keeps one window open for days stays on the old worker. Because navigation is network first, a reload online already loads the new page; only the offline fallback and the cached assets lag until the old windows close.
- **The remembered configuration.** `/varanda.json` is classified from its headers before any body read. Transport (the installation did not answer): the fetch threw or hit the 8 s abort, a redirect, or status 408, 429 or 5xx. Authoritative failure (it answered, and the answer is not a configuration): any other non-2xx status, a content type that is not JSON, an oversized or non-UTF-8 body, invalid JSON or a bad shape. Only a 2xx JSON body is read, with a bounded 4 KiB reader inside the abort; a failure while reading that body counts as transport. On a valid answer the association is stored apart, bound to the origin (`localStorage` key `varanda-web-discovered`, `{ v: 1, origin, association }`, not a secret). It is used **only on a transport failure**; an authoritative failure never falls back to it, so a server that deliberately answers something else is not overridden by an old copy. A stored seeder address is never trusted: the seeder is always this origin's `/seeder`. A configuration typed into the Conectar form keeps `varanda-web-config`.
- **Recovery policy** (`blockingRecovery`). A device whose diary already holds its member certificate opens its tabs at once, with no blocking recovery run (a hidden run would be preempted by the first read anyway). Without the certificate the recovery run is what brings the diary from the seeder, so it blocks while the browser may be online and does **not** block when `navigator.onLine` is false. Going offline cancels the recovery the provider started and its run, so the local tabs are not held for up to the 30 s timeout.
- **Persistence.** `persist.js` asks `navigator.storage.persist()` and never rejects; a grant only lowers the odds of eviction (see the limits).
- **The outbox data model.** One `localStorage` value, `varanda-web-outbox`, `{ v: 1, items }` (native has its own store). An item: `id` (16 hex), `author` and `association` (64 hex), `kind` (`post` or `reply`), `to` (`author:seq` for a reply, else null), `text`, `writtenAt` (when the person wrote it, for ordering only), `state` (`queued`, `sending`, `uncertain`, `failed`), `attempts`, `nextAt`, `floorSeq`, `attemptAt`, `lastError`. Parsing drops malformed items; a `sending` item without a floor becomes `uncertain`. At most 50 items per author; an item is bound to its author and association pair. Text the diary refuses (C0 controls except LF, DEL and C1, U+2028/2029, the bidi controls) is refused at enqueue time, so a queued post is never stuck.
- **The append-time date decision.** The RPC parameters are only `{ text }` or `{ to, text }`, never `at`: the diary stamps the date at the moment of the real append. A post written offline and sent hours later appears in Diário and A Rua with the new date, not the date it was typed. `writtenAt` is never published.
- **Drain gating.** One step at a time, only when the screen is enabled, the identity is unlocked (author known), the association is known and the store is available. A step runs on a change of the queue, of the online state or of the seeder confirmation, and on a timer for the next due item. The queue wakes (`nextAt` of the queued items set to now) when the browser goes from offline to online and when a sync run stops with `seederConfirmed`. Failures that wrote nothing (the write gate refused, identity locked, busy, closed, no node, too many requests) put the item back to `queued` with a backoff of 30 s, doubling to a cap of 300 s. Any other error marks the item `failed` (manual retry or removal). A store that cannot save blocks the drain for one backoff period.
- **Claim before send.** A step first reads the own diary (`log.read`), reconciles, and only then claims the next due item: it saves `state: 'sending'`, `attemptAt` (now) and `floorSeq` (the diary's highest seq, invalid blocks included) **before** the request goes out. A request that never resolved, or a reload in the middle, therefore leaves a durable `sending` item. Nothing is sent while any item of the pair is `sending`.
- **Reconcile before resend (final rule, approved after two review rounds).** The node appends before it pushes to the seeder, so an unresolved request may have written the post. For the `sending` item, the candidates are posts identical to it (text and reply target) with `seq > floorSeq`. The item is **sent** (removed, reported as published) only when a candidate is dated at most 2 s before `attemptAt` (`attemptAt - 2000 ms`) and no later than 60 s after it (`ATTEMPT_WINDOW_MS`; the request itself times out after 30 s, `packages/rpc/lib/limits.js`): the diary stamps the date at append time, right after the claim. Any other candidate makes the item **uncertain**. With no candidate, the item goes back to `queued` only if the log page **covers** the floor, `entriesTruncated <= floorSeq + 1` (the page reaches back to the first block after the claim, so the absence is provable); if it does not, or the page is malformed, the item is `uncertain` too. That is the **page-coverage rule**: an unprovable absence is never read as absence. Two failure modes found in review are both closed by this strict rule: (1) an identical post from another device (replicated above the floor by the write gate's catch-up) taken for this send, which would have silently dropped the person's post; it is dated outside the attempt, so it is only a candidate and the item is `uncertain`; (2) a clock moved backward, so that our own append is dated before the window; it is also `uncertain`, never resent. In both cases the cost is a human decision, never a loss or a duplicate.
- **Automatic send is scoped to the page session.** The stored queue is not authenticated: any script of the origin can write `localStorage`, also while the identity is locked (DevTools on a shared or unattended computer, an extension), and before this rule an item planted there was signed and published with the member's key at the next "entrar", with no action by the member (CWE-345, found by the pre-push security audit). The provider keeps an in-memory map of approvals, never persisted (anything stored can be planted): the items `add` wrote in this page session and the items the person released by hand ("enviar", "enviar todos", "tentar de novo"). An approval is bound to the item's content (author, association, kind, reply target and text), not only to its id: a stored item whose content was changed after it was approved (the same id, another text, e.g. while the identity is locked but the page stays open) is no longer approved and waits for the person again (found by the review of the first fix). An approval is spent by the attempt it allows (it is dropped when the item is claimed and restored only after a retryable failure that wrote nothing), so an item restored into storage after its publication waits again; and a queued reply shows its target ("resposta a <nome> · #seq") before it is approved, since the approval covers the target (both found by the review of the second fix). The drain claims the next item only among approved items (`nextToSend` / `nextDueAt` on the stored queue filtered to the approvals) and still claims nothing while any item of the pair is `sending`. Reconciliation is unchanged and still settles any `sending` item of the pair (it never resends); an item it puts back to `queued` is sent again only if it is already approved, so a post left in the middle of a send by an earlier session waits for the person. Diário shows a queued item that is not allowed as "guardado antes: confira o texto e toque em enviar", with "enviar" and "descartar", and "enviar todos" under the section header.
- **Never resend `uncertain`.** An `uncertain` item is never sent again automatically and never removed automatically. The person sees the text with the notice "incerto: pode ter sido aplicado; confira antes de repetir", checks the diary, and then discards or queues it again by hand. A `sending` item cannot be removed or re-queued by hand until it is reconciled.
- **Lock and reset.** Locking the identity keeps the queue (bound to the author; after "entrar" in the same page session it drains again, and after a reload it waits for "enviar"). "recomeçar" (`reset`) drops the author's items, since that identity's diary is gone.
- **Caddy cache and 404 rules** (`deploy/seeder/Caddyfile`). Every static file, the hashed names under `/_expo/` and `/assets/` included, is `Cache-Control: no-cache` (revalidated by ETag on each load). There is **no immutable or long cache**, on purpose: the deploy replaces the files of `www` in place (`find -delete`, then `cp -R`) while Caddy keeps serving, and a file read half way during the copy, or a 404 during it, would get a year of cache that the browser never revalidates; with `no-cache` it gets another ETag when the copy ends and heals on the next load. The worker already serves the hashed files from its own verified cache, so a long HTTP cache would add little. A 404 is `no-store`: a path with an extension that is not a file, and a path without an extension when `index.html` itself is missing. A path without an extension is an app route and answers `index.html`; a path **with** an extension is a file or a real 404, never `index.html` (with `nosniff` it would blank the page). `/manifest.webmanifest` is `application/manifest+json`. `/varanda.json` keeps `no-store` and its own handle; `/seeder` is untouched. The CSP is unchanged (`worker-src 'self'` and `manifest-src 'self'` were already in it).
- **Deploy probes.** `deploy.sh`'s web probe now also requires `sw.js` and the hashed bundle named in `index.html` to be served byte for byte, when they exist in `www`.
- **Rollback analysis.** A rollback recreates Caddy with the previous Caddyfile and serves the previous `www`. With the previous Caddyfile, `/sw.js` answers `index.html` (its SPA fallback), which is not a script, so the browser rejects the update and the installed worker **stays**. The installed worker's navigations are network first, so the rolled-back code is served whenever there is network, and only offline does the cached shell answer. A later deploy with a worker replaces it. The probe skips `sw.js` when `www` has none, so a rollback to a release without a worker still passes its health gate.
- **The worker re-verifies what it serves.** The Cache API is writable by any same-origin script, so a copy that passed install may have been replaced since. Every cached response is checked again against `PRECACHE` (SHA-256, and the release meta for `index.html`) before it is returned; a copy that fails is a miss (deleted), and an entry outside the precache list is never served.
- **The first deploy with this change runs the previous `deploy.sh`** (bash read the whole file before the reset to the new commit): none of the new probes run, so that first deployment is checked by hand with curl (checklist below).

### Automated (CI)

New or extended tests, run with the workspace runners (`npm test -w apps/app`, `npm test -w apps/cli`):

| File | Tests | What |
|---|---|---|
| `apps/app/test/sw.test.js` | 18 | `finishWeb` (precache list, release meta, byte-identical second run, any byte changes the version, incomplete export refused); the worker in a fake environment: install under absolute URLs, install fails on the SPA fallback, a changed byte or another release, activation drops older shells, navigation network first with the cached shell offline and on 404/5xx, an opaque redirect passed on, cache-first assets with a miss not stored and HTML refused, `/varanda-node.js` fallbacks, bypassed requests, 503 with nothing cached, a half-failed store dropped; cache poisoning: a poisoned hashed bundle, `index.html` or `/varanda-node.js` in the cache is never served, and an entry outside the precache list is never served and is deleted |
| `apps/app/test/outbox.test.js` | 28 | parse and serialize, malformed items dropped, enqueue validation (the diary's forbidden text refused), the 50-per-author limit, ordering and `nextToSend`, `claim`, the `reconcile` cases (the attempt window, an identical post from another device, coverage by `entriesTruncated`, a malformed page, two identical texts), backoff 30 s to 300 s, `markQueued`, `wake`, `remove`, `classifyFailure`, `rpcParams` without `at`, `maxSeq`, `hexId` |
| `apps/app/test/discovery.test.js` | 5 | transport versus authoritative failures, the read flags (oversized, invalid text), a valid answer, the remembered association (same origin only) |
| `apps/app/test/recoveryPolicy.test.js` | 2 | certified never blocks; without the certificate it blocks unless offline |
| `apps/app/test/pwa-boot.test.js` | 2 | registers only for the full combination; never unregisters |
| `apps/app/test/persist.test.js` | 2 | no storage or no `persist`; the boolean of `persist()`, never rejecting |
| `apps/app/test/pwa.test.js` | extended | the web shell assertions of the existing file |
| `apps/cli/test/caddyfile.test.js` | 4 | CSP unchanged; existing blocks kept; the cache headers (no long cache, 404 `no-store`); the SPA rule only for paths without an extension |
| `apps/cli/test/deploy.test.js`, `apps/cli/test/serve.test.js` | extended | the deploy script's new probes and the static server's handling of the new files |

The session-scoped automatic send (the allowed-id set in `outboxProvider.js`, and the "enviar" buttons in `Diario.js`) has **no Node test**: the app tests cannot import React; `outbox.js` is unchanged by it.

The totals of the whole run are recorded by the integration run, not here.

### Browser end to end

**Not run in CI.** The worker is registered only on a hosted https page, so the local dev server cannot exercise it. Steps (production, or a staging host with TLS):

1. Open the hosted page in Chrome, enter (create or use the passkey), wait for the diary to sync. In DevTools, Application, check that `/sw.js` is activated and `varanda-shell-<id>` holds the precache.
2. Go offline (DevTools network, or airplane mode) and reload: the shell opens from the cache.
3. "Entrar" offline with the platform authenticator, then open the three tabs: they read from the local diaries with no 30 s wait.
4. Publish a post and a reply offline: they show as queued.
5. Go online: the queue drains without a reload and the posts appear in Diário and A Rua with the new date.
6. Lock the identity with posts queued: the queue stays; "entrar" drains it. "recomeçar" drops it.
7. Open a second tab: it is refused.
8. Deploy a new release: a reload online shows it; after every window is closed, the new worker takes over and the old cache is deleted.

### Limits and open risks

- **Authenticator offline is platform-dependent.** Whether the passkey ceremony (and its PRF) works with no network depends on the platform and password manager. Not verified on real devices.
- **IndexedDB eviction.** `navigator.storage.persist()` may be denied, and a browser under storage pressure can evict the diaries and the outbox despite it. The diaries come back from the seeder; a queued post that was never sent does not.
- **One window.** The browser node holds an exclusive Web Lock, so a second window or tab is refused.
- **Outbox queue and Web Locks (known, not fixed).** The queue is one `localStorage` value updated by read-modify-write. Without the Web Locks API, two windows could both run and a concurrent enqueue in each could lose one item (a reviewer reported it as P1). It is unreachable in practice: every browser that can enter (WebAuthn PRF: recent Chrome and Edge, Safari 18) has Web Locks, which keep a second window out, and without Web Locks the diary itself is already unprotected.
- **Queued text is cleartext.** The outbox is plain JSON in `localStorage` and is kept while the identity is locked, so anyone with access to the device or the origin can read the unsent texts. The session-scoped send stops a planted item from being published automatically, not from being read or changed; the person confirms items from an earlier visit by reading them. A queue sealed with a key derived from the passkey is a possible follow-up.
- **An `uncertain` item needs a human decision.** The strict reconcile rule trades automation for safety: it never resends and never drops a post it cannot prove.
- **An RPC success is not delivery.** A resolved `post.create` / `post.reply` means the block was appended locally and is pushed now or retried on the next write; it is not a confirmation that the seeder has it.
- **Mixed releases.** A page of release N+1 (network-first navigation) whose `/varanda-node.js` fetch fails while the release-N worker still controls it gets release N's node. The app refuses a node whose `VarandaWebNode.version` differs from the one it expects (`apps/app/src/client/browser.js`). **Rule: any breaking change to the browser node or to its IndexedDB schema MUST bump that version.**
- **The deploy probe lags one deploy.** The `sw.js` and bundle probes run from the deploy after the one that introduces them, while the Caddyfile applies on the deploy that introduces it.
- **`publicar_web` empties `www` before copying.** A precache that fails during that window keeps the previous worker.
- **The Caddy header and rewrite syntax was validated only as recorded in the PR notes.** `caddyfile.test.js` checks the file's text, not Caddy's parser; run `caddy validate` or watch the first deploy.
- **The write gate's fork window between two devices is unchanged** (section 10).
- **Updates need the old windows closed.** With no `skipWaiting`, a long-lived window delays the new worker.

### Human verification

- [ ] Android, Chrome: install the app (install prompt or Add to Home screen); it opens in its own window with the icon.
- [ ] Android, Samsung Internet: no "Instalar" note or button and no install icon in the address bar; the menu's add to Home screen gives no Play Protect "App de risco bloqueado".
- [ ] iOS, Safari: Add to Home Screen; it opens full screen.
- [ ] Open it offline: the shell loads.
- [ ] "Entrar" offline works with the platform authenticator (record which platforms do not).
- [ ] The three tabs read from the device without the 30 s wait.
- [ ] Publish offline: the post is queued and shown as such.
- [ ] Reconnect: the post appears in Diário and A Rua with its new date, and the queue is empty.
- [ ] Lock the identity with a queued post: the queue is kept; after "entrar" it drains.
- [ ] Queue a post offline, close the app and reopen it online: the post waits in Diário › Fila de saída with "enviar" / "enviar todos" and nothing is published until it is tapped; a post written in the reopened page is still sent by itself.
- [ ] With the identity locked, plant an item in `localStorage` (`varanda-web-outbox`) from DevTools, then "entrar": it is listed with "enviar" and is not published.
- [ ] From DevTools, overwrite the cached bundle in the `varanda-shell-<id>` cache, then reload offline: the worker refuses it (503) instead of running it, and drops the entry.
- [ ] "recomeçar" drops the queue.
- [ ] A second tab is still refused.
- [ ] `curl -I https://<domain>/_expo/static/js/web/missing.js` is 404, not 200.
- [ ] `curl -I https://<domain>/sw.js` is 200 with a JavaScript content type and `Cache-Control: no-cache`.
- [ ] `curl -I https://<domain>/manifest.webmanifest` is `application/manifest+json`.
- [ ] `curl -I https://<domain>/varanda.json` keeps `Cache-Control: no-store`.
- [ ] The first deploy with this change runs the previous `deploy.sh`: check the items above by hand. The deploy log of the **second** deploy shows the probe of `sw.js`.
- [ ] Operator steps: no new `.env` variable; after the first deploy run the curl checks above, and roll back with the usual procedure if something is wrong (see the rollback analysis).

## 12. Google account link, @username and automatic certificate (PR B1, 2026-10-24)

### Summary

- A member on the hosted page links the passkey-derived diary key to a Google account, picks a @username and receives, with no operator step, a **member certificate v2** (`ageBand: 'unchecked'`, `method: 'google'`, signed by an *issuer* key that the association delegated) plus a signed **username record** that goes into the diary. The @username can be changed once every 7 days.
- Verified by Node tests (below). Not verified with the real Google consent screen, on two real devices or on the real server: see the human checklist.
- CI result on the final tree, integrated with main (#114), Node 24.22.1: `npm ci`, `npm run lint`, `npm test` (all workspaces, 67 test files, 0 failures) and `npm run demo` (DEMO OK). Node 20.20.2 before the merge: the same, except `packages/web-member/test/sodium-browser.test.js`, which hangs on the author's machine only (known since §10, untouched here) and passes in GitHub's CI. Deploy checks: `shellcheck` and `bash -n` (3.2 and 5.3) on `deploy.sh`, `caddy adapt` with `caddy:2.11.6-alpine`, `docker compose … config`.

### The flow, as built

1. The page asks `POST /account/start { member, username }` and gets a single-use `nonce` and the cookie `__Host-varanda-link` (600 s). The member signs the nonce with the diary key (RPC `account.sign`, phase `reserve`, `packages/core/lib/account-link.js`); `POST /account/authorize { signature }` verifies it and returns the Google URL.
2. The page navigates to Google (`openid email`, `state`, PKCE S256). Google returns to `GET /account/callback?code&state`. The service requires the cookie and the `state` to name the same pending row **before** any call to the token endpoint, exchanges the code server side with the client secret and the PKCE verifier, and checks `userinfo` and the `id_token` claims (`iss`, `aud`, `exp`, `sub`, `email_verified`; `apps/cli/lib/account/google.js`). It redirects to `/?conta=ok|erro|cancelado` (or `lista-de-espera` when the member cap is full, before the exchange), never with a code in the URL.
3. The page loads, reads `GET /account/pending`, shows the chosen @username and asks the member to confirm. The member signs again (phase `finish`, over the Google subject); `POST /account/finish { signature }` returns `{ cert, usernameRecord, nextChangeAt }`. The page runs `cert.add`, then `username.add`.
4. Rename: `POST /account/rename/start { member, username }` then `POST /account/rename/finish { member, nonce, signature }` (phase `rename`, no cookie: the key proof is the authority). Before 7 days the service answers 409 `troca-bloqueada` with `nextChangeAt`.

### What the server stores and what it never sees

- The directory keeps per link: member key, Google `sub`, e-mail, the current @username and its signed record, `usernameChangedAt`, `linkedAt`, the finish `nonce` and `signature`, and the certificate; plus `usedNames` (every name a member ever held). It is three files in the service volume, all mode 0600 in a 0700 data dir: `<data>/directory.json` (the snapshot, with `seq`), `<data>/directory.journal.<id>` (the journal the snapshot names) and `<data>/directory.hwm` (the high-water mark); see "Directory journal" below. `apps/cli/lib/account/store.js`. It never stores the Google tokens or the pending Google transaction (state, verifier), which live in memory for at most 600 s.
- It never sees the member secret, the passkey, or the association secret. The issuer secret never leaves `issuer-key.json` in the service volume.
- The e-mail never enters the diary, the certificate, the username record, the seeder or the browser; `GET /account/username/<name>` and `/account/status` return no e-mail. `account export` (service stopped) is the only way out and has the e-mail but no signature, certificate or secret.
- Logs receive only `{ event, reason }` tokens; no e-mail, subject, code, token, signature or client address. The rate limits need no address (see "Reservations and rate limits" below).

### Rules worth restating

- **7-day rename.** One change per member per 7 days (`COOLDOWN_MS`); the page says so before the link and before the rename button, and after a rename shows the date of the next one.
- **Never reassigned.** A name once held by a member is never given to another member; the same member may take it back after the cooldown. An old record copied around therefore never names someone else.
- **Old names can linger.** A node from before B1, or a follower that has not synced yet, may briefly show the previous name (or none: nodes from before B1 ignore the `username` record type). The newest valid own record wins (`packages/core/lib/username.js`); `username.add` refuses an older one (`registro de nome antigo`), so the official client cannot revert a rename.
- **Single writer.** The service holds `<data>/.account-lock` while serving; `account key`, `cert add` and `status` do not take it; `export` refuses while it runs.

### Reservations and rate limits (security audit fixes, 2026-10-24)

The audit before the push found that the first cut let an unauthenticated client spend what members need: shared per-route windows charged before any proof, per-member windows keyed on a key anyone can name (keys are public via `/account/username/<name>`), and key-proven reservations that cost nothing (a key is free to generate) yet held names and were never evicted. The rules are now:

- **A name is held only once Google answered.** A pending row holds its @username and is protected from eviction only after the callback put the Google `sub` on it. A key-proven row (`/account/authorize` passed) holds nothing and is evictable like a bare start; `finish` re-checks the name. When two rows claim the same name (both started before either reached Google) the first to claim holds it and the other's finish answers `nome-em-uso`; neither blocks the other. Pending rows: at most 1000 live by default (`VARANDA_ACCOUNT_MAX_PENDING`); at most 3 bare rows per member (a bare row only went through `/account/start`; its oldest is replaced, and a row the member already signed at `/account/authorize` is never replaced this way, because anyone can name a public key in `start`); signed rows without a Google answer are bounded by the signed `/account/authorize` window (5 per member per 10 min); at most **2 per Google subject** (a third claim for the same `sub` replaces its oldest row); the oldest unclaimed row (bare or signed) evicted when the table is full, which only a flood reaches; `lotado` only when every row is Google-claimed.
- **Nothing shared is charged before a proof.** `/account/start` and `/account/rename/start` have no per-member window (they need no proof, so a window keyed on the body's member would let anyone lock a member out); they are bounded by their tables (pending rows as above; rename nonces at most 1000, the oldest evicted) and by the global bucket. The per-member windows are charged only after the member's signature verified and are keyed on the member it proved: 5 `/account/authorize` per member per 10 min, 10 `/account/finish` per member per 10 min, 5 `/account/rename/finish` per member per 10 min. The callback quota is per pending row (3), charged only after the cookie and the `state` named the same row. The public reads (`/account/status`, `/account/username/<name>`) share one window of 1200 per minute. A keyed window whose table (10 000 keys) is full drops expired entries, then the oldest; it never refuses a new key.
- **Residual (documented, not fixed).** The one global token bucket (20 requests/s, burst 100) is the last-resort ceiling and an unauthenticated flood can still drain it for everyone. A per-source limit needs client addresses, which the design keeps out of the service pending the legal opinion on logs (issue #38): Caddy strips `X-Forwarded-For` and the service never reads it. The operator can add per-IP limiting in front of Caddy without changing the service.

### Compatibility (read before the first deploy)

- A node from before B1 answers `malformed` for any v2 certificate (the exact-key check in `packages/core/lib/cert.js`, `MEMBER_KEYS`). The **seeder and every native or CLI member must be updated before the first v2 issuance**, or a v2 diary is rejected by them.
- The first deploy boots the `account` service **unconfigured**: `/account/health` answers `{"status":"ok"}`, the link routes answer 503 `indisponivel`, and `account status` prints `emissor não certificado`. The ceremony runs after the deploy: `account key`, `assoc certify-issuer` on the operator machine, `account cert add`, restart of the service (README, "Vínculo de conta Google e @nome"). `account cert add` refuses a certificate for another association or key.
- The pilot's live web member keeps its **v1 certificate**: `cert.add` refuses a second certificate (`packages/web-member/lib/member-ops.js`, `certAdd`: "certificado já gravado"), and a diary that already has block 0 cannot take a second one. It can still link and receive a @username through its username record; its certificate stays v1. Its feed items carry the @username like any other member's.

### Threat limits

- Whoever serves the PWA can change its code; an XSS on the origin can call `account.sign` while the identity is unlocked and so link or rename the key to an account the attacker controls.
- The member signature proves the web key only. The association vouches for "someone controlled this Google account when linking", not for age (`ageBand: 'unchecked'`) and not for being one person: one Google account per key, but nothing stops one person from owning several accounts.
- The page loads no Google script; the sign-in is a top-level navigation to Google, and the CSP is unchanged (`script-src 'self'`).
- The browser handle always caches the diary key before an unlock (`packages/web-member/web/node.js`, `identityStatus`); a direct session caller that never called `identityStatus()` can see `account.sign` preempt a `once` sync (as `node.info` does). Not reachable through the shipped handle.
- Only the newest own username record is verified, which bounds a follower's cost to one verification per log; a modified client of the owner can only hide the owner's own name.
- The e-mail and the Google subject sit on one server in Brazil; retention is open (issue #38; `docs/design.md`, LGPD).
- **The issuer key is online and cannot be revoked yet.** It lives in the account container's volume on the public host. Whoever steals it can mint v2 certificates and username records that every node accepts (the delegation has no expiry; an expiry would not help, since a stolen key can back-date). PR B2 adds the revocation: the moderator's signed list carries revoked issuer keys and every node refuses them. Until then the only response is rotating the association key and re-certifying every member.
- `/account/pending` returns the Google subject (`sub`) to the browser that holds the link cookie, because the member signs over it at `finish`. It reaches no other member, log, redirect, error body or diary; the e-mail never leaves the server except through `account export`.
- If the account container is down when Google sends the browser back, Caddy's error log may record the request URI, `code` and `state` included. The code is single-use and worthless without the PKCE verifier and the client secret, which never leave the service.

### Member cap and configurable limits (PR `feat/account-member-cap`, 2026-10-27)

Read from the code (`apps/cli/lib/account/store.js`, `server.js`, `apps/cli/lib/commands/account.js`); the automated and human checks for this change are listed at the end of this subsection.

- **`VARANDA_MAX_MEMBERS`** (1 to 4096; absent or empty = no cap) caps the number of linked members. The count is taken on demand from `state.links`, never from `usedNames` (which never shrinks). Lowering the cap below the current count removes nobody.
- **Where the cap is checked.** While the cap is reached, `start()` answers `lista-de-espera` after the `conta-vinculada` check, and `finish()` answers it in the new-link branch, after the same-sub branch. The server maps the token to HTTP 503 and its body is only the token; the app shows the waitlist screen.
- **Callback before the exchange.** A Google callback that arrives while the cap is reached is refused before the Google code is exchanged: the server drops the pending row, clears the link cookie, logs only `{ event: 'lista-de-espera' }` and redirects to `/?conta=lista-de-espera` (the app shows the same waitlist screen), so no Google subject or e-mail is collected for a refused link. `finish()` keeps its own check for a cap that fills after the callback.
- **Who is unaffected.** A member who already has a link (the same member key and the same Google `sub`) keeps renaming, reading status, reporting, and a second link flow they started before their link finished completes as an e-mail update (a linked key cannot start a new link: `start` answers `conta-vinculada`). Renames, status, lookup, export, the moderation desk and a linked member's e-mail update never consult the cap.
- **Who is refused.** A member who lost the passkey and links again with a NEW key counts as a new member, so it is refused while the cap is reached.
- **Nothing about a refused attempt is stored.** A refused `start()` creates no pending row. A `finish()` refused by the cap deletes the pending row it refuses (that row holds the Google `sub`, the e-mail and the claimed @username), so no pending row, directory entry, username record or certificate is written. The log keeps only the reason token, as in the rest of section 12.
- **Configurable limits** (`readLimits` in `apps/cli/lib/commands/account.js`). Each variable is an integer read from the environment, and an absent or blank value keeps the default; `0`, a value outside the range, or anything that is not a plain integer without leading zeros or signs is refused with a usage error, `<NAME> inválido`:

  | Variable | Range | Default |
  |---|---|---|
  | `VARANDA_MAX_MEMBERS` | 1 to 4096 | none (no cap) |
  | `VARANDA_ACCOUNT_MAX_PENDING` | 1 to 100000 | 1000 |
  | `VARANDA_ACCOUNT_MAX_CONNECTIONS` | 1 to 4096 | 64 |
  | `VARANDA_ACCOUNT_RATE` | 1 to 10000 | 20 per second |
  | `VARANDA_ACCOUNT_BURST` | 1 to 100000 | 100 |

  The defaults are the values the service runs with when the variables are absent (`MAX_PENDING` in `store.js`, `MAX_SOCKETS`, `DEFAULT_RATE` and `DEFAULT_BURST` in `server.js`), so a deploy that sets none of them behaves as before.
- **Still one global bucket.** The rate limit is still the one global token bucket (`global: tokenBucket(...)` in `server.js`). The variables change its rate and burst; they add no per-member or per-source bucket.
- **Still no client address.** The account service reads no client address for the cap or the limits (`server.js` and `store.js` never read the socket address or `X-Forwarded-For`). A per-source limit therefore still waits for the issue #38 decision, as described in "Reservations and rate limits".

Checks for this subsection (not run in the author's session; to be done by hand or in CI before the PR is merged):

- [ ] `npm run lint` and the account test files pass on Node 20 and 24.
- [ ] With `VARANDA_MAX_MEMBERS=1` and one member linked: a second Google account gets the waitlist screen, and `docker compose logs account` shows only the `lista-de-espera` token, with no e-mail, subject or client address.
- [ ] The same member renames, reports and re-links with the same key and Google account while the cap is reached.
- [ ] A new key for the already linked Google account is refused with the waitlist answer.
- [ ] A value of `0` or `4097` in `VARANDA_MAX_MEMBERS`, or `0` in `VARANDA_ACCOUNT_RATE`, is refused with the usage error `<NAME> inválido`; an empty value keeps the default.

### Automated (CI)

- `packages/core/test/account-link.test.js`: constants, golden vector, every field bound, phases never cross-verify, shape rejections, pure module.
- `packages/core/test/cert.test.js` and `packages/core/test/records.test.js` (golden vectors and rejections for the issuer certificate, certificate v2 and the username record: wrong member, other association, swapped issuer signature, seq 0), `packages/core/test/session.test.js` and `packages/web-member/test/session.test.js` (`account.sign`, `username.add`), `packages/rpc/test/methods.test.js` (method lists).
- `apps/cli/test/google.test.js`: PKCE, authorize URL parameters, userinfo and `id_token` checks, size, redirect and timeout limits, no value echoed.
- `apps/cli/test/account-store.test.js`: pending rows, eviction (a key-proven row is evicted only by a full table and holds no name; starts naming a member's key never evict the row that member signed; a Google-claimed row is kept and holds it; first claim wins; a third row per `sub` replaces the oldest), 0600 files, crash safety, conflicts, 7-day cooldown with an injected clock, names never reassigned.
- `apps/cli/test/account.test.js`: the full link, cookie-and-state binding before the token call, replay and wrong-key signatures, rename routes, request hygiene, rate limits (unauthenticated starts, rename/starts and finishes naming a member never block its own signed flow; the 6th signed authorize in 10 min is 429; a keyed window at capacity still admits a new key; an unmatched callback charges no per-row quota), unconfigured service, the data-dir lock, `account key|cert add|status|export`.
- `apps/app/test/account.test.js`: request builders, return parsing, fixed error messages, `formatNextChange`.
- `packages/core/test/feed.test.js` (items carry the @username), `cli.test.js` and `readme-help.test.js` (flags and help).
- `apps/cli/test/account-e2e.test.js`: link, `username.add`, a CLI follower sees @a, rename refused before 7 days, allowed after, the follower sees @b.

### Human verification

- [ ] The real Google consent screen with the `openid email` scopes; the unverified-app warning (while the OAuth client is in testing) and what a tester sees.
- [ ] Two devices with the same Google account and passkey: the link made on one is recovered on the other (status, certificate, @username).
- [ ] A @username collision: two members, the same name; the second gets `nome-em-uso`.
- [ ] A rename before 7 days shows the date and no input; after 7 days it works and the old name is not given to another member.
- [ ] `curl https://<host>/account/username/<name>` and `/account/status?member=<key>` return no e-mail.
- [ ] The seeder and `account` logs show no client address (`docker compose logs account seeder`).
- [ ] The pilot's v1 member links, gets a @username and keeps its v1 certificate.
- [ ] After the deploy and before the ceremony, the link routes answer 503 `indisponivel`; after `cert add` and the restart, `account status` stops saying `emissor não certificado`.

### Directory journal (PR `perf/account-directory-journal`, 2026-10-27)

Read from the code (`apps/cli/lib/account/store.js`, `apps/cli/lib/commands/account.js`). A sign-up, an e-mail update or a rename no longer rewrites the whole directory: it appends one line to the journal. Third fix round (same PR): journal files are never truncated or rewritten once another process may hold them, a snapshot rename is fsynced again when its first dir fsync failed, and a high-water mark refuses a pair restored from an older backup. Fourth fix round (same PR, after a security audit of that design): every read-write open fences unconditionally (F1, a takeover in the header-only state used to write nothing and share the files with the stale writer); the hwm records the link and name counts, so a snapshot without `seq` (the older build's, after the documented rollback) is judged by counts and a roll forward no longer needs the mark deleted (F2); orphan removal is conservative (young orphans kept, `directory.json` re-read and the fence checked before each unlink, F3); an orphan whose lines past the snapshot are identical in the named journal opens (a crash between `retire()`'s fold and its unlink, F4); the hwm is written under the fence and never lowered (F5); and the guard runs again after each append's fsync, before the line is acknowledged (F6).

- **Files.** `directory.json` is the snapshot `{ v, seq, journal, links, bySub, byUsername, usedNames }` (a file without `seq` is seq 0; `journal` only in `v: 2`), replaced whole and atomically through `writeJsonAtomic`. Every link record must be whole (`sub`, `username`, `email` strings, `usernameChangedAt` and `linkedAt` parseable dates, `cert` and `usernameRecord` objects), or the open fails closed. `directory.journal.<id>` is the journal (not `*.log`, so no log-rotation pattern matches it; `<id>` a random 16-byte hex id): NDJSON whose first line is the header `{ "journal": "<id>" }` and whose later lines are one change each since the snapshot, `{ seq, op: 'link' | 'email' | 'rename', member, ... }`. It is created `O_EXCL|O_NOFOLLOW` with mode 0600, and every read-write open of it calls `fchmod(0600)`, so an existing journal with looser permissions is tightened too. `directory.hwm` is the high-water mark `{ seq, journal, links, names }` (`writeJsonAtomic`, 0600): the highest committed `seq` with the number of links and of `usedNames` entries at that mark, written after every compaction and at close (a mark without the counts, from the earlier rounds of this PR, reads as 0 and 0).
- **Journal binding and orphans.** A `v: 2` snapshot names its journal's id, and readers resolve the journal by that id. Every open, read-write or readOnly, fails closed (`diretório de contas inválido`) when the journal of a `v: 2` snapshot is missing, empty, has no header or carries another id: a journal deleted, rotated or truncated outside the service never makes the directory forget links, so no @username or Google account is issued twice. A `v: 1` snapshot names no journal. A `directory.journal.*` file the snapshot does not name is an orphan: a crash between two steps of a journal start, a compaction or a close leaves one, always with nothing past the snapshot's `seq`. Readers ignore orphans; a read-write open removes them after the snapshot was read and after its own snapshot write (so a stalled writer about to name one is fenced first), never the named one. The removal is conservative: an orphan whose mtime is younger than `ORPHAN_GRACE_MS` = `LOCK_STALE_MS` + `LOCK_HEARTBEAT_MS` (40 s, mirrored from `server.js` and checked equal by a test) is left for a later open, since a writer that has not noticed it lost the lock may still hold it (its heartbeat fences it within that time); right before each unlink the store reads `directory.json` again and skips any id it names, and checks its fence (a snapshot that changed under it marks the store unavailable and the open reads again instead of sweeping). An orphan with a line past the snapshot's `seq` (an acknowledged change no snapshot names) fails closed at every open and is kept for the operator, unless the named journal holds the byte-identical line (canonical JSON) at the same `seq`: that is the state a crash leaves between `retire()`'s fold of the stale writer's late lines and its unlink, and it opens; a line that differs from, or is absent from, the named journal still fails closed, and so does an orphan that does not parse.
- **Writes.** Each change is ONE `write` of its line followed by ONE `fsync`, so a sign-up costs the same whatever the directory size. The fsynced append is the commit point; the in-memory state changes only after it. A failed `fsync` of the journal (an append or its header), or a write that may have put bytes in the file before failing, makes the store unavailable (every later change answers `indisponivel` until the service restarts); the line is never adopted, and the next open reads what is on disk. An error raised before any byte reached the journal reloads the files before the error propagates.
- **Never truncate a journal another process may hold.** The journal's start (before the first change since a `v: 1` snapshot) and every compaction take the same path: create a NEW `directory.journal.<new id>` (`O_EXCL`, header written and fsynced, data dir fsynced), rewrite the snapshot as `v: 2` naming the new id at the current `seq` (`writeJsonAtomic`: rename plus dir fsync), and only then unlink the previous journal file. A crash at any step leaves a directory that opens with every acknowledged change: before the rename the old snapshot and its journal are intact beside a header-only orphan; after it the new snapshot names the new (header-only) journal and holds the compacted state, and the old file is an orphan whose lines are all at or below the snapshot's `seq`. The open-time compaction (lines past the header, which also drops a torn trailing line) follows the same path; the only truncation left is the writer's own torn tail after its own failed write, under the guard, on its own live journal.
- **Writer guard.** Before every append and every snapshot write the store compares the journal's open fd with the path (`fstat` and `lstat`): same device and inode, still linked (nlink above 0), exactly the size the store expects, and `directory.json` still the file (device, inode) the store last read or wrote. Every read-write open fences unconditionally: it creates a fresh journal (new id, `O_EXCL`, header fsynced) and publishes a snapshot naming it (a new `directory.json` inode), then retires and unlinks the previous journal, also when the journal it found is header-only and nothing is orphaned (the normal state right after every open, which the earlier rounds left untouched, so a takeover there shared the snapshot inode and the journal with the stale writer and both passed the guard). A writer that lost its lock without noticing (a stalled process whose lock went stale and was taken over) is therefore fenced by the new writer's open, before any of its writes, and once its journal is unlinked its fd points at an inode with nlink 0: its appends can never reach the live journal, and compaction into a new file (instead of truncating the shared inode) removes the equal-length case where the old guard passed. Any difference makes the store unavailable without writing. After each append's fsync the full guard runs again (fd still the file at the path with nlink above 0, the expected size, `directory.json` intact) before the line is adopted and the change acknowledged: a line that landed in an inode unlinked, or under a snapshot replaced, between the guard and the write is refused to its client (`indisponivel`) and the store is unavailable. Lines the old writer still landed in the previous journal between the new writer's read and its unlink (its guard passed before the rename) are folded into the new journal before the unlink and, through a read fd kept open across it, right after; a line there that cannot be folded fails closed. Residual, documented micro-window (inherent without OS file locks): the old writer's guard and its `write` are separate syscalls, so a write that lands in the previous journal after the new writer's last fold stays in an inode with nlink 0 (never read again) and is refused to its client by the re-guard rather than acknowledged; the window is microseconds wide and opens only after a stall of at least the lock's staleness. When the service loses its lock, `account` serve marks the store unavailable at once, before it stops and while requests drain.
- **Snapshot durability.** `writeJsonAtomic` renames and then fsyncs the data dir; if that dir fsync fails after the rename, the store reloads the files (which now name the new snapshot) and keeps `snapDirSynced` false; before the next change is acknowledged the dir is fsynced again (a failure fails that change, nothing appended), so a crash cannot lose the rename that a later acknowledged line depends on. The unlink of a previous journal never runs before the snapshot naming the new one was written with a successful dir fsync.
- **Compaction.** After `COMPACT_EVERY` = 256 journal lines, past `COMPACT_BYTES` = 1048576 bytes, and at every read-write open that finds a journal (an open that finds a `v: 1` snapshot or none starts the journal instead: the same new file and snapshot, no hwm write); always inside the queue, before the change that needs it (if it fails, that change fails and the file it created is removed). After the old journal is retired the hwm is written; a failed hwm write fails the change and leaves a directory that opens. In the steady state a change is still one write and one fsync; the open's fence costs one extra journal and snapshot write per open.
- **Version.** `v: 2` from the journal's start on (every compaction keeps v 2). A clean close (`close()`, called by `account` serve on SIGINT or SIGTERM, and never after the lock was lost) runs the guard, compacts (or writes the hwm), writes a complete `v: 1` snapshot without a journal id, and unlinks the journal. The store counts as closed only after the `v: 1` write: a close that fails (or a store already unavailable with `v: 2` on disk) rejects and may be retried, and `account` serve then logs `close falhou` (no detail) and exits 1, so a rollback never trusts a stop that left `v: 2`. The build before this change refuses a `v: 2` snapshot (`diretório de contas inválido`) and ignores `directory.hwm`.
- **Readers.** Every open, read-write or readOnly, reads the snapshot, replays the named journal's lines with `seq` above the snapshot's, checks the orphans and reads the snapshot again. A different `seq`, `v` or journal id (a compaction or a clean close raced the read) or a gap in the journal's `seq` makes it read again, up to `OPEN_RETRIES` = 3 retries; still inconsistent, the open fails with `diretório de contas inválido`. A complete line that breaks an invariant, or a link or rename record that is not whole, also fails closed. A torn trailing line (a write cut short by a crash) is ignored; the next read-write open compacts it away before any append.
- **Snapshot indexes.** Every open, read-write or readOnly, checks the snapshot's derived indexes against its links and fails closed (`diretório de contas inválido`) on any disagreement, never rebuilding them: `bySub` maps exactly each link's Google `sub` to its member, `byUsername` exactly each link's current @username to its member, and `usedNames` holds every current @username with its member plus past names, each held by a linked member. A damaged or hand-restored `directory.json` missing a `bySub` or `usedNames` entry therefore cannot let a second member link the same Google account or reissue a used name. Tested in `apps/cli/test/account-store.test.js` (`snapshot indexes:`).
- **Restore (high-water mark).** `directory.hwm` holds the highest committed `seq`, with the link and `usedNames` counts at that mark, outside the restorable snapshot+journal pair, and only ever grows: `writeHwm()` runs under the fence (a stale writer never writes it) and reads the stored mark first, writing only when the new `seq` and both counts are at or above it, otherwise marking the store unavailable (`indisponivel`: the change or the close fails and the file is untouched). A snapshot with `seq` is judged by `seq`; a snapshot WITHOUT `seq` was written by an older build (the documented rollback rewrites `directory.json` as `v: 1` without it, so its `seq` restarted) and is judged by the counts only: restored when it holds fewer links or fewer `usedNames` entries than the mark, otherwise it opens and continues the numbering from the mark's `seq`, so the roll forward keeps the mark monotone without the operator deleting it. A read-write open whose pair ends below the mark refuses with `diretório de contas restaurado de uma cópia antiga; confira o backup` (error code `RESTAURADO`; `account` serve logs `store restaurado` and exits 1); a readOnly open reports it (`store.restored`; `account status` prints `aviso: ...` and `restored: true` in `--json`, `export` and `reports` warn on stderr) and still reads. A damaged hwm (not JSON, a negative `seq`, a symlink) fails closed. The hwm advances at compaction and close time only: changes made after the last of those and lost to a crash are not covered (the restore of a backup taken before them is then accepted); a backup taken with the service stopped is always covered, since the clean stop writes the hwm. A restore is a security event: restore `directory.json` and its `directory.journal.*` from the LATEST backup only and KEEP the volume's existing `directory.hwm` (restore the backup's `directory.hwm` only if the volume lost it): overwriting the live mark with the backup's own would lower it and the restored-copy refusal could never fire (a pair restored together with its own hwm is accepted by design, and a test confirms it). An operator who deliberately restores an older copy acknowledges it by deleting `directory.hwm` after confirming that no @username and no Google account were issued since that copy (README, "Vínculo de conta Google e @nome"). Known minor race: a readOnly `account status`, `export` or `reports` may print a false "restaurado" warning if the service finishes a compaction in the microseconds between the reader's snapshot re-check and its hwm read; running the command again clears it. Read-write opens are not affected.
- **Unavailable at runtime.** When the read-write store marks itself unavailable on its own (writer guard, a failed `fsync`, a failed reload), `account` serve logs `store indisponivel` (no personal data), stops, skips the clean close and exits 1, so Docker restarts it and the restart re-reads the disk instead of answering `indisponivel` forever. A lost lock keeps its own path (`lock perdido`). Tested in `apps/cli/test/account-store.test.js` (`onUnavailable:`) and `apps/cli/test/account.test.js` (`serve wiring:`).
- **readOnly.** `account status`, `account export` and `account reports` never write, create, unlink, chmod or truncate anything, so they work on a read-only volume and while the service runs. Every disk mutation answers `indisponivel`.
- **Rollback.** Before rolling back to a build that knows only `v: 1`, stop the `account` service cleanly (SIGTERM, and let it exit within the Docker stop timeout). A clean stop leaves `directory.json` with `"v":1` and no `directory.journal.*` file; check both before starting the older build (it ignores `directory.hwm`). A service killed while running, or one that stopped after losing its lock (it logs `lock perdido` and exits 1), leaves `v: 2`, which the older build refuses to open (so does a service that started and was not stopped cleanly: every read-write open publishes `v: 2`). In that case start THIS build first, let it open the directory (it replays the journal), stop it cleanly, and only then roll back. Rolling forward again needs nothing from the operator: the older build rewrites `directory.json` without `seq`, and this build judges such a snapshot by its counts against `directory.hwm` (see "Restore"), opens it when no link or name was lost, and continues the numbering from the mark; delete `directory.hwm` only when the roll forward is refused with `RESTAURADO` and the loss of links or names is intended.
- **Backups and rotation.** Never rotate, delete or truncate a `directory.journal.*` (a `v: 2` directory without its journal refuses to open). A backup copies `directory.json`, the journal it names and `directory.hwm`, taken with the service stopped (a restore does not put all three back: see "Restore"). A copy of one file can miss journaled links (and a `v: 2` snapshot without its journal fails closed), and a copy taken while the service runs can catch a compaction between the files. See "Restore" above for restoring.
- **Unchanged.** The member cap (`maxMembers`), the no-address rule, the 7-day rename cooldown, the names that are never reused, and the pending rows (memory only, never on disk) are as before.

Automated (`apps/cli/test/account-store.test.js`): the `journal:` tests (300 finishes compact once into a new journal file, with the hwm, and the compacted snapshot reads beside its header alone and fails closed without its journal; a failed compaction keeps the journal and the old snapshot and removes the file it created; one append and one fsync per sign-up; a readOnly open during the service sees the journal and writes nothing; a torn last line is ignored and dropped by the next read-write open; a damaged line fails closed; a reader racing a close reads again; a snapshot that moved while the journals were read is read again; the member cap counts replayed links; `v: 2` on disk while the journal is not empty and a clean close leaves a complete `v: 1`, no journal and the hwm; a data dir fsync that fails after a journal is created discards it and the retry creates and fsyncs another; every read-write open fchmods the journal it appends to). The `compaction:` tests (crash at each step: before the snapshot rename the old pair is intact beside a header-only orphan; after the rename and before the unlink the old journal is an orphan that readers skip and the next read-write open removes, while the stale writer's next change is `indisponivel`; a failed hwm write fails the change and leaves a directory that opens). The `snapshot:` test (a data dir fsync that fails after the snapshot rename is done again before the next change is acknowledged, and a retry whose dir fsync fails again appends nothing). The `journal binding:`, `orphans:` and `writer guard:` tests (the header carries the id the `v: 2` snapshot names and the file is named by it; a missing, empty, headerless, foreign or renamed journal under `v: 2` fails closed, readOnly and read-write; a line past a `v: 1` snapshot fails closed while a header-only or torn-header orphan opens and is removed by the next read-write open; orphans are left by readers, removed by a read-write open only after a snapshot write, and refused with a line past the snapshot; a journal truncated, replaced, deleted or appended to behind the writer, or a snapshot replaced behind it, makes the next change `indisponivel` and writes nothing; the reproduced takeover, a new writer's open that compacts into a new journal and appends a line of the same length as the stale writer remembers, stops the stale writer before any write and the directory reopens with the takeover's state; a line a stale writer lands in the previous journal right after the snapshot rename is folded into the new journal, never lost, and the hwm counts it; a torn byte there is dropped and an unparsable line there fails closed and keeps the file; F1: a takeover in the header-only state, after the first open and after an open on a `v: 1` or a `v: 2` snapshot, unlinks the stale writer's journal, changes the snapshot inode, and the stale writer's next change is `indisponivel` with nothing written and nothing acknowledged; F6: a line that lands in a journal unlinked, or under a snapshot replaced, between the guard and the write is refused and never adopted). The `orphans:` tests for F3 (an orphan younger than the grace is kept, also 5 s short of it, and removed once older; a snapshot replaced right before the sweep makes every attempt stop with the orphan still there, and the open gives up with `indisponivel` after its retries) and F4 (the crash after `retire()`'s fold and before its unlink opens, readOnly and read-write, with the late line counted once and its name never reissued; an orphan line that differs from the named journal's at the same `seq`, or that it does not hold, still fails closed). The `hwm:` tests (a `v: 1` pair restored from an older backup is refused read-write with `RESTAURADO` and reported readOnly, a pair restored with its own hwm is not, removing `directory.hwm` acknowledges the restore and a new mark follows, a damaged hwm fails closed, a mark below the pair opens; a `v: 2` pair below the mark is refused too and the mark follows every compaction and close; F2: a snapshot without `seq` with equal or higher counts opens read-write with the mark in place and continues the numbering from it, with fewer links or fewer names it is `RESTAURADO`, and with `seq` present the `seq` rule decides; F5: a stored mark above the store's `seq`, or above its counts, makes the compaction or the close `indisponivel` with the file untouched). Also `whole link records:`, `fail():`, `close:`, `resync:`, `snapshot indexes:` and `onUnavailable:`. In `apps/cli/test/account.test.js`: a lost lock marks the store unavailable before the service stops, and on a directory restored from an older backup `account status` warns (`restored: true` in `--json`), `account export` still reads and warns on stderr, `account` serve logs `store restaurado` and exits 1 with the lock released, and removing `directory.hwm` acknowledges it. Run before the PR is merged: `cd apps/cli && node ../../scripts/run-tests.js test/account-store.test.js test/account.test.js test/account-e2e.test.js test/account-mod.test.js test/moderation-e2e.test.js test/readme-help.test.js`.

Human (to be done on a test deploy before the first deploy with this change):

- [ ] Sign up two links, stop the service with the README command, and check that `directory.json` has `"v":1`, that no `directory.journal.*` file is left and that `directory.hwm` has `"seq":2`.
- [ ] Start the previous build on that volume: it opens the directory and shows the same links.
- [ ] Kill the service with SIGKILL while it runs: the previous build refuses the `v: 2` directory with `diretório de contas inválido`; this build opens it and keeps both links.
- [ ] Copy the three files with the service stopped into an empty volume: every link and @username is there.
- [ ] With at least one link only in the journal (`directory.json` has `"v":2`), stop the service with SIGKILL and move the `directory.journal.*` away: the next start fails with `diretório de contas inválido`; put it back and the start succeeds with every link.
- [ ] Back up the three files with the service stopped, sign up one more link, stop cleanly, restore the backup's `directory.json` and its journal (if any), keeping the volume's `directory.hwm` (not the backup's): the start fails with `diretório de contas restaurado de uma cópia antiga; confira o backup` and logs `store restaurado`; `account status` warns; delete `directory.hwm` and the start succeeds.
- [ ] Roll back to the previous build after a clean stop, sign up one link there, stop it, and start this build again WITHOUT touching `directory.hwm`: it opens (the snapshot without `seq` holds at least the mark's links and names), `account status` shows every link, and numbering continues from the mark's `seq`: a clean stop with no new change writes the same `seq` (it only grows with new changes), and the mark's link and name counts grow only with new sign-ups made in this build (sign one up before the stop to see them rise).
- [ ] Start the service, kill it with SIGKILL within 40 s of the start, and start it again: the snapshot still names the killed run's journal, so the open replays it and retires it at once and `ls` shows only the new `directory.journal.*`. Orphans appear only after a crash in the middle of a compaction or a close; one younger than 40 s is left by the next open and removed by an open after that.

## 13. Signed P2P blocklist and issuer revocation (PR B2, 2026-10-24)

### Summary

- The association's moderator signs numbered snapshots of blocked diary keys and revoked issuer keys. Every node (seeder, CLI member, browser node) swaps them on the `varanda/blocklist/1` channel, keeps the newest one that verifies and refuses, purges and skips the listed diaries. The operator runs `mod block|unblock|revoke-issuer|unrevoke-issuer` on their own machine; the moderator secret never goes to a server. Format, channel, limits and gates: `docs/protocol.md` section 3.
- Verified by Node tests (below) on loopback networking only. Not verified on the real server, on two real devices or on the public DHT: see the human checklist.
- CI result on the final tree, Node 24.22.1: `npm ci`, `npm run lint`, `npm test` (all workspaces, 74 test files, 0 failures) and `npm run demo` (DEMO OK). `apps/cli/test/blocklist-e2e.test.js` also passes 3 of 3 runs on Node 20.20.2; the full suite was not run on Node 20 locally (`packages/web-member/test/sodium-browser.test.js` hangs on the author's machine only, known since §10), GitHub's CI runs both versions.

### Limits as built (read from the code)

- Snapshot: at most 4096 blocked keys and 64 revoked issuers, `MAX_SNAPSHOT_BYTES = 393216`; channel message at most 393216 bytes, a `have` at most 256.
- Flow control by credit: each `have` allows exactly one snapshot from its receiver; an uncredited snapshot is a bad message; snapshots are processed at most one per 10 s per connection; 5 bad messages drop the peer; a per-connection bucket (burst 512, 2 per second) drops a flooder (`message-rate`). Local save failures are retried with backoff up to 5 min.
- Ordering: the newer moderator certificate date wins (its `seq` restarts); for the same moderator the higher `seq` wins; a different moderator with the same date loses (first stored wins).

### Automated (CI)

- `packages/core/test/blocklist.test.js`: shape, payload, golden vector, size bound, `verifySnapshot` reasons, `compareSnapshots` / `acceptSnapshot` rules (newer moderator, same moderator, stale, same), `createBlocklistState` (serialized offers, save failure keeps the previous snapshot, failing load fails closed).
- `packages/core/test/blocklist-net.test.js`: the channel on loopback sockets: message validation, delivery once, a newer moderator travelling toward a higher `seq`, `announce`, stale never counts, the 5th bad message, an early credited snapshot held, seven bunched publishes, an uncredited snapshot, the message bucket, padded `have`, retry after a failing offer, and a peer without the channel (admission completes, `supported` false).
- `packages/core/test/blocklist-member.test.js`: a member stores, enforces and relays a snapshot (purge, `log.read` / `follow.add` / feed rules); a newly revoked issuer drops the followed diaries it certified and purges the unfollowed and failed replicas.
- `packages/core/test/blocklist-seeder.test.js`: a snapshot drops and refuses a blocked diary (a forged one does nothing, an unblock lets it back), restart purges blocked and revoked-issuer diaries in step 3, an admission-only peer stays connected, a failing revocation sweep drops the diary, and an adoption during an in-flight admission or verdict refuses it.
- `packages/web-member/test/blocklist.test.js` and `node-storage.test.js`: the browser node (blocked author purged, hidden and still blocked offline, forged snapshots ignored, revoked issuers, own key unblocked and announced again, a `once` run waits for the seeder's newest snapshot, storage in kv `'blocklist'`).
- `apps/cli/test/mod.test.js`: the `mod` chain (init, cert add, block, unblock, revoke), foreign dirs and certificates and a damaged list refused, a missing or extra `--new-list` and a missing seeder key refused before anything is signed, `--no-publish` never touches the network, two concurrent writers (the second is refused), publish delivering to the certified seeder by its key (never through the topic), an echoing peer or a seeder certificate for another key never counting as delivery, and a timeout (exit 1, list kept). `cert.test.js` (moderator certificate and `revoked-issuer` reasons), `cli.test.js` and `readme-help.test.js` (flags and help).
- `apps/cli/test/blocklist-e2e.test.js`: a block and an issuer revocation published to the seeder propagate to an honest member and drop the diaries. `seed-ops.test.js` covers `seed status` (`blocklist` in `--json`) and the `/health` keys `blocked` and `blocklistSeq`; the Prometheus gauges are `varanda_seeder_blocked` and `varanda_seeder_blocklist_seq` (`health.js`). `mod.test.js` also covers a rotation continuing from a copied `blocklist.json`.

### Residual paths (what the list does not stop)

- **Nodes from before B2 do not enforce it.** The channel open is rejected by protomux and nothing else changes for them; they keep replicating a blocked diary until updated.
- **A modified app** can still connect straight to the blocked author and can serve the diary to other modified apps. An honest, up-to-date node on the path refuses it, so the diary cannot be pushed through such a node.
- **The author's own official app** keeps its diary in its store (the own diary is never purged) and the Corestore serves a stored core to a peer that already knows its discovery key (`docs/protocol.md` section 4).
- **The PWA offline** enforces the snapshot it has stored and gets a newer one only when it reaches the seeder; the DHT members exchange snapshots without the seeder.
- **A node is only as current as its last contact.** A node that never meets a peer holding a newer snapshot never learns of it; the moderator publishes to the seeder and the others learn by fan-out.
- **A torn or unparsable `blocklist.json` reads as no list.** The node enforces nothing until it receives the snapshot again from a peer; only the core member warns when a stored snapshot fails verification.
- **The web regate's `'blocked'` branch is defensive** (blocked keys are purged before they are regated), and a peer that opens the channel after our open was rejected pairs again but `supported` already resolved `false`.
- **The operator's address** is visible to the seeder and to the DHT nodes that route the lookup, not to arbitrary peers.
- **Moderator compromise.** A stolen moderator key can block any diary or revoke any issuer until the association certifies a new moderator (a later certificate date replaces it, and the new list starts at `seq` 1). The association key stays offline.
- **Individual member certificates are not revocable**; block the diary key instead. Re-issuing certificates after an issuer revocation is not implemented: affected members link again.
- A blocked author who creates a new key and a new certificate is a new diary; blocking is per key (the Google link and the username rules raise the cost, they do not remove it).

### Publishing, as built after the security audit

- `mod` publishes only to the association's seeder, dialed by its Noise key (`--seeder`, or `mod init --seeder`); it never joins the public association topic. Delivery counts only on a peer whose admission `hello` carries a seeder certificate of this association for its Noise key AND whose blocklist `have` equals the snapshot. `mod publish` re-sends the stored list; a timeout leaves the signed list on disk (exit 1).
- The first list of an association needs `--new-list`; a moderator rotation copies `blocklist.json` into the new directory (the command refuses otherwise), because a newer moderator's list replaces every node's whole list.

### Security audit

Auditors: Claude (opus; fable was out of credits) and GPT (gpt-6-astra, max); Grok out of balance. The built-in security review was not run for B2. Findings, each verified against the code: F1 forged delivery acknowledgement (medium, raised to high by triage), F2 a moderator rotation drops the list (low, raised to high), F3 the operator address exposed to peers of the topic (low, raised to high). All three are fixed in this PR (seeder-only publishing with a verified delivery, `--new-list` and the copied list, no topic). No forgery, rollback or enforcement bypass was found in the nodes.

### Operator response to a stolen issuer key

1. `node bin/varanda.js mod revoke-issuer <old issuer hex> --data <modDir>` (publishes; nodes drop that issuer's v2 diaries and ignore its username records).
2. In the account service: `account key` (new key), then `assoc certify-issuer` on the operator machine, `account cert add`, restart the service.
3. Affected members link again. Their old v2 certificates stop working; a later PR may add re-issuance.

### Human verification

- [ ] Upgrade the seeder and the clients to the B2 build first (old nodes do not enforce).
- [ ] On the operator machine: `mod init`, `assoc certify-moderator`, `mod cert add`; `mod show` prints `lista vazia`.
- [ ] With the seeder, a CLI member and the PWA connected, follow a test diary on both members, then `mod block <test key>`: it prints `lista publicada`; `seed status` shows `lista de bloqueio: seq 1 ...`; the seeder logs `{ event: 'blocklist', seq }` and a rejection for the dropped key; `/health` shows `blocked` 1 and `blocklistSeq` 1; the member drops the diary (`sync`, `log --author` says `sem dados locais para este diário`) and the PWA skips it ('ignorado (blocked)').
- [ ] Stop the seeder, then block a second test key from the operator machine with a CLI member online: the member adopts it from the DHT; start the seeder again and watch it adopt the newer snapshot from the member and drop the key.
- [ ] `mod unblock <key>`: the diary can be followed and synced again (the follow entry was kept).
- [ ] With the PWA offline, the blocked diary stays hidden; online again it receives a newer list through the seeder.
- [ ] `mod revoke-issuer <test issuer>` against a throwaway issuer: a v2 diary from it is dropped by the seeder and an honest member; `mod unrevoke-issuer` restores it.
- [ ] A node from before B2 connected to the seeder keeps working (no disconnect) and does not enforce.
- [ ] `docker compose logs seeder` shows no key list, address or reason for a block beyond `{ event: 'blocklist', seq }` and one rejection line per dropped key (that line carries the key, never the list or an address).
- [ ] `mod block` run from a machine whose seeder key is wrong or whose seeder is stopped exits 1 with `a lista ficou gravada; rode mod publish quando o semeador estiver no ar`; with the seeder back, `mod publish` prints `lista seq <n> publicada`.
- [ ] A first `mod block` in an empty directory without `--new-list` is refused; after a moderator rotation, the new directory (with `blocklist.json` copied from the old one) continues the `seq` and keeps every earlier block.

## 14. Reports from the app and the moderation panel (PR B3, 2026-10-24)

### Summary

- A member linked to a Google account reports a post or a whole account from the official hosted web app; the statement is signed with the member's diary key and stored by the account service. Moderators (the e-mails in `VARANDA_MODERATOR_EMAILS`, whose Google account is also linked to a diary) sign in with Google on the same service and record bloquear, descartar or desbloquear in a panel. The panel signs nothing: the operator's `mod apply --server <origin>` pulls the decisions with a request signed by the moderator key, REVIEWS them, signs ONE new snapshot on the operator machine, publishes it to the seeder and only then acknowledges it. The moderation key never goes to the server; the snapshot bytes, the blocklist channel and the enforcement rules are those of section 13, unchanged. Format of the two signed statements: `docs/protocol.md` section 3, "Reports and operator requests".
- Verified by Node tests (below) on loopback networking only. Not verified with the real Google sign-in, on a phone, against production or on the real server: see the human checklist.
- CI result on the final tree, Node 24.22.1: `npm ci`, `npm run lint`, `npm test` (all workspaces, 82 test files, 0 failures) and `npm run demo` (DEMO OK). `apps/cli/test/moderation-e2e.test.js` also passes on Node 20.20.2; the full suite was not run on Node 20 locally (`packages/web-member/test/sodium-browser.test.js` hangs on the author's machine only, known since §10), GitHub's CI runs both versions. Deploy checks: `shellcheck` and `bash -n` on `deploy.sh`.
- Security audit of B3: see the "Security audit" section below.

### The flow, as built

1. **Report.** In the hosted app (passkey unlocked, account linked) the sheet "Denunciar" calls `POST /account/report/start { member }` and gets a single-use `nonce` (403 `nao-vinculado` for a member with no Google link). The browser node signs the statement (RPC `report.sign`, `packages/core/lib/report.js`) and the page sends `POST /account/report { member, nonce, target, seq, reason, text, quote, signature }`. The service verifies the signature with the member key, then stores the report. An account report has `seq: null` and `quote: ''`; a report of oneself is refused; the same reporter reporting the same target and post (or account) again while the earlier report is still open gets that report back with `duplicate: true`, even at the daily cap.
2. **Decision.** A moderator opens `/account/mod/` (login `GET /account/mod/login` to Google with PKCE, a second redirect URI `/account/mod/callback`, session cookie `__Host-varanda-mod`, 8 hours, in memory). The login transaction is not a server-side row: it travels in an AES-256-GCM sealed `__Host-varanda-mod-login` cookie under a per-process key (a restart invalidates logins in flight). The callback checks the seal, the expiry and the state (constant time) before any token call, and a login can be used once (spent login ids are pruned at expiry); with no login table, anonymous `/login` requests cannot evict a moderator's sign-in. The panel admits a moderator only if their Google account is linked to a diary; otherwise it redirects to `?erro=sem-diario` ('Entre no painel com a conta Google vinculada ao seu diário.'), and the session keeps that diary key. Tabs: Abertas, Pendentes, Bloqueadas, Histórico. `bloquear` queues a block; `descartar` closes the report at once and changes no list; "Desbloquear" queues an unblock; "cancelar" on a pending change deletes it, or, when the operator already pulled it ("enviada para assinatura"), queues the inverse so the next `mod apply` undoes it. A moderator never sees, decides, unblocks or cancels anything about their own linked diary: reports AGAINST it and reports filed FROM it are hidden, and a pending change about it cannot be cancelled by them.
3. **Apply.** `mod apply --server <origin> --data <modDir>` holds the data-dir lock, asks `GET api/challenge?moderator=<hex>&op=pull`, signs and posts `api/pull`, refuses a local list behind or forked from the published one, then REVIEWS before signing: it prints one net line per member (`bloquear <k>`, `desbloquear <k>`, an unblock of a key blocked outside the panel carries a mark). At a terminal it asks 'Assinar e publicar estas mudanças? [s/N]' and, for unblocks of keys blocked outside the panel (`moderation.jsonl` `source: 'operacao'`, or no block line), a second confirmation. Without a terminal it refuses unless `--yes`; `--yes` (for cron) applies BLOCKS only, at most 100 per run, and HOLDS every unblock (their changes stay pending, neither signed nor acknowledged) until a terminal run: unblocks are never published unattended. It then applies the changes in order into ONE snapshot (`seq` + 1), publishes it to the seeder by its Noise key (section 13), then asks a second challenge (`op=ack`) and posts `api/ack { changeIds, snapshot }`. Only a delivered publish is acknowledged; an undelivered one leaves the list written and the next run re-sends the same bytes before acknowledging. The server verifies the snapshot (`verifySnapshot`, the moderator certificate, `acceptSnapshot`) and keeps it as its mirror of the published list.
4. **Export.** `account reports [--member <hex>]` on the server prints one JSON line per report with `reporterContact` and `targetContact` (`{ email, username }` or `null`). It is the only way an e-mail of the link leaves the service; the signed-in moderator's own e-mail appears only in `api/me`.

### What the server stores and what it never sees

- `<data>/moderation.json` (mode 0600, one atomic file, in the account service's volume): per report the id, date, reporter key, target key, `seq` (or null), reason, the reporter's text, the quote as the reporter sent it, the reporter's nonce and signature (the evidence), the status, the deciding moderator's e-mail, the decision date and the moderator's note; the ordered pending changes; the last acknowledged snapshot (a verified mirror); and an event log (capped at 10 000) of action, date, the moderator's e-mail, member, report id and change id: never a signature, nonce, reporter key or note. Caps: 20 000 OPEN reports (decided reports are kept, retention is issue #38, and no longer block intake) and a total of 100 000 rows that bounds the file, 20 reports per reporter key per 24 h, 1000 pending changes, 4096 blocked keys (`lotado`). A malformed file makes every method fail (`indisponivel`) and is never rewritten.
- It never sees the moderator secret key, the member secret or passkey, or the association secret. It sees the public blocklist snapshot that the operator sends back.
- E-mails and Google subjects are never in a log (`{ event, reason }` tokens only), the panel (members appear by key and @username; `api/me` returns only the signed-in e-mail), the snapshot or the diary. The moderators' e-mails are in `deploy/seeder/.env` and in `moderation.json` beside the decision; the e-mail of the link reaches the outside only through `account reports`, run on the server.
- No route and no screen shows a report to the reported person, and the reported is not shown who reported.

### Nonces and the two signed requests

- **Report nonce (stateless).** `POST /account/report/start` returns a nonce built from an expiry, random bytes and an HMAC under a per-process secret, bound to the member, valid 600 s. The server keeps no table of unspent nonces: a nonce is recorded as spent only AFTER the signed report verifies, so it is single use, and no unauthenticated request can fill a store or spend anyone's quota. There is no per-member quota on `start`; the limits before a proof are the server's global bucket, and the per-reporter cap (20 per 24 h) is charged in the store after the signature verified. The spent set lives in memory and only until each nonce's own expiry, so its size follows validly signed requests, never anonymous traffic. A restart changes the secret, so a nonce issued before it answers `expirado` and the sheet asks again.
- **Operator challenge (stateless).** `GET api/challenge?moderator=<hex>&op=pull|ack` returns a nonce that is an HMAC bound to that moderator key and operation, valid 120 s, single use, recorded as spent only after the signed request verifies. Anonymous challenges spend no quota; `pull` and `ack` have their own small bucket applied after the signature verified.
- **What the request signature binds** (`packages/core/lib/mod-request.js`): the deployment origin, the association, the moderator key, the nonce, the operation and the BLAKE2b-256 of the exact body bytes (`pull` is `{}`; `ack` is the sorted change ids plus the snapshot in canonical key order). The server also requires the certificate to be the association's moderator certificate and not older than the last acknowledged snapshot's (`cert.date`): a rotated-out key with an older date is refused once a newer key's `ack` was accepted. The operator routes need no cookie and no Origin; the signature is the authority.
- **Browser routes** (the panel API and `logout`) require the exact Origin and a JSON body; the cookies are `SameSite=Lax`, `Secure`, `HttpOnly`. The panel cookie `__Host-varanda-mod` is not the link cookie `__Host-varanda-link`; each route reads only the cookie of its own exact name.
- **Limits of `mod apply`:** 10 s per request, no redirect, the pull answer at most 1 MiB, challenge and ack answers at most 512 KiB, exact key sets on every reply.

### Threat limits

- Whoever serves the PWA can change the report sheet (what it shows and what it signs); an XSS on the origin can call `report.sign` while the passkey is unlocked and report any account on the member's behalf, within the caps.
- The report signature proves the web key only: that the reporter attested this text and this quote to the account service. The quote is reporter-supplied and is never verified by the report itself. The account service does not open the seeder's RocksDB (`docs/protocol.md` section 1). With the triage on (`VARANDA_AI`), it reads block 0 and the reported block from the local seeder over `GET /moderation-post/<D>/<seq>` and re-checks them (section 27); without the triage, the moderator checks the diary separately. A modified client can flood the service within the caps (20 reports per key per 24 h; a report needs a Google link, which costs one Google account per key).
- Reports come only from the hosted web app; the native app and the CLI cannot sign one (the sheet says so), and a `varanda-serve` page is not hosted.
- A stolen moderator Google login (or a compromised account server) can queue decisions and make a `--yes` cron publish up to 100 BLOCKS per run, but cannot get an unblock published without the operator's review at a terminal. Side effect: under a `--yes` cron, a block the panel cancelled after a failed publish is republished until someone reviews at a terminal.
- A stolen account server can read reports, the directory and all e-mails, but cannot forge a snapshot (the moderator key is not there) nor make `mod apply` sign anything beyond the changes it pulled, applied over the operator's own local list and subject to the review above.
- **Accepted residual risk: the panel shares the PWA's origin.** Any script on that origin (an XSS, a malicious web-root deploy, a poisoned service worker) can use a signed-in moderator's session. The user decided on 2026-10-24 to keep the panel on the same origin; the fix would be a dedicated subdomain.
- A moderator who also owns a second diary linked to a second Google account is not detectable by the own-case checks.
- A retired moderator key with an older certificate date is refused once a newer moderator's `ack` was accepted; until that first `ack`, the server cannot know of the rotation.
- The server's "aplicado" is the operator's attestation (`ack`), not proof that any node has the list: propagation follows section 13 (seeder first, then fan-out; old nodes do not enforce).
- A restart (or recreating the container) signs every moderator out and voids report nonces, operator challenges and logins in flight.
- Report retention is open (issue #38); nothing is deleted automatically. `docs/design.md`, LGPD, has the engineering hypotheses.
- The moderators' Google sign-in and the member link share one OAuth client and secret, with two redirect URIs.

### Security audit

Auditors: Claude (opus; fable was out of credits) and GPT (gpt-6-astra, max); Grok out of balance. Findings, each verified against the code and raised to high by triage unless noted:

- **A** anonymous `/login` requests evicted moderators' sign-ins (GPT and Claude): fixed, the login is a sealed cookie and there is no table.
- **B** `mod apply` signed whatever the server returned, with no review, and ran from cron: fixed, review before signing, `--yes` applies blocks only (at most 100), unblocks are held for a terminal.
- **C** the own-case check matched only the panel's Google account: fixed, a linked diary is required and its key is used.
- **D** a moderator could decide a report filed from their own diary: fixed.
- **E** the 20 000 cap counted decided reports (low): fixed, open reports only, plus a 100 000 row total.
- **F** the panel shares the PWA's origin, so any script on that origin can use a signed-in moderator's session: NOT fixed. The user decided on 2026-10-24 to keep the same origin and accepted it as a documented residual risk (see Threat limits); the fix would be a dedicated subdomain.

Earlier per-task review fixes (stateless report nonces and operator challenges, own-case filtering in `api/blocked`, the store's `ja-revertido`, strict store open) are described in the sections above.

A re-review of these fixes found two more, fixed here: `mod apply` re-sorted the pulled changes by their timestamps, so a server clock that stepped back would reverse a block and its cancellation; it now walks them in the server's order (the store's insertion order, which `ack` checks). And `api/me` counted the moderator's own open cases and pending changes, which hinted that someone had reported them; the counts now leave them out, like the lists. A known limitation stays: the panel's Histórico shows the newest 100 decisions and has no paging; the whole history is in `account reports` on the server.

### Automated (CI)

- `packages/core/test/report.test.js` and `packages/core/test/mod-request.test.js`: the payload layouts, every field bound, the prefixes never cross-verify, shape and well-formedness rejections (a lone surrogate in `text` is a TypeError), the canonical bodies.
- `packages/core/test/session.test.js`, `packages/web-member/test/session.test.js`, `packages/rpc/test/methods.test.js`: `report.sign` (own key refused, malformed report refused, the core session always answers "assinatura disponível só no navegador", locked identity).
- `apps/cli/test/moderation-store.test.js`: validation, caps, duplicates, decide / unblock / cancel as an ordered intent log (net zero, claimed changes compensated), the `pull` shape, `ack` rules (signature, certificate, same moderator, stale), strict open on a damaged file, events without secrets, `exportRows`.
- `apps/cli/test/account-mod.test.js`: `VARANDA_MODERATOR_EMAILS` parsing, the signed report flow and its refusals, the daily cap, panel authentication (the exact 401 body `{"error":"nao-autorizado"}` that `deploy.sh` probes, the link cookie never a session, callback guards), a moderator who never sees their own case, operator pull and ack, panel assets and CSP, `account reports` and `status`.
- `apps/cli/test/moderation-e2e.test.js`: the whole loop on loopback with the real modules (the CLI ceremony, the in-process seeder, the account service on a reserved port so the signed origin carries it, a fake Google, two browser sessions): a linked member reports a post (a repeat is a duplicate, an unlinked key is refused), an e-mail outside `VARANDA_MODERATOR_EMAILS` is refused, the moderator decides 'bloquear', `mod apply --server` pulls, signs, publishes to the seeder and acks, the seeder drops the diary and 'Pendentes' empties; an unblock round trip; the D6 cases (a cancelled unclaimed decision is never published, a cancel after the operator pulled becomes a compensating change); forged operator certificates refused; no e-mail, Google sub or address in any log. Passed 5 of 5 runs on Node 24.22.1 and its one run on Node 20.20.2, about 5 s each.
- `apps/cli/test/panel.test.js`: the panel page (no inline code, no HTML sinks, `textContent` only, no storage), fixed error messages, drafts kept per report, a hostile quote rendered inert, tabs and the "enviada para assinatura" mark.
- `apps/cli/test/mod-apply.test.js`: pull, reconcile, one snapshot, publish before ack, refusal of a local list behind or forked, `--new-list`, exact reply shapes, caps and timeouts.
- `apps/app/test/report.test.js`: request builders, fixed error messages, normalization of the quote and the note.
- `apps/cli/test/cli.test.js`, `apps/cli/test/deploy.test.js` and `apps/cli/test/readme-help.test.js`: flags, help, and the `deploy.sh` checks for `VARANDA_MODERATOR_EMAILS` and the `api/me` probe.

### Human verification

- [ ] The second authorized redirect URI `https://<domain>/account/mod/callback` is registered in the Google OAuth client, `VARANDA_MODERATOR_EMAILS` is set in `deploy/seeder/.env`, and the account container was recreated (`up -d --force-recreate account`, not just restarted).
- [ ] A real Google sign-in at `https://<domain>/account/mod/` on a phone: the panel opens and shows the moderator's own e-mail only.
- [ ] A Google account that is not in the list is refused (`?erro=nao-autorizado`) and gets no session.
- [ ] A real report from the PWA (a post from A Rua, and a whole account from Seguindo) by a linked member: "denúncia enviada"; the same report again says "você já tinha denunciado isso". The reported member's app and every route they can reach show nothing.
- [ ] An unlinked member's sheet asks to link the Google account first; the native app and `varanda-serve` say reports are web only.
- [ ] In the panel a report appears in Abertas with the quote and @usernames and no e-mail; "Descartar" closes it at once and Pendentes stays empty.
- [ ] `mod apply --server https://<domain> --data <modDir>` against production (with `--new-list` only if there is no list yet) prints `aplicado: seq <n>, <k> chaves bloqueadas`; the seeder shows `lista de bloqueio: seq <n> ...`; "Pendentes" empties; "Bloqueadas" shows the same list.
- [ ] The blocked key is purged and skipped by an honest, up-to-date node (a CLI member and the PWA), as in section 13.
- [ ] Block and then cancel in the panel before `mod apply`: no list change. Cancel after the operator pulled but before the ack: the next `mod apply` unblocks.
- [ ] A Google account in `VARANDA_MODERATOR_EMAILS` that is not linked to a diary is refused (`?erro=sem-diario`); a moderator does not see reports against or from their own diary.
- [ ] `mod apply` at a terminal prints one line per member and asks 'Assinar e publicar estas mudanças? [s/N]' (a second time for an unblock of a key blocked outside the panel); without a terminal and without `--yes` it refuses.
- [ ] A scheduled `mod apply --yes` (cron) applies blocks only (at most 100) and reports `desbloqueios aguardando revisão no terminal` for queued unblocks, which stay pending until a run at a terminal; the moderation directory is backed up before each run.
- [ ] `account reports --member <hex>` on the server prints the link e-mails; no other command or route does.
- [ ] `docker compose logs account seeder caddy` shows no e-mail, address, Google subject, report text or note.
- [ ] A sign-in started before the restart fails; after recreating the container the panel asks for a new sign-in, and a report started before the restart answers "a denúncia expirou, tente de novo".

## 15. UX shell: onboarding, names, cursor paging, pull-to-refresh and auto-sync (Stage 1, 2026-10-24)

### Summary

- The app gets a Stage 1 shell: a three-step onboarding ('Passo n de 3'), names and @nomes instead of keys in every list, backward cursor paging with infinite scroll (A Rua 30 then 35, Diário 42, Seguindo 50), pull-to-refresh on native and on the web, a 'ver novidades' pill, loading/empty/error states, and a sync that runs by itself (one continuous `sync.start {}` once the identity is unlocked and the member certificate is confirmed; Ajustes › Sincronização is read-only). Contract additions: RPC `profile.read` and the optional `before` cursor on `feed.read` and `log.read` (`docs/rpc.md`, `docs/protocol.md`), implemented in the core node, the browser node and the shared feed code. The screens are described in `docs/app.md` and the design in `apps/site/artwork/app-design.md`.
- Cleanup: `handleOf`, `atHandle` and `initialsOf` were removed from `apps/app/src/format.js` with their tests, after a grep over `apps/app/App.js`, `apps/app/src` and `apps/app/test` showed that only `format.js` and `format.test.js` mentioned them. `shortKey`, `avatarColorOf`, `relativeTime`, `sinceText`, `countChars`, `interpolateStops` and `MONTHS` stay. No exception to record.
- CI result on the final tree, Node 24.22.1 (run from the worktree root, in this order):
  - `npm run lint`: clean (`standard`), exit 0.
  - `npm test` (all workspaces): 88 test files, 0 failures (core 14, rpc 8, web-member 15, app 17, cli 32, site 2).
  - `npm run demo`: DEMO OK.
  - `node packages/rpc/test/sizes.test.js`: 7 tests, 37 asserts, all pass. Measured worst cases against `MAX_MESSAGE` (262144 bytes): `profile.read` at 100 authors 229170 bytes (largest that fits: 114 authors), feed page of 35 items 256683 bytes, log page of 42 entries 260830 bytes, `follow.list` at 500 keys 33581 bytes.
  - `npm run pack:worklet -w apps/app`: bundle 1931224 bytes, 348 files, 38 linked addon entries; 'node scan: clean'.
  - `npm run build:node -w apps/app`: `NODE_BUNDLE 603299 GZIP 183740`.
  - `npm run export:web -w apps/app`: exported to `apps/app/dist` (ignored by git); service worker with 11 files.
  - `node apps/cli/test/readme-help.test.js`: passes.
  - the whitespace check on the diff (`git diff --check`): clean.
  - `npm ci` was not run (installing was out of bounds for this run); the dependencies were already in the worktree.
- Hidden web tab (PWA PR): a hidden page (`visibilitychange`, `pagehide`; `pageshow` shows it again) sends one `sync.stop` and releases its continuous run and its seeder connection slot; the run restarts as soon as the tab is visible again. An uncertain stop is reconciled through `sync.status`, and a run that is still continuous gets at most one more stop in that hidden period. Continuous sync while visible is unchanged, and the outbox does not send while hidden (the `node.visible` gate in `apps/app/App.js`). The Avisos screen already paused its notices poll while hidden before this change (`shouldPoll` in `apps/app/src/notices.js` gates the interval in `apps/app/src/screens/Avisos.js`); it is unchanged. Code: `apps/app/src/visibility.web.js`, `apps/app/src/node.js` (the hidden stop effect, next to the start gate), `apps/app/src/autoSyncPolicy.js` (`shouldStopForHidden`, `wantsStart`).
- Not verified: anything in a real browser, on a phone, in the iOS simulator, against production or with two devices. See "Human verification"; nothing in that list is marked done.

### Automated (CI)

- `packages/rpc/test/methods.test.js`: the contract of `profile.read` and of the `before` cursor on `feed.read` / `log.read`, with the fixed error `parâmetro inválido: before`.
- `packages/rpc/test/sizes.test.js`: the worst-case responses fit `MAX_MESSAGE` with the maxima in `packages/rpc/lib/limits.js`; `profile.read` with `PROFILE_LIMIT_MAX` (100) keys measured at 229170 bytes, and a post outweighs a profile record in a log page.
- `packages/core/test/session.test.js`: `profile.read` on the core node (an author with no local data is `missing` and gets no core opened, a stored replica without a member certificate is `missing`, duplicates collapse) and `log.read` / `feed.read` paging backwards with `before`.
- `packages/core/test/session-sync.test.js`: `profile.read` over synced replicas: names, usernames, blocked and unknown keys, the own diary.
- `packages/web-member/test/session.test.js`: the same on the browser node, plus `log.read` with `before` (a cursor past the end is the newest page, nothing before the oldest post), the verified username, the same answer while the identity is locked, a blocked replica is `missing`.
- `packages/web-member/test/session-e2e.test.js`: `profile.read` of a CLI member's diary through the browser node over a real replication, including a mixed list.
- `packages/core/test/feed.test.js`: the shared feed paging: `before` pages backwards over every item exactly once, equal timestamps split by author then seq, a cursor newer than everything gives the newest page, the cursor is not mutated, an invalid `before` throws.
- `apps/app/test/who.test.js`: the naming rule (trimmed name, valid username, or 'sem nome'), username validation rejecting malformed and six-hex handles, the reply mark that stays pending until the author is looked up.
- `apps/app/test/paging.test.js`: reversing and merging pages without repeating a key, cursors from the oldest item and the progress requirement, diary rows interleaving invalid blocks, when a screen reloads (initial load, fresh hint, expired load).
- `apps/app/test/syncSignals.test.js`: folding of sync events: download hints survive preemption, the own-diary baseline, fresh acknowledgements, warnings, stale runs and malformed lines ignored, and the chip label precedence.
- `apps/app/test/pull.test.js`: the pull gesture math: bounded damping, activation, direction lock, cancel on sideways moves, arming only at the threshold with a vertical lock, the minimum spinner time.
- `apps/app/test/autoSyncPolicy.test.js`: when a start is wanted, no start while waiting for the node's restart, the wait after a preempted continuous run, reconciliation when the grace passes, the back-off ladder and its reset, the failure map.
- `apps/app/test/onboarding.test.js`: the step machine for hosted and for native/serve, skipping the name always reaches the tabs, locked and recovering take precedence, titles and hints cover every step.
- `apps/app/test/format.test.js`: the remaining display helpers after the removal of `handleOf`, `atHandle` and `initialsOf`.

### Limits

- Every read still preempts the continuous run (#66). Mitigations only: `profile.read` batches (up to 100 keys), a 1 s floor between batches, background lookups wait until the run is 5 s old, the pill instead of an automatic reload, no reload on a tab switch within 60 s.
- Pages are 35 (A Rua, after a first load of 30), 42 (Diário) and 50 (Seguindo). `profile.read` takes at most `PROFILE_LIMIT_MAX` (100) keys per call and reads whole replicas.
- There is no forward ('since') paging.
- The 'ver novidades' pill is a hint from `downloaded` lines and from the web's own-synced line, not a count; it can rarely appear without new posts. The Diário pill exists on the web only (on native there is no own-diary sync signal).
- The Wi-Fi preference (#48) is not done.
- On desktop web a list is refreshed by re-selecting the tab, by the pill or by the 'Atualizar' action; the pull gesture is for touch.
- The name step is skippable per session: skipping is not remembered across sessions.
- `varanda-serve` has no automatic transport reconnection.
- Stages 2-4 (other people's profiles, likes and reposts, media) are not in this change; Seguindo rows are not pressable yet.
- Hidden web tab, not done (superseded on 2026-10-27: a visible idle page now releases the seeder slot too, see section 17, "Duty cycle; the Espiadinha keeps its own link"; the background sync while hidden is still not done): no periodic once runs while the tab is hidden, so the seeder slot stays released for the whole hidden period and nothing syncs in the background. Why: `apps/app/src/names.js:84-92` and `:126-130` wait for a continuous run before the name lookups flush (`quietOk`); `packages/web-member/lib/session.js:600` (`restartIfWanted`) revives only a continuous intent; `packages/web-member/lib/sync.js:96-97` says once runs never wait for media, and the media confirmation only arrives in a continuous run. Releasing the slot while a visible page sits idle (holding the seeder link only while catching up, then a pause) is a separate follow-up PR that keeps the continuous run and adds that release inside the browser node.

### Security audit

Multi-vendor audit of the uncommitted change (2026-10-25): Claude (fable, the audit brief), Claude (the built-in security review) and GPT (gpt-6-astra, max) took part; Grok did not (its usage balance was exhausted, HTTP 402). Result: 1 verified finding, medium, fixed in this PR; nothing critical, high or low remains.

- Fixed (medium, CWE-451): with the key-derived handle gone, a free-form display name such as "@alice" rendered exactly like a member whose verified @nome is `alice` and who has no display name, so a followed member could impersonate the verified identity marker. Now the bold title comes only from the display name (leading at-signs, look-alikes included, removed) or, without one, the @nome written as a name (`alice`), and the `@alice` line appears only from a verified username record (`apps/app/src/who.js`, tests in `apps/app/test/who.test.js`).
- Residual (accepted): two followed members who both have no verified @nome and pick the same display name still look alike in the lists; telling them apart needs the key, which Stage 2's profile pages can show. Moderation (block by key) and reports (by key) are unaffected.

What the implementation was also checked against, by reading and by the tests above:

- No new network surface: `profile.read` and the cursors are local reads on the node's existing RPC; no new route, port or replication behaviour.
- The outbox approval rule is untouched. The drain gate now follows the sync run: the outbox drains while a continuous run is active and never during a once run.
- Keys are never rendered as text in lists. They appear only in the own profile (behind 'mostrar chave'), in Ajustes › Identidade and in the certificate step, where the association needs them. The avatar never shows key characters (only its colour comes from the key).
- Every peer-derived string in the new components (names, @nomes, bios, post text, reasons, event lines) goes through `displayText` from `@varanda/rpc`, as plain text.
- `profile.read` uses the feed's admission rules: a forked, uncertified or blocked diary is `missing`, so it never names anyone.
- The contract validates cursors and key lists (shape, size, duplicates) with fixed error messages.
- An uncertain `sync.start` is reconciled through `sync.status` and never retried blindly; after a preempted stop the app waits for the node's own restart (up to 10 s, extended by each request) before reconciling; the app never sends `sync.stop`.
- Error messages carry no filesystem path or key material.
- No new dependency, no CSP change; the change to the web template (`apps/app/public/index.html`) is CSS only.

### Human verification

- [ ] Hosted PWA on a phone: onboarding from a clean browser ('Passo 1 de 3' to 'Passo 3 de 3'), 'Pular por enquanto' reaches the tabs, the toast 'Tudo pronto. Siga pessoas para encher a Rua.'.
- [ ] Pull-to-refresh on A Rua, Seguindo and Diário (indicator, 72 px threshold; the page still scrolls normally; a sideways swipe does not trigger it).
- [ ] The 'ver novidades' pill appears after another device publishes, and tapping it loads the new posts.
- [ ] Infinite scroll on a followed diary of 100 posts to the very end: no repeats, no gaps, 'Isso é tudo por enquanto.' in A Rua and 'Início do diário.' in Diário; with the network cut mid-scroll, the failed page waits for 'tentar de novo' / 'mostrar mais'.
- [ ] Names for a member with an old profile, for one with no profile ('sem nome') and for a reply to an author not yet looked up ('…' then the name); no key text in any list.
- [ ] The sync chip toggling with airplane mode ('sem rede', then 'reconectando…', then 'sincronização automática'), and 'sincronizando…' during a download.
- [ ] Ajustes › Sincronização is read-only (no button) and shows the state, the last stop and the event log.
- [ ] iOS simulator: the system refresh control on the lists, re-selecting the current tab scrolls to the top and refreshes.
- [ ] `varanda-serve` mode: onboarding steps 'Sua identidade', 'Certificado de membro' and the name, and the lists with names.
- [ ] Two devices: publish on one, the other shows the post after its refresh or the pill; the outbox of a device that was offline drains once the continuous sync is back.

## 16. End-user polish, staying signed in, follows on every device, photos and GIFs (2026-10-25)

### Summary

- The app reads as a social app for people: no sync chip (a calm 'Sem internet' note only while offline), refresh by pulling on touch and by the wheel or trackpad on desktop (with a visually hidden, focusable 'Atualizar' for the keyboard), plain-language copy, Diário showing publications only, and Ajustes split into a main list (Editar perfil, Conta e @nome, Guardar dados neste aparelho, Instalar o app, Sair) and a collapsed Avançado (Conexão, Sincronização, Identidade técnica, Recomeçar). Screens: `docs/app.md`; design: `apps/site/artwork/app-design.md`.
- Staying signed in on the web: the passkey's PRF output is kept sealed (AES-GCM-256 under a non-extractable `CryptoKey`, bound to the rp.id and the identity) in its own IndexedDB database `varanda-session`, so a reload resumes without WebAuthn until 'Sair' or 30 days without opening the app (each open refreshes the period). This reverses the earlier "key only in memory" rule; the trade-off is in `docs/design.md` and `docs/rpc.md` section 11.
- Follows on every device: `follow` records in the own diary (public), local-first on the browser node (only while unlocked; every queued change signed with the identity key and verified before it is appended), old per-device follows published only after the person confirms them (the Seguindo card 'Pessoas que você seguia neste aparelho', host controls `follows.legacy()` / `confirmLegacy(keys)`), folded back from the diary by the sync (RPC event `follows.changed { count }`). The CLI and the core node append the record too.
- Photos and GIFs: posts carry up to 4 media descriptors pointing into a per-device media core; the seeder binds media cores to diaries two ways, keeps them under the same `admitted.json` invariants and serves blocks over `GET|HEAD /media/<D>/<K>/<start>/<blocks>`; the hosted PWA verifies every byte (length and SHA-256) before showing it. Images only, no video: the illegal-media hash check is not implemented (Residual risks).
- Contract: records `media-core` and `follow`, `post.media`, the media header (`docs/protocol.md` section 2), seeder media admission and the media route (sections 5 and 7), `post.create` / `post.reply` `media`, `FeedItem.media`, `follows.changed`, `report.sign` with an empty quote, and page maxima lowered to `FEED_LIMIT_MAX` 31 and `LOG_LIMIT_MAX` 36 (`docs/rpc.md`).

### What changed, per area

- `packages/core`: `lib/records.js` (descriptor, the two record types, media constants), `lib/media.js` (new, pure helpers), `lib/seeder.js` (media scan, binding, admission, startup step 3b, purge rules, `mediaRead`, `stats()` `mediaCores` / `mediaBytes`, `seed list` / `seed drop` with media), `lib/store.js` (`openMediaReplica`), `lib/member.js` (`follow` / `unfollow` append a `follow` record), `lib/feed.js` (`FeedItem.media`), `lib/session.js` (`'mídia disponível só na versão web'`).
- `packages/rpc`: `media` params, `follows.changed`, `report.sign` empty quote with seq, `FEED_LIMIT_MAX` 35 -> 31 and `LOG_LIMIT_MAX` 42 -> 36 (worst cases re-measured).
- `packages/web-member`: `lib/session-store.js` (new), resume / 'Sair' in `web/node.js` (the `signedOut` marker and the session-database deletion as two barriers), per-device media key (`lib/passkey.js`), `mediaUpload` host control, lazy paged storage for media cores (`lib/node-storage.js`), local-first follows with drain and fold, media replication and push confirmation in `lib/sync.js`.
- `apps/cli`: the `/media` route on the WebSocket listener (`lib/seed-ws.js`), media metrics (`lib/health.js`), `seed list` media lines and media events (`lib/commands/seed.js`), human `log` lines and `[foto]` in `feed` (`lib/commands/member.js`).
- `deploy/seeder/Caddyfile`: `handle /media/*`, excluded from `@mutavel` and `@ausenteApp`; CSP unchanged.
- `apps/app`: `OfflineNote`, `MediaGrid`, `MediaView`, `EmojiPicker`, `src/media/*` (attach, encode, fetch, cache, plan), `src/emoji.js`; `SyncChip` removed; the service worker never intercepts `/media/`.

### Automated (CI)

CI result on the final tree, Node 24.22.1 (run from the worktree root, in this order):

- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 100 test files, 0 failures (core 15, rpc 8, web-member 21, app 21, cli 33, site 2).
- `npm run demo`: DEMO OK.
- `node packages/rpc/test/sizes.test.js`: 7 tests, 37 asserts, all pass. Measured worst cases against `MAX_MESSAGE` (262144 bytes): feed page of 31 items 260001 bytes, log page of 36 entries 258946 bytes, `profile.read` at 100 authors 229170 bytes, `follow.list` at 500 keys 33581 bytes.
- `npm run pack:worklet -w apps/app`: bundle 1944309 bytes, 349 files, 38 linked addon entries; 'node scan: clean'.
- `npm run build:node -w apps/app` (run by `export:web`): `NODE_BUNDLE 636946 GZIP 194188`.
- `npm run export:web -w apps/app`: exported to `apps/app/dist` (ignored by git); service worker with 11 files.
- `node apps/cli/test/readme-help.test.js`: passes.
- the whitespace check on the diff (`git diff --check`): clean.

New test files: `packages/web-member/test/e2e-media.test.js`, `packages/core/test/media.test.js`, `packages/core/test/seeder-media.test.js`, `packages/web-member/test/session-store.test.js`, `resume.test.js`, `session-media.test.js`, `media-ops.test.js`, `sync-media.test.js`, `apps/app/test/emoji.test.js`, `mediaPlan.test.js`, `mediaFetch.test.js`, `mediaCache.test.js`; extended: the rpc, session, seeder, seed-ws, feed, records, node-storage and pull tests.

### End-to-end (in process)

`packages/web-member/test/e2e-media.test.js` (4 tests, 114 asserts; passed in each of 3 runs) drives a browser session against a real in-process seeder and CLI member:

- A 100 KiB upload (3 x 32 KiB + 4 KiB blocks) reaches the seeder, and `GET /media/<D>/<K>/<start>/<blocks>` answers 200 with a byte-identical body whose SHA-256 equals the descriptor's; `HEAD` gives the same `Content-Length`; a wrong core, diary or range gives 404.
- The browser's Hypercore 10 COMPAT media core interoperates with the Hypercore 11 seeder exactly as diaries do (the seeder's core key equals the media public key, compat true).
- Largest browser -> seeder frame: 32,867 bytes, about 0.39 % of `MAX_EXTERNAL_FRAME` (8,454,144); one block per frame (41 frames, 107,400 bytes in total).
- Upload to `media-admitted`: 60-89 ms.
- A second device (same identity, new storage) rebuilds the follows from the diary on its first run (one `follows.changed { count: 2 }`) and then applies an unfollow made on the first device (`count: 1`).
- The CLI member's `feed` shows `[foto]` and `feed --json` carries the descriptor intact.

### Fixes made in this verification

- Photos upload only on Publicar (critical, GPT audit): attaching a photo used to upload it at once, so a photo the person then removed or never posted was already public in the media core. Now attached photos stay in the page's memory until Publicar (`apps/app/src/screens/Publicar.js`).
- Sign-in expires after 30 days idle (owner decision after a finding escalated to high): the stored session of the browser node is no longer kept indefinitely; the passkey is asked again after 30 days without opening the app (`packages/web-member/lib/session-store.js`).
- Follow changes refused while signed out and signed before publication (escalated to high): `follow.add` / `follow.remove` refuse while the identity is locked, and every queued change carries an Ed25519 signature by the identity key that is verified before the `follow` record is appended, so changes planted in the storage of a signed-out profile are dropped (`packages/web-member/lib/member-ops.js`, `lib/session.js`).
- Old follows confirmed, not published automatically (owner decision after the re-audit): a device's follows from before `follow` records existed were appended to the diary automatically at the first sign-in, but that local list cannot be authenticated, so a planted entry would have been published. Now the Seguindo card lists them (names, or 'Alguém sem nome' with a short key fragment; checkboxes on by default; 'Publicar selecionados' / 'Agora não') and only the confirmed ones become signed follow changes; the rest leave that device (`packages/web-member/lib/member-ops.js` `legacyFollows` / `confirmLegacyFollows`, `apps/app/src/screens/Seguindo.js`).
- Replay of signed follow changes (escalated to high): a signed change copied or kept in the queue could be appended again after the diary had already recorded it, or after a newer decision. Now the drain keeps one change per key (the newest `at`), skips any change whose key already has a diary `follow` record with `at` at or after the change's (the record reuses the change's own `at`), and the queue is capped at `MAX_INVENTORY - 1` when read and written (`packages/web-member/lib/member-ops.js` `drainFollows`, `lib/node-store.js` `readFollowsPending`).
- Fresh-device fold (`packages/web-member/lib/node-store.js` `writeFoldedFollows`): a device with no local follows and no pending changes was never marked migrated, so later folds of the diary's `follow` records were held back. Now such a device counts as migrated on its first fold. The end-to-end test above caught it, independently of the cross-vendor review.

### Human verification

None of these was performed for this change.

- [ ] Phone, installed PWA: no sync chip anywhere (not performed yet).
- [ ] Phone, airplane mode: 'Sem internet' appears under the top bar and disappears when the network is back (not performed yet).
- [ ] Pull-to-refresh on A Rua, Seguindo and Diário (not performed yet).
- [ ] Desktop: wheel / trackpad refresh at the top of a list, and the hidden 'Atualizar' appears on keyboard focus (not performed yet).
- [ ] Reload and reopen keep you signed in (no passkey prompt) (not performed yet).
- [ ] 'Sair' asks for the passkey again on the next load (not performed yet).
- [ ] Attach photos and close the composer without Publicar: nothing is uploaded (no `/media` growth at the seeder) (not performed yet).
- [ ] Post 1, 2, 3 and 4 photos and a GIF; the grid layouts and the full-screen viewer (not performed yet).
- [ ] Download a posted photo and check its EXIF: no GPS (not performed yet).
- [ ] A second device shows the same follows and the photos (not performed yet).
- [ ] Ajustes: Avançado holds every technical item (Conexão, Sincronização, Identidade técnica, Recomeçar); the main list has none (not performed yet).

### Residual risks

- No illegal-media hash check: `docs/design.md` promises a comparison with lists of hashes of known illegal material before showing or relaying; it is not implemented. This PR therefore ships images only, no video. A blocked diary's media cores are purged with it.
- A same-origin script can use the stored session: the `CryptoKey` is not exportable, but any script on the origin can call decrypt and act as the member (an XSS was already a full compromise while unlocked); anyone holding the unlocked device or profile can post until 'Sair' or the 30-day idle expiry.
- The wrapping AES key lives in the same browser profile as the sealed PRF output: a copy of the profile yields the identity until 'Sair' or 30 days idle. The sealing only keeps the PRF output out of plain storage and stops the record alone from opening elsewhere.
- Follows stored on a device before the update are not published automatically: the person confirms them in the Seguindo card 'Pessoas que você seguia neste aparelho'. Until the person decides, that device keeps its old list locally and does not receive follow changes from other devices. A confirmed follow cannot be taken back from the diary (append-only; only a later `on: false` record undoes it).
- Follows are public: anyone holding a diary reads whom its member follows.
- Old readers (apps, CLIs, seeders from before this change) skip media posts and the new records entirely; there is no text-only fallback.
- One media core per device, no rotation: at 8192 blocks / 256 MiB uploads fail with 'espaço de fotos deste aparelho esgotado'.
- Push confirmation of a media core counts a block "served" to the seeder on this link as held; served is not proof of storage (a later link's advertised length is the truth).
- A transient IndexedDB error while loading the stored session clears it: the person signs in with the passkey once more.
- Nothing is uploaded until Publicar (attached photos stay in the page's memory; removing one or closing the composer discards it). Once Publicar is pressed the uploaded bytes are public and permanent in the device's media core even if a later upload or the post fails: the only remaining case of unreferenced public bytes.
- The media route's rate limit and caps are global (16 in flight, 64 requests/s, burst 128), with no per-client limit, because the deployment never handles client IP addresses: one client can make photos answer 503 for everyone, and hold slots up to the 120 s deadline.
- Media responses are cacheable for a year (`Cache-Control: public, max-age=31536000, immutable`): a later block of the author does not purge browser caches (the feed hides blocked authors' posts).
- `mediaRead` reads each block twice (once for the exact `Content-Length`, once to stream).
- A post can be visible before its photos reach the seeder: the write gate confirms the diary push, and the media blocks travel through the continuous sync moments later. If the tab closes or the network drops right after posting, viewers see 'foto indisponível' until that device reconnects; the app retries a failed photo a few times automatically (`apps/app/src/ui/MediaView.js`) and on a tap.
- Device-count limit: `MAX_MEDIA_CORES` = 4 with one media core per device and no rotation. A member who posts photos from a 5th device makes the seeder drop the oldest device's core (`unbound`); its photos answer 404 for everyone until that device declares its core again by uploading a new photo, and are lost for good if that device is gone.
- Core node and CLI follows: `follow` / `unfollow` append `follow` records once block 0 exists, but an existing `follows.json` is never migrated into the diary unless the follow is run again, and the core node never folds another device's `follow` records into `follows.json`.
- Follow changes made on another device take effect on this device's next sync run (the continuous run restarts once per change); the core node and `varanda-serve` do not fold another device's follows into `follows.json`.

## 17. Espiadinha: the discovery tab without an algorithm (PR feat/espiadinha, 2026-10-26)

### Summary

- The fourth tab ("Espiadinha", provisional label; second in the tab bar, after A Rua) shows what the diaries the person does NOT follow are publishing, by one public rule (`PEEK_RULE`, `packages/core/lib/peek.js`): "A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos." Definition: round r (0, 1, 2; `PEEK_MAX_ROUNDS` = 3) holds the (r+1)-th highest-`seq` top-level post of every candidate diary ("most recent" = last written in the diary, not the newest `at`); replies are excluded [superseded 2026-10-27: sections 18 and 19 include replies, quotes, reposts and the own diary; the rule text now ends the first clause with "o seu incluído"; superseded again 2026-10-28: section 34 takes the own diary back out of its owner's Espiadinha and the rule text loses "o seu incluído"]; page order is (`round` asc, `at` desc, `author` asc); posts carry their `media`, shown through the existing `/media` route as in A Rua.
- Files: `packages/core/lib/peek.js` (the pure rule: candidates, window, per-diary result, page), `packages/web-member/lib/peek.js` (transport and memory, in the browser node), `packages/web-member/lib/session.js` (the `peek.read` handler) and `lib/storage.js` (64 KiB memory pages), `packages/rpc` (`peek.read`, `PEEK_LIMIT_DEFAULT` 30, `PEEK_LIMIT_MAX` 31; `docs/rpc.md` 5.22 and 13), `packages/core/lib/session.js` (the node session answers that it is web only), `apps/app/src/screens/Espiadinha.js` and `apps/app/src/peek.js` (screen and pure helpers), `apps/app/App.js`, `ui/TabBar.js`, `ui/Icon.js`, `ui/PostRow.js`.
- Trust model: nothing is gained by the seeder compared with A Rua. It can withhold (an inventory entry, a block, a shorter length, an older signed state it kept); it cannot forge (Hypercore verifies every block against the author key), cannot choose which post is shown (the client reads the signed tail: the window comes from the length Hypercore verified with block 0, never from the length advertised in the hello), cannot bypass the block-0 gate (checked locally with the stored revoked-issuer set, block 0 alone, before any other block of that diary) and cannot unblock anyone (the stored signed blocklist is re-applied on every read). Later windows are accepted only if their core has the same verified length and the same `treeHash` as the first window.
- Data flows and retention: browser memory only. The node keeps one snapshot for at most 5 minutes (`PEEK_SNAPSHOT_TTL_MS`, retained records capped at 32 MiB); the UI keeps the page until the list is refreshed. Nothing is written to storage, the account service learns nothing, and the only server-side trace is one `peer` log line per link at the seeder (ephemeral Noise key; the seeder log is size-rotated).
- Questions decided by default (no owner answer was available): (1) rounds rule, 3 rounds of one post per diary, not "all posts newest first" (keeps one prolific diary from filling the tab); (2) replies are excluded [superseded 2026-10-27: replies, quotes and reposts are included since section 18]; (3) the tab is second in the bar; (4) no extra transport guards on the browser side beyond the ones the sync link already has (see residual risk 12).
- The two riskiest assumptions from the objection round: (a) external socket capacity: the seeder admits 32 external sockets and each hosted member already holds one, so many members online can starve the peek link (item 17); (b) cutoffs causing unequal exposure: the 5 s inventory cut, the 25 s page deadline and the 16 MiB budget can leave some diaries out; mitigated by a random fetch order per snapshot (a cut falls on random diaries) and by the `incomplete` flag the app shows.
- Pages: the first page has 30 items, continuation pages up to 31. `next` is the cursor of the last item exactly when the page is full; a page cut by the deadline or the byte budget still carries a cursor (diaries still pending count as exhausted for that read only) and is `incomplete`. Unavailable block 0 skips the diary and marks the page incomplete. One peek runs at a time; a disconnect frees the slot at once; a read never preempts the sync.

### Automated (CI)

CI result on the final tree, Node 24.22.1 (run from the worktree root, in the order of `.github/workflows/ci.yml`):

- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 103 test files, 0 failures (core 16, rpc 8, web-member 22, app 22, cli 33, site 2).
- `npm run demo`: DEMO OK.
- `node packages/rpc/test/sizes.test.js`: 8 tests, 42 asserts, all pass. Measured worst cases against `MAX_MESSAGE` (262144 bytes): peek page of 31 items 238402 bytes, feed page of 31 items 260001 bytes, log page of 36 entries 258946 bytes, `profile.read` at 100 authors 229170 bytes, `follow.list` at 500 keys 33581 bytes.
- `node packages/core/test/peek.test.js`: 20 tests, 818 asserts, all pass.
- `node packages/web-member/test/peek.test.js`: 26 tests, 259 asserts, all pass (about 36 s; includes a 50-diary page in 36 ms against a real in-process seeder).
- `npm run build:node -w apps/app`: `NODE_BUNDLE 650004 GZIP 198790`.
- `npm run pack:worklet -w apps/app`: bundle 1945790 bytes, 349 files, 38 linked addon entries; 'node scan: clean'.
- `npm run export:web -w apps/app`: exported to `apps/app/dist` (ignored by git); `sw.js` 12783 bytes, 11 files.
- `node apps/cli/test/readme-help.test.js`: 2 asserts, passes.
- the whitespace check on the diff (`git diff --check`): clean. It covers tracked files only; the new untracked files were not covered by it.

Not run: the same battery under Node 20 (Node 20.20.2 is installed but was not used), `npm ci` (installing was out of bounds; dependencies were already in the worktree). Nothing was run against production, a real browser or the pilot seeder.

New test files: `packages/core/test/peek.test.js`, `packages/web-member/test/peek.test.js`, `apps/app/test/peek.test.js`; `packages/rpc/test/methods.test.js`, `sizes.test.js`, `packages/core/test/session.test.js` and `packages/web-member/test/session.test.js` were extended. The test runner discovers the new files by pattern (`scripts/run-tests.js`); there is no CI, deploy or Caddy change, and the transport stays on `/seeder`, which the CSP already allows.

### Limits

- Constants (`packages/core/lib/peek.js`, `packages/rpc/lib/limits.js`): `PEEK_HEAD_BLOCKS` 3, `PEEK_TAIL_BLOCKS` 8, `PEEK_MAX_BLOCKS_PER_DIARY` 64, `PEEK_MAX_ROUNDS` 3, `PEEK_PARALLEL` 16, `PEEK_FETCH_TIMEOUT_MS` 10000, `PEEK_PAGE_TIMEOUT_MS` 25000, `PEEK_CONNECT_TIMEOUT_MS` 15000, `PEEK_SNAPSHOT_TTL_MS` 300000, `PEEK_PAGE_MAX_BYTES` 16777216 (16 MiB), page 30 / 31.
- Cost per page (`docs/rpc.md` 5.22 and 13): one WebSocket, Noise and hello (1 round trip each at the start), the inventory at about 85 bytes per entry (4096 entries about 340 KB), then per candidate one channel and at most 11 block requests in two phases (block 0, then the window), 16 diaries in parallel. Documented estimate: about 3-5 s for 300 diaries at 50 ms RTT (an estimate, not measured on the pilot). Memory in the browser: raw buffers released after every window, between pages only retained records (at most 32 MiB per snapshot) and 64 KiB memory pages per open core. At the seeder: one extra short-lived external socket and reads of blocks it already holds; no new state.
- Theoretical maximum: 4096 diaries x 11 blocks x 16 KiB = 738,197,504 bytes (704 MiB), against the 16 MiB page budget; with a random order the budget (or the 25 s deadline) cuts the page and marks it incomplete rather than fetching it all.
- Known limits [superseded 2026-10-27: replies appear since section 18; the own diary is included since section 19; superseded again 2026-10-28: section 34 takes the own diary back out of its owner's Espiadinha and the rule text loses "o seu incluído"]: replies do not appear; names come only from the first blocks and the fetched tail ("sem nome" otherwise); `at` is author-supplied (up to 24 h ahead is accepted); rows already shown are removed only on the next load; no city or state; up to 3 posts per diary; native app and `varanda-serve` answer that the Espiadinha is web only.

### Security audit

Checked by reading the final code and the tests named (not a multi-vendor audit run):

1. No storage write. `grep` over `packages/web-member/lib/peek.js` finds only reads (`store.readFollows`, the stored blocklist) and the memory storage; it opens no storage core. Verdict: pass; test 5 also checks that nothing is stored.
2. An unverified endpoint never gets a core (test 4): no replication before the verified hello (role `seeder` and `seederCertForKey` on the Noise key). Pass.
3. A blocked key and a revoked issuer are hidden without any sync, also on continuation pages (test 3). Pass.
4. The gate runs before content, fork and quota are handled (tests 9 and 10): block 0 alone is requested first and a failing block 0 never gets a second request. Pass.
5. No key shown as text in the screen: the screen renders names, @names and "sem nome"; the author key only keys the list and the report action. Pass (by reading `apps/app/src/screens/Espiadinha.js`).
6. `displayText` on every peer string, through `PostRow` for name, @name and text. Pass.
7. Sockets: one extra short-lived external socket per page against `maxExternal` (`packages/core/lib/seeder.js`, 32 by default) and `MAX_SOCKETS` 128 (`apps/cli/lib/seed-ws.js`). Accepted; see 17. Kept on 2026-10-27 whatever the sync state: the page never borrows the sync link (privacy, see "Duty cycle; the Espiadinha keeps its own link").
8. Privacy: the seeder sees an anonymous link from the same IP asking for the complement of the follows, which it already learns from the sync link; one `peer` log line per link (`packages/core/lib/seeder.js` `_attachPeer`, printed by `apps/cli/lib/commands/seed.js`); nothing new on the account service. Pass.
9. The client timeout (30 s, `DEFAULT_TIMEOUT_MS`) is above the page deadline (25 s). Pass.
10. A concurrent `peek.read` is refused (`'espiadinha já em andamento'`, test 13). Pass.
11. `close()` during a read ends it and closes the socket (test 8). Pass.
12. Residual: no frame guard on the browser side beyond what the sync link has (Question 4): at most `PEEK_PARALLEL` oversized frames can be received past the budget before the link is destroyed.
13. The window comes from the verified length, not the advertised one (test 11). Pass.
14. Revocation is re-verified on continuation pages served from the snapshot (test 12). Pass.
15. Concurrent read and shutdown (test 13, plus the detach regression tests). Pass.
16. Memory pages and budgets (tests 14 and 15, and the regression tests for the byte budget, the oversized block and the TTL). Pass.
17. Capacity: the seeder admits 32 external sockets and every hosted member holds one, so with about 30 hosted members online a peek can be refused with `'sem conexão com o semeador'`; the person retries. The lease of 2026-10-27 does not change this: the Espiadinha still costs a short extra external slot per page while it loads. Estimated from the constants, NOT measured on the pilot seeder.

### Human verification

None of these was performed for this change.

- [ ] Hosted build, 320 px wide: four tabs fit and nothing overflows (not performed yet).
- [ ] Round order with three test accounts: all first posts, then all second posts, with the separator between rounds (not performed yet).
- [ ] "seguir" on a row moves that diary to A Rua and the row leaves the Espiadinha on the next load (not performed yet).
- [ ] "denunciar" opens the sheet for a row (not performed yet).
- [ ] Pull-to-refresh rebuilds the list (not performed yet).
- [ ] Last page: no further loading and the end state shows (not performed yet).
- [ ] Offline: the "Sem internet" notice shows and "tentar de novo" works when back online (not performed yet).
- [ ] Native app and `varanda-serve`: the tab explains it is web only and never errors (not performed yet).
- [ ] An old PWA bundle against a new node (or the reverse) answers "método desconhecido" and the tab shows the web-only notice (not performed yet).
- [ ] Caddy logs show no new route and no new error (not performed yet).
- [ ] Browser heap observed during a page against the pilot seeder (not performed yet).

### Duty cycle; the Espiadinha keeps its own link (2026-10-27)

Superseded on 2026-10-30 by section 54: the hosted web no longer ends the link when idle (lease off), so the 8 s hold and 45 s gap checks below no longer apply; the Espiadinha part stands.

Scope: the hosted web app with the node in the browser (`packages/web-member`, `apps/app`). The native app, `varanda-serve` and the CLI are unchanged.

#### Summary

- The lease (`packages/web-member/lib/session.js`, header "The lease"; enabled by `packages/web-member/web/node.js` with `leaseHoldMs` 8000 and `leaseGapMs` 45000). A user's continuous run whose seeder link is settled (inventory complete and not timed out, no unmet goal, no failing follow, and every own media core with blocks confirmed pushed, or `leaseMediaMaxMs` 120000 elapsed) for 8 s ends with `sync.stopped { reason: 'idle' }`, keeps the continuous intent and holds no socket for 45 s (`leaseGapMs`). The 8 s clock survives preemptions by member reads and is reset only by an unsettled report or another end of the run. A borrow (`borrow(fn)`) holds the link for as long as it runs, never past `LEASE_BORROW_MAX_MS` 30000 from the first borrow. A `sync.stop` that lands while an idle run unwinds makes its reason `'stopped'` and clears the intent; only the lease produces `'idle'`.
- Redial inside the gap happens only for `sync.start`, a diary write (which clears the gap first) and a `diary.peek`. Member reads of the gap (feed, profile, log, engagement, node.info, as the lease header lists them) do not redial.
- App: `apps/app/src/autoSyncPolicy.js` waits `IDLE_GAP_MS` 45000 after an `'idle'` end (`nextBackoff`), and `apps/app/src/syncSignals.js` folds `'idle'` into the chip `'em pausa'` (also the reason text in `apps/app/src/screens/Sincronizar.js`); `'em pausa'` is not shown while the app waits to retry after a failure (`reconcileIdle`, `endIdle`). Pull-to-refresh (`syncNow` in `apps/app/src/node.js`) follows `refreshPlan`: offline, hidden, with automatic sync off or given up (or a start in flight), it only re-reads the device's data without waiting; otherwise it waits through `waitForCatchUp`, which counts only a verified seeder link (`peer seeder`): about 1.5 s with no download after the last one, at most 10 s, and a dropped seeder link (`aviso: sem conexão com o semeador`) restarts the count.
- Hidden tab: `shouldStopForHidden` sends one `sync.stop` at once, also when the tab is hidden during the 45 s idle gap (no run active, the continuous intent the node kept is released), and showing the tab starts a fresh run at once (`visibilityChange` clears the idle gap; `apps/app/src/node.js`).
- Espiadinha (`packages/web-member/lib/peek.js`, `docs/rpc.md` 5.22): unchanged by the lease. Every page that needs blocks opens its own short link with an ephemeral Noise key that announces nothing, whatever the sync state, and closes it after the page, on a budget overrun and on abort. It never borrows the sync link and does not hold the lease. The one fix kept from this work in `peek.js`: a get ended by the budget cut (`run.overBudget`) is no verdict on the diary (no `unavailable`, no hole), even before the destroyed link's `close` event sets `run.lost`.
- Privacy decision (user decision, privacy over capacity): an earlier draft of this change served the Espiadinha over the live sync link to save the second external slot. A security audit (escalated to high) found that this lets the seeder bind the browsing of unfollowed diaries to the member's identity: the sync link already announced the member's diary key and follow inventory, whereas the design (`docs/design.md`) uses a short connection with an ephemeral key that announces nothing. The draft was reverted before merge; the slot cost stays (Limits below).
- `diary.peek` is the only borrower of the lease (`borrow(fn)`, from its wait to its answer). It already rode the sync link before this change, so that is not a privacy regression; a run that ends while a `diary.peek` waits runs the restart check again once `run` is clear.
- Notices (`notices.list`, `packages/web-member/lib/notices.js`) also keep their own short link: their channel proves the diary key with a signature bound to that link's Noise key. Each read takes one extra external slot against `maxExternal` 32.
- Web Lock and the Wi-Fi preference (#48) are untouched: one tab per browser still opens the node, and the app still syncs on any network whenever it is open.

#### Automated (CI)

Test files in the tree that cover this change (their results are recorded by the CI run of the pull request, not in this section):

- `packages/web-member/test/lease.test.js` (10 tests): an idle leased run emits `idle`, keeps the intent, and only `sync.start`, a write or a `diary.peek` dial again; a `profile.read` every 100 ms does not hold the link up; a `sync.stop` queued behind a preempting read clears the hold clocks; an unconfirmed own media core holds the lease until `leaseMediaMaxMs`, a confirmed one does not; `leaseHoldMs` 0 keeps a settled run running; `borrow` holds the lease while it runs; a `diary.peek` around the hold is served (it holds the lease, and one waiting when the run ends is redialled); a `sync.stop` during an idle unwind ends it `stopped`; after a link drop the reconnected link must confirm the media core again; a preemption during a reconnect backoff waits for the old socket to close.
- `packages/web-member/test/peek.test.js` (1 new test): with a live continuous run, a `peek.read` opens its own short socket (the socket count goes up by one during the page, that socket is closed after it), the sync socket stays open, no `sync.stopped` is emitted, and the page is served.
- `apps/app/test/autoSyncPolicy.test.js` (3 new tests): the idle gap is exactly 45 s and independent of the failure ladder; `namesQuiet` keeps the idle gap and the 5 s quiet window; the gap belongs only to the last continuous run and ends at the next start.
- `apps/app/test/syncSignals.test.js` (4 new tests): refresh waits for a settled inventory and ignores early own-sync and stale stops; refresh can await an existing run, time out, or cancel on teardown; refresh on a run whose link is already up starts the quiet window at once; refresh resolves once a verified link goes quiet.

#### Limits

- Freshness: a visible tab that is in its idle gap sees another device's posts within about 45 s (the gap) plus the next run's catch-up. A hidden tab sees them only when it is shown again. Pull-to-refresh adds no freshness beyond the link it waits for. Numbers are from the constants above, not measured on the pilot seeder.
- The Espiadinha still costs a short extra external slot per page while it loads (its own link, by the privacy decision above), and can be refused when the seeder's 32 external slots are taken (`'Semeador ocupado; tente novamente em instantes.'` after the seeder's 1013 close, section 24; `'sem conexão com o semeador'` from an older seeder that drops the socket without a close frame). It does not redial the sync in a gap.
- The seeder slot is released while a visible page is idle. Background sync while the tab is hidden is still not done.
- Notices keep their own short link too; reducing those extra slots without binding the reads to the member's identity is a capacity follow-up.

#### Human verification

None of these was performed for this change.

- [ ] Hosted web: leave the app visible for 60 s on a seeder with no other activity; the connection closes at about 8 s after the last catch-up and reopens within about 45 s after that (not performed yet).
- [ ] Two devices: publish on one, and see it on a visible idle tab of the other within about 45 s (not performed yet).
- [ ] Hidden tab: the connection closes at once, and showing the tab restarts the run (not performed yet).
- [ ] Pull-to-refresh on an idle tab: the list refreshes after the link goes quiet, never later than 10 s (not performed yet).
- [ ] Espiadinha with the sync running: the seeder log shows a second, short `peer` link for the page that closes after it, and the sync link stays up (not performed yet).

## 18. Profiles, threads, likes, reposts and quotes (2026-10-26)

### Summary

- Likes, reposts and quotes are signed records in the engager's own diary: `like` and `repost` (`{ type, to: { author, seq }, on, at }`, the last operation per (type, target) wins, self-engagement allowed) and a quote, a `post` with a `quote` target and no `replyTo` (`'quote-with-reply'`, `'quote-invalid'`). Old readers skip them as invalid; the diary is never rejected. FeedItems gain `kind` ('post' | 'repost') and `quote`. Contract: `docs/protocol.md` section 2 and "FeedItem".
- The seeder keeps an in-memory engagement index (replies, quotes, likes, reposts, each member's posts, profile / username seq hints), rebuilt at start on its own scan cursor, capped (the cursor pauses at the cap, never skips) and honest (`indexing`, `complete`), served over `GET|HEAD /index/post/...`, `/index/counts/...` and `/index/member/...`. It only says where to look; counts and completeness are the seeder's claims (`docs/protocol.md` sections 5 and 7).
- The browser node reads any admitted diary on demand with `diary.peek`, inside the running sync, in memory only, gated like a quarantine fetch and verified block by block; the core node answers 'leitura sob demanda só na versão web' (`docs/rpc.md` 5.26, `docs/protocol.md` section 6).
- RPC: `post.quote`, `like.set`, `repost.set`, `engagement.read`, `diary.peek`; limits `ENGAGEMENT_LIMIT_MAX` 62, `PEEK_SEQS_MAX` 36, `PEEK_TIMEOUT_MS` 8000; worst cases re-measured (`docs/rpc.md` section 2).
- App: a screen stack above the tabs with Conversa (parent, post, every reply paged) and Membro (anyone's profile: header, Seguir/Seguindo, 'denunciar a conta', posts and reposts); browser Back, Escape and Android Back close screens; PostRow gets pressable author / parent / reposter / quote and an action bar (responder, republicar, citar, curtir, counts when known); A Rua and Diário show reposts and quote cards; Publicar has a quote mode; strangers' photos are fetched with `cache: 'no-store'`. Screens: `docs/app.md`; design: `apps/site/artwork/app-design.md`.

### What changed, per area

- `packages/core`: `lib/records.js` (`like`, `repost`, quote posts, `likeRecord` / `repostRecord`, `postRecord({ quote })`), `lib/engagement.js` (new, `engagementState`), `lib/feed.js` (`kind`, `quote`, repost items, CLI lines), `lib/engagement-index.js` (new), `lib/seeder.js` (index scan, cap and pause, flags, removal on drop, `indexPost` / `indexCounts` / `indexMember`, `stats()` `indexRecords` / `indexSaturated`), `lib/member.js` and `lib/session.js` (core node toggles, quote without media, `engagement.read`, `diary.peek` web-only).
- `packages/rpc`: the five methods, the three limits, size proofs for quote records, `diary.peek` and `engagement.read`.
- `packages/web-member`: `lib/member-ops.js` (toggles, quote, `engagementRead`), `lib/session.js` (the write path for the new writes, `diary.peek` outside the serial chain with a waiting restart and one retry), `lib/sync.js` (peek served by the run, a shared refcounted link core per key, the gate, reads bounded by the seeder's advertised length, fork / blocklist / issuer re-check before answering), `lib/node.js` (header).
- `apps/cli`: `/index` routes on the WebSocket listener (`lib/seed-ws.js`), index metrics (`lib/health.js`), `log` lines for the new records (`lib/commands/member.js`).
- `deploy/seeder/Caddyfile`: `handle /index/*`, excluded from `@mutavel` and `@ausenteApp`; CSP unchanged. `apps/app/scripts/sw.js`: never intercepts `/index/`.
- `apps/app`: `App.js` (screen stack, Back handling), `src/nav.js`, `src/history.web.js` / `history.native.js`, `src/indexClient.js` (strict validation, 64 KiB body cap, 8 s timeout), `src/thread.js`, `src/engagement.js`, `src/screens/Conversa.js`, `src/screens/Membro.js`, `src/ui/QuoteCard.js` (new); `src/ui/PostRow.js`, `TopBar.js`, `Icon.js`, `MediaGrid.js`, `MediaView.js`, `src/media/fetch.js`, `cache.js`, `src/screens/ARua.js`, `Diario.js`, `Seguindo.js`, `Publicar.js`, `src/outbox.js` (quotes never reconcile a queued post or reply).
- Merged with the Espiadinha (section 17, PR #120): a PeekItem is now a FeedItem plus `round` (`kind`, `replyTo`, `quote`, or a repost item with `to`), and, at the owner's request after the merge, a publication is any post (replies and quotes included) or a repost still in effect (`packages/core/lib/peek.js`: the last operation per target within the fetched tail; likes never show); the `peek.read` worst case was re-measured at 242,215 bytes for 31 items (19,929 to spare). The Espiadinha rows use A Rua's `useSocial` / `socialRowProps` with counts: they open the conversation and the author's profile, show the index counts, offer curtir, republicar and citar, name a reply's parent and show the quoted post and a repost's original (each read with `diary.peek`), and fetch photos `no-store` (their authors are not followed); the browser peek tests that used replies as never-shown filler now use likes; `PostRow` keeps the Espiadinha's 'seguir' action (`onFollow`, `followPending`). The rows' `engagement.read` (and `follow.list` on refresh) are member reads and preempt the sync as A Rua's do; `peek.read` itself still never does. In the browser session the two peeks keep separate names (`peek.read`: `PEEK_BUSY` 'espiadinha já em andamento'; `diary.peek`: `DIARY_PEEK_BUSY` 'ocupado', `MAX_DIARY_PEEKS` 2, `diaryPeeker`); this change's browser test moved to `packages/web-member/test/diary-peek.test.js`. RPC sections shifted: `post.quote` 5.23, `like.set` / `repost.set` 5.24 / 5.25, `engagement.read` 5.26, `diary.peek` 5.27.

### Automated (CI)

CI result on the final tree after merging `main` with the Espiadinha, Node 24.22.1 (run from the worktree root, in this order):

- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 113 test files, 0 failures (core 18, rpc 8, web-member 25, app 26, cli 34, site 2).
- `npm run demo`: DEMO OK.
- `node packages/rpc/test/sizes.test.js`: 11 tests, 64 asserts, all pass. Measured worst cases against `MAX_MESSAGE` (262144 bytes): feed page of 31 items 260838 bytes (32 = 268628), `peek.read` page of 31 items 242215 bytes, log page of 36 entries 259414 bytes (37 = 266615), `diary.peek` at 36 entries with profile and username 261642 bytes, `engagement.read` at 62 + 62 refs 10483 bytes, `profile.read` at 100 authors 229170 bytes, `follow.list` at 500 keys 33581 bytes.
- `npm run pack:worklet -w apps/app`: bundle 1956863 bytes, 350 files, 38 linked addon entries; 'node scan: clean'.
- `npm run export:web -w apps/app`: `NODE_BUNDLE 659491 GZIP 201625`; exported to `apps/app/dist` (ignored by git); service worker with 11 files.
- `node apps/cli/test/readme-help.test.js`: passes.
- the whitespace check on the diff (`git diff --check`): clean.

New test files: `packages/core/test/engagement.test.js`, `engagement-session.test.js`, `packages/web-member/test/engagement.test.js`, `diary-peek.test.js`, `e2e-social.test.js`, `apps/cli/test/seeder-index.test.js`, `apps/app/test/engagement.test.js`, `indexClient.test.js`, `nav.test.js`, `thread.test.js`; extended: the records, feed, seed-ws, seed-ops, caddyfile, deploy, rpc methods and sizes, sw, outbox, mediaFetch and mediaCache tests. The end-to-end test `packages/web-member/test/e2e-social.test.js` passes (5 runs in a row): 66 replies from three authors paged exactly once in order (50 + 16), counts equal an independent reducer, peeks of unfollowed diaries never create replicas, a like reaches the seeder count in ~29 ms, a block removes the author from the index in ~45 ms, the CLI shows quotes and reposts.

### Human verification

None of these was performed for this change.

- [ ] Tap "respondendo a X": the parent post opens (not performed yet).
- [ ] Browser Back, Android Back and Escape each close the screen (not performed yet).
- [ ] A thread with many replies, including from people you don't follow, pages through all of them (not performed yet).
- [ ] Like, then undo: the heart and the count update and survive a reload (not performed yet).
- [ ] Repost, then undo: "Fulano republicou" appears in a follower's A Rua, then goes away (not performed yet).
- [ ] A quote shows the quoted card (not performed yet).
- [ ] Tap any name: the profile opens, and Seguir, denunciar and their posts all work (not performed yet).
- [ ] Once a blocklist arrives, a blocked author's replies disappear (not performed yet).

### Residual risks

- Index memory: the engagement index lives in memory, bounded by records (default 1,000,000), distinct targets (default 500,000) and a per-diary quota (default 50,000 records); the worst case was measured at about 436 MiB with both global caps full. At a cap the affected diary's cursor pauses (never skips) and every answer says `complete: false`; it resumes when room frees (an unlike that empties a target, a dropped diary or a dropped post author) and a failed block read is retried with backoff. A large deployment can stay incomplete (the app shows "Algumas respostas podem faltar."). It is rebuilt at every start (`indexing: true` meanwhile). Reads cost O(log n + page) (incremental counters, binary-search cursor).
- Reading on demand tells the seeder which diaries you open: `diary.peek` fetches the requested blocks of an unfollowed diary from the seeder, so the seeder can see which members' posts a device reads (it already serves those diaries to anyone; nothing is stored on the device).
- Counts, completeness and the freshness of the "latest" profile / username record are trusted to the seeder: a lying seeder can hide or inflate counts, hide replies or point at an older name record. It cannot invent content: every post, name and bio shown is fetched from the author's diary and verified by the node.
- `diary.peek` depends on the live verified seeder link: with no run live within 8 s it answers 'semeador indisponível' (retried once by the screens), and a write that preempts the run makes a peek retry on the next run.
- Strangers' content is read in memory only (never stored as a replica, photos with `no-store`): opening the same thread again reads it again.
- Quotes, likes and reposts need a connection on the browser node (write gate); quotes never enter the outbox.
- The native app and `varanda-serve` have no remote browsing: Conversa shows the tapped row and Membro the header, with a note; A Rua's reposts and quotes resolve only from local diaries there, and there are no counts.
- The filled heart is a glyph overlay on the Feather outline (Feather has outline glyphs only), not a dedicated icon.
- Per-client limit on `/index/*` and `/media/*` (replaces the earlier "global caps only" risk). Caddy answers 429 with `Retry-After` above 20 requests per 10 s per client address on `/index/*` and 120 per 10 s on `/media/*` (zones keyed on `{remote_host}`), so one client can no longer exhaust the seeder's global caps (16 in flight, 32 or 64 requests/s) alone. The address lives only in Caddy's memory for the window: no access log, the module's `rate limit exceeded` log line (it prints `remote_ip`) excluded by `log { exclude http.handlers.rate_limit }`, `X-Forwarded-For` / `X-Real-Ip` still removed upstream. Residual: clients behind one shared address (CGNAT, an office) share a window, and an attacker with many addresses can still drain the global caps.
- The Caddy image is now built (`deploy/seeder/Dockerfile.caddy`): the official `caddy:2.11.6-builder-alpine` (sha256:096ec6e8...) builds `xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.0` (commit 12435ecef5dbb1b137eb68002b85d775a9d5cdb2, Apache-2.0; its README calls it work in progress), and the binary is copied over `caddy:2.11.6-alpine` (sha256:d44355d3...). The module is third-party code compiled into the process that terminates TLS: bump it deliberately. `deploy.sh` builds it with the seeder image, keeps the previous Caddy image as `varanda-caddy:anterior` and restores it on rollback.
- Verified (2026-10-26, Docker 29.5.3, local): `docker build -f deploy/seeder/Dockerfile.caddy` succeeds (Caddy v2.11.6 with caddy-ratelimit v0.1.0); `caddy list-modules` shows `http.handlers.rate_limit`; the production Caddyfile passes `caddy adapt`; against a local upstream, 25 requests in a burst gave 20 x 200 and 5 x 429 (`Retry-After: 10`), and a request 11 s later gave 200; with the `log` exclusion, the 429s produced no log line containing the client address (without it, each 429 logged `remote_ip`). Not verified: behaviour behind real TLS and a real client address on the production host (the Docker Desktop test sees one gateway address for every request).
- Likes, reposts and quotes are public; old readers skip them (and a quote is not shown there at all).

## 19. Own publications in the Espiadinha (2026-10-26)

### Summary

- [superseded 2026-10-28: section 34 excludes the own diary from its owner's Espiadinha again] At the owner's request ("quando posto na rua não sobe na espiadinha"), the own diary is now an Espiadinha candidate like any unfollowed diary: a post made in A Rua shows up in the person's own Espiadinha. Followed diaries stay out (they are already in A Rua).
- `packages/core/lib/peek.js`: `peekCandidates` no longer excludes the own key (the `ownKey` parameter is gone). `packages/web-member/lib/peek.js`: `createPeeker` no longer takes `ownKey`; `peek.read` still checks the identity on the serial chain first (`packages/web-member/lib/session.js`).
- App: own rows in the Espiadinha offer no 'seguir' (following oneself is refused) and, as before, no 'denunciar'.
- The own diary is read like any other candidate: from the seeder, over the short-lived peek link, into memory cores (never the node storage), so it shows once the seeder holds the post (the browser's write gate pushes it before `post.create` answers).

### Automated (CI)

CI result on the final tree, Node 24.22.1 (run from the worktree root, in this order):

- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 113 test files, 0 failures (core 18, rpc 8, web-member 25, app 26, cli 34, site 2). New: the core candidate test includes the own diary; `packages/web-member/test/peek.test.js` "the own diary shows in the Espiadinha like any unfollowed diary" (28 tests, 275 asserts).
- `npm run demo`: DEMO OK.
- `node packages/rpc/test/sizes.test.js`: 11 tests, 64 asserts, all pass (no size change).
- `npm run pack:worklet -w apps/app`: bundle 1956863 bytes, 350 files, 38 linked addon entries; 'node scan: clean'.
- `npm run export:web -w apps/app`: `NODE_BUNDLE 659292 GZIP 201561`; service worker with 11 files.
- `node apps/cli/test/readme-help.test.js`: passes. The whitespace check on the diff: clean.

### Human verification

- [ ] Hosted web: publish in A Rua, open the Espiadinha: the post is there, without 'seguir' (not performed yet). (superseded by section 34: the own diary no longer shows in its owner's Espiadinha)

## 20. Follow-back notices: the Avisos tab (PR feat/follow-back-notices, 2026-10-26)

### Summary

- The fifth tab ("Avisos", bell icon `sino`; fourth in the bar, before Diário) tells a member who started following them, with "Seguir de volta" on each row. It is private and quiet: no follower count, no followers list, no HTTP route and no system notification anywhere; the tab shows a plain dot (never a number) when something is unseen.
- Contract: RPC `notices.list { limit, after }` (`docs/rpc.md` 5.28; `NOTICES_LIMIT_DEFAULT` 30, `NOTICES_LIMIT_MAX` 64); the channel `'varanda/notices/1'` (`docs/protocol.md`, "Notices channel"); the browser read (`docs/protocol.md`, "Notices link").
- Files: `packages/core/lib/notices.js` (index, proof payload, message validation), `packages/core/lib/notices-net.js` (the channel), `packages/core/lib/seeder.js` (index folded in the diary scan, channel attached after the blocklist channel), `packages/core/lib/session.js` (the node session refuses), `packages/web-member/lib/notices.js` and `session.js` (the read), `packages/rpc` (`notices.list`, limits), `apps/app/src/notices.js`, `apps/app/src/screens/Avisos.js`, `ui/TabBar.js`, `ui/Icon.js`, `apps/app/App.js`.
- Trust model: the seeder is not trusted for facts. It serves candidates only to a connection that proved it owns the diary key (an Ed25519 signature over `'varanda-notices-v1\n'` + nonce + `'\n'` + the connection's Noise key + `'\n'` + the diary key); the browser re-verifies each row (block 0 gate, the named `follow` block with `on: true` and the claimed `at`, the signed tail for a later unfollow). A seeder can withhold a row or an unfollow outside the verified tail, never forge a follower.
- Data flows: the seeder index is in memory only, rebuilt from block 1 on every serve and at start, committed per author only when the scan reached the signed length. The browser keeps verified evidence in memory for 5 minutes (at most 512 rows), re-verified on every read; the only thing on the device is the seen-ids list in `localStorage` (`varanda-notices-seen`, scoped to the own key, at most 2048 ids).
- Scope: hosted web only. Native, `varanda-serve` and the CLI are out of scope (`'avisos disponíveis só no navegador'`, the tab shows the web-only text).

### Limits

- Constants: page 30 / 64; `MAX_NOTICES_MESSAGE` 16384; `MAX_BAD_NOTICES` 5; request timeout 10000 ms (terminal for the channel); `MAX_FOLLOW_TARGETS_PER_AUTHOR` 4096; `NOTICES_MAX_EDGES` 262144; read deadline 25000 ms; byte budget 16777216; 8 rows in parallel; 16 blocks per row; 8 seeder pages; evidence cache 300000 ms / 512 rows; app poll 300000 ms; seen ids 2048.
- Worst case of one `notices.list` page (64 notices): 42256 bytes against `MAX_MESSAGE` 262144 (`node packages/rpc/test/sizes.test.js`).
- Capacity: each read occupies one extra external socket (default `maxExternal` 32), like a peek; a busy seeder can refuse it. Not measured on the pilot seeder.

### Human verification

None of these was performed for this change. Use two browsers (or profiles) with two hosted accounts, A and B, against the same seeder.

- [ ] A follows B. B (after opening the app, or within 5 minutes with the page visible) sees a dot on the Avisos tab and no number.
- [ ] B opens Avisos: the row "<A's name> começou a seguir você" with "Seguir de volta" shows, and the dot goes away. Reload: the dot does not come back for the same row.
- [ ] B presses "Seguir de volta": the row leaves, the toast says "seguindo <name>" and A shows up in B's Seguindo.
- [ ] A follows B again after B followed back: no row (B already follows A).
- [ ] A unfollows B (before B follows back): the row is gone on B's next load (pull to refresh).
- [ ] The operator blocks A: the row is gone on B's next load.
- [ ] Nowhere in the app is there a follower count or a followers list; the Diário still says "N seguindo".
- [ ] A different identity in the same browser starts with no seen ids (the dot lights for rows the first identity had seen).
- [ ] Offline before the first load: "Sem conexão" and "tentar de novo". Locked identity: the error "identidade bloqueada: entre com a passkey".
- [ ] A seeder without the channel (an older build): the tab says "O semeador desta associação ainda não envia avisos." (the 5-minute poll keeps asking, so an upgraded seeder is picked up without a reload).
- [ ] Native app and `varanda-serve`: the tab shows "Só na versão web" and never errors; no `notices.list` call is made.
- [ ] Caddy logs show no new route and no new error; the seeder log shows one `peer` event per read.

## 21. Seeder capacity for the hosted web (PR feat/seeder-web-capacity, 2026-10-27)

### Summary

- The WebSocket entry has its own cap, independent of the swarm: `maxExternal` (`VARANDA_MAX_EXTERNAL`, 1 to 4096; default half of `maxConnections`, that is 32) bounds external sockets, in-flight handshakes included, and `maxConnections` bounds swarm sockets only. `/health` and `/metrics` report `swarm`, `external`, `maxConnections` and `maxExternal`.
- Frame pinning, amplified vector: see the residual bullet in section 8 (`frameDeadlineFor(len)` = `min(120 s, 10 s + 1 s per 64 KiB)` for every incomplete frame; frames over 64 KiB left incomplete are charged to the 64 MiB `maxFrameMemory` budget and must keep 64 KiB/s after a 10 s grace; a full budget evicts the slowest stalled reservation older than 1 s; drop reasons `frame-deadline` and `frame-budget`). The shared budget cannot be used to drop active members or refuse new ones. Tests in `packages/core/test/seeder-stream.test.js`: `a charged frame that drips is dropped at the first throughput check after the grace`, `stalled declarations filling the budget cannot keep members out or drop them`, `a full budget evicts the stalled reservation for a member frame that makes progress`, `charged declarations over the frame memory budget are refused when nothing can be evicted`.
- The HTTP listener (`/seeder`, `/media`, `/index`, Caddy keep-alives) has a socket cap that only bounds file descriptors: `max(128, maxExternal + media in flight + index in flight + 64)`, or `VARANDA_MAX_SOCKETS` (1 to 8192) when set (then used as given); the computed value is never below 128.
- Operator variables (all optional, read by `seed`; empty in `deploy/seeder/.env` means the default): `VARANDA_MAX_EXTERNAL`, `VARANDA_MAX_SOCKETS`, `VARANDA_FRAME_MEMORY` (bytes, 8454144 to 1073741824; the minimum is `MAX_EXTERNAL_FRAME`, so one legal frame always fits), `VARANDA_MEDIA_MAX_IN_FLIGHT`, `VARANDA_MEDIA_RATE`, `VARANDA_MEDIA_BURST`, `VARANDA_INDEX_MAX_IN_FLIGHT`, `VARANDA_INDEX_RATE`, `VARANDA_INDEX_BURST` (1 to 1024, 1 to 100000 and 1 to 100000 respectively). Defaults: media 16 in flight, 64/s, burst 128; index 16 in flight, 32/s, burst 64.
- Besides the long WebSocket of each member, two features open short extra seeder connections per member while they run: the Espiadinha (`peek.read`) and the follow notices (`notices.list`, polled every 5 minutes by the Avisos screen, `packages/web-member/lib/notices.js`). Count them when choosing `VARANDA_MAX_EXTERNAL`; at the cap the seeder refuses with `connection-limit` and the feature answers "sem conexão com o semeador" or tries again at the next poll.

### Capacidade medida

`apps/cli/scripts/load-ws.js` is a development-only, loopback-only measurement. It opens idle, admitted connections (Noise handshake done, nothing else), holds them, and reports how many were opened and refused and the handshake latency. It does not generate real traffic.

```sh
# terminal 1: a local seeder (see section 8 for the association and seeder certificate setup)
VARANDA_MAX_EXTERNAL=64 VARANDA_FRAME_MEMORY=134217728 \
  node bin/varanda.js seed --data ./data --association <hex> --ws-port 8789 --health-port 8788
# terminal 2: the load
node apps/cli/scripts/load-ws.js --port 8789 --health-port 8788 --clients 64 --hold-ms 10000 --json
```

Flags: `--port` (required), `--clients` 1 to 4096 (default 32), `--hold-ms` 0 to 25000 (default 10000), `--health-port` (optional), `--json`. Read the seeder's resident memory (RSS) from the host (`ps`, `docker stats`) while the clients are held.

Caveat: the numbers are idle admissions, not real traffic. A member that uploads a diary, an Espiadinha read or a notices read costs more memory than an idle socket, and none of that is measured here. No production capacity is claimed.

Operator table (fill it in on the machine that will host the seeder, one row per run; nothing is filled in by this PR):

| Clients | Opened | Refused | p95 handshake (ms) | Seeder RSS (MiB) | `VARANDA_MAX_EXTERNAL` | `VARANDA_FRAME_MEMORY` |
|---|---|---|---|---|---|---|
| | | | | | | |

Rule of thumb: `VARANDA_FRAME_MEMORY` >= 8 MiB x the number of members expected to upload at the same time (a legitimate frame can be about 8 MiB, `MAX_EXTERNAL_FRAME`). Raise `VARANDA_FRAME_MEMORY` together with `VARANDA_MAX_EXTERNAL`, and keep the host memory above `maxExternal` x `MAX_PAYLOAD` + `maxFrameMemory` plus the seeder's baseline.

### dht-relay decision

Not pursued for this launch: dht-relay 0.4.3 has defects (section 8, G3) and the relay is a loopback-only spike. The seeder WebSocket path is the production entry; `packages/web-member/scripts/dht-relay.js` spike script stays a documented experiment.

### Not verified

- No production capacity: the load test measures idle admissions only.
- The memory bound of a stalled WebSocket message (`MAX_PAYLOAD` per socket for 30 s) is derived from the code and the `ws` buffering, not measured under load.

## 22. Account search (2026-10-26)

### Summary

- A member can find people by name or @nome in Seguindo and follow them. The seeder keeps an in-memory name index (folded tokens and the verified @nome only) fed by the existing index scan, and answers `GET|HEAD /index/search/<segment>` with at most 20 `{ author, profileSeq, usernameSeq }` rows (`docs/protocol.md` sections 5 "Seeder name index" and 7 "Seeder index route"). No RPC change: the app reads and verifies each row's name and @nome with `diary.peek`.
- Contract: query of 1..4 folded words joined by `-`, at least 2 characters; order 0 exact @nome, 1 @nome equal ignoring `_`, 2 @nome prefix, 3 every typed word starts a word of the name or @nome; ties by member key; at most 20 results, no cursor. Body exactly `{ members, more, indexing, complete }`; a valid query with no hit answers `members: []`; a segment under 2 characters is the generic 404.
- Moderation: blocked, dropped and ungated authors never appear; an @nome from a revoked issuer stops matching at the next query without a rescan; a diary whose re-gate after a newly revoked issuer is pending is held out of results until block 0's verdict clears it; the name index is cleared on rebuild.
- Scope: hosted web only ("Buscar" field in Seguindo, 400 ms after typing stops). Native and `varanda-serve` are unchanged. No opt-out in this version.
- Files: `packages/core/lib/search-text.js`, `packages/core/lib/name-index.js`, `packages/core/lib/seeder.js` (`indexSearch`, wiring), `apps/cli/lib/seed-ws.js` (`INDEX_SEARCH_RE`), `deploy/seeder/Caddyfile`, `apps/app/src/indexClient.js` (`fetchSearch`), `apps/app/src/search.js`, `apps/app/scripts/sw.js`, and the Seguindo screen with `useMemberSearch`.

### Automated (CI)

- `packages/core/test/search-text.test.js` (the fold and the query grammar).
- `packages/core/test/name-index.test.js` (the pure index: newest record wins with no fallback, one verification per candidate, bounded candidate copy, unusable issuers and visibility at query time, `remove`, `maxAuthors`, ordering and `more`).
- `apps/app/test/search.test.js` (the app-side copy: parity with core, the `diary.peek` plan, verification through `diary.peek`, dropped and unconfirmed rows, own account). The follow state of search rows lives in `Seguindo.js` and has no automated test (CI renders no React).
- Extended: `apps/cli/test/seed-ws.test.js` (the route, 200 body, 404 / 405 / 421 policy, shared caps), `apps/cli/test/seeder-index.test.js` (the seeder wiring: removal on drop, cap pause and resume, revocation without a rescan, the re-gate hold, blocked authors, one loopback request), `apps/app/test/indexClient.test.js` (`fetchSearch`) and `apps/app/test/sw.test.js` (the service worker still bypasses `/index/`).

### Human verification

None of these was performed for this change. Use two or three hosted accounts against the same seeder.

- [ ] An author blocked by the operator is absent from a search for their name and for their @nome.
- [ ] An author whose @nome record has a bad signature is not found by that @nome (the display name can still match).
- [ ] An author who renamed themselves is found only under the new name, not the old one.
- [ ] A request for `/index/search/<query>` that fails (unknown path, one-letter segment) answers the generic 404 and does not echo the query; the seeder and Caddy logs show no query.
- [ ] Rows appear only after `diary.peek` verified them (a throttled network shows no row before its name and @nome are read); a row whose name no longer matches the query is dropped.
- [ ] The own account never appears in the results.
- [ ] Someone followed past the first page of the follow list shows "Seguindo", not "Seguir".
- [ ] Typing one letter shows "Digite pelo menos 2 letras."; offline shows "A busca precisa de internet."; a name with no hit shows "Ninguém encontrado com esse nome.".
- [ ] The exact "@nome ou chave" field below still follows by @nome or key through the account service.

### Residual risks

- The seeder sees the folded query in the path (neither the seeder nor Caddy logs it).
- An anonymous client learns at most 20 keys per probe, keys already in the seeder's hello inventory.
- Ordering, omissions and completeness are seeder claims, and the seeder may point at an older authentic profile / username record (a stale name; the same trust model as the member profile screen, `docs/rpc.md` `diary.peek`).
- A member blocked while a search is on screen can stay in the rows already shown until the next search.
- No opt-out in this version; names in other scripts are found only by @nome; matching is by word prefix only; no topic search.

## 23. Espiadinha: republicações, orçamento do índice, expiração e aviso de nova versão (2026-10-27)

### Summary

- Report: reposts of diaries the person does not follow did not show in the Espiadinha. T1 wrote a regression test (`packages/web-member/test/peek-repost.test.js`, 8 tests / 65 asserts, all pass) that follows an unfollowed repost through every layer: record, engagement state, `retainRecords` / `diaryPeek`, the window walk past likes, `buildPeekPage` with a cursor, the session (`peek.read`, `repost.set`, `diary.peek`) and the app (`mergePage`, `peekKey`). It was green from the start, so the cause of the report is UNPROVEN in code: every layer is clean. The most likely cause is a window running an old release (`apps/app/scripts/sw.js` waits until every window closes), which the release banner below addresses.
- [superseded 2026-10-28: section 34 excludes the own diary from its owner's Espiadinha again] `PEEK_RULE` (`packages/core/lib/peek.js`) now reads exactly: "A Espiadinha mostra a publicação mais recente de cada diário que você não segue, o seu incluído, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos."
- Expiration: `packages/web-member/lib/peek.js` refuses a continuation (`after`) on a missing or expired snapshot with USAGE 'A lista expirou; atualize para continuar.' before any link is opened; an `after`-less read keeps the previous snapshot until the new one exists, so a failed refresh does not strand the list. Docs: `docs/rpc.md` 5.22.
- Index budget (`apps/app/src/indexClient.js`): shared pacer (at most 2 in flight, at most 18 starts per rolling 10 s, under Caddy's 20 per 10 s zone); a 429 with Retry-After sets a shared cooldown honoured in full (cap 10 min); up to 3 retries within 45 s of waiting per call, then 'rate-limited' with the remaining `retryAfterMs`; member cache (complete pages only, 5 min, 256 entries, in-flight dedupe); `resetIndexClient()` and `invalidateMember(author)` (used by Membro's pull-to-refresh).
- App (`screens/ARua.js`, `engagement.js`, `ui/PostRow.js`): the second pass resolves the quote and the `replyTo` of resolved originals (a reposted reply names its parent); 'seguir' on the 'Nome republicou' line (Espiadinha only); follows changed elsewhere reset `useSocial`'s follow cache; a failed member lookup retries the nameless originals once (after `retryAfterMs`, else 10 s); a failed counts call shows the 'incompletos' note.
- App (`App.js`, `screens/Espiadinha.js`, `src/peek.js`, `screens/Membro.js`): the Espiadinha reloads only on publishes (`peekVersion`), not on follows; 'seguir' removes the author's rows without reload or scroll loss and a late page cannot bring them back; follows made elsewhere drop rows without reload (all `follow.list` pages); no 'seguir' on own rows or before the own key is known; round labels on all three rounds; the texts include the own diary; the skipped note lists the real causes; empty states offer 'publicar' / 'atualizar'; reply marks of own or followed parents show their names; an expired list keeps its rows and asks for a pull.
- Core tests (`packages/core/test/peek.test.js`): 4 repost cases (head/tail window, undo in the tail with `on` below the floor, `MAX_FUTURE_MS`, two reposters).
- Release banner (`apps/app/src/release.js`, `pwa.web.js`, `ui/UpdateNote.js`, `App.js`): 'Nova versão disponível.' with 'atualizar' (reload) when the release the server serves now (the `VERSION` in `/sw.js`, which the worker never intercepts) differs from the open page's `varanda-release` marker, so the notice disappears once the reload lands on the new release even while the old worker still controls the page; checked on focus/visibility (at least 60 s apart), every 30 min and when a new worker starts installing; a failed check leaves the state unchanged; native shows nothing.
- [superseded 2026-10-28: section 34 excludes the own diary from its owner's Espiadinha again] Docs: strangers' photos are fetched `no-store` (`apps/app/src/media/fetch.js`; own and followed keep the long cache); `ownKey` is gone from `peekCandidates` and `createPeeker`; the own diary is part of the rule.

### Automated (CI)

Commands (from the worktree root, in this order): `npm run lint`; `cd packages/core && node ../../scripts/run-tests.js`; `cd packages/rpc && node ../../scripts/run-tests.js`; `cd packages/web-member && node ../../scripts/run-tests.js`; `cd apps/app && node ../../scripts/run-tests.js`.

Results (2026-10-27, local, Node 24): `npm run lint` clean; `npm test` across the six workspaces, 126 test files (with main through #169 merged in), 0 failures (changed suites: web-member `peek-repost` 8/8 and `peek` 30/30, core `peek` 25/25, app `indexClient` 18/18, `peek` 14/14, `engagement` 4/4, `release` 7/7); `npm run demo` ends with `DEMO OK`. Security audit of the change: 0 verified findings (auditors: Claude, Claude built-in review, GPT, Grok).

### Human verification (none performed yet)

If the reposts are still missing on the hosted web:

1. [ ] In the browser devtools, read the open page's `<meta name="varanda-release">` and compare it with the `VERSION` in the deployed `/sw.js` (a PWA window opened before a deploy keeps running the old shell: `apps/app/scripts/sw.js` waits until every window closes) (not performed yet).
2. [ ] Close every Varanda window/tab (or use the new 'Nova versão disponível · atualizar' banner) and reopen (not performed yet).
3. [ ] In the browser console of the hosted web, run a `peek.read` and count items with `kind === 'repost'`. Above zero with none on screen means the screen; zero for a diary whose newest block is a repost means compare its blocks and the seeder's `have` length with `peek-repost.test.js` cases (b) and (d) (not performed yet).

Shipped behaviours:

- [ ] 'seguir' on a row keeps the scroll position, removes that author's rows and the rows do not come back (not performed yet).
- [ ] Own rows have no 'seguir', and there is none before the own key is known (not performed yet). (superseded by section 34: own rows no longer exist)
- [ ] Round 1 is labelled '1ª publicação de cada diário', like rounds 2 and 3 (not performed yet).
- [ ] The skipped note lists the real causes (not performed yet).
- [ ] A reposted reply names its parent ('respondendo a Nome') (not performed yet).
- [ ] 'seguir' on a 'Nome republicou' line follows the reposter (not performed yet).
- [ ] With 30 rows, names and counts survive the index limit (no 'incompletos' note on a normal load) (not performed yet).
- [ ] After 5 minutes on the list, scrolling to the end shows 'A lista expirou; puxe para atualizar.' and keeps the rows (not performed yet).
- [ ] The 'Nova versão disponível.' banner appears after a deploy with a window left open, and 'atualizar' reloads into the new release (not performed yet).

### Residual risks

- `at` is author-supplied (up to 24 h ahead is accepted), so ordering inside a round can be gamed within that bound.
- Names can be absent (`packages/web-member/lib/who.js`, around lines 60-66): a profile or @name outside blocks 1-2 and the fetched tail reads as 'sem nome'.
- The cause of the repost report is unproven; if the checklist finds a real defect it needs a new fix.
- Hardening of the seeder link (frame guard and capacity) was not part of this change; it is section 24.

## 24. Ligação com o semeador: guarda de quadros no cliente e semeador lotado (2026-10-27)

### Summary

- Issue #130 (seeder-link hardening and capacity), stacked on the Espiadinha reposts PR. No production default changed (64 swarm, 32 external; since #168 the external cap is independent of the swarm cap and the operator sets it with `VARANDA_MAX_EXTERNAL`); what changed is what a client sees and how much it will accept.
- T8: `packages/core/lib/frame-guard.js` holds `FrameGuard`, moved out of `seeder.js` unchanged in behaviour, plus `handshakeFrames` (Noise XX responder receives 2 handshake frames, the initiator 1), option validation, and a throwing `onLimit` can no longer skip the destroy. It depends on streamx only (browser-safe, checked by `packages/core/test/browser-safe.test.js`).
- T10: `Seeder#acceptStream(raw, { onRefuse })` hands a capacity refusal to the caller without destroying the stream; `apps/cli/lib/seed-ws.js` closes the WebSocket with 1013 `'lotado'` and terminates it after `REFUSE_GRACE_MS` = 1 s. Callers without `onRefuse` keep destroy-on-cap.
- T11: `packages/web-member/lib/ws-stream.js` `guardedWsStream` (FrameGuard with `handshakeFrames` 1, records the close code). Peek and notices links: `PEEK_MAX_FRAME` = 1 MiB; sync and seeder-link: `MAX_EXTERNAL_FRAME` (8 MiB + 64 KiB). Over the bound the link is cut (peek: incomplete page and 'aviso: quadro grande demais do semeador'; sync reconnects). A 1013 close gives USAGE 'Semeador ocupado; tente novamente em instantes.' (peek, notices) and the sync warning 'aviso: semeador ocupado; tente novamente em instantes'.
- Considered and NOT done: link reuse (a peek over the sync link) collides with the peeker's destroy-on-budget/abort model; an anonymous sub-cap would be post-handshake and spoofable.
- Docs: `docs/design.md`, `docs/protocol.md` (section 4 "External transports", Peek link), `docs/rpc.md` (5.22 and 13), `README.md`, `CHANGELOG.md`.

### Measurements

`packages/web-member/test/peek-capacity.test.js`, Apple M4 Pro, Node 24, loopback, real in-process Seeder behind `startSeedWs`; the header comment of the test holds the full numbers.

- Largest legitimate frame, against a real seeder with 64 diaries x 200 posts and a media core: 11,665 bytes; a 4096-key inventory stand-in: 9,031 bytes. Hence the 1 MiB bound for peek and notices.
- Production caps 64/32, 40 member sync links: 40 attempted, 40 connected, 32 admitted, 8 refused. With the 32 slots held, a peek or notices read fails with USAGE 'Semeador ocupado; tente novamente em instantes.' in 2-5 ms (peek) and 1-3 ms (notices); a bare 33rd socket closes 0-1 ms after its refusal log line, far inside the 1 s grace.
- Test-only caps (maxConnections 64, `seeder.maxExternal` 40): 40 admitted; the 41st peek or notices read is refused with the busy message in 3-7 ms; with `maxExternal` 41 the 41st peek reads a 10-diary page in 11-14 ms.
- A peek link holds a slot about 10-20 ms on loopback (a notices read 2-3 ms); each network round-trip adds to that over a real network.
- Not measured: whether held member links survive the 30 s external idle deadline with no traffic.
- Hostile-frame result: a frame declaring more than the bound is cut at its 3-byte header: `frame-guard-client.test.js` drives a hostile seeder against the peek, sync and seeder links, and `ws-stream.test.js` covers the shared `guardedWsStream`; the notices link uses that same call and has no hostile-seeder test of its own; `frame-guard.test.js` covers the guard itself.

Test-only overrides: `seeder.maxExternal` (40 / 41) in the capacity test; `maxFrame` and the guard options in the frame tests. Production code carries no such switch.

### Automated (CI)

Commands (from the worktree root, in this order): `npm run lint`; `npm test`; `npm run demo`.

Results (2026-10-27, local, Node 24): `npm run lint` clean; `npm test` across the six workspaces, 129 test files (with main through #169 merged in), 0 failures (new or changed suites: core `frame-guard` 23 tests, `browser-safe`; cli `seed-ws`, `seeder-stream`; web-member `frame-guard-client` 8 tests, `ws-stream`, `bundle`, `peek-capacity` 43 asserts); `npm run demo` ends with `DEMO OK`. Security audit of the change: 0 verified findings (auditors: Claude, Claude built-in review, GPT, Grok).

### Human verification (none performed yet)

- [ ] Oversized frame cut: against a test seeder or a stub that sends a frame declaring more than 1 MiB on the peek link, the Espiadinha page is incomplete with 'aviso: quadro grande demais do semeador' and the app keeps working (not performed yet).
- [ ] Seeder full: with the seeder's external slots held, opening the Espiadinha and the Avisos shows 'Semeador ocupado; tente novamente em instantes.' and works again after a retry once a slot frees (not performed yet).
- [ ] Normal reads unaffected: with free slots, the Espiadinha, the Avisos and the sync behave as before (not performed yet).

### Residual risks

- The browser has already allocated the whole WebSocket message before the guard sees it; the guard bounds the secret-stream copy and cuts early.
- On the sync link frames up to `MAX_EXTERNAL_FRAME` are still accepted (legitimate replication frames can be that large).
- With about 32 hosted members online the 32 external slots are all taken by syncs and every peek or notices read is refused until a slot frees; the message is now accurate; raising `VARANDA_MAX_EXTERNAL` (#168) is how an operator adds room. Sub-cap and link reuse were rejected (see above).
- Numbers are from loopback on one machine, not from the pilot seeder; no deploy claim is made.

## 25. Busca por assunto na Espiadinha (seeder topic index, issue #81) (2026-10-27)

### Summary

- Shipped: `packages/core/lib/topic-index.js` (the seeder's in-memory full-text index of public posts, whole tokens, ANDed, newest first, paged by cursor); the seeder's own search scan and `Seeder#indexTopic` in `packages/core/lib/seeder.js`; `GET|HEAD /index/topic/<tok>+<tok>[/<cursor>]` in `apps/cli/lib/seed-ws.js`; `fetchTopic` in `apps/app/src/indexClient.js`; the pure helpers in `apps/app/src/topics.js`; the 'pesquisar por assunto' field and the Busca screen (`apps/app/src/screens/Busca.js`) in the Espiadinha.
- Hosted web only. Native and `varanda-serve` show no field.
- Trust model: the node re-checks each returned post, including its words, so a seeder can hide results or list unrelated posts but cannot forge content. The seeder's search is a finding aid, not a fact.
- The index respects the blocklist at the moment the seeder adopts a snapshot.
- A diary whose re-gate after a newly revoked issuer is still pending is held out of results, and the answer says `complete: false`: the same hold as account search (section 22).
- `/health` gains `topicPosts` and `topicSaturated`, and the index is announced with the `indexing` and `complete` marks.
- What #81 asked for that is NOT delivered: removal of a deleted publication (no deletion record exists in the protocol, so the 'conteúdo apagado' criterion cannot be met); hiding a single listed post (#21 and #20 are still open); age protection (certificates are 'unchecked', 18+ is an MVP scope decision, not an enforced gate); 'assuntos do momento' (no trending computation exists).

### Automated (CI)

CI result on the final tree, Node 24.22.1 (run from the worktree root, in this order). Node 20 was not run locally: only Node 24.22.1 is installed on this machine.

- `npm ci`: 1015 packages added, 1022 audited, completed. `node_modules/@varanda` lists `app core rpc site web-member` (the CLI workspace is `varanda`, not linked there). npm reported 5 high-severity advisories and two install-script notices (`esbuild`, `fsevents`); not addressed in this change.
- `npm run lint`: clean (`standard` printed no output).
- `npm test` (all workspaces, log in the scratchpad `t8-test.log`): 1345 `ok` lines, 0 `not ok`; 123 test files in total, per workspace: core 21, rpc 8, web-member 27, app 29, cli (`varanda`) 36, site 2; each file reports `# tests = N/N pass`.
- New or changed test files, all passing in that run: `packages/core/test/topic-index.test.js` (includes the 50k-post load test, see below), `apps/app/test/topics.test.js`, `apps/app/test/indexClient.test.js` (`fetchTopic` and `topicUrl` cases), `apps/app/test/sw.test.js` (additions), `apps/cli/test/seed-ws.test.js` (the `/index/topic` route: a null answer, a throw and a seeder without `indexTopic` answer 404 and echo nothing), `apps/cli/test/seeder-topic.test.js` (new), and `apps/cli/test/seed-ops.test.js` (the search gauges).
- Core 50k-post load test (`topic-index.test.js`, "50k posts from 500 diaries: build and common-token queries stay bounded"), figures from the log of this run: build 90.7 ms; first query 2.56 ms; second query 0.02 ms; heapUsed delta 15.6 MB. One run on the development machine; the bounds asserted in the test are build under 15 s, first query under 3 s, second query under 250 ms.
- `npm run demo`: `DEMO OK`.
- `node packages/rpc/test/sizes.test.js`: 12 tests, 69 asserts, all pass. Worst cases logged: `profile.read` 229170 bytes at 100 authors; `follow.list` 33581 bytes at 500 keys.
- `npm run export:web -w apps/app`: `NODE_BUNDLE 679651 GZIP 208228`; web bundle `_expo/static/js/web/index-01e34ffd547f5a2bb02b99d0e7a81ac6.js` 917KB; service worker `sw.js` with 11 files, version `3d2cbcb8787e8d5e`.
- No browser pass in CI: there is no component harness, so the Busca screen and the field are covered only by the pure helper tests and the human checklist below.
- Re-integration with account search (#169), 2026-10-27: the route moved from `/index/search/...` (now account search's) to `/index/topic/...`, every topic identifier was renamed (`topic-index.js`, `Seeder#indexTopic`, `topicPosts`/`topicSaturated`, `apps/app/src/topics.js`, `fetchTopic`), main was merged in twice (#164, #167, #168, #169, then #171 with #172), and topic search adopted the revocation re-gate hold and #171's request scheduler. Review fixes in the same round: each Busca page peeks into its own map (a map shared across pages kept the first @nome seen, so one revoked meanwhile survived on later pages), and the rounds' 'offline' notice no longer unmounts a search that already loaded. New cases: `seed-ws.test.js` "the same word reaches only its own method", `seeder-topic.test.js` "a diary held by a pending revocation re-gate is left out and the answer is incomplete", and a 429 case for `fetchTopic` in `indexClient.test.js`. CI figures for the final tree are in the PR description.

### Residual risks

- Memory: the search index lives in the seeder's memory next to the engagement index, and grows with the public posts of every diary it keeps. After the security fix cycle (every stored token is a flat canonical copy, so a V8 substring slice can no longer pin a post's folded text), measured on Node 24.22.1 with a full GC before and after: the core test's 50k posts of 4 words from 500 diaries retain 11.2 MB (about 236 B per post); 4,000 crafted posts of one 13-letter word plus 986 U+1D160 retain about 155-260 B per post, against ~12,175 B before the fix (`topic-index.test.js` "memory: a stored token never retains the post text" asserts under 2,000 B). With every default cap full (200,000 posts, 500,000 tokens, 4,000,000 slots) the security audit measured about 264 MB retained, to be added to the engagement index's ~436 MiB worst case when sizing a seeder. The figure for the pilot seeder is not measured. Two full block reads run at startup (search and engagement).
- Privacy: the seeder learns which words a device searches, as it already learns which diaries it opens. The seeder logs none of it.
- Privacy, Caddy error log (MEDIUM, deferred): Caddy keeps no access log, but its error log is on for every route (the global `log` block of `deploy/seeder/Caddyfile` only excludes the rate-limit logger). When the proxy to the seeder fails (seeder restarting or crashed, a deadline) it can record the request URI, which for `/index/topic` holds the search words, together with the client address. Fix deferred: a Caddy log filter on the URI verified with a forced 502, and dropping `web` from `deploy/seeder/deploy.sh`'s failure log dump.
- CPU, out-of-order posts (LOW): a post older than the newest entry of a posting list (e.g. very old-dated) marks that list dirty, and the next query that touches it sorts it synchronously (measured by the audit at about 13 ms for a list at 190k posts, against 0.03 ms for a clean list). A member publishing such posts, plus many client addresses to get past the per-client limit, can spend seeder CPU.
- Per-diary budgets: each diary holds at most 10,000 indexed posts, 200,000 (token, post) slots and may create at most 25,000 new words (each 5% of its global cap, `topicPerAuthorMax` / `topicPerAuthorPostingsMax` / `topicPerAuthorTermsMax`), so filling a global cap takes at least 20 colluding member diaries. A very prolific author's newest posts stop being indexed past either share (its search cursor pauses and `complete` turns false) until the diary leaves the seeder.
- Far-future posts: a post dated more than a day ahead is skipped by binary search and never consumes the 2000-candidate budget, so a member cannot empty the first page of a word by flooding it with future-dated posts.
- A lying seeder can hide results or list unrelated posts. The node drops the unrelated ones after re-checking the words; it never shows a forged post.
- Whole-token matching misses inflections, substrings and non-Latin letters: "ceu" finds "Céu" and "#Céu" (case and accents are folded), but "céus" or "ceuzinho" are not found.
- A short or empty page with a cursor is possible when the scan reaches its 2000-candidate budget before the page fills.
- Rate limit: the per-client limit is 20 requests per 10 s on `/index/*`, shared with the other `/index` routes. Since #171 every `/index` request of the app, the topic search included, goes through one scheduler (2 in flight, 18 starts per 10 s, a shared 429 cooldown), so a page of results that are replies or quotes of many different strangers (one `/index/member` per unknown parent author, as in the Espiadinha rounds) queues instead of tripping 429s; a search that still meets the cooldown shows "Muitas consultas ao semeador agora. Tente de novo em alguns segundos."
- The search field lives in two React trees (the rounds header and the Busca header). Submitting from the field remounts the input and drops focus.
- Load: a search is a plain HTTP request (no WebSocket, so it does not count against `maxExternal`); it shares the `/index` in-flight cap (16) and token bucket (32 per second, burst 64) with the other `/index` routes, and beyond either the seeder answers 503 `ocupado`. Not measured on the pilot seeder.

### Human verification

None of these was performed for this change. Use the hosted web app at 320 px and on desktop, against a seeder that holds posts from at least one unfollowed diary.

- [ ] 'ceu' finds 'Céu' from an unfollowed diary, below its three newest posts.
- [ ] 'boa noite' finds 'boa e noite'.
- [ ] A listed-but-non-matching ref (a seeder that lists a post without the words) is not shown.
- [ ] 'limpar' restores the rounds.
- [ ] A diary blocked by the association disappears on the next search.
- [ ] Native app and `varanda-serve` show no field.
- [ ] An older seeder shows 'A pesquisa não está disponível neste semeador.'

## 26. Shareable profile links and follow-on-signup (2026-10-26)

### Summary

- A member can copy or share a profile link, and a newcomer who opens it can sign in and follow that person. Two paths on the installation's own origin: `/@<nome>` (readable) and `/m/<64 hex>` (when the member has no @nome). Hosted web only; there are no universal links, `apple-app-site-association` or `assetlinks`.
- Consent rule: the link never follows anyone by itself. The automatic follow happens only when the invite card was shown on this page and a passkey ceremony then succeeded on this same page, with no reload in between (a returning member signing in from the card). The acceptance is bound to that key and survives the Google return, but after a reload it only opens the profile with 'Para seguir @nome, toque em Seguir.' — a newcomer, who always goes through Google, confirms with one tap. An accepted record read after a reload could have been planted in tab storage, so it never becomes a signed follow without the person seeing whom (owner decision, 2026-10-27, after the security audit). A visitor already signed in (or restored at load) only gets the profile opened with 'Seguir'.
- The protocol, the RPC, the account service, the Caddyfile, the static server and the service worker are unchanged: they already serve extensionless paths and the follow uses the existing `follow.add` and `GET /account/username`. No new record, no new RPC method.

### What changed, per area

- `apps/app/src/profileLink.js` (pure ES module): `parseProfilePath` (strict regexes over the raw path, no `decodeURIComponent`), `buildProfileUrl` (the @nome link when there is one, else the key link), the invite record (`v`, `username`, `key`, `state` 'new' | 'accepted', `recipient`, `at`; untrusted on every read, rebuilt field by field, 1 h TTL), `captureInvite` (any `/@…` or `/m/…` path first clears a stored invite, then stores a fresh 'new' one when valid, and cleans the address bar to `/` keeping search and hash), `inviteAction` (the shell's decision table: none, wait, drop, card, accept, follow, confirm, open; 'follow' needs consent given in this page load, otherwise an accepted record gives 'confirm') and `resolveInvite` (@nome to key through the same-origin lookup; a consistency check, not a signature).
- `apps/app/src/profileLinkStore.web.js` and `profileLinkStore.native.js`: the web store keeps the invite in this tab's `sessionStorage` (`varanda-profile-invite`) so it survives the same-tab trip to Google and back to `/?conta=` and dies with the tab; `localStorage` is not used because it is unauthenticated and shared by every visit on the origin. The native store honours nothing.
- `apps/app/App.js`: captures the invite once at load; evaluates `inviteAction`; shows the card; records consent after a successful ceremony, bound to the profile the card showed (a target changed in storage meanwhile is dropped); resolves the @nome; after the Conta sheet closes, calls `follow.add` and opens Membro with the toast 'Agora você segue @nome.' ('Você já segue @nome.' if already following) when the consent was given in this page load, and otherwise (after the Google reload) opens Membro with 'Para seguir @nome, toque em Seguir.'; the own link opens Diário and never self-follows. Lookup failures (offline, 429/5xx, timeout) keep the invite, show 'Sem conexão: o perfil abre quando a conexão voltar.' once and retry after 15 s, 30 s, then every 60 s (at most 10 tries) and when the connection returns; a missing @nome shows 'Não encontramos esse @nome.'.
- `apps/app/src/screens/Identidade.js`: the Entrar card shows '@nome convidou você — entre para seguir' ('Alguém convidou você — entre para seguir' for a key link) and 'agora não' (clears card and record); right after the first ceremony it re-reads the passkey status so the key is known before the Google step, even if the recovery ends without a sync (offline); on the cards where no ceremony is possible (no PRF passkey, as in in-app browsers; no WebAuthn; an address that cannot carry a passkey) it shows the invite, 'Para entrar e seguir, abra este link no Chrome ou no Safari.' and the copy/share control with the link rebuilt from the stored invite.
- `apps/app/src/share.js` and `apps/app/src/ui/ShareProfile.js`: 'copiar link' and, where `navigator.share` exists, 'compartilhar' (a failed share falls back to the copy). Only a `/@nome` link is printed; the `/m/<chave>` link is never shown, except in the selected field when the clipboard write fails ('não foi possível copiar: o link está selecionado abaixo').
- `apps/app/src/screens/Diario.js`: the header offers the share row for the own profile on the hosted web.
- Tests: `apps/app/test/profileLink.test.js`, `apps/app/test/share.test.js`; cases added in `apps/app/test/sw.test.js` and `apps/cli/test/serve.test.js` (extensionless profile paths still resolve to the app shell).
- Docs: `docs/app.md` (Entrar, Diário, Nomes, Navegação) and `CHANGELOG.md`.

### Automated (CI)

- Added in this change: `apps/app/test/profileLink.test.js` (parsing, build, invite decode/encode, capture, `inviteAction` table, lookup), `apps/app/test/share.test.js` (copy, share, visible URL), and the service worker and `varanda-serve` cases for the new paths.
- Run on the branch with main merged in (through #175): `npm run lint` clean; `npm test` 135 test files, 0 failures; `npm run demo` DEMO OK; `npm run export:web -w apps/app` builds.

### Human verification

- [ ] (a) Signed out, open `/@nome`: card, 'Criar passkey', @nome, Google, back, close Conta, name or skip: Membro of that person opens with 'Seguir' and the toast 'Para seguir @nome, toque em Seguir.'; one tap follows (not performed).
- [ ] (a2) A member with an account but signed out (session expired), open `/@nome`: card, 'Entrar com a passkey' (no Google step): toast 'Agora você segue @nome.' and Membro shows 'Seguindo' (not performed).
- [ ] (b) A remembered session opening `/@nome`: Membro with 'Seguir' and no `follow.add` (not performed).
- [ ] (c) `/m/<hex>`: the 'Alguém convidou você' card and no key on screen (not performed).
- [ ] (d) 'agora não' clears the card and the record (not performed).
- [ ] (e) The own link opens Diário (not performed).
- [ ] (f) A cancelled or pending ceremony does not accept (not performed).
- [ ] (g) Offline lookup: one toast, invite kept (not performed).
- [ ] (h) Invalid `/@x!` and `/m/zz` are cleaned and ignored (not performed).
- [ ] (i) Network toggled off and on during 'Buscando sua conta…': after Google the profile still opens with the 'Para seguir' toast (the acceptance was recorded) (not performed).
- [ ] (j) In-app browser: card, 'abra no Chrome ou no Safari' and copy link (not performed).
- [ ] (k) Google sign-in from the installed PWA on Android and iOS (not performed).
- [ ] (l) Diário 'copiar link' / 'compartilhar' with and without an @nome (not performed).
- [ ] Installed PWA: open a profile link offline (not performed).

### Residual risks

- The username lookup is same-origin: the account service answers, and the match is a consistency check, not a signature.
- A script of this origin in the same tab, an extension or devtools can write an invite record (same class as the outbox note in `docs/app.md`, narrowed to one tab). It cannot cause a follow: within one page acceptance and the follow require the stored record to name the profile the page showed, and a record read after a reload — even one marked accepted — only opens that profile with 'Para seguir…', so the person sees whom before tapping. The security audit found both paths (Codex Security; Claude and Grok re-audits), and they were closed this way.
- An OAuth return outside the initiating browsing context (possible in some installed PWAs) loses the invite: the newcomer lands on the tabs without the inviter's profile and has to find them (Seguindo, @nome) to follow.
- Installed iOS PWAs do not capture links.
- If `sessionStorage` is unavailable or the write fails, the invite does not survive the Google reload (the profile still opens on this load; a returning member who signs in from the card on this page is still followed).
- The card's @nome comes from the URL and is checked against the account service only at completion.
- A username renamed after the link was shared stops resolving ('Não encontramos esse @nome.').
- In-app browsers need the link opened in a real browser.
- If a signed-in member taps Sair while an invite is pending, the card appears and signing in again counts as accepting it.

## 27. Triagem de denúncias com IA (PR feat/ai-report-triage, 2026-10-27)

### O que mudou

- O serviço de conta, com a triagem ligada, lê o bloco 0 e o bloco denunciado no semeador local, reconfere os dois e compara o texto verificado com precedentes humanos. Decide sozinha só com folga; senão a denúncia fica `aberta`. Roda no servidor: um veredito calculado no aparelho poderia ser forjado. Um bloqueio da IA fica pendente até o `mod apply` do operador. A chave secreta da moderação não vai para o servidor. O trecho citado da denúncia continua sem ser conferido pela própria denúncia.
- Modelo `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (exportação ONNX de `paraphrase-multilingual-MiniLM-L12-v2`: cerca de 118 milhões de parâmetros, vetores de 384 dimensões, português incluído, até 128 wordpieces), quantizado q8, revisão `2c4055b12046f11709e9df2c122e59ffbdc2f900`, num processo filho com ambiente vazio e saída descartada (`apps/cli/lib/account/ai/embed-child.js`, IPC; prazos de 60 s para carregar e 10 s por texto, recriação no máximo a cada 5 s), com `@huggingface/transformers` 3.8.1 e o binário de CPU do `onnxruntime-node` 1.21.0. Os pesos ficam no volume `account-data` (`/data/ai-model` no contêiner). O operador baixa uma vez com `node apps/cli/scripts/fetch-ai-model.js --dir <diretório fora do repositório>`, que confere o sha256 dos cinco arquivos. Em execução não há download nem texto para API externa. Acima de 128 wordpieces a IA não decide. `npm ci --ignore-scripts` em `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` e `deploy/seeder/build-web.sh`; a imagem Docker instala com `--ignore-scripts`. Uma checagem com o modelo real: cosseno 0,86 entre duas paráfrases em português e 0,09 contra uma frase sem relação.
- `VARANDA_AI` vazio ou ausente desliga; `sombra` só sugere no painel; `1` decide. Sem o modelo (`sem-modelo`) o serviço sobe sem triagem e a checagem de saúde continua verde. Regra, aprendizado, painel e operador: `docs/design.md` (Moderação, item Triagem automática) e `docs/protocol.md` (rota e pull). `account status` mostra `Triagem IA: desligada`, `Triagem IA: <n> precedentes` ou `Triagem IA: indisponível (exemplars.json inválido)`.
- Arquivos: `apps/cli/lib/account/ai/triage.js`, `exemplar-store.js`, `ledger.js`, `embedder.js`, `read-post.js`, `worker.js`; `apps/cli/scripts/fetch-ai-model.js`; `packages/core/lib/seeder.js` (`postBlock`); `apps/cli/lib/seed-ws.js` (a rota); `apps/cli/lib/cli.js` e `apps/cli/lib/commands/seed.js` (o token); `apps/cli/lib/account/moderation-store.js` (`actor`, `humanReversed`); `apps/cli/lib/mod-apply.js` (a marca `(ia)`); `apps/cli/lib/account/mod-routes.js` (ganchos e projeção); `apps/cli/lib/commands/account.js` (ambiente, subida e `status`); `apps/cli/lib/account/panel/app.js`; `deploy/seeder/compose.web.yaml`, `deploy/seeder/build-web.sh` e os exemplos de ambiente do semeador; `npm ci --ignore-scripts` no CI.

### Testes automatizados

Cobertura no repositório:

- `apps/cli/test/ai-triage.test.js`: a regra pura (limiares, partida a frio, motivos, texto idêntico).
- `apps/cli/test/ai-exemplar-store.test.js`: `exemplars.json` (validação total, teto, modelo).
- `apps/cli/test/ai-ledger.test.js`: `triage.json` (marcas, cache, arquivo corrompido posto de lado).
- `apps/cli/test/ai-embedder.test.js`: o embedder com tokenizer e modelo injetados; o modelo real só quando `VARANDA_AI_MODEL_DIR` aponta para um diretório do `fetch-ai-model.js` (não definido no CI).
- `apps/cli/test/ai-post-route.test.js`: `GET /moderation-post/<D>/<seq>` e `Seeder#postBlock`.
- `apps/cli/test/ai-read-post.test.js`: a reconferência no serviço de conta.
- `apps/cli/test/ai-worker.test.js`: modos, tetos, espera crescente, aprendizado.
- `apps/cli/test/ai-hooks.test.js`: ganchos em `mod-routes.js`; a projeção do painel e do pull traz `actor` e não traz e-mail.
- `apps/cli/test/ai-e2e.test.js`: o laço em loopback, da denúncia assinada ao bloqueio no semeador, com embedder falso no lugar do MiniLM.
- Estendidos: `apps/cli/test/moderation-store.test.js` (`humanReversed`), `mod-apply.test.js` (a marca `(ia)` e a recusa do formato antigo), `account-mod.test.js`, `account.test.js` (ambiente, subida, `status`), `panel.test.js`, `deploy.test.js`, `caddyfile.test.js` (a rota não entra no Caddy) e `cli.test.js`.

### Limites

- A autenticidade do texto depende do semeador local mais a rota com token. O JSON não é uma prova portátil. A reconferência no serviço de conta pega resposta malformada, tipo errado, fork errado, certificado ruim e emissor revogado. Não pega um semeador malicioso.
- Leituras além de 2000 perdem o texto em cache: uma decisão humana depois disso pode não virar precedente.
- O registro de eventos tem teto de 10000. Um desbloqueio pelo painel de uma chave bloqueada fora do painel pode ser esquecido depois que o evento sai do registro.
- Cancelar um desbloqueio também conta como "uma pessoa já mexeu nesta conta". A IA só se abstém.
- Os limiares (0,92, 0,90, 0,12, 20 precedentes de cada lado, 5 diários) são iniciais e devem ser revistos com o Histórico. A checagem com o modelo real (cosseno 0,86 entre paráfrases) indica que a IA age sobretudo em textos quase idênticos.
- A IA não vê imagens. A comparação com listas de hashes de mídia ilegal (issue #79) continua não existindo.
- `exemplars.json` inválido (uma linha basta) fica indisponível e nunca é regravado. `triage.json` corrompido é renomeado para `triage.json.corrupt-<ms>` e recriado.

### Verificação humana

- [ ] Baixar o modelo com `node apps/cli/scripts/fetch-ai-model.js --dir <diretório fora do repositório>`.
- [ ] Gerar o token (`openssl rand -hex 32`) e pôr o mesmo `VARANDA_TRIAGE_TOKEN` no semeador e no serviço de conta.
- [ ] Subir com `VARANDA_AI=sombra` e conferir as sugestões no painel (`/account/mod/`).
- [ ] Passar a `VARANDA_AI=1`.
- [ ] Uma denúncia de spam quase idêntica a 5 bloqueios humanos de 5 diários, com 20 precedentes de cada lado, fica pendente com "pedido pela IA".
- [ ] `mod apply --yes` (o agendamento) NÃO assina o bloqueio da IA: mostra `bloquear <hex> (ia) — aguarda revisão no terminal` e a mudança continua em Pendentes; um `mod apply` num terminal mostra `(ia)`, pede confirmação e só então publica.
- [ ] Denúncias `ilegal` e de publicação com fotos ficam abertas.
- [ ] O log do serviço não tem texto de publicação.
- [ ] `curl` da rota sem token no semeador dá 404, e pela URL pública (Caddy) também.

## 28. Estatísticas de uso no painel de moderação (2026-10-27)

### Resumo

- A aba Estatísticas de `/account/mod/` fica só para os e-mails de `VARANDA_STATS_EMAILS`, um subconjunto de `VARANDA_MODERATOR_EMAILS`. `GET /account/mod/api/me` traz `stats: true` só para esses administradores. Quem está fora da lista não vê a aba, e `GET /account/mod/api/stats` responde 403 `nao-autorizado`. Sem sessão, a resposta continua 401 `{"error":"nao-autorizado"}`: a sonda `api/me` do `deploy.sh` não muda.
- A aba mostra membros e teto, diários, ativos hoje e em 7 dias, conexões, publicações indexadas, armazenamento, cadastros por semana (12) e por mês (12, com o total acumulado) a partir de `linkedAt`, e uma tabela de 30 dias. Não mostra contagem de denúncias. Só contagens: sem chave, e-mail ou @nome.
- `activeDay` e `activeWeek` vêm de `packages/core/lib/activity.js` (`DAY_OFFSET_MS`, `dayStart`, `localDay`, `noteGrowth`, `countActive`). Contam diários servidos e já conferidos (`gated`) cujo tamanho assinado passou do comprimento conhecido ao servir. A janela é o dia de Brasília (UTC−3), fixo, sem horário de verão desde 2019, no relógio da máquina. Ficam só na memória do semeador, zeram no reinício, e um diário admitido pela primeira vez nesta execução conta quando o tamanho assinado cresce. O `/health` publica `activeDay` e `activeWeek`; o `/metrics` publica `varanda_seeder_active_diaries_day` e `varanda_seeder_active_diaries_week`. As contagens nunca dizem quais diários.
- `usage.json` fica no diretório de dados da conta (volume `account-data`): `{ v: 1, days: [{ day, members, admitted, activeDay, activeWeek, blocks, bytes, mediaBytes, topicPosts, connections, external }] }`, uma linha por dia de Brasília (UTC−3), no máximo 400 (`MAX_DAYS`), modo `0600`, gravado com `writeJsonAtomic`. Um arquivo inválido nunca é regravado. `PEAK_FIELDS` (`activeDay`, `activeWeek`, `connections`, `external`) guardam o pico do dia; os outros totais guardam o valor mais recente. A amostragem de fundo é a cada 15 minutos (a primeira cerca de um minuto depois de subir) e a aba pede no máximo uma leitura ao vivo a cada 5 minutos, em `VARANDA_SEEDER_HEALTH` (padrão `http://127.0.0.1:8788`, loopback, lido só com as estatísticas ligadas). Apagar o arquivo só perde o histórico.
- Os cadastros por semana e por mês usam o mesmo dia de Brasília (UTC−3) de `linkedAt` e são exatos, sem suprimir células pequenas: `linkedAt` já é a data do certificado público.
- O serviço de conta registra só `{ event: 'usage', reason }`, com `reason` `ligada`, `desligada`, `invalido` ou `falhou`.
- O `deploy.sh` e o serviço conferem `VARANDA_STATS_EMAILS` (subconjunto dos moderadores) e `VARANDA_SEEDER_HEALTH` (loopback) sem imprimir os valores. O contêiner `account` precisa ser recriado para ler o `.env`.
- Documentos: `README.md` (saúde, política de registros, aba), `docs/protocol.md` (seção 7 e "Files and replicas"), `docs/design.md` (tabela LGPD e o painel) e esta seção.

### Testes automatizados

- `packages/core/test/activity.test.js`: `DAY_OFFSET_MS`, `dayStart`, `localDay`, crescimento só além do comprimento conhecido, janelas do dia e da semana, só entradas `gated`.
- `apps/cli/test/seed-ops.test.js`: `activeDay` e `activeWeek` no `/health` e os medidores `varanda_seeder_active_diaries_day` e `varanda_seeder_active_diaries_week` no `/metrics`; um diário restaurado sem crescimento novo não conta.
- `packages/core/test/seeder.test.js`: um diário admitido nesta execução conta uma vez quando o tamanho assinado chega; um novo crescimento no mesmo dia não conta de novo.
- `apps/cli/test/account-store.test.js`: `linkStats` devolve só contagens, por dia de `linkedAt`.
- `apps/cli/test/account-seeder-health.test.js`: leitura do `/health` em loopback; um semeador antigo sem `activeDay` / `activeWeek` entrega esses campos `null`.
- `apps/cli/test/account-usage-stats.test.js`: `usage.json`, pico contra o mais recente, teto de 400 dias, arquivo inválido nunca regravado (registro `usage` `invalido`), falha de gravação (registro `usage` `falhou`), baldes de cadastro, `GET` da visão.
- `apps/cli/test/account-mod.test.js`: `api/me` com `stats: true` só para o administrador das estatísticas; `api/stats` 403 `nao-autorizado` para os outros; sem sessão, `api/me` segue exatamente 401 `{"error":"nao-autorizado"}`.
- `apps/cli/test/panel.test.js`: a aba Estatísticas só com `stats: true`; a tabela, o aviso de reinício e o aviso de `usage.json` inválido.
- `apps/cli/test/account-stats.test.js`: o serviço liga e desliga a amostragem a partir de `VARANDA_STATS_EMAILS` e `VARANDA_SEEDER_HEALTH`, e registra `usage` `ligada` ou `desligada`.
- `apps/cli/test/deploy.test.js`: o `deploy.sh` confere o subconjunto e o loopback sem imprimir os valores (também com espaço em volta do `=` e com aspas); a sonda de `/account/mod/api/me` continua no script.

### Verificação humana

Nenhuma destas conferências foi feita ao escrever esta seção.

- [ ] `VARANDA_STATS_EMAILS` está definido em `deploy/seeder/.env` (subconjunto de `VARANDA_MODERATOR_EMAILS`) e o contêiner `account` foi recriado (`up -d --force-recreate account`).
- [ ] Um administrador das estatísticas vê a aba Estatísticas em `/account/mod/`.
- [ ] Um moderador fora da lista não vê a aba, e `GET /account/mod/api/stats` com a sessão dele responde 403 `nao-autorizado`.
- [ ] Os números da aba batem com `curl -s http://127.0.0.1:8788/health`.
- [ ] Uma publicação pelo PWA aumenta "Ativos hoje" em até 5 min.
- [ ] Depois de reiniciar o semeador, a aba mostra "O semeador reiniciou há menos de 7 dias: os ativos ainda estão parciais." e os ativos recomeçam em 0.
- [ ] `usage.json` aparece no volume `account-data` em cerca de 15 min, com modo `0600` e uma linha por dia de Brasília (UTC−3).
- [ ] `docker compose logs account seeder` não mostra e-mail, chave nem endereço.
- [ ] A sonda `api/me` do `deploy.sh` continua igual: sem sessão, 401 e o corpo `{"error":"nao-autorizado"}`.

## 29. Termos de Uso e Política de Privacidade (PR feat/terms-privacy, 2026-10-27)

### O que mudou

- Antes de Entrar (web hospedada) ou Conectar (nativo), o app mostra os Termos de Uso e a Política de Privacidade (versão vigente, `LEGAL_VERSION` em `apps/app/src/legal.js`) e só segue depois do aceite. O aceite é por aparelho e por membro: pergunta de novo a cada conta nova e a cada versão nova. Na web hospedada, enquanto a conta está bloqueada, o aparelho não sabe quem vai entrar, então o portão aparece antes de Entrar só enquanto não há registro da versão atual no aparelho; com esse registro, recarregar, Sair ou a sessão expirar não pedem de novo antes de Entrar. Quem desbloqueia é conferido no registro: uma conta sem registro próprio é perguntada logo depois da passkey, antes de qualquer pedido ao serviço de conta (numa primeira passkey o shell ainda não conhece a chave, então o registro só dispensa o portão enquanto a conta está bloqueada); uma sessão retomada de um membro que já está no registro do aparelho passa direto. No nativo e no `varanda-serve`, passa enquanto não existe identidade e pergunta quando aparece uma identidade que não está no registro. A decisão é a função pura `termsDecision` (`apps/app/src/terms.js`, com `hosted`, `identityKnown` e `locked`); o aceite dado na página fica preso à próxima identidade que desbloqueia nessa carga (limite de navegador compartilhado). (Regra revista em 2026-10-29: antes, o portão voltava em toda carga bloqueada.)
- Declaração assinada `varanda-terms-v1` (`packages/core/lib/terms.js`): `'varanda-terms-v1'`, nonce, membro, associação e versão, unidos por LF, sem LF final e sem data. A data é a do serviço de conta. Assinada pela chave do diário do membro; nenhuma outra assinatura do protocolo usa o prefixo.
- RPC `terms.sign` `{ nonce, version }` -> `{ signature }` (`docs/rpc.md` 5.29): só no nó do navegador; os nós nativo, `varanda-serve` e CLI respondem `USAGE` `'assinatura disponível só no navegador'`.
- Serviço de conta (`apps/cli/lib/account/server.js`): `POST /account/terms/start` `{ member, version }` -> `{ nonce }` e `POST /account/terms/finish` `{ member, nonce, signature }` -> `{ version, acceptedAt }`. Recusas: `pedido-invalido`, `nao-vinculado`, `expirado`, `assinatura-invalida`, `indisponivel` e `limite`. Só membro com vínculo Google aceita no servidor; o nonce vale 10 minutos, uma vez, no máximo 1000 pendentes.
- `terms.json` (`apps/cli/lib/account/terms-store.js`, volume `account-data`, modo 0600): `{ v: 1, members: { <hex64>: [{ version, acceptedAt, nonce, signature }] } }`. Cada aceite relê e une o arquivo; o teto por membro é 32 (guarda as MAIORES versões); `MAX_MEMBERS` (100000) limita só admissões novas; um membro com lista vazia torna o arquivo inválido (indisponível, nunca regravado). Uma recusa da guarda (`lock.owned()`) recusa só aquele pedido; a indisponibilidade permanente só vem de `fail()` quando o batimento confirma a perda do bloqueio, ou de um arquivo malformado. Um reparo (`heal()`) roda a cada 10 s no `serve` (`startTermsHeal`, registro `{ event: 'terms', reason: 'reparado' }`) e uma vez numa parada limpa. O `heal()` só relê o arquivo quando inode, tamanho, `mtime` ou `ctime` mudaram, ou quando a loja está suja; depois de gravar, não guarda a impressão do que gravou (uma troca tardia de um gravador desatualizado ficaria sem leitura), então o reparo seguinte lê uma vez. Um erro de leitura que não seja arquivo malformado (`EIO`, `EMFILE`) não derruba a loja: registra `{ event: 'terms', reason: 'leitura-falhou', code }` (só o código do erro) e tenta de novo no próximo intervalo.
- Aparelho: um registro por aparelho (chave `varanda-terms` no `localStorage` da web, arquivo `varanda-terms.json` no nativo): `{ v: 1, version, members: { <hex64>: { acceptedAt, synced } } }`, no máximo 16 membros, lido sempre como não confiável (`termsRecordOf`); um registro recusado significa "perguntar de novo".
- Sincronização com o servidor: no máximo 3 tentativas por membro e versão em cada carga da página (falhas de verdade), rearmadas ao voltar a rede, depois de mudar a geração da passkey e depois de um vínculo confirmado em Ajustes › Conta; `nao-vinculado` vale como "só neste aparelho".
- Ajustes › Termos e privacidade mostra os dois documentos em todos os modos e o estado do aceite (registrado, pendente, só neste aparelho). Recomeçar tira aquele membro do registro do aparelho; Sair não tira.
- `account export` ganha o campo `terms` por membro (`{ version, acceptedAt }`, nunca a assinatura); `account status` ganha a linha `aceites dos termos: <n>` (ou `aceites dos termos: indisponível (terms.json inválido)`).
- A frase do passo da conta (`LINK_TEXT` em `Identidade.js`) agora aponta para a Política de Privacidade e não diz mais "nada mais é coletado". Contato nos textos: issues do GitHub (sem dados pessoais) e o formulário de aviso de segurança só para segurança.
- Os textos v1 têm o hash sha256 fixado em `apps/app/test/legal.test.js`: qualquer mudança de texto obriga a subir a versão (`LEGAL_VERSION` e `TERMS_VERSION` em `packages/core/lib/terms.js`, que `apps/app/test/terms-version.test.js` mantém iguais).

### Testes automatizados

Cobertura no repositório:

- `packages/core/test/terms.test.js`: a declaração (bytes exatos, campos, verificação, separação de prefixo).
- `packages/rpc/test/methods.test.js`: o esquema de `terms.sign` (`nonce`, `version`, nada mais).
- `packages/core/test/session.test.js`: o nó nativo responde `USAGE`.
- `packages/web-member/test/session.test.js`: `terms.sign` assina com o membro e a associação do nó; recusa sem identidade, bloqueado e parâmetros a mais.
- `apps/cli/test/terms-store.test.js`: `terms.json` (validação, união, teto por membro, reparo, guarda, modo 0600).
- `apps/cli/test/account-terms.test.js`: as duas rotas e todos os motivos de recusa.
- `apps/cli/test/account.test.js` e `apps/cli/test/account-e2e.test.js`: `export`, a linha de `status` e o ciclo completo.
- `apps/app/test/terms.test.js`: `termsDecision`, o registro do aparelho e a fila de tentativas.
- `apps/app/test/legal.test.js` e `apps/app/test/terms-version.test.js`: os textos fixados por hash e a versão igual à do núcleo.
- `apps/app/test/account.test.js`: as chamadas do app às rotas.
- Executados na CI local, em ordem: `npm run lint`, `npm test`, `npm run demo` (resultado na descrição do PR).

### Verificação ao vivo

Ainda não feita; marcar na hora de verificar, fora dos testes acima.

- [ ] Na web hospedada, sem sessão e sem registro da versão atual neste aparelho (primeira visita): o portão aparece antes de Entrar, com os dois documentos abrindo no lugar; "Li e aceito os Termos de Uso e a Política de Privacidade" libera Entrar; sem tocar nele não se entra.
- [ ] Sair e Entrar de novo com a mesma conta: não pergunta, nem antes nem depois de Entrar; recarregar com a sessão retomada de um membro já aceito não pergunta.
- [ ] Escrever um rascunho em Publicar, fechar sem publicar e tocar em Sair; entrar na mesma aba com outra conta que já aceitou neste aparelho: o compositor abre vazio e Ajustes mostra o perfil da conta nova.
- [ ] Entrar com uma conta nova no mesmo aparelho: não pergunta antes de Entrar; o portão aparece logo depois da passkey.
- [ ] Aceitar o portão e recarregar antes de Entrar: não pergunta antes de Entrar; a conta que entrar é perguntada uma vez logo depois da passkey.
- [ ] Nesse mesmo caso, com uma passkey nova (primeira entrada): o portão aparece logo depois da passkey, sem "Continuar com o Google" e sem pedido a `/account/status` antes do aceite (aba Rede); depois do aceite, a configuração segue sem erro e sem pedir a passkey de novo.
- [ ] Recomeçar com o único membro do aparelho e recarregar: não pergunta antes de Entrar; a nova conta é perguntada logo depois da passkey.
- [ ] Um valor de `varanda-terms` editado à mão que não passa na validação: o portão aparece antes de Entrar.
- [ ] Depois do vínculo Google, o aceite chega ao servidor: `account status` mostra `aceites dos termos: 1` e `account export` traz o `terms` do membro (parar o serviço antes do export).
- [ ] Membro sem vínculo: Ajustes › Termos e privacidade diz "só neste aparelho"; depois do vínculo vira "registrado".
- [ ] Armazenamento recusado (janela privada que bloqueia `localStorage`): o portão aparece a cada carga.
- [ ] Subir `LEGAL_VERSION` e `TERMS_VERSION` para a próxima versão (7, hoje) num teste local: o portão volta para todos e o registro do aparelho é substituído.
- [ ] Recomeçar tira o membro do registro; Sair não.
- [ ] No nativo (`Conectar`): o portão antes de Conectar e, em Ajustes › Termos e privacidade, a data do aceite (sem linha de sincronização: no nativo o aceite fica só no aparelho).

### Limites

- O aceite é por aparelho e por membro. Membros nativos e membros sem vínculo Google ficam só no aparelho.
- Armazenamento recusado: o aceite vale só para a carga e é pedido a cada carga.
- A sincronização com o servidor tenta até 3 vezes por carga da página; depois, nas cargas seguintes.
- Um `terms.json` restaurado de uma cópia mais antiga perde aceites, e aparelhos que já sincronizaram não reenviam.
- Janela que sobra: um titular que cai dentro de um intervalo de reparo (10 s) depois do rename de um escritor atrasado perde os aceites que confirmou nesse intervalo.
- O nó pode subir, retomar a sessão e fazer a sincronização de recuperação do certificado antes do aceite; a sincronização contínua, a fila de saída, o convite e as chamadas à conta esperam.
- Subir a versão substitui o registro do aparelho (aceites antigos ainda não sincronizados se perdem).
- Textos v1 pendentes de revisão jurídica; o encarregado não está nomeado; ainda não há URL pública dos textos.
- O portão substitui a interface em vez de ficar acima dela, e não vale a pena mudar isso: nada pode renderizar ou ficar acessível atrás dele (o aceite precede o nó, a fila de saída e o convite), e uma sobreposição exigiria prender o foco e esconder o conteúdo de leitores de tela. O que estava montado antes se perde só quando o portão aparece depois do aplicativo (versão nova dos termos ou conta sem registro), caso em que rascunhos não salvos se perdem; o que o #209 tratou, o bloqueio com a conta em dia, não passa pelo portão. Não confirmado no nativo.
- O portão pertence ao app oficial: um cliente modificado ou outro cliente do protocolo não passa por ele, e o aceite no servidor é um registro, não uma barreira.
- Na web hospedada, antes de o nó conectar o modo ainda não é "hospedado": quem tem o registro do aparelho em dia pode ver a tela de erro de conexão antes do portão. Nada sai dessa tela; o portão aparece assim que o nó conecta.
- Num navegador compartilhado, o aceite dado antes de Entrar vale para a próxima conta que entrar naquela carga da página.
- Com o registro da versão atual no aparelho, outra conta só vê o portão depois da passkey, não antes do Google; o aceite dado antes de Entrar na mesma carga continua valendo para a primeira conta que entrar (item acima).

## 30. Android gate on the emulator (issue #150, 2026-10-28)

What was run: the worklet gate (steps a to i of [ios-gate.md](ios-gate.md)) on an Android 16 (API 36, google_apis x86_64) emulator, KVM, software GPU, with the debug build of `app.varanda.debug`, on Linux with JDK 21 and Gradle 9.0.0.

Build: `npm run link:addons` and `npm run pack:worklet` (351 files, 38 linked addon entries, scan clean), then `./gradlew assembleDebug` (BUILD SUCCESSFUL). `lib/x86_64` of the APK holds the `.so` addons (`libbare-fs.4.8.4.so`, `librocksdb-native.3.19.1.so`, `libsodium-native.5.2.0.so`, `libudx-native.1.21.3.so`, ...): jniLibs are picked up from the library's `android/src/main/addons`, and the worklet loads them.

Driver output of the final run (lines shortened, `trace` lines omitted):

```
PASS a: diag structuredClone=function O_NOFOLLOW=yes O_EXCL=yes bare=v1.33.4
PASS b: identity.create f288d5d0...
PASS c: cert.add seq 0, node.info memberCert true
PASS d: post.create f288d5d0...:1
data-dir lock before the kill: present (files/varanda-gate-<run>/.varanda-lock)
app terminated (adb); lock after the kill: present
PASS e: log.read after kill+relaunch: seq 1 "post do app (gate)" (2 entries, recover true)
PASS f: app sync once done (seederConfirmed true); feed.read has the CLI peer post | CLI peer sync once
        done downloaded 3 blocks of the app diary
PASS g: node.info after background/resume: publicKey f288d5d0, sync idle
PASS h: second worklet (no recover) node.info -> LOCKED; its node.close stop clean in 10 ms; first worklet still answers
PASS i: terminateNode clean in 9 ms; startNode without recover + node.info + log.read in 315 ms (3 entries)
GATE OK
```

Defects found and fixed:

- **`link()` is denied to Android apps.** Step b failed with `INTERNAL erro interno`; logcat had `avc: denied { link }` (SELinux, `untrusted_app`) and `EACCES ... linkSync config.json.<pid>.<rand>.tmp -> config.json` from `publishConfig` (`packages/core/lib/member.js`). The same pattern is in `saveKeyPairFile` (`lib/cert.js`). `lib/link-new.js` now falls back to an `lstat` check and a rename on `EACCES` only, and still refuses to replace an existing entry (`EEXIST`, a dangling symlink included). `EPERM` is not a fallback: other file systems (FAT, exFAT, network volumes) answer `link()` with it, and the moderator and account key creation in `apps/cli` rely on its `EEXIST` to never overwrite a secret key. The check and the rename are not atomic, which is accepted because the app's data dir is private to one worklet. Regression test: `packages/core/test/link-new.test.js` (fails without the fix with the same `EACCES`).
- **The emulator does not share the host's loopback** (driver, not product): steps a to e passed and f failed with `sem pares`. The app's DHT did bootstrap (lookup found the seeder and the CLI peer), but the connection failed with `PEER_CONNECTION_FAILED` (hole punch). Fixed in the driver as described in ios-gate.md ("Android emulator"): the nodes bind to `--host`, with firewall probing off. UDP from the emulator to the host's LAN address was checked with a UDP echo first.

Not verified: a real Android device, arm64-v8a, a release build, Doze and the real background limits (step g only sends the app to the Home screen for 5 s), and iOS after the driver refactor (`--platform ios` keeps the old defaults, `--host 127.0.0.1`, probing on; the iOS gate was not re-run).

Method notes: with the data partition too small the emulator refuses to start, so keep several GB free. `adb reverse` carries TCP only. Do not stop Metro with `kill $(lsof -ti tcp:8081)`: `lsof` also lists the emulator process, which has a connection to that port, and in this run the kill stopped the emulator too. Use `lsof -ti tcp:8081 -sTCP:LISTEN`.

## 31. Quem curtiu e quem republicou (seeder engagers lists, 2026-10-28)

### Summary

- Shipped: the seeder's engager pages `GET|HEAD /index/likes/...` and `/index/reposts/...` in `apps/cli/lib/seed-ws.js`, backed by `packages/core/lib/engagement-index.js` and `packages/core/lib/seeder.js` (`indexEngagers`, newest first, paged by cursor, 20 per page); `fetchEngagers` in `apps/app/src/indexClient.js`; the pure helpers in `apps/app/src/engagers.js`; the 'Curtidas' screen (`apps/app/src/screens/Curtidas.js`) with its route in `apps/app/src/nav.js` and `apps/app/App.js`; the entry points in `apps/app/src/ui/PostRow.js` and the screens that render it (A Rua, Conversa, Diario, Espiadinha, Membro, Busca); `docs/protocol.md`, `docs/rpc.md`, `docs/design.md`, `docs/app.md`, `apps/site/artwork/app-design.md`, `CHANGELOG.md`. The service worker (`apps/app/scripts/sw.js`) and Caddy already pass every `/index/` path: only `sw.test.js` gains the new URLs and the Caddyfile gains comment lines.
- Hosted web only. Native and `varanda-serve` show no number control.
- Entry point: the like and repost numbers on post rows. Each number sits next to its icon as a compact, separate touch target (each icon and number pair is about as wide as the old combined button, about 47 pt, so the bar still fits 320 pt). The toggle and the number have non-overlapping hit areas: the icon toggles, the number opens the list on the matching tab. On a repost row the list is the original post's.
- Trust model: the index says where to look; each row is the engager's own signed like or repost record, verified by `diary.peek` on the node. A seeder can omit or reorder people but cannot invent one.
- No new RPC method. The counts on rows are unchanged.

### Automated (CI)

CI result on the final tree, from the worktree root, in this order: `npm ci --ignore-scripts`, `npm run lint`, `npm test`, `npm run demo`. `npm ci` was not rerun in this pass (dependencies were already installed). Lint, test and demo were run on Node 24.22.1 and on Node 20.20.2.

- `npm run lint`: clean on both versions (`standard` printed no output).
- `npm test` (all workspaces), the same on Node 20.20.2 and on Node 24.22.1, 0 failures: core 38, rpc 8, web-member 31, app 38, cli (`varanda`) 43, site 2 test files (`# N arquivo(s) de teste, 0 falha(s)` for each).
- `npm run demo`: `DEMO OK` on both versions.
- New or changed test files, all passing: `apps/cli/test/seeder-index.test.js` (engager pages, 'lazy targets', 20k likers), `apps/cli/test/seed-ws.test.js` (the `/index/likes|reposts` routes and the size cap: 57/57 on Node 20), `apps/app/test/indexClient.test.js` (`fetchEngagers`), `apps/app/test/engagers.test.js` (new, the pure helpers), `apps/app/test/nav.test.js` (the new route) and `apps/app/test/sw.test.js` (additions).
- 'lazy targets' (`seeder-index.test.js`), Node 20.20.2 log: `50k distinct like targets: 25.06 MiB retained (526 bytes/target including records)`, against the unchanged 35 MiB bound. Before this change the same test retained 22.0 to 22.5 MiB; the extra 3 MiB or so is the per-like and per-repost edge object. The Node 24 run measured 25.08 to 25.54 MiB.
- 20k engagers on one target (`seeder-index.test.js`, 'engager pages: 20,000 likers on one target have bounded visibility work'): first page 0.054 ms on Node 20 (0.049 ms on Node 24), with at most 201 visibility calls. These are comments in the test log on a development machine, not asserted timings.
- `seed-ws.test.js` worst case: `engagers worst case: 4516 bytes` against the 65536 cap (a full page of 20 rows with maximum-length fields); an oversize answer is 404.
- No browser pass in CI: there is no component harness, so the Curtidas screen and the entry points are covered only by the pure helper tests and the human checklist below.

### Residual risks

- Order, omissions, `total`, and whether a listed `on` record is still the engager's latest operation on the post are seeder claims. A lying seeder can hide a person, reorder the list, list an older authentic like that was later taken back, or report a wrong total; it cannot invent a like.
- An `at` up to 24 h ahead is accepted, so an engager with a future-dated record is listed first; a record dated further ahead is hidden until the clock catches up.
- The count on the row can exceed the verified list (records dated more than 24 h ahead, engagers held by a pending re-gate, records that do not verify); the list then says 'Algumas pessoas não aparecem nesta lista agora.' or 'N pessoas indisponíveis', never a key, and never 'Ninguém curtiu ainda'.
- A like or unlike while the list is being paged needs a refresh to show up; a person blocked while the list is open stays until refresh.
- Each page costs one serial `diary.peek` per engager, up to 20 per page.
- The page cursor never carries an engager hidden from the list (it resumes from the last person listed), so a run of 200 or more hidden engagers right after the cursor ends the list there; the answer then has `complete: false` and the screen says people may be missing.
- Privacy: the seeder learns which list was opened (which post, likes or reposts), but never the client address (Caddy strips it); Caddy keeps the address only in memory for the rate-limit window.
- Privacy, Caddy error log: the error log is on for every route, so a failed proxy (seeder restarting, a deadline) can record the request URI of `/index/likes` and `/index/reposts` together with the client address. The same deferred item as the topic search (section 25).
- Memory: the engagement index keeps one edge object per like and per repost in seeder memory (see the 'lazy targets' figure above); the pilot seeder was not measured.
- No follow pill on the rows: opening Membro is the way to follow someone from the list.

### Human verification

None of these was performed for this change. Use the hosted web app at 320 px and on desktop, against a seeder with the change.

- [ ] Hosted web at 320 px: the post bar fits, and tapping the like and repost numbers never toggles the like or repost, and tapping the icons never opens the list.
- [ ] Hosted web on desktop: the same, with the mouse.
- [ ] Two accounts like and repost the same post; the post shows both counts.
- [ ] From A Rua, from a repost row (the list is the original's) and from Conversa, the number opens the matching tab and the icon still toggles.
- [ ] Rows show verified names (not the raw key).
- [ ] A row opens Membro, and back returns to the same list.
- [ ] Unlike, then refresh: the person is gone from 'Curtidas'.
- [ ] A blocked engager disappears after a refresh.
- [ ] A record that does not verify shows '1 pessoa indisponível' and no key.
- [ ] More than 20 likers page with 'mostrar mais', without gaps or duplicates.
- [ ] Native app and `varanda-serve` show no number control.
- [ ] Keyboard (tab order, enter on the number) and screen-reader labels on the numbers and on the list.

## 32. Foto do perfil (PR feat/profile-avatar, 2026-10-28)

### O que mudou

- Web hospedada: Editar perfil escolhe uma imagem, enquadra em círculo e recodifica no navegador (`apps/app/src/media/avatar.js`, `crop.js`, `avatarEncode.web.js`, `ui/AvatarEditor.js`) para um still 512x512 em WebP ou JPEG de no máximo 262144 bytes, sem metadados. O nó confere o resultado (`packages/core/lib/still-image.js`). Nada sobe antes de Salvar (`profileSave.js`).
- Perfil: chave opcional `avatar` e o par de compatibilidade (`docs/protocol.md`); `profile.set` aceita `avatar`; `avatar` em `profile.read`, `diary.peek`, `peek.read` e `notices.list` (`docs/rpc.md`).
- Termos de Uso e Política de Privacidade versão 2, com novo aceite.
- O avatar usa a foto, quando há, no mesmo círculo (cover) por cima das iniciais; sem foto, iniciais; nunca caracteres da chave. O cache de nomes (`namesCache.js`) guarda o `avatar` junto do nome.
- O nó do núcleo recusa mudar nome ou bio enquanto existe foto (`USAGE` 'perfil com foto: mude o nome e a bio na versão web ou tire a foto').

### Testes automatizados

Novos: `apps/app/test/mediaAvatar.test.js`, `apps/app/test/mediaCrop.test.js`, `apps/app/test/namesCache.test.js`, `packages/core/test/still-image.test.js`.

Alterados: `apps/app/test/legal.test.js`, `search.test.js`, `thread.test.js`, `topics.test.js`; `packages/core/test/helpers/net.js` (o `scanWire` aceita as strings de mime de mídia), `member.test.js`, `peek.test.js`, `records.test.js`, `session-sync.test.js`, `session.test.js`, `terms.test.js`; `packages/rpc/test/methods.test.js`, `sizes.test.js`; `packages/web-member/test/diary-peek.test.js`, `e2e-media.test.js`, `media-ops.test.js`, `notices-e2e.test.js`, `notices.test.js`, `peek-repost.test.js`, `peek.test.js`, `session-e2e.test.js`, `session-media.test.js`, `session.test.js`.

### Verificação humana

Na web hospedada, a cada item:

- [ ] Um JPEG com EXIF e GPS, um PNG, um WebP e um GIF animado: cada um vira um still 512x512 em WebP ou JPEG de no máximo 262144 bytes, sem metadados (`exiftool` nos bytes baixados de `/media`).
- [ ] Enquadrar arrastando, com os botões, pelo teclado e com leitor de tela (VoiceOver, NVDA).
- [ ] Confirmar o enquadramento não sobe nada até Salvar.
- [ ] Remover a foto volta às iniciais.
- [ ] Num segundo aparelho, editar o nome mantém a foto.
- [ ] Um build antigo mostra o mesmo nome e a mesma bio.
- [ ] No nativo, aparecem as iniciais e dá para remover a foto.
- [ ] O portão da versão 2 dos termos aparece de novo.
- [ ] O avatar de uma conta bloqueada deixa de carregar.
- [ ] Caddy, mídia: 120 pedidos por 10 s com uma página cheia de avatares.
- [ ] Moderação: o painel só sinaliza fotos (`panel/app.js:62,99`); quem modera julga uma denúncia de foto abrindo `/m/<chave>` no app hospedado.
- [ ] (a) A saída real do codificador no Chrome, no Safari e no Firefox passa na conferência de still e de dimensões do nó: um Salvar com enquadramento novo funciona em cada navegador.
- [ ] (b) Entrar com foto no cadastro grava o perfil simples antes da declaração do núcleo de mídia, então a linha da Espiadinha de um desconhecido e o aviso de seguidor mantêm o nome depois de mais de 10 escritas.
- [ ] (c) Um enquadramento cujos bytes codificados falham na conferência local mostra 'não foi possível preparar a foto' e não sobe nada.

### Limites

- A foto é permanente: o registro fica no diário como os demais.
- Só os 4 núcleos de mídia mais novos valem.
- Não há comparação com listas de hash.
- No nativo, só iniciais.
- Uma aba com pacote antigo não mostra o nome de quem tem foto na busca, nas páginas de membro e nas conversas até recarregar.
- Quem escreve com versão antiga (aba velha, CLI antiga) e salva o perfil remove a foto.
- Espiadinha e Avisos mostram o avatar só dentro da janela de espiada.
- O nó do núcleo recusa mudar nome ou bio enquanto existe foto.
- Ao publicar, suba o semeador e o pacote web juntos.

## 33. Textos mais curtos e folhas de ajuda (issue #198, 2026-10-28)

### O que mudou

- As explicações saíram das telas e foram para uma folha de ajuda aberta pelo botão de informações (ⓘ). O conteúdo fica em `apps/app/src/help.js` (um texto por aba e por passo da configuração) e a folha em `apps/app/src/ui/Help.js`. Os avisos que antes ocupavam a tela viraram uma linha curta com "Saiba mais", que abre a folha do tema.
- Têm ⓘ: A Rua, Espiadinha, Seguindo, Avisos, Diário e os primeiros passos da configuração. Ganharam só "Saiba mais": passkey, vínculo com o Google, instalação, denúncia, diários que não aparecem, contas bloqueadas, pesquisa e registro do aceite.
- As telas principais e a tela Conectar da web hospedada não mostram mais semeador, nó, chave, certificado nem índice. A tela Conectar mostra uma frase simples e um botão "Tentar de novo" (`apps/app/src/connectText.js`: `CONNECT_FAILED_TEXT`, `OTHER_TAB_TEXT`, `RETRY_LABEL`), e os termos técnicos da falha ficam em "Detalhes técnicos", recolhido.
- O aviso do vínculo com o Google ficou em uma frase visível, antes de "Continuar com o Google".
- Textos de offline: Espiadinha e Avisos mostram "Sem conexão" com "Confira sua internet." (`PEEK_OFFLINE_MESSAGE`, `NOTICES_OFFLINE_MESSAGE`); a pesquisa mostra "A pesquisa precisa de conexão." (`SEARCH_OFFLINE_MESSAGE`).
- "Semeador ocupado" da tela passa a ser "Muitas pessoas conectadas agora. Tente de novo em instantes." (mapeamento em `apps/app/src/ui/index.js`).
- Ajustes › Avançado continua técnico. Os Termos, a Política de Privacidade e a regra da Espiadinha não mudaram; `apps/app/src/legal.js` não foi alterado, então nenhum aceite novo é pedido.

### Testes automatizados

Cobertura no repositório:

- `apps/app/test/help.test.js`: os textos da folha de ajuda por aba e por passo, e os temas de "Saiba mais".
- `apps/app/test/connectText.test.js`: as frases da tela Conectar, o botão de tentar de novo e a separação entre a frase e os detalhes técnicos.
- Atualizados para os textos novos: `apps/app/test/peek.test.js`, `apps/app/test/topics.test.js`, `apps/app/test/notices.test.js`, `apps/app/test/report.test.js` e `apps/app/test/onboarding.test.js`.

Resultados (2026-10-28, Node 24.22.1, macOS): `npm run lint` sem erros; `npm test` com 0 falhas em todos os workspaces (39, 8, 31, 45, 43 e 2 arquivos de teste, já com a main de #201); `npm run demo` termina com "DEMO OK". Node 20 não foi rodado localmente; fica para a CI.

### Verificação humana

Nenhuma verificação foi feita ainda. Todos os itens abaixo estão desmarcados e não realizada ainda; marcar só o que for de fato executado, com a saída.

- [ ] Cada aba (A Rua, Espiadinha, Seguindo, Avisos, Diário) e cada passo da configuração tem o ⓘ, com papel de botão e rótulo (não realizada ainda).
- [ ] Fechar, o toque no fundo, Escape e o botão Voltar do Android fecham a folha (não realizada ainda).
- [ ] "Saiba mais" em Entrar, Escolha seu @nome, Conta e @nome, Instalar, Denunciar, no aviso de Espiadinha pulada, no aviso de A Rua bloqueada e na pesquisa abre a folha certa (não realizada ainda).
- [ ] No iOS, a folha de ajuda aberta sobre Ajustes ou sobre Denunciar aparece e volta para a tela, e o rascunho continua lá (não realizada ainda).
- [ ] Na web, o Voltar com a folha de ajuda aberta sobre Denunciar fecha só a folha e mantém o rascunho da denúncia (não realizada ainda).
- [ ] A frase do vínculo com o Google aparece visível antes de "Continuar com o Google" (não realizada ainda).
- [ ] Na web hospedada, com uma segunda aba aberta, aparece a frase de outra aba, e "Tentar de novo" recupera a conexão (não realizada ainda).
- [ ] Na web hospedada com uma configuração manual salva antes, a página abre na visão simples (não realizada ainda).
- [ ] Com o boot offline, aparece a frase genérica de conexão, sem termos técnicos (não realizada ainda).
- [ ] Enquanto conecta, nenhum campo manual aparece (não realizada ainda).
- [ ] "Detalhes técnicos" começa recolhido e, ao abrir, é anunciado como expandido (não realizada ainda).
- [ ] Espiadinha e Avisos offline mostram "Sem conexão" e "Confira sua internet."; a pesquisa offline mostra "A pesquisa precisa de conexão." (não realizada ainda).
- [ ] Com os slots externos do semeador ocupados, a Espiadinha e os Avisos mostram "Muitas pessoas conectadas agora. Tente de novo em instantes." Este item substitui o texto antigo da verificação "Seeder full" da §24 (não realizada ainda).
- [ ] Ajustes › Avançado › Conexão continua igual, com os termos técnicos (não realizada ainda).
- [ ] Em Identidade técnica, o texto ainda diz chave e certificado (não realizada ainda).
- [ ] Membro que já aceitou a versão 1 dos Termos não é perguntado de novo, porque `legal.js` não mudou (não realizada ainda).

### Limites

- A tela Conectar nativa (ConexaoNo), o `varanda-serve` e Ajustes › Avançado mantêm as palavras técnicas (semeador, chave, certificado).
- A folha de ajuda ocupa a altura toda porque o componente `Sheet` não tem variante curta.
- O mock do site (`apps/site/public/index.html`) não foi atualizado nesta mudança.

## 34. Own publications out of the own Espiadinha (2026-10-28)

### Summary

- User report: the person's own reply showed in A Rua and also in their own Espiadinha. Decision, quoted from the owner: "eu nao vejo os meus mas outros veem os meus posts ou interracoes". So the person never sees their own publications, replies, quotes and reposts in their own Espiadinha (they are already in A Rua), while a person who does not follow them still sees that diary in their own Espiadinha, including a stranger's repost of one of their posts. This reverts section 19.
- The rule text returns to the pre-section-19 sentence, without "o seu incluído" (`PEEK_RULE`, `packages/core/lib/peek.js`). The own diary stays a candidate and is fetched over the anonymous link like any other, so the link keeps requesting the complement of the follows and the blocklist; `buildPeekPage({ hidden })` pages it exactly as if shown (same rounds, `needs`, windows and cursor) and removes its items only from the page returned to its owner, so a non-last page may hold up to 3 fewer items than `limit`. It is counted in neither `diaries` nor `skipped` nor the failed/capped `incomplete` warning. `peekCandidates` is back to `{ inventory, follows, blocked }`; `createPeeker` requires the `ownKey` getter and the session passes a cache-only getter.
- The "carregar mais" delay is out of scope. Topic search, A Rua, `feed.read` and `diary.peek` are unchanged.
- Files: `packages/core/lib/peek.js` and `packages/core/test/peek.test.js`; `packages/web-member/lib/peek.js`, `packages/web-member/lib/session.js` and the tests `peek.test.js`, `peek-repost.test.js`, `frame-guard-client.test.js` and `peek-capacity.test.js`; `apps/app/src/peek.js`, `apps/app/src/screens/Espiadinha.js` and `apps/app/test/peek.test.js`; docs `docs/rpc.md`, `docs/protocol.md`, `docs/design.md`, `docs/app.md` and `apps/site/artwork/app-design.md`.

### Automated (CI)

CI result on the final tree (rebased on main 60282a6), Node v24.22.1 (run from the worktree root). Node 20 (the other version in `.github/workflows/ci.yml`) was NOT run locally.

- `npm ci --ignore-scripts`: ok.
- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 168 test files, 0 failures (core 39, rpc 8, web-member 31, app 45, cli 43, site 2).
- `npm run demo`: DEMO OK.
- `node packages/core/test/peek.test.js`: 32 tests, 923 asserts, all pass.
- `node packages/web-member/test/peek.test.js`: 34 tests, about 335 asserts, all pass (the assert count of these network tests moves by a few between runs because of polling waits).
- `node packages/web-member/test/peek-repost.test.js`: 9 tests, 69 asserts, all pass.
- `node packages/web-member/test/frame-guard-client.test.js`: 8 tests, 34 asserts, all pass.
- `node packages/web-member/test/peek-capacity.test.js`: 1 test, 43 asserts, passes.
- `node apps/app/test/peek.test.js`: 14 tests, 76 asserts, all pass.
- Regression proofs: in `packages/core/test/peek.test.js`, "hiding a diary changes nothing but the returned items" generates 200 page configurations and checks, for every diary key in both cases, that `buildPeekPage({ hidden })` returns the same `needs` and `next` as without `hidden` and the same items minus that diary's; dropping the hidden diary before the page is cut instead makes it fail (620 mismatching pages, 29/32 tests). In `packages/web-member/test/peek.test.js`, "regression: the own diary is still requested over the peek link as cover" fails on the first version of this change, which left the own diary out of the candidates (33/34), and passes now; the two tests on the author's and another member's pages pass on both.
- Reviews: one grok pass on the core change (its only finding, the web-member caller, was fixed in the next task as planned), then codex and grok passes on the web-member and app changes and on the docs, with no defects.

### Security audit

- Auditors: Claude (opus, with the audit brief), Claude built-in security review, GPT (gpt-6-astra) and Grok (grok-4.7).
- No open findings.
- Design note: the own diary is fetched and paged exactly as if shown, so the requests on the peek link do not depend on who is reading (see `docs/protocol.md` section 6).

### Human verification (none performed yet)

- [ ] Hosted web, seeder log at debug: opening the Espiadinha requests the own diary's core like any other diary.
- [ ] Hosted web: a reply by the signed-in person appears in A Rua and not in their Espiadinha rounds, also after 'atualizar'.
- [ ] A second passkey that does not follow them sees that reply and their repost in its Espiadinha.
- [ ] A stranger's repost of the person's post still shows to the person.
- [ ] A lone member sees 'Ninguém para espiar ainda'.

## 35. Menções e avisos de resposta, citação e menção (2026-10-28)

### Summary

- Shipped: `@nome` mentions in the text of a post, and notices in the Avisos tab when someone replies to, quotes or mentions the member, next to the follow notices of section 20. The row opens the conversation of that post. In-app only, hosted web only, never a count, no push.
- Contract: `@varanda/rpc` exports `findMentions`, `mentionTokens`, `mentionSegments`, `activeMention` and `MENTION_MAX` (`packages/rpc/lib/mentions.js`, `docs/rpc.md` section 12); `notices.list` (`docs/rpc.md` 5.28) gains `kind` on each notice, `activity` on the result and a three-key cursor `{ at, key, seq }`, with no new param; the channel `'varanda/notices/2'` (`docs/protocol.md`, "Notices channel v2"); the browser read (`docs/protocol.md`, "Notices link"). No record change (a post gains no key, protocol section 2) and no new RPC method. `NOTICE_KINDS` lives in `@varanda/core` (`packages/core/lib/notices-v2.js`), not in `@varanda/rpc`.
- Files: `packages/rpc/lib/mentions.js`, `packages/rpc/index.js`, `packages/rpc/lib/methods.js`; `packages/core/lib/notices-v2.js` (the v2 messages and proof), `packages/core/lib/notices-net.js` (`attachNoticesV2`, slot `_varandaNoticesV2`), `packages/core/lib/post-notices.js` (the post index), `packages/core/lib/username.js` (`heldUsernames`, `MAX_HELD_USERNAMES`), `packages/core/lib/seeder.js` (fold in `_runScan`, v2 page in `_attachPeer`); `packages/web-member/lib/notices.js`, `member-ops.js` (`ownNoticeContext`) and `session.js`; `apps/app/src/mentions.js`, `apps/app/src/notices.js`, `apps/app/src/ui/MentionText.js`, `apps/app/src/ui/MentionSuggest.js`, `apps/app/src/ui/PostRow.js`, `apps/app/src/ui/QuoteCard.js`, `apps/app/src/screens/Avisos.js`, `Publicar.js`, `Conversa.js`, `Membro.js`, `ARua.js`, `Diario.js`, `Espiadinha.js`, `Busca.js` and `apps/app/App.js` (`openMention`).
- Trust model: the seeder is not trusted for facts or for kinds. A v2 item is `{ key, seq, at, kind }` and `kind` is a hint only. The browser re-reads the named signed block from the author's diary (block 0 gate, then the block `seq` with the claimed `at`) and derives the kind itself from the signed post and its own diary: a reply to or a quote of one of the member's own post blocks, else an `@nome` in the signed text naming a username the own diary verifiably held (current revoked issuers applied on every read). A post that earns none is dropped. A seeder can withhold a notice, never forge one or change its kind. A v1 proof cannot open v2 pages (different proof prefix).
- Mentions fail closed: invisible characters are looked past, and the visible neighbour must be one of an allowlist of separators, otherwise the token is not a mention (a missed link, never a wrong notice).
- Data flows: the post index is in memory only, separate from the follow index, rebuilt from block 1 on every serve and at start. Nothing new is stored on the device; the seen tokens are unchanged. The `@` suggestions in Publicar send the typed fragment (2 or more characters, 400 ms debounce) to the seeder's account search (`/index/search/<segment>`), as the Buscar field already does, so the association's seeder can see which names a member starts to mention, even in a draft that is never published.

### Limits

- Constants: `MENTION_MAX` 8 names per post; `MAX_POST_NOTICES_PER_PAIR` 32; `MAX_POST_NOTICES_PER_AUTHOR` 1024; `POST_NOTICES_MAX_EDGES` 262144; `MAX_UNRESOLVED_TOKENS_PER_AUTHOR` 64 (distinct unresolved targets); `MAX_HELD_USERNAMES` 64 (the newest username records of an author, per seeder and per reader); future rule 24 h (`MAX_FUTURE_MS`); page 30 / 64; `MAX_NOTICES_MESSAGE` 16384. Authors are bounded by the seeder's `maxServed`. @ suggestions: 5 rows, queries of 2 or more characters.
- What evicts and what marks incomplete: the per-pair and per-author caps evict the author's own lowest-seq post whole and do NOT mark pages incomplete. The global edge cap refuses the new row and marks pages incomplete (never evicting another author). Unresolved targets beyond 64 per author are skipped silently. An author refused at `maxAuthors`, or a refusal the bounded set cannot record, keeps pages incomplete (sticky until `removeAuthor` or a restart).
- Worst case of one `notices.list` page (64 notices, with the widest avatar): 61751 bytes against `MAX_MESSAGE` 262144 (`node packages/rpc/test/sizes.test.js`).
- Capacity: a read is still one extra external socket (two channels on it), like a peek; a busy seeder can refuse it.
- Known limit: a self-mention folded before the author's own username record settles can still evict that author's older rows inside the author's own budget; it never touches another author's rows, and the row is dropped once the name is verified.
- Known limit: a mention next to an unlisted character (a letter, mark or digit of any script, or another `@`) is not linked and does not notify (fail closed).
- Known limit: a seeder from before v2 serves follow rows only; the tab says so (`activity: false`). Native, `varanda-serve` and the CLI show the web-only text.
- Human checks are not done yet (below).

### Automated tests

New test files, one per area:

- `packages/rpc/test/mentions.test.js`: the grammar, the boundaries (separator allowlist, skipped invisible characters), `MENTION_MAX`, `mentionSegments`, `activeMention`.
- `packages/core/test/notices-v2.test.js`: v2 messages, proof prefix, cursors, items, hostile input.
- `packages/core/test/username.test.js`: `heldUsernames` and `MAX_HELD_USERNAMES`.
- `packages/core/test/post-notices.test.js`: the post index (priority, caps, unresolved targets, name window, self-mentions, whole-post eviction, sticky incomplete, 24 h rule).
- `packages/web-member/test/post-notices.test.js`: the browser read of reply, quote and mention notices over v2 (kind derived from the signed block, v1 fallback with `activity: false`, cursors).
- `packages/web-member/test/post-notices-e2e.test.js`: seeder and browser node end to end on the loopback DHT.
- `apps/cli/test/seeder-post-notices.test.js`: the seeder's fold and the v2 pages.
- `apps/app/test/mentions.test.js`: `insertMention` and `suggestionRows`.

Extended: `packages/core/test/notices.test.js`, `packages/core/test/session.test.js`, `packages/rpc/test/methods.test.js`, `packages/rpc/test/sizes.test.js`, `packages/web-member/test/notices.test.js`, `apps/app/test/notices.test.js`, `apps/cli/test/seeder-index.test.js`, `apps/cli/test/seeder-topic.test.js`.

No browser pass in CI: there is no component harness, so the screens (Avisos rows, the suggestion strip, the tappable `@nome`) are covered only by the pure helper tests and the checklist below. The final CI result (lint, tests, demo) is the orchestrator's and is not repeated here.

### Human verification

None of these was performed for this change. Use two hosted accounts, A and B, in two browsers against a seeder with the change.

- [ ] Publicar, hosted web, online: typing `@` and 2 letters shows the suggestion strip with up to 5 verified members; tapping one writes `@nome ` at the caret without a double space. Offline, on native and with the sheet closed there is no strip.
- [ ] A publishes a post that says `@b`. In A Rua, in Conversa and in a quote card, `@b` is a link; tapping it (and Enter or Space from the keyboard) opens B's profile and does NOT open the thread. A tap on the rest of the text still opens the thread.
- [ ] Tapping a name that nobody holds shows the not-found message; offline it says "Sem conexão para abrir o @nome."
- [ ] B (page visible, or after opening the app) sees the dot on Avisos with no number; the row says "<A> mencionou você"; tapping it opens the conversation.
- [ ] A replies to a post of B: the row says "<A> respondeu à sua publicação". A quotes it: "<A> citou sua publicação". A post that replies and mentions B shows one row, as a reply.
- [ ] B follows A back from the follow row: the follow row leaves, the reply, quote and mention rows of A stay.
- [ ] B renames to another @nome; a later post of A that mentions the OLD name still notifies B.
- [ ] A mentions A's own name: no notice for A. A text like `x@b` or `@b1é` is not linked and notifies nobody.
- [ ] The operator blocks A: A's rows are gone on B's next load.
- [ ] Nowhere in the app is there a count of mentions, replies or followers.
- [ ] Native app and `varanda-serve`: the Avisos tab shows the web-only text, mentions are plain text, no `notices.list` call.
- [ ] A seeder with only `varanda/notices/1`: the follow rows show and the quiet line "O semeador desta associação ainda só envia avisos de quem seguiu você." appears.
- [ ] The seeder log shows no new route, no key and no text of a post.

## 36. A Rua com diários seguidos ainda incompletos (2026-10-28)

### Summary

- User report (screenshot): A Rua ended with "Isso é tudo por enquanto." right after a post from "ontem", while older posts of people they follow were missing. Owner's decisions: download followed diaries in order; `feed.read` reports the followed diaries that are still incomplete; A Rua shows a syncing footer instead of the end and loads more when the sync advances. Starvation (reads preempting the sync run, `discardRegate`, the run-start purge) is out of scope.
- Cause: followed replicas (and the browser node's own-diary recovery range) were downloaded with `core.download({ start: 0, end: -1 })`, which starts at a random offset, while `readAll` reads only `0..contiguousLength-1`. Stored blocks after the first gap were invisible and a short page looked like the end of the feed. Reproduced before the change with a scratch script (not in the repo): a 400-block followed diary, sync stopped mid-download, held 240 blocks of which 7 were contiguous, and `feed.read` showed 4 posts; with `linear: true` every stored block was contiguous and every stored post showed.
- Ordered downloads: `linear: true` in `packages/web-member/lib/sync.js` (follow range and own-diary recovery range) and `packages/core/lib/sync.js` (follow range). Seeder ranges are unchanged.
- `feed.read` (docs/rpc.md 5.13): new `incomplete` and `incompleteTruncated`, capped at `FEED_INCOMPLETE_MAX` = 16 (the 31-item worst case is 261,964 bytes, 180 under `MAX_MESSAGE`). Listed: shown followed diaries whose replica has `length > contiguousLength`, in follow order; a follow with no local replica stays `no-cert` in `skipped` and is not listed. Same rule on the core and browser nodes; the CLI `feed` is unchanged.
- A Rua (`apps/app/src/screens/ARua.js`, `apps/app/src/paging.js`): the footer says "Ainda sincronizando quem você segue." instead of "Isso é tudo por enquanto." while the last page reported incomplete diaries; `atEnd`, 'mostrar mais' and the end-reached load are unchanged; an empty older page keeps the cursor. When the downloaded length of a listed diary, or of a follow skipped as `no-cert`, grows past the lengths seen before the last read, one timer (`FEED_REARM_MS` = 2 s) runs exactly one `feed.read`: a quiet re-read of the newest page when only it is loaded (no pull spinner, no 'ver novidades' acknowledgement, no other request; if the new page would cut rows already shown, the list stays and leaves its end so 'mostrar mais' pages on), otherwise an older page. Empty automatic older reads back off (2 s doubling to 32 s). No automatic read follows a failed read; the footer retry repeats the read that failed. A capped `skipped` or `incomplete` list makes growth of any key count.

### Automated (CI)

CI result on the final tree (rebased on main 17ec1d8, after the mentions PR), Node v24.22.1 (run from the worktree root). Node 20 (the other version in `.github/workflows/ci.yml`) was NOT run locally.

- `npm ci --ignore-scripts`: ok.
- `npm run lint`: clean (`standard`), exit 0.
- `npm test` (all workspaces): 177 test files, 0 failures (core 42, rpc 10, web-member 33, app 46, cli 44, site 2).
- `npm run demo`: DEMO OK.
- `node packages/rpc/test/sizes.test.js`: 13 tests, 78 asserts, all pass (the `feed.read` worst case is unchanged by the mentions PR).
- `node packages/core/test/sync.test.js`: 42 tests, 239 asserts, all pass.
- `node packages/core/test/member.test.js`: 11 tests, 132 asserts, all pass.
- `node packages/core/test/session.test.js`: 29 tests, 350 asserts, all pass.
- `node packages/web-member/test/sync-gate.test.js`: 5 tests, 53 asserts, all pass.
- `node packages/web-member/test/session.test.js`: 26 tests, 327 asserts, all pass.
- `node apps/app/test/paging.test.js`: 10 tests, 89 asserts, all pass.
- New tests: core `sync.test.js` "a follower downloads a followed diary in block order" (the in-test fake seeder gains an optional `have`, so a peer that connects later learns about a diary it already holds); web-member `sync-gate.test.js` "a followed diary downloads in block order so its prefix is readable"; core `member.test.js` "feedRead reports a shown diary with holes as incomplete"; core `session.test.js` "feed.read caps the incomplete list at FEED_INCOMPLETE_MAX"; web-member `session.test.js` "feed.read reports incomplete followed diaries until their full download" and "feed.read caps incomplete followed diaries in follow-list order"; app `paging.test.js` "feed footer says syncing only while the last page reported incomplete diaries", "sync baseline covers incomplete and no-cert follows, plus every length when truncated", "sync advances only on growth past the baseline", "a capped skipped or incomplete list opens the trigger to every key", "only a short newest page replaces the list quietly" and "empty automatic reads back off with a capped delay". `sizes.test.js` adds the two fields to the `feed.read` worst case.
- The ordering tests replace `Math.random` during the follower's run with a seeded generator in 0.4..0.6 (HyperDHT draws stream ids from `Math.random` and retries on a collision, so a constant could loop), which puts a random-order range far from block 0. In-flight requests complete out of order (0, 1, 2, 4, 8, ... was observed), so they check that the first 32 distinct uploaded blocks are below 64 (and include 0 to 3 on the browser node) and that the follower stored every block.
- Regression proofs: without `linear: true` on the follow range both ordering tests fail (core 41/42, web-member 4/5). Without the `incomplete` push the new `feed.read` tests fail (core member 10/11, core session 28/29, web-member session 24/26). The new paging tests fail without the paging helpers, without counting `skippedTruncated`, and without the shown-rows rule for quiet replacement.
- Reviews: every task by a vendor other than its author (GPT, Grok or Claude). A Rua took three review-fix rounds: the first "settle" rule could hide a diary's later posts and became the backoff; the automatic newest-page read behaved like a pull-to-refresh and became the quiet read with its footer retry; capped `skipped` lists, a full page that would cut shown rows, and an empty list were then handled.

### Security audit

- Auditors: Claude (opus, with the audit brief), Claude built-in security review, GPT (gpt-6-astra) and Grok (grok-4.7).
- One low finding (automatic reads kept repeating while a full newest page left the list unchanged), fixed by leaving the end in that case. No open findings.

### Human verification (none performed yet)

Check the hosted web (browser node) and the native app (core node) separately.

- [ ] A partially synced follow: after a short page the footer reads "Ainda sincronizando quem você segue.".
- [ ] The list fills without pull-to-refresh as the follow downloads; on native no pull spinner appears.
- [ ] A fully synced follow: the footer reads "Isso é tudo por enquanto." as before.
- [ ] With an empty feed and a follow still syncing, "Ainda não chegou nada" carries "Ainda sincronizando quem você segue."; once synced, the old body returns.
- [ ] Pull to refresh right after the diary grows: no second read follows the manual one.
- [ ] 'mostrar mais' still pages 30 then 31 items.
- [ ] Follow a diary with hundreds of posts, keep A Rua open at the end of the list, and confirm the download finishes (every automatic read preempts the sync run).

### Limits

- Every automatic read preempts the sync run, which restarts; `FEED_REARM_MS` (2 s) is a starting value to tune after the check above.
- A download usually costs one extra read at its end, because the stopped run reports growth the read already saw.
- A follow with no local replica is not reported, so a follow nobody serves keeps the old footer; an author who signs a length nobody serves keeps the syncing footer.
- Arrivals that sort inside the range already shown come through 'ver novidades' or pull-to-refresh; once the download ends the footer can say "Isso é tudo por enquanto." while such arrivals wait behind the pill.
- An empty feed shows "Ainda sincronizando quem você segue." as the body of "Ainda não chegou nada" while followed diaries sync.
- `withStore`/`stopRun` preemption, `discardRegate` and the run-start purge are unchanged.

## 37. Convites para entrar na rede (2026-10-29)

### O que mudou

- Com `VARANDA_INVITES_PER_WEEK` definido (1 a 100), um vínculo Google que criaria um membro novo só termina com um convite válido. Ausente ou vazio, o cadastro segue aberto como hoje, limitado só por `VARANDA_MAX_MEMBERS`. Remover a variável desliga tudo e o `invites.json` fica no disco, ignorado. Mudar o valor exige reiniciar o serviço `account`.
- O link é `https://<origem>/convite/<código>`. O código tem 32 bytes em base64url, aparece uma única vez e fica guardado só como SHA-256, e só enquanto o convite não foi usado. Vale para uma pessoa só e por 7 dias depois de criado.
- Cada membro vinculado ganha N convites por semana civil de Brasília (UTC-3, sem horário de verão), com renovação na segunda 00:00. Um convite criado conta na semana em que foi criado, mesmo sem uso. O que sobra não acumula, não há revogação nem devolução, e baixar N não apaga links já criados na semana. Todos seguem N, o operador também, e não existe comando de emissão. A primeira pessoa de uma rede vazia precisa vincular com a variável vazia, sem exceção. `varanda assoc certify` fica fora do portão: um membro só certificado não é vinculado, logo não emite convite.
- Uso único estrito: o serviço de conta grava o hash do convite (SHA-256 do código) no vínculo de quem entrou, no diretório (`directory.json` e seu diário, o armazenamento de um só escritor), e esse registro recusa um segundo uso de forma atômica. O `invites.json` apaga o hash quando o convite é usado e guarda só o identificador aleatório, a chave de quem criou, a data de criação e se foi usado. Uma conclusão recusada deixa o convite utilizável. Uma recusa na conclusão por @nome em uso ou conta já vinculada também apaga a linha pendente e libera o convite na hora, para a pessoa recomeçar.
- O serviço nunca guarda e-mail, nome, `sub` ou chave de quem entrou, e não registra quem usou qual convite. A volta do Google recusa um convite inválido antes de trocar o código do Google, como a lista de espera.
- Rotas: `GET /account/invites/policy` (`{ required, perWeek }`), `POST /account/invites/start`, `POST /account/invites/finish` (assinatura `invite.sign`, `docs/rpc.md` 5.30, a resposta traz `used`, `remaining` e `resetsAt`). `GET /account/status` não traz contagens de convite. Sem a variável, a política responde `{ "required": false }` e as rotas `POST` de convite respondem 404. Recusas: `convite-obrigatorio` (403), `convite-invalido` (404), `limite-convites` (429) e `indisponivel`. `varanda account status` imprime só `convites: <total> (<usados> usados)`.
- App (web hospedada): `/convite/<código>` guarda o código na aba (`sessionStorage`, chave `varanda-signup-invite`), limpa o endereço e mostra o botão do Google; sem código, a tela calma pede o link de convite. Ajustes › Convidar pessoas aparece só na web hospedada, só com o portão ligado e só para membro vinculado: quantos convites pode criar por semana (da política), depois de criar quantos restam (da resposta assinada), criar, copiar ou compartilhar, link mostrado uma vez e renovação na segunda em Brasília. O código não é enviado ao Google.
- LGPD: `docs/design.md` ganhou a linha do `invites.json`, a nota de que o vínculo de quem entrou por convite guarda o hash do convite (dado novo no diretório) e a nota de que quem convidou quem pode ser reconstruído a partir de uma cópia do `invites.json` anterior ao uso e, de forma aproximada, pelas datas.

### Testes automatizados

Nenhum foi rodado por quem escreveu esta seção; o resultado de lint, testes e demo é o da CI. Por arquivo:

- `apps/cli/test/invites-store.test.js`: o armazenamento de `invites.json` (semana de Brasília, limite por membro, validade de 7 dias, poda, arquivo inválido, modo 0600).
- `packages/core/test/invite.test.js`: a mensagem e a assinatura de `invite.sign`.
- `apps/cli/test/account-invites.test.js`: as rotas de política, início e conclusão, as recusas, o portão do vínculo e a regressão de que `GET /account/status` nunca traz contagens de convite, com `invites.json` íntegro ou corrompido.
- `apps/cli/test/account-invites-cli.test.js`: a leitura da variável (`readEnv`), a perda do lock e `varanda account status`. O reinício com e sem a variável é coberto no próprio processo por `account-e2e.test.js`.
- `apps/cli/test/account-store.test.js` (estendido): o hash do convite no vínculo e a recusa atômica de um segundo uso.
- `apps/cli/test/deploy.test.js` (estendido): a variável no `.env.example`, no compose e no `deploy.sh`.
- `packages/rpc/test/methods.test.js` (estendido): o método `invite.sign`.
- `packages/core/test/session.test.js` e `packages/web-member/test/session.test.js` (estendidos): `invite.sign` nas duas sessões.
- `apps/app/test/account.test.js` (estendido): política, início e conclusão.
- `apps/app/test/signupInvite.test.js`: o caminho `/convite`, a guarda na aba, o prazo, a limpeza do endereço e os textos da contagem e do número semanal.
- `apps/app/test/help.test.js` (estendido): a folha de ajuda dos convites.
- `apps/cli/test/account-e2e.test.js` (estendido): o fluxo completo com convite.

Sem teste de navegador na CI: as telas (Convidar pessoas, a tela calma) só têm os testes de funções puras e a lista abaixo.

### Verificação humana

Nada abaixo foi feito ainda. Use uma instalação hospedada com o serviço `account` e o Google configurados.

- [ ] Sem `VARANDA_INVITES_PER_WEEK`, um vínculo novo termina normalmente (cadastro aberto) e Ajustes não mostra Convidar pessoas.
- [ ] Com `VARANDA_INVITES_PER_WEEK=1`, uma pessoa sem link que tenta vincular vê a tela calma, e o `docker logs` do serviço mostra só tokens, nunca um código, um e-mail ou uma chave.
- [ ] Um membro vinculado abre Ajustes › Convidar pessoas, vê "Você pode criar até 1 convite por semana.", cria o link, copia e compartilha. O link aparece uma vez; depois de criado, aparece "Seus convites desta semana acabaram." e o botão fica desativado.
- [ ] Abrir `/convite/<código>` troca o endereço para `/` e o botão do Google aparece. O vínculo termina e a pessoa passa a ser membro.
- [ ] O mesmo código não vincula uma segunda chave (recusa calma), e uma recusa na conclusão deixa o convite utilizável.
- [ ] Na fronteira da segunda-feira, 03:00Z, a contagem renova e os convites sem uso da semana anterior não acumulam.
- [ ] `varanda account status` mostra `convites: <total> (<usados> usados)` e nenhum código.
- [ ] Remover a variável e reiniciar volta ao cadastro aberto, e o `invites.json` continua no disco.

### Limites

- Uma queda ou perda do lock do serviço bem no meio da criação de um convite pode gastar aquele convite da semana sem entregar o link (o código só existe na resposta).
- Um erro passageiro de leitura do `invites.json` deixa os convites indisponíveis até reiniciar o serviço (mesmo comportamento do `terms.json`).
- O `invites.json` e o diretório são arquivos separados: uma gravação atrasada de um processo que perdeu o lock pode desfazer a contagem da semana (resíduo do gravador atrasado, como em `terms-store.js`). O uso único não depende disso, porque o diretório registra o convite usado no vínculo.
- Em navegação privada que recusa o armazenamento da aba, o código fica só na memória da página e não sobrevive à ida ao Google: se o vínculo não terminar, é preciso abrir o link de novo.
- Uma nova tentativa de início sem assinatura nunca apaga um vínculo pendente que já passou pela assinatura ou pelo Google, a menos que venha do mesmo navegador com o cookie desse vínculo ("começar de novo", "usar outra conta Google"); sem o cookie, o código fica reservado até esse pendente vencer (10 minutos) ou terminar. Uma recusa do convite no início não apaga o código guardado na aba: o formulário continua e a pessoa tenta de novo sem recarregar.
- `varanda assoc certify` fica fora do portão.
- Fechar Ajustes enquanto a criação do convite já foi enviada ao serviço pode gastar o convite sem mostrar o link.
- Quem convidou quem pode ser reconstruído a partir de uma cópia de `invites.json` anterior ao uso e, de forma aproximada, pelas datas. O diretório guarda o hash do convite usado no vínculo de quem entrou (dado novo).
- Não há revogação: um link enviado à pessoa errada admite um membro até vencer (7 dias). Uma resposta de criação perdida gasta a vaga e a única cópia do código.
- O número de convites por semana é público (GET /account/invites/policy); quantos cada membro já criou só aparece para o próprio membro, na resposta assinada de criação.
- Numa instalação com o serviço de conta, o botão de vincular em Conta e @nome espera a leitura da política, que pode levar até 8 segundos (o limite de tempo das chamadas ao serviço). Se a leitura falhar ou passar desse tempo, o formulário de hoje é liberado e o serviço recusa sozinho quem precisar de convite.
- O teto é de 100000 linhas no `invites.json`. A semana segue o relógio do servidor.
- Se um operador ligar depois um log de acesso do Caddy, os códigos ficariam nos caminhos `/convite/<código>`; este deploy não tem log de acesso.

## 38. Avisos push na web hospedada (feat/web-push, 2026-10-29)

A especificação pedia a seção 35. A seção 35 já documenta menções e avisos de resposta, citação e menção (2026-10-28), a 36, A Rua com diários seguidos ainda incompletos, e a 37, Convites para entrar na rede. Esta verificação fica na 38. As seções 1 a 37 não mudam.

O push é outro caminho que a lista de Avisos. A lista (canais `varanda/notices/1` e `varanda/notices/2`) continua dentro do app e inclui citação e menção. O push da web hospedada cobre só seguir, resposta, curtida e republicação.

### O que mudou

- Na versão web hospedada, Ajustes ganha "Avisos no aparelho". A pessoa liga, só neste navegador, quatro avisos: começou a seguir, respondeu ao seu post, curtiu seu post, republicou seu post. Cada um é uma frase com o nome e a ação. Citação, menção e o crescimento de um diário seguido não geram push. O app nativo, o `varanda-serve` e a CLI ficam na lista de Avisos.
- O semeador escolhe o candidato (`packages/core/lib/push-events.js`) e o manda em loopback (`POST /push-event`, `apps/cli/lib/push-relay.js`). O cursor `pushNext` começa no comprimento assinado já guardado (na primeira admissão, o maior entre esse comprimento e o que a quarentena verificou). Reinício, reconstrução de índice e histórico já servido não repetem aviso. O semeador nunca vê a inscrição.
- O serviço de conta (`apps/cli/lib/account/push-routes.js`) oferece `GET /account/push/key`, `POST /account/push/start`, `POST /account/push/finish` e `POST /account/push/check`. A declaração é `varanda-push-v1`, só por HTTPS até o serviço de conta. O `endpoint` tem de ser uma URL `https` canônica, em ASCII imprimível (`isEndpoint` em `packages/core/lib/push-proof.js`, `isPushEndpoint` em `packages/rpc/lib/methods.js`, `endpointParam` na conclusão). A frase é cifrada de ponta a ponta (RFC 8291). O fabricante vê o texto cifrado e o endereço.
- Operação: `account push-key` com o serviço parado (grava `push-vapid.json`, modo 0600, imprime só a chave pública), `VARANDA_PUSH_TOKEN` e `VARANDA_ACCOUNT_HTTP` em `deploy/seeder/.env`. Token vazio desliga. Termos versão 3 (`TERMS_VERSION`). Ligar os avisos pede o aceite dessa versão.
- A página mede o worker com `{ type: 'varanda-push-ping' }`. O worker atual responde `{ source: 'varanda-sw', push: 1 }`. Com um worker antigo, ligar fica bloqueado, com `PUSH_RELOAD`, até fechar todas as janelas; desligar continua permitido. No iOS, o estado é lido quando a folha abre, para o toque chegar em `pushManager.subscribe()` sem outro `await` antes.

### Testes automatizados

Arquivos novos:

- `packages/core/test/push-events.test.js`: candidato (seguir, resposta, curtida, republicação), nunca a si mesmo, só membro, lista de bloqueio, idade de 6 h, nome e forma do evento.
- `packages/core/test/push-proof.test.js`: declaração `varanda-push-v1`, hash do endpoint e URL `https` em ASCII imprimível.
- `apps/cli/test/seeder-push.test.js`: cursor `pushNext`, silêncio do histórico, primeira admissão, reinício e os quatro eventos.
- `apps/cli/test/push-relay.test.js`: `POST /push-event` em loopback, token, fila e perda sem repetir.
- `apps/cli/test/account-push.test.js`: as quatro rotas da conta, o relé, 404 sem token, cifra e 404/410.
- `apps/cli/test/web-push.test.js`: cifra RFC 8291 e a lista de endereços permitidos.
- `apps/cli/test/push-store.test.js`: `push.json`, modo 0600, teto de 4 aparelhos.
- `apps/cli/test/push-text.test.js`: as quatro frases, "Alguém" e `PUSH_BODY_MAX` 120.
- `apps/app/test/push-state.test.js`: rótulos, estado do interruptor, `PUSH_RELOAD` e o aviso aberto pelo toque.
- `apps/cli/test/push-e2e.test.js`: de um registro no diário servido, pelo relé do semeador, a um único `POST` cifrado num serviço de push falso, e todos os caminhos que devem ficar em silêncio.

Arquivos estendidos:

- `packages/core/test/terms.test.js`: `TERMS_VERSION` 3.
- `packages/rpc/test/methods.test.js`: `push.sign` e o endpoint canônico (`href` igual à string, sem porta 443 explícita, sem host em maiúsculas, sem segmentos `.` ou `..`).
- `packages/core/test/session.test.js`: o nó recusa `push.sign` com USAGE.
- `packages/core/test/browser-safe.test.js`: `push-proof.js` entra no pacote do navegador.
- `packages/web-member/test/session.test.js`: `push.sign` com a chave aberta.
- `apps/cli/test/cli.test.js`: `VARANDA_PUSH_TOKEN` e `VARANDA_ACCOUNT_HTTP`.
- `apps/cli/test/caddyfile.test.js`: `push-event` e `push-vapid` não aparecem fora de comentário.
- `apps/cli/test/deploy.test.js`: as duas variáveis no semeador e na conta, não no serviço web.
- `apps/cli/test/account.test.js`: o reparo de `push.json` registrado como `push`, e `pushDevices` no `account export`.
- `apps/app/test/account.test.js`: `GET /account/push/key`, `POST /account/push/start`, `POST /account/push/finish` e `POST /account/push/check`.
- `apps/app/test/sw.test.js`: o aviso, o toque, o ping `varanda-push-ping` e a resposta `{ source: 'varanda-sw', push: 1 }`.
- `apps/app/test/legal.test.js`: `LEGAL_VERSION` 3.

O resultado de lint, dos testes e da demo fica com o orquestrador e não é repetido aqui. Nenhum teste de navegador cobre a linha de Ajustes nem o fluxo de abrir o aviso a partir da notificação (veja Limites).

### Verificação manual

Nenhuma verificação foi feita ainda. Todos os itens abaixo estão desmarcados e não realizada ainda. Marcar só o que for de fato executado, com a saída. Use duas contas hospedadas, A e B, em dois navegadores, com o semeador e o serviço de conta desta mudança, a chave VAPID gerada e `VARANDA_PUSH_TOKEN` definido.

- [ ] No navegador de mesa, em Ajustes, "Avisos no aparelho" aparece desligado. Ligar pede permissão e passa a "Ligados" (não realizada ainda).
- [ ] No PWA instalado no Android, o mesmo controle liga e o sistema mostra o aviso (não realizada ainda).
- [ ] No iPhone ou iPad com iOS 16.4 ou mais novo, com o Varanda na Tela de Início: o primeiro `await` do toque em ligar é `pushManager.subscribe()` (o estado já foi lido ao abrir a folha). A inscrição completa e o aviso do sistema chega (não realizada ainda).
- [ ] Fora da Tela de Início, no iPhone ou iPad, a linha do interruptor não aparece e o texto diz que os avisos só funcionam na Tela de Início (não realizada ainda).
- [ ] Com a conta B, um evento de cada tipo para A: seguir, responder, curtir e republicar. A recebe uma frase de cada, com o nome de B e a ação, sem o texto da publicação e sem citação (não realizada ainda).
- [ ] Tocar no aviso de seguir abre a aba Avisos. Tocar no de resposta, curtida ou republicação abre a Conversa daquela publicação (não realizada ainda).
- [ ] Desligar em Ajustes para os avisos neste navegador. Um evento novo de B não chega neste aparelho (não realizada ainda).
- [ ] "Sair" desliga os avisos deste navegador. Entrar de novo não os religa sozinho (não realizada ainda).
- [ ] Reiniciar o semeador não repete o histórico: os eventos que já estavam no diário não geram aviso de novo (não realizada ainda).
- [ ] Sem `push-vapid.json` (serviço sem chave), a linha "Avisos no aparelho" não aparece (não realizada ainda).
- [ ] Uma citação e uma menção de B aparecem na lista de Avisos e não geram aviso do sistema (não realizada ainda).

### Limites

- Um evento se perde, e não é repetido, enquanto o serviço de conta está fora ou a fila do repasse está cheia (`maxPending` 256 no semeador, `MAX_QUEUE` 512 no serviço). O cursor do semeador já andou.
- Um bloco escrito enquanto o semeador estava fora só vira aviso depois do reinício se o `at` do autor tiver menos de 6 h (`PUSH_MAX_AGE_MS`, só para suprimir). O que já estava guardado ao servir o diário, na primeira admissão, num reinício ou numa reconstrução de índice, não gera aviso.
- Teto de 60 avisos por hora por destinatário (`keyedWindow(60, 3600 * 1000)`, motivo `teto`). Pausa de 600 s para o mesmo autor, destinatário, tipo e `ref` (curtida, republicação e seguir repetidos; `keyedWindow(1, 600 * 1000)`, motivo `descartado`); cada resposta é um aviso próprio, porque a chave leva também o `seq` da resposta.
- No máximo 4 aparelhos por membro (`PUSH_MAX_PER_MEMBER`). O envio só sai para a lista de hosts (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com` e os sufixos `.push.apple.com`, `.push.services.mozilla.com`, `.notify.windows.com`).
- Não há tratamento de `pushsubscriptionchange`. Não há citação nem menção no push. Não há push nativo (APNs e FCM do app continuam fora). Não há aviso quando um diário seguido cresce (o TODO de `packages/core/lib/sync.js`).
- Em `apps/cli/lib/account/push-store.js`, `byDate` compara `createdAt` como texto. Um ISO de ano expandido (`toISOString` fora de 0000 a 9999, no formato `+275760-...`) ordena antes de um ano de quatro dígitos, e o teto pode tratar essa linha como a mais antiga. Uma transferência de `endpoint` para um membro que já tem 4 aparelhos não é recusada: `put` aceita (o comentário de "transferência que não acrescenta membro" vale para `MAX_MEMBERS`) e `cap` descarta a linha mais antiga desse membro.
- Não há teste automatizado no navegador da linha de Ajustes nem do fluxo de abrir o app a partir do aviso. A cobertura é dos módulos puros, do service worker e do roteiro acima.
- Uma resposta, curtida ou republicação cujo post alvo ainda não está legível na réplica do destinatário no semeador (fora do prefixo contíguo, ou uma leitura sem espera que falhou) não vira aviso, e o bloco não é lido de novo (no máximo uma vez).
- Se um envio volta 410 enquanto o mesmo `endpoint` é registrado de novo com chaves novas, a remoção compara as chaves antes de entrar na fila do `push.json`, e uma janela curta ainda pode apagar o registro novo. O navegador costuma gerar outro `endpoint` ao assinar de novo; religar em Ajustes resolve.
- Ao ligar, um cancelamento local que passa de 5 s (`UNSUBSCRIBE_MS`) é dado como não confirmado; o navegador ainda pode concluí-lo depois.
- A limpeza de Sair e Recomeçar não espera uma troca do interruptor em andamento, e o interruptor continua tocável durante ela: ligar os avisos de novo no meio de Sair pode deixar a nova inscrição ativa.
- Todo aviso é preenchido até 1024 bytes antes de cifrar (`PUSH_PAD_TO`, preenchimento do RFC 8188), então o tamanho não mostra o tipo nem o nome. Mas a entrega é imediata: o serviço de push do navegador vê o momento de cada aviso e pode cruzá-lo com os registros públicos dos diários. Não há atraso artificial, por escolha: um atraso deixaria todo aviso mais lento.
- Os caminhos de `apps/app/src/screens/Identidade.js` que trocam a identidade guardada ("apagar e recomeçar" quando a identidade não confere, "criar mesmo assim") não chamam `disablePush`. Num aparelho compartilhado, a inscrição do navegador pode continuar recebendo os avisos da identidade anterior até ser desligada ou até o serviço de push descartá-la (não confirmado de ponta a ponta).

## 39. Abertura do app: splash e cartões (feat/app-startup, 2026-10-29)

As seções 1 a 38 não mudam. Esta seção documenta a primeira parte da abertura do app (PR A): a marca animada e os três cartões de apresentação antes dos Termos.

### O que mudou

- Splash animado (`apps/app/src/ui/Splash.js`): a cadeira (`assets/cadeira.png`) aparece com efeito de fade e escala, junto com a palavra "Varanda" e "conectando…", sobre o fundo `#fbf8f3`, o mesmo das telas de abertura nativas e da página web. Respeita "reduzir movimento". Substitui o splash só com texto que aparecia enquanto o registro dos Termos carregava e enquanto o nó conectava.
- Cartões de apresentação (`apps/app/src/screens/Introducao.js`, lógica em `apps/app/src/intro.js`): três cartões, mostrados uma vez por aparelho, antes do portão dos Termos. Botões Pular, Voltar, Próximo e Começar. Na web, deslizar, os botões e as setas do teclado; na tela nativa, deslizar e os botões. Cada cartão é anunciado para leitor de tela.
- Registro do aparelho: `varanda-intro` no `localStorage` (web, `introStore.web.js`) ou `varanda-intro.json` na pasta de documentos do app (nativo, `introStore.native.js`). Guarda só `{ v, seenVersion, at }`. É apresentação: não é aceite dos Termos nem de nada.
- Não há telemetria e não há dependência nova. As telas de abertura nativas (`ios/` e `android/`) não mudam.

### Testes automatizados

- `node apps/app/test/intro.test.js`: validação do registro (formato, versão, data), a decisão de mostrar ou não (carregando tem prioridade, versão nova mostra de novo), o registro novo, os três cartões congelados e a ida e volta do armazenamento web (o nativo copia `termsStore.native.js` e fica na verificação manual).

Esses testes cobrem os módulos puros e o armazenamento. Não cobrem a animação, a tela nem a ordem de carga no app: essa parte está na lista abaixo.

### Verificação manual

Nenhuma verificação manual foi feita ainda. Todos os itens estão em aberto:

1. [ ] Primeira carga em aparelho novo: aparecem o splash, depois os três cartões, depois os Termos (não realizada ainda).
2. [ ] Recarregar depois de Começar: os cartões não aparecem de novo (não realizada ainda).
3. [ ] Pular no primeiro ou no segundo cartão (o último só tem Começar): vai direto para os Termos e não aparece de novo na recarga (não realizada ainda).
4. [ ] Armazenamento recusado (navegador em modo privado): os cartões voltam a cada carga, e Pular continua funcionando (não realizada ainda).
5. [ ] "Reduzir movimento" ligado no sistema: o splash não anima e os cartões trocam sem movimento (não realizada ainda).
6. [ ] Web em celular estreito e em desktop largo: sem rolagem horizontal, botões acessíveis, cartões legíveis (não realizada ainda).
7. [ ] iOS (app nativo): splash, cartões e Termos na ordem certa, e o arquivo `varanda-intro.json` aparece depois de Começar (não realizada ainda).
8. [ ] Android (app nativo): o mesmo roteiro do iOS (não realizada ainda).
9. [ ] Volta do Google (`?conta=` na URL): os cartões não aparecem, e o registro não é marcado como visto (não realizada ainda).
10. [ ] Aparelho novo abrindo `/convite/<código>`: os cartões aparecem antes, e depois de Começar o convite continua na tela de entrada (não realizada ainda).
11. [ ] Aparelho novo abrindo `/@nome`: os cartões aparecem antes, e depois de Começar o perfil continua aberto (não realizada ainda).
12. [ ] Leitor de tela (VoiceOver ou TalkBack, ou leitor do navegador): cada cartão é anunciado ao trocar (não realizada ainda).

### Limites

- O registro vale por aparelho, não por conta. Quem usa outra conta no mesmo aparelho não vê os cartões de novo.
- Sem armazenamento (modo privado ou dados bloqueados), os cartões voltam a cada carga. Pular continua funcionando na mesma carga.
- Quem abre `/@nome` ou `/convite/<código>` pela primeira vez no aparelho vê os cartões antes do destino. O link é mantido enquanto os cartões estão na tela, e a checagem 10 e 11 confirma que ele não se perde.
- A volta do Google (`?conta=`) pula os cartões nessa carga e não os marca como vistos, então eles podem aparecer na próxima abertura normal.
- Os cartões são de apresentação. Não dizem nada sobre os Termos, e o texto deles não substitui o aceite.

## 40. Verificação de idade na web hospedada (feat/hosted-age-verification, 2026-10-29)

As seções 1 a 39 não mudam. Esta seção documenta o PR B: a verificação de idade com a Didit para quem usa a web hospedada. Idade mínima 16.

### O que mudou

- Declaração assinada `varanda-age-v1` (`packages/core/lib/age.js`) e método RPC `age.sign` (`docs/rpc.md` §5.32), só no nó do navegador.
- Cliente da Didit (`apps/cli/lib/account/didit.js`): cria a sessão, lê a decisão e apaga a sessão. A decisão por rosto vale pela MENOR estimativa aprovada; abaixo de 21 anos pede o documento, e só o documento recusa (menos de 16).
- Sidecar `age.json` (`apps/cli/lib/account/age-store.js`, modo 0600, volume `account-data`): por chave do membro, só a faixa (`16-17` ou `18+`), o método `didit` e a data.
- Rotas (`apps/cli/lib/account/age-routes.js`): `GET /account/age/policy` e `POST /account/age/start|session|result`. Pedidos simultâneos de sessão dividem uma só sessão paga. Sem `age.json` disponível, nenhuma sessão é criada. A sessão que expira (24 h) ou é substituída é apagada na Didit. Limites de sessões pagas: 3 por membro em 24 h e, para chaves ainda sem vínculo, 3 por código de convite em 24 h (`limite-idade`, 429); teto diário `VARANDA_DIDIT_DAILY_LIMIT` (padrão 200), contado à parte para chaves novas e para membros já vinculados, que respondem `indisponivel` (503) quando cheio. Chaves sem vínculo e sem convite, com convites ligados, recebem `convite-obrigatorio`.
- Portões no `server.js`: `idade-pendente` (403) em `/account/authorize`, `/account/finish`, `/account/rename/finish` e `/account/invites/finish` enquanto a verificação estiver ligada, sempre depois de conferir a assinatura (as rotas `start` sem assinatura não revelam se uma chave já verificou).
- App: tela "Confirme sua idade" (`apps/app/src/screens/Idade.js`, lógica em `apps/app/src/age.js`) para toda pessoa da web hospedada, inclusive quem já tinha conta; antes do vínculo Google. A volta é `/?idade=volta`; `verificationSessionId` e `status` na URL são ignorados. Falha vira "verificação necessária".
- Termos e Política versão 4 (novo aceite para todos).
- Variáveis: `VARANDA_DIDIT_API_KEY`, `VARANDA_DIDIT_WORKFLOW_ID` (as duas definidas ligam; as duas vazias desligam; uma só é erro de uso) e `VARANDA_DIDIT_DAILY_LIMIT`. A chave precisa de `read:sessions` e `delete:sessions` e não pode ser restrita (README, "Verificação de idade").

### Testes automatizados

- `node packages/core/test/age.test.js`
- `node apps/cli/test/didit.test.js`
- `node apps/cli/test/age-store.test.js`
- `node apps/cli/test/account-age.test.js`
- `node apps/cli/test/account-age-e2e.test.js`
- `node apps/app/test/age.test.js`
- `node apps/app/test/onboarding.test.js`
- `node apps/app/test/account.test.js`

Todos usam servidores falsos em `127.0.0.1`, sem rede externa. Não cobrem a Didit real, a tela no navegador nem o modelo de idade do parceiro: isso está na lista abaixo.

### Verificação manual

Nenhuma verificação manual foi feita ainda. Todos os itens estão em aberto:

1. [ ] Recurso desligado (sem as duas variáveis): nada muda, o passo não aparece e o serviço registra isso na partida (não realizada ainda).
2. [ ] Teste de fumaça no sandbox da Didit, com os dois `curl` do README, antes de ligar em produção (não realizada ainda).
3. [ ] Membro novo de ponta a ponta: Entrar, "Confirme sua idade", Didit, volta, @nome, Google, certificado (não realizada ainda).
4. [ ] Membro já vinculado: fica bloqueado em "Confirme sua idade" e é liberado depois de passar (não realizada ainda).
5. [ ] Menor de 16 pelo documento: recusado, sem acesso (não realizada ainda).
6. [ ] Rosto inconclusivo, depois documento: o fluxo segue para o documento e termina bem (não realizada ainda).
7. [ ] Revisão pendente, depois aprovada: o estado "pendente" some quando a Didit aprova (não realizada ainda).
8. [ ] Reiniciar o serviço `account` com a sessão pendente: a pessoa recomeça e o app não trava (não realizada ainda).
9. [ ] Teto diário atingido: aparece "serviço indisponível" (503) para chaves novas, um membro já vinculado ainda consegue a sessão, e no dia seguinte tudo volta a funcionar (não realizada ainda).
10. [ ] Volta forjada, com `?idade=volta&status=Approved` sem ter passado: continua bloqueado (não realizada ainda).
11. [ ] Abrir o app hospedado sem rede: fica bloqueado até conseguir consultar o serviço de conta (não realizada ainda).
12. [ ] Console da Didit: retenção mínima definida e exclusão da sessão confirmada depois da decisão (não realizada ainda).
13. [ ] Parecer jurídico sobre os textos da versão 4 dos Termos e da Política e sobre a idade mínima de 16 (não realizada ainda).

### Limites

- As sessões pendentes ficam só na memória: reiniciar pede para começar de novo.
- A faixa não entra no certificado (v2 continua `unchecked`). A camada P2P ainda admite um certificado existente (`docs/protocol.md`), então um cliente antigo ou modificado não é bloqueado pela rede, só pelo app e pelo serviço de conta.
- Não há o modo restritivo de 16 e 17 anos (#74).
- O resultado depende do modelo do parceiro.
- A exclusão na Didit é pedida logo após a decisão, com novas tentativas só em memória.
- Sem as variáveis, ninguém é verificado (só para desenvolvimento e demo).
- Aberto offline, o app hospedado fica bloqueado até conseguir consultar o serviço de conta.
- Uma faixa fica guardada para uma chave que fez a verificação e não concluiu o vínculo.
- A verificação prova a idade de quem terminou a página da Didit, não de quem tem a passkey: o endereço da sessão pode ser repassado, e um adulto pode fazer a selfie no lugar de um menor (no mesmo aparelho ou em outro). Prender a sessão ao aparelho não fecha isso; é uma questão de produto e de parecer (#39, #82).
- Um membro que já tinha certificado é bloqueado pelo app e pelo serviço de conta, mas um cliente modificado ainda publica e sincroniza, porque os semeadores não conferem a faixa (#68).

## 41. Apagar publicações e versões do perfil (PR feat/delete-posts, 2026-10-29)

### O que mudou

- Registro novo `delete` (lápide) no próprio diário: `{ type: 'delete', seq, at }`, com `media: [{ core, start, blocks }]` opcional, `1 <= seq <` o seq da própria lápide (`docs/protocol.md`). O efeito é determinístico e genérico: as entradas são lidas do seq mais alto para o mais baixo, uma lápide válida vale se ela mesma ainda não foi apagada, e o bloco apagado não conta em nenhuma dobra (`packages/core/lib/deletion.js`, `applyDeletes`).
- Os escritores (`packages/core/lib/member.js`, `packages/web-member/lib/member-ops.js`) só apagam publicação própria (inclusive resposta e citação) ou versão do perfil; recusam o bloco 0, lápides e qualquer outro tipo. O par de compatibilidade do perfil sai como uma versão só, em um append atômico (duas lápides). A faixa de mídia vai na lápide só quando nenhuma publicação ou perfil sobrevivente a usa.
- RPC `post.delete` e `profile.delete` (`docs/rpc.md`); `log.read` mostra o bloco apagado como `invalid: { seq, reason: 'deleted' }`.
- Semeador: o alvo sai dos índices de engajamento, tema e nome; curtidas, republicações, respostas e citações de um alvo apagado não contam; `postBlock` responde null e `mediaRead` recusa a faixa listada na lápide, então `/media` e `/moderation-post` dão o 404 genérico.
- CLI: `varanda delete --to <chave>:<seq>`; `log` mostra `#<seq> apagado`.
- App: ação de lixeira nas publicações próprias em Diário, A Rua e Conversa, com confirmação em folha (`DeletePrompt`); Perfil lista as versões com "Apagar versão".

### Testes automatizados

Cobertura no repositório, por ponto:

- Dobra, validação e efeito determinístico (inclusive a lápide de lápide): `packages/core/test/deletion.test.js`, `records.test.js`, `records-clone.test.js`.
- Escritor do nó do núcleo, recusas, par de compatibilidade, faixas de mídia, `log.read` paginado: `packages/core/test/delete-session.test.js`, `member.test.js`, `session.test.js`, `store.test.js`.
- Escritor do nó do navegador: `packages/web-member/test/delete.test.js`, `session.test.js`.
- Semeador (índices, `postBlock`, `mediaRead`, reconstrução, cursor pausado): `packages/core/test/seeder-delete.test.js`, `engagement-index-delete.test.js`, `topic-index.test.js`, `name-index.test.js`; `apps/cli/test/seeder-index.test.js`, `ai-post-route.test.js`.
- Feed e Espiadinha: `packages/core/test/feed.test.js`, `peek.test.js`.
- CLI `delete` e `log`: `apps/cli/test/commands.test.js`, `cli.test.js`.
- App (quem pode apagar, linhas escondidas, versões do perfil): `apps/app/test/deletion.test.js`, `outbox.test.js`.
- Ponta a ponta, novo: `packages/core/test/delete-e2e.test.js` (sessões do nó na DHT local): quem segue sincroniza pelo semeador e deixa de ver a publicação, a resposta e a citação apagadas (`feed.read`, `log.read` com `deleted`); a lápide de outro diário com o seq do autor só esconde o bloco do próprio diário dela; o escritor recusa outro autor e recusa apagar uma lápide; uma lápide de lápide gravada à mão faz a publicação voltar no nó do autor e no de quem segue; um diário truncado continua aparecendo como `fork` para quem segue; o worklet do app usa o mesmo despachante da sessão, sem handler próprio.
- Ponta a ponta, novo: `packages/web-member/test/e2e-delete.test.js` (nó do navegador e semeador real pelo WebSocket): depois de apagar uma publicação com foto, `/index/counts` e `/index/member` a omitem, `/media` e `/moderation-post` dão 404, `postBlock` é null e a Espiadinha de outro nó não a mostra mais.

Resultados (2026-10-29, macOS): `node packages/core/test/delete-e2e.test.js` com 3 testes e 44 asserções, todos passam, no Node 24.22.1 e no 20.20.2; `node packages/web-member/test/e2e-delete.test.js` com 1 teste e 20 asserções, passa no Node 24.22.1 e no 20.20.2. Na árvore final, já sobre a main 184b7d2: `npm ci --ignore-scripts` ok; `npm run lint` sem erros; `npm test` com 0 falhas em todos os workspaces (50, 10, 35, 51, 54 e 2 arquivos de teste) no Node 20.20.2 e no 24.22.1; `npm run demo` termina com "DEMO OK" nas duas versões.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Diário: a lixeira aparece só nas publicações próprias; tocar abre a folha "Apagar publicação"; Cancelar, o toque no fundo, Escape e o Voltar do Android fecham sem gravar nada (não realizada ainda).
- [ ] Diário: confirmar apaga, a publicação some da lista e o diário mostra uma lápide a mais em Ajustes › Avançado (não realizada ainda).
- [ ] A Rua e Conversa: a mesma ação numa publicação, numa resposta e numa citação próprias; a republicação de um post de outra pessoa nunca oferece a lixeira (não realizada ainda).
- [ ] Falha incerta (semeador derrubado durante o pedido): aparece a mensagem de incerteza, o app relê o diário antes de oferecer o botão de novo e nunca reenvia o pedido sozinho (não realizada ainda).
- [ ] Perfil: com três versões, "Apagar versão" na mais nova faz valer a anterior (nome e bio); confirmar e cancelar se comportam como no Diário (não realizada ainda).
- [ ] Perfil: uma versão com foto (par de compatibilidade) aparece como uma versão só e some inteira com um toque; a foto deixa de carregar em `/media` (não realizada ainda).
- [ ] Perfil: apagar a última versão deixa a conta sem nome nem bio; quem segue vê as iniciais (não realizada ainda).
- [ ] CLI: `varanda delete --to <chave>:<seq>` imprime `apagado #<seq>`; repetir imprime `já apagado` sem gravar; outro autor, o bloco 0, uma curtida e uma lápide são recusados com a mensagem em pt-BR (não realizada ainda).
- [ ] CLI: `varanda log` mostra `#<seq> apagado` no lugar do texto, e `--json` traz `record: null, deleted: true` (não realizada ainda).
- [ ] Semeador de produção: depois da sincronização, `/index/counts/<ref>` e `/index/member/<chave>` não trazem a publicação, `/media/...` da foto dá 404 e `/moderation-post/<chave>/<seq>` com o token dá 404 (não realizada ainda).
- [ ] Um segundo aparelho que segue o autor deixa de ver a publicação em A Rua depois de sincronizar, e uma pessoa que não segue deixa de vê-la na Espiadinha (não realizada ainda).
- [ ] O aceite dos Termos versão 5 aparece de novo para quem aceitou a versão 4 (não realizada ainda).

### Limites

- Apagar não remove os bytes: quem já tem cópia do diário, ou da foto, continua com ela; a lápide só diz aos clientes e ao semeador que o bloco não vale mais.
- Uma lápide que aponta para outra lápide desfaz a primeira. O escritor nunca grava isso; só o próprio autor, escrevendo à mão, consegue, e o efeito vale só para o diário dele.
- O semeador não aplica nesta etapa lápides que apontam para `follow` ou para a declaração de núcleo de mídia (os escritores nunca as gravam).

## 42. Descarte dos bytes apagados (PR feat/delete-posts-purge, 2026-10-29)

### O que mudou

- Os bytes de um bloco apagado são descartados (`core.clear`) no aparelho do autor, em quem segue, no semeador e no nó do navegador. Só se descarta o que a dobra dos leitores esconde (`deletedSeqs` / `applyDeletes` em `packages/core/lib/deletion.js`); o bloco 0 e as lápides nunca são descartados. As faixas de mídia da lápide saem do núcleo de mídia, menos o cabeçalho e o que uma publicação sobrevivente ainda mostra.
- O comprimento presente (primeiro buraco que não é bloco apagado) substitui o `contiguousLength` como valor em `hello`, `have` e `admitted`; o formato das mensagens não muda. Um buraco apagado não segura o comprimento, e o bloco descartado nunca é baixado de novo de um par desatualizado.
- Na partida, o semeador e o nó descartam o que as lápides guardadas apagam antes de servir ou baixar qualquer coisa. Uma réplica que deixou de ser seguida é removida.
- Chave de emergência: `VARANDA_NO_CLEAR=1` (ou `noClear`) guarda os bytes como antes; a lápide continua escondendo o item.

### Testes automatizados

- Descarte no motor e no armazenamento: `packages/core/test/clear.test.js`, `packages/web-member/test/node-storage.test.js`.
- Escritor e sincronização do nó do núcleo (par desatualizado, chave de emergência, réplica não seguida, seguidor novo): `packages/core/test/sync-delete.test.js`, `delete-session.test.js`, `store.test.js`, `sync.test.js`.
- Semeador (descarte, partida, `mediaRead`, lápide de lápide): `packages/core/test/seeder-delete.test.js`; `apps/cli/test/seeder-index.test.js`, `seed-ws.test.js`.
- Nó do navegador (escritor, reabertura, sincronização sem reabastecer o buraco): `packages/web-member/test/delete-purge.test.js`, `delete.test.js`.
- Ponta a ponta, novo: `packages/core/test/delete-purge-e2e.test.js` (sessões do nó, semeador real e um par cru desatualizado na DHT local). Depois de `post.delete` e das sincronizações, o bloco some do semeador e de quem segue (`has` falso; uma réplica crua nova pede o bloco e não recebe nada, e como controle recebe o mesmo bloco do par desatualizado). Reiniciados o semeador e a sessão de quem segue, cada um sozinho continua servindo os blocos seguintes e a lápide e não serve o bloco apagado. O par desatualizado volta com o bloco, o autor escreve de novo, e nem o semeador nem quem segue buscam o bloco de volta. Um seguidor novo, com o autor fora da rede, sincroniza pelo semeador e pelo par desatualizado e fica sem o bloco depois da varredura. Uma lápide forjada (no diário de outro membro, apontando para o seq do autor e inválida lá) não apaga nem descarta nada. Um diário de teste truncado continua sendo `fork` no semeador (`rejected` com `fork`) e em quem segue. Com `VARANDA_NO_CLEAR=1` o semeador e quem segue guardam os bytes e o item continua escondido (`postBlock` null, `feed.read` sem ele).
- Ponta a ponta, novo: `packages/web-member/test/e2e-delete-purge.test.js` (nó do navegador sobre o IndexedDB de teste e semeador real pelo WebSocket). Apagada uma publicação com foto de três blocos, o semeador descarta o bloco do post e os três blocos da foto e guarda o cabeçalho e a outra foto; `mediaRead` recusa a faixa, um bloco dentro dela e faixas que a cruzam; GET e HEAD `/media` dão 404 para essas faixas e 200 para a foto que fica; a Espiadinha de outro nó não mostra o post. Depois de recarregar o nó (armazenamento fechado e reaberto, sincronização de novo), o buraco continua no navegador e no semeador.
- A lápide de lápide com bytes já descartados não traz nada de volta: o post fica ausente no autor e em quem segue, e os blocos seguintes continuam visíveis (`packages/core/test/delete-e2e.test.js`, primeiro teste; `seeder-delete.test.js`, "a post a later tombstone gives back stays absent once cleared").

Resultados (2026-10-29, macOS, rodados um a um): `node packages/core/test/delete-purge-e2e.test.js` com 3 testes e 76 asserções, todos passam, no Node 24.22.1 e no 20.20.2; `node packages/web-member/test/e2e-delete-purge.test.js` com 1 teste e 34 asserções, passa no Node 24.22.1 e no 20.20.2. Com `VARANDA_NO_CLEAR=1` no ambiente, o teste do navegador falha (o semeador não descarta), como esperado. A sequência completa da CI (`npm ci --ignore-scripts`, lint, test, demo) ainda não foi registrada aqui para esta PR.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Ordem de implantação: semeadores primeiro, depois o pacote web, depois o app, por último a CLI. Leitores anteriores a esta PR veem o diário cortado no primeiro buraco; conferir que cada etapa só entra depois da anterior estar no ar (não realizada ainda).
- [ ] Semeador de produção: apagar uma publicação com foto no app; depois da sincronização, `/media/...` da foto dá 404 em GET e em HEAD, e o diretório de dados do semeador, depois de um reinício, continua sem servir o bloco (não realizada ainda).
- [ ] Reinício do semeador com `VARANDA_NO_CLEAR=1` e depois sem: com a chave, os bytes ficam e o item continua escondido; sem a chave, o reinício descarta os bytes antes de servir (não realizada ainda).
- [ ] Um aparelho com o app desatualizado (anterior a esta PR) que já tinha a publicação volta a se conectar: o semeador e os aparelhos atualizados não buscam o bloco de volta, e o app desatualizado mostra o diário do autor só até o primeiro buraco, sem erro (não realizada ainda).
- [ ] Depois de atualizar esse app, ele descarta o bloco apagado na primeira sincronização e mostra as publicações seguintes do autor (não realizada ainda).
- [ ] Navegador: apagar uma publicação com foto na web hospedada, recarregar a página; a foto não volta, as publicações seguintes aparecem e a Espiadinha de outra pessoa não mostra o post (não realizada ainda).
- [ ] Um segundo aparelho que segue o autor, depois de sincronizar e reiniciar o app, continua sem a publicação e sem a foto, inclusive com um par antigo ainda online (não realizada ainda).
- [ ] CLI: `varanda log` de um diário com bloco descartado mostra `#<seq> apagado` e lê os blocos seguintes (não realizada ainda).

### Limites

- Quem já obteve uma cópia (par desatualizado, réplica de navegador fora do registro, captura de tela, cache imutável de `/media`) continua com ela; o descarte vale para as cópias oficiais atualizadas.
- Uma réplica nova ainda pode baixar o bloco de um par desatualizado antes de varrer a lápide; ela o descarta na varredura.
- Uma lápide de lápide desfaz a primeira na dobra, mas não traz de volta bytes já descartados: o seq aparece sem registro (`malformed`) e os blocos seguintes continuam visíveis.
- No Hypercore 10 do navegador o `contiguousLength` não é durável depois de `clear`; o nó usa o comprimento presente calculado com `has(i)`, e um par do navegador pode anunciar um intervalo contíguo que cruza um buraco descartado: o pedido desse bloco só expira.

## 43. Ajustes de UX: Espiadinha sem rótulos de rodada, ajuda só pelo botão de informação, compartilhar perfil, campo único em Seguindo, aviso abre o perfil, confirmação ao deixar de seguir, cartão de instalação (2026-10-30)

As seções 1 a 42 não mudam. Esta seção documenta uma rodada de sete ajustes de interface no app. Nenhum método do RPC, formato de registro ou rota mudou.

### O que mudou

- Espiadinha sem rótulos de rodada: as rodadas continuam (até três publicações por diário), mas a lista não mostra mais os títulos "Nª publicação de cada diário" (`apps/app/src/peek.js`, `apps/app/src/screens/Espiadinha.js`).
- Ajuda só pelo botão de informação: o link "Saiba mais" deixou de existir; as linhas curtas terminam com um pequeno botão de informação que abre a mesma folha (`apps/app/src/ui/Help.js`, `apps/app/src/help.js` e as telas A Rua, Espiadinha, Seguindo, Avisos, Diário, Identidade, Ajustes, Denunciar, Termos e Busca).
- Compartilhar perfil: no Diário, "Editar perfil" e "Compartilhar" ficam lado a lado embaixo dos dados do perfil (fora da faixa do topo); "Compartilhar" abre a folha "Compartilhar perfil" com o link, "copiar link" e "compartilhar" (`apps/app/src/screens/Diario.js`).
- Campo único em Seguindo: "Encontrar pessoas" ("nome, @nome ou código") no lugar do campo "Buscar", da pílula "Buscar" e do campo de código; a classificação da entrada vive em `apps/app/src/followInput.js` (`apps/app/src/screens/Seguindo.js`).
- Aviso abre o perfil: a linha "começou a seguir você" é um link para o perfil, sem a pílula "Seguir de volta"; o "Seguir" fica no perfil (`apps/app/src/screens/Avisos.js`, `apps/app/src/notices.js`).
- Confirmação ao deixar de seguir: "Seguindo" abre a folha "Deixar de seguir <nome>?", e só o botão vermelho "Deixar de seguir" envia `follow.remove` (`apps/app/src/ui/FollowPill.js`, `apps/app/src/follow.js`; usado em Seguindo, na busca e em Membro).
- Cartão de instalação: "Instale o Varanda" aparece uma vez depois do cadastro novo (`apps/app/src/ui/InstallCard.js`, `apps/app/src/install-offer.js`, `apps/app/src/install.web.js`, `apps/app/src/install.native.js`, `apps/app/App.js`).

**Substitui.** As instruções de verificação humana que mandam procurar o link "Saiba mais" (seções 20, 22, 23, 26 e 33) passam a valer para o botão de informação ao fim da mesma linha. A pílula "Seguir de volta" da seção 20 deixa de existir: a linha abre o perfil. A pílula "Buscar" e o campo separado "@nome ou código" da seção 22 (e do acompanhamento da seção 26) viram o campo único "Encontrar pessoas". Os títulos de rodada da Espiadinha (seção 23) não aparecem mais. O "Seguindo" que deixava de seguir com um toque agora pede confirmação. A seção 39 (abertura do app antes do cadastro: splash e cartões de apresentação) continua valendo sem mudança; o cartão de instalação desta seção vem depois do cadastro e é outra coisa.

### Testes automatizados

- `node apps/app/test/peek.test.js`: os testes dos títulos de rodada foram removidos.
- `node apps/app/test/notices.test.js`: o teste do rótulo "Seguir de volta" foi removido.
- `node apps/app/test/follow.test.js` (novo): texto e rótulo da confirmação de deixar de seguir.
- `node apps/app/test/followInput.test.js` (novo): classificação da entrada (nome, @nome, código, código incompleto).
- `node apps/app/test/install-offer.test.js`: testes novos de `installCard`, de `getCard` e das exportações do módulo nativo.
- `node apps/app/test/help.test.js`: não mudou.

### Verificação humana (ainda não realizada)

- [ ] A Espiadinha não mostra títulos entre as rodadas.
- [ ] Cada ponto que tinha "Saiba mais" abre a folha certa pelo botão de informação ao fim da linha.
- [ ] Diário, "Compartilhar": a folha "Compartilhar perfil" abre com e sem @nome, com a área de transferência recusada (o link fica selecionado) e a engrenagem continua tocável.
- [ ] Seguindo, campo único: nome, @nome (com e sem resultado que bata, e sem internet), código completo, código incompleto e Enter.
- [ ] Avisos: o aviso de quem seguiu abre o perfil, e "Seguir" ali tira o aviso na próxima leitura.
- [ ] A confirmação "Deixar de seguir <nome>?" aparece na lista, na busca e em Membro, e "Cancelar" não envia nada.
- [ ] O cartão "Instale o Varanda" aparece depois do cadastro no Chrome do Android, no Chrome do computador e no Safari do iPhone; nunca numa recarga, nem para conta existente, nem para conta que volta num aparelho novo.
- [ ] "Agora não" também silencia a nota "Instalar o Varanda".

### Limites

- O cartão aparece só na carga de página que volta do Google depois do passo "vinculo", e vale também a chave de 30 dias; não há cartão no app nativo. Quem já é membro e vincula o Google em Ajustes › Conta e @nome não o recebe. "Instalar" abre o diálogo do navegador e fecha o cartão.
- Na web, Escape ou Voltar com a folha de confirmação aberta em Membro também fecha a tela, e nada é enviado.

## 44. Abertura do app: splash animado e espera mínima (feat/animated-splash, 2026-10-30)

As seções 1 a 43 não mudam. Esta seção documenta o splash animado: a cadeira, as letras e "conectando…" cobrem o carregamento e a conexão com o semeador, e a tela Conectar deixa de piscar na web hospedada.

### O que mudou

- Portão (`apps/app/src/splashGate.js`): `SPLASH_MIN_MS = 1500`, o splash fica pelo menos 1,5 s nas fases de carregamento e também, em qualquer fase, quando a próxima tela seria os cartões ou os Termos (`gateNext`, caso da primeira abertura). `CONNECT_PATIENCE_MS = 10000`, contado a partir de quando o splash passa a cobrir a fase `connecting` (o tempo nos cartões e nos Termos não conta); depois disso, num nó configurável, a tela Conectar aparece. A busca da configuração (`loading`) não entra nessa conta: ela tem o próprio limite de 8 s. Depois que aparece, Conectar fica no lugar durante uma nova tentativa ("tentar de novo"). Falhas (`config`, `config-error`, `error`) só esperam o piso quando os cartões ou os Termos vêm antes; quando a próxima tela é Conectar, ela aparece na hora.
- Coreografia (`apps/app/src/ui/Splash.js`): a cadeira sobe e assenta, as letras de "Varanda" entram uma a uma, e "conectando…" aparece e pulsa. Os números ficam em `apps/app/src/ui/splashMotion.js` (`ENTRANCE_MS = 1180`, `PULSE_MS = 1200`, entre outros). Com "reduzir movimento", tudo vai ao estado final de imediato.
- Sobreposição na web (`apps/app/public/index.html`): um elemento fixo `#varanda-pre-splash`, desenhado só com CSS e um SVG inline (sem script), antes de o bundle do app carregar. O app o remove quando o splash sai. Uma regra CSS o esconde sozinho depois de 20 s, caso o app nunca monte. Sem JavaScript, ele fica oculto e aparece a frase do `<noscript>`.
- Por que: na web hospedada `canConfigure` é verdadeiro, então a regra antiga do `App.js` mostrava Conectar enquanto o nó ainda conectava. Agora o splash cobre essa espera.

### Testes automatizados

- `apps/app/test/splashGate.test.js`: o piso de 1,5 s segura as fases de carregamento e, com `gateNext`, qualquer fase antes dos cartões ou dos Termos, a paciência de 10 s conta a partir de `connecting`, tempo que não é número finito conta como zero, depois que Conectar apareceu (`released`) o splash não volta, e os guardas da função pura e da integração no app.
- `apps/app/test/splashMotion.test.js`: as constantes, a coreografia completa, o "reduzir movimento" que assenta de imediato, e que o módulo continua puro.
- `apps/app/test/pwa.test.js`, "index.html paints the brand before the bundle runs": a marca e o estilo da sobreposição vêm no HTML antes do bundle do app.

Esses testes cobrem o portão, os números e o HTML. Não cobrem a animação em aparelho real nem a ordem de pintura no navegador: essa parte está na lista abaixo.

### Verificação manual

Nenhuma verificação manual foi feita ainda. Todos os itens estão em aberto:

1. [ ] Web hospedada a frio: a cadeira e as letras aparecem antes do app, e nunca a chave nem o endereço do semeador (não realizada ainda).
2. [ ] PWA instalada com cache quente: a animação termina e não aparece duas vezes (não realizada ainda).
3. [ ] Rede lenta (3G no DevTools): a marca continua durante a busca da configuração (até 8 s) e depois até a conexão responder ou até 10 s, e só então aparece Conectar (não realizada ainda).
4. [ ] Falha de descoberta: Conectar aparece na hora (não realizada ainda).
5. [ ] Falha de conexão: Conectar aparece na hora, com "Detalhes técnicos" (não realizada ainda).
6. [ ] Conexão presa por 10 s: Conectar aparece (não realizada ainda).
7. [ ] "Tentar de novo": Conectar continua na tela durante a nova tentativa (não realizada ainda).
8. [ ] Com o app bloqueado (bundle que não monta), a sobreposição some sozinha em 20 s (não realizada ainda).
9. [ ] "Reduzir movimento" na web, no iOS e no Android: nada se move (não realizada ainda).
10. [ ] Leitor de tela anuncia "Varanda, conectando" uma vez (não realizada ainda).
11. [ ] Passagem da tela de abertura nativa para o splash no iOS e no Android, sem salto nem tela em branco (não realizada ainda).
12. [ ] Ordem dos cartões e dos Termos da seção 39 inalterada (não realizada ainda).
13. [ ] JavaScript desligado mostra "Ative o JavaScript para usar o Varanda." (não realizada ainda).
14. [ ] No nativo com configuração salva, o splash cobre a conexão por até 10 s no lugar do formulário com "conectando…" (não realizada ainda).
15. [ ] Primeira abertura lenta: com o nó ainda conectando, passar mais de 10 s nos cartões e nos Termos; depois deles volta o splash (com a entrada de novo), e Conectar só aparece se a conexão não responder em mais 10 s (não realizada ainda).

### Limites

- A sobreposição da web não conhece a fase real da conexão. Ela sai quando o app a remove, ou some sozinha em 20 s; se o app montar depois disso, o splash do app toca a entrada e passa a ser o anunciado para leitor de tela.
- 1,5 s e 10 s são fixos, sem configuração.
- No nativo não há desenho animado em SVG, porque o app não tem biblioteca SVG. A cadeira é o PNG de 128 px, mostrado no máximo a 96 px.
- Na primeira abertura, se o nó ainda estiver conectando depois dos cartões, o splash do app toca a entrada de novo (a sobreposição web já saiu).
- No nativo, o primeiro quadro do splash é transparente (a entrada parte da opacidade 0), como no splash anterior; com "reduzir movimento", a marca aparece de uma vez.
- Uma queda da conexão logo depois de `ready`, ainda dentro do 1,5 s, segue o caminho de antes: o app já marcou a conexão como vista e não volta para Conectar.

## 45. Passkey sem PRF: cartão Entrar com passos e "tentar de novo" (PR fix/passkey-no-prf-ux, 2026-10-30)

### O que mudou

- Veio de um relato com print: num iPhone, depois de criar a passkey, o cartão mostrava três avisos seguidos, culpava só o navegador ("Use o Chrome ou o Edge, ou o Safari 18") e não tinha botão; só recarregar a página saía dele.
- O cartão separa dois casos (`apps/app/src/screens/Identidade.js`, textos em `apps/app/src/passkeyTrouble.js`):
  - o navegador diz antes de qualquer cerimônia que não consegue (sem WebAuthn, ou `getClientCapabilities` com `extension:prf` falso): "Este navegador não funciona com o Varanda. Use o Chrome, o Edge ou o Safari 18 ou mais novo.", sem botão, como antes;
  - uma cerimônia devolveu NO_PRF (a passkey foi criada ou escolhida, mas o gerenciador de senhas não entrega o PRF): "Não deu para entrar com essa passkey.", passos numerados e o botão "tentar de novo", que volta ao cartão Entrar.
- Passkey criada nesta página (Criar ou concluir): apagar a passkey "Varanda xxxxxx", tentar de novo e criar outra salvando nas Senhas da Apple ou no Gerenciador de Senhas do Google, ou abrir no Safari ou no Chrome.
- O passo de apagar nomeia só passkeys criadas nesta página que falharam, todas, uma vez cada. Ele sobrevive ao "tentar de novo" e a uma falha seguinte em Entrar; depois de uma falha em Entrar o passo seguinte é escolher outra passkey, nunca criar outra.
- Passkey escolhida em Entrar e não criada aqui: pode ser a passkey da conta, então nunca é nomeada para apagar (antes era). Os passos sugerem tentar de novo (escolhendo outra passkey quando o navegador não guarda nenhuma; com uma guardada, Entrar só oferece aquela e o passo é só "tentar de novo") ou abrir em outro navegador.
- Criação em dois passos (o PRF só chega no "concluir"): se o "concluir" falha sem PRF, o cartão sai do estado "concluir", porque o nó descarta a criação pendente e "tentar de novo" levaria a um "concluir" que só falharia. Uma falha de "Criar passkey" (outra passkey) não mexe na criação pendente. Se a falha vem de uma passkey escolhida em Entrar, a criação pendente pode continuar viva (outra passkey) ou ter sido descartada (a mesma), e a tela não sabe qual: o cartão mantém "concluir" e mostra também "Criar passkey" (achados das revisões do codex e do grok).
- Com convite, o passo de abrir em outro navegador sai, porque o convite já diz isso com o link.
- O texto do convite perdeu o travessão: "@nome convidou você. Entre para seguir." (`apps/app/src/profileLink.js`).
- A cerimônia, o nó e o que fica guardado não mudaram. O nó já deixava a passkey que falhou fora da próxima criação (`packages/web-member/web/node.js`, `noteUnusable`).

### Testes automatizados

- Novo: `apps/app/test/passkeyTrouble.test.js` (rótulo da passkey, uma ou várias passkeys nomeadas sem repetir, ids inválidos ignorados, numeração, passo omitido com convite, passkey escolhida nunca nomeada para apagar nem recriada, sem travessão e sem o id inteiro).
- Atualizado: `apps/app/test/profileLink.test.js` (texto do convite).

Resultados (2026-10-30, Node 24.22.1, macOS): `npm run lint` sem erros; `npm test` com 0 falhas em 219 arquivos de teste (já sobre a main com #234 e #235); `npm run demo` termina com "DEMO OK". `apps/app/test/passkeyTrouble.test.js`: 5 testes, 60 asserções. Numa rodada anterior, com auditorias rodando testes ao mesmo tempo, `packages/web-member/test/e2e-delete-purge.test.js` falhou uma vez ("every photo block is cleared on the seeder": `[false, true, true]` em vez de `[false, false, false]`); sozinho, passou duas vezes (34/34), e a rodada completa seguinte passou. Esse pacote não foi alterado. Não rodado no Node 20.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] iPhone com um gerenciador de senhas de terceiros ligado: criar a passkey salvando nele mostra "Não deu para entrar com essa passkey.", os passos e "tentar de novo" (não realizada ainda).
- [ ] Na mesma página, "tentar de novo" e criar salvando nas Senhas da Apple entra; o cartão não volta (não realizada ainda).
- [ ] Duas falhas seguidas nomeiam as duas passkeys no passo 1 (não realizada ainda).
- [ ] Criação em dois passos que falha no "concluir": "tentar de novo" mostra "Criar passkey", não "concluir" (não realizada ainda).
- [ ] Criação em dois passos pendente e outra passkey sem PRF escolhida em Entrar: "tentar de novo" mostra "concluir" e "Criar passkey", e "concluir" ainda entra (não realizada ainda).
- [ ] Escolher em Entrar uma passkey sem PRF que não foi criada nesta página mostra os passos sem "Apague" (não realizada ainda).
- [ ] Criar falha, "tentar de novo", Entrar com a mesma passkey falha: o passo "Apague" continua nomeando-a (não realizada ainda).
- [ ] Navegador embutido (Instagram) com link de convite continua mostrando o caso do navegador, o convite e copiar/compartilhar (não realizada ainda).

### Limites que sobram

- A lista de passkeys que falharam fica só na memória da página: depois de recarregar, o nó pode oferecer de novo uma passkey que já falhou, e o cartão só a nomeia quando ela falhar outra vez.
- Tentar de novo no mesmo gerenciador sem PRF pode dar "já existe uma passkey do Varanda neste gerenciador: use entrar"; entrar com ela leva de volta ao cartão com os passos.
- Os textos citam a Apple e o Google para todos; o app não detecta a plataforma.
- Se a passkey escolhida em Entrar era a da criação pendente, "concluir" continua aparecendo e, tocado, só diz "nenhuma criação de passkey pendente"; "Criar passkey" ao lado resolve. Esconder o "concluir" depois de uma falha dele perderia uma criação ainda viva quando a pessoa só fechou o diálogo, e a tela não distingue os dois casos. Essa passkey também não é nomeada para apagar. Saber qual das duas falhou exigiria o nó informar a criação pendente.

## 46. Leituras sem parar a sincronização na web (PR perf/faster-content-loading, 2026-10-30)

### O que mudou

- Na web hospedada (nó do navegador, `packages/web-member`), cada leitura de membro parava a sincronização em curso: o socket fechava, todos os núcleos fechavam, e a rodada recomeçava e reconectava. A Rua disparava uma rajada de leituras, e a sincronização caía de novo e de novo. Num armazenamento novo do navegador, a lista de seguidos (montada a partir do próprio diário quando ele fica em dia) só aparecia depois que as leituras paravam. Parecia que A Rua, a Espiadinha e Seguindo só carregavam depois do Diário.
- `feed.read`, `log.read`, `profile.read`, `engagement.read` e a leitura do próprio diário em `notices.list` passam a ser servidas pelos núcleos que a rodada já tem abertos (`packages/web-member/lib/session.js`, `withCores`; `lib/sync.js`, o leitor). Elas não param mais a sincronização: nenhum `sync.stopped` com `'preempted'`, o mesmo `runId`. Sem rodada, abrem o armazenamento como antes. Uma leitura que a rodada não consegue servir (uma réplica guardada que a rodada não tem, ou um núcleo que a rodada fechou no meio da leitura) volta ao caminho exclusivo antigo e interrompe a rodada uma vez. A moderação (chaves bloqueadas, emissores revogados) é relida logo antes de responder.
- `follow.list` lê só a lista guardada e nunca para a sincronização. A resposta continua em ordem, depois de um `follow.add`.
- A Espiadinha (`peek.read`) e `notices.list` deixam de esperar atrás da fila de pedidos quando a chave própria já é conhecida, a menos que uma troca de identidade esteja pendente.
- Escritas (publicar, curtir, seguir, perfil, apagar) continuam parando e recomeçando a sincronização como antes. O app nativo e o `varanda-serve` (`packages/core`) não mudam: as leituras deles ainda interrompem a rodada por causa do lock do diretório de dados (`docs/protocol.md` seção 9).

### Testes automatizados

- `packages/web-member/test/read-while-sync.test.js`: as leituras mantêm o `runId`, zero `'preempted'`, o mesmo feed que sem uma rodada, bloqueados e emissores revogados continuam escondidos, `follow.list` espera em ordem enquanto `peek.read` começa, o fechamento espera uma leitura em andamento, e uma réplica guardada de quem não se segue cai no caminho exclusivo uma vez.
- `packages/web-member/test/sync-reader.test.js`: a rodada publica os núcleos dela, um empréstimo atrasa o desmonte, e uma falha cedo limpa o leitor.
- `packages/web-member/test/member.test.js`: leituras emprestadas iguais às leituras exclusivas, nada aberto, fechado ou descartado, casos `NEEDS_EXCLUSIVE`, e bloco, bifurcação e fechamento adotados no meio da leitura.
- `packages/web-member/test/session.test.js`: `follow.list` não interrompe a rodada, `peek.read` com a chave em cache pula a fila, e uma troca de identidade pendente entra na fila.
- `packages/web-member/test/lease.test.js` e `packages/web-member/test/diary-peek.test.js`, reescritos: as leituras deixam de interromper a rodada; `diary.peek` durante um `feed.read` na mesma rodada.

### Verificação humana

Nenhuma verificação foi feita ainda. Na web hospedada, com as ferramentas de desenvolvedor do navegador e o registro de RPC e de eventos. Marcar só o que for de fato executado, com a saída.

- [ ] Armazenamento com seguidos: desbloquear. No primeiro minuto, nenhum `'preempted'` causado por uma leitura. Paradas `'idle'` do lease, e paradas e recomeços depois de escritas, são esperados (não realizada ainda).
- [ ] Abrir Seguindo enquanto A Rua carrega: a lista responde sem parar a sincronização. Ela pode ainda esperar uma leitura que já estava na fila (não realizada ainda).
- [ ] Abrir a Espiadinha com um `feed.read` pendente: o socket próprio dela abre antes de esse `feed.read` responder (não realizada ainda).
- [ ] Um diário bloqueado e um emissor revogado continuam escondidos em A Rua, nos nomes e na Espiadinha (não realizada ainda).
- [ ] Armazenamento novo do navegador: ficar em A Rua. As publicações de quem se segue aparecem quando a lista de seguidos chega (`follows-changed`), sem visitar o Diário (não realizada ainda).
- [ ] Anotar os números antes e depois desta PR: a quantidade de `'preempted'` no primeiro minuto e o tempo até a primeira linha de A Rua (não realizada ainda).

### Limites

- A primeira leitura depois que uma rodada começa espera a rodada abrir as réplicas seguidas, uma a uma.
- O app nativo e o `varanda-serve` ainda interrompem a rodada em cada leitura.
- Um desbloqueio adotado durante uma leitura só aparece na leitura seguinte (falha segura).
- O portão de idade da web hospedada continua com 3 idas e voltas a cada carga da página (de propósito).


## 47. Pedido para ligar os avisos no aparelho (web hospedada, 2026-10-30)

As seções 1 a 46 não mudam.

### O que mudou

- A web hospedada mostra a nota "Receber avisos neste aparelho", com Ativar e fechar, sob a barra do topo, no mesmo lugar e com a mesma aparência de "Instalar o Varanda", abaixo de "Sem internet". Vale em todo navegador onde Web Push funciona, inclusive de mesa, só para um membro com a identidade desbloqueada e depois dos termos, da idade e da configuração inicial.
- Ativar abre diretamente o pedido de permissão do navegador. Nada é aguardado antes de `pushManager.subscribe()`: `enablePush` começa de forma síncrona, antes de avisar qualquer listener. O estado mostrado vem de `pushStateAfter` aplicado sobre uma leitura nova depois do passo.
- A nota fica escondida fora da web hospedada, sem suporte, sem chave VAPID, com permissão negada ou desconhecida, com os avisos já ligados, com estado desconhecido, com worker antigo ou sem registro do service worker. Também fica escondida quando foi fechada nos últimos 30 dias (`varanda-push-dismissed`) ou enquanto "Nova versão disponível.", o cartão de instalação depois do cadastro (seção 43) ou a nota "Instalar o Varanda" aparece, nessa ordem.
- Ajustes e a nota dividem o mesmo estado em `apps/app/src/push-offer.js`, por meio de `apps/app/src/usePush.web.js`. Sair e Recomeçar continuam desligando os avisos primeiro, com o limite da troca em andamento descrito na seção 38.
- O estado é lido de novo quando a conexão volta, e qualquer bloqueio da identidade apaga o que foi lido.
- Uma troca de cada vez no navegador, mesmo depois de Sair e entrar de novo: a inscrição é do navegador, e duas trocas ao mesmo tempo poderiam desfazer uma à outra. Quando uma troca começada em outra sessão termina, o estado é lido de novo antes de liberar a linha e a nota.

### Testes automatizados

- `apps/app/test/push-offer.test.js`: regras da nota, chamada síncrona de `enablePush` antes de qualquer listener, nenhuma segunda chamada enquanto há uma pendente, leitura nova depois do passo, resultados de permissão negada e de falha, leitura em espera, fechamento por 30 dias e `offHere`.
- `apps/app/test/use-push-native.test.js`: contrato nativo inerte.
- `apps/app/test/push-shell.test.js`: ordem e ligação da nota verificadas pela leitura do código-fonte.

Não há executor de testes no navegador. O resultado de lint, dos testes e da demo fica com o orquestrador e não é repetido aqui.

### Verificação manual

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado.

- [ ] No Chrome e no Firefox de mesa, depois de chegar às abas, a nota aparece e Ativar abre o pedido de permissão sem abrir Ajustes (não realizada ainda)
- [ ] Aceitar a permissão faz a nota sair e Ajustes mostrar "Ligados" (não realizada ainda)
- [ ] Cancelar o pedido de permissão não inicia os 30 dias de fechamento; um toque posterior em Ativar pede de novo (não realizada ainda)
- [ ] Negar a permissão faz a nota sair e Ajustes mostrar o texto de permissão negada (não realizada ainda)
- [ ] Fechar a nota persiste depois de recarregar e é independente de `varanda-install-dismissed` (não realizada ainda)
- [ ] No Chrome do Android com a oferta de instalação, "Instalar o Varanda" aparece primeiro e a nota dos avisos só aparece depois de fechar a de instalação (não realizada ainda)
- [ ] No iPhone ou iPad fora da Tela de Início, só a nota de instalação aparece (não realizada ainda)
- [ ] No iPhone ou iPad pela Tela de Início, a nota aparece quando os avisos ainda não estão totalmente ligados e o primeiro `await` do toque é `pushManager.subscribe()` (não realizada ainda)
- [ ] Com uma versão aguardando atualização, "Nova versão disponível." aparece primeiro (não realizada ainda)
- [ ] Abrir Ajustes enquanto Ativar está em andamento mostra a linha pendente e o mesmo estado final da nota (não realizada ainda)
- [ ] Tocar em Sair logo depois de Ativar ainda desliga os avisos (não realizada ainda)
- [ ] Uma falha mostra o texto de falha na barra e nada é enviado de novo por conta própria (não realizada ainda)
- [ ] No app nativo, a nota não aparece (não realizada ainda)

### Limites

- Fechar vale por perfil do navegador, não por conta; a nota volta depois de 30 dias. Sem armazenamento, volta na próxima carga.
- Sair continua sem esperar uma troca dos avisos em andamento, como descrito na seção 38: um Sair no meio de um Ativar pode deixar este navegador inscrito até a próxima leitura. Depois de entrar de novo, a linha e a nota ficam pendentes até essa troca terminar; se o pedido de permissão ficar aberto, elas esperam a resposta, e se uma leitura do navegador travar, até recarregar a página.
- Uma leitura sem conexão ao abrir Ajustes volta sem chave: a linha mostra o texto de indisponível e a nota some até a próxima leitura, como antes desta mudança. Se o service worker não fica pronto a tempo, a linha mostra o texto de recarregar, também como antes. Como fechar Ajustes não apaga mais o estado, ao reabrir a linha mostra o estado anterior até a leitura nova chegar.
- Se Sair ou Recomeçar falhar depois de desligar os avisos, a linha continua mostrando o estado anterior até a próxima leitura, como antes desta mudança.
- Com duas abas abertas, uma não vê a inscrição feita na outra até ler de novo (abrir Ajustes, voltar a conexão, bloquear e desbloquear). Ativar nessa aba recebe do navegador a inscrição que já existe e, se um passo seguinte falhar com recusa, a desfaz, como já acontecia na linha de Ajustes; a nota aumenta essa janela porque a leitura dela vale até a próxima.
- Não há push nativo, repetição automática de pedidos nem teste automatizado no navegador.

## 48. Conta de pagamentos opcional: abertura e KYC (feat/hodle-account, 2026-10-30)

As seções 1 a 47 não mudam. Esta seção documenta o PR1: opt-in, KYC e PIN da conta de pagamentos na web hospedada. O envio de dinheiro fica para a seção 53 e para a próxima etapa.

### O que mudou

- Recurso opcional, só na web hospedada, por um parceiro (Hodle). O saldo previsto é BRLA, emitido pela Avenia, 1 real, na Polygon (padrão documentado da Hodle). Não rende. Sem abrir a conta, o app segue igual. Decisão do dono do produto em 2026-10-30. O papel da associação ainda depende de parecer, e a ida ao ar depende do parecer jurídico (`docs/design.md`, Conta de pagamentos).
- Cliente de saída `apps/cli/lib/account/hodle.js`: subconta, documento, prova de vida, envio do KYC, leitura do resultado e criação da carteira. A chave de API, o PIN, o CPF e o JSON do parceiro não saem num resultado nem num erro. Chamada que muda estado e pode ter chegado ao parceiro volta com `uncertain: true` e não é repetida. Redes aceitas: `polygon` e `base`, padrão `polygon`.
- Arquivo `wallet.json` (`apps/cli/lib/account/wallet-store.js`, modo 0600, volume `account-data`): `subAccountId`, rede, estado do KYC, `attemptId`, `documentId`, `selfieId`, `walletId`, endereço e chave embrulhada. As marcas de criação incerta vão para o disco antes da chamada. A primeira carteira fica. O PIN, o CPF, o nome, o endereço, as fotos, as URLs e os saldos não entram.
- Declaração `varanda-wallet-v1` (`packages/core/lib/wallet-proof.js`) e método RPC `wallet.sign` (`docs/rpc.md` 5.35), só no nó do navegador. O nó do núcleo, o `varanda-serve` e a CLI respondem `USAGE` `assinatura disponível só no navegador`. A operação assinada não leva PIN nem CPF.
- App, módulo puro `apps/app/src/wallet.js`: os passos do opt-in ao PIN, a idade mínima de 18 anos no formulário, o PIN de 6 dígitos sem sequência óbvia, e os textos fixos. O operador escolhe `VARANDA_HODLE_MODE`, na ordem de ativação `cadastro` < `carteira` < `pix` < `completo`. O padrão `cadastro` permite só subconta e KYC e para no KYC aprovado. O modo `carteira` acrescenta a criação da carteira com o PIN da própria pessoa e só deve ser configurado depois que a Hodle confirmar por escrito o PIN por pessoa. Nesta versão existem apenas `cadastro` e `carteira`; `pix` e `completo` chegam nos próximos PRs.
- As fotos não passam pelo serviço de conta. O documento sobe direto para `uploads.hodle.com.br`. A selfie abre `app.hodle.com.br`.
- Variáveis: `VARANDA_HODLE_API_KEY` (`hodle_live_` ou `hodle_test_`; sem ela o recurso fica desligado), `VARANDA_HODLE_NETWORK` (`polygon` ou `base`, padrão `polygon`, só antes da primeira carteira), `VARANDA_HODLE_MODE` (`cadastro` por padrão, ou `carteira`) e `VARANDA_HODLE_DAILY_LIMIT`.
- Termos de Uso e Política de Privacidade versão 7, com novo aceite. O `wallet-ops.json` é do PR2 e não faz parte desta abertura.
- Bloqueio que continua: a documentação da Hodle descreve um PIN da plataforma herdado pela subconta. A Varanda quer um PIN por pessoa. Enquanto a Hodle não confirmar, a carteira não deve ser criada na API real. O sandbox é Base Sepolia e não exercita subcontas.

### Testes automatizados

Todos os testes desta etapa usam o falso em `127.0.0.1` (`apps/cli/test/helpers/fake-hodle.js`) ou não abrem rede. Nenhum cobre a Hodle real, o sandbox, a tela no navegador nem o parecer. Rodados em 30/10/2026 no Node 24 e no Node 20, sem falha.

- `node apps/cli/test/hodle.test.js`
- `node apps/cli/test/wallet-store.test.js`
- `node apps/cli/test/account-wallet.test.js` (rotas do serviço de conta)
- `node apps/cli/test/account-wallet-e2e.test.js` (do `wallet.sign` no navegador até o falso, com reinício)
- `node apps/cli/test/account.test.js` (variáveis `VARANDA_HODLE_*`, partida por modo, perda do lock)
- `node apps/app/test/account.test.js` (cliente do app)
- `node packages/core/test/wallet-proof.test.js`
- `node packages/core/test/session.test.js`
- `node packages/web-member/test/session.test.js`
- `node packages/rpc/test/methods.test.js`
- `node apps/app/test/wallet.test.js`
- `node apps/app/test/legal.test.js`
- `node packages/core/test/terms.test.js`

### Verificação manual

Nenhuma verificação manual foi feita ainda. Todos os itens estão em aberto:

1. [ ] Sem `VARANDA_HODLE_API_KEY`: a conta de pagamentos não aparece e o restante do app não muda (não realizada ainda).
2. [ ] `VARANDA_HODLE_MODE` em `cadastro` (padrão): opt-in, documento, selfie, dados e KYC aprovado terminam na frase de que a carteira será liberada em breve, sem pedir PIN (não realizada ainda).
3. [ ] Com `VARANDA_HODLE_MODE=carteira`: depois do KYC aprovado, o app pede o PIN e cria uma carteira. Uma segunda criação não cunha outra (não realizada ainda).
4. [ ] "Deixar para depois" não cria subconta e a Varanda segue utilizável (não realizada ainda).
5. [ ] Os textos dizem que a conta na Hodle não pode ser apagada, que o saldo não rende e que a Varanda não é banco (não realizada ainda).
6. [ ] Data de nascimento de quem tem menos de 18 anos: o app recusa e o serviço não chama a Hodle (não realizada ainda).
7. [ ] PIN `111111`, `123456` e `654321` não passam no app. Um PIN aceito não aparece no `wallet.json` nem no registro (não realizada ainda).
8. [ ] O `wallet.json` tem só identificadores, chave embrulhada, estado e ids. Sem CPF, nome, endereço ou foto (não realizada ainda).
9. [ ] A foto do documento não passa pelo serviço de conta. A selfie abre a página da Hodle em outra janela (não realizada ainda).
10. [ ] Resposta perdida na criação: fica o estado incerto, a pessoa toca em Conferir, e o serviço não cria outra sozinho (não realizada ainda).
11. [ ] Três PINs errados bloqueiam a criação da carteira por 24 horas na Hodle, sem nova tentativa automática (não realizada ainda).
12. [ ] O aceite dos Termos e da Política versão 7 aparece de novo para quem aceitou a versão 6 (não realizada ainda).
13. [ ] No app nativo e na CLI, `wallet.sign` responde que a assinatura só existe no navegador (não realizada ainda).
14. [ ] `VARANDA_HODLE_NETWORK` mudada depois da primeira carteira não muda a rede já guardada (não realizada ainda).
15. [ ] Enquanto a Hodle não confirmar por escrito o PIN por pessoa, o operador mantém `VARANDA_HODLE_MODE` em `cadastro` para deixar a criação de carteira na API real desligada. Isso é uma configuração do operador, não uma trava no código (não realizada ainda).
16. [ ] Nenhum teste desta etapa abre rede externa. Só `127.0.0.1` (não realizada ainda).

### Limites

- O sandbox da Hodle não exercita subconta. O que os testes provam é o falso de loopback.
- Até a Hodle confirmar por escrito o PIN por pessoa, o operador deve manter `VARANDA_HODLE_MODE` em `cadastro` para deixar a criação da carteira na API real desligada.
- A subconta não pode ser apagada na Hodle. A eliminação pedida pelo titular segue em aberto, com a retenção (issue #38).
- Quem tem 16 ou 17 anos não abre esta conta nesta etapa.
- Esta etapa não envia dinheiro, não cobra taxa e não cria `wallet-ops.json`.
- Sem `VARANDA_HODLE_API_KEY`, ninguém vê o recurso.
- Uma criação cuja resposta se perdeu fica parada até leitura adotável ou limpeza pelo operador.
- Uma recusa definitiva da Hodle no envio do KYC (por exemplo, um campo que ela não aceita) encerra a tentativa como recusada, e a pessoa refaz documento e selfie.
- Se a gravação do `wallet.json` falhar logo depois de uma recusa da Hodle, a marca de incerteza pode ficar, e a pessoa fica parada até o operador limpar.
- Dois processos gravando o mesmo `wallet.json` só acontecem depois de perder o lock; nesse caso a mesclagem pode trazer de volta um identificador apagado. O serviço deixa de gravar ao perder o lock.
- 16 e 17 anos: a barreira é a declaração no opt-in e a data de nascimento conferida pela Hodle no documento.

## 49. Grupos públicos (PR feat/groups-public, 2026-10-28)

Primeira parte de Cadeiras de Praia: grupos públicos de texto, `docs/protocol.md` seção 10 e `docs/rpc.md` 5.36 a 5.49. Cada aparelho escreve o próprio núcleo, o leitor dobra todos (`buildGroup`), o semeador admite os núcleos e responde os índices, e a moderação segue a seção 10 do protocolo e `docs/design.md`.

### Como verificar

Do repositório, cada arquivo roda sozinho (`node <arquivo>`); a suíte inteira roda com `npm test`.

| Arquivo | O que cobre |
|---|---|
| `packages/core/test/group.test.js` | formas exatas dos registros e do cabeçalho (inclusive `seen` em todo registro), construtores, `groupJoins` e `groupJoinHistory`, a dobra: ordem causal e desempate, referência pendente ignorada, ciclo forjado, cortes como comprimento observado, autoridade (só a raiz nomeia e rebaixa; proteção lida do estado final; admissão positiva nunca protegida; raiz sem vínculo sem autoridade), banimento que domina, `lifts`, saída e `rejoin`, teto de 512 escritores, pulo de 24 h |
| `packages/core/test/group-member.test.js` | operações do nó (`member.js`): criar, entrar, sair, postar, ler, listar, moderar, estado `pending`, saída repetida, banido que não entra nem sai, entrada recusada no teto de escritores, `groups.json` e a regra de nunca despejar um grupo criado |
| `packages/core/test/group-index.test.js` | índice em memória do semeador: um grupo por linha, vivos primeiro, busca só por nome público, tetos |
| `packages/core/test/groups-net.test.js` | canal `varanda/groups/1`: mensagens, limites, mensagens ruins, taxa, tempo esgotado, semeador antigo |
| `packages/core/test/seeder-groups.test.js` | admissão de escritor e de raiz, quarentena, gravação antes de abrir, bloqueio da lista retido, derrubadas (diário, raiz, fork, cota; nunca por saída), suporte da raiz e adiamento na partida, `admitted.json`, flags de completude |
| `packages/core/test/seeder-groups-waits.test.js` | semeador: esperas e novas tentativas de admissão (inclusive depois de uma purga), orçamento de parada da varredura por diário e sua memória entre derrubada e nova oferta (as funções de apoio de ambos os arquivos ficam em `test/helpers/seeder-groups.js`; dividido para caber no limite de 180 s por arquivo) |
| `packages/core/test/seeder-groups-3.test.js` | semeador: a guarda das purgas contra replicação (o gancho do corestore fixado ainda existe; pedido de um par durante a purga não anexa e nada lança; a purga espera a abertura já em andamento) e a espera de uma entrada que ninguém serve (mesmos apoios em `test/helpers/seeder-groups.js`) |
| `packages/core/test/sync-groups.test.js` | sincronização do nó: portões, diários de vínculo, metas de execução única, ritmo dos pedidos, purgas só de escritor aceito, eventos |
| `packages/core/test/sync-groups-2.test.js` | continuação da sincronização do nó: tetos por diário, memórias de dicas, purgas na partida, erros leves agregados e portão do próprio diário (dividido para caber no limite de 180 s por arquivo; apoio em `test/helpers/sync-groups.js`) |
| `packages/core/test/sync-groups-3.test.js` | continuação: diários de vínculo divergentes e o modelo de exclusão nos diários de vínculo (blocos apagados limpos e nunca pedidos de novo, entrada apagada retirada sem purga, núcleos próprios mantidos na limpeza da partida) |
| `packages/core/test/session-groups.test.js` e `session-group-events.test.js` | métodos `group.*` na sessão do nó, `groups.changed` por escrita e por crescimento da sincronização |
| `packages/web-member/test/group-ops.test.js` | os mesmos métodos no nó do navegador (`member-ops.js`), `node-store.js` (`groupWriters`, `groupReplicas`, `groupDiaries`) |
| `packages/web-member/test/sync-groups.test.js` | sincronização do navegador: portões, confirmação do envio pelo comprimento do semeador, ritmo de 1 pedido por segundo, purgas, `groups-changed` agrupado |
| `packages/web-member/test/sync-groups-2.test.js` | continuação da sincronização do navegador: tetos e dicas hostis, criador atrasado, aparelho atrás do semeador, semeador sem grupos e o modelo de exclusão nos diários de vínculo (inclusive `diary.peek`) (dividido para caber no limite de 180 s por arquivo; apoio em `test/helpers/sync-groups.js`) |
| `packages/web-member/test/session-groups.test.js` | sessão do navegador: `group.*`, `node.info` com `groups: true`, `report.sign` v2 |
| `packages/web-member/test/groups-e2e.test.js` | ponta a ponta em loopback: semeador real atrás de WebSocket e na DHT local, nó do núcleo (criador, `runSync`) e nó do navegador. O criador faz um grupo com aprovação; o navegador entra pela chave antes de ter a raiz, é admitido, posta, é banido e desbanido, vê uma ocultação e sai; o semeador reinicia e refaz o índice; um instantâneo de moderação bloqueando a raiz chega ao semeador e aos dois nós |
| `apps/cli/test/group-commands.test.js` | comandos `group ...` da CLI e saída `--json` |
| `packages/core/test/records.test.js`, `report.test.js`, `store.test.js`, `browser-safe.test.js` | `group-join`, declaração `varanda-report-v2` (11 linhas na ordem), `admitted.json` com `groups`, módulos puros seguros para o navegador |
| `packages/rpc/test/methods.test.js`, `envelope.test.js`, `sizes.test.js` | validação dos parâmetros `group.*`, evento `groups.changed`, tamanho do pior caso de `group.read` e `group.members` |
| `apps/cli/test/seed-ws.test.js`, `seeder-index.test.js`, `seed-ops.test.js` | rotas `/index/group`, `/index/groups/<D>`, `/index/group-search`, `seed list` com os núcleos de grupo |
| `apps/cli/test/moderation-store.test.js`, `account-mod.test.js`, `group-check.test.js`, `ai-worker.test.js`, `panel.test.js` | `moderation.json` v2, denúncia de grupo, chave de deduplicação com escritor, alvo `diario`/`grupo`, a IA que nunca lê denúncia de grupo, painel |

Resultado nesta rodada: os arquivos de teste de grupos listados acima passam; a contagem de testes e a CI completa (lint, test e demo) ficam registradas na execução da CI da PR.

### Não verificado / limites conhecidos

- Renomear o grupo (`group-meta`) não aparece na busca do semeador: ela lê só o nome do cabeçalho da raiz.
- `seed list` não mostra a raiz cujo diário criador não foi admitido naquele semeador.
- O diário não consegue cortar o escritor de um aparelho perdido (`group-join on:false` só atualiza índices).
- Sair e voltar offline antes de o semeador buscar as saídas do escritor antigo deixa o escritor novo sem verificação para os pares: o semeador só admite entradas vivas.
- O nó do núcleo guarda os diários de vínculo inteiros (custo de escala).
- A sincronização do núcleo pode perder um fork de diário de vínculo entre a checagem do portão e a instalação do vigia; um núcleo em execução única pode aceitar um diário de vínculo que cresceu depois da admissão sem esperar os blocos novos; no nó do núcleo, a vaga liberada por um fork ou por uma falha de cota só é usada na próxima passada de páginas.
- No navegador, um núcleo de grupo já baixado que uma interrupção deixou fora da lista `groupReplicas` pode ficar preso na reconferência (`regate`) até crescer de novo; numa execução única ele estoura o prazo e é descartado. As três leituras do portão de um núcleo alheio usam cada uma o prazo inteiro, não o que resta, então um portão lento pode levar até cerca de três vezes o tempo pedido antes de a execução única terminar.
- O navegador continua paginando um grupo do qual o próprio diário saiu e pagina itens de diários banidos na dobra local (baixo, adiado).
- A contagem por diário do semeador na partida, para vínculos gravados em disco, segue a ordem de iteração e não a entrada mais antiga (uma retaguarda para dados escritos antes do teto de 8 escritores por diário).
- O semeador conta os núcleos de grupo com varreduras lineares (adiado).
- A varredura de revogação do navegador para um instantâneo adotado no meio de uma execução não tem teste.
- O ritmo dos pedidos de página deixa as sincronizações com muitos grupos mais lentas (cerca de 1 s por pedido).
- Grupos privados e comunidades vêm em PRs seguintes; não há interface nativa (só web e CLI).
- A memória por entrada do semeador (por diário, chave e posição da entrada) vale para a cota: depois de mudar a cota, só uma nova entrada faz o semeador buscar o núcleo de novo. Uma raiz que nomeia um diário bloqueado não é mais lembrada por entrada: desbloquear basta.
- No navegador, uma raiz pedida antes de entrar mas ainda não indexada pelo semeador sai da lista depois de uma passada de páginas completa sem ela.
- As varreduras do próprio diário do semeador e a adoção da lista de bloqueio reconciliam fora da fila justa de admissões.
- A correção do teto por diário no navegador é coberta por testes de unidade, sem um teste de ponta a ponta com 9 escritores do mesmo diário.
- Cada início de execução do navegador lê uma vez cada diário de vínculo guardado dos escritores guardados.
- A restauração da cobrança das raízes na partida do semeador (a partir de `admitted.json`) não tem teste.
- Raízes de `admitted.json` gravadas antes do campo `by` não são cobradas de ninguém.
- Núcleos de grupo do navegador criados por versões anteriores desta branch não estão em `groupCores` e a redefinição de identidade não os apaga.
- O nó do núcleo dobra todos os escritores de um grupo por inteiro a cada comando de grupo (sem cache incremental da dobra; adiado).
- O navegador abre o bloco 0 de todo núcleo de grupo guardado a cada operação (adiado).
- Uma retirada de admissão (`on:false`) cujos cortes não observaram uma saída vale só para a geração anterior.
- Numa execução única do núcleo, com 8 escritores de um mesmo diário não guardados localmente no portão ao mesmo tempo, o download do diário de vínculo chegou a travar até o prazo (visto num teste; causa não confirmada).
- Uma saída retira os registros dos outros aparelhos da pessoa e das gerações anteriores (decisão do produto, por desenho): quem saiu por um aparelho perde o que os outros escreveram no grupo, mesmo antes da saída.
- A recusa `saia pelo aparelho que criou o grupo` é praticamente inalcançável num grupo carregado.
- Uma entrada que deu `timeout` no semeador só deixa de reter as respostas (páginas, busca, lista de grupos do diário) depois que a nova tentativa após a primeira espera também falha; uma entrada recusada por `group-full` (capacidade do semeador) mantém as respostas incompletas, e uma recusa de `group-full` antes da busca espera o recuo, então uma escritora recusada pode esperar até o recuo depois que abre vaga.
- Limite conhecido do criador: ele pode listar, numa saída por outro escritor, um corte da raiz além do comprimento atual dela e depois acrescentar registros à raiz abaixo desse corte com `at` retroativo; eles continuam valendo (não se distinguem de registros honestos da raiz ainda não vistos, e o criador não ganha nada que não recuperaria ao voltar).
- A corrida da reserva de vaga no portão do navegador e as funções `capExcess` e `refineJoinSeq` só têm teste de unidade, sem teste de ponta a ponta.
- Item aberto desde a terceira rodada: o download que travou com muitos escritores de um mesmo diário não guardado (acima).
- Item aberto desde a terceira rodada: no nó core, enquanto a portaria de uma chave está em andamento, outra listagem da mesma chave sob outro grupo é descartada; depois de uma dica refutada a nova varredura olha só o grupo daquela dica, então a listagem honesta sob o outro grupo espera a próxima passada (e pode se perder num `--once`).
- A parte da correção do laço da sexta rodada que pula o semeador na nova varredura não tem teste de regressão que falhe sem ela (a parte da memória cheia tem).
- Núcleo: a comparação do bloco 0 guardado com o bloco 0 do portão antes da cota (sétima rodada) não tem teste que falhe sem ela, porque a detecção de fork pega o caso primeiro.
- Núcleo: pular o semeador suspenso pelo resto da passada não tem teste determinístico.
- Núcleo (oitava rodada): o teste da comparação do diário de vínculo guardado com os blocos do portão passa sem a correção, porque a detecção de fork pega o caso primeiro; o caminho do portão para um núcleo já guardado não tem teste separado.
- Navegador (oitava rodada): o teste do cache do histórico de entradas por execução não foi mostrado falhando sem a correção.
- Navegador: a posição da reconferência do certificado de vínculo no portão (antes de guardar e antes de ativar) só tem teste de unidade.
- Raízes vinculadas antes desta versão só ganham `bound` (e `issuer`) em `admitted.json` depois da próxima varredura do criador; até lá o semeador não as derruba por criador bloqueado ou de emissor revogado.
- Núcleo (nona rodada): o teste da recusa de um diário de vínculo divergente passa sem a correção, porque uma reescrita sempre chega ao membro como fork.
- Navegador (nona rodada): o teste de ponta a ponta do portão de escrita não falha de forma confiável sem a correção; o teste de unidade de `ownGroupVerdict` a protege.
- Manutenção (nona rodada): o reanexo da réplica do diário de vínculo no núcleo depende de `opened()` do protomux, do Protomux do fluxo em `socket.userData` e de `Hypercore#replicate(mux)` (hypercore 11.39.0, corestore 7.15.0, protomux 3.13.0): reconferir a cada atualização dessas dependências.
- Semeador (décima rodada): o ramo de negação além de 8192 entradas (`denials-full` com uma negação sem espaço) não tem teste.
- Núcleo (décima rodada): o refino pela entrada `on:true` mais antiga não vale para os portões só de quarentena.
- Dobra (décima rodada): os testes do desbanimento conferem o corte gravado, não o que fica oculto depois que os blocos chegam.
- Uma negação que não coube (além de 8192 entradas) se perde ao reiniciar o semeador; enquanto os mapas seguirem cheios, as raízes continuam recusadas (`denials-full`).
- Núcleo (décima segunda rodada): o teto de 32 textos em `errorsSoft` para as outras mensagens (31 mais a linha agregada de núcleos de grupo) não tem teste direto.
- Núcleo e navegador ainda diferem no teto por diário: os dois despejam o escritor guardado que cede a vaga a uma entrada comprovada mais antiga, mas o núcleo purga os blocos dele (`group-skipped` `quota`) e o navegador os mantém (`evictionPurges`).
- Limitação aceita pela decisão do produto: um navegador que divide a chave de escritor de um grupo com outra instância do mesmo perfil (outra aba, ou um aparelho restaurado de um armazenamento mais antigo) confia no comprimento que seu único semeador informa. Um semeador malicioso que esconde blocos desse escritor que ele tem pode fazer o aparelho gravar num comprimento defasado e bifurcar o próprio escritor ou a própria raiz. Nenhuma prova distingue um semeador que esconde blocos de um que nunca os recebeu, e o navegador não tem outro par. Um semeador honesto que só está atrasado é coberto por `group-behind`.
- Núcleo (décima terceira rodada): o caminho real da divergência de bloco 0 em escritores de grupo não tem asserção de ponta a ponta da linha agregada `bloco 0 divergente em escritores de grupo: <n> (<chaves>)` (só um teste com gancho).
- Núcleo (diário de vínculo): entre a saída de um escritor parado por cota da tabela de admissão e a leitura que o registra como guardado, o diário de vínculo dele pode ser liberado e purgado se nenhum outro escritor o nomear naquele instante; o diário volta a ser buscado quando um escritor dele passa de novo pelo portão. Sem perda dos blocos do escritor.
- Navegador: as leituras de grupo (`group.read`, `group.list`, `group.info`, `group.members`, `group.requests`) ainda pausam a sincronização em andamento em vez de ler junto com ela.
- Quando a pessoa autora apaga um bloco `group-join`, a varredura do semeador o ignora, mas o estado de entrada dobrado antes da exclusão permanece.
- Núcleo: nenhum teste falha sem a mudança da varredura de entradas para uma entrada depois de um buraco limpo (só o refino do teto por diário a usa).
- Núcleo: a execução única que ficava esperando um escritor cujo bloco `group-join` a pessoa autora apagou depois do portão não foi reproduzida em teste (a retirada `withdrawn` tem teste; a espera exata foi conferida lendo o código), e a regra que impede a limpeza da partida de apagar um núcleo de grupo que o próprio nó grava não tem teste que falhe sem ela. Um portão que já esperava o bloco `group-join` quando chega a exclusão dele só termina no próprio prazo (`timeout`, sem contar contra o diário).
- Núcleo: a exclusão que chega enquanto o diário de vínculo é dobrado pela primeira vez tem teste que falha sem a correção; a parte que varre os blocos locais além da dobra, sem evento, só foi conferida lendo o código. A regra que mantém a execução única aberta até o bloco 0 de um escritor recém-admitido ser comparado não tem teste que falhe sem ela (com ela, 8 execuções seguidas do arquivo sem falha, contra 3 falhas em 11 antes). A varredura feita logo depois da primeira dobra espera cada recomposição em vez de juntá-las: com muitas exclusões já locais nesse trecho, o custo cresce com o quadrado delas (limitado pela cota do diário; baixo, adiado).
- Navegador: nenhum teste cobre um bloco apagado que o semeador ainda guarda ser recusado enquanto está em oferta.
- Verificações humanas, em aparelho real, ainda devidas: ver um grupo criado na CLI aparecer no navegador e o inverso, num semeador de verdade.

### Verificações novas do ciclo de segurança (a fazer; a pessoa que modera ou opera confere)

- **Aparelho restaurado atrás do semeador.** Restaure um aparelho de membro (backup antigo) de modo que um núcleo de escritor seu fique mais curto que o do semeador, abra um grupo e tente postar: o navegador recusa (`group-behind`) até sincronizar com o semeador, e depois que alcança o post sai normalmente, sem bifurcar o escritor.
- **Teto por diário.** Com uma conta, vincule 9 escritores ao mesmo grupo (9 aparelhos ou o mesmo diário com 9 `group-join` para o mesmo grupo). Só os 8 de entrada mais antiga contam na leitura e no semeador (`/index/group/<chave>` lista 8 dessa conta); o 9º recebe `limite do grupo atingido` ao entrar pelo app e nunca é admitido nem indexado no semeador. Sair não libera a vaga.
- **Efeito da saída.** Saia de um grupo e confira que a admissão ou a ocultação de administração que o diário fez depois da saída deixou de valer, que as mensagens do próprio aparelho que saiu anteriores à saída continuam como estavam, que a pessoa que saiu ainda consegue ocultar uma mensagem sua e que o criador mantém nome e administradores (a raiz segue a regra dos cortes). Volte (novo escritor com `rejoin`) e confira que o que foi escrito depois da volta vale.
- **Cortes da nomeação.** Nomeie um administrador, depois entre com um aparelho novo dele: o aparelho novo não ganha autoridade até uma nova nomeação, e o que o administrador escreveu antes da promoção não passa a valer como ato de administração.
- **Bloqueio de grupo verificado no painel.** Abra uma denúncia de mensagem de grupo: o painel mostra a chave inteira do grupo, o escritor e a posição, e rotula as chaves bloqueadas ou pendentes como `conta` ou `grupo`. Com o semeador no ar e a chave servida, `Bloquear conta` e `Bloquear grupo` ficam ativos; enquanto o grupo não é confirmado, os dois botões ficam desabilitados com a explicação, e `Descartar` sempre funciona (com o semeador parado, ou com uma chave que ele não serve, a denúncia só pode ser descartada). Forçar `bloquear` por fora do painel numa denúncia de grupo responde 409 `grupo-nao-confirmado` e nada é decidido. Uma denúncia v2 com o grupo igual ao alvo, ou o escritor igual ao alvo, é recusada na entrada. Uma denúncia de mensagem do criador (escritor igual à chave do grupo) pode ser confirmada e decidida. Uma denúncia que nomeia o diário da própria pessoa que modera como grupo aparece para ela e pode ser descartada; só `Bloquear grupo` nela é recusado (404 `nao-encontrado`).
- **Denúncia com posição além do escritor.** Denuncie uma mensagem de grupo cuja posição passa do comprimento do escritor no semeador: o painel mostra a explicação nova (o semeador confirma a pessoa, mas não tem a mensagem), `Bloquear conta` e `Bloquear grupo` ficam desabilitados e `Descartar` funciona; forçar `bloquear` por fora responde 409 `grupo-nao-confirmado`, e depois da recusa o painel pergunta de novo na carga seguinte.
- **Sair por um segundo aparelho.** Com a mesma conta em dois aparelhos que postaram no mesmo grupo, saia pelo segundo: a saída é imediata (sem `aguarde a sincronização do grupo para sair`) e as mensagens do primeiro aparelho deixam de aparecer no grupo, inclusive as anteriores à saída. Volte e confira que só o que for escrito depois da volta vale.
- **Criador saindo por um aparelho secundário.** Crie um grupo com nome e administradores no aparelho A, entre com a mesma conta no aparelho B, deixe os dois sincronizarem e saia pelo B: o grupo mantém nome e administradores (a saída lista a raiz nos cortes). Se a raiz não estiver entre os cortes, a saída é recusada com `saia pelo aparelho que criou o grupo` (num grupo carregado isso quase nunca acontece).
- **Painel e alvo sem conta vinculada.** Abra uma denúncia sem grupo cujo alvo não tem conta vinculada, com o semeador no ar e servindo o diário: o painel mostra `conferindo a chave no semeador…` e depois libera `Bloquear`. Com um diário que o semeador não serve (ou sem semeador), `Bloquear` fica desabilitado com `O semeador não confirmou que esta chave é um diário servido; só é possível descartar.`; forçar `bloquear` por fora responde 409 `alvo-nao-confirmado`. Com o semeador parado no meio, o painel mostra `O semeador não respondeu agora; a confirmação será tentada de novo.` e pergunta de novo na carga seguinte; `Descartar` sempre funciona.
- **Bloqueio de conta vinculada sem semeador.** Pare o semeador e abra uma denúncia sem grupo cujo alvo tem conta vinculada: `Bloquear` fica desabilitado, forçar `bloquear` por fora responde 409 `alvo-nao-confirmado` e só `Descartar` funciona. Suba o semeador de novo e, com ele servindo o diário, `Bloquear` volta.
- **Reinício de identidade no navegador.** Participe de um grupo (criado e entrado) no navegador, redefina a identidade e abra o app de novo com outra conta no mesmo aparelho: o IndexedDB não guarda nenhum núcleo de grupo, escritor ou réplica, e as listas `groupWriters`, `groupReplicas`, `groupDiaries` e `groupCores` estão vazias (núcleos criados por versões anteriores desta branch não estão em `groupCores`).
- **Semeador e criador bloqueado.** Bloqueie o diário que criou um grupo e confira no registro do semeador `group-rejected ... blocked` para a raiz (também logo depois de reiniciar o semeador) e `/index/group/<chave>` respondendo 404 para a raiz; os escritores dos outros membros seguem as regras de sempre. Uma raiz cujo cabeçalho nomeia um diário que nunca registrou a entrada responde `creator: null`.
- **Denúncia de grupo com texto conferido.** Abra uma denúncia de mensagem de grupo com o semeador no ar e `VARANDA_TRIAGE_TOKEN` igual nos dois serviços: o painel mostra `Texto conferido no semeador:` com o texto assinado e libera `Bloquear conta` e `Bloquear grupo`. Se o semeador não devolve a mensagem (token diferente, posição inexistente, grupo ou diário diferente da denúncia), os dois botões ficam desabilitados e `Descartar` funciona.
- **Conta sem `VARANDA_TRIAGE_TOKEN`.** Suba o serviço de conta sem o token (IA desligada): a denúncia de grupo não pode ser bloqueada por nenhum dos dois botões, e forçar `bloquear` por fora é recusado; `Descartar` funciona. Um token malformado impede a partida mesmo com a IA desligada.
- **Raiz que nomeia um diário bloqueado sem tê-la vinculado.** Bloqueie um diário D que nunca registrou a entrada com `writer` igual a G, mas que é o diário do cabeçalho da raiz G: a raiz continua servida enquanto membros a sustentam (`/index/group/<G>` responde `creator: null`). Bloqueie um criador que vinculou a raiz: ela sai, e continua recusada depois de reiniciar o semeador até a lista levantar o bloqueio.
- **Denúncia de um escritor cuja raiz o semeador já não serve (décima terceira rodada).** No painel da conta, abra uma denúncia de mensagem de um escritor de um grupo cuja raiz o semeador não serve mais (purgada ou recusada, com algum escritor do grupo ainda servido): `Bloquear conta` fica ativo, `Bloquear grupo` não aparece e o painel explica que só a conta pode ser bloqueada; forçar `bloquear` com alvo `grupo` por fora responde 409 `grupo-nao-confirmado`.
- **Aparelho novo depois da admissão.** Num grupo por aprovação, admita um membro e depois adicione um aparelho novo dele ao grupo: o aparelho novo continua oculto, e o pedido reaparece na lista dos administradores, até um administrador admitir de novo.
- **Desbanimento que não viu um aparelho.** Bana um membro, crie um aparelho novo dele e desbana sem que o desbanimento liste esse aparelho: o aparelho continua oculto até um novo desbanimento, e o membro ainda consegue sair do grupo.

## 50. Vínculo de conta pelo app nativo: segredo V e código de resgate R (PR feat/account-app-clients, 2026-10-30)

### O que mudou

- O serviço `account` aceita clientes nativos no padrão RFC 8252 (`apps/cli/lib/account/server.js`, regras puras em `apps/cli/lib/account/app-return.js`). Todos os caminhos da web ficam como estavam: cookie `__Host-varanda-link`, `Origin` exato e volta para `/?conta=`.
- Um `POST` sem `Origin` só passa com `x-varanda-client: app` e corpo JSON. Um `Origin` presente (inclusive `null`) tem de ser a origem exata.
- `POST /account/start` do app traz `appProof` (base64url do SHA-256 de um segredo V de 32 bytes, 43 caracteres, forma canônica) e não recebe cookie. `authorize`, `pending` e `finish` acham a linha por V (`x-varanda-link`), comparando em tempo constante.
- A volta do Google de uma linha do app é achada só pelo `state` de uso único. Com sucesso, o serviço sorteia R, guarda só o hash de R, aceita R por 3 minutos (`APP_REDEEM_TTL_MS`) e redireciona para `https://<domínio>/account/app/conta?conta=ok&codigo=<R>` (a origem do próprio serviço); recusas vão para `https://<domínio>/account/app/conta?conta=<resultado>` sem código. R chega ao app só pelo Auth Tab (Android) ou pelo `ASWebAuthenticationSession` (iOS) abertos pelo app, que capturam essa volta; não há entrega por `varanda://conta` nem botão no navegador. Se um navegador carregar a volta, `GET /account/app/conta` responde a página estática "Volte ao app Varanda" (sem script, sem link, CSP `default-src 'none'`, `no-store`, `no-referrer`, sem exigir emissor configurado, sem janela própria, sem ler nem registrar a consulta), que manda voltar ao app ou ligar a conta pelo site com a mesma passkey. Aparelho sem navegador com Auth Tab liga a conta Google pelo site.
- `deploy/seeder/well-known.sh`: o `assetlinks.json` passa a declarar também `delegate_permission/common.handle_all_urls`, exigido pelo Auth Tab para entregar a volta https ao app. O app não declara intent-filter https.
- `pending` exige V e R (`x-varanda-redeem`); `finish` exige V e R e gasta R na primeira tentativa, qualquer que seja o resultado.
- Escritas da volta do Google: a resposta do Google (`sub`, e-mail) de uma linha do app fica guardada só na memória ao lado da linha e só é associada a ela (`putGoogle`, que segura o @nome e conta no limite por conta Google) quando R é apresentado. A lista de espera e o convite recusados na volta só apagam a linha pendente e a reserva do convite, que não dependem da conta Google; nada é gravado em disco antes da conclusão.
- Recomeçar um vínculo com convite já assinado ou já no Google aceita V como prova de dono, como o cookie na web. Um início do app que apresenta V abandona a linha anterior desse V: ela é apagada e o `state` dela morre, então a página do Google aberta para ela não troca código nenhum. Um `state` que já pertenceu a uma linha do app (abandonada, tomada, vencida ou usada) volta sempre para a volta do app com `conta=erro`, nunca para o site e nunca com código (registro em memória, até 10 minutos depois do vencimento da linha, no máximo 10000).
- Idade: `POST /account/age/session` com o cabeçalho do app pede ao Didit a volta em `/account/age/app-return`, que ignora parâmetros e responde 302 para `varanda://idade?volta=1`, sem janela própria (só o balde global), para nunca trocar a volta por uma página de erro 429. A sessão aberta é reaproveitada só pelo mesmo tipo de cliente (web ou app), e cada cliente lê o resultado da sua sessão; a chamada que registra a aprovação apaga no Didit as duas sessões do membro.
- O serviço não guarda resposta do Google de linha que não existe mais: se a linha do app vence ou é despejada durante a troca do código, a volta é a do app com `conta=erro`, sem código, e a resposta é descartada; a cada pedido (no máximo uma vez por segundo) o serviço descarta as entradas do app, e o `sub` e o e-mail guardados nelas, cuja linha venceu ou foi despejada.

### Testes automatizados

- Novo: `apps/cli/test/app-return.test.js` (forma do `appProof`, hash de V, comparação em tempo constante, forma e hash de R, lista de resultados, URL https fixa de volta na origem do serviço, página estática sem link, sem `intent:`, sem `codigo` e sem script).
- `apps/cli/test/account.test.js`: `POST` sem `Origin` com e sem o cabeçalho, `Origin` `null` e diferente; `appProof` malformado e sem cookie; fluxo completo do app; ataque com V sem R; R repetido, R vencido 3 minutos depois da volta (pendente e conclusão), V errado com R certo, R gasto depois de conclusão recusada; a volta com R começa por `<origem>/account/app/conta?conta=ok&codigo=`; recusas da volta para `<origem>/account/app/conta`; `GET /account/app/conta` sem emissor configurado, com cabeçalhos `no-store`, `no-referrer`, `nosniff` e CSP, a página nunca mostra o código, mesmo válido na consulta, é a mesma com ou sem consulta, e a consulta fica fora dos registros; recomeço com o mesmo V (a primeira página do Google volta com `erro` sem troca de código, a nova linha conclui); recomeço com V num servidor com convites (o `state` da linha tomada volta com `erro`); linha despejada durante a troca ou vencida antes da volta dá `erro` sem código e some com a resposta do Google; entrada vencida some no pedido seguinte de qualquer rota; registros sem V, `appProof`, R, `state`, `sub`, e-mail e nonce.
- `apps/cli/test/account-age.test.js`: volta do Didit do app só com o cabeçalho; `/account/age/app-return` ignora parâmetros e responde 302 a 1300 pedidos seguidos; sessão reaproveitada só pelo mesmo tipo de cliente, nos dois sentidos, e criações simultâneas da web e do app não se misturam; a primeira chamada que aprova apaga as duas sessões no Didit.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Num servidor de teste, `curl -si -X POST https://<domínio>/account/start -H 'content-type: application/json' -d '{}'` (sem `Origin`) responde 403; com `-H 'x-varanda-client: app'` responde 400 `pedido-invalido` (corpo inválido, não 403) (não realizada ainda).
- [ ] O mesmo com `-H 'Origin: null' -H 'x-varanda-client: app'` responde 403 (não realizada ainda).
- [ ] (a) Android com Chrome 137 ou mais novo: o vínculo termina dentro do app (Auth Tab) (não realizada ainda).
- [ ] (b) Samsung Internet como navegador padrão, com o Chrome instalado: o vínculo ainda termina dentro do app, pelo Auth Tab do Chrome (não realizada ainda).
- [ ] (c) Sem navegador com Auth Tab (por exemplo, Chrome desativado): o app pede para ligar a conta pelo site e, depois de ligar pelo site com a mesma passkey, o app mostra a conta como ligada (não realizada ainda).
- [ ] (d) `curl -s https://<domínio>/.well-known/assetlinks.json` lista `get_login_creds` e `handle_all_urls` (não realizada ainda).
- [ ] (e) `adb shell am start -a android.intent.action.VIEW -d 'varanda://conta?conta=ok&codigo=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'` não muda nada no app (não realizada ainda).
- [ ] (f) Copiar o link do Google para outro aparelho continua sem concluir o vínculo (não realizada ainda).
- [ ] Cancelar no Google volta ao app com `conta=cancelado` e sem `codigo` (não realizada ainda).
- [ ] Verificação de idade pelo app: o Didit volta por `/account/age/app-return` para `varanda://idade?volta=1` e o app lê o resultado (não realizada ainda).
- [ ] `docker compose ... logs account` depois desses passos não mostra `codigo`, `state`, e-mail, `sub` nem os valores dos cabeçalhos `x-varanda-*` (não realizada ainda).
- [ ] A web segue igual: vínculo pelo navegador volta para `https://<domínio>/?conta=ok` com o cookie (não realizada ainda).

### Limites que sobram

- Outro app no mesmo aparelho pode registrar o esquema `varanda://`, mas R não passa mais por ele (volta https capturada só pela sessão de autenticação do app). Mesmo com R, sem V, que só existe na memória do app, ele não lê o pendente nem conclui.
- R é gasto na primeira conclusão, mesmo recusada (assinatura inválida, 429 ou falha passageira): o app recomeça o vínculo.
- Entre a volta do Google e o resgate de R, a linha do app ainda não conta como respondida pelo Google, então uma enxurrada de inícios pode despejá-la para dar lugar a outras (o app recebe `expirado` e recomeça).
- Quem verifica a idade pela web e pelo app na mesma hora abre duas sessões pagas do Didit (uma por tipo de cliente), porque a URL de volta é fixada na criação da sessão. As duas contam no limite de 3 sessões por membro em 24 h.
- `/account/age/app-return` não tem janela própria: uma enxurrada nele gasta só o balde global, como qualquer rota.

## 51. Identidade por passkey no app nativo (PRF) e sessão guardada no aparelho (PR feat/native-passkey-identity, 2026-10-30)

O app nativo (nó web dentro do worklet) roda a cerimônia da passkey no próprio aparelho pelo módulo local `apps/app/modules/passkey-prf` (Android: Credential Manager do `androidx.credentials`; iOS 18 ou mais novo: `ASAuthorizationPlatformPublicKeyCredentialProvider` com a extensão PRF), com o mesmo rp.id (o domínio da instalação) e a mesma entrada da PRF da web (`utf8('varanda/member-identity/prf/v1')`). Só a saída de 32 bytes da PRF cruza o IPC, em `identity.install` (docs/rpc.md 5.50). Depois de uma instalação não retomada que deu certo, a saída da PRF fica no chaveiro do aparelho (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), ligada ao rp.id e à chave pública, e vence com 30 dias sem uso; só um salvamento que deu certo chama `identity.sessionSaved`. Sair grava a marca `signedOut` no worklet (`identity.forget`) e então apaga o item; se o item não sair, a resposta é `SIGNOUT_INCOMPLETE` com o nó bloqueado.

### Testes automatizados

- Novo: `apps/app/test/passkeyOptions.test.js` (opções de criação e de entrada iguais às de `packages/web-member/lib/passkey.js`, entrada da PRF byte a byte igual a `PRF_EVAL`, base64url, `parsePrf` e `NO_PRF`, mensagens iguais às da web).
- Novo: `apps/app/test/sessionStoreNative.test.js` (sessão guardada: ligação ao rp.id e à chave, 30 dias, data mais de 1 dia no futuro, `usedAt` ausente, apagamento; identidade: `identity.install` com `resumed: false`, `identity.sessionSaved` só depois de um salvamento que deu certo, `NO_PRF` nunca instala, ordem de Sair e `SIGNOUT_INCOMPLETE`, Recomeçar apaga a sessão qualquer que seja a resposta, retomada sem cerimônia e recusas).

### Verificação humana

Nenhuma verificação foi feita ainda: a compilação nativa (Kotlin e Swift) só acontece no build do EAS, e os passos abaixo pedem aparelhos de verdade. Marcar só o que for de fato executado, com a saída.

Pré-requisitos: Android com `assetlinks.json` publicado no domínio da instalação para o pacote do app (`delegate_permission/common.get_login_creds`); iOS 18 ou mais novo com `com.apple.developer.associated-domains` contendo `webcredentials:<domínio>` (precisa do Apple Developer Program), o `apple-app-site-association` no domínio e `VarandaWebCredentials` como `true` no `Info.plist` (fica `false` até o domínio associado existir, porque o erro do iOS sem ele vem traduzido e não dá para reconhecê-lo com segurança). Sem isso, o iOS responde `UNSUPPORTED` e o app mostra o aviso do aparelho. Uma passkey sem PRF não trava o app: lança o mesmo `NO_PRF` da web e o cartão "Não deu para entrar com essa passkey" aparece, com "tentar de novo".

- [ ] Mesma chave do diário que a web, ANTES de publicar qualquer coisa: entrar na web com a passkey e anotar a chave pública (Ajustes, Identidade técnica); no app, entrar com a mesma passkey (o gerenciador de senhas oferece a passkey criada na web) e conferir que a chave pública é a mesma. Se for diferente, não publicar nada e relatar (não realizada ainda).
- [ ] Criar passkey pelo app numa instalação de teste: o app entra, e a mesma passkey abre a mesma conta na web (não realizada ainda).
- [ ] Retomada a frio: depois de entrar, encerrar o app à força e abrir de novo; ele abre já desbloqueado, sem pedir a passkey (não realizada ainda).
- [ ] Sair pede de novo: Ajustes, Sair; encerrar e abrir o app; ele pede a passkey (não retoma a sessão) (não realizada ainda).
- [ ] Aparelho ou gerenciador sem PRF: o app mostra o cartão "Não deu para entrar com essa passkey", com os passos e "tentar de novo"; nada é derivado, nenhuma chave aparece em Identidade técnica e tocar "tentar de novo" abre a cerimônia outra vez (não realizada ainda).
- [ ] Os logs do app (`adb logcat`, console do Xcode) durante entrar, retomar e Sair não mostram a saída da PRF nem o `prfHex` (não realizada ainda).

### Limites que sobram

- A saída da PRF passa pela ponte JS como texto hexadecimal (uma string não pode ser zerada); os bytes locais são zerados depois do `identity.install`.
- Criar a passkey pelo app ainda envia `excludeCredentials: []`: a web guarda em memória os ids das passkeys inutilizáveis e os exclui, o app não, então uma passkey rejeitada pode ser oferecida de novo.
- O item no chaveiro dá a identidade a quem tiver o aparelho desbloqueado (ou código rodando dentro do app) até Sair ou 30 dias sem uso. Não vai para backups nem para o iCloud Keychain.
- No iOS, se a plataforma não aplicar à entrada da PRF o mesmo prefixo "WebAuthn PRF" que o navegador aplica, a chave sai diferente da web: o primeiro passo da verificação humana existe para pegar isso antes de publicar.

## 52. Rolagem infinita em todas as listas (PR fix/infinite-scroll, 2026-10-30)

As seções 1 a 47 não mudam.

### O que mudou

- `apps/app/src/ui/RefreshableList.js` não tem mais o "mostrar mais" no estado normal. Uma só função confere o fim da lista (`endStep` em `apps/app/src/paging.js`) ao chegar ao fim, ao rolar, ao mudar o tamanho do conteúdo, ao medir a lista, quando `atEnd`, o carregador ou o erro mudam e quando termina um carregamento ou uma atualização (`spanEnd`). Uma lista mais curta que a tela (que não rola) e uma lista vazia com mais páginas carregam sozinhas.
- Um pedido de fim que chega enquanto uma página carrega não é mais descartado quando o carregamento termina com os mesmos dados (por exemplo, a leitura silenciosa de A Rua): a lista confere de novo.
- Uma página pedida pela lista que não mostra nada novo conta como seca. Depois de três seguidas (`AUTO_DRY_MAX`), a lista para e mostra "Nada novo nas últimas páginas." com o botão "carregar mais" (papel de botão, rótulo "carregar mais"), que carrega uma página e recomeça a contagem. Sair da região do fim zera a contagem e a pausa. Uma página que falha continua esperando a pessoa ("tentar de novo" ou sair do fim e voltar).
- A Rua: a leitura silenciosa durante a sincronização usa `quietNewestPlan`. Uma página cheia que cortaria linhas mostradas não troca a lista e não tira mais a lista do fim (antes, `atEnd: false` fazia a leitura `before` voltar vazia e repetir em laço); ela marca `deep` e `probeOlder`, e a próxima leitura automática (`canSyncRead`, uma vez mesmo sem crescimento) é `loadOlder({ fromSync: true })`, que acrescenta no fim as linhas mais antigas que tiverem chegado. Uma lista cheia ou já paginada sempre lê abaixo da última linha (`syncReadKind`); as mais novas chegam só pela pílula "ver novidades". O espaçamento `FEED_REARM_MS`, o recuo depois de leituras vazias e a regra de nenhuma leitura automática depois de um erro (seção 36) continuam.
- Diário: sai o limite de cinco páginas sem publicação seguidas e o efeito que as carregava; a lista conduz esses carregamentos, e um Diário vazio com mais páginas também chega ao botão da pausa.
- Avisos: "ocupado" ao carregar a próxima página vira o erro visível "Os avisos ainda estão carregando. Tente de novo.", com "tentar de novo", em vez de sumir sem nada na tela.
- A Rua e Avisos só passam o carregador quando ele de fato começaria uma página (fora da primeira carga e com cursor).

### Testes automatizados

- `apps/app/test/paging.test.js`: `nearListEnd` (lista curta está no fim, lista sem medida não), `endStep` (carrega perto do fim; parado no fim, sem carregador e depois de falha; espera ocupado; pausa em três páginas secas), `spanEnd` (fim de um carregamento que a lista não pediu confere de novo; página própria sem nada novo conta seca e a lista pede outra; página com linhas zera; falha não confere), `quietNewestPlan`, `syncReadKind` e `canSyncRead` (a sonda roda uma vez sem crescimento, nunca com erro nem fora do fim). Os testes novos falham com o `paging.js` anterior (as funções não existem; vários também codificam a regra antiga e mostram que ela falha no cenário).

Não há executor de testes de interface no navegador. O resultado de lint, dos testes e da demo fica com o orquestrador e não é repetido aqui.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado.

- [ ] Lista curta (menos linhas que a tela) com mais páginas, na web e no nativo: a próxima página vem sem rolar e sem botão (não realizada ainda)
- [ ] Rede cortada no meio da rolagem: a página falha, aparece "tentar de novo" e nada é repetido sozinho até a pessoa tocar ou sair do fim e voltar (não realizada ainda)
- [ ] Diário cheio de curtidas e outros registros técnicos: a rolagem passa por eles e, depois de três páginas sem publicação, aparece "Nada novo nas últimas páginas." com "carregar mais" (não realizada ainda)
- [ ] A Rua durante a sincronização: publicações mais antigas que chegam aparecem no fim ao rolar, e as mais novas só pela pílula "ver novidades", sem a lista pular (não realizada ainda)
- [ ] Espiadinha: as páginas continuam até o fim das rodadas, sem botão (não realizada ainda)
- [ ] Leitor de tela (TalkBack e VoiceOver): rolar pela lista carrega as próximas páginas, e o botão "carregar mais" da pausa é anunciado como botão (não realizada ainda)

### Limites

- O fim da lista é conferido pelas medidas da própria lista: se a plataforma não informar o tamanho do conteúdo depois de novas linhas, a próxima conferência espera a pessoa rolar.
- Um carregador que não começa nada quando chamado (sem conexão, uma primeira carga em andamento) é esquecido depois de 1,5 s e a lista confere o fim de novo.
- A pausa depois de três páginas secas vale por lista: numa lista curta, que não rola, só o botão "carregar mais" ou uma atualização retomam.
- Em A Rua, uma lista cheia não relê a página mais nova sozinha: as publicações mais novas que chegam dependem da pílula "ver novidades".
- Um "carregar mais" tocado quando o carregador não começa nada já tira a pausa, então a rolagem automática volta a contar três páginas secas.
- No Diário, uma página mais antiga cancelada por uma releitura (voltar à aba) conta como página seca; três seguidas pausam a lista.
- A lista em si (RefreshableList) não tem teste automatizado: só as regras puras de `paging.js` têm. As verificações acima cobrem o componente.

## 53. Conta de pagamentos: saldo, receber e pagar por Pix, taxa da Varanda (feat/hodle-pix, 2026-10-30)

As seções 1 a 47 e 49 a 52 não mudam; a 48 perde o limite da verificação perdida. Esta seção documenta o PR2: saldo, Pix de entrada e de saída, taxa da Varanda, webhook e Termos versão 8.

### O que mudou

- Modos de `VARANDA_HODLE_MODE`, em ordem: `cadastro` (padrão) < `carteira` < `pix`; `completo` vem no próximo PR. A criação da carteira tem o próprio modo: em `cadastro` ela responde 404 e o app mostra "Verificação aprovada. A carteira será liberada em breve.". O operador só define `carteira` depois que o Hodle confirmar por escrito que PINs escolhidos pelo membro funcionam em subcontas individuais.
- Em `pix`: saldo, receber por Pix (inclusive de CPF de outra pessoa) e pagar por Pix. A consulta ao Hodle é a fonte de verdade. O webhook só acelera o estado e nunca cria movimento ou dinheiro. `DISPUTE_*` vira uma marca ao lado do estado.
- Webhook (`VARANDA_HODLE_WEBHOOK_SECRETS`, lista `EVENTO:hex64`; vazia, a rota responde 404): com `EVENTO:registrar`, só um corpo cujo evento é exatamente `WEBHOOK_TEST` recebe 200 `{}`, sem verificar e sem tocar em armazenamento, e todo outro corpo recebe 401. Com `EVENTO:<hex64>`, toda entrega é verificada, `WEBHOOK_TEST` inclusive.
- Taxa da Varanda: ordem principal, taxa nova (só quando a resposta da principal diz que o Pix foi concluído; senão fica pendente) e no máximo uma taxa pendente, só de um Pix já concluído (só se as pernas anteriores deram 2xx em menos de 45 s). Como o Pix de saída costuma levar de 30 a 90 s, a taxa em geral é cobrada no próximo envio confirmado com o PIN. Pix que falha ou volta antes de concluir nunca paga taxa. Reserva: para enviar, o saldo precisa cobrir valor, taxa do Hodle, taxa nova e todas as taxas pendentes; a conferência mostra o valor reservado. A troca de moeda não tem taxa da Varanda (`VARANDA_FEE_SWAP_*` diferente de zero recusa a partida); `CRYPTO` mantém a taxa configurável. Nenhuma taxa pendente sai antes da principal. Cada perna é gravada no `wallet-ops.json` antes de sair. Prazo de 30 s por perna. PIN errado ou bloqueado na primeira perna aborta as outras. Estados: `cobrada`, `pendente`, `incerta`. Um 409 de referência existente só conta como cobrada com estado `completed` ou `txHash`. A resposta mostra principal e taxa em separado. Chamadas de dinheiro do app têm prazo de 100 s. A taxa sobre o Pix de entrada está desligada.
- `wallet-ops.json` (0600): tipo, estado, valor, taxas, id do parceiro, destino mascarado e marca de contestação. Nunca a chave Pix inteira nem o CPF. Linhas finais são apagadas depois de 90 dias, exceto enquanto uma taxa da Varanda ainda puder ser cobrada, uma contestação estiver aberta ou uma revisão de suporte estiver aberta; um Pix de entrada que falhou e ainda está sendo devolvido não conta como finalizado.
- Corrigido neste PR: um envio de KYC da segunda tentativa em diante que perde a resposta não fica mais em andamento. A lista `previousAttemptIds` separa uma tentativa anterior da nova, e a nova é adotada mesmo já encerrada. `kyc-incerto` agora só aparece quando a consulta achou o id de uma tentativa anterior.
- Variáveis: `VARANDA_HODLE_MAX_CENTS` (padrão 300000; de 100 a 100000000), `VARANDA_HODLE_WEBHOOK_SECRETS`, `VARANDA_FEE_{TRANSFER,PAYOUT,CRYPTO,DEPOSIT}_{CENTS,BPS}`, `VARANDA_FEE_SWAP_BPS` e `VARANDA_FEE_TREASURY`. `DEPOSIT` deve ficar em zero. Qualquer taxa exige a tesouraria. Taxas são recusadas na partida nos modos `cadastro` e `carteira`, e em `pix` as de transferência, `CRYPTO` e `SWAP`; só `PAYOUT` é aceita. `VARANDA_HODLE_PIN` e `VARANDA_FEE_TREASURY_PIN` com qualquer valor recusam a partida. Webhook: `EVENTO:hex64` ou `EVENTO:registrar`.
- Termos de Uso e Política de Privacidade versão 8, com novo aceite: cobranças do Pix, CPF de terceiro, taxa do Hodle como cotada, taxa da Varanda (desligada até o operador definir, sempre em reais antes de confirmar, presente no extrato, nenhuma ao receber), taxa cobrada só depois que o Pix é concluído, em geral no próximo envio confirmado com o PIN, nunca cobrada se o Pix falhar ou voltar antes, reserva das taxas pendentes no saldo, Pix concluído e depois devolvido não devolve sozinho uma taxa já cobrada.

### Testes automatizados

Todos usam o falso em `127.0.0.1` ou não abrem rede. Nenhum cobre o Hodle real, o sandbox, a tela no navegador nem o parecer.

- `node apps/cli/test/fees.test.js`
- `node apps/cli/test/hodle.test.js`
- `node apps/cli/test/wallet-ops-store.test.js`
- `node apps/cli/test/wallet-webhook.test.js`
- `node apps/cli/test/account-wallet.test.js`
- `node apps/cli/test/account-wallet-e2e.test.js` (o teste 5 é o e2e de dinheiro e taxa)
- `node apps/cli/test/account.test.js`
- `node apps/app/test/account.test.js`
- `node apps/cli/test/deploy.test.js` (variáveis só no serviço `account`)
- `node apps/cli/test/caddyfile.test.js`
- `node apps/app/test/wallet.test.js`
- `node apps/app/test/legal.test.js`
- `node apps/app/test/terms-version.test.js`
- `node packages/core/test/terms.test.js`

### Verificação manual

Nenhuma verificação manual foi feita ainda. Todos os itens estão em aberto:

1. [ ] Pagar o próprio CPF com R$ 1,00 por Pix: o app mostra valor, taxa do parceiro, taxa da Varanda e total em reais antes do PIN, e o saldo cai pelo total (não realizada ainda).
2. [ ] Depósito de terceiro: um Pix de outro CPF para a chave da conta chega ao saldo, com o Hodle habilitado para terceiros (não realizada ainda).
3. [ ] Três PINs errados: o app mostra o bloqueio, nenhuma perna seguinte sai e a tentativa de PIN gasta é uma só por toque (não realizada ainda).
4. [ ] Matar o serviço no meio de um saque e subir de novo: a operação fica `incerta`, nada é refeito sozinho e o Hodle mostra um único saque para o `externalId` `var-` (não realizada ainda).
5. [ ] A perna da taxa aparece na tesouraria, com a referência terminada em `:taxa` (não realizada ainda).
6. [ ] Uma taxa que respondeu `WALLET_BUSY` aparece como `pendente` e é cobrada no envio seguinte que a pessoa confirma com o PIN, nunca por relógio (não realizada ainda).
7. [ ] Webhook: cadastrar com `EVENTO:registrar`, copiar o segredo, trocar por `EVENTO:<hex64>` e reiniciar. Um corpo que não é `WEBHOOK_TEST` recebe 401 antes da troca, e depois dela toda entrega é verificada (não realizada ainda).
8. [ ] Sem `VARANDA_HODLE_WEBHOOK_SECRETS`, a rota de webhook responde 404 (não realizada ainda).
9. [ ] Em `cadastro`, criar a carteira responde 404 e o app mostra que a carteira será liberada em breve (não realizada ainda).
10. [ ] `wallet-ops.json` tem modo 0600 e não contém chave Pix inteira, CPF nem PIN (não realizada ainda).
11. [ ] `VARANDA_FEE_DEPOSIT_CENTS` diferente de zero recusa a partida do serviço, e uma taxa sem `VARANDA_FEE_TREASURY` também (não realizada ainda).
12. [ ] O aceite dos Termos e da Política versão 8 aparece de novo para quem aceitou a versão 7 (não realizada ainda).
13. [ ] Nenhum teste desta etapa abre rede externa. Só `127.0.0.1` (não realizada ainda).
14. [ ] Com taxa de `PAYOUT` ligada, pagar por Pix: a taxa nova fica `pendente` enquanto o Pix não for concluído e só é cobrada no envio seguinte confirmado com o PIN, depois do Pix concluído. Um Pix que falha ou volta antes de concluir nunca tem a taxa cobrada (não realizada ainda).
15. [ ] Com uma taxa pendente, tentar enviar com saldo que cobre valor, taxa do Hodle e taxa nova mas não todas as pendentes: o serviço recusa com saldo insuficiente. Com saldo suficiente, a conferência mostra o valor reservado para taxas pendentes, e esse valor continua no saldo depois do envio (não realizada ainda).

### Limites

- Não há tela de contestação: `DISPUTE_*` só marca a operação.
- A taxa sobre o Pix de entrada está desligada.
- Um Pix devolvido não devolve sozinho uma taxa da Varanda já debitada.
- O sandbox da Hodle não exercita subconta. O que os testes provam é o falso de loopback.
- A ida ao ar depende do parecer jurídico, inclusive sobre o Código de Defesa do Consumidor.

## 54. Web hospedada conectada enquanto visível (PR perf/stay-connected, 2026-10-30)

As seções 1 a 53 não mudam, exceto "Duty cycle" (seção 17), marcada como substituída.

### O que mudou

- `packages/web-member/web/node.js` passa `leaseHoldMs: 0`: a rodada contínua da web hospedada não termina mais com `'idle'` depois de 8 s nem espera 45 s sem discar. Uma aba visível mantém a conexão com o semeador (uma vaga externa por aba); a aba oculta continua parando a sincronização (`shouldStopForHidden`) e, ao voltar, começa uma rodada nova.
- A lease continua no código como saída de emergência para capacidade. As esperas de 45 s do app só valiam depois de um `'idle'` e ficaram inalcançáveis; o app não mudou.
- A conexão é mantida viva pelo keepalive do Hypercore (a cada 5 s); o semeador derruba um socket externo sem dados depois de 30 s. Uma conexão que cai disca de novo (1 s dobrando até 30 s); com o semeador cheio, a resposta 1013 vira "Semeador ocupado".

### Testes automatizados

- `packages/web-member/test/resume.test.js`: o nó que `web/node.js` cria recebe `leaseHoldMs` 0 (falha com 8000).
- `packages/web-member/test/lease.test.js`: com a lease desligada e um semeador de mentira que usa `noise.setTimeout(6000)` como o real, um enlace estabelecido passa de 13 s com um só socket e sem parar (documenta o keepalive de que a decisão depende; passa antes e depois).

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado.

- [ ] Uma aba visível mantém um socket com o semeador por vários minutos e uma publicação nova de outro aparelho chega em poucos segundos (não realizada ainda)
- [ ] Uma aba oculta para a sincronização e libera a vaga; ao voltar, reconecta (não realizada ainda)
- [ ] Com o semeador no limite de `VARANDA_MAX_EXTERNAL`, a próxima aba é recusada com "Semeador ocupado" e tenta de novo (não realizada ainda)

### Limites

- Capacidade: cada aba visível segura uma vaga externa o tempo todo. Dimensione `VARANDA_MAX_EXTERNAL` para as abas visíveis ao mesmo tempo mais folga para os links curtos da Espiadinha e dos Avisos; `apps/cli/scripts/load-ws.js` mede conexões seguradas.
- Não há teste automatizado no navegador nem medição em semeador real.

## 55. Partida mais rápida da sincronização na web (PR perf/faster-sync-startup, 2026-10-30)

### O que mudou

- Na web hospedada (nó do navegador, `packages/web-member`), numa visita de volta, toda leitura de membro espera a rodada abrir o próprio diário e as réplicas seguidas (seção 46). Essa partida era sequencial: para cada seguido, uma checagem de existência, a abertura da réplica (leituras inteiras do IndexedDB), o teste de bifurcação, `has(0)` e a verificação do bloco 0 (ed25519 em JavaScript puro), um de cada vez. E o próprio diário era decodificado duas vezes: na varredura do comprimento presente e de novo na leitura dos registros `follow`, cujo cursor recomeçava em 1 a cada rodada.
- `lib/sync.js`, réplicas seguidas: a partida tem três passos. Primeiro, na ordem da lista, valida, descarta repetidas e marca as bloqueadas, como antes. Depois abre e verifica até 8 réplicas ao mesmo tempo (`MAX_PARALLEL_OPENS`), cada resultado no seu lugar, sem tocar em estado compartilhado, e nenhuma abertura começa depois que a rodada está terminando. Por último, em série e na ordem da lista, aplica o mesmo de antes: estado do seguido, eventos `skipped`, ativação, limpeza das rejeitadas e parada numa limpeza que falhou. Num término, numa limpeza que falhou ou num erro, todo núcleo aberto e ainda não usado é fechado antes de seguir. Cada chave abre uma vez só; nada mais abre réplicas antes da primeira conexão.
- `lib/sync.js`, registros `follow`: `trackPresent` ganha `onScan(state)`, chamado com o resultado da varredura inicial. O rastreador do próprio diário usa essa varredura para semear a leitura dos registros `follow` abaixo do comprimento presente (mesmas regras: `decodeBlock` e `validRecordCopy`, seq a partir de 1, a última operação por chave vale, a chave própria é ignorada, os apagados ficam de fora, com o conjunto de apagados do momento da leitura) e começa o cursor ali. A lista gravada e o `follows-changed` são os mesmos de antes para o mesmo diário.
- `lib/member-ops.js`, leituras emprestadas: com os núcleos da rodada, a réplica que a rodada já tem é lida direto, sem perguntar ao armazenamento se ela existe. Só uma chave que a rodada não tem consulta o armazenamento (sem dados: nada, como antes; guardada mas fora da rodada: caminho exclusivo, como antes). As respostas não mudam.
- A varredura de chaves bloqueadas continua consultando o armazenamento diretamente (`docs/protocol.md`, normativo). Nenhum documento normativo muda.

### Testes automatizados

- `packages/web-member/test/sync-gate.test.js`: 12 seguidos (2 com certificado de outra associação) com aberturas atrasadas para inverter a ordem de chegada: pico de aberturas simultâneas acima de 1 e no máximo 8, cada chave aberta uma vez, `skipped` e o inventário enviado ao semeador na ordem da lista, aberturas iguais a fechamentos. Uma rodada interrompida durante as aberturas termina com aberturas iguais a fechamentos e sem abrir as demais. Sem a mudança, o pico fica em 1 e o teste falha.
- `packages/web-member/test/sync-media.test.js`: cada bloco do próprio diário depois do certificado é lido uma vez na partida (antes, duas), com a mesma lista e o mesmo `follows-changed`.
- `packages/web-member/test/read-while-sync.test.js`: `feed.read` e `profile.read` emprestados não consultam `hasCore('replica/' + chave)` para a réplica que a rodada tem (antes, 1 vez por leitura). O teste do caminho exclusivo continua cobrindo `NEEDS_EXCLUSIVE`.
- `packages/web-member/test/delete-purge.test.js`: o teste de um registro `follow` cuja leitura falha uma vez dependia de a partida ler o registro pela leitura dos seguidos, o que não acontece mais. Agora o registro chega depois da partida: a cópia do semeador (gravável, como outro aparelho) recebe o registro depois do primeiro `own-synced`, a primeira leitura dele falha, e um bloco seguinte dispara a leitura que o aplica.
- `packages/web-member/scripts/startup-bench.js` (fora da CI): mede, no Node, o tempo entre `runSync` e a publicação do leitor, com as checagens de existência, as aberturas de réplica (e o pico simultâneo) e as leituras de blocos do próprio diário. Os tempos no Node não valem para o navegador; as contagens é que comparam. Resultado nesta máquina:

| Cenário | Antes | Depois |
|---|---|---|
| 50 seguidos x 20 blocos, diário 200, memória, 5 rodadas | mediana 22.2 ms; pico 1; 398 leituras | mediana 16.1 ms; pico 8; 199 leituras |
| 50 seguidos x 20 blocos, diário 200, fake-indexeddb, 5 rodadas | mediana 78 ms; pico 1; 398 leituras | mediana 71.1 ms; pico 8; 199 leituras |
| 200 seguidos x 10 blocos, diário 400, fake-indexeddb, 3 rodadas | mediana 466.1 ms; pico 1; 798 leituras | mediana 387.5 ms; pico 8; 399 leituras |

Em todos os cenários, as checagens de existência e as aberturas ficam iguais ao número de seguidos.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Web hospedada, visita de volta com muitos seguidos: medir o tempo entre desbloquear e a primeira linha de A Rua, antes e depois desta PR (não realizada ainda).
- [ ] Na mesma visita, as ferramentas de desenvolvedor mostram as aberturas das réplicas sobrepostas e nenhum `'preempted'` causado por uma leitura (não realizada ainda).
- [ ] Um diário seguido bloqueado e um com certificado inválido continuam aparecendo como ignorados, na mesma ordem (não realizada ainda).
- [ ] Seguir alguém em outro aparelho: a lista de seguidos deste navegador atualiza depois que o diário próprio fica em dia, como antes (não realizada ainda).

### Limites

- No navegador o ganho depende de quanto o IndexedDB e a verificação ed25519 se sobrepõem; o bench no Node com fake-indexeddb não mede isso.
- Até 8 réplicas abertas ao mesmo tempo na partida aumentam o pico de memória dessa fase.
- A varredura de bloqueados e a de emissores revogados continuam em série, depois das aberturas.

## 56. Diários seguidos baixam o mais novo primeiro (PR perf/newest-first-sync, 2026-10-30)

### O que mudou

- Na web hospedada (nó do navegador, `packages/web-member`), um diário seguido baixava em uma só faixa linear, do bloco 0 ao fim, e A Rua só mostrava o que estava no prefixo contínuo. Com histórico longo, os posts novos eram os últimos a aparecer.
- `lib/sync.js` `trackPresent`: com `newest` maior que 0 (diários seguidos, `NEWEST_BLOCKS` = 32), o download tem duas fases estritas, nunca as duas ao mesmo tempo (o Hypercore 10.38.2 sorteia entre as faixas abertas de um núcleo). A cabeça pede os blocos 0 a 2 (só eles enquanto falta o bloco 0), espera o comprimento assinado quando o semeador anunciou mais do que o núcleo conhece (nada é pedido além do comprimento assinado) e então pede os 32 blocos mais novos, sem os apagados. O corpo é o download linear de antes, a partir do bloco 0. O corpo começa quando a janela já encosta no prefixo (diário pequeno: igual a antes), quando a janela inteira está guardada ou apagada, ou quando a janela não trouxe bloco nenhum por `HEAD_STALL_MS` (3 s). `runSync` aceita `newestBlocks` e `headStallMs` (testes). O próprio diário continua do mais velho para o mais novo.
- `lib/node-store.js` `readVisible`: o prefixo de `readAll` mais a sequência contínua de blocos que termina no comprimento assinado (um buraco nela só passa se uma tombstone guardada o aponta), só com o bloco 0 guardado e dentro de `MAX_LOG_BLOCKS`. Uma tombstone vem sempre depois do alvo, então toda tombstone que pode apagar um bloco da sequência está nela.
- `lib/member-ops.js`: `feed.read` e `profile.read` (admissão e nome) leem com `readVisible`; `log.read` continua só com o prefixo. `incomplete` mantém o valor (comprimento presente abaixo do assinado), com nova definição em `docs/rpc.md` 5.13.
- Tudo o que é anunciado ou medido (hello, `have`, `downloaded`, metas, `settled`) continua no comprimento presente. Documentos normativos: `docs/rpc.md` 5.12, 5.13 e 5.21; `docs/protocol.md` §2 e §6 "Browser node download order".

### Testes automatizados

- `packages/web-member/test/sync-gate.test.js`: com 300 blocos, o semeador envia o bloco 0 primeiro, depois {1, 2} e [268, 300), depois o resto (sem a mudança, falha: o envio é linear). Um semeador sem o meio do diário: A Rua mostra o prefixo e os 32 mais novos, com `incomplete`, e o histórico quando o semeador o recebe (sem a troca de leitura, falha). Visita de volta: os envios começam em [268, 300) e nenhum `have` passa de blocos não guardados (sem a mudança, falha). Semeador que retém os blocos mais novos (`headStallMs: 200`): o histórico baixa assim mesmo. O próprio diário continua em ordem de blocos.
- `packages/web-member/test/member.test.js`: réplica com [0, 3) e os blocos mais novos: o feed mostra prefixo e sequência nova, nada do meio, nos caminhos exclusivo e emprestado; uma sequência que não chega ao comprimento assinado mostra só o prefixo; uma tombstone na sequência esconde o alvo no prefixo e na sequência, guardado ou limpo; bloqueado e emissor revogado continuam escondidos do feed e do perfil; `profile.read` usa o perfil mais novo da sequência e um perfil só no meio lê `null`; a paginação com `before` passa pela sequência e depois pelo prefixo, sem repetir; `log.read` termina no comprimento presente. Sem a troca em `member-ops.js`, cinco desses falham.
- `packages/web-member/test/delete-purge.test.js`: com `download()` registrado, só as faixas da cabeça abrem ([0, 3), [268, 280), [281, 300), o 280 apagado fica de fora), a faixa do corpo só abre com a janela guardada e as da cabeça fechadas, e o bloco apagado nunca chega (sem a mudança, falha). Diário dentro da janela, e `newest` 0, abrem o corpo de uma vez.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Navegador novo, seguindo contas com histórico longo: A Rua mostra os posts mais novos de cada conta em poucos segundos, enquanto o histórico completa (não realizada ainda).
- [ ] Visita de volta depois de as contas postarem bastante: os posts novos aparecem antes do histórico que faltava (não realizada ainda).
- [ ] Semeador sem o meio de um diário: A Rua mostra o começo e os mais novos, e o resto quando o semeador o tiver (não realizada ainda).
- [ ] Um nome pode aparecer como "sem nome" por um instante, até chegar o bloco do perfil (não realizada ainda).

### Limites

- A Rua atualiza quando o comprimento presente cresce: os posts mais novos aparecem cerca de uma ida e volta depois do bloco 2, ou ao puxar para atualizar se o semeador não tem o meio do diário.
- Um perfil que está só no meio do diário lê "sem nome" até o histórico chegar.
- Um semeador que anuncia um comprimento que não serve atrasa o histórico em no máximo 3 s por crescimento do comprimento.
- Blocos guardados entre o prefixo e a corrida mais nova não aparecem: se um diário ainda no meio do histórico cresce, a corrida anterior some até chegar a ponta nova, e curtidas desfeitas, exclusões ou um perfil novo guardados nesse trecho só valem quando o histórico chega até eles. Mostrar esse trecho não é seguro (uma lápide pode estar num buraco depois dele); aplicar só os registros dele pediria mudar o `buildFeed` de `packages/core`.

## 57. A Rua relê o trecho mostrado enquanto os seguidos sincronizam (PR fix/rua-sync-refresh, 2026-10-30)

### O que mudou

- Na web hospedada, A Rua mostrava "Isso é tudo por enquanto." com publicações de seguidos já guardadas no aparelho, e só puxar ou rolar à mão as trazia. Duas causas, reproduzidas com um semeador real e o nó do navegador:
  - Visita de volta: a réplica guardada tem comprimento igual ao presente até chegar a atualização do Hypercore (cerca de 1 s), então a primeira leitura vinha com `incomplete` vazio, a linha de base ficava vazia e `canSyncRead` nunca mais ficava verdadeiro; as linhas `downloaded` seguintes só acendiam a pílula.
  - Lista longa: com uma linha de base válida, a leitura automática de uma lista funda ou cheia era sempre `before` abaixo da última linha. Com o download do mais novo primeiro (seção 56), o histórico chega ENTRE as mais novas e a última mostrada, então toda leitura automática voltava vazia, a espera crescia até 32 s e, quando o download acabava, `incomplete` esvaziava e o rodapé anunciava o fim com linhas faltando.
- `apps/app/src/paging.js`: `syncBaseline` grava todos os comprimentos conhecidos no momento da leitura (mais os diários incompletos e os sem certificado em -1), e `advancedKeys` conta como crescimento uma chave que cresceu ou que apareceu depois da leitura. Continuam as regras de antes: nada automático durante uma leitura, depois de `loadError` ou `moreError`, nem antes do intervalo de `FEED_REARM_MS` com a espera de `rearmDelay`.
- `syncReadKind` tem o tipo novo `range`, usado por uma lista funda ou cheia; `older` fica só para a sonda abaixo da lista. `planSyncRead` junta a condição, o tipo e a espera (leituras `range` e `older` vazias aumentam a espera). A leitura `range` (`loadRange` em `ARua.js`) pede páginas de 31 a partir de logo abaixo da primeira linha mostrada (`rangeStart`) até uma página chegar ao cursor da lista (`reached`), voltar curta (`end`) ou bater o teto de `rangePageCap` (ceil(mostradas/31)+1, no máximo 10); uma leitura cortada pelo teto guarda `rangeFrom` e a próxima continua dali sem precisar de crescimento novo. `mergeRange` encaixa as linhas na ordem do feed sem tirar nenhuma mostrada (como `mergeOlder`); as mais novas que a primeira linha não entram e contam para a pílula. Depois de `reached` com página cheia, a próxima leitura é a sonda abaixo da lista, como depois de uma página mais nova cheia.
- A linha de base só avança para comprimentos tirados no INÍCIO de uma leitura que cobriu todo o trecho mostrado: uma recarga que trocou a lista, ou uma sequência de releitura (as páginas `range` e as continuações de `rangeFrom` guardam em `seqBase` os comprimentos de antes da primeira página; `sequenceBase`). Uma página abaixo da lista (rolagem ou sonda, `olderPagePatch`) só acrescenta linhas: não avança a linha de base nem encerra uma sequência pendente. Assim uma publicação que chegou no trecho já lido dispara outra leitura `range` em vez de ser dada como lida.
- Só as leituras no fim da lista esperam por ele (a sonda abaixo da lista e a página mais nova de uma lista curta). A leitura `range` relê o trecho mostrado, então roda com a pessoa em qualquer ponto da lista (no topo de uma lista longa, por exemplo), sempre que os comprimentos passam da linha de base ou há continuação pendente. `rangeEnd` mantém o `atEnd` de antes: uma lista que não estava no fim continua paginando pela rolagem, sem sonda.
- `waitForCatchUp` (a janela de silêncio de puxar para atualizar) também empurra a janela com uma linha `newest`, como com `downloaded`.
- A leitura mais nova automática de uma lista curta que voltaria cheia e cortaria linhas passa a ser a primeira página de uma leitura `range` (antes só marcava a sonda abaixo da lista).
- `feedSyncing`: o rodapé e o estado vazio dizem "Ainda sincronizando quem você segue." enquanto há `incomplete`, crescimento depois da última leitura, sonda ou leitura `range` pendente.
- `apps/app/src/syncSignals.js`: a linha `newest <chave> <comprimento>` (os posts mais novos de um diário seguido chegaram; vem no PR do nó) fica num mapa próprio (`signals.newest`), acende a pílula e dispara a leitura automática. `lengths` continua sendo só o comprimento presente das linhas `downloaded`, para que o histórico que chega depois ainda conte como crescimento. `syncLengths` junta os dois mapas (o mais novo sob `newest:<chave>`) para a linha de base, o gatilho e o rodapé. Linhas desconhecidas continuam ignoradas.
- `apps/app/src/ui/RefreshableList.js`: a opção `keepVisiblePosition` (só A Rua usa) passa `maintainVisibleContentPosition` `{ minIndexForVisible: 0, autoscrollToTopThreshold: 24 }` à `FlatList` (React Native 0.83.10), então no app nativo as linhas encaixadas acima da que a pessoa lê não a empurram para baixo; perto do topo a lista acompanha as linhas novas, e a recarga pela pílula continua mostrando as mais novas. As outras listas não mudam.

### Testes automatizados

- `apps/app/test/paging.test.js`: lista funda com cursor na última linha, linha de base `{k: 51}`, comprimentos `{k: 147}` e `emptyStreak` 1 planeja `range`, não `older`; uma página com `incomplete` e `skipped` vazios seguida de crescimento (réplica guardada ou chave que aparece depois) libera `canSyncRead`; `mergeRange` encaixa as linhas na ordem do feed, guarda as mais novas para a pílula e não corta nada; o laço de páginas para no cursor, numa página curta e no teto, e `rangeEnd` decide cursor, sonda e continuação; regra do rodapé. Sem a mudança em `paging.js`, falham os testes da linha de base, do crescimento e do tipo de leitura (asserções), e os de `planSyncRead`, `mergeRange`, `rangeStep` e `feedSyncing` (funções ausentes).
- `apps/app/test/paging.test.js`, depois da revisão: crescimento durante uma sequência cortada pelo teto planeja outra leitura `range`; a sonda depois de `reached` não consome o crescimento da sequência e, com comprimentos acima da foto inicial, a próxima leitura é `range`; rolar abaixo da lista com uma página cheia e depois chegar ao fim não avança a linha de base nem encerra a sequência, e o crescimento durante a rolagem planeja `range`. Com `sequenceBase` medindo dos comprimentos atuais, o primeiro falha; com a página abaixo da lista gravando a linha de base dos comprimentos atuais (a regra anterior), os outros dois falham.
- `apps/app/test/syncSignals.test.js`: `newest <chave> <n>` fica em `signals.newest`, não sobe `lengths`, acende a dica, e um `downloaded` menor que o mais novo ainda conta como crescimento por `syncLengths`; formatos errados e rodada antiga são ignorados. Com `newest` gravado em `lengths` (a primeira versão deste PR), seis asserções falham.
- `apps/app/test/paging.test.js`: com a lista longe do fim, crescimento ou continuação pendente planejam `range`; a sonda e a página mais nova de lista curta esperam o fim; `rangeEnd` com a lista fora do fim não cria sonda. Com a regra anterior (tudo só no fim), falha.
- `apps/app/test/syncSignals.test.js`: uma linha `newest` empurra a janela de silêncio de `waitForCatchUp`. Sem a mudança, falha.
- `maintainVisibleContentPosition` não tem teste automático: depende da rolagem nativa, que os testes em Node não rodam.
- Reprodução com semeador real (`Seeder` em processo atrás da entrada WebSocket, 3 autores, rede local presa a `127.0.0.1`), repetindo a lógica de leitura de A Rua com o `paging.js` e o `syncSignals.js` deste PR e o nó da `main`, sem nenhuma leitura manual depois da carga inicial:
  - Navegador novo, 600 publicações, latência de 40 ms: antes, 147 mostradas de 600 e rodapé "Isso é tudo por enquanto."; agora, 600 de 600 em cerca de 7 s, com três leituras automáticas.
  - Visita de volta com a primeira leitura antes da atualização (60 publicações novas por autor, latência de 200 ms): antes, nenhuma leitura automática e 300 mostradas de 480; agora a leitura automática acontece e as 180 que faltam são todas mais novas que a primeira linha mostrada, com a pílula "ver novidades" acesa (regra de sempre: nada entra no topo embaixo da pessoa). Com a primeira leitura depois da atualização, 480 de 480.
  - Navegador novo com a primeira leitura só com o começo de cada diário (3 linhas): 401 mostradas e as 199 restantes todas mais novas que a primeira linha, com a pílula acesa.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Navegador novo na web hospedada, seguindo contas com histórico longo: A Rua completa as publicações mais antigas sozinha, sem puxar nem rolar (não realizada ainda).
- [ ] Visita de volta depois de as contas postarem: a pílula "ver novidades" aparece e A Rua completa sozinha o que faltava no trecho mostrado (não realizada ainda).
- [ ] Enquanto sincroniza, o rodapé diz "Ainda sincronizando quem você segue." e nunca "Isso é tudo por enquanto." (não realizada ainda).

### Limites

- As publicações mais novas que a primeira linha mostrada só entram pela pílula "ver novidades" ou ao puxar, como antes.
- Cada leitura `range` relê até 10 páginas; no app nativo cada pedido ainda interrompe a rodada de sincronização (docs/rpc.md seção 6.1), limitado pelo intervalo e pela espera de `rearmDelay`.
- Uma chave que aparece pela primeira vez no mapa de comprimentos (por exemplo, pelo resultado de uma rodada parada) dispara no máximo uma leitura a mais.
- Na web, o react-native-web 0.21.3 descarta `maintainVisibleContentPosition` (não está entre as propriedades que ele repassa). O que segura a linha lida é a ancoragem de rolagem do próprio navegador (CSS `overflow-anchor`), que pode variar entre navegadores; não foi conferido em aparelho.

## 58. Janela mais nova sinalizada e ponta nova inteira na volta (PR perf/newest-window-signal, 2026-10-30)

### O que mudou

- Na web hospedada, depois do PR da seção 56, dois problemas apareceram com um semeador real. (1) Quando a janela dos 32 blocos mais novos chegava, o nó não emitia linha nenhuma de `sync.event`: o comprimento presente fica parado no prefixo enquanto a janela baixa, e só o crescimento dele gerava `downloaded`, então a leitura automática de A Rua esperava o histórico. (2) Depois de um crescimento, `readVisible` mostra só a sequência que termina no comprimento NOVO: a janela guardada numa sessão anterior sumia até a ponta nova baixar (o feed caía de 99 itens para 3 por alguns segundos).
- A regra estrita de leitura fica como está (decisão do responsável pelo produto, depois de um achado de segurança: mostrar todo bloco guardado deixaria um post apagado visível por minutos, porque a tombstone fora da janela só baixa quando o corpo linear chega nela). `readVisible` continua: o prefixo mais a sequência contínua guardada que chega ao comprimento assinado, um buraco nela só passa se a dobra efetiva o apaga, julgado num retrato só, com o bloco 0 e dentro de `MAX_LOG_BLOCKS`. A única diferença é que um buraco que a sequência passa não entra mais na lista (o `log.read` o pula).
- `lib/sync.js`, sinal: quando a cabeça encontra a janela inteira guardada ou apagada (o passo que entrega ao corpo), a sincronização emite `newest <chave> <comprimento>`, uma vez por chave e comprimento assinado, pelo mesmo caminho das linhas `downloaded` (`lib/session.js`, com `safe()`). Um diário ainda em `regate` guarda o aviso até o bloco 0 passar pela porta local. Nada anunciado ou medido muda: hello, `have`, `downloaded`, metas e `settled` continuam no comprimento presente.
- `lib/sync.js`, ponta nova inteira: se a réplica já tem uma sequência guardada acima do prefixo cujo topo `T` (o bloco mais alto que a varredura inicial achou, depois o fim de cada janela completada) está a no máximo `TAIL_MAX` (256) blocos do comprimento assinado, a janela da cabeça começa em `T`: baixa toda a ponta nova `[T, comprimento)`, sem os apagados, e a sequência que já aparecia volta a chegar ao comprimento novo assim que ela chega. Crescimento maior mantém a janela dos 32 mais novos. Um novo crescimento na mesma sincronização usa a mesma regra a partir da última janela completada. `runSync` aceita `tailBlocks` (testes).
- `lib/member-ops.js` e `lib/session.js`: `log.read` de um autor seguido (não o próprio) lê os mesmos blocos que `feed.read` e pagina por seq: a janela termina em `before` (exclusivo) e traz até `limit` desses blocos, os de seq mais alta abaixo dele; blocos não guardados são pulados sem aparecer em `invalid`, um bloco guardado malformado continua em `invalid`, e `entriesTruncated` conta os blocos abaixo da janela. O próprio diário não tem buracos e responde igual a antes.
- `incomplete` não muda: comprimento assinado acima do presente.
- Documentos normativos: `docs/rpc.md` 5.12 e §6 (linha `newest`); `docs/protocol.md` §6 "Browser node download order".

### Testes automatizados

- `packages/web-member/test/sync-gate.test.js`: visita de volta com o semeador tendo a ponta nova mas não o meio: a linha `newest <chave> 300` chega, nenhum `downloaded` da chave vem enquanto falta o histórico, o post mais novo está no feed, e quando o histórico chega a linha `newest` veio antes do primeiro `downloaded` da chave, uma vez só (sem a chamada `onNewest`, falha). Seguidor com [0, 3) e a janela antiga [68, 100), o autor posta mais 40 e o semeador tem só [108, 140): a cabeça espera [100, 108) (sem `newest` enquanto falta), e quando o semeador os recebe todo bloco de [100, 140) é pedido e o feed volta a mostrar a janela antiga com a ponta (sem a regra da ponta, falha: a janela [108, 140) completa sozinha). Com `tailBlocks: 16`, a mesma volta pede só a janela dos 32 mais novos e o feed mostra só ela.
- `packages/web-member/test/member.test.js`: `log.read` de um autor seguido traz o prefixo e a sequência mais nova por seq, sem o bloco apagado e limpo que a sequência passa e com o apagado guardado marcado (sem a troca em `member-ops.js` ou sem o filtro em `node-store.js`, falha). Os testes estritos existentes (sequência que não chega ao comprimento, tombstone que chega depois da varredura, buraco nomeado só por tombstone cancelada, bloqueado e emissor revogado) seguem sem mudança.
- `packages/web-member/test/read-while-sync.test.js`: diário seguido com buracos e um bloco malformado no prefixo: o feed mostra prefixo e sequência mais nova, sem a ilha do meio; `log.read` com `limit` 5 pagina por seq (12 a 16 com 6 abaixo; depois 1, 2, 4, 11 com o 3 em `invalid` `malformed` e 1 abaixo; depois 0), um `before` dentro de um buraco termina no bloco visível abaixo, e com a sincronização ativa (caminho emprestado) as respostas são as mesmas, sem preempção. Sem a mudança em `member-ops.js` ou em `session.js`, falha.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Reabrir a web hospedada depois de as contas seguidas postarem alguns posts: A Rua continua com os posts que mostrava, ou volta a mostrá-los em cerca de um segundo (não realizada ainda).
- [ ] Na mesma situação, os posts mais novos aparecem antes do histórico que faltava, sem puxar para atualizar (com o PR do app) (não realizada ainda).

### Limites

- Crescimento de mais de 256 blocos desde a última visita: a janela antiga ainda some até o histórico chegar até ela (só os 32 mais novos aparecem antes).
- Até 256 blocos são pedidos pela cabeça antes do corpo; se o semeador não tem parte da ponta, a cabeça espera `HEAD_STALL_MS` (3 s) sem bloco novo antes de passar ao corpo.
- `newest` é só um aviso: chega uma vez por comprimento assinado, e uma janela que nunca completa (semeador sem ela) não gera aviso; nesse caso a leitura espera o crescimento do comprimento presente, como antes.

## 59. Comunidades (PR feat/communities)

Segunda parte de Cadeiras de Praia: uma comunidade junta grupos públicos, `docs/protocol.md` seção 10 ("Communities") e `docs/rpc.md` 5.57 a 5.60. A raiz da comunidade (cabeçalho `kind: 'community'`) guarda só `group-meta`, `group-admin` e `group-link`; a raiz do grupo guarda `community-link`. O vínculo só vale com os dois lados ligados, um grupo fica em uma comunidade por vez e uma comunidade conta no máximo 32 grupos. O criador e os administradores da comunidade agem como administradores em todo grupo vinculado dos dois lados (banir, admitir, ocultar), nunca nomeiam administradores de grupo.

### Como verificar

Do repositório, cada arquivo roda sozinho (`node <arquivo>`); a suíte inteira roda com `npm test`.

| Arquivo | O que cobre |
|---|---|
| `packages/core/test/group.test.js` (testes de comunidade) | registros `group-link` e `community-link`, construtores, `buildGroup` com `communities` (vínculo dos dois lados, raiz vinculada pelo criador, uma comunidade por grupo, teto de 32 grupos, cortes de vínculo e de nomeação, rebaixamento e desvínculo, raízes ausentes ou bifurcadas, ordem de entrega) e `buildCommunity` |
| `packages/core/test/community-member.test.js` | `community.create`, `community.link`, `community.admin`, `community.info` no nó do núcleo, `group.info` com `communities`, recusas e idempotência |
| `packages/core/test/sync-communities.test.js` | sincronização do núcleo: raízes de comunidade seguidas pelos vínculos, portão por papel, `not-community`, evento `community-linked` |
| `packages/core/test/seeder-communities.test.js` | semeador: admissão da raiz de comunidade, página com só a raiz, raiz sem vínculo do criador |
| `packages/core/test/group-index.test.js` | índice do semeador: `community` nas linhas de `/index/group`, `/index/community/<C>`, busca só de grupos |
| `packages/web-member/test/community-ops.test.js` | os mesmos métodos no nó do navegador (`member-ops.js`) |
| `apps/cli/test/community-commands.test.js` | comandos `community create|link|admin|info` da CLI, saída `--json` e recusas |
| `packages/web-member/test/groups-e2e.test.js` (segundo teste) | ponta a ponta em loopback: semeador real atrás de WebSocket e na DHT local; o criador (núcleo) vincula grupo e comunidade, nomeia uma administradora (outro nó do núcleo) que oculta uma mensagem, vista oculta pelo criador e pelo nó do navegador; rebaixada sem ter sincronizado, ela oculta outra mensagem, e essa ocultação não vale para os dois nós, enquanto a anterior continua |

### Checagens humanas (a fazer)

- CLI: `varanda community create --name <nome>` imprime `comunidade criada: <chave>`; `community info <chave>` mostra nome, criador e nenhum grupo.
- Vincular dos dois lados: com outra pessoa dona do grupo, `community link <comunidade> <grupo>` de quem criou a comunidade imprime `vínculo gravado (lado: comunidade)`; `community info` ainda não lista o grupo. Depois de a dona do grupo rodar o mesmo comando (`lado: grupo`) e de uma sincronização, os dois lados listam o grupo e `group info <grupo> --json` mostra `communities` com a chave.
- `community admin <comunidade> --member <diário>`: a pessoa nomeada oculta uma mensagem do grupo vinculado; no navegador, a mensagem aparece como oculta depois da sincronização.
- Rebaixar (`--undo`): uma ocultação nova da pessoa rebaixada não vale; as anteriores continuam.
- Desvincular (`community link ... --undo`) de qualquer lado: o grupo sai de `community info` e a pessoa administradora da comunidade perde o poder no grupo.
- Semeador: `curl /index/community/<C>` numa comunidade vinculada dos dois lados mostra o grupo com `writerCount`; desvincular de qualquer lado tira o grupo, e `/index/group/<G>` passa a mostrar `community: null`.
- Bloquear a raiz da comunidade: `/index/community/<C>` responde 404 e o log do semeador mostra `group-rejected` com `group-blocked`.

### Não verificado / limites conhecidos

- Um aparelho de uma pessoa administradora que existia antes do vínculo e que o criador do grupo não guardava conta a partir do início da nomeação, não do vínculo.
- Depois de um desvínculo, um novo vínculo só vale para os escritores que ele lista.
- Um grupo cujos vínculos já nomearam mais de 32 comunidades distintas fica marcado como incompleto.
- O índice do semeador é só uma dica e ignora a retirada de registros por saída (`group-leave`).
- A raiz vinculada que deixa de ser nomeada antes do portão (`unwanted`) não tem teste.
- Um grupo cuja comunidade foi bloqueada pela associação não consegue desligá-la nem ligar outra (o pedido recusa a comunidade bloqueada antes do `on: false`); a autoridade não muda, porque uma raiz bloqueada nunca entra na dobra.
- Num desligamento ou rebaixamento com mais escritores que o teto, cada nó lista os primeiros em ordem de chave e omite o resto (cortado em 0); o nó do núcleo conta também escritores guardados ainda não vinculados e o navegador só os vinculados, então os dois podem gravar listas diferentes para o mesmo pedido (os dois são seguros). A ramificação do navegador que deixa em repouso um escritor guardado sob uma chave só ligada não tem teste.
- Núcleos de escritor que nomeiam uma comunidade são admitidos pelo semeador e contam nos tetos, mas nunca entram nas páginas.
- A nova tentativa de uma leitura falha na varredura de vínculos e a nova varredura da própria raiz de grupo quando ela cresce não têm teste de regressão (não há gancho para forçá-las).
- Sem interface nativa; as telas da web vêm na PR4.

## 60. A Rua não fica presa em "Isso é tudo por enquanto" (PR fix/rua-sync-loop, 2026-10-31)

### O que mudou

- Uma releitura automática do trecho mostrado (`range`) que volta com uma página curta não marca mais a lista como no fim (`rangeEnd`, passo `'end'`, em `apps/app/src/paging.js`). Antes, uma página curta tirava a lista do estado "não chegou ao fim" para sempre. As leituras automáticas paravam, o rodapé dizia "Isso é tudo por enquanto." e a rolagem infinita sumia (A Rua só passa `onLoadMore` enquanto a lista não está no fim). Só puxar para atualizar recuperava.
- A página curta acontece quando o feed visível encolhe por um tempo: um diário seguido cujo comprimento assinado cresceu antes de a ponta nova chegar mostra só o prefixo (regra estrita, seção 56). A busca da ponta inteira (seção 58) deixa esse estado durar mais. Agora a lista guarda o estado de fim que tinha, e uma leitura de rolagem acha o fim de verdade.

### Testes automatizados

- `apps/app/test/paging.test.js`: "regression: a short range page while the visible feed shrank never ends a list that was not at its end" (falha sem a correção); o teste das leituras longe do fim passou a esperar que uma página curta mantenha o estado de fim.

### Verificação humana

Nenhuma verificação foi feita ainda. No PWA:

- [ ] Abrir A Rua com quem você segue publicando: a rolagem infinita continua e o rodapé não diz "Isso é tudo por enquanto." enquanto há mais publicações (não realizada ainda).
- [ ] Depois de alguém que você segue publicar com o app aberto, rolar até o fim: as publicações mais antigas continuam carregando (não realizada ainda).

### Limites

- Uma lista que não estava no fim pode fazer uma leitura de rolagem a mais, vazia, para descobrir o fim.

## 61. Leituras não esperam uma partida da sincronização que não termina (PR fix/reads-never-hang, 2026-10-31)

### O que mudou

- No nó do navegador, `feed.read`, `profile.read`, `log.read`, `engagement.read` e a leitura do próprio diário dos avisos esperavam sem limite que a rodada em curso publicasse os seus núcleos (`withCores` em `packages/web-member/lib/session.js`). Uma partida lenta ou presa deixava A Rua sem dados e travava tudo o que estava na fila atrás das leituras, `sync.stop` e `sync.status` inclusive. Sintoma visto no PWA: Sincronização em "conectando…" e "sincronizando (contínua, execução 2)", sem nenhuma linha da execução 2.
- Agora a leitura espera no máximo 3 s (`readerWaitMs`). Depois disso ela para a rodada que está partindo (uma preempção, `sync.stopped` `'preempted'`), lê pelo caminho exclusivo e a rodada contínua volta depois, como em qualquer preempção. A tela de Sincronização mostra uma vez `aviso: leitura sem esperar a partida da sincronização (3000 ms)`.
- Diagnóstico local, sem telemetria: uma rodada que não chegou à conexão com o semeador 5 s depois de começar mostra `aviso: partida demorada (etapa: <etapa>, <s> s)` e repete a cada 5 s até conectar ou acabar. As etapas: `configuração`, `lista de bloqueio`, `diário`, `mídia própria`, `grupos`, `leitura do próprio diário`, `seguidos (abertura)`, `diários de grupo`, `índice de réplicas`, `varredura de bloqueados` e `conexão`.

### Testes automatizados

- `packages/web-member/test/read-while-sync.test.js`: "a read never waits unbounded for a run whose startup has not published its cores" (a partida fica presa na abertura dos seguidos; `feed.read` responde pelo caminho exclusivo, uma linha de aviso, a rodada é preemptada e recomeça; falha sem a correção: a leitura fica presa).
- `packages/web-member/test/sync-reader.test.js`: "a slow startup logs the step it is held on until it goes on, and nothing once the run ended" (falha sem o vigia da partida).

### Verificação humana

Nenhuma verificação foi feita ainda. No PWA:

- [ ] Abrir o app, mandar para o fundo e trazer de volta várias vezes: A Rua carrega a cada volta (não realizada ainda).
- [ ] Se uma partida demorar, Ajustes › Avançado › Sincronização mostra `aviso: partida demorada (etapa: …)`: mandar uma captura de tela com a etapa (não realizada ainda).

### Limites

- Uma partida presa num `await` que nunca termina ainda trava a preempção da leitura: parar a rodada espera ela terminar. O aviso de partida demorada diz em que etapa ela parou.
- A etapa `conexão` aparece uma vez só no aviso `partida demorada`; um semeador que não responde já tem os próprios avisos (`sem conexão com o semeador`, nova tentativa).

## 62. Grupos privados cifrados de ponta a ponta (PR feat/groups-private)

Terceira parte de Cadeiras de Praia: um grupo privado (`visibility: 'private'` no cabeçalho da raiz) leva publicações, ocultações e metadados cifrados (`group-sealed`); só os aparelhos com a chave da época leem. Normas em `docs/protocol.md` seção 10 ("Private groups") e `docs/rpc.md` 5.36 (visibilidade), 5.40 (`sealed`, `epoch`, `state`) e 5.61 (`group.rekey`). Membros, moderação e a distribuição de chaves (`group-key`) continuam em claro e seguem todas as regras das seções 49 e 59. Grupos privados podem entrar em comunidades (decisão da pessoa dona do produto): quem cria ou administra a comunidade com poder no grupo recebe as chaves, e perder esse poder gera uma época nova.

### Como verificar

Do repositório, cada arquivo roda sozinho (`node <arquivo>`); a suíte inteira roda com `npm test`.

| Arquivo | O que cobre |
|---|---|
| `packages/core/test/group-crypto.test.js` | primitivas: chave de época de 32 bytes aleatórios, `sealRecord`/`openRecord` (JSON compacto, `null` em adulteração, chave errada, truncamento, base64 não canônico, texto que não é objeto), pares de caixa (vetor fixo), `sealTo`/`openFrom`, `keyTag` (vetores fixos), `sealEpochKey`/`openEpochKey` presos ao grupo e ao `kid`, `keyCommit` (vetor fixo), 48 destinatários cabem num bloco, `wipe` |
| `packages/core/test/group-private.test.js` | dobra: formatos e limites de `group-key` e `group-sealed`, `box` conforme a visibilidade, ordem pelo envelope, envelope adulterado ou transplantado conta como cifrado, distribuidor sem poder ignorado, rotações concorrentes, `rekey-pending`, época anterior a um banimento nunca elegível, aparelho novo pendente nunca recebe, administração de comunidade, propriedade de ordem de entrega, desempenho da cobertura (4000 épocas), registro aberto com a geração e a aresta `kid` do envelope (volta pendente não publica por um escritor antigo), remoções da comunidade reduzidas à mais recente e só enquanto o grupo mantém o vínculo, saídas repetidas de quem foi banido, já saiu ou voltou sem aprovação não geram remoção nova (uma exigência por diário entre voltas, e uma saída depois da primeira só conta com nova admissão, nomeação ou entrega de chave no meio), rebaixamento com cortes vazios ou acima do teto não apaga o histórico (leitura separada do envio), bloco só de leitura nunca muda a época de envio, compromisso da chave no primeiro bloco (continuação forjada só entrega a chave comprometida) |
| `packages/core/test/private-member.test.js` | nó do núcleo: criação privada nunca pública, não membro só conta mensagens cifradas, admitido lê o histórico, banimento gera época nova, reinício mantém as chaves, nada em claro no disco, `group.rekey`, comunidade, entrega recuperada por `group.rekey`, rotação em vários blocos com as épocas intermediárias só para quem distribui, remoção da comunidade listada de novo na `basis`, entrega do histórico recusada inteira quando não cabe no diário, religar uma comunidade gera época nova quando falta, primeiro bloco de cada época com `commit` igual à chave entregue |
| `packages/web-member/test/private-ops.test.js` | os mesmos métodos no nó do navegador (`member-ops.js`) |
| `packages/core/test/sync-private.test.js` | sincronização do núcleo: escritor sem `box` num grupo privado (ou com `box` num público) recusado e nunca guardado, grupo privado de ponta a ponta por um semeador |
| `packages/web-member/test/sync-private.test.js` | portão do navegador: raiz privada aceita, comunidade privada inválida, `box` conforme a visibilidade |
| `packages/core/test/seeder-private.test.js` | semeador: admite e serve blocos como estão, índice sem nome, `box` divergente recusado, denúncia cifrada só num grupo privado |
| `apps/cli/test/seed-ws.test.js`, `apps/cli/test/account-mod.test.js`, `apps/cli/test/panel.test.js` | denúncia cifrada: `/moderation-group-post` responde só a estrutura, o serviço de conta confere sem texto, o painel mostra `cifrada: citação do denunciante` |
| `packages/web-member/test/group-keys.test.js` | guarda das chaves no navegador: só em memória, apagadas em `lock`, `signOut` e `close`, geração segura |
| `packages/web-member/test/passkey.test.js` | par de caixa derivado da PRF (vetor fixo, separado das outras chaves, buffers zerados) |
| `packages/core/test/store.test.js` | `group-box.json`: criado uma vez, 0600, nunca substituído, arquivo ruim recusado e deixado como está |
| `apps/cli/test/group-commands.test.js` | `group create --private`, `group info` com a visibilidade, `group read` e `--json` (`sealed`, `epoch`, `state`), `group rekey`, nenhuma saída com a chave de caixa |
| `packages/web-member/test/private-e2e.test.js` | ponta a ponta em loopback (cerca de 70 s sozinho): semeador real atrás de WebSocket e na DHT local; o criador (núcleo) cria o grupo privado; um membro do navegador entra pela chave antes de a raiz chegar (escritor sem `box`, que o semeador nunca aceita; desde a PR feat/groups-web a execução deixa de esperar o envio dele quando a raiz privada chega), entra de novo com a raiz guardada (escritor com `box`), é admitido pelo semeador real, lê o histórico e publica cifrado (o criador lê); um terceiro nó (núcleo), que também entra antes da raiz (a primeira execução relata só o tempo esgotado do escritor sem `box`), nunca é admitido, só conta mensagens cifradas e não vê o nome; um banimento gera época nova e o banido não lê a publicação seguinte; o armazenamento do semeador não tem o texto de nenhuma publicação |

### Revisão de criptografia (checklist)

- Destinatários: cada época vai a exatamente os escritores com direito (membros admitidos e administradores, o criador pela `box` da raiz, administradores de comunidade com poder), por escritor e não por diário; nunca a um escritor pendente, banido ou que saiu. Banir, sair, retirar administração, desvincular ou rebaixar na comunidade gera época nova; `basis` lista as remoções que ela cobre e quem envia usa só uma época que cobre todas as remoções vistas (senão `aguardando nova chave`).
- Contexto (R1/R2): a chave selada carrega o `keyTag` de grupo e `kid` ({escritor, seq} do primeiro bloco da época), então uma entrada transplantada para outro grupo, outro bloco ou outra época não abre; o registro interno é preso a escritor, grupo e `kid` (`sealedInner`) e validado como `group-post`, `group-hide` ou `group-meta` com o `at` do envelope.
- Compromisso: o primeiro bloco de cada época publica `commit` (BLAKE2b de 32 bytes sobre o domínio `varanda/group-key-commit/v1`, o grupo, o `kid` e a chave); quem lê só aceita uma chave que bata com ele, então nenhuma continuação troca a chave de uma época, nem a de quem distribui sem poder.
- Nonces: `crypto_secretbox_easy` com nonce aleatório de 24 bytes por envelope (`randombytes_buf`); `crypto_box_seal` usa chave efêmera por destinatário. Nenhum contador, nada reaproveitado.
- Persistência: no nó do núcleo, só `group-box.json` (0600) guarda segredo (a chave de caixa do aparelho); as chaves de época são reabertas dos blocos `group-key` a cada leitura e nunca vão ao disco em claro. No navegador nada secreto fica no armazenamento: o par de caixa vem da PRF da passkey e de um nonce (`groupBoxDevice`), e as chaves de época ficam só em memória.
- Limpeza: buffers de chave são zerados com `wipe` depois do uso; no navegador as chaves somem em trancar, sair (`signOut`) e fechar. Nenhum método RPC, evento, log ou erro devolve chave.

### Checagens humanas (a fazer)

- CLI: `varanda group create --private --name <nome>` imprime `grupo privado criado: <chave>`; `group info <chave>` mostra `visibilidade: privado (cifrado)` e `por aprovação`.
- Outra pessoa entra (`group join <chave>`) e, antes da admissão, `group read` avisa `N mensagens cifradas sem chave neste aparelho`; depois de `group admit` e de uma sincronização, ela lê as mensagens antigas e novas.
- Banir (`group ban <chave> --member <diário>`) e publicar de novo: a pessoa banida não lê a publicação nova (vê a contagem cifrada subir).
- `group rekey <chave>` imprime `nova chave do grupo gerada e entregue aos membros`; os membros continuam lendo e publicando.
- Semeador: procurar no diretório de dados do semeador (`grep -r` pelo texto de uma publicação) não acha nada; `curl /index/group/<G>` mostra `visibility: 'private'` e `name: null`; `/index/group-search` nunca lista o grupo.
- Navegador: trancar e destrancar a sessão; antes de destrancar, `group.read` responde `state: 'locked'`, e depois lê de novo sem nova entrada.
- Nenhuma saída da CLI ou log do semeador mostra chave (conferir `--json` de `group read` e `group rekey`: só a referência `epoch`).

### Não verificado / limites conhecidos

- Sem catraca nem sigilo futuro dentro de uma época: quem tem a chave lê tudo daquela época, inclusive o que já passou.
- Metadados continuam visíveis: quem é membro, quem publica, quando, o tamanho aproximado de cada mensagem e a moderação.
- Quem foi removido guarda o que já leu; a época nova só protege o que vem depois.
- Um aparelho que entrou antes de a raiz privada chegar (entrada pendente, sem `box`) precisa entrar de novo. O semeador nunca aceita esse escritor sem `box`, e o navegador deixa de esperar o envio dele assim que guarda a raiz privada (PR feat/groups-web, seção 64). A nova entrada com `box` desvincula o escritor sem `box` nos dois nós, e a checagem de admissão de grupo privado ignora escritores desvinculados, então a admissão funciona pelo semeador (teste ponta a ponta).
- Um aparelho novo depois de sair e voltar só recebe chaves depois de uma admissão que o liste.
- A rotação do navegador confere na dobra os blocos que planeja; o nó do núcleo grava a `basis` direto, sem essa pré-checagem.
- A entrega do histórico depois de uma admissão, nomeação, desbanimento ou vínculo não é fatal: se falhar, é tentada de novo no próximo gatilho ou em `group.rekey`.
- A reconferência do navegador quando a visibilidade chega depois só tem testes de veredito puros; a entrada pela chave antes da raiz e a nova entrada com `box` têm teste em rede desde a seção 64 (`node-bundle.test.js`).
- A reconferência do núcleo que julga a `box` de um escritor pelo bloco 0 do portão (escritor ativo antes de o bloco 0 local chegar) e a regra do navegador que mantém os blocos de um escritor guardado restaurado numa divergência tardia não têm teste de regressão que falhe sem a correção (os fixtures não controlam o tempo).
- O caso "época de um administrador depois rebaixado ainda é entregue" tem teste no núcleo, mas não no navegador que falhe sem a correção.
- Quem saiu de um grupo privado não consegue mais ocultar a própria publicação antiga: a ocultação vai cifrada e, depois da saída, não há época elegível para ela (`aguardando nova chave`).
- O nó do núcleo cria `group-box.json` na primeira leitura de um grupo privado, mesmo para quem não é membro.
- Um destinatário cuja `box` o libsodium recusa (ponto de ordem baixa) é pulado na rotação e no histórico; os outros recebem a chave normalmente.
- `packages/core/test/seeder-groups.test.js` leva cerca de 115 s sozinho, perto do limite de 180 s por arquivo.
- O teste de desempenho da cobertura (`group-private.test.js`, 4000 épocas) mede uma razão de tempos e depende da carga da máquina.
- A denúncia de uma mensagem cifrada só confere a estrutura: quem modera vê a citação do denunciante, não o texto conferido.
- O teste da geração pelo envelope só falha sem as duas defesas (geração tirada do envelope e aresta `kid` mantida no registro aberto): cada uma sozinha corrige o caso, e não achamos ordem em que só a geração faça diferença.
- A recusa de uma rotação grande demais para o diário no nó do núcleo não tem teste próprio (a mesma checagem de espaço tem teste na entrega do histórico), e o teste das 5000 remoções falsas no núcleo não foi conferido falhando sem a correção.
- Uma entrega de histórico que não cabe no diário de quem distribui é recusada inteira, sem gravar nada: quem entrou fica sem as épocas antigas até outro aparelho que distribui entregar ou até `group.rekey` caber.
- Enquanto o grupo mantém uma comunidade desligada, as remoções dela não contam; ao religar, a mais recente volta a contar, e o aparelho que religa gera época nova se a dobra pedir. Se essa rotação falhar, o grupo fica `aguardando nova chave` até `group.rekey`.
- Para não apagar o histórico, a leitura aceita blocos de chave de um escritor que um rebaixamento ou desvínculo não listou; as épocas que esse escritor gravar depois também ficam legíveis, mas nunca viram época de envio. Épocas só legíveis não entram na entrega do histórico: quem já tinha a chave continua lendo, quem entra depois não recebe esse trecho.
- Quem ainda tem a chave de uma época (por exemplo, um admin rebaixado que continua membro) pode entregá-la a outro escritor, fora do protocolo ou num bloco só de leitura; esse bloco não muda a época de envio nem marca `aguardando nova chave`, porque deixar um bloco só de leitura mexer na elegibilidade permitiria travar o envio do grupo.
- Sair encerra a nomeação e a admissão (decisão da pessoa dona do produto): quem sai e volta só recebe chaves ou distribui depois de uma nova admissão ou nomeação feita depois da saída (os cortes do registro provam que ela viu a saída). Um administrador que volta precisa ser nomeado de novo. Ninguém se admite, e um registro escrito pelo próprio diário nunca prova que viu a saída; a exceção é o vínculo do lado da comunidade escrito por quem criou a comunidade, que vale para o próprio poder dela (é tão confiável quanto a raiz de quem criou o grupo). No caminho da admissão, a nova regra e a anterior (geração contada pelas saídas) deram o mesmo resultado em todos os casos que montamos, então nenhum teste falha só sem ela.
- Se quem criou o grupo sai e volta, recebe as chaves só pelo aparelho da volta; a raiz continua com a autoridade do grupo, mas deixa de receber chaves (decisão da pessoa dona do produto).
- Ocultar e reexibir uma publicação seguem a ordem decifrada (o último vale, como nos grupos públicos): um administrador que saiu pode deixar uma publicação visível de novo com um registro preparado antes de sair, até outro administrador ocultá-la outra vez.
- Não verificado: um administrador, enquanto tem poder, talvez consiga deixar pré-aprovada a volta de um membro listando de antemão o escritor da volta numa admissão; a admissão valeria mesmo se ele perdesse o poder depois. Exige um administrador agindo de má-fé enquanto ainda pode admitir.
- Sem interface nativa; as telas da web vêm na PR4.

## 63. Listas da web desenham além das primeiras linhas (PR fix/list-render-window, 2026-10-31)

### O que mudou

- Na web, A Rua, o Diário e Seguindo mostravam só umas dez linhas e depois "Isso é tudo por enquanto.", mesmo com centenas de publicações já carregadas. As publicações apareciam depois de abrir o Diário ou depois de cerca de um minuto. Visto no Chrome do computador e no PWA, mais fácil logo depois de limpar os dados do site.
- A causa estava no esqueleto que pulsa enquanto uma lista carrega (`Skeleton` em `apps/app/src/ui/States.js`). Na web nenhuma animação roda no driver nativo, e uma `Animated.timing` sem `isInteraction: false` conta como interação enquanto roda. A `FlatList` do react-native-web só aumenta a janela de linhas desenhadas quando o `InteractionManager` está livre. Uma lista montada ainda vazia fica então nas linhas iniciais (`initialNumToRender`, 10). As abas ocultas continuam montadas, e Seguindo e o Diário mostram o esqueleto até a primeira visita, então o laço dele nunca parava. Abrir a aba terminava o carregamento e parava o laço, por isso os dados "só apareciam depois de ir ao Diário".
- Agora toda `Animated.timing` dentro de um `Animated.loop` passa por `loopTiming` (`apps/app/src/ui/loopMotion.js`), que acrescenta `isInteraction: false`: o esqueleto e o pulso do "conectando…" da abertura. No iOS e no Android nada muda: com o driver nativo, essas animações já não contavam como interação.

### Testes automatizados

- `apps/app/test/loopMotion.test.js`: `loopTiming` nunca marca interação e mantém o resto da configuração; todo arquivo de `apps/app/src` com `Animated.loop(` passa as suas `Animated.timing` do laço por `loopTiming` (as duas do esqueleto e o pulso da abertura); o módulo continua puro. Falha sem a correção (o segundo teste).
- Reprodução fora da CI: o app exportado (`npm run export:web`) num Chrome sem janela, com o nó do navegador real atrás de uma ponte, um semeador real com 60 diários seguidos (cerca de 3700 publicações), 150 ms de latência e armazenamento vazio, como depois de limpar os dados. Sem a correção, a `FlatList` de A Rua tinha 3757 itens e a janela desenhada vazia (`{ first: 0, last: -1 }`, só as 10 linhas iniciais) enquanto os esqueletos de Seguindo e do Diário pulsavam ocultos; abrir Seguindo parou o último laço e a janela foi a `{ 0, 85 }`. Com a correção, no mesmo roteiro e com os dois esqueletos ainda pulsando, A Rua desenhou `{ 0, 81 }` e depois `{ 188, 343 }` ao rolar, e o Diário as 61 linhas até "Isso é tudo por enquanto.".

### Verificação humana

Nenhuma verificação foi feita ainda. No Chrome do computador e no PWA:

- [ ] Limpar os dados do site, entrar e, sem abrir outra aba, rolar A Rua: as publicações de quem você segue continuam aparecendo e a lista não para nas primeiras linhas (não realizada ainda).
- [ ] Logo depois de entrar, abrir Seguindo e o Diário e rolar até o fim: a lista inteira aparece (não realizada ainda).

### Limites

- O esqueleto de uma aba oculta continua pulsando até a primeira visita dela. Ele não segura mais as listas, mas ainda gasta o processamento da página; parar a animação nas abas ocultas fica para depois.
- As outras animações curtas (o indicador de puxar para atualizar, a pílula "ver novidades", a entrada da abertura) continuam contando como interação enquanto duram, uma fração de segundo.

## 64. Cadeiras de Praia na web hospedada (PR feat/groups-web)

Quarta parte de Cadeiras de Praia: as telas. Na web hospedada (nó no navegador), a aba **Cadeiras** (depois da Espiadinha) lista as cadeiras da pessoa e cria outra; a tela **Cadeira** mostra a conversa, a caixa de escrever e a folha de administração (membros, pedidos, administradores, banidos, vínculo com comunidade, sair e, em cadeira privada, gerar nova chave); a tela **Comunidade** lista as cadeiras vinculadas; o link `/g/<chave>` abre a cadeira; **Denunciar** aceita uma mensagem de grupo (`report.sign` com `writer` e `group`; num grupo privado, a citação é o texto aberto neste aparelho). Mudanças de código: `apps/app/src/groups.js` (lógica pura: páginas, linhas, papéis, rótulos, reconciliação de resultado incerto), `groupLink.js`, `groupVersions.js`, `tabs.js`, `indexClient.js` (rotas `/index/group`, `/index/groups`, `/index/group-search`, `/index/community`), `nav.js`, `report.js`, as telas em `apps/app/src/screens/` e `ui/GroupMessageRow.js`. O protocolo não muda; no nó do navegador, a barreira de escrita e a sincronização deixam de esperar o envio de um escritor sem `box` de uma cadeira privada (correção abaixo). Descrição das telas em `docs/app.md` ("Cadeiras de Praia").

### Como verificar

Do repositório, cada arquivo roda sozinho (`node <arquivo>`); a suíte inteira roda com `npm test`.

| Arquivo | O que cobre |
|---|---|
| `apps/app/test/groups.test.js` | lógica pura: junção de páginas, linhas (mais nova embaixo, nomes e nunca chave crua, mensagem escondida), papéis e permissões, rótulos, link de entrada, `reconcile` de cada ação, `applyPage` e versão da leitura |
| `apps/app/test/indexClient.test.js` | rotas de grupo e de comunidade do índice: formatos estritos, tetos de tamanho, tentativas com o orçamento compartilhado |
| `apps/app/test/nav.test.js` | rotas novas da navegação (cadeira e comunidade, pela chave) e a volta |
| `apps/app/test/tabBar.test.js` | seis abas na web hospedada (Cadeiras logo depois da Espiadinha) e cinco no nativo, no `varanda-serve` e nos outros modos |
| `apps/app/test/groupVersions.test.js` | versão por grupo (`groups.changed`): começa em zero, cresce por grupo, rajada em lote conta um, `signOut` e troca de identidade limpam |
| `apps/app/test/groupLink.test.js` | `/g/<chave>`: só hexadecimal minúsculo de 64 caracteres, limpeza da barra de endereço preservando `?conta=` e `#token=`, outros caminhos intocados |
| `apps/app/test/profileLink.test.js` | o link `/@nome` segue igual ao lado do `/g/` (a captura de um não toca o outro) |
| `apps/app/test/report.test.js` | corpo e parâmetros da denúncia de mensagem de grupo (`writer`, `group`, `seq`, citação), corpo de diário e de conta inalterados |
| `apps/app/test/group-flow.test.js` | fluxos sobre os estados puros: chegada tardia (página mais velha depois de uma leitura nova é descartada), cursor vencido (época, contagem cifrada ou estado mudou), resposta perdida (publicar, admitir e gerar chave incertos são reconciliados antes de qualquer nova tentativa, nunca às cegas), ocultar, banir, trancado (sem linhas e com o rótulo), `aguardando nova chave` (publicar recusado e gerar chave só para quem pode), ida e volta do link `/g/` e parâmetros da denúncia de grupo privado |
| `packages/core/test/community-member.test.js`, o teste de comunidade do navegador e `packages/rpc/test/methods.test.js` | `community.list` (rpc 5.62): lista as comunidades criadas e as ligadas às cadeiras locais, sem repetir, criadas primeiro; o contrato do método (sem campos, só leitura) |
| `packages/web-member/test/node-bundle.test.js` | o pacote do navegador de verdade (build `--node`, IndexedDB falso, passkey falsa, semeador real na DHT local): cria, entra, publica e lê um grupo público com um nó do núcleo; o nó do núcleo cria um grupo privado e publica, o pacote entra pela chave antes de ter a raiz, sincroniza sem esperar o escritor sem `box`, entra de novo, só conta mensagens cifradas até ser admitido, depois lê o histórico e publica, o núcleo o lê, e o IndexedDB não guarda o texto em claro |
| `packages/web-member/test/session-private-gate.test.js` | regressão da barreira de escrita: a segunda entrada numa cadeira privada depois de uma entrada antes da raiz não fica presa esperando o escritor sem `box` (falha sem a correção); o armazenamento do navegador não guarda o texto privado em claro (cerca de 45 s sozinho) |

### Checagens humanas (a fazer)

Duas janelas com perfis do navegador diferentes (A e B, cada uma com a própria passkey) e uma terceira pessoa que não é membro (C), no site hospedado:

1. **Cadeira pública aberta.** A: aba Cadeiras, Nova cadeira (aberta, pública), escrever. B: buscar a cadeira em Cadeiras (campo de busca) ou colar o link em "Entrar por link"; entrar, ler a mensagem de A, responder. A vê a resposta sem recarregar. A oculta a mensagem de B (vira "mensagem escondida"); B oculta uma mensagem sua. A bane B: B não consegue mais publicar e a caixa explica.
2. **Cadeira por aprovação.** B pede entrada ("pedido enviado"); A abre a administração, vê o pedido em Pedidos e aprova; B passa a membro e publica. Recusar um pedido deixa B sem entrada. B sai da cadeira e precisa de nova aprovação para voltar.
3. **Cadeira privada.** A cria (a entrada por aprovação é forçada). B cola o link `/g/` de uma cadeira privada já sincronizada neste aparelho em "Entrar por link" (ou abre a cadeira), pede entrada e, antes de ser admitido, vê só "N mensagens cifradas" e nenhuma mensagem. A admite; B lê o histórico e publica; A lê. A bane B e publica de novo: B não lê a nova mensagem. Se a cadeira ficar em `aguardando nova chave`, a caixa de B recusa publicar com esse rótulo, só quem pode (criador, administradores) vê "Gerar nova chave", e depois de gerar a cadeira volta a aceitar mensagens.
4. **Comunidade.** Na aba Cadeiras, A toca em "Nova comunidade", dá um nome e abre a comunidade criada; copia a chave dela. Depois de criar, A sai da tela e volta à aba Cadeiras: a comunidade aparece em "Minhas comunidades" ("criada por você"), e continua lá depois de recarregar a página. Na administração da cadeira pública de A, em Vincular, A cola a chave da comunidade (só vale com os dois lados: a comunidade também vincula a cadeira, colando o link `/g/` na tela da comunidade, onde A é a criadora). A cadeira ganha o botão "comunidade"; a tela da comunidade lista a cadeira. Uma pessoa administradora da comunidade (A adiciona B pela chave, na tela da comunidade) oculta e bane na cadeira vinculada, sem nomear administradores dela. Desvincular tira a cadeira da lista.
5. **Link por quem não é membro.** C abre `https://<site>/g/<chave>` sem ser membro de nada: a barra de endereço volta para `/`, a cadeira abre e mostra o que um não membro pode ver (cadeira pública: nome, modo de entrada e botão de entrar; privada: sem nome e sem mensagens). Uma chave inválida (`/g/abc`) só limpa a barra e não abre nada.
6. **Denúncia.** B denuncia uma mensagem de uma cadeira pública e outra de uma cadeira privada (conta Google vinculada): a folha mostra o texto que B vê; no painel de moderação a denúncia do grupo privado vem marcada `cifrada: citação do denunciante`.
7. **Recarregar, trancar e sair.** Recarregar a página com uma cadeira aberta volta à mesma cadeira com a conversa. Trancar a sessão: a conversa some, aparece "bloqueado: entre com a passkey" e não há linhas; destrancar a mostra de novo, sem nova entrada. Sair (`signOut`): a aba Cadeiras volta vazia e nenhuma mensagem fica na tela; entrar de novo mostra as cadeiras.
8. **Teclado e folhas.** Escape fecha a folha de administração, a de Nova cadeira e a de denúncia sem sair da tela da cadeira; Escape sem folha aberta volta à tela anterior, como nas outras telas.
9. **Nativo e `varanda-serve`.** Continuam com cinco abas, sem Cadeiras; onde um link `/g/` ou uma tela de Cadeiras apareça, vê-se "só na versão web".

### Não verificado / limites conhecidos

- Só na web hospedada, só texto (sem fotos nem GIFs) e sem telas nativas; o `varanda-serve` e o app nativo não têm Cadeiras.
- Não há teste de componente: as telas (`apps/app/src/screens/Cadeira.js`, `CadeiraAjustes.js`, `Cadeiras.js`, `Comunidade.js`, `NovaCadeira.js` e `ui/GroupMessageRow.js`) não são carregadas por nenhum teste automatizado (importam `react-native`). Os fluxos testados são os da lógica pura e do nó; o que as telas fazem com eles só tem a checagem humana acima.
- **Corrigido nesta PR: entrada em cadeira privada por chave antes de a raiz chegar ao aparelho.** No pacote do navegador, `group.join` de uma cadeira privada sem a raiz grava um escritor sem `box` que o semeador nunca aceita, e a barreira de escrita (`ensureCaughtUp`) esperava o envio dele para sempre: a nova entrada respondia `sincronize com o semeador antes de publicar`, também depois de recarregar. Agora, com a raiz privada guardada, esse escritor não é meta de envio nem da barreira, e a nova entrada cria o escritor com `box` e pede entrada (`session-private-gate.test.js`, `node-bundle.test.js`). Vale conferir à mão na checagem 3, pelo link `/g/` e por "Entrar por link".
- Sem teste automatizado de rede para a entrada de um navegador em cadeira pública pela interface; o pacote cobre a entrada pública (`pending` e depois membro) via RPC.
- A cadeira privada continua sem catraca nem sigilo futuro dentro de uma época, com metadados visíveis, e as demais limitações da seção 62 valem.
- Fora das telas, por não terem sido feitos: responder a uma mensagem (`groups.js` lê `replyTo`, mas as telas não o mostram nem o enviam), remover um administrador da comunidade e desvincular pelo lado da comunidade. Renomear (a criadora, na administração) e criar comunidade (na aba) estão nas telas; vale conferir os dois à mão.
- O que mais as telas não conseguirem fazer fica registrado na descrição do PR.
