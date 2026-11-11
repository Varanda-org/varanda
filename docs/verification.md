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

### Splash até a primeira tela (fix/boot-splash-first-screen, 2026-11-03)

Antes, o splash saía cedo e deixava aparecer telas de espera (passkey "carregando…", "Buscando sua conta…", "Confirme sua idade" com o botão desativado e o "Um instante" do perfil). Agora o splash fica até a primeira tela real ser conhecida. Cada etapa tem 10 s de paciência: se uma leitura travar, a tela real aparece mesmo assim. "Buscando sua conta…" (recuperação da conta) continua coberto até o nó encerrar a busca (30 s, ou cerca de 60 s se ela recomeçar uma vez), com teto de 65 s caso o fim da busca nunca chegue. Depois que a primeira tela real aparece, o splash não volta nesta carga da página ou nesta execução do app. Cartões de introdução, Termos e Conexão não mudam; na web, "Entrar" com a passkey é a primeira tela real.

1. [ ] App nativo com sessão retomada e idade já verificada: só o splash até A Rua, sem passar por "Confirme sua idade" com o botão desativado (não realizada ainda).
2. [ ] Membro com a idade ainda não verificada: splash, depois "Confirme sua idade" com "Verificar minha idade" ativo (não realizada ainda).
3. [ ] Leitura da idade que não responde: depois de 10 s nessa etapa, aparece "Confirme sua idade" com o indicador de carregamento (não realizada ainda).
4. [ ] Perfil próprio lento: "Continuar mesmo assim" só aparece depois de 10 s em "Um instante" (não realizada ainda).
5. [ ] Web: o splash em CSS some uma vez só, sem repetir a animação da cadeira (não realizada ainda).
6. [ ] Web: "Entrar" com a passkey aparece como antes, e depois de entrar as telas seguem como antes (não realizada ainda).
7. [ ] Cartões de introdução, Termos e Conexão sem mudança (não realizada ainda).
8. [ ] Depois de A Rua, bloquear e desbloquear não traz o splash de volta (não realizada ainda).

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
- Os estados presos e as saídas novas (passkey sem sincronização, caminho pelo celular, passkeys recusadas guardadas, saída de uma passkey conhecida perdida) estão em §109; os resultados desta seção não foram refeitos.

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
- `deploy/seeder/well-known.sh`: o `assetlinks.json` passa a declarar também `delegate_permission/common.handle_all_urls`, exigido pelo Auth Tab para entregar a volta https ao app. O app não declara intent-filter https. (Desde a seção 68, o app declara App Links só para `/c/` e `/g/` de `bora.varanda.app`.)
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

## 54. Web hospedada conectada enquanto visível (PR perf/stay-connected, 2026-10-30)

As seções 1 a 52 não mudam, exceto "Duty cycle" (seção 17), marcada como substituída.

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
| `apps/app/test/groupLink.test.js` (caminho da comunidade) | `/c/<chave>`: hexadecimal minúsculo de 64 caracteres, maiúsculas, tamanho errado, segmento extra e consulta recusados, limpeza da barra de endereço, e `/g/` e `/c/` nunca se misturam |
| `apps/app/test/profileLink.test.js` | o link `/@nome` segue igual ao lado do `/g/` (a captura de um não toca o outro) |
| `apps/app/test/report.test.js` | corpo e parâmetros da denúncia de mensagem de grupo (`writer`, `group`, `seq`, citação), corpo de diário e de conta inalterados |
| `apps/app/test/group-flow.test.js` | fluxos sobre os estados puros: chegada tardia (página mais velha depois de uma leitura nova é descartada), cursor vencido (época, contagem cifrada ou estado mudou), resposta perdida (publicar, admitir e gerar chave incertos são reconciliados antes de qualquer nova tentativa, nunca às cegas), ocultar, banir, trancado (sem linhas e com o rótulo), `aguardando nova chave` (publicar recusado e gerar chave só para quem pode), ida e volta do link `/g/` e parâmetros da denúncia de grupo privado |
| `packages/core/test/community-member.test.js`, o teste de comunidade do navegador e `packages/rpc/test/methods.test.js` | `community.list` (rpc 5.62): lista as comunidades criadas e as ligadas às cadeiras locais, sem repetir, criadas primeiro; o contrato do método (sem campos, só leitura) |
| `packages/web-member/test/node-bundle.test.js` | o pacote do navegador de verdade (build `--node`, IndexedDB falso, passkey falsa, semeador real na DHT local): cria, entra, publica e lê um grupo público com um nó do núcleo; o nó do núcleo cria um grupo privado e publica, o pacote entra pela chave antes de ter a raiz, sincroniza sem esperar o escritor sem `box`, entra de novo, só conta mensagens cifradas até ser admitido, depois lê o histórico e publica, o núcleo o lê, e o IndexedDB não guarda o texto em claro |
| `packages/web-member/test/session-private-gate.test.js` | regressão da barreira de escrita: a segunda entrada numa cadeira privada depois de uma entrada antes da raiz não fica presa esperando o escritor sem `box` (falha sem a correção); o armazenamento do navegador não guarda o texto privado em claro (cerca de 45 s sozinho) |

### Checagens humanas (a fazer)

Duas janelas com perfis do navegador diferentes (A e B, cada uma com a própria passkey) e uma terceira pessoa que não é membro (C), no site hospedado:

1. **Cadeira pública aberta.** A: aba Cadeiras, Nova cadeira (aberta, pública), escrever. B: buscar a cadeira em Cadeiras (campo de busca) ou abrir o link da cadeira (o campo "Entrar por link" saiu na seção 68); entrar, ler a mensagem de A, responder. A vê a resposta sem recarregar. A oculta a mensagem de B (vira "mensagem escondida"); B oculta uma mensagem sua. A bane B: B não consegue mais publicar e a caixa explica.
2. **Cadeira por aprovação.** B pede entrada ("pedido enviado"); A abre a administração, vê o pedido em Pedidos e aprova; B passa a membro e publica. Recusar um pedido deixa B sem entrada. B sai da cadeira e precisa de nova aprovação para voltar.
3. **Cadeira privada.** A cria (a entrada por aprovação é forçada). B abre o link `/g/` de uma cadeira privada já sincronizada neste aparelho (ou a cadeira; o campo "Entrar por link" saiu na seção 68), pede entrada e, antes de ser admitido, vê só "N mensagens cifradas" e nenhuma mensagem. A admite; B lê o histórico e publica; A lê. A bane B e publica de novo: B não lê a nova mensagem. Se a cadeira ficar em `aguardando nova chave`, a caixa de B recusa publicar com esse rótulo, só quem pode (criador, administradores) vê "Gerar nova chave", e depois de gerar a cadeira volta a aceitar mensagens.
4. **Comunidade.** Na aba Cadeiras, A toca em "Nova comunidade", dá um nome e abre a comunidade criada; copia a chave dela. Depois de criar, A sai da tela e volta à aba Cadeiras: a comunidade aparece em "Minhas comunidades" ("criada por você"), e continua lá depois de recarregar a página. Na administração da cadeira pública de A, em Vincular, A cola a chave da comunidade (só vale com os dois lados: a comunidade também vincula a cadeira, colando o link `/g/` na tela da comunidade, onde A é a criadora). A cadeira ganha o botão "comunidade"; a tela da comunidade lista a cadeira. Uma pessoa administradora da comunidade (A adiciona B pela chave, na tela da comunidade) oculta e bane na cadeira vinculada, sem nomear administradores dela. Desvincular tira a cadeira da lista.
5. **Link por quem não é membro.** C abre `https://<site>/g/<chave>` sem ser membro de nada: a barra de endereço volta para `/`, a cadeira abre e mostra o que um não membro pode ver (cadeira pública: nome, modo de entrada e botão de entrar; privada: sem nome e sem mensagens). Uma chave inválida (`/g/abc`) só limpa a barra e não abre nada.
6. **Denúncia.** B denuncia uma mensagem de uma cadeira pública e outra de uma cadeira privada (conta Google vinculada): a folha mostra o texto que B vê; no painel de moderação a denúncia do grupo privado vem marcada `cifrada: citação do denunciante`.
7. **Recarregar, trancar e sair.** Recarregar a página com uma cadeira aberta volta à mesma cadeira com a conversa. Trancar a sessão: a conversa some, aparece "bloqueado: entre com a passkey" e não há linhas; destrancar a mostra de novo, sem nova entrada. Sair (`signOut`): a aba Cadeiras volta vazia e nenhuma mensagem fica na tela; entrar de novo mostra as cadeiras.
8. **Teclado e folhas.** Escape fecha a folha de administração, a de Nova cadeira e a de denúncia sem sair da tela da cadeira; Escape sem folha aberta volta à tela anterior, como nas outras telas.
9. **Administrador por @nome e por busca.** A cria uma comunidade. Em Adicionar administrador, A digita o @nome de B: a tela mostra "@nome" de B e só então "Tornar administrador"; um @nome que não existe mostra "@nome não encontrado.". Depois A digita parte do nome de B: B aparece na lista com **Tornar administrador**. A contagem de administradores sobe, e a tela nunca mostra a chave inteira.
10. **Compartilhar a comunidade e a cadeira.** Na comunidade, qualquer pessoa toca em **Compartilhar**: no celular abre a folha do sistema, no computador copia e mostra "Link copiado."; o link `/c/` não aparece como texto. Abrir esse link em outro perfil do navegador, que nunca viu a comunidade, e sem entrar: a barra volta para `/`, e a comunidade abre depois de entrar, primeiro com o nome e as cadeiras do índice do servidor (no cartão de convite da seção 68, com **Entrar** ou **Pedir entrada**; cadeira privada só como "cadeira privada"; o texto "Pelo índice do servidor; entre na comunidade para participar." saiu na seção 68), e depois com a visão verificada quando os dados chegam ao aparelho. Na administração de uma cadeira, **Compartilhar** faz o mesmo com o convite `/g/`, sem mostrar o endereço.
11. **Nativo e `varanda-serve`.** Continuam com cinco abas, sem Cadeiras; onde um link `/g/` ou uma tela de Cadeiras apareça, vê-se "só na versão web".

### Não verificado / limites conhecidos

- Só na web hospedada, só texto (sem fotos nem GIFs) e sem telas nativas; o `varanda-serve` e o app nativo não têm Cadeiras.
- Não há teste de componente: as telas (`apps/app/src/screens/Cadeira.js`, `CadeiraAjustes.js`, `Cadeiras.js`, `Comunidade.js`, `NovaCadeira.js` e `ui/GroupMessageRow.js`) não são carregadas por nenhum teste automatizado (importam `react-native`). Os fluxos testados são os da lógica pura e do nó; o que as telas fazem com eles só tem a checagem humana acima.
- **Corrigido nesta PR: entrada em cadeira privada por chave antes de a raiz chegar ao aparelho.** No pacote do navegador, `group.join` de uma cadeira privada sem a raiz grava um escritor sem `box` que o semeador nunca aceita, e a barreira de escrita (`ensureCaughtUp`) esperava o envio dele para sempre: a nova entrada respondia `sincronize com o semeador antes de publicar`, também depois de recarregar. Agora, com a raiz privada guardada, esse escritor não é meta de envio nem da barreira, e a nova entrada cria o escritor com `box` e pede entrada (`session-private-gate.test.js`, `node-bundle.test.js`). Vale conferir à mão na checagem 3, pelo link `/g/` e por "Entrar por link" (o campo saiu na seção 68).
- Sem teste automatizado de rede para a entrada de um navegador em cadeira pública pela interface; o pacote cobre a entrada pública (`pending` e depois membro) via RPC.
- A cadeira privada continua sem catraca nem sigilo futuro dentro de uma época, com metadados visíveis, e as demais limitações da seção 62 valem.
- Fora das telas, por não terem sido feitos: responder a uma mensagem (`groups.js` lê `replyTo`, mas as telas não o mostram nem o enviam), remover um administrador da comunidade e desvincular pelo lado da comunidade. Renomear (a criadora, na administração) e criar comunidade (na aba) estão nas telas; vale conferir os dois à mão.
- O que mais as telas não conseguirem fazer fica registrado na descrição do PR.

## 65. App no Android arm64: build de debug, Metro e links (pilha "celular primeiro", 2026-11-01)

Verificação do app nativo com todas as mudanças da pilha "celular primeiro" aplicadas sobre `main@a0303c2` (links de grupo e comunidade, origem dos links compartilhados, `expo-clipboard`, visibilidade nativa, textos do nó hospedado, trava `platformGate`). É a primeira execução do ciclo local no Mac Apple Silicon descrito em [development.md](development.md) ("macOS setup").

- Aparelho: emulador AVD `varanda-api36`, ABI `arm64-v8a`, API 36, imagem `google_apis`, sem janela (`-no-window -no-audio -no-snapshot`). Evidência por `adb exec-out screencap -p` (as imagens ficaram fora do repositório).
- Versões: JDK 17 (Homebrew `openjdk@17`), Gradle 9.0.0, Expo 55.0.31 (o Metro avisou que o esperado é ~55.0.32), id da aplicação `app.varanda.debug`.

### Comandos e resultados

1. `npm run prepare:native -w apps/app -- android`: saiu com 0. Gerou o bundle do worklet (3767580 bytes, 517 arquivos, 50 entradas de addons), "node scan: clean" e "prepare-native: ready (android)".
2. `(cd apps/app/android && ./gradlew assembleDebug)`: saiu com 0, `BUILD SUCCESSFUL in 10m 28s` (372 tarefas, primeira compilação). O Gradle não pediu SDK, NDK nem build-tools além dos já instalados.
3. `emulator -avd varanda-api36 -no-snapshot -no-window`: iniciou; `ro.product.cpu.abi` = `arm64-v8a`, `ro.build.version.sdk` = 36.
4. `adb install -r .../app-debug.apk`: `Success`. `adb reverse tcp:8081 tcp:8081`: 8081.
5. `npx expo start --port 8081 --clear` em `apps/app` (com `CI=1`): `Android Bundled 3453ms apps/app/index.js (989 modules)`. Nenhum `EXPO_PUBLIC_VARANDA_INSTALLATION` definido.
6. Abertura: `adb shell monkey -p app.varanda.debug 1` não abriu a tela (saiu com 251). A abertura foi por `adb shell am start -n app.varanda.debug/app.varanda.MainActivity` (MAIN/LAUNCHER) e funcionou.

### Observado

- O bundle JS carregou do Metro e o logcat mostrou `ReactNativeJS: Running "main"` (Fabric ligado).
- Sem instalação configurada, a sequência na tela foi: introdução ("Seu diário, perto de você", Pular/Próximo), depois "Termos de Uso e Política de Privacidade" (versão 8) e, depois de aceitar os termos neste aparelho de teste, **Conectar** ("Informe o endereço da instalação do Varanda", campo `https://varanda.exemplo`, botões conectar e Avançado). Não digitei endereço nem conectei.
- Links: `adb shell am start -a android.intent.action.VIEW -d 'varanda:///g/<64 hex minúsculos>' app.varanda.debug` e a forma `/c/` (chave de teste `ab` repetido 32 vezes, sem relação com nenhuma cadeira real) foram entregues à instância em execução ("intent has been delivered to currently running top-most instance"). O processo continuou vivo (mesmo pid antes e depois) e a tela seguiu em Conectar, porque ainda não há instalação nem sessão para resolver o link.
- HOME e retorno: o processo continuou vivo (mesmo pid) e a tarefa voltou à frente. Não foi observada a pausa de sincronização, que só aparece em Ajustes > Sincronização com sessão.
- logcat filtrado (`-s ReactNativeJS:* AndroidRuntime:E`): só a linha `Running "main"`; `FATAL EXCEPTION` ocorreu 0 vezes.
- `git status --short apps/app/android apps/app/ios` vazio ao final (saídas do Gradle ignoradas pelo git).

### O que não foi executado

- Aparelho real, emulador x86_64, build de release.
- Entrar com passkey: precisa de conta Google e bloqueio de tela no emulador, que não foram criados. Além disso, o build de debug (`app.varanda.debug`) não casa com o `assetlinks` da instalação de produção (`app.varanda`), então não entra por passkey nela. Por isso nenhuma tela autenticada foi aberta, inclusive cadeira e comunidade depois do login.
- O rodapé "Conexão" nos passos de configuração do celular com a instalação ficou como na `main` (escondido): mostrá-lo deixaria trocar de instalação no meio do cadastro, e a política de idade, o resultado da idade e o convite guardado ainda não são zerados por instalação nesse caminho. Fica para um PR próprio.
- Push do sistema, login no iOS.
- O workflow `native.yml` não foi disparado.

### CI local

Na mesma árvore, no Mac (Node 24.22.1), na ordem da CI:

- `npm ci --ignore-scripts`, depois `npm run lint`: saiu com 0.
- `VARANDA_TEST_CONCURRENCY=6 npm test`: falharam 2 arquivos de `packages/core`, pacote que esta pilha não altera. `private-member.test.js` estourou o tempo de 30 s num teste sob a carga do pool e passou sozinho (207/207). `sync-groups.test.js` #34 ("a writer evicted by an earlier proven join is still purged when its diary forks", asserção "it was held before the eviction") falhou também sozinho na primeira vez (142/143) e passou sozinho na segunda: é o teste instável já conhecido. Os demais workspaces passaram (app: 94 arquivos, 0 falhas).
- `npm run demo`: `DEMO OK`.
- `npm run pack:worklet -w apps/app` ("node scan: clean") e `npx expo export --platform android` em `apps/app`: saíram com 0 (os comandos do workflow `native.yml`).
- O primeiro build local mostrou que a saída do Gradle dos módulos locais (`apps/app/modules/*/android/build/`) não estava no `.gitignore`; agora está.

## 66. App no simulador iOS depois da pilha "celular primeiro" (PR fix/ios-native-loop, 2026-11-02)

Mesmo roteiro da seção 65, agora no iOS, sobre `main@bc56143` (a pilha inteira já na `main`). Mac Apple Silicon, Xcode 26.2 (17C52), runtime iOS 26.2, simulador iPhone 17 Pro, CocoaPods 1.16.2. As capturas ficaram fora do repositório.

### Comandos e resultados

1. `npm ci --ignore-scripts`, depois `npm run prepare:native -w apps/app -- ios`: saiu com 0, "Pod installation complete! There are 95 dependencies from the Podfile and 97 total pods installed." e "prepare-native: ready (ios)".
2. O `pod install` acrescentou o pod `ExpoClipboard` (55.0.17), que faltava no `Podfile.lock` desde a entrada do `expo-clipboard`, e mudou as duas linhas de `SPEC CHECKSUMS` que dependem do caminho (`React-Core-prebuilt`, `ReactNativeDependencies`; veja a seção 7) e a indentação de `PrivacyInfo.xcprivacy`. Só o `ExpoClipboard` foi commitado. `node apps/app/scripts/check-pods-lock.js` acusou o lock antigo (as seis linhas do `ExpoClipboard` como "not committed", saída 1) e aceitou o novo contra o lock gerado (saída 0).
3. `xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build`: `** BUILD SUCCEEDED **`.
4. `xcrun simctl install` no iPhone 17 Pro, Metro com `npx expo start --port 8081 --clear` (`iOS Bundled 5108ms apps/app/index.js (988 modules)`) e `xcrun simctl launch ... app.varanda`.

### Observado

- O app abriu do Metro na introdução ("Seu diário, perto de você", Pular/Próximo). O aparelho de teste já tinha uma instalação anterior do app, que foi substituída sem apagar os dados.
- `xcrun simctl openurl ... 'varanda:///g/<64 hex>'` e a forma `/c/` (chave de teste `ab` repetido 32 vezes) foram entregues, o processo seguiu vivo e a tela continuou na introdução, porque não há instalação nem sessão para abrir o link. O Metro não registrou erro.

### O que não foi executado

- Entrar com passkey (depende do domínio associado da conta Apple Developer), telas que exigem conta, aparelho real, build de release.

## 67. Comunidades com grupos (PR feat/comunidades-com-grupos)

Uma comunidade passa a conter grupos: toda comunidade nasce com o grupo Geral, e só quem criou a comunidade cria grupos (pelo aparelho que a criou; administradores moderam, não criam). A pessoa entra na comunidade (aberta ou com aprovação) e, por ela, nos grupos. Sair ou ser banido na comunidade vale para todos os grupos dela: as mensagens antigas de quem sai continuam visíveis, mas quem sai não tem mais autoridade de moderação em nenhum grupo da comunidade, e um administrador que sai e volta precisa de nova nomeação. Os grupos privados seguem a comunidade (a chave troca depois de um banimento). Os grupos e comunidades do protocolo v1 são descartados. Normativo: seção 10 de `docs/protocol.md` e RPC 5.36 a 5.69 de `docs/rpc.md`.

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Cada arquivo roda sozinho (`node <arquivo>`); a suíte inteira roda com `VARANDA_TEST_CONCURRENCY=1` como na CI. Testes novos e reescritos (número de `test(` antes -> depois):

| Arquivo | Testes | O que cobre |
|---|---|---|
| `packages/core/test/community-fold.test.js` | 0 -> 93 | dobra do estado da comunidade: membros, pedidos, banimentos, administradores, Geral |
| `packages/core/test/records.test.js` | 37 -> 40 | `group-join` com `rejoin` (6 chaves), `group-cut`, `group-confirm` |
| `packages/core/test/group.test.js` | 101 -> 101 (103 na execução, por testes gerados em laço) | cabeçalho v2 (`community`, `member`) e regras do grupo |
| `packages/core/test/group-private.test.js` | 76 -> 103 | grupos privados que seguem a comunidade, troca de chave depois do banimento |
| `packages/core/test/community-member.test.js` | 11 -> 24 | operações de comunidade no nó do núcleo |
| `packages/core/test/community-member-leave.test.js` | 0 -> 44 | saída da comunidade no nó do núcleo (separado de `community-member.test.js`): confirmação, marcas, nota local, espera pelos grupos |
| `packages/core/test/group-member.test.js` | 50 -> 50 | grupos no nó, adaptados ao v2 |
| `packages/core/test/private-member.test.js` | 19 -> 19 | grupos privados no nó, adaptados ao v2 |
| `packages/core/test/seeder-communities.test.js` | 5 -> 8 | semeador com comunidades |
| `packages/core/test/group-index.test.js` | 10 -> 12 | índice e rota `/index/community/<C>/groups/<cursor>` |
| `packages/core/test/sync-communities.test.js` | 5 -> 7 | sincronização de comunidades |
| `packages/web-member/test/community-ops.test.js` | 12 -> 68 | operações de comunidade no pacote do navegador |
| `packages/web-member/test/community-sync.test.js` | 2 -> 5 | sincronização de comunidade no navegador |
| `packages/web-member/test/session-groups.test.js` | 14 -> 18 | sessão de grupos no navegador |
| `packages/web-member/test/groups-e2e.test.js` | 2 -> 2 | ponta a ponta com semeador na DHT local |
| `apps/app/test/group-flow.test.js` | 10 -> 30 | fluxos de lógica pura de comunidade e grupo |
| `apps/app/test/groups.test.js` | 15 -> 18 | linhas, papéis e rótulos |
| `apps/app/test/indexClient.test.js` | 37 -> 40 | rota de grupos da comunidade no índice |
| `packages/rpc/test/methods.test.js` | 55 -> 63 | contrato dos métodos `community.*` novos |
| `apps/cli/test/community-commands.test.js` | 1 -> 6 | `community join|leave|members|requests|admit|ban|meta` |
| `apps/cli/test/group-commands.test.js` | 2 -> 3 | `group create --community` |

Operador: ao iniciar depois da atualização, cada semeador descarta todos os núcleos de grupo e de comunidade do protocolo v1 (irreversível, eram dados de protótipo), e clientes antigos não enxergam nada do v2.

### Checagens humanas (a fazer)

Na web hospedada, contra um semeador local, como a seção 64 descreve:

1. **Criar uma comunidade.** O grupo Geral aparece.
2. **Entrar pelo link.** Outra conta entra pelo botão Compartilhar (link `/c/`, nunca mostrado cru) e cai no Geral.
3. **Novo grupo.** Só quem criou a comunidade vê Novo grupo e cria um grupo; um administrador não vê o botão.
4. **Banir e desbanir.** Banir alguém na comunidade some com as mensagens dessa pessoa em todos os grupos; desbanir traz de volta.
5. **Grupo privado.** Num grupo privado da comunidade, depois do banimento, a chave troca: as novas mensagens não chegam para quem saiu.
6. **Sair.** Sair da comunidade encerra a participação em todos os grupos; reentrar não ressuscita os grupos antigos.
7. **Pedir entrada.** Numa comunidade com aprovação, "Pedir entrada", desistir com "Desistir do pedido", e o pedido some da lista do administrador.
8. **Dados antigos.** Os grupos e comunidades antigos (protocolo v1) somem do app depois da atualização.
9. **Sair depois de um desbanimento parcial.** Uma conta com dois aparelhos na comunidade é banida; o desbanimento lista só um dos aparelhos. Pelo aparelho que continua banido, Sair funciona e a conta fica fora da comunidade e de todos os grupos dela.
10. **Quem criou sai por outro aparelho.** Quem criou a comunidade entra nela por um segundo aparelho e sai por ele. Depois que a confirmação da saída chega (o registro `group-confirm` daquela saída no diário; desligar o aparelho no diário não confirma nada), pelo aparelho que criou a comunidade (já de volta), tenta nomear um administrador: o app recusa, ou, se a nomeação for escrita, ela não vale para ninguém. Novo grupo e editar a comunidade também não valem mais; banir, admitir e ocultar continuam funcionando pelo aparelho novo.
11. **Quem criou sai e volta, nos grupos.** Quem criou a comunidade nomeia um administrador num grupo dela, sai da comunidade e volta. O administrador nomeado antes continua com o título no grupo. Um banimento escrito no grupo pelo aparelho que criou a comunidade, depois da saída, não vale.
12. **Tirar um administrador depois da volta.** Antes de sair, quem criou a comunidade nomeia um administrador pelo aparelho que a criou (simula um administrador nomeado por quem roubou esse aparelho). Quem criou sai e volta por um aparelho novo. Só depois que a saída está confirmada no diário (e, para um grupo, depois que o diário marcou a raiz do grupo), tira esse administrador pelo aparelho novo, da comunidade (e de um grupo, se for o caso): a pessoa perde o título. Antes disso, a retirada pelo aparelho novo não vale. Depois disso, banir essa pessoa funciona.
13. **Concluir saída.** Se a saída de quem criou a comunidade for interrompida (por exemplo, sem conexão no meio dela), o app mostra **Concluir saída** na tela da comunidade. Tocar no botão e confirmar termina a saída (o diário passa a ter o `group-confirm` dessa saída), e o botão some. Depois da sincronização, o administrador nomeado antes pelo aparelho que criou pode ser tirado pelo aparelho novo, como no item 12.
14. **Entrar depois de uma saída interrompida.** Quem criou a comunidade tem a saída interrompida (como no item 13) e, em vez de Concluir saída, toca Entrar (ou usa `varanda community join <chave>`). A saída é concluída primeiro: no diário aparecem as marcas das raízes e o `group-confirm` daquela saída antes da nova entrada na comunidade.
15. **Sair sem os dados de um grupo.** No aparelho de quem criou a comunidade falta a raiz de um grupo que essa pessoa criou (por exemplo, um grupo recém-criado por outro aparelho que ainda não sincronizou). Sair pede uma segunda confirmação, "Sair mesmo assim?"; confirmar sai, e esse grupo fica sem marca. Numa outra comunidade, esperar a sincronização e sair sem forçar: a saída marca o grupo.
16. **Mudar a entrada depois da volta.** Quem criou uma comunidade com aprovação muda a entrada para aberta, sai, volta e, pelo aparelho novo, muda a entrada de volta para com aprovação em Ajustes. A comunidade passa a pedir aprovação de novo.
17. **Tirar um grupo da lista depois da volta.** Quem criou sai e volta; pelo aparelho novo, na tela da comunidade, toca **Tirar da lista** num grupo indesejado e confirma: o grupo some da lista. O Geral não mostra o botão (`varanda community remove-group` no Geral responde "o grupo Geral só sai com a comunidade").
18. **Devolver à lista.** Depois do item 17, na seção **Tirados da lista**, quem criou toca **Devolver à lista** no grupo tirado e confirma: o grupo volta para a lista da comunidade.
19. **Saída espera os dados da comunidade.** No aparelho que criou a comunidade, enquanto os dados da comunidade ainda estão baixando, Sair pede uma segunda confirmação, "Este aparelho ainda não baixou tudo desta comunidade. Sair mesmo assim?" (sem confirmar, nada é gravado; a CLI responde "este aparelho ainda não baixou tudo da comunidade: aguarde para sair"). Confirmar com **Sair mesmo assim** (ou `varanda community leave <chave> --force`) sai, e o que ainda não chegou ao aparelho não conta. Sem forçar, depois de baixar, Sair funciona.
20. **Consertos continuam valendo.** Quem criou sai, volta por um aparelho novo, muda a entrada ou tira um grupo da lista por esse aparelho e depois sai por ele (saída confirmada no diário, gravada depois dos consertos). Os consertos continuam valendo: a entrada e a lista ficam como estavam. Uma mudança feita pelo aparelho antigo, de antes da primeira saída, não vale como conserto.
21. **Saída espera os outros aparelhos.** Quem criou a comunidade usa dois aparelhos nela; o segundo escreve algo que ainda não chegou ao primeiro. Sair pelo primeiro pede "Outro aparelho seu ainda não terminou de sincronizar esta comunidade. Sair mesmo assim?"; sem confirmar, nada é gravado (a CLI responde "aguarde a sincronização dos seus aparelhos nesta comunidade para sair"). Depois da sincronização, Sair funciona sem essa pergunta.

### Não verificado / limites conhecidos

- Resíduo de datação retroativa por um aparelho que já saiu: ele ainda pode acrescentar mensagens com data antiga. Não é impedido, porque a data é declarada pelo próprio aparelho; banir ou ocultar cobre essas mensagens, e a autoridade de moderação de quem saiu não volta.
- Aparelho antigo roubado: quem tem nas mãos um aparelho que já saiu da comunidade consegue esconder o que foi escrito por esse mesmo aparelho (decisão do ciclo 10). Ele não encerra a participação atual da conta: uma saída escrita por um aparelho antigo não conta.
- Quem criou a comunidade e saiu por outro aparelho: entre a saída honesta e a chegada da confirmação no diário dela, o aparelho que criou a comunidade ainda vale. Só a confirmação exata dessa saída no diário (`group-confirm`), assinado pela identidade, encerra os poderes da raiz; desligar o aparelho no diário não confirma nada.
- Quem criou a comunidade e saiu de verdade (saída confirmada no diário), ao voltar, não nomeia mais administradores e não cria grupos (decisão do dono do projeto): a raiz perde esses poderes para sempre a partir da saída, para que um aparelho perdido não os use depois. Pelo aparelho novo, continua moderando e pode consertar a comunidade: mudar o nome e a entrada, tirar grupos da lista (menos o Geral) e devolvê-los, e tirar o cargo de qualquer administrador. Esses consertos só valem quando feitos por um aparelho que voltou depois da saída que encerrou os poderes da raiz (os aparelhos de antes dessa saída nunca consertam), e continuam valendo depois que esse aparelho sai, a menos que uma saída confirmada no diário encerre esse aparelho antes deles. Uma saída falsa, sem a confirmação do diário, não tira esses poderes.
- Se a cópia dos dados da comunidade no aparelho que criou tem uma lacuna que nunca se completa, uma saída forçada gravada nesse aparelho só conta quando a lacuna se completar. Nesse caso, quem criou deve sair por outro aparelho.
- Um aparelho de quem já saiu só volta a contar na comunidade quando a entrada assinada pelo diário nomeia a mesma saída que o cabeçalho do aparelho. Um aparelho novo sem essa entrada fica de fora: não modera nem conserta.
- Quem criou a comunidade espera, ao sair, as raízes dos grupos que criou e marca todas as que tem no aparelho; a saída nunca fica bloqueada, porque "Sair mesmo assim" sai sem esperar. Um grupo que ficou sem marca, depois de uma saída confirmada, não tem nenhum poder pela raiz: o que quem criou fez nele como criador antes deixa de valer.
- A nota local da saída de quem criou é gravada antes da própria saída. Se o bloco gravado não for exatamente a saída que a nota descreve, o aparelho não confirma nada, a chamada falha com "a saída gravada não confere; tente sair de novo" e a nota fica. Uma saída no escritor do aparelho que não confere com a nota nunca é confirmada por esse aparelho.
- Só na web: enquanto o diário de quem criou a comunidade e já saiu dela uma vez tem um buraco na leitura do navegador, os grupos ignoram a moderação que o aparelho que criou fez antes, até o diário ficar completo. Isso nunca dá poder a ninguém, só tira por um tempo. O nó do núcleo lê o diário inteiro e não tem esse caso.
- Quem tem a identidade (a chave do diário) é a pessoa: fica fora do alcance do protocolo. Um aparelho roubado sem a chave do diário não apaga o histórico dos outros aparelhos da pessoa nem tira os poderes de quem criou a comunidade, porque só o diário confirma uma saída.
- O 32º grupo é o limite: só quem criou a comunidade cria grupos, então não há corrida; um grupo além do limite fica órfão.
- Os dados do protocolo v1 são descartados na atualização (irreversível).
- Um administrador rebaixado ainda pode escrever blocos de chave válidos na leitura, mas ninguém envia mensagens sob eles.
- Uma comunidade é sempre pública.
- A dica `attached` fica falsa enquanto a raiz de um grupo não é servida.
- A verificação de uma ocultação incerta lê só a página mais nova (já era assim, vinda de `Cadeira.js`).

## 68. Convite por link de comunidade e App Links no Android (PR feat/convite-por-link)

O link de comunidade cai num cartão de convite com um só botão (Entrar ou Pedir entrada) e a frase "Participar é público: sua entrada fica registrada no seu diário."; um link nunca entra por ninguém, só o toque grava a entrada no diário. O campo "Entrar por link" da aba Comunidades saiu: quem participa manda o link pelo Compartilhar e quem recebe toca nele. Sem nada da comunidade no aparelho, o cartão vem do índice do semeador e, quando a resposta da entrada é pendente, diz "Enviado. Aguardando a comunidade chegar a este aparelho.". Na web hospedada, o link `/c/` ou `/g/` tocado fica em `sessionStorage` (`varanda-entry-link`, até 1 h) para sobreviver à recarga do passo do Google, e a tela Entrar avisa do convite. No Android, o app declara App Links (`autoVerify`) só para `https://bora.varanda.app/c/` e `/g/`; um link https que chega antes de a instalação carregar espera e é lido de novo. No iOS os links universais esperam a conta Apple Developer.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes (número de `test(` e de asserções antes -> depois):

| Arquivo | Testes antes -> depois | Asserções antes -> depois | O que cobre |
|---|---|---|---|
| `apps/app/test/groupLink.test.js` | 9 -> 15 | 52 -> 114 | registro de 1 h `varanda-entry-link`, textos do aviso, armazenamento que recusa escrita |
| `apps/app/test/linkReturn.test.js` | 18 -> 19 | 162 -> 177 | link https que chega antes da instalação (`waitsForInstallation`) |
| `apps/app/test/groups.test.js` | 18 -> 17 | 306 -> 275 | saíram os leitores do campo removido |
| `apps/app/test/group-flow.test.js` | 30 -> 32 | 198 -> 202 | fluxo do cartão de convite e do resultado da entrada |
| `apps/app/test/nativeLinks.test.js` | 3 -> 6 | 10 -> 29 | `App.js`: `CAPTURED_ENTRY`, apagar antes de abrir, guardar e reler o link https antes da instalação, aviso na tela Entrar e **agora não**, nenhum `community.join` |
| `apps/app/test/eas-preview.test.js` | 8 -> 9 | 36 -> 50 | manifesto: um só filtro `autoVerify`, só `/c/` e `/g/` de `bora.varanda.app`, filtro `varanda:` e `singleTask` mantidos |

### Já conferido (pelo agente do mantenedor, 2026-11-03)

- `./gradlew assembleDebug` compilou com o filtro novo; o manifesto mesclado o tem.
- No emulador `varanda-api36` (Android 16, API 36), com `app.varanda.debug` instalado e aprovado à mão, `adb shell am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d https://bora.varanda.app/c/<64 hex>` abriu `app.varanda.debug/app.varanda.MainActivity` (partida a frio). `pm query-activities` listou o app primeiro para `/c/` e `/g/`. `https://bora.varanda.app/@ana` e `/account/app/conta` resolveram para o Chrome.

### Checagens humanas (a fazer)

1. **Android, verificação.** Com o APK de preview do EAS num celular, `adb shell pm get-app-links app.varanda` mostra `bora.varanda.app` verificado.
2. **Android, abrir o link.** Tocar num link `/c/` num app de conversa abre o app.
3. **Android, sem entrar.** A tela Entrar mostra "Você recebeu um convite para uma comunidade. Entre para ver e participar."; **agora não** descarta o link.
4. **Android, entrado.** A comunidade abre no cartão de convite.
5. **Android, Entrar e Pedir entrada.** O botão certo aparece conforme a entrada; quem já participa não vê o cartão.
6. **Android, Compartilhar.** Qualquer pessoa que abre a comunidade, participante ou não, consegue compartilhar.
7. **Android, link `/g/`.** Passa pela comunidade e abre o grupo depois da entrada.
8. **Android, partida a frio.** Com o app fechado, tocar no link abre o app e chega ao cartão.
9. **iOS, simulador.** `xcrun simctl openurl booted 'varanda:///c/<hex>'` mostra o mesmo fluxo; um link https abre o Safari.
10. **Web, contra um semeador local.** Sem entrar, abrir `/c/<hex>`, criar a passkey; o passo do Google recarrega em `/?conta=`; depois de desbloquear, a comunidade abre no cartão.
11. **Web, registro.** Depois de abrir, o `sessionStorage` não tem `varanda-entry-link`; recarregar não abre de novo; um registro com mais de 1 h não abre nada.
12. **Web, navegador embutido.** O aviso diz "Para participar, abra este link no Chrome ou no Safari.", com copiar e compartilhar, sem mostrar o link como texto.
13. **Web, aba Comunidades.** Não há campo "Entrar por link".

### Não verificado / limites conhecidos

- Links universais no iOS esperam a conta Apple Developer (`Varanda.entitlements` está vazio); links https abrem o Safari.
- O build de depuração (`app.varanda.debug`) não está no `assetlinks.json`; abre os links só depois de `adb shell pm set-app-links-user-selection --user cur --package app.varanda.debug true bora.varanda.app`.
- Outra instalação (outro domínio) não ganha App Links.
- No Android com o app instalado, um link `/c/` ou `/g/` de `bora.varanda.app` sempre abre o app; se o app estiver ligado a outra instalação ou a um nó manual, o link é descartado (antes abria no navegador).
- Armazenamento que recusa escrita guarda o link só até a página recarregar.
- O registro da aba não é confiável: só nomeia uma tela a abrir.
- Um convite de perfil e um link de comunidade pendentes ao mesmo tempo abrem os dois depois de entrar.
- Uma comunidade cuja entrada seguiu pelo caminho pendente responde com o papel `pending`; reabrir a tela antes de sincronizar pode mostrar de novo o cartão do índice com Entrar (tocar de novo é idempotente).

## 69. Conversas: mensagens privadas (pilha feat/dm-core ... feat/dm-reports-push)

Mensagens privadas 1:1, só texto, cifradas de ponta a ponta, na aba **Conversas** (id interno `comunidades`, ícone `conversas`). O seletor é Mensagens | Comunidades. Quem a pessoa segue cai em Mensagens; quem ela não segue cai em Pedidos de mensagem, com um ponto e nunca uma contagem. Aceitar, recusar e bloquear não avisam a outra pessoa. Não há confirmação de leitura, fotos nem indicador de digitação. Apagar vale neste aparelho e nos outros aparelhos da mesma pessoa; a outra pessoa fica com a cópia dela. A denúncia (`dm.reportSign`, `varanda-dm-report-v1`) leva a mensagem escolhida e a chave do diário de quem enviou, no campo `target`, para a moderação poder bloquear a conta. Não leva o resto da conversa nem a assinatura de quem enviou. No painel a citação sai com o rótulo "Texto não conferido". Normativo: seção 11 de `docs/protocol.md` e RPC 5.73 a 5.81 de `docs/rpc.md`. A descrição para quem usa o app está em `docs/app.md`, seção Conversas.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Cada arquivo roda sozinho (`node <arquivo>`). A suíte inteira usa `VARANDA_TEST_CONCURRENCY=1`, como a CI. Nenhum teste usa a DHT pública.

Testes desta funcionalidade:

| Arquivo | O que cobre |
|---|---|
| `packages/core/test/dm.test.js` | quadro, texto interno, lacre e constantes |
| `packages/core/test/dm-fold.test.js` | pedido, aceite, recusa, bloqueio, apagar, ponto sem contagem |
| `packages/core/test/dm-net.test.js` | canal `varanda/dm/1`; a transcrição não leva chave de diário |
| `packages/core/test/dm-pool.test.js` | conjunto, reinício, diretório sem chave de diário, varredura de 7 dias com o relógio adiantado (8 dias sai, 1 dia fica) |
| `packages/core/test/dm-postage.test.js` | selo RSA cego |
| `packages/core/test/dm-stamp-net.test.js` | canal `varanda/dm-stamp/1`; o registro `{ event: 'dm-stamp', reason }` não leva chave |
| `packages/core/test/dm-session-refuse.test.js` | o nó do núcleo recusa `dm.*` antes de abrir qualquer coisa |
| `packages/core/test/seeder-dm.test.js` | o semeador guarda, pagina e mantém o conjunto ao reiniciar; `seed --no-dm` deixa os dois canais sem suporte |
| `packages/core/test/records.test.js` | registro `dm-key` (`DM_KEY_KEYS`) |
| `packages/core/test/report.test.js` | denúncia `varanda-dm-report-v1`, com `target` e sem assinatura de quem enviou |
| `packages/rpc/test/methods.test.js` | contrato dos métodos `dm.*` |
| `packages/rpc/test/envelope.test.js` | evento `dm.changed` |
| `packages/web-member/test/dm.test.js` | pedido, aceite, bloqueio, segundo aparelho, `ctl` que não vai ao par, nada em claro no disco |
| `packages/web-member/test/dm-store.test.js` | a cópia local reabre com a mesma chave e fica cifrada em repouso |
| `packages/web-member/test/dm-link.test.js` | selo e canal anônimo contra um semeador |
| `packages/web-member/test/passkey.test.js` | derivação da chave de caixa e da chave local a partir da passkey |
| `packages/web-member/test/dm-e2e.test.js` | ponta a ponta na DHT local |
| `apps/app/test/dm.test.js` | rótulos, seletor Mensagens e Comunidades, ponto sem contagem, sem confirmação de leitura |
| `apps/app/test/conversas.test.js` | telas de Conversas |
| `apps/app/test/help.test.js` | folha "Como funcionam as Conversas" |
| `apps/app/test/tabBar.test.js` | aba Conversas, id `comunidades`, ícone `conversas`; cinco abas fora do nó hospedado |
| `apps/app/test/legal.test.js` | `LEGAL_VERSION` 11 |
| `packages/core/test/terms.test.js` | `TERMS_VERSION` 11 |
| `packages/core/test/dm-wake.test.js` | o sinal `dm-wake`: formato exato, sem chave nem texto, não é evento de membro |
| `apps/cli/test/dm-report.test.js` | denúncia de mensagem privada no serviço de conta, com `target` e a citação não conferida |
| `apps/cli/test/moderation-store.test.js` | a denúncia de mensagem privada no armazém de moderação |
| `apps/cli/test/ai-worker.test.js` | a triagem automática e a denúncia de mensagem privada |
| `apps/cli/test/account-push.test.js` | rotas de push do serviço de conta, com o aviso de mensagem |
| `apps/cli/test/push-relay.test.js` | o relé de push e o aviso de mensagem |
| `apps/cli/test/push-store.test.js` | o armazém de push e o aviso de mensagem |
| `apps/app/test/sw.test.js` | o service worker mostra o aviso de mensagem com a frase fixa, sem nome, e abre o app ao tocar |
| `apps/app/test/report.test.js` | a denúncia de mensagem privada no app |
| `apps/app/test/terms-version.test.js` | versão dos termos igual no app e no núcleo |
| `apps/cli/test/seed-ops.test.js` | `seed --no-dm` e a rotação de `dm-postage.json` |
| `apps/cli/test/cli.test.js` | a opção `--no-dm` |

A varredura de 7 dias é o teste de relógio adiantado em `packages/core/test/dm-pool.test.js`. Não é um passo de aparelho.

### Checagens humanas (a fazer)

Primeiro no Android, com dois apps instalados (duas contas). Depois o mesmo roteiro no simulador iOS. Por último na web, contra um semeador local. As caixas ficam desmarcadas até alguém executar o passo.

#### Android (dois apps instalados)

A segue B. B não segue A.

- [ ] A envia uma mensagem a B.
- [ ] B vê a linha Pedidos de mensagem, com um ponto e sem contagem. A não vê estado de leitura.
- [ ] B aceita e responde. A vê a resposta. B não recebe confirmação de que A leu.
- [ ] B recusa um estranho C. C não fica sabendo de nada (nem aceite, nem recusa, nem leitura).
- [ ] Uma mensagem posterior de C abre um pedido novo.
- [ ] B bloqueia D. A mensagem seguinte de D não aparece para B.
- [ ] B apaga a conversa num aparelho. O outro aparelho de B perde a conversa depois de um `dm.pull`. A continua com a cópia dela.
- [ ] Um segundo aparelho da mesma passkey vê o que foi enviado, o que foi recebido e o estado aceito.
- [ ] A folha de denúncia mostra só a mensagem escolhida e a frase "Só esta mensagem e a conta de quem enviou vão para a moderação. Nada mais da conversa."
- [ ] A abertura e a barra do topo continuam com a cadeira. O estado vazio dentro de Comunidades continua com o ícone `cadeira`.
- [ ] Na configuração manual a barra tem cinco abas e não tem Conversas.

#### iOS (simulador)

- [ ] Repetir o roteiro do Android no simulador iOS (duas contas; A segue B e B não segue A).

#### Web (semeador local)

- [ ] Repetir o roteiro de mensagem, Pedidos, aceite, resposta, recusa de C, pedido novo, bloqueio de D e apagar em dois aparelhos.
- [ ] Com os avisos no aparelho ligados, o push de mensagem diz só "Pode haver uma mensagem nova na Varanda", sem nome e sem texto, no máximo um a cada 15 minutos.
- [ ] O painel de moderação mostra a citação com o rótulo "Texto não conferido" e dá para bloquear a conta de quem enviou (`target` é a chave do diário).
- [ ] O registro do semeador (`{ event: 'dm', reason }` e `{ event: 'dm-stamp', reason }`) não traz chave, endereço nem texto.
- [ ] Reiniciar o semeador mantém o conjunto.
- [ ] A abertura e a barra do topo continuam com a cadeira.
- [ ] A configuração manual continua com cinco abas, sem Conversas.
- [ ] `LEGAL_VERSION` (`apps/app/src/legal.js`) e `TERMS_VERSION` (`packages/core/lib/terms.js`) são 10. Em `docs/design.md`, seção LGPD, existem as linhas Mensagens diretas, Envelopes de mensagens diretas, Selos de envio e Denúncia de mensagem direta.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação.
- O nó hospedado acha o `dm-key` na réplica local ou nas `DM_LOOKUP_WINDOWS` = 8 janelas mais novas de `PEEK_WINDOW` = 36 blocos. Um `dm-key` muito antigo, num diário longo, pode passar despercebido até essa pessoa abrir o app de novo (o app publica o `dm-key` uma vez por sessão destravada).
- Depois de uma troca de `gen`, envelopes lacrados para a geração antiga que ainda estão no conjunto não são abertos.
- O primeiro envio logo depois de ligar pode responder "o limite de envio de hoje acabou" até a primeira recarga de selos (`DM_STAMP_WALLET`) terminar.
- O app instalado não tem aviso do sistema. A novidade só aparece com o app aberto (`dm.pull`, `DM_PULL_EVERY_MS` = 120000) e pelo ponto.
- Um aparelho offline por mais de sete dias (`DM_RETENTION_MS`) perde o que a varredura já tirou.
- `seed --no-dm` deixa os dois canais sem suporte. Sem a opção, ficam ligados.

## 70. Chegar em A Rua depois de configurar a conta (PR fix/rua-after-onboarding)

`apps/app/App.js` abria Ajustes › Conta em toda carga `/?conta=` assim que `setupStep` ficava falso, para quem acabava de criar a conta e para quem já tinha certificado. `linkReturnTaker` em `apps/app/src/linkReturn.js` entrega a volta de quem é novo ao passo de configuração, que já conclui o vínculo, e abre a folha só para quem já tinha certificado. Logo depois de desbloquear, enquanto "Buscando sua conta…" segura a leitura do shell, o botão "confirmar vínculo" já funciona; por isso o cartão avisa o shell, por `onLinked`, assim que grava o certificado. No nativo nada muda.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes (número de `test(` e de asserções antes -> depois):

| Arquivo | Testes antes -> depois | Asserções antes -> depois | O que cobre |
|---|---|---|---|
| `apps/app/test/linkReturn.test.js` | 19 -> 25 | 177 -> 214 | `linkReturnTaker` (volta de pessoa nova fica com o passo de configuração, nada decidido atrás dos Termos, quem já tinha certificado recebe Ajustes › Conta, campos ausentes nunca dão `conta`), a varredura de `App.js` (uma só chamada `setAjustes('conta')`, dentro do efeito novo; a guarda antiga sumiu) e a de `Identidade.js` (o cartão do passo de configuração chama `onLinked` logo depois de gravar o certificado; só o Identidade da configuração recebe `onLinked`); contra o `App.js` e o `Identidade.js` antigos: 23/25 testes, 203/214 asserções |

### Checagens humanas (a fazer)

1. **Web, pessoa nova.** Contra um semeador local: criar a passkey, passo do Google, recarga em `/?conta=`, desbloquear, confirmar vínculo, nome (ou "Pular por enquanto"): as abas abrem em A Rua, sem folha por cima.
2. **Web, quem já tinha certificado.** Vincular o Google em Ajustes › Conta; depois da volta e do desbloqueio, a folha Conta abre uma vez e oferece "confirmar vínculo".
3. **Web, convite `/@nome` para pessoa nova.** Depois da configuração, Membro abre por cima das abas, sem a folha Conta no meio (a seção 26 descreve o caminho antigo e fica como registro).
4. **Android (build de debug).** Passkey, sessão do Google no app, nome ou pular: A Rua, sem folha.
5. **iOS (simulador).** O mesmo fluxo do item 4.
6. **Web, pessoa nova, confirmar durante a recuperação.** Como no item 1, mas tocar em "confirmar vínculo" enquanto "Buscando sua conta…" ainda aparece: as abas abrem em A Rua, sem folha por cima.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- As voltas `lista-de-espera` e `convite-invalido` continuam no passo de configuração, como antes.
- Se o envio do @nome falha logo depois de a pessoa nova confirmar o vínculo, a folha Conta não abre mais sozinha para oferecer "enviar o @nome de novo"; o botão continua em Ajustes › Conta.
- O Android e o iOS não mudam de código (só as checagens 4 e 5).

## 71. Barra de ícones, sino, Busca e perfis iguais (PR feat/app-ux-icones)

A barra de baixo passa a mostrar só ícones (A Rua com a estrada, Espiadinha, Conversas no nó hospedado, Busca com a lupa e Diário com a foto da própria pessoa), de 49 pt como antes. Avisos sai da barra e abre pelo sino no canto direito da barra do topo de A Rua, Espiadinha, Conversas e Busca e pelo sino branco da faixa do Diário. Seguindo vira uma lista aberta por "N seguindo" no Diário, com o campo "Filtrar nesta lista". A nova aba Busca tem as categorias Contas e Publicações. A Espiadinha perde o campo de pesquisa por assunto. Membro ganha o desenho do Diário. Neste PR a contagem e a lista de seguidores ainda não existem (elas chegam, públicas, na seção 74). Os textos estão em `apps/app/src/buscaGlobal.js`, `apps/app/src/peopleFilter.js`, `apps/app/src/tabs.js` e `apps/app/src/help.js`.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes novos ou alterados: `apps/app/test/buscaGlobal.test.js` (categorias, textos, plano de consulta de Contas e de Publicações), `apps/app/test/peopleFilter.test.js` (o filtro local de Seguindo), `apps/app/test/tabBar.test.js` e `apps/app/test/nav.test.js` (abas, ordem, pilha com Seguindo) e `apps/app/test/help.test.js` (folhas de ajuda).

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada), depois no iOS (simulador) e na web.

1. **Barra.** Cinco ícones sem palavras, na ordem A Rua (estrada com a faixa tracejada), Espiadinha, Conversas, Busca (lupa) e Diário (a foto da própria pessoa ou as iniciais, com anel verde quando selecionado). Numa configuração manual são quatro, sem Conversas. TalkBack e VoiceOver leem os nomes.
2. **Sino.** O sino aparece no canto direito da barra do topo de cada aba (A Rua, Espiadinha, Conversas, Busca) e, branco, no canto da faixa do Diário. Com novidade em Avisos há um ponto no sino (nunca um número). Tocar abre Avisos com o título "Avisos" e a seta de voltar, que leva à aba anterior; o ponto some. Um push de quem seguiu ainda abre Avisos.
3. **Busca › Contas (hospedado).** Nome e @nome buscam depois de 2 letras; "Seguir @nome" segue; o código de 64 letras e números mostra "Seguir"; um código incompleto mostra "Código incompleto: são 64 letras e números.". Numa configuração manual só há o campo "Cole o código da pessoa (64 letras e números)." e a pílula "Seguir".
4. **Busca › Publicações.** Só pesquisa ao enviar, nunca a cada tecla; mostra os resultados; "limpar" apaga; cada categoria guarda o próprio rascunho ao trocar. Numa configuração manual aparece "Só na versão web", sem nenhum pedido.
5. **Espiadinha.** Sem campo de pesquisa; carrega e atualiza como antes.
6. **Seguindo.** "N seguindo" no Diário abre a lista. O campo "Filtrar nesta lista" ("nome ou @nome") reduz a lista no aparelho, com a dica "Para encontrar outra conta, use a Busca." e, sem correspondência, "Ninguém com esse nome nesta lista."; colar um código de 64 letras e números não segue ninguém; "Deixar de seguir" ainda pede confirmação; voltar retorna ao Diário. Sem internet, com nomes ainda não lidos, o filtro mostra "Carregando nomes…" e pede os nomes de novo enquanto a tela está no topo; ao voltar a conexão, eles aparecem.
7. **Perfil de outra pessoa.** Tem o desenho do Diário: faixa atrás da barra de estado com a barra de estado clara, o círculo de voltar no canto esquerdo da faixa acessível (não coberto pelo avatar), avatar com anel à esquerda, nome, @nome, bio e as pílulas Seguir, Mensagem (hospedado) e denunciar a conta, todas funcionando.
8. **Seguidores.** Avisos não mostra contagem nem lista de seguidores. (A contagem e a lista públicas de seguidores nos perfis chegam na seção 74.)

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Limite aceito: as contagens da Espiadinha podem demorar a refletir uma curtida feita na Busca até a próxima atualização dela.
- Limite aceito: Avisos não entra na pilha de telas. Na web, o botão Voltar do navegador não fecha Avisos (era assim quando Avisos era aba); Esc, a seta da barra do topo, o ícone da aba anterior e o Voltar do Android fecham.
- Limite aceito: no perfil de outra pessoa, como no Diário, a barra de estado fica clara mesmo depois que a faixa sai da tela ao rolar.
- Com o filtro de Seguindo, a lista lê mais páginas sozinha pela regra de todas as listas (pausa depois de 3 páginas sem linha nova, com "Nada novo nas últimas páginas." e "carregar mais"), e só com a tela no topo, porque cada leitura interrompe a sincronização. Sem resultado entre as linhas já lidas, mostra "Ninguém com esse nome entre os já carregados.".

## 72. Convidar por @nome pelas Conversas (PR feat/convidar-por-nome)

Quem pode convidar (criação, administradores e, com "Membros podem convidar", os membros) vê **Convidar** na comunidade e **Convidar para o grupo** nos Ajustes do grupo. Digita @nome ou escolhe na busca, vê a pessoa e toca em Convidar. O app confere `dm.lookup`; sem Conversas, mostra "Essa pessoa ainda não usa as Conversas. Mande o link pelo Compartilhar."; com Conversas, manda uma mensagem privada (`dm.send`) "Convite para a comunidade X na Varanda: <link>" (ou a forma de grupo). Envio incerto mostra "Não deu para confirmar se o convite foi enviado. Tente de novo: a mensagem não se repete." e **Tentar de novo**, que reenvia o mesmo texto, nunca sozinho. Na conversa, um link de convite desta instalação mostra **Abrir convite**, que abre o cartão de convite; abrir nunca entra. Links de outros endereços são ignorados.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Cada arquivo roda sozinho (`node <arquivo>`).

| Arquivo | O que cobre |
|---|---|
| `apps/app/test/inviteMessage.test.js` | 12 testes: texto do convite (também de grupo sem nome), corte dos nomes, reconhecimento estrito do link (só no começo do texto ou depois de espaço, o último link vale) |
| `apps/app/test/group-flow.test.js` | dois testes novos: seção Convidar e Convidar para o grupo, consulta ao nó antes do envio, membro conferido no nó, Tentar de novo com o mesmo texto e nenhum envio dentro de um efeito |
| `apps/app/test/conversas.test.js` | o teste novo da linha de mensagem com Abrir convite |

### Checagens humanas (a fazer)

Primeiro no Android, depois no simulador iOS, por último na web contra um semeador local. As caixas ficam desmarcadas até alguém executar o passo.

#### Android (APK de preview do EAS, com contas)

- [ ] Um administrador convida @nome na comunidade. A pessoa recebe a mensagem nas Conversas; em Pedidos de mensagem se não seguir quem convidou.
- [ ] **Abrir convite** abre a comunidade no cartão de convite.
- [ ] Abrir o convite não entra: só o toque em **Entrar** (ou **Pedir entrada**) grava a entrada.
- [ ] Repetir em Ajustes do grupo, com **Convidar para o grupo**.
- [ ] Um membro só vê **Convidar** quando a regra é "Membros podem convidar".
- [ ] Uma pessoa sem Conversas faz aparecer "Essa pessoa ainda não usa as Conversas. Mande o link pelo Compartilhar."
- [ ] Com o envio incerto (rede cortada logo após tocar), aparece o texto de incerteza e **Tentar de novo**; a pessoa convidada recebe uma só mensagem.

#### iOS (simulador)

- [ ] Repetir o roteiro do Android no simulador iOS.

#### Web (semeador local)

- [ ] Repetir o roteiro: convite por @nome, Pedidos, Abrir convite, Entrar ainda necessário, regra Membros podem convidar, pessoa sem Conversas e Tentar de novo.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação.
- A pessoa convidada precisa usar as Conversas; sem elas, só o link pelo Compartilhar.
- "Quem pode convidar" controla só o botão: qualquer pessoa ainda pode mandar o link pelo Compartilhar ou colá-lo numa mensagem.
- O convite não aprova a entrada. Os administradores não veem "convidado por".

## 73. Comunidade estilo Telegram: lista de grupos, Informações e não lidas (PR feat/comunidade-lista-grupos)

A tela da comunidade virou a lista dos grupos. A barra do topo mostra o avatar, o nome e só o número de membros; tocar no nome ou no **⋯** abre **Informações da comunidade**, também enquanto a comunidade ainda chega ("Aguardando a sincronização desta comunidade.", só com **Compartilhar**). Cada grupo mostra quem escreveu por último, o texto, a hora e o selo de não lidas ("99+" a partir de 99). Abrir um grupo zera o selo só neste aparelho. A marca de lido só é gravada pela tela do grupo que está no topo; uma tela coberta relê, mas não marca, e marca ao voltar ao topo. Em Informações ficam Compartilhar, Sair ou Desistir, Concluir saída, Sair mesmo assim, Convidar, Membros, Pedidos, Quem pode convidar e Ajustes. Entrar, o cartão de convite, o índice do semeador como alternativa, Novo grupo, Tirar da lista e Devolver à lista continuam na lista. A aba Comunidades e o ponto da aba não mudaram.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Cada arquivo roda sozinho (`node <arquivo>`).

| Arquivo | O que cobre |
|---|---|
| `apps/app/test/groups.test.js` | `unreadLabel` (vazio abaixo de 1, número até 98, "99+" a partir de 99) e `lastLine` (quem escreveu e o texto; uma mensagem escondida só mostra o rótulo fixo) |
| `apps/app/test/group-flow.test.js` | a lista abre Informações e mostra a última linha e a contagem; Informações tem o caminho de sair e nunca entra (sem cartão de convite, sem `community.join`); a tela do grupo marca como lido uma vez, depois da leitura mais nova, e não marca quando está coberta; a tela do grupo envia como corte (`upTo`) a linha mais nova que pintou, sem corte não envia nada; a tela do grupo avisa a lista após cada tentativa de `group.seen`, mesmo quando falha |
| `apps/app/test/nav.test.js` | `comunidade-info` é uma tela da pilha, com chave hex64 como `grupo` e `comunidade` |
| `apps/app/test/shareOrigin.test.js` | o link de compartilhar da comunidade usa a origem da instalação |
| `apps/app/test/tabBar.test.js` | o botão publicar some na tela `comunidade-info`, como em grupo e comunidade |
| `packages/core/test/group-seen.test.js` | `community.info` com `last` e `unread` por grupo; `group.seen` marca a mensagem mais nova, ou a de corte (`upTo`), que nunca marca além dela nem uma mensagem não listada; quem não lê não recebe texto cifrado; contagem para em 99; a marca só avança e fica no máximo em 512 grupos |
| `packages/web-member/test/group-seen.test.js` | a marca no kv `groupSeen` (uma por grupo, a mais nova no fim, até 512); as linhas de `community.info` no navegador (própria e escondida não contam); `group.seen` só grava quando muda; com corte, grava a mensagem listada com o `at` do nó e não grava corte desconhecido ou pendente; `deleteGroupData` remove a marca |
| `packages/rpc/test/methods.test.js` | `group.seen` na lista de métodos, não mutante, com `group` e `upTo` opcional (forma de `before`, formas inválidas recusadas); `community.info` continua não mutante |
| `packages/rpc/test/sizes.test.js` | `community.info` no pior caso (32 grupos com nomes máximos) cabe no limite de mensagem |

### Checagens humanas (a fazer)

As caixas ficam desmarcadas até alguém executar o passo. Primeiro no Android, depois no simulador iOS, por último na web contra um semeador local.

#### Android (APK de preview do EAS, com contas)

- [ ] A lista mostra, em cada grupo, quem escreveu por último, o texto, a hora e o selo de não lidas.
- [ ] Abrir um grupo e voltar zera só o selo dele; os outros grupos mantêm o deles.
- [ ] Com 99 ou mais mensagens não lidas, o selo mostra "99+".
- [ ] Depois de fechar e abrir o app, as contagens continuam como estavam.
- [ ] Tocar no nome da comunidade ou no ⋯ abre Informações; voltar leva à lista.
- [ ] Numa comunidade ainda chegando, Informações mostra o título "Comunidade ainda chegando", só **Compartilhar** e "Aguardando a sincronização desta comunidade.".
- [ ] Em Informações: Compartilhar, Sair da comunidade, Concluir saída e Sair mesmo assim funcionam como antes, cada um conforme o papel.
- [ ] Convidar por @nome, Membros, Pedidos, Quem pode convidar (Só administradores e Membros podem convidar) e Ajustes (renomear, entrada e administradores) continuam funcionando.
- [ ] Na lista, o cartão de convite de quem não participa ainda entra com um toque, e Tirar da lista e Devolver à lista continuam no criador com o reparo ativo.
- [ ] Um grupo privado ou bloqueado mostra a linha sem texto cifrado.
- [ ] Uma mensagem escondida aparece como "mensagem escondida".
- [ ] A sua última mensagem mostra "Você:" em verde; a de um par com o nome "Você" aparece em cinza, como qualquer outro nome.
- [ ] Enquanto a comunidade ainda chega, a barra do topo mostra o nome que o índice já deu; sem ele, "Comunidade ainda chegando".

#### iOS (simulador)

- [ ] Repetir o roteiro do Android no simulador iOS.

#### Web (semeador local)

- [ ] Repetir o roteiro do Android no navegador.
- [ ] Recarregar a página mantém as contagens de não lidas.
- [ ] Sem a comunidade neste aparelho, a lista do índice mostra o cartão, **Compartilhar** e os grupos, sem última mensagem nem selo.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação.
- A marca de lido é por aparelho: outro aparelho, ou outro navegador, conta de novo as não lidas.
- A marca vale para no máximo 512 grupos; o grupo cuja marca foi descartada (a menos marcada recentemente) volta a contar como nunca lido.
- A primeira visita pode mostrar não lidas antigas até cada grupo ser aberto.
- A tela do grupo envia a mensagem mais nova que pintou como corte (`upTo`, seção 76), então uma mensagem que chega entre a pintura e a marca fica não lida até a tela pintá-la. Um cliente que ainda omite o corte continua marcando a mensagem mais nova que o nó tem quando atende o pedido, como antes.
- Se a releitura do grupo falhar, nada é marcado até a próxima leitura que der certo: a contagem pode ficar, mas nunca some antes da hora.
- A aba Comunidades e o ponto da aba não mudaram; não há número na aba.

## 74. Seguidores públicos (PR feat/seguidores-publicos)

Por decisão dos donos do projeto, a contagem e a lista de seguidores são públicas: quem usa o site da associação ou o app ligado à instalação vê, em qualquer conta, "N seguindo" e "N seguidores", e cada número abre a lista (Seguindo, Seguidores) com o campo "Filtrar nesta lista", que só filtra essa lista. O Diário mantém o "N seguindo" do nó local (`node.info.followCount`) e ganha "N seguidores" do semeador; o perfil de outra pessoa mostra os dois do semeador. O semeador responde `GET /index/follows/<author>` e `GET /index/follows/<author>/(seguindo|seguidores)[/<cursor>]` (`Seeder#indexFollowCounts` e `Seeder#indexFollows`, `packages/core/lib/notices.js` `followCounts` e `followsPage`; protocol §5 "Seeder follow index" e §7). Cada linha é um registro de seguir assinado, conferido com `diary.peek` antes de aparecer. Avisos continua privado e com prova. Termos e Política vão à versão 12, com novo aceite.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes novos ou alterados: `packages/core/test/notices.test.js` (`followsPage`, `followCounts`, regra de omissão, tetos), `apps/cli/test/seeder-notices.test.js` e `apps/cli/test/seed-ws.test.js` (as duas rotas, 404, cursor, tamanho máximo), `apps/app/test/indexClient.test.js` (`followsUrl`, `validFollows`), `apps/app/test/pessoas.test.js` (conferência com `diary.peek`, textos), `apps/app/test/nav.test.js`, `apps/app/test/help.test.js`, `apps/app/test/legal.test.js` e `packages/core/test/terms.test.js` (versão 12).

Contra o semeador da demo (`npm run demo` imprime a URL do semeador; `<hex64>` é a chave de um diário servido):

```sh
curl -s <url-do-semeador>/index/follows/<hex64>
curl -s <url-do-semeador>/index/follows/<hex64>/seguidores
```

A primeira devolve `{ seguindo, seguidores, indexing, complete }`; a segunda, `{ author, kind, items, next, total, authors, indexing, complete }` com no máximo 20 itens. Uma chave desconhecida ou bloqueada dá 404 `não encontrado`.

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada), depois no iOS (simulador) e na web.

1. **Diário.** Mostra "N seguindo" (do nó local) e "N seguidores" (do semeador). Tocar em cada um abre a lista Seguindo ou Seguidores, com o título certo e a seta de voltar.
2. **Perfil de outra pessoa.** Mostra "N seguindo" e "N seguidores" do semeador; cada um abre a lista dessa pessoa.
3. **Listas.** O cabeçalho mostra "N pessoas" ("1 pessoa"); as linhas têm avatar, nome e @nome e abrem o perfil; a lista pagina até o fim.
4. **Filtro.** "Filtrar nesta lista" reduz só a lista aberta, no aparelho, sem pedir nada ao semeador.
5. **Seguir.** Seguir alguém aumenta o "seguidores" dessa pessoa depois de puxar para atualizar (o semeador precisa ler o diário; até lá o número pode atrasar).
6. **Deixar de seguir.** Cai o "seguidores" dela depois que o semeador relê o diário.
7. **Bloqueado.** Um membro bloqueado não aparece em nenhuma lista nem entra em nenhuma contagem.
8. **Configuração manual.** No Diário só aparece "N seguindo"; nos perfis não aparece nada; a lista aberta mostra "Disponível no site da associação ou no app ligado à instalação.".
9. **Nota.** Enquanto o semeador ainda lê os diários (logo depois de reiniciar), os números do perfil mostram "A contagem pode estar incompleta." e a lista mostra "A lista pode estar incompleta.".
10. **Termos.** Com os Termos e a Política já aceitos na versão 11, o app pede o aceite da versão 12 antes de qualquer tela.
11. **Avisos.** Continua sem contagem nem lista de seguidores e só com prova.
12. **curl.** Os dois comandos acima devolvem o formato descrito.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Limite aceito: a contagem do semeador inclui só membros admitidos e visíveis nesse semeador (contas de fora da associação nunca aparecem), então pode ser menor que o "N seguindo" do próprio Diário, que conta todo seguir do nó local; os tetos de 4096 seguidos e 64 contas de fora por diário só marcam a lista Seguindo como incompleta.
- Limite aceito: enquanto o semeador lê os diários (`indexing`, ou um diário pendente), as contagens e as listas podem estar incompletas, e a nota "A contagem pode estar incompleta." (sob os números do perfil) ou "A lista pode estar incompleta." (na lista) aparece.
- Limite aceito: o semeador fica sabendo de qual perfil a lista foi aberta.
- Limite aceito: quem segue a partir de um diário que passou de um teto do semeador (4096 seguidos por diário, 262144 no total) pode faltar na lista Seguidores de quem foi seguido, sem a nota de incompleta, que só aparece enquanto o semeador lê os diários (decisão do mantenedor).
- Limite aceito: a ordem usa a data `at` escrita por quem segue; um registro com data no futuro aparece no topo das listas Seguidores e Seguindo.
- Limite aceito: a rota de contagens tem um só `complete` para os dois números, então, num diário que passou de um teto ao seguir, a nota "A contagem pode estar incompleta." pode ficar no Diário mesmo com "N seguidores" completo.
- Depois de seguir alguém, o "N seguidores" dessa pessoa só muda depois de puxar para atualizar, quando o semeador já leu o novo registro.
- Limite aceito: um semeador mentiroso pode omitir linhas ou apontar para um registro de seguir autêntico mais velho (a conferência não prova que não existe um "deixar de seguir" posterior); não pode forjar um seguidor.

## 75. Avisos de curtidas e republicações (PR feat/avisos-curtidas)

Avisos passa a mostrar quem curtiu e quem republicou uma publicação da própria pessoa, ao lado de seguir, resposta, citação e menção. Uma linha por curtida e uma por republicação: "<nome> curtiu sua publicação" e "<nome> republicou sua publicação". Tocar na linha abre essa publicação. O estado vazio usa o texto de `EMPTY_TEXT` em `apps/app/src/notices.js`. Mensagens privadas continuam em Conversas. O canal novo é `varanda/notices/3` (`docs/protocol.md`, "Notices channel v3" e "Notices link"). `varanda/notices/1` e `varanda/notices/2` não mudam: um tipo desconhecido numa página v2 invalida a mensagem `items` inteira, e um cliente antigo a recusa por completo.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test`. Nenhum teste desta parte usa a DHT pública (DHT local em `helpers/net.js`, diretório temporário). As caixas abaixo ficam desmarcadas até alguém executar o passo. Dois membros hospedados, A e B, em dois navegadores, contra um semeador com esta mudança.

- [ ] B publica. A curte essa publicação. B, com a página visível ou ao abrir Avisos, vê uma só linha "<A> curtiu sua publicação". Tocar na linha abre a publicação de B.
- [ ] A republica a mesma publicação. B vê uma segunda linha, "<A> republicou sua publicação", e nada mais dessa ação. Tocar nela abre a mesma publicação.
- [ ] A descurte. Na próxima leitura de B a linha da curtida some. A linha da republicação fica.
- [ ] B apaga a publicação. As linhas de curtida e de republicação dessa publicação somem na próxima leitura.
- [ ] Um semeador antigo, que abre `varanda/notices/2` e não abre `varanda/notices/3`, não mostra linha de curtida nem de republicação. Seguir, resposta, citação e menção continuam, e `activity` fica verdadeiro. Um semeador que só abre `varanda/notices/1` mostra só quem seguiu, com a linha "O semeador desta associação ainda só envia avisos de quem seguiu você."
- [ ] Uma mensagem privada para B acende o ponto da aba Conversas. O ponto sai de `dm.list` em `apps/app/App.js` (`readDmDot`: pasta `inbox`, `inboxUnread` ou `requests`) e entra no selo da aba junto com o das comunidades (`badges.comunidades` = `groupsBadge || dmDot`). O ponto do sino (Avisos) não acende por essa mensagem, e a mensagem não vira linha em Avisos.
- [ ] A curtida da própria publicação de A não cria linha para A. Em lugar nenhum Avisos mostra uma contagem de curtidas ou de republicações.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação.
- O índice esquece linhas antigas (`NOTICE_ROWS_PER_ENGAGER` 64 por pessoa, `NOTICE_ROWS_MAX` 4096 no total) e não devolve contagem. Uma data mais de 24 h à frente fica escondida até a hora chegar. Uma data anterior a 1970, ou exatamente `1970-01-01T00:00:00.000Z`, não vira linha.
- A janela de 6 h do push (`PUSH_MAX_AGE_MS`) continua só no relé de push. A lista de Avisos não usa esse prazo.
- Desfazer a republicação tira a linha dela do mesmo jeito que descurtir tira a da curtida. Um registro apagado (lápide) da curtida ou da republicação também tira a linha.

## 76. Marca de lido até a mensagem pintada (PR fix/group-seen-corte)

A tela do grupo marca como lido só até a mensagem mais nova que pintou. `group.seen` (rpc.md 5.82) aceita `upTo`, o corte no formato do `before` de `group.read` (`{ at, writer, seq }`), mas inclusivo. Com ele, o nó marca a mensagem que tem com esse autor e esse seq e copia o `at` dela, nunca o do pedido. A regra de avanço é a mesma de antes. Assim, uma mensagem que chega depois da pintura continua não lida até a tela pintá-la. Um corte que não bate com nenhuma mensagem legível (desconhecida, ainda não recebida, de autor bloqueado ou removido, ou com seq futuro) responde `{ ok: true }` e não grava nada, então um cliente nunca empurra a marca além do que o nó tem. Sem `upTo`, vale a mensagem mais nova, como na seção 73. O formato de `data/group-seen.json` e da kv `groupSeen` não mudou.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. O pacote core roda com um processo só: `VARANDA_TEST_CONCURRENCY=1 npm test -w packages/core`. Cada arquivo tocado roda sozinho (`node <arquivo>`; os de core com `VARANDA_TEST_CONCURRENCY=1`).

| Arquivo | O que cobre |
|---|---|
| `packages/rpc/test/methods.test.js` | `group.seen` aceita `upTo` opcional na forma de `before`, não mutante; `at` fora do formato, `writer` fora de hex64, `seq` 0, chaves a mais ou a menos e `upTo` que não é objeto são recusados |
| `packages/core/test/group-seen.test.js` | o corte marca exatamente a mensagem (própria e escondida também), nunca além dela, nunca uma não listada nem um corte mais velho; corte de grupo desconhecido ou ainda não recebido responde `{ ok: true }` sem gravar; sem corte, a mais nova |
| `packages/core/test/group-seen-session.test.js` | `group.seen` com corte pela sessão: `{ ok: true }`, a marca vai para a mensagem de corte, corte não listado não move a marca, corte sem `at` é `USAGE` |
| `packages/web-member/test/group-seen.test.js` | o corte no kv `groupSeen` marca só a mensagem listada, com o `at` do nó; corte não listado não grava; própria e escondida podem ser o corte; raiz pendente não grava |
| `packages/web-member/test/session-groups.test.js` | `group.seen` com corte pelo `request`: `upTo` inclusivo, corte não listado ignorado, corte sem `at` é `USAGE`, grupo desconhecido é `NOT_FOUND`, sem `groups.changed` |
| `apps/app/test/group-flow.test.js` | a tela do grupo envia `upTo` da linha mais nova pintada (escondidas inclusive), nunca além dela; sem corte não envia `group.seen`; a tela avisa a lista após cada tentativa |

### Checagens humanas (a fazer)

As caixas ficam desmarcadas até alguém executar o passo. Primeiro no Android, depois no simulador iOS, por último na web contra um semeador local.

#### Android (APK de preview do EAS, com contas)

- [ ] Com o grupo aberto e pintado, uma mensagem de outro aparelho que chega logo depois da pintura fica não lida ao voltar à lista.
- [ ] Uma mensagem que chega depois da pintura continua não lida até o grupo ser aberto e pintado de novo.
- [ ] Sair do grupo antes de a tela pintar a leitura deixa o selo como estava.
- [ ] Uma tela do grupo coberta por outra (Informações ou Membros por cima) não marca, mesmo com mensagens novas.
- [ ] Abrir um grupo e voltar continua zerando só o selo dele, como na seção 73.

#### iOS (simulador)

- [ ] Repetir o roteiro do Android no simulador iOS.

#### Web (semeador local)

- [ ] Repetir o roteiro do Android no navegador.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação.
- Sem `upTo`, a marca vai para a mensagem mais nova que o nó tem. Um cliente que ainda omite o corte mantém a lacuna descrita na seção 73.
- Um corte que não bate com nenhuma mensagem legível não move a marca, e a contagem fica até uma mensagem listada ser pintada. É o lado seguro: a contagem nunca cai antes da hora.
- Se a mensagem pintada sai da lista legível entre a pintura e a marca (autor bloqueado, autor removido), a marca não anda e a contagem fica até uma mensagem listada posterior ser pintada.
- A marca continua por aparelho e vale para no máximo 512 grupos, como na seção 73.

## 79. Modo escuro e Aparência (PR feat/tema-escuro)

O app ganha modo escuro. Em Ajustes › Aparência a pessoa escolhe Sistema (o padrão), Claro ou Escuro, e a escolha fica guardada só neste aparelho (`localStorage` com a chave `varanda-aparencia` na web; `varanda-aparencia.json` na pasta de documentos no app). As duas paletas estão em `apps/app/src/appearance.js`, com as mesmas chaves; o escuro é quente e verde, nunca preto, e `dim` é sempre um véu escuro. O provedor e a receita de migração de uma tela ficam em `apps/app/src/ui/ThemeProvider.js`. A barra de status segue o tema. Mudanças nativas: `userInterfaceStyle` automatic em `app.json`, `UIUserInterfaceStyle` removido de `Info.plist`, `UIStatusBarStyle` em `UIStatusBarStyleDarkContent`. O splash nativo (iOS, Android e o React no nativo) continua creme nos dois modos, para não haver flash de creme para escuro. Na web, o splash do app segue a escolha, e o pré-splash de `index.html` segue o sistema até o JavaScript do app rodar. Detalhes em [app.md](app.md) ("Aparência") e [development.md](development.md) ("Tema claro e escuro").

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `apps/app/test/appearance.test.js` (as duas paletas com as mesmas chaves, contraste de 4,5:1 nos pares de texto, a escolha guardada só se válida, `resolveScheme`, `statusBarStyle`, o armazenamento da web) e `apps/app/test/themeUsage.test.js` (nenhum arquivo importa a paleta fixa nem cria estilos com cores no carregamento do módulo). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (emulador ou aparelho):

- [ ] Com o aparelho no modo escuro e Ajustes › Aparência em Sistema, o app abre escuro. No modo claro, abre claro. Trocar o modo do aparelho com o app aberto troca as cores sem reiniciar.
- [ ] Claro e Escuro forçados, com o aparelho no modo oposto: o app segue a escolha, inclusive a barra de status e as folhas.
- [ ] Fechar e abrir o app mantém a escolha (arquivo `varanda-aparencia.json`).
- [ ] A abertura (splash) é creme nos dois modos.
- [ ] No escuro: Ajustes, a folha de Publicar e o portão de entrada mostram texto legível e nenhum fundo branco sobrando.
- [ ] A barra de abas segue o modo e passa por trás da área de navegação do sistema sem faixa de outra cor, no claro e no escuro.

iOS (simulador ou aparelho):

- [ ] Os mesmos quatro passos do Android, e os ícones da barra de status: escuros na abertura creme, claros no escuro.
- [ ] No escuro, a cadeira da barra do topo fica sobre um disco creme, e as listras e a faixa do pôr do sol são iguais.

Web (Chrome ou Safari, com o nó no navegador ou com o `varanda-serve`):

- [ ] Sistema, Claro forçado e Escuro forçado: a cor da barra do navegador (`theme-color`) acompanha a escolha.
- [ ] Escuro forçado com o sistema claro: a barra do navegador e o app ficam escuros; pode aparecer um quadro claro do pré-splash (limite conhecido, abaixo).
- [ ] O splash no escuro: fundo `#1c2622`, palavra `#5dcaa0`, cadeira sobre disco creme.
- [ ] Ajustes › Aparência, uma folha (Publicar) e o portão de entrada nos três modos.
- [ ] Recarregar a página mantém a escolha (`localStorage`).
- [ ] App instalado pelo Chrome no Android (reinstalar ou esperar o Chrome atualizar o app depois do deploy): a barra de abas é escura e opaca nos dois modos, e a faixa da barra de navegação do sistema embaixo dela é da mesma cor, no modo claro e no escuro.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação. Os valores de contraste em [app-design.md](../apps/site/artwork/app-design.md) foram medidos pela fórmula do teste, não num aparelho.
- O pré-splash da web e a cor do navegador antes do JS seguem o sistema, não a escolha manual. Por isso, com uma escolha diferente do sistema, pode aparecer um quadro do modo do sistema.
- O splash nativo não segue a escolha manual: fica creme nos dois modos.
- `manifest.webmanifest`: `background_color` creme e `theme_color` escuro (`#1c2622`) nos dois modos; na web, a barra de abas é escura e opaca nos dois modos para combinar com a barra de navegação do sistema no app instalado (no nativo ela segue o modo).

## 80. Mesmas comunidades e grupos em todos os aparelhos da conta (PR fix/comunidades-em-todo-aparelho)

A comunidade criada no PWA do celular não aparecia no navegador do computador com a mesma passkey. A causa: as listas e a sincronização do navegador só olhavam os escritores deste aparelho (kv `groupWriters`). O que mudou: `diaryGroupKeys` em `packages/core/lib/group.js` devolve as raízes que o diário vincula agora, pela mesma regra do semeador (`liveGroupJoins`). `packages/web-member/lib/sync.js` adota essas raízes como réplicas na abertura da sincronização e de novo quando o próprio diário termina de baixar, sem gravar nada. `packages/web-member/lib/member-ops.js` une essas raízes em `community.list` e `group.list` e informa `writerHere`, `canWrite` e `rootHere` em `group.info` e `community.info`, e `authorityHere` em `community.info` (rpc 5.41, 5.42, 5.59 e 5.62), com papel "pending" enquanto os escritores da conta ainda chegam. O app (`apps/app/src/groups.js`, `screens/Comunidade.js`, `screens/Grupo.js` e `screens/GrupoAjustes.js`) mostra "Participar neste aparelho", esconde "Sair", "Novo grupo" e as ações de administração onde falhariam (com uma nota curta dizendo por quê) e não oferece entrada de novato enquanto a conta ainda chega.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes (número de `test(` e de asserções antes -> depois; "novo" é arquivo criado neste PR; "ver CI" é contagem que não foi conferida localmente):

| Arquivo | Testes antes -> depois | Asserções antes -> depois | O que cobre |
|---|---|---|---|
| `packages/core/test/group.test.js` | 109 -> 110 | ver CI | `diaryGroupKeys` (raízes que o diário vincula, pela regra do `liveGroupJoins`) |
| `packages/web-member/test/sync-diary-roots.test.js` | novo, 3 testes | novo, ver CI | adoção das raízes do diário como réplicas numa só passada da sincronização, sem gravar nada no diário; filho do catálogo paginado só pela raiz passa a ser paginado inteiro quando o diário entra nele; um grupo que outra raiz nomeia como comunidade continua aceito |
| `packages/web-member/test/community-devices.test.js` | novo, 10 testes | novo, 47 asserções | `community.list`, `community.info` e `group.info` (`writerHere`, `canWrite`, `rootHere`, `authorityHere`, papel "pending" enquanto os escritores da conta chegam, saída real continua "left") |
| `packages/web-member/test/devices-e2e.test.js` | novo, 1 teste | novo, 20 asserções | fluxo de dois aparelhos com a mesma conta: a comunidade criada num aparelho aparece no outro |
| `apps/app/test/groups.test.js` | ver CI | ver CI | helpers do cartão e das ações por aparelho: `needsDeviceJoin`, `writerOnDevice`, `canWriteHere`, `showNewGroup`, `rootAdminHere`, `authorityHere`, `deviceStaffNote` |

### Checagens humanas (a fazer)

1. **Web, mesma passkey.** Criar uma comunidade no PWA do celular; abrir o site no computador com a mesma passkey. Depois da sincronização, a comunidade aparece em Minhas comunidades com o papel de quem criou, a leitura funciona, "Novo grupo" não aparece e a caixa de escrever dá lugar a "Participar neste aparelho". Tocar e escrever no Geral; a mensagem chega no celular.
2. **Comunidade com aprovação.** Membro comum, segundo aparelho: depois do toque, a caixa avisa que precisa da aprovação de um administrador. O administrador aceita em Pedidos.
3. **Grupo privado.** O segundo aparelho mostra "aguardando nova chave" até um administrador atualizar o acesso.
4. **Durante a sincronização.** Enquanto os dados da conta chegam, a comunidade aparece como "aguardando sincronização" e não oferece "Entrar".
5. **Quem criou, no segundo aparelho.** Depois de "Participar neste aparelho", Pedidos e Membros funcionam; "Novo grupo", "Ajustes" e "Quem pode convidar" não aparecem e a nota diz que só funcionam no aparelho que criou a comunidade.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Instalação com configuração manual (nó core) tem o próprio diário e não recebe nada de outro aparelho.
- Uma raiz que o semeador ainda não tem não aparece até chegar.
- Cada aparelho que participa usa uma das 8 vagas da conta em cada comunidade ou grupo, e o semeador nunca devolve essa vaga.
- Uma comunidade de que todos os aparelhos saíram não aparece num aparelho novo.
- A participação automática e o reenvio de chaves ficam para o PR seguinte (`feat/aparelho-entra-sozinho`).
- Revisão cruzada deixou para depois (o próximo ciclo de sincronização resolve): um buraco ou uma leitura que falha no diário pode pular uma entrada numa passada; um escritor novo numa raiz já réplica espera a próxima paginação (30 s numa sincronização contínua); uma raiz do diário descartada como sonda sem resposta volta na passada seguinte; um núcleo de escritor com `member` do tipo errado pode ficar guardado, mas o fold o ignora.
- Numa comunidade com aprovação, um segundo `community.join` do mesmo aparelho ainda cria outro escritor no Geral (comportamento anterior de `joinGeneral`); o app não oferece mais esse segundo toque.
- `packages/web-member/test/sync-groups.test.js` ("more than one page of writers is paged in full") falha às vezes sob carga também na `main`.

## 81. Aparelho novo entra sozinho e recebe as chaves (PR feat/aparelho-entra-sozinho)

Um aparelho novo da mesma passkey precisava de um toque em "Participar neste aparelho" em cada comunidade e grupo. Agora ele participa sozinho, depois da sincronização, das comunidades e grupos em que a conta já está. O que mudou: `deviceUpkeepPlan` e `deviceUpkeep` em `packages/web-member/lib/member-ops.js` fazem a entrada automática com reserva de 2 das 8 vagas de cada comunidade ou grupo (acima de 6 usadas, a entrada deixa de ser automática e o cartão decide); o Geral é avaliado como grupo; um reparo de escritor listado sem entrada no diário não grava nada. As mesmas funções reenviam as chaves de época já guardadas aos escritores que têm direito, sem rotação de chave, pelo `historyPlan`. A passada limitada `upkeep` em `packages/web-member/lib/session.js` é armada por um comprimento novo do diário, pelo evento `group-writer` da sincronização e pelo desbloqueio; no máximo 3 passadas por armação e 9 no total; ela adia durante uma sincronização única do usuário; uma falha vira aviso, e nunca repete um pedido do cliente. O evento `group-writer` sai de `packages/web-member/lib/sync.js`. As respostas de info ganham `writersBound` e `generalWritersBound`. No app, o cartão vira o caminho para a reserva, com aviso e segundo toque. A exceção ao "nunca repetir pedido" e à entrada automática está registrada no `AGENTS.md`.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes (número de `test(` e de asserções antes -> depois; "novo" é arquivo criado neste PR; "ver CI" é contagem que não foi conferida localmente):

| Arquivo | Testes antes -> depois | Asserções antes -> depois | O que cobre |
|---|---|---|---|
| `packages/web-member/test/device-upkeep-ops.test.js` | novo, 19 testes | novo, ver CI | `deviceUpkeepPlan` e `deviceUpkeep`: entrada automática com reserva de 2 das 8 vagas, Geral avaliado como grupo, reparo de escritor listado sem entrada no diário, reenvio das chaves de época a escritores com direito, sem rotação (`historyPlan`) |
| `packages/web-member/test/session-upkeep.test.js` | novo, 14 testes | novo, ver CI | passada `upkeep` na sessão: armação pelo comprimento do diário, pelo `group-writer` e pelo desbloqueio; limite de 3 por armação e 9 no total; adiamento durante uma sincronização do usuário; falha vira aviso |
| `packages/web-member/test/devices-auto-e2e.test.js` | novo, ver CI | novo, ver CI | dois aparelhos com a mesma passkey: o aparelho novo entra sozinho na comunidade aberta e no Geral e consegue escrever |
| `packages/web-member/test/devices-private-e2e.test.js` | novo, ver CI | novo, ver CI | grupo privado: o segundo aparelho espera a nova chave e abre o histórico depois que o primeiro sincroniza |
| `apps/app/test/groups.test.js` | ver CI | ver CI | helpers da reserva: `deviceReserveReached`, `communityReserveReached`, `reserveReachedAny` e `needsReserveConfirm` |

### Checagens humanas (a fazer)

1. **Aparelho novo, comunidade aberta.** Mesma passkey; abrir o site no computador. Sem tocar em nada, depois da sincronização o computador participa da comunidade e do Geral e consegue escrever.
2. **Grupo privado de quem criou.** O segundo aparelho mostra "aguardando nova chave" até o primeiro aparelho sincronizar; depois o histórico abre sozinho.
3. **Comunidade com aprovação, membro comum.** O aparelho novo entra na comunidade; os grupos esperam um administrador aceitar em Pedidos.
4. **Reserva.** Com 6 aparelhos já usados na comunidade, o aparelho novo não entra sozinho; o cartão mostra o aviso e só o segundo toque participa.
5. **Informações.** Quem modera e ainda não participa por este aparelho vê a nota explicando.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Cada escrita local (uma publicação) arma uma passada, que para a sincronização contínua por um instante, cerca de 1,5 s depois.
- O evento `group-writer` dispara para todo escritor novo guardado; num grupo grande, cada um custa uma parada curta da sincronização (no máximo 512 por sessão).
- `generalWritersBound` é 0 enquanto o Geral ainda não chegou ao aparelho, então o aviso da reserva pode não aparecer nesse intervalo.
- Um membro comum precisa de um administrador para o aparelho novo nos grupos de uma comunidade com aprovação e para ler um grupo privado.
- O nó core (configuração manual) não muda.

## 82. Idade lembrada por conta (PR feat/idade-lembrada)

Uma conta verificada há tempo, no app Android ligado à instalação, via depois do splash "Confirme sua idade" (Passo 2 de 3, carregando, "Verificar minha idade" desligado) em vez de A Rua: o estado da idade começava desconhecido a cada abertura e a etapa falha fechada até o serviço responder. Decisão do dono do produto (2026-11-04): a verificação é lembrada por conta, independente do aparelho. O que mudou: duas provas assinadas pela chave do emissor do serviço de conta, conferidas pelo nó a cada leitura (`packages/core/lib/age-proof.js`). (1) O atestado `age-verified` de um membro, que o serviço manda junto com `verificado` em `/account/age/result` e `/account/age/session`; o app o repassa ao nó com `age.proof { verified }`. (2) O atestado `age-since` da instalação, que `GET /account/age/since` devolve assinado (nunca antes do piso descrito abaixo); o app o repassa com `age.proof { since }`, e um `null` apaga o guardado. O nó só aceita um objeto que confere com a associação dele (e, no `age-verified`, com a própria chave), guarda no kv e confere de novo ao ler do armazenamento; o `node.info` traz `ageVerifiedDate` e `ageSince`. O `App.js` abre a porta só por `nodeVouches` sobre o `node.info` (`ageVerifiedDate`, ou `memberCertDate` entre `ageSince` e `ageSinceUntil`, a data em que o `since` guardado foi assinado) e só depois de carregar o registro do aparelho. O aparelho guarda apenas recusas (`{ v: 2, denied: [{ member, origin }] }`, `src/ageMemory.js`); nada que ele guarda abre a porta. Só `answerAge`, com a resposta do serviço, grava uma recusa (`recusado`) ou apaga a recusa desta instalação (`verificado`); `nenhum`, `pendente`, `inconclusivo` e `expirado` só aparecem nesta abertura, sem gravar nada. A leitura do resultado continua em segundo plano a cada abertura, e uma resposta pedida em outra instalação é descartada. Na etapa de idade o `App.js` lê o `node.info` (antes só a tela Identidade lia) e lê de novo quando uma sincronização termina e o nó ainda não tem nenhuma das provas. `ageReadAllowed` (`src/age.js`) decide a leitura sem esperar a recuperação ou a sincronização única. A tela Idade mostra "Conferindo sua idade…" enquanto espera a primeira resposta.

- Recusa lembrada: uma recusa vale na hora para a sessão (membro e instalação) e é gravada no aparelho, com uma nova tentativa se a gravação falhar; ela vence as provas do nó, então uma conta recusada continua fechada depois de reabrir, mesmo sem internet. Um `verificado` numa instalação nunca apaga a recusa de outra. Mudanças feitas antes de o registro carregar entram numa fila aplicada sobre o que foi lido e gravada mesmo que a tela saia antes; cada gravação lê de novo o registro guardado e aplica a mudança por cima (outra aba não é sobrescrita).
- Piso do `since`: o serviço assina o maior entre `VARANDA_AGE_SINCE`, o início do dia UTC seguinte à primeira faixa registrada, a última vez em que a verificação foi religada (guardada em `age-check.json`) e o vínculo mais recente sem faixa registrada mais 1 ms.
- Emissor: o `age-since` só vale para o certificado v2 do bloco 0 assinado pelo mesmo emissor do atestado, nunca para um de outro emissor nem para um certificado v1.
- Janela: o certificado só vale com data entre o `since` e a data em que ele foi assinado (`ageSinceUntil` no `node.info`, `null` quando não há `since`), que o serviço renova a cada pedido; sem teto, o caminho do certificado fica desligado.
- `since`: pedido uma vez por instalação e geração; só a resposta mais recente vale; uma falha de leitura ou de gravação no nó é tentada de novo depois de 5 s, 15 s e então a cada 60 s, e na hora quando a conexão volta.
- `node.info` na etapa de idade: uma leitura que falha é tentada de novo depois de 2 s, 5 s, 15 s e então a cada 30 s enquanto a etapa precisa dela (e na hora quando a conexão volta), nunca durante a recuperação ou a sincronização única; a tela Idade só fica em "Conferindo sua idade…" enquanto a leitura do resultado está de fato em curso.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Arquivos rodados um a um: `node apps/app/test/age.test.js`, `node apps/app/test/ageMemory.test.js`, `node apps/app/test/useAgeMemory.test.js`, `node apps/app/test/account.test.js`, `node apps/app/test/onboarding.test.js`, `node apps/app/test/splashGate.test.js`, `node apps/app/test/platformGate.test.js`, `node apps/app/test/agePolicyOrigin.test.js`.

| Arquivo | Testes antes -> depois | Asserções antes -> depois | O que cobre |
|---|---|---|---|
| `apps/app/test/age.test.js` | 8 -> 22 | 205 -> 317 | `ageReadAllowed`; checagens do texto do `App.js`: `ageShown` no `ageGate` e na tela Idade, `nodeVouches` com os campos do `node.info` como única abertura e `ageMemory.loaded` na porta, `deny`/`clearDenial` e `age.proof { verified }` só dentro de `answerAge`, `age.proof { since }` só no efeito do `since` (com sequência e nova tentativa), nada disso no retorno por URL nem nos links do app, `node.sync.stopped` lido na seção da idade e nunca durante a recuperação ou a sincronização única, nada de `sinceOf`/`remember(`, origem no reset, na chave da leitura e no `stale()`, `ageReadNow` sem `onceSync`/`recovering`; texto "Conferindo sua idade…" |
| `apps/app/test/useAgeMemory.test.js` | novo, 16 testes | novo, 109 | `openNow`: só o nó abre, a recusa da sessão (membro e instalação) e a do registro fecham; `applyPending`; cada gravação lê o registro guardado antes (outra aba); fila gravada mesmo depois de desmontar; `verificado` na origem A não apaga a recusa da origem B |
| `apps/app/test/account.test.js` | 78 -> 80 | 1577 -> 1616 | `ageSince`: objeto de até 1024 bytes, `null`, `undefined` em qualquer falha ou formato diferente; `ageResult`/`ageSession`: `proof` só com `verificado`, só objeto e só até 1024 bytes UTF-8 |
| `apps/app/test/ageMemory.test.js` | novo, 18 testes | novo, 194 | registro v2 só com recusas, o formato v1 lido como nada, limite e ordem, `withoutDenied` só na mesma instalação, `ageAnswerOutcome`, tabela de `nodeVouches`, `certVouches` com piso e teto (data do certificado depois do teto, teto ausente ou fora do formato canônico: não abre), armazenamento web |
| `packages/core/test/age-proof.test.js`, `apps/cli/test/account-age.test.js`, `apps/cli/test/age-store.test.js`, `packages/web-member/test/session.test.js`, `packages/rpc/test/methods.test.js` | ver as tarefas do serviço e do nó | ver CI | formatos e assinaturas dos atestados; respostas do serviço; verificação no nó, kv e `age.proof` |

### Checagens humanas (a fazer)

1. **Android, conta verificada e `VARANDA_AGE_SINCE` definido.** Uma conta com certificado anterior ao `since` assinado (contas criadas antes de a verificação começar, como a do dono) ainda espera UMA resposta do serviço por aparelho na primeira abertura depois da atualização; dali em diante o nó guarda o atestado `age-verified` e A Rua abre logo depois do splash, sem "Confirme sua idade". Uma conta com certificado dentro da janela abre A Rua já na primeira abertura.
2. **Fechar e abrir de novo.** Igual.
3. **Serviço local respondendo `recusado`.** A abertura seguinte mostra a etapa de idade com o texto de recusa.
4. **Web hospedada.** Mesmo comportamento.
5. **Conta vinculada antes de `since`.** Espera uma resposta do serviço uma vez por aparelho (o atestado fica no nó) e depois entra direto, mesmo sem internet.
6. **Editar `varanda-age` ou o kv do nó à mão não abre a porta.** Escrever um `verificado`, um `since` de 1970 ou um atestado sem assinatura válida no `localStorage`, no `varanda-age.json` ou no kv do nó (`ageVerified`, `ageSince`) mantém a etapa de idade.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- O texto da Política de Privacidade (`apps/app/src/legal.js`) ainda não menciona o registro no aparelho nem os atestados guardados no nó (revisão jurídica).
- Sem `VARANDA_AGE_SINCE`, ou enquanto o serviço não tem certificado de emissor ou nenhuma faixa registrada, o caminho do certificado fica desligado (`{ since: null }`).
- Um app modificado, ou uma chave de associação trocada na configuração do nó (a configuração hospedada na web, o argumento do worklet no nativo), ainda abre a própria porta com um emissor e atestados próprios, como já podia alterar o app; o serviço continua exigindo a faixa no vínculo, na troca de nome e nos convites.
- Um `since` assinado servido antes pode ser posto de volta no kv (repetição), mas só vale para certificados com data até a da assinatura dele; e o serviço nunca serve um `since` abaixo do piso. Um `age-verified` repetido para o mesmo membro diz algo verdadeiro (o serviço nunca apaga uma faixa).
- Apagar uma recusa do registro do aparelho só tira um auxílio que falha fechado; o serviço continua recusando.
- Os limites da janela confiam no relógio do serviço de conta: um erro de relógio durante uma troca de desligado para ligado pode deixar passar um certificado que não deveria valer.
- `ageVerifiedDate`, `ageSince` e `age.proof` existem só no nó do navegador (`packages/web-member`), que o app nativo também roda no worklet no modo hospedado; o nó do núcleo (CLI) não os tem, e ali a porta só abre com a resposta do serviço.

## 83. Interações da Rua: curtir animado, toque duplo, fio da conversa, desfazer (PR feat/rua-interacoes)

A Rua e a Conversa ganham quatro interações: o coração curtido cheio com pulo e vibração leve, o toque duplo para curtir (só no app nativo), o fio que liga a resposta à publicação em destaque na Conversa, e o aviso "Republicado" com "Desfazer" por 4 s. Pílulas e abas ganham toque mais claro (opacidade 0,65 ao pressionar; no Android, ondulação nas abas). A vibração vem de `expo-haptics` 55.0.18 (`apps/app/src/ui/haptics.native.js`); na web é um no-op. O toque duplo fica em `apps/app/src/doubleTap.js`, com a abertura pendente compartilhada pela lista. Detalhes no [app.md](app.md) ("Interações da Rua") e no [app-design.md](../apps/site/artwork/app-design.md) ("Componentes").

Regras que os passos abaixo conferem (só a janela do toque duplo tem teste automático):

- Um pulo e uma vibração só vêm de ação da própria pessoa na linha; curtidas que chegam numa atualização não pulam nem vibram. Descurtir não pula nem vibra.
- Com "Reduzir movimento" ligado, o pulo e o coração do toque duplo somem; a vibração continua.
- O toque duplo nunca descurte. Um toque simples abre a conversa depois de 280 ms, e uma abertura pendente é cancelada por qualquer toque em outra publicação ou botão.
- Leitores de tela abrem a conversa na hora e nunca curtem por toque duplo.
- "Desfazer" só desliga a republicação; se a gravação ainda está pendente, o aviso diz "Aguarde um instante e tente de novo.".

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Teste desta parte: `apps/app/test/doubleTap.test.js` (a janela de 280 ms, a abertura pendente única e o cancelamento). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador, primeiro):

- [ ] Toque duplo numa publicação de A Rua (fora de links, menções e fotos) curte, mostra o coração de 64 pt sobre a publicação e vibra de leve. Tocar de novo nessa publicação não descurte.
- [ ] Toque simples numa publicação abre a Conversa, depois de uma pausa perceptível; um toque simples em outra publicação logo em seguida não abre a primeira.
- [ ] Toque em um link, em uma menção e em uma foto abre na hora, sem curtir.
- [ ] Com "Remover animações" (ou "Reduzir movimento") ligado nas configurações de acessibilidade, o toque duplo curte sem o coração de 64 pt, o coração não pula, e a vibração continua.
- [ ] Com TalkBack ligado, a ativação de uma publicação abre a Conversa na hora e nunca curte.
- [ ] Tocar no coração curte com pulo e vibração; tocar de novo descurte sem pulo nem vibração.
- [ ] Republicar mostra "Republicado" com "Desfazer" por 4 s; "Desfazer" desliga a republicação e a contagem volta. Repetir "Desfazer" não republica.
- [ ] Ao republicar e desfazer logo em seguida, com a gravação ainda pendente, o aviso diz "Aguarde um instante e tente de novo.".
- [ ] Na Conversa, o fio de 2 pt liga o avatar da resposta ao avatar da publicação em destaque, e a barra verde de 3 pt fica à esquerda sem deslocar os avatares.
- [ ] Pílulas e abas ficam mais claras ao pressionar; nas abas, a ondulação aparece e não tem borda.
- [ ] TalkBack lê os botões de curtir e republicar com o estado (curtido ou não) e o aviso "Republicado" com o botão "Desfazer".

iOS (simulador ou aparelho, depois do Android):

- [ ] Os mesmos passos de toque duplo, toque simples, links e fotos, e de "Reduzir movimento" (Ajustes › Acessibilidade › Movimento).
- [ ] Com VoiceOver ligado, a ativação de uma publicação abre a Conversa e nunca curte.
- [ ] Com VoiceOver ligado, numa publicação com link ou menção no texto, ativar o texto duas vezes seguidas abre a Conversa e não curte (com leitor de tela ligado, o toque duplo para curtir fica desligado).
- [ ] A vibração de curtir e de republicar acontece num aparelho com Taptic Engine (o simulador não vibra).
- [ ] O fio, as pílulas e as abas, e o aviso "Republicado" com "Desfazer".

Web (Chrome ou Safari, com o nó no navegador ou com o `varanda-serve`):

- [ ] Duplo clique numa publicação não curte: o texto é selecionado, como antes.
- [ ] Curtir e republicar não vibram, e o coração curtido continua cheio e verde.
- [ ] O aviso "Republicado" com "Desfazer" aparece por 4 s, e "Desfazer" desliga a republicação.
- [ ] O fio da Conversa e o toque mais claro das pílulas e abas.

### Não verificado / limites conhecidos

- Nenhuma caixa acima foi executada nesta documentação. Os testes automáticos cobrem só a janela do toque duplo e a abertura pendente; o pulo, o coração de 64 pt, a vibração e o aviso ainda precisam de aparelho.
- Um desfazer durante a atualização puxada pode deixar a contagem uma a mais até a próxima atualização.
- O desfazer atualiza só a tela que mostrou o aviso.
- Um desfazer enquanto uma curtida da mesma publicação está pendente não entra na fila; o botão de republicar da linha continua desfazendo.
- Um arrasto que começa fora de qualquer publicação, dentro dos 280 ms, não cancela a abertura da conversa. Tocar numa aba cancela.

## 84. Páginas (PR feat/pages-app)

Uma Página é o diário de um negócio ou projeto, com @nome, dono e administradores. O serviço de conta escreve no diário da página em nome deles. Protocolo na seção 12 de `docs/protocol.md`; dados em `docs/design.md` (LGPD); telas em `docs/app.md` ("Páginas"). Termos e Política na versão 15.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes ligados a esta etapa: `packages/core/test/terms.test.js` e `apps/app/test/terms-version.test.js` (versão 15 nos dois lados), `apps/app/test/legal.test.js` (texto e digest) e os arquivos de páginas listados nas seções de protocolo e de app.

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web. Use duas contas: A (dona) e B (administradora convidada).

1. **Aceite da versão 15.** Ao abrir o app com a versão 14 aceita, o aceite dos Termos e da Política aparece de novo; a seção "Páginas" está nos dois documentos e não fala de mensagens.
2. **Criar.** Páginas > Nova página: nome e @nome livres criam a página; ela aparece em Páginas. Um @nome já usado por uma pessoa ou por outra página é recusado, e um @nome usado antes não volta.
3. **Seguir.** Com a conta B (que não administra), abra o perfil da página em Membro e toque em Seguir; a página aparece em Seguindo.
4. **Publicar como a página.** Na conta A, o chip "Publicar como" escolhe a página; a publicação aparece no diário da página e, na conta B, em A Rua.
5. **Convidar e aceitar.** Em Ajustes da página, A convida B pelo @nome; B vê o convite e aceita. O @nome de B aparece na lista pública de administradores no perfil da página, visto por uma terceira conta.
6. **Administradora publica.** B publica como a página e a publicação sai no diário da página.
7. **Remover.** A remove B. B não consegue mais publicar como a página (o chip some ou o envio é recusado) e uma publicação de B enviada antes da remoção continua no diário.
8. **Passar a página.** A passa a página para B; só vale depois de B aceitar. Depois, A continua administradora até ser removida por B.
9. **Perfil por @nome.** O link `/@nome` da página abre o perfil da página.
10. **Busca.** Busca > Contas por nome ou @nome mostra a página com o selo de página.
11. **Incerto.** Com a rede cortada no meio do envio, o app mostra "incerto" e não publica de novo sozinho; conferir no diário que há no máximo uma publicação.
12. **Só hospedado.** Numa configuração manual, as telas de Páginas mostram "Só na versão web".

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Mensagens da página (seção 85), comunidades da página, encerrar e mover a página e os avisos da página não fazem parte desta etapa.

## 85. Conversas como página (PR feat/pages-app)

> Superada pela seção 148 para as Conversas de página de ponta a ponta.

Uma Página tem Conversas, mas a chave de mensagens dela fica no serviço de conta, que pode ler as mensagens enviadas e recebidas pela página. Protocolo na seção 12 de `docs/protocol.md` ("Conversas como página"); dados em `docs/design.md` (LGPD); telas em `docs/app.md` ("Páginas"). Termos e Política na versão 15.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes ligados a esta etapa: `packages/core/test/terms.test.js` e `apps/app/test/terms-version.test.js` (versão 15 nos dois lados) e `apps/app/test/legal.test.js` (texto e digest).

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web. Use A (dona), B (administradora) e C (outra pessoa).

1. **Termos.** Não há aceite novo só para as Conversas da página: a versão 15 (seção 84) já diz que o serviço de conta pode ler as mensagens da página.
2. **Enviar como a página.** A abre as Conversas da página e envia uma mensagem a C. A mensagem sai com o cabeçalho "como página".
3. **A outra pessoa vê a página.** C recebe a mensagem como vinda da página (nome e @nome da página), sem o nome de A, e responde.
4. **Resposta na caixa da página.** A resposta de C aparece na caixa da página para A e para B, e a contagem de não lidas some depois de abrir.
5. **Administradora lê e envia.** B abre a mesma conversa, vê o histórico e responde como a página.
6. **Remover.** A remove B. B deixa de ver a caixa da página e o envio como a página é recusado. Uma mensagem que B enviou antes continua na conversa de C.
7. **Incerto.** Com a rede cortada no meio de um envio, o app mostra "incerto" e não envia de novo sozinho; conferir com C que chegou no máximo uma mensagem.
8. **Só hospedado.** Numa configuração manual, as Conversas da página mostram "Só na versão web".

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- O serviço lê as mensagens da página (decisão do dono, no Termos 15). As Conversas de uma página não acompanham uma troca de chave da página.

## 86. Páginas: seguir, fotos e A Rua (PR feat/pages-app)

A página segue pessoas e outras páginas, mostra A Rua da página (janela de 64 seguidos por vez) e publica fotos e GIFs como uma pessoa.

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Os testes dos módulos puros de páginas ficam em `apps/app/test/`.

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web.

1. **Seguir como a página.** Na conta A, com a página escolhida, abra o perfil de uma pessoa e use "Seguir como a página"; a pessoa aparece em quem a página segue.
2. **A Rua da página.** Uma publicação nova dessa pessoa aparece em "A Rua da página". Com mais de 64 seguidos, a lista lê uma janela por vez e o rodapé indica que há mais.
3. **Foto como a página.** Publique como a página com uma foto; ela aparece na publicação, em A Rua de uma terceira conta e é servida pela rota de mídia do semeador (a imagem carrega sem a conta A aberta).
4. **GIF como a página.** Publique um GIF como a página; ele anima na publicação e em A Rua da terceira conta.
5. **Deixar de seguir como a página.** A remoção tira a pessoa de A Rua da página sem mexer no que a própria conta A segue.
6. **Só hospedado.** Numa configuração manual, essas ações não aparecem.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.

## 87. Páginas: encerrar e mudar de chave (PR feat/pages-app)

O dono encerra a página ou muda a chave dela em Ajustes da página. O app mostra as páginas encerradas e as que mudaram de chave e não mostra o que a chave antiga publicou depois do fim. O nó corta o diário no primeiro `page-close` ou `page-moved` verificado; o app confia só no que o nó verificou (`page.read`), e a declaração de `GET /account/pages/successor/<K1>` só vale junto com um `page-origin` de K2 que nomeia o mesmo par (`apps/app/src/pageMove.js`).

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Os módulos puros ficam em `apps/app/test/pageMove.test.js` (declaração sem origem igual ignorada, cadeia parada em 4, encerrada sem "Seguir a chave nova") e `apps/app/test/pages.test.js` (textos de `encerrada`, `movida` e do limite diário).

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web.

1. **Só o dono vê.** Um administrador que não é dono abre Ajustes da página e não vê "Encerrar página" nem "Mudar a chave".
2. **Encerrar.** O dono toca "Encerrar página"; a primeira confirmação cita o @nome e diz que as publicações somem para quem está em dia e que cópias já guardadas continuam; a segunda diz que o @nome nunca volta. Depois de "Encerrar de vez", as publicações somem do perfil e de A Rua numa segunda conta que seguia a página, e a página fica cinza em Páginas.
3. **Nome indisponível.** Criar uma página nova ou trocar o @nome de outra conta para o @nome da página encerrada responde "Esse @nome já está em uso".
4. **Chave vazada depois do encerramento.** Um bloco acrescentado ao diário da página encerrada com a chave antiga (fixture de teste) não aparece em nenhuma tela.
5. **Perfil encerrado.** O perfil mostra "Esta página foi encerrada", sem Seguir, sem "Seguir como a página" e sem "Agir como esta página".
6. **Mudar a chave.** O dono toca "Mudar a chave" e confirma; a tela mostra a chave nova e o @nome continua o mesmo (a Busca pelo @nome abre a chave nova).
7. **Aviso no perfil antigo.** Numa segunda conta que seguia a página, o perfil da chave antiga mostra "Esta página mudou para uma nova chave" e "Ver a página nova" abre o perfil da chave nova. O aparelho pode já ter seguido a chave nova sozinho, uma vez, depois de conferir a mudança (Termos 15); "Seguir a chave nova" é a forma manual.
8. **Seguir a chave nova.** Se o aparelho ainda não seguiu, "Seguir a chave nova" passa a seguir a chave nova (aparece em Seguindo) e o botão some.
9. **Publicações antigas.** As publicações de antes da mudança continuam legíveis no perfil antigo e em A Rua.
10. **Chave antiga vazada depois da mudança.** Um bloco acrescentado à chave antiga depois da mudança (fixture de teste) não aparece no perfil nem em A Rua.
11. **Incerto.** Com a rede cortada logo depois de confirmar, a tela mostra "Tentar de novo"; o toque reenvia o mesmo pedido e não pede outra assinatura.
12. **Limite.** Passado o limite diário, a resposta é "Limite de mudanças atingido, tente amanhã".

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- O app não confere assinaturas (o Metro não alcança `packages/core`): vale o que o nó verificou. A declaração do serviço é só uma dica.
- Com a chave antiga pausada (sem `page-moved` no diário), o perfil da chave antiga esconde os blocos depois de `fromSeq`, mas A Rua não consulta a rota `successor` para cada página seguida: ali o corte depende só do nó.

## 88. Avisos da página (PR feat/pages-app)

O dono e os administradores leem em Avisos o que chega para a página: quem começou a seguir a página, as respostas, as citações e as menções (sem as curtidas e republicações do canal `notices/3`). O serviço de conta lê os avisos pelo semeador, confere cada linha e responde só ao dono e aos administradores (ação `notices`, leitura assinada, 8 por minuto por página; página mudada de chave responde `movida`). Nenhum Web Push vai para uma página. Contrato em `docs/protocol.md` seção 12 ("Avisos de uma página") e em `docs/rpc.md` (5.84); dados em `docs/design.md` (LGPD).

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Testes desta etapa: `apps/cli/test/account-pages-notices.test.js` (linhas verificadas, limite por página, administrador removido) e `apps/app/test/notices.test.js`. Não rode nada contra o serviço de produção.

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web. Contas: A (dona), B (administradora) e C (terceira).

1. **Seguir a página.** C segue a página; em A e em B, Avisos mostra "começou a seguir a página" com o nome de C.
2. **Menção.** C publica um texto com o @nome da página; o aviso de menção aparece para A e para B, sem o texto cru de um par fora de `displayText`.
3. **Quem não administra.** C não vê os avisos da página em nenhuma tela.
4. **Administrador removido.** A remove B; B deixa de ver os avisos da página no próximo carregamento.
5. **Limite.** Atualizar Avisos da página mais de 8 vezes em um minuto mostra o limite e nada quebra; passado o minuto, funciona de novo.
6. **Sem push.** Nenhuma notificação do sistema chega ao aparelho por causa de um aviso da página.
7. **Página encerrada.** Depois de encerrar a página, Avisos da página responde "Esta página foi encerrada".

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- O limite de 8 por minuto por página fica na memória do serviço e recomeça quando ele reinicia.
- O serviço lê os avisos da página em nome dos administradores (Termos 15).

## 89. Páginas no nó core (PR feat/pages-app)

Um nó core (CLI e `varanda-serve`) administra páginas com uma chave de delegado que fica no aparelho (`private/page-actor.json`), registrada pelo diário do nó com `page-delegate` (`page.register`, 5.87). O serviço de conta aceita o delegado só depois de replicar o diário pelo semeador e de o delegado aceitar os Termos 15. A CLI fala com o serviço em `VARANDA_ACCOUNT_ORIGIN`; o app servido por `varanda-serve --account-origin https://<host>` mostra as Páginas pelo mesmo serviço.

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Testes desta etapa: `apps/cli/test/account-pages-delegate.test.js`, `apps/cli/test/cli.test.js` e `apps/cli/test/readme-help.test.js` (ajuda idêntica ao README), `packages/core/test/terms.test.js` e `apps/app/test/terms-version.test.js` (versão 15).

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro o app no Android (build de debug apontando para um `varanda-serve --account-origin` de teste) e depois a web e a CLI. Use só um serviço de conta de teste.

1. **Registrar.** `page register` mostra a chave pública do delegado e nunca a secreta; repetir não acrescenta outro `page-delegate`. Antes de existir identidade a CLI diz "identidade não encontrada"; antes do certificado de membro, que é preciso gravar o certificado primeiro; um arquivo de chave malformado ou ligado por link diz "chave de página inválida" e nenhum arquivo é escrito.
2. **Termos.** `page terms` aceita a versão 15 pelo delegado; sem isso, as ações respondem "este nó não tem delegado aceito pelo serviço" ou "aceite os Termos antes". Uma conta ligada ao Google não registra delegado para o próprio diário.
3. **Criar.** `page create --username ... --name ...` cria a página; ela aparece em `page list` e na Busca.
4. **Publicar, responder e foto.** `page post`, `page reply --to <chave>:<seq>` e `page photo` publicam no diário da página e aparecem em outra conta que a segue. Repetir o mesmo pedido assinado nunca publica duas vezes.
5. **Seguir.** `page follow --page <chave> --key <chave>` e `page unfollow` mudam a lista pública da página.
6. **Avisos.** `page notices --page <chave>` lista os avisos da página (seção 88).
7. **Encerrar e mudar.** `page close` e `page move` seguem a seção 87; depois do fim, uma ação responde "esta página foi encerrada" ou "esta página mudou para uma nova chave".
8. **Núcleo com o app.** No app nativo (Android primeiro) com um nó core que informa `accountOrigin` (o `varanda-serve --account-origin https://<host>` publica o campo no `node.info`), Ajustes mostra Páginas. O primeiro uso registra o delegado, aceita os Termos com ele e mostra a chave do delegado copiável com "convites chegam por esta chave"; só então "Criar página" funciona. A interface web do `varanda-serve` não mostra Páginas, mesmo com a origem (o serviço de conta não aceita outra origem de navegador). Uma origem que não seja https é recusada com "--account-origin inválido".
9. **Administrador de nó core.** A lista pública de administradores mostra, para esse administrador, a chave do diário do nó e não um @nome.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador, num aparelho nem contra o serviço de produção pelo agente.
- Um delegado não tem @nome e é convidado pela chave.
- Perder `page-actor.json` perde o acesso do nó: registre de novo e peça o convite outra vez.
- Limite aceito: a interface web do `varanda-serve` não tem Páginas (o serviço de conta não envia CORS e confere a origem). Avisos, Conversas e comunidades como a página seguem só no nó hospedado; no nó core, os avisos da página vêm pela CLI.
- A CLI nunca reenvia um pedido: um resultado incerto pede conferência antes de repetir.

## 90. Páginas em comunidades (PR feat/pages-app)

Esta seção foi substituída pela seção 149 para grupos privados como Página.

Uma página entra em comunidades e grupos como membro, por núcleos de escritor próprios que o serviço de conta guarda (`pages-groups`). Ela só entra, sai, lê e escreve: nunca cria, admite, bane, nomeia, oculta nem troca a chave de um grupo. Em comunidade de aprovação a página fica "pedida" até os administradores a admitirem. Nos grupos privados o serviço guarda a caixa da página e pode ler as publicações (Termos 15). Contrato em `docs/protocol.md` seção 12 ("Comunidades como página") e `docs/rpc.md` (5.84).

### Como verificar

Do repositório: `npm run lint`, `npm test` e `npm run demo`. Testes desta etapa: `apps/cli/test/account-pages.test.js` (ações de comunidade e de grupo), `apps/app/test/groups.test.js` e `apps/app/test/group-flow.test.js` (a página como quem age).

### Checagens humanas (a fazer)

Todas a fazer (nenhuma foi rodada). Primeiro no Android (build de debug no emulador, instalação hospedada) e depois na web. Contas: A (dona da página), B (criadora de uma comunidade aberta e de uma de aprovação).

1. **Comunidade aberta.** Em Comunidade, "Agir como" a página e entrar; a página aparece como membro, com o @nome dela, na lista de membros.
2. **Comunidade de aprovação.** A página entra e fica como pedida; B admite a página e ela passa a membro.
3. **Grupo público.** A página entra no grupo e publica; o texto sai com o nome da página e é público como a página.
4. **Grupo privado.** A página entra num grupo privado e lê e escreve; um membro comum vê o texto, e quem não é membro não vê.
5. **Sair.** A página sai do grupo e da comunidade; o membro some da lista e uma publicação anterior continua.
6. **Mudar a chave.** Depois de "Mudar a chave" (seção 87), a chave nova volta para as mesmas comunidades e grupos; os de aprovação voltam a "pedida".
7. **Encerrar.** Encerrar a página a tira de todas as comunidades e grupos.
8. **Administrador removido.** A remove um administrador; ele perde o controle dos grupos da página no mesmo instante.
9. **Limite.** Mais de 16 núcleos de escritor ou 64 grupos por página respondem o limite.
10. **Só entra e sai.** A página não vê nenhuma ação de criar, admitir, banir, nomear, ocultar ou trocar a chave de um grupo.

### Não verificado / limites conhecidos

- Nada foi rodado num navegador nem num aparelho pelo agente.
- Um escritor vazado pode escrever com data anterior até a saída, o limite do aparelho que saiu da seção 10 do protocolo.
- Uma página pausada que mudou de chave não sai dos grupos sozinha: vale `mod block`.
- As Conversas da página não acompanham a mudança de chave.

## 91. Perfil fixo, Avisos, Mensagens e Publicar (PR feat/perfil-avisos-dm-publicar)

Quatro partes do app ganham ajustes visuais e de toque: a barra fixa ao rolar o Diário e um perfil; o selo de tipo e o nome em negrito nos Avisos; os marcadores de dia e os grupos de bolhas nas Mensagens; e, na Publicar, o autor ao lado do avatar, o anel com a contagem restante, as vibrações e a alça da folha. O roteiro está em [app.md](app.md), seção "Perfil fixo, Avisos, Mensagens e Publicar".

Regras que os passos abaixo conferem:

- A barra fixa só aparece depois que a faixa do perfil sai da tela, nunca no topo. Cada botão responde uma vez: o da faixa ou o da barra, nunca os dois.
- Com "Reduzir movimento" ligado, a barra aparece de uma vez.
- Nos Avisos, o selo é decorativo e a linha lê a mesma frase de antes.
- Nas Mensagens, mensagens do mesmo lado até 5 min da primeira do grupo, no mesmo dia e sem convite entre elas, formam um grupo; só a última mostra a hora.
- Na Publicar, o anel e a contagem mudam a partir de 90 % do limite, e a vibração de sucesso só vale para envio de fato, não para a fila de saída.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `apps/app/test/profileBar.test.js` (limites da barra), `apps/app/test/composeRing.test.js` (tons e contagem do anel), e `apps/app/test/format.test.js`, `apps/app/test/notices.test.js` e `apps/app/test/conversas.test.js` (dias, grupos e frases dos Avisos). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador, primeiro):

- [ ] No Diário, ao rolar, a barra de 44 pt com o nome, a ajuda, a engrenagem e o sino aparece aos poucos, e não aparece no topo do perfil.
- [ ] Tocar em ajuda, engrenagem e sino pela barra abre o mesmo que pela faixa; um toque nunca dispara os dois.
- [ ] No Diário, "ver novidades" aparece abaixo da barra e responde ao toque.
- [ ] Abrir o perfil de outra pessoa (Membro) e rolar: a barra aparece com o nome e a seta de voltar, e voltar pela barra funciona.
- [ ] Com "Remover animações" ligado, a barra aparece de uma vez.
- [ ] Nos Avisos, cada linha tem um selo verde de 20 pt com o ícone do tipo (seguir, resposta, citar, @, coração, republicar); o nome está em negrito e o resto da frase, não.
- [ ] Nos Avisos, nenhuma linha mostra trecho do texto, não há divisão "Novos" e "Anteriores", e tocar na linha abre a mesma tela de antes.
- [ ] Com TalkBack, a linha de Avisos lê a mesma frase de antes; o selo não é lido à parte.
- [ ] Nas Mensagens, "hoje", "ontem" e uma data antiga aparecem entre os dias certos.
- [ ] Nas Mensagens, duas mensagens seguidas do mesmo lado com menos de 5 min da primeira formam grupo: a bolha de cima fecha os cantos do lado de quem enviou, e só a última mostra a hora.
- [ ] Nas Mensagens, uma mensagem a mais de 5 min da primeira do grupo começa um grupo novo.
- [ ] Nas Mensagens, com um convite entre duas mensagens do mesmo lado, elas não formam grupo.
- [ ] Pressionar e segurar uma mensagem de grupo abre a bolha inteira, com a hora; fechar o menu devolve o grupo.
- [ ] Na Publicar, o nome e o @nome aparecem ao lado do avatar, acima do campo de texto.
- [ ] Na Publicar, com cerca de 900 caracteres o anel fica âmbar e a contagem mostra quantos faltam; passando de 1000, o anel fica vermelho e o número fica negativo.
- [ ] Na Publicar, quando aparece a nota de limite de caracteres, vibra de aviso; publicar de fato vibra de sucesso; guardar na fila (sem rede) não vibra.
- [ ] Na Publicar, a alça aparece centralizada no topo da folha, sem tapar os botões, e o campo de texto não mostra anel de foco.

iOS (simulador ou aparelho, depois do Android):

- [ ] Os passos de barra fixa, Avisos, Mensagens e Publicar acima, e a barra com VoiceOver ligado: cada botão é lido uma vez, e a seta de voltar da faixa não aparece duplicada.
- [ ] Na Publicar, a alça aparece centralizada no topo da folha (só uma alça).
- [ ] A vibração de sucesso e a de aviso da Publicar acontecem num aparelho com Taptic Engine (o simulador não vibra).

Web (navegador, depois do iOS):

- [ ] No Diário e no Membro, a barra fixa aparece ao rolar, e os botões respondem ao mouse e ao teclado (Tab), sem duplicar.
- [ ] Nos Avisos e nas Mensagens, selo, negrito, dias e grupos aparecem iguais aos do app nativo.
- [ ] Na Publicar, a alça aparece no topo da folha. Não há vibração na web.
- [ ] Na Publicar, o campo de texto não mostra contorno do navegador ao receber o foco; o cursor mostra o foco.

Limites desta parte:

- As abas Publicações e Respostas do perfil não entram nesta etapa: uma resposta é `record.replyTo` dentro de `log.read` paginado, e não há leitura só de respostas.
- O anel e a contagem não mudam o limite de 1000 caracteres.
- Nas Mensagens, ao carregar mensagens anteriores do mesmo dia, o marcador do dia passa para a nova primeira mensagem daquele dia; a linha que tinha o marcador perde essa altura e pode subir um pouco se estiver na tela.
- Nenhuma caixa acima foi executada nesta documentação.

## 92. Dados mais cedo em A Rua e no Diário (PR perf/first-paint)

Três partes do app passam a mostrar dados mais cedo: as contagens de curtidas, respostas, republicações e citações, as citações e respostas de quem você não segue, e o Diário ao voltar à aba. Não muda o que é gravado nem o que o nó guarda; muda a ordem e o intervalo dos pedidos. Medidas do dono antes da mudança (Chrome, produção, visita repetida): as fotos dos autores começavam entre 2,35 s e 3,4 s; as contagens, em 3,4 s e 4,2 s; cada pedido de rede levava de 2 a 26 ms; o Diário levava cerca de 0,8 s a cada volta. Este documento não traz medidas novas: os números depois da mudança saem dos passos abaixo.

Regras que os passos abaixo conferem:

- Fotos dos autores: sem mudança (PR fix/quiet-boot-warm). Tirar o intervalo de 1 s entre pedidos profile.read não mudou nada na medida do dono: as fotos esperam a fila do nó no início, não esse intervalo.
- Contagens: o pedido ao índice do semeador (/index/counts) sai junto com a página, antes de follow.list e engagement.read, e não espera por eles. Uma curtida feita enquanto a contagem chega não é desfeita pela resposta antiga. "Indexando" continua escondendo as contagens.
- Citações e respostas de quem você não segue: os autores são lidos dois por vez (a busca do nome de um enquanto o outro é lido), e cada autor aparece assim que chega, sem esperar o mais lento. Todas as telas e a Conversa dividem uma só vaga de diary.peek do app, e a outra vaga do nó fica livre para a primeira mensagem privada e para a leitura de uma página. Uma Conversa ou um perfil aberto pela pessoa passa na frente das leituras de fundo de A Rua (espera no máximo a leitura em andamento). "Ocupado" deixa de ser o caso comum.
- Diário: voltar à aba em menos de 60 s não relê o diário (sem node.info nem log.read) e as citações não piscam. Relê na primeira vez, depois de 60 s, ao puxar para atualizar, depois de publicar ou apagar, depois de curtir ou republicar em outra aba, na primeira vez que a aba aparece depois de uma reconexão, depois de uma leitura que falhou, e quando outro aparelho publicou. No nó nativo sem instalação (sem o sinal de diário próprio), continua relendo a cada vez que a aba aparece.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `apps/app/test/namesCache.test.js` (batchWait e promoteTimer, o intervalo das fotos), `apps/app/test/engagement.test.js` (poolMap e createLimiter, as vagas de citações), `apps/app/test/paging.test.js` (shouldReloadDiario, quando o Diário relê) e `apps/app/test/localWrites.test.js` (a marca da última curtida ou republicação feita neste aparelho, que faz o Diário reler). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador, primeiro):

- [ ] Com o registro de rede aberto, recarregar A Rua: o primeiro /index/counts sai antes da resposta de engagement.read.
- [ ] Curtir uma publicação enquanto as contagens de A Rua ainda carregam: a curtida fica marcada e a contagem não volta ao valor antigo.
- [ ] Com o índice em "indexando", as contagens continuam escondidas.
- [ ] Em A Rua, as citações e respostas de quem você não segue: cada autor aparece assim que o nome chega, sem esperar o último.
- [ ] Abrir uma Conversa e mandar a primeira mensagem para alguém enquanto A Rua carrega citações: não aparece "ocupado".
- [ ] Trocar A Rua > Diário > A Rua > Diário em menos de 60 s: o Diário não mostra o indicador de atualização e as citações não piscam.
- [ ] Curtir em A Rua e voltar ao Diário em menos de 60 s: o Diário relê e a curtida aparece.
- [ ] Deixar o Diário fora da tela por mais de 60 s e voltar: o Diário relê.
- [ ] Puxar o Diário para atualizar: o Diário relê.
- [ ] No nó nativo sem instalação, o Diário relê a cada vez que a aba aparece.

iOS (simulador ou aparelho, depois do Android):

- [ ] Os passos de fotos, contagens e citações de A Rua acima, no simulador ou num aparelho.
- [ ] Trocar A Rua > Diário > A Rua > Diário em menos de 60 s: o Diário não relê (conferir no log, sem node.info nem log.read).
- [ ] Abrir uma Conversa e mandar a primeira mensagem enquanto A Rua carrega citações: não aparece "ocupado".

Web (navegador, depois do iOS):

- [ ] Na web hospedada, com o registro de rede aberto, recarregar A Rua: o /index/counts sai antes de engagement.read.
- [ ] Na web hospedada, trocar A Rua > Diário > A Rua > Diário em menos de 60 s: o Diário não relê e as citações não piscam.
- [ ] Curtir em A Rua enquanto a contagem chega: a curtida não é desfeita.

Limites desta parte:

- O intervalo de 1 s entre pedidos profile.read continua em todo nó; acelerar as fotos exige mexer na fila do nó no início (fica para depois).
- Já era assim antes e continua: uma curtida tocada antes de a publicação ter qualquer número fica sem número (ou sem o +1) até a próxima leitura; e um "atualizar" com o índice ainda indexando mostra os números antigos até a resposta nova chegar.
- Novo e aceito: um bloqueio da associação que chega enquanto o Diário está fresco tira a publicação citada ou republicada de quem foi bloqueado até 60 s depois (na próxima releitura), a mesma janela que A Rua já usa.
- Já era assim antes: republicar numa Conversa aberta por cima do Diário e voltar não relê o Diário (a aba não mudou); a republicação aparece na próxima troca de aba ou ao puxar para atualizar.
- Já era assim antes: se outro aparelho publica durante a leitura do Diário, o aviso de novidade é dado como visto; com a nova regra, a volta à aba em menos de 60 s não relê, e a publicação aparece ao puxar para atualizar ou depois de 60 s.
- Este documento não traz medidas depois da mudança: os números novos saem dos passos acima, no mesmo tipo de visita usado nas medidas do dono.
- Nenhuma caixa acima foi executada nesta documentação.

## 93. Espiadinha e Avisos prontos ao abrir (PR perf/warm-tabs)

No nó hospedado (web e app com a instalação), a Espiadinha e os Avisos começam a carregar antes de a pessoa abrir a aba. Não muda o que é gravado nem o que o nó guarda; muda a ordem e o momento dos pedidos. Medidas do dono antes da mudança (Chrome, produção, visita repetida): a primeira abertura da Espiadinha falhou com "Sem conexão agora"; na segunda tentativa, as linhas apareceram em 1,67 s e as citações cerca de 8,8 s depois. Avisos ficou em branco por 2,75 s. Este documento não traz medidas novas: os números depois da mudança saem dos passos abaixo.

Regras que os passos abaixo conferem:

- Espiadinha: no nó hospedado, com a aba escondida, o app lê a primeira página da Espiadinha uma vez por conexão, depois de a sincronização ficar pronta (linha `sync ready`) e de o app passar 3 s sem nenhum pedido ao nó (as leituras do início só começam no `sync ready`; PR perf/warm-when-idle), e só com a página visível e em linha. A página fica guardada fora da tela (nada é desenhado com a aba escondida) e aparece na hora ao abrir a aba (PR fix/quiet-boot-warm: no celular, desenhar a lista escondida disputava a tela com A Rua). As citações, contagens e corações dessa página só começam quando a aba aparece, para não disputar a fila do nó com A Rua. Uma falha escondida não mostra erro; a aba, ao abrir, tenta de novo. Abrir a aba durante essa leitura mostra o esqueleto e espera, sem segunda leitura. No nó nativo sem instalação, nada muda (lá a Espiadinha não existe).
- Avisos: cada página aparece assim que chega (antes, a tela esperava até 5 leituras e mostrava tudo de uma vez), com o indicador de atualização enquanto as continuações chegam. Com a aba escondida, uma leitura da primeira página acontece uma vez por conexão, depois de a sincronização ficar pronta e de o app passar 4 s sem nenhum pedido ao nó (depois da leitura da Espiadinha), e a leitura de 5 min também preenche a lista antes da primeira abertura. A lista escondida só muda o ponto do sino: nada é marcado como visto até a aba aparecer. Uma falha numa continuação mantém as linhas e oferece "tentar de novo" no fim da lista. Cada leitura continua com sua própria ligação curta ao semeador (decisão do dono).
- Um "atualizar" vindo de fora (seguir, apagar, publicar) que chega durante uma leitura em andamento espera ela terminar e então relê uma vez.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `apps/app/test/peek.test.js` (shouldWarmPeek), `apps/app/test/notices.test.js` (onPage de readNotices) e `apps/app/test/avisosHosted.test.js`. As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador, primeiro):

- [ ] Com o registro do nó aberto e a instalação hospedada, abrir o app em A Rua: nenhum peek.read nem notices.list antes de "sync ready" nem enquanto aparecem pedidos do início (feed.read, profile.read, dm.*, community.*); só depois de uns 3 s sem pedidos, um peek.read; e uns 4 s depois de ele terminar, um notices.list.
- [ ] Abrir a Espiadinha depois disso: as linhas aparecem na hora, sem esqueleto.
- [ ] Abrir a Espiadinha durante a leitura escondida: esqueleto, depois linhas, sem segundo peek.read.
- [ ] Abrir Avisos antes da leitura escondida: a primeira página aparece assim que chega, com o indicador de atualização.
- [ ] Com avisos novos e a aba escondida: o ponto do sino acende e, ao abrir, os avisos passam a vistos.
- [ ] O primeiro feed.read e o primeiro /index/counts de A Rua não ficam mais lentos.
- [ ] No nó nativo sem instalação, nenhuma leitura escondida acontece.

iOS (simulador ou aparelho, depois do Android):

- [ ] Os passos de Espiadinha e Avisos acima, no simulador ou num aparelho com a instalação hospedada.
- [ ] O primeiro feed.read de A Rua não fica mais lento (conferir no log).

Web (navegador, depois do iOS):

- [ ] Na web hospedada, com o registro de rede aberto, carregar a página: peek.read só depois de uns 3 s sem pedidos ao nó após "sync ready", e notices.list uns 4 s depois de o peek.read terminar.
- [ ] Na web hospedada, abrir a Espiadinha depois disso: as linhas aparecem na hora.
- [ ] Na web hospedada, abrir Avisos antes da leitura escondida: a primeira página aparece assim que chega.

Limites desta parte:

- O sinal do semeador vale para a ligação da sincronização, não para a ligação própria da Espiadinha, então a leitura escondida ainda pode falhar. Nesse caso fica quieta, e a aba tenta de novo ao abrir.
- A leitura escondida gasta uma ligação curta a mais ao semeador por conexão, mesmo que a pessoa nunca abra a aba.
- Abrir a Espiadinha mais de 60 s depois da leitura escondida mostra as linhas na hora, mas sem citações nem contagens, e relê a página (a regra de 60 s de sempre); as citações e contagens chegam com a página nova.
- No Android e no iOS, a primeira abertura dos Avisos pode mostrar o indicador de puxar para atualizar enquanto as continuações chegam.
- Nenhuma caixa executada nesta documentação.

## 94. Leituras do nó hospedado sem reiniciar a sincronização (PR perf/borrowed-group-reads)

No nó hospedado (web, PWA e app com a instalação), as leituras de comunidades e grupos e o plano da participação automática passam a usar os núcleos que a sincronização já tem abertos, como `feed.read`, `profile.read` e `log.read` já faziam (seção 46). Antes, cada uma delas parava a sincronização e a reiniciava depois (novo aperto de mão com o semeador e nova abertura de todos os núcleos). A sincronização agora empresta também os seus núcleos de grupo (os próprios e os de outros que ficam guardados quando ela termina) e os diários de quem escreve nesses grupos. Todos os nós (navegador, core e semeador) leem o diário com uma passagem só pelos registros de apagamento, em vez de três. Nada muda no que é gravado nem nas respostas.

A reinicialização que o log do celular mostrava logo depois de `dm.pull` não vinha de `dm.pull` (que não para a sincronização): era o primeiro plano da participação automática, 1,5 s depois da primeira linha "diário próprio sincronizado", que relia as comunidades parando a sincronização. Com o plano nos núcleos emprestados, um plano sem nada a escrever não para mais a sincronização; só uma escrita de verdade passa pela trava de escrita e reinicia.

Medidas (repetição local no Node, DHT local, semeador no mesmo processo atrás de um WebSocket, armazenamento IndexedDB falso; a mesma rajada de pedidos do início do app em `main@b84a420` e nesta mudança; "latência 4 ms" acrescenta 4 ms a cada carga de arquivo de núcleo e a cada leitura de kv, como um IndexedDB de celular). Não são medidas de celular: servem para comparar antes e depois.

| Cenário | Rajada do início | Execuções paradas | Núcleos abertos | CPU (rajada + 6 s) |
|---|---|---|---|---|
| Médio, sem latência | 315 ms -> 166 ms | 5 -> 0 | 96 -> 20 | 540 ms -> 285 ms |
| Médio, latência 4 ms | 2,33 s -> 1,05 s | 4 -> 0 | 78 -> 20 | 735 ms -> 441 ms |
| Grande, sem latência | 970 ms -> 608 ms | 5 -> 0 | 149 -> 38 | 1,61 s -> 0,84 s |
| Grande, latência 4 ms | 3,13 s -> 1,46 s | 3 -> 0 | 109 -> 38 | 2,17 s -> 0,84 s |

Médio: 200 posts próprios, 12 seguidos com 40 posts cada, 40 curtidas, uma comunidade com Geral. Grande: 800 posts próprios, 30 seguidos com 150 posts cada, 150 curtidas. No grande com latência, `community.info` caiu de 503 ms para 108 ms, `group.read` de 863 ms para 271 ms e `group.seen` de 392 ms para 70 ms. No perfil de CPU do cenário grande, a validação de registros (`validRecordCopy`) caiu de 470 ms para 317 ms, e a parte dela que vinha das três passagens por apagamentos, de 207 ms para 25 ms.

Regras que os passos abaixo conferem:

- Com uma sincronização em andamento, `community.list`, `community.info`, `community.members`, `community.requests`, `group.list`, `group.info`, `group.read`, `group.members`, `group.requests` e `group.seen` respondem sem `sync.stopped` `'preempted'`, com o mesmo `runId`, e com a mesma resposta que dariam sem sincronização.
- Uma leitura que precisa de um núcleo guardado que a sincronização não tem aberto (por exemplo, um núcleo ainda na checagem de entrada) volta ao caminho exclusivo e para a sincronização uma vez, com a mesma resposta.
- Um plano da participação automática sem nada a escrever não para a sincronização. Um plano com algo a escrever continua passando pela trava de escrita e pelo envio ao semeador, como antes.
- Uma leitura nos núcleos emprestados nunca abre um núcleo no armazenamento ao lado da sincronização. Se a sincronização deixa de emprestar uma réplica no meio de `page.read` (ela a separa e só fecha depois), a leitura é refeita no caminho exclusivo, depois de a sincronização parar.
- A leitura do diário com apagamentos (`presentState`) dá as mesmas respostas de antes.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `packages/web-member/test/read-while-sync.test.js` (leituras de comunidade e grupo na sincronização em andamento, a volta ao caminho exclusivo e a réplica que deixa de ser emprestada no meio de `page.read`), `packages/web-member/test/session-upkeep.test.js` (plano vazio sem parar a sincronização, limite de passagens) e `packages/core/test/deletion.test.js` (`presentState` igual às três passagens em diários aleatórios). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador com a instalação hospedada, primeiro):

- [ ] Com o registro de Sincronização aberto, abrir o app e esperar "sync ready": abrir Conversas e depois uma comunidade não cria um novo "sync ready" (antes apareciam #2 e #3).
- [ ] Cerca de 2 s depois de "diário próprio sincronizado", nenhuma reinicialização da sincronização (antes vinha o plano da participação automática).
- [ ] As linhas "pedido lento" de `community.list`, `community.info`, `dm.list` e `profile.read` diminuem ou somem, comparando com o mesmo aparelho antes da mudança.
- [ ] Com a mesma passkey em dois aparelhos e uma comunidade, o segundo aparelho ainda entra sozinho na comunidade e no Geral.

iOS (simulador ou aparelho com a instalação hospedada, depois do Android):

- [ ] Os três primeiros passos do Android.

Web (navegador, depois do iOS):

- [ ] Na web hospedada, com o registro de rede aberto, recarregar: os GETs de `/media` dos avatares começam mais cedo que antes.
- [ ] Abrir uma comunidade e um grupo com a sincronização ligada: o estado da sincronização em Ajustes não muda de execução.

Limites desta parte:

- As medidas são do Node com IndexedDB falso e latência simulada, não do celular. Os números do celular saem dos passos acima.
- Um núcleo de grupo ainda na checagem de entrada, o diário de um membro que a sincronização ainda está abrindo logo na partida, ou um núcleo que a sincronização não guarda ainda param a sincronização uma vez, como antes.
- Os pedidos continuam um de cada vez na fila do nó: um pedido ainda espera os que chegaram antes dele.
- Uma leitura que responde com erro (comunidade inexistente, `group.requests` de quem não administra) ainda é refeita no caminho exclusivo e para a sincronização uma vez, como `feed.read` desde a seção 46. O app só pede `group.requests` a quem administra.
- A maior parte da CPU restante das leituras é revalidar os mesmos registros a cada leitura (históricos de entrada, confirmação e corte dos grupos, nome de usuário e perfil). Proposta para um próximo PR: o mesmo filtro por tipo antes da validação nesses pontos, ou guardar os registros decodificados por núcleo enquanto a sincronização vive.
- Nenhuma caixa executada nesta documentação.

## 95. Abertura até A Rua ficar pronta, com barra de progresso (PR feat/splash-until-ready)

A tela de abertura continua sobre A Rua depois de o perfil próprio ficar pronto, até a primeira página estar na tela com os nomes e as contagens das primeiras linhas, e nunca mais que 5 s além disso. A Rua termina de carregar por baixo da abertura; quem abre o app vê a lista já preenchida. O texto "conectando…" saiu: no lugar dele, uma barra fina que avança por etapas reais (conexão, perfil próprio, primeira página, nomes e contagens), nunca por um relógio. A barra só cresce.

Regras que os passos abaixo conferem:

- Só A Rua como primeira tela espera as linhas. Um link aberto na entrada (uma conversa, um perfil) ou outra aba aparece na hora.
- No máximo 5 s a mais (CONTENT_PATIENCE_MS) depois de o perfil ficar pronto; passou disso, A Rua aparece e termina de carregar à vista.
- As linhas estão prontas quando os autores das 6 primeiras foram consultados (um perfil sem nome também conta) e as contagens responderam para pelo menos uma delas. Sem nó hospedado, sem rede, com o índice indexando ou com a resposta de contagens falhando, não se espera pelas contagens. Uma primeira leitura que falha também libera a tela.
- A abertura só aparece uma vez por carregamento: travar e destravar, reconectar ou trocar de aba nunca a traz de volta.
- Na web e no PWA a barra é desenhada pela camada de `public/index.html`; o app só passa o avanço (variável CSS `--varanda-progress`). No celular nativo, o próprio componente da abertura desenha a barra.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `apps/app/test/splashGate.test.js` (cobertura de 'pronto', teto de 5 s, `feedDetailsReady`, `bootProgress`), `apps/app/test/splashMotion.test.js` e `apps/app/test/pwa.test.js` (barra na camada da web, sem "conectando").

Android (aparelho ou emulador, primeiro):

- [ ] Abrir o app já conectado: a abertura mostra a barra avançando, sem "conectando…", e some com A Rua já com nomes, fotos e números nas primeiras linhas.
- [ ] Com a rede lenta, a abertura some no máximo cerca de 5 s depois de a barra passar da metade, e A Rua termina de carregar à vista.
- [ ] Abrir o app por um link de conversa ou de perfil: a tela do link aparece sem esperar A Rua.
- [ ] Travar e destravar, ou perder e recuperar a rede: a abertura não volta.

iOS (simulador ou aparelho, depois do Android):

- [ ] Os passos acima.

Web e PWA (depois):

- [ ] Recarregar a página: a camada de abertura mostra a barra (sem texto), que avança e some com A Rua preenchida.
- [ ] Em Ajustes › Aparência, Claro e Escuro: a barra acompanha as cores.
- [ ] Com "reduzir movimento" ligado no sistema, a barra aparece sem pulsar e sem animação de largura.

Limites desta parte:

- A barra esconde a espera, não a encurta: os dados chegam no mesmo tempo de antes, só que por baixo da abertura.
- As fotos em si (os bytes) carregam logo depois de os nomes chegarem; a abertura espera os nomes, não cada imagem.
- Nenhuma caixa acima foi executada nesta documentação.

## 96. Primeira leitura de A Rua sem verificar de novo as mesmas assinaturas (PR perf/first-feed-read)

No nó hospedado (web, PWA e app com a instalação), o nó roda no navegador, e o navegador verifica assinaturas Ed25519 em JavaScript puro (sodium-javascript): cerca de 4 ms por assinatura neste Mac e várias vezes isso num celular, contra 0,07 ms da biblioteca nativa do Node. Cada leitura verificava de novo as mesmas assinaturas: o certificado de cada diário seguido (duas, com o emissor), o registro de nome de usuário (mais duas) e a lista de bloqueio guardada (duas, e cada leitura a lê duas vezes). Isso acontecia na checagem de entrada da sincronização, em `feed.read`, de novo em `profile.read` e em `dm.enable`. Era a maior parte do tempo de `feed.read` e `profile.read` no início do app. As repetições anteriores no Node usavam a biblioteca nativa e não mostravam esse custo.

Duas mudanças, em todos os nós (navegador, core e semeador):

- Uma assinatura que já verificou não é verificada de novo enquanto a página (ou o processo) vive. Para cada chave pública e assinatura, a memória guarda uma cópia exata da mensagem e só responde quando a mensagem é igual byte a byte. Só guarda verificações que deram certo, no máximo 4096 e 4 MiB de mensagens. Revogação de emissor, associação e forma do registro continuam conferidas em toda leitura, então um bloqueio ou uma revogação nova vale na leitura seguinte, como antes.
- `feed.read` (e o feed da CLI) só confere o nome de usuário de quem aparece na página pedida (20 itens no app), não de todos os seguidos. A resposta é a mesma.

Nada muda no que é gravado, nas respostas nem nos caminhos emprestado e exclusivo das leituras (seção 46).

Medidas (repetição local no Node, a mesma da seção 94: DHT local, semeador no mesmo processo atrás de um WebSocket, IndexedDB falso; a rajada de pedidos do início do app em `main@95048d8` e nesta mudança; aqui com certificados v2 de um emissor, nome de usuário em todos os diários, lista de bloqueio guardada com 40 chaves e verificação com sodium-javascript, como no navegador). "Latência 4 ms" acrescenta 4 ms a cada carga de arquivo de núcleo e a cada leitura de kv. Não são medidas de celular: servem para comparar antes e depois. Pelos números do dono, o celular gastou cerca de 3 vezes o tempo desta repetição em `feed.read` (2,9 s contra 0,9 s), mas essa proporção é só uma estimativa.

| Cenário | `feed.read` | `profile.read` | `dm.enable` | Assinaturas verificadas | CPU da rajada |
|---|---|---|---|---|---|
| Dono, sem latência | 890-895 ms -> 232-235 ms | 1,39 s -> 352-357 ms | 1,00-1,01 s -> 123-189 ms | 431 -> 78 | 2,66-2,83 s -> 0,78-0,82 s |
| Dono, latência 4 ms | 1,34-1,39 s -> 773-774 ms | 1,84-1,91 s -> 922-941 ms | 1,08-1,09 s -> 268-296 ms | 431 -> 78 a 80 | 2,83-3,21 s -> 0,94-1,00 s |
| Grande, latência 4 ms | 2,22 s -> 1,36 s | 3,06 s -> 1,63 s | 1,90 s -> 555 ms | 671 -> 128 | 5,10 s -> 2,37 s |

Dono: 36 seguidos com 60 posts cada, diário próprio com 170 posts (272 blocos), 60 curtidas, uma comunidade com Geral; duas repetições de cada lado (os intervalos acima). Grande: 60 seguidos com 150 posts cada, 800 posts próprios, 150 curtidas; uma repetição. No Dono sem latência, o trabalho de `feed.read` nos núcleos caiu de cerca de 530 ms para 63 ms e o de `profile.read` de cerca de 490 ms para cerca de 120 ms (os nomes de usuário de quem não apareceu na primeira página passam a ser conferidos aqui, uma vez). A sincronização passou a emprestar os núcleos cerca de 170 ms depois de começar, em vez de cerca de 360 ms: a checagem de entrada dos seguidos caiu de cerca de 300 ms para cerca de 150 ms, porque a delegação do emissor, igual em todos os certificados, é verificada uma vez só (medido com marcas temporárias nas etapas da partida, que não ficam no código). O que sobra de verificação são assinaturas diferentes: um certificado por seguido na partida, a delegação do emissor uma vez, o nome de usuário de cada autor uma vez e a lista de bloqueio uma vez. Com latência, o que sobra da espera de `feed.read` é quase todo a partida da sincronização (ver os limites).

O script `packages/web-member/scripts/startup-bench.js` mede só a partida da sincronização e as primeiras leituras nos núcleos emprestados, sem rede, e serve para repetir a comparação: `node packages/web-member/scripts/startup-bench.js --follows 36 --blocks 60 --own 172 --issued --js-verify --reads --runs 5` (e `--idb` para o IndexedDB falso). Medianas de 5 execuções neste Mac, `main@95048d8` -> esta mudança:

| Armazenamento | Até emprestar os núcleos | Primeira `feed.read` | `profile.read` de todos | Assinaturas verificadas |
|---|---|---|---|---|
| Memória | 230 ms -> 128 ms | 470 ms -> 38 ms | 442 ms -> 108 ms | 362 -> 74 |
| IndexedDB falso | 295 ms -> 176 ms | 457 ms -> 31 ms | 448 ms -> 113 ms | 362 -> 74 |

Regras que os passos abaixo conferem:

- Com a sincronização em andamento, a segunda `feed.read` e a segunda `profile.read` não verificam nenhuma assinatura de novo e respondem igual à primeira.
- Uma lista de bloqueio gravada depois dessas leituras esconde o diário bloqueado já na leitura seguinte, em `feed.read` e em `profile.read`.
- Com a memória já preenchida, um certificado ou um nome de usuário de um emissor revogado continua recusado (`revoked-issuer`), e um registro alterado com a mesma assinatura continua recusado (`bad-signature`).
- Uma verificação que falhou é refeita sempre. Chave ou assinatura de outro tamanho nunca usa a memória.
- `feed.read` dá os mesmos nomes de usuário em todas as páginas, e confere o nome só de quem tem item na página.

### Como verificar

Do repositório: `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo`. Testes desta parte: `packages/core/test/verified.test.js` (memória: mesmas respostas, cópia da mensagem, tamanhos, limites, revogação e alteração com a memória preenchida), `packages/core/test/feed.test.js` (nome de usuário só da página, mesmas respostas) e `packages/web-member/test/read-while-sync.test.js` (leituras repetidas na sincronização sem verificar de novo, e o bloqueio novo que esconde na leitura seguinte). As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador com a instalação hospedada, primeiro):

- [ ] Com o registro de Sincronização aberto, abrir o app: as linhas "pedido lento" de `feed.read`, `profile.read`, `engagement.read`, `dm.enable`, `dm.list`, `community.list` e `dm.pull` diminuem ou somem, comparando com o mesmo aparelho antes da mudança.
- [ ] A Rua mostra os posts e os @nomes de quem aparece como antes.
- [ ] Uma conta bloqueada pela moderação continua fora de A Rua e sem nome.

iOS (simulador ou aparelho com a instalação hospedada, depois do Android):

- [ ] Os três passos do Android.

Web (navegador, depois do iOS):

- [ ] No Chrome do computador, com o registro de rede aberto, recarregar A Rua: os GETs de `/media` das fotos dos autores começam antes de cerca de 2,4 s (o que se via depois da seção 93).

Limites desta parte:

- As medidas são do Node com IndexedDB falso e latência simulada, não do celular. Os números do celular saem dos passos acima.
- A memória vive enquanto a página vive: cada carga da página verifica de novo, uma vez, cada assinatura. Guardar a memória no armazenamento do navegador confiaria num lugar que qualquer pessoa com acesso ao perfil do navegador pode escrever, então isso não foi feito.
- Com latência de armazenamento, o que sobra da espera da primeira `feed.read` é a partida da sincronização: abrir os núcleos de grupo próprios, abrir as réplicas e a varredura de bloqueados, que pergunta ao IndexedDB por cada chave bloqueada, uma de cada vez (cerca de 160 ms com 40 chaves e 4 ms por pergunta). Ficam para um próximo PR.
- A memória tem limite, mas quem pode assinar coisas que o nó verifica (no serviço de conta, as provas de página de qualquer chave; nos outros nós, emissores e moderadores) pode encher a memória e tirar dela outras entradas. O efeito é só verificar de novo, como antes desta mudança.
- Uma verificação Ed25519 mais rápida no navegador (por exemplo `@noble/curves`) mudaria as regras de aceitação em casos de borda (equação com ou sem cofator, pontos de ordem pequena) em relação ao libsodium dos outros nós, e não foi feita.
- Nenhuma caixa executada nesta documentação.

## 97. Convites de surpresa (PR feat/invite-drops)

### O que mudou

Com `VARANDA_INVITE_DROPS=1` (exige `VARANDA_INVITES_PER_WEEK`; o `deploy.sh` e o serviço `account` recusam o par incompleto), os N convites da semana de cada membro deixam de abrir todos na segunda 00:00 e passam a abrir um a um, em N minutos sorteados entre 09:00 e 20:59 (horário de Brasília), diferentes por membro, só entre os minutos ainda futuros depois do vínculo e da ativação. O sorteio é uma função do segredo de `invite-drops-key.json` (modo 0600, escrito uma vez junto da data de ativação), da chave do membro e da semana; o `invite-drops.json` (modo 0600) guarda só os índices já avisados, sem horário, e é podado no fim da semana. Um arquivo de chave inválido, ou ausente ao lado de um `invite-drops.json` existente, deixa as concessões indisponíveis (`indisponivel`) em vez de liberar a semana inteira.

- Criar o link antes do momento responde `convite-aguardando` (429). Um convite criado conta na semana, como na seção 37; o que não foi usado some na segunda 00:00; um código já emitido vale 7 dias.
- Nova rota `POST /account/invites/summary`: o membro assina com `invite.sign` na ação `summary` (uso único do nonce de `/account/invites/start`) e recebe `{ mode, perWeek, opened, used, remaining, resetsAt }`, com `mode` `semanal` ou `sorteio`. Limite de 30 pedidos por 10 minutos por membro, sem verificação de idade (a leitura não cria nada). Sem o recurso, o mesmo pedido responde `semanal`.
- Aviso push novo, `{ v: 1, kind: 'invite-drop' }`, enviado pelo próprio serviço de conta (nunca pelo semeador nem por `PUSH_KINDS`). Título "Chegou um convite pra sua varanda" e texto "Escolha com carinho quem você quer chamar: alguém próximo, que faz falta na conversa." ficam fixos no service worker (tag `varanda-invite-drop`); o clique abre `/?aviso=convite`. Só vai a quem aceitou Termos e Política na versão 16, a todos os aparelhos do membro ou a nenhum. Os envios de convite ocupam no máximo um quarto da fila e só entram com a fila abaixo da metade. Um aviso que não saiu até 21:00 de Brasília é descartado, e o TTL nunca passa do fim da janela.
- O aviso só sai dentro da janela. Se o serviço estava parado no minuto sorteado, o aviso é recuperado uma vez na próxima janela, desde que a semana seja a mesma. Os índices são marcados antes do envio e nunca desmarcados.
- No app (hospedado, o nativo com a instalação inclusive), Ajustes › Convidar pessoas mostra quantos convites já chegaram e um aviso dentro do app, sem dia nem hora. Web Push é só da PWA hospedada.
- Termos de Uso e Política de Privacidade na versão 16, com novo aceite.
- Registro de logs do serviço: só `{ event: 'sorteio', reason }` com `ligado`, `indisponivel`, `enviado` ou `descartado`, e `{ event: 'ready', inviteDrops: true }`. Nenhum horário, chave, segredo ou índice.

### Testes automatizados

- `packages/core/test/invite.test.js`: a ação `summary` assina e verifica, e uma assinatura de `issue` não vale como `summary`.
- `packages/core/test/terms.test.js`: `TERMS_VERSION` 16.
- `packages/rpc/test/methods.test.js`: `invite.sign` aceita `summary`.
- `apps/cli/test/invite-drop-time.test.js`: janela 09:00-20:59 em Brasília, semana de segunda, minutos só no futuro depois do vínculo e da ativação, sorteio estável para a mesma chave, diferente por membro, segredo e semana, e uma semana de 100 minutos preenchida inteira.
- `apps/cli/test/invite-drops.test.js`: chave escrita uma vez, arquivo de chave inválido deixado intacto, chave ausente ao lado de um registro nunca recriada (nem pelo `heal`), registro inválido nunca regravado, união ao reler com poda das semanas encerradas, aviso uma vez entre ciclos e reaberturas, minuto perdido recuperado na janela e nunca às 03:00 nem depois da semana, marcas gravadas mesmo com `none` e `dropped`, lote limitado por `room()`, `guard` falso sem gravar.
- `apps/cli/test/invites-store.test.js`: `opened`, `convite-aguardando`, `indisponivel` com callback que falha ou devolve valor inválido, `summary` com `opened`.
- `apps/cli/test/account-invites.test.js`: `POST /account/invites/summary` (assinatura, nonce, limite de 30, modo `semanal` e `sorteio`, sem verificação de idade) e `convite-aguardando` como 429.
- `apps/cli/test/account-invites-cli.test.js`: `VARANDA_INVITE_DROPS` só liga com `1` e exige `VARANDA_INVITES_PER_WEEK`; a perda do lock marca os sorteios como indisponíveis e para o laço.
- `apps/cli/test/account-push.test.js`: `notifyInvite` (payload só com o tipo, todos os aparelhos ou nenhum, `none` sem transporte ou aparelho, prazo e TTL, um quarto da fila e metade da fila, argumentos inválidos, o relé continua recusando o evento `invite-drop`).
- `apps/cli/test/account-store.test.js`: `linkedAt` e `linkRoster` (só chave e data do vínculo).
- `apps/cli/test/push-text.test.js`: payload `invite-drop` com duas chaves e sem texto.
- `apps/cli/test/web-push.test.js`: `ttlS` válido e inválido.
- `apps/cli/test/deploy.test.js`: `VARANDA_INVITE_DROPS` no `deploy.sh`, no `compose.web.yaml` e no `.env.example`, e a recusa sem `VARANDA_INVITES_PER_WEEK`.
- `apps/app/test/signupInvite.test.js`: `dropView` nos dois modos e os textos.
- `apps/app/test/account.test.js`: o resumo assinado no cliente, a forma exata, a queda para o serviço antigo e resumos malformados indisponíveis, sem repetição automática.
- `apps/app/test/push-state.test.js`: `?aviso=convite` e a mensagem `varanda-invite-open`.
- `apps/app/test/sw.test.js`: o worker mostra o título e o texto fixos, qualquer payload com mais que isso cai no texto genérico, e o clique foca o app e envia `varanda-invite-open`.
- `apps/app/test/help.test.js` e `apps/app/test/legal.test.js`: texto de ajuda e versão 16 dos Termos.
- `apps/app/test/inviteDrop.test.js`: o aviso dentro do app e a lógica do que já foi visto.

Resultado da CI local (06/11/2026, Node 24, sobre origin/main@46adbd43): `npm run lint` limpo; `npm test` com 380 arquivos, 378 passaram de primeira; `packages/core/test/seeder-delete.test.js` falhou uma vez no conjunto e passou sozinho (28/28); `apps/cli/test/ai-embedder.test.js` falha nesta máquina também na `main`, porque o caminho da pasta de trabalho contém "sharp" e o teste recusa módulos com esse nome; `npm run demo` terminou com DEMO OK. `npm ci --ignore-scripts` não rodou de novo: nenhuma dependência mudou.

### Verificação humana

As caixas abaixo ficam desmarcadas até alguém executar o passo, num aparelho ou navegador de verdade.

Android (aparelho ou emulador com a instalação hospedada, primeiro):

- [ ] Em Ajustes › Convidar pessoas, aparecem quantos convites já chegaram e o aviso dentro do app, sem notificação do sistema.
- [ ] Antes do momento do convite, tocar em Criar link mostra que o convite ainda não chegou.

iOS (simulador ou aparelho com a instalação hospedada, depois do Android):

- [ ] Os dois passos do Android.

Web e PWA (depois do iOS):

- [ ] Dentro da janela, o aviso aparece com o título e o texto aprovados.
- [ ] Tocar no aviso abre Ajustes › Convidar pessoas com o app aberto, fechado e com a identidade bloqueada.
- [ ] Um segundo ciclo do serviço não envia o aviso de novo.
- [ ] Reiniciar o serviço dentro da semana não envia nada duas vezes.
- [ ] Na segunda 03:00Z, um convite não usado some.
- [ ] `docker logs` do serviço `account` mostra só tokens (`sorteio`, `enviado`, `descartado`), nunca horário, chave ou índice.
- [ ] Com `VARANDA_INVITE_DROPS` vazio, tudo se comporta como na seção 37.
- [ ] Com um worker antigo (página aberta antes da atualização), o aviso mostra o texto genérico.

### Limites

- Sem push no app nativo: o convite aparece ao abrir o app.
- Sem transporte de push (sem chave VAPID ou com `push.json` inválido) nada é reservado: os avisos saem quando o push volta, se a semana for a mesma. Quem não tem inscrição no minuto do convite recebe só o aviso dentro do app: o índice é marcado uma vez e não há novo envio naquela semana.
- Uma falha ao ler o lock logo depois de gravar a reserva, ou uma fila de push que não esvazia até 21:00, perde o aviso daquele momento (o convite continua aberto e o aviso dentro do app continua valendo).
- O aviso push só vai a quem aceitou Termos e Política na versão 16. Quem ainda não aceitou não tem o momento reservado: o aviso sai na próxima volta do laço depois do aceite, se a semana for a mesma.
- Duplicata possível só na janela de troca do lock do serviço (a mesma de `invites-store.js`).
- Uma queda entre a gravação do `invite-drops.json` e o envio perde o aviso, nunca a concessão.
- Um momento no domingo à noite deixa poucas horas para usar o convite antes de segunda 00:00.
- Subir N no meio da semana pode abrir um convite novo na hora.
- Os envios de convite usam no máximo um quarto da fila de push, um envio que não saiu até 21:00 de Brasília é descartado, e nos 2 minutos antes das 21:00 nenhum momento é reservado (fica para a próxima janela da mesma semana), menos no domingo, que não tem outra janela na semana. Uma falha passageira ao ler o lock só pula aquela volta do laço; a perda real do lock para os sorteios até reiniciar.
- Apps nativos antigos mostram o texto do modo fixo até atualizar. Ao tocar em Criar link antes do momento, um app nativo antigo mostra a frase "Se o convite foi criado, ele já conta nesta semana." (recusa desconhecida `convite-aguardando`).
- Apagar o `invite-drops-key.json` não reinicia o sorteio: com o `invite-drops.json` ao lado, o serviço o trata como indisponível.
- Os aparelhos de um mesmo membro saem um depois do outro: com a fila de push atrasada mais de 2 minutos bem na virada das 21:00, os aparelhos mais novos podem perder o aviso pelo prazo.
- Se a fila de push enche durante a gravação do `invite-drops.json`, o aviso daquele momento é descartado (registro `descartado`) e não é repetido na semana; o convite continua aberto e o aviso dentro do app continua valendo.
- Na primeira ativação, uma troca do lock bem no meio da criação do `invite-drops-key.json` pode deixar o processo novo com um segredo diferente do gravado; os índices já avisados passam a valer outros minutos depois do reinício (no pior caso, um aviso repetido ou perdido naquela semana).
- O registro de aviso visto fica um por aparelho: com duas contas no mesmo aparelho, uma pode ver de novo o aviso de um convite já mostrado depois de recarregar.
- O TTL do aviso de convite (os segundos até 21:00) é diferente do TTL dos avisos sociais (24 h) e fica visível ao serviço de push do navegador, que assim distingue um aviso de convite de um aviso social; o conteúdo continua cifrado e do mesmo tamanho.
- Ajustes lê a política de convites ao abrir: se o operador ligar os convites com Ajustes já aberto, um clique no aviso só leva a Convidar pessoas depois de fechar e abrir Ajustes de novo.
- Nenhuma caixa executada nesta documentação.

## 98. Linha de base da revisão visual (PR chore/assessment-lab)

Primeira caminhada completa pelas telas do ciclo de [design-review.md](design-review.md), nas três plataformas, antes de qualquer correção visual deste PR. Serve de referência: as capturas mostram o ponto de partida, e cada rodada de correção depois compara com elas. A caminhada usa a Vitrine (dados de exemplo) para as telas sem conta e o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`, em [development.md](development.md), "Instalação hospedada local") para a troca de mensagens entre duas pessoas.

Regras que os passos conferem:

- Cada tela sai nos temas claro e escuro, com texto grande e com movimento reduzido, nas plataformas em que a caminhada roda.
- As capturas ficam fora do git, em `~/Workspace/evidencias/chore/assessment-lab/<plataforma>/`, uma pasta por plataforma, gravadas por `apps/app/scripts/review-shots.sh` com o rótulo `base-<tela>`. O registro do PR cita o caminho de cada uma.
- Uma caixa só é marcada depois que o passo foi executado e a captura guardada. Nada abaixo foi executado nesta documentação.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.
- `node apps/cli/test/hosted-lab.test.js` e `node apps/app/test/vitrine.test.js`, um arquivo por vez. São os testes do laboratório e da Vitrine; não substituem a caminhada.

Android (AVD `varanda-api36`, primeiro):

- [ ] A Vitrine sobe com `EXPO_PUBLIC_VARANDA_VITRINE=1`, e as telas do ciclo (A Rua, Conversa, Membro, Diário, Conversas e filtros, Mensagem, Comunidade, Grupo, ComunidadeInfo, Avisos, Busca, Publicar, Ajustes e Introdução) abrem com dados de exemplo. Capturas: `~/Workspace/evidencias/chore/assessment-lab/android/`.
- [ ] Cada tela em tema claro e em tema escuro, com uma crítica curta (o que está bom, o que quebra a referência, a correção proposta) anotada no registro.
- [ ] Texto grande e movimento reduzido: nenhum texto cortado, sobreposto ou escondido, e nenhum alvo de toque menor que 44 pt.

iOS (simulador iPhone 16e, depois do Android):

- [ ] As mesmas telas, em tema claro e escuro, com a Vitrine; capturas em `~/Workspace/evidencias/chore/assessment-lab/ios/`.
- [ ] Texto grande e movimento reduzido, com a mesma conferência de corte, sobreposição e alvo de toque do Android.

Web (Chrome, depois do iOS):

- [ ] As mesmas telas em 390 px e em 1280 px, nos temas claro e escuro, com a Vitrine. Capturas em `~/Workspace/evidencias/chore/assessment-lab/web/`.
- [ ] Laboratório hospedado com dois perfis do Chrome: Pessoa 1 e Pessoa 2 entram, trocam uma mensagem direta e uma publicação em grupo, e as duas telas mostram o que foi enviado. Registrar o número de cada passo que falhou, se algum.
- [ ] Texto grande e movimento reduzido na web, sem corte nem sobreposição.

Entrada nativa real (caixa separada: não é parte da revisão visual):

- [ ] entrada nativa real: entrar com passkey e conta no app instalado, no Android e no iOS. Pré-requisitos que ainda faltam:
  - iOS: o domínio associado da conta Apple Developer, sem o qual a passkey não entra.
  - Android: o `assetlinks.json` da instalação precisa associar o build de debug (`app.varanda.debug`), o que a instalação de produção não faz e não deve fazer com a chave pública de debug. Até lá, o login com conta no Android usa o APK de preview do EAS (ver a seção Android de [development.md](development.md)).
  - A configuração hospedada do app nativo exige `https`.

Limites desta linha de base:

- O laboratório só troca mensagens diretas no Chrome: o nó do aparelho recusa `dm.*` (`packages/core/lib/session.js`, linhas 614 a 621).
- Uma caminhada aprovada não libera o login nativo real: esse é o portão separado, marcado acima.
- A caminhada não corrige nada. As correções entram em rodadas posteriores, cada uma com as capturas da rodada anterior como comparação.
- Nenhuma caixa acima foi executada nesta documentação.

## 99. Transições, gesto de borda, movimento reduzido e Voltar (PR feat/ui-tokens-motion)

Roteiro da transição entre telas da pilha (`apps/app/src/ui/StackLayer.js`, com os planos em `apps/app/src/stackMotion.js`), do gesto de voltar pela borda esquerda e do botão Voltar, nas três plataformas e nos dois temas. Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e a captura, ou o registro, fica guardado.

Regras que os passos conferem:

- Uma tela aberta desliza da direita em 250 ms, e a volta a faz sair para a direita. A tela de baixo fica parada, e a barra de abas some enquanto há uma tela aberta (veja [app.md](app.md), "Navegação").
- Movimento reduzido: a tela chega ao lugar final sem deslizar, na mesma direção e sem atraso. Conferir com o ajuste de movimento reduzido ligado e desligado, na abertura e na volta.
- Gesto de borda: só um arrasto que começa a até 24 pt da borda esquerda da tela volta uma tela. Um arrasto que começa sobre o conteúdo é do que rola ali, e nada volta. Vale só para arrastar para a direita, com movimento mais horizontal que vertical.
- Soltar: se o arrasto passou de 35% da largura, ou se foi um toque rápido com velocidade acima de 0,5 px por ms, a volta se completa a partir do ponto em que a tela está, na mesma velocidade. Senão a tela retorna ao lugar. Um arrasto que termina para a esquerda nunca volta, mesmo rápido.
- Um segundo Voltar, ou um segundo arrasto, durante o deslize é ignorado. No Android, o botão Voltar é consumido nesse intervalo, e o app não sai.
- Web: cada tela aberta é uma entrada do histórico. O Voltar do navegador e a tecla Escape fazem a mesma volta com o mesmo deslize, e histórico e pilha andam juntos.
- Durante o deslize, nenhuma tela some, pisca, perde o estado (rolagem, rascunho) nem repete um carregamento.

Android (AVD `varanda-api36`, primeiro):

- [ ] Abrir Conversa a partir de A Rua: a tela desliza da direita. A volta pela seta da barra do topo a faz sair para a direita.
- [ ] Arrasto a partir da borda esquerda passando de 35%: volta. Arrasto mais curto e solto: a tela retorna. Toque rápido e curto para a direita: volta.
- [ ] Arrasto que começa no meio da tela, sobre uma lista: a lista rola e nenhuma tela volta.
- [ ] Botão Voltar do Android durante o deslize: ignorado, o app continua aberto. Depois que o deslize termina: volta uma tela.
- [ ] Movimento reduzido ligado: abrir e voltar sem deslize, com a mesma tela final.
- [ ] Tema claro e tema escuro: nenhuma tela cortada, sobreposta ou vazia durante o deslize. Capturas em `~/Workspace/evidencias/feat/ui-tokens-motion/android/`.

iOS (simulador iPhone 16e, depois do Android):

- [ ] Os mesmos passos de abertura, volta e arrasto pela borda esquerda. Conferir que o gesto do próprio sistema, que começa na borda do simulador, não disputa com o do app.
- [ ] Movimento reduzido ligado nos Ajustes de Acessibilidade do simulador: abrir e voltar sem deslize.
- [ ] Tema claro e tema escuro, com a mesma conferência de corte e sobreposição do Android. Capturas em `~/Workspace/evidencias/feat/ui-tokens-motion/ios/`.

Web (Chrome, depois do iOS):

- [ ] Em 390 px e em 1280 px, nos temas claro e escuro: abrir uma tela e voltar pelo botão Voltar do navegador desliza e volta à tela de baixo; a tecla Escape faz o mesmo.
- [ ] Em 390 px, com a emulação de toque do DevTools, arrasto a partir da borda esquerda: volta. Em 1280 px, anotar no registro se o arrasto pela borda funciona no conteúdo centrado, que fica numa coluna de 640 px.
- [ ] Movimento reduzido ligado no sistema: abrir e voltar sem deslize, nas duas larguras. Capturas em `~/Workspace/evidencias/feat/ui-tokens-motion/web/`.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.
- `node apps/app/test/stackMotion.test.js` e `node apps/app/test/stackEntries.test.js`, um arquivo por vez. Cobrem os planos de movimento, a regra de borda e a lista de telas, mas não o toque, o deslize nem a animação de verdade: só a caminhada mostra isso.

Limites desta caminhada:

- O bloqueio de um segundo Voltar dura até o fim do deslize mais 100 ms, para que a pilha nunca fique presa se a animação não avisar o próprio fim. Se um passo mostrar uma tela presa, anotar o caminho que levou a ela.
- Não há medida de quadros por segundo nem de desempenho do deslize nesta caminhada.
- O gesto de borda vale só para o app: o Safari do iOS e o navegador do Android têm gestos próprios, e a caminhada registra o que cada um faz, sem tratá-los como erro do app.
- Nenhuma caixa acima foi executada nesta documentação.

## 100. Conversas numa lista só (PR feat/conversas-inbox)

Roteiro da aba Conversas como uma lista só no nó hospedado: busca, filtros, fixados, linhas, Pedidos de mensagem, Nova conversa, Comunidades, carga parcial e a volta pela notificação, nas três plataformas, nos dois temas, com texto grande e movimento reduzido. O comportamento descrito está em [app.md](app.md), seção "Conversas". Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e a captura, ou o registro, fica guardado.

Regras que os passos conferem:

- A lista traz as conversas privadas e os grupos das comunidades da pessoa, do mais recente para o mais antigo. O cabeçalho tem **+** (Nova conversa), ⓘ (ajuda) e o sino de Avisos.
- **Buscar conversas** fica acima dos filtros, filtra as linhas carregadas, e o X limpa. Com texto na busca, os fixados somem, e o filtro escolhido continua valendo.
- Os filtros são **Todas**, **Não lidas** e **Grupos**.
- Fixados no topo: **Pedidos de mensagem**, com um ponto quando há pedido não lido (nunca um número; em **Não lidas**, só quando há pedido não lido), e **Comunidades**, com uma seta.
- Cada linha tem avatar (pessoa redonda; grupo e comunidade em quadrado arredondado com iniciais), nome, prévia de uma linha ("Você:" à parte na própria última mensagem; em grupo, "Autor: texto"), hora relativa e um ponto (conversa privada) ou contador (grupo) na cor de destaque. Não há marcas de lido, de entrega nem de digitação.
- **Pedidos de mensagem** é uma tela empilhada: entra deslizando, e a borda e o Voltar a fecham. Uma nota no topo diz que, até aceitar, quem enviou não sabe se você leu. Aceitar, Recusar e Bloquear ficam na conversa.
- **+** abre Nova conversa: busca de pessoa pelo nome; **Novo grupo** abre Comunidades; **Nova comunidade** cria uma comunidade; com a busca vazia, **Conversas recentes** mostra até 8 pessoas.
- **Comunidades** é uma tela empilhada que volta para Conversas, com grupos públicos, criação de comunidade e as minhas comunidades, com avatares quadrados.
- A carga parcial mostra "Algumas conversas ainda não carregaram." com **tentar de novo**, distinto de "Nenhuma conversa ainda".
- Tocar numa notificação volta para a lista inteira, com o filtro Todas e a busca limpa.

Android (AVD `varanda-api36`, build de debug, primeiro):

- [ ] Lista em tema claro e em tema escuro: ordem do mais recente, avatar redondo para pessoa e quadrado para grupo, prévia com "Você:" e "Autor: texto", hora, ponto ou contador.
- [ ] Busca: o campo filtra as linhas e o X limpa. Com texto na busca, os fixados somem e o filtro escolhido continua valendo.
- [ ] Filtros Todas, Não lidas e Grupos. Em Não lidas, Pedidos de mensagem só aparece com pedido não lido.
- [ ] Pedidos de mensagem: ponto, nunca número. Abre como tela empilhada, que volta pela borda e pelo Voltar. Nota no topo. Aceitar, Recusar e Bloquear na conversa.
- [ ] **+** abre Nova conversa: busca por nome, Novo grupo abre Comunidades, Nova comunidade, e Conversas recentes com a busca vazia.
- [ ] Comunidades: volta para Conversas, mostra grupos públicos, cria comunidade e lista as minhas comunidades com avatares quadrados.
- [ ] Carga parcial: "Algumas conversas ainda não carregaram." com tentar de novo, distinto do vazio "Nenhuma conversa ainda".
- [ ] Notificação: a lista volta com o filtro Todas e a busca limpa.
- [ ] Texto grande e movimento reduzido: nenhum texto cortado, sobreposto ou escondido, e nenhum alvo de toque menor que 44 pt. Capturas fora do git, uma pasta por plataforma.

iOS (simulador iPhone 16e, depois do Android):

- [ ] Os mesmos passos do Android, em tema claro e em tema escuro.
- [ ] Texto grande e movimento reduzido, com a mesma conferência de corte, sobreposição e alvo de toque do Android.
- [ ] Pedidos de mensagem e Comunidades, abertos e voltados pela borda esquerda: o gesto do próprio sistema, que começa na borda do simulador, não disputa com o do app.

Web (Chrome, depois do iOS):

- [ ] Em 390 px e em 1280 px, nos temas claro e escuro: lista, filtros, busca, Pedidos de mensagem, Nova conversa e Comunidades aparecem como descrito acima.
- [ ] Em 390 px: Pedidos de mensagem e Comunidades abrem deslizando e voltam pelo Voltar do navegador.
- [ ] Texto grande e movimento reduzido, nas duas larguras, sem corte nem sobreposição.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.

Limites desta caminhada:

- Na Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), as conversas são dados de exemplo. Envio, aceite de pedido e busca com conversas reais só se conferem no laboratório hospedado, com duas pessoas, como na seção 94.
- Nenhuma caixa acima foi executada nesta documentação.

## 101. Balões, respostas e cabeçalhos das conversas (PR feat/chat-bubbles-replies)

Roteiro das conversas privadas (Mensagem) e dos grupos (Grupo) com balões, respostas, cabeçalhos, campo de escrever compartilhado e emojis, nas três plataformas, nos dois temas, com texto grande e movimento reduzido. O comportamento descrito está em [app.md](app.md), seção "Conversa". Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e a captura, ou o registro, fica guardado.

Regras que os passos conferem:

- Conversa privada: o cabeçalho mostra o avatar, o nome e o @nome, e tocar neles abre o perfil. Um só ícone, **opções da conversa**, reúne bloquear, apagar e denunciar.
- Balões: as suas à direita, na cor de destaque suave, e as da outra pessoa à esquerda, sobre a cor de cartão. A última mensagem de cada sequência tem cauda; a hora fica dentro do balão, embaixo à direita; os marcadores de dia ficam centralizados.
- **Enviada** aparece só enquanto um envio está retido ou incerto.
- Toque longo abre **Responder**, **Copiar** e **Denunciar**. Na web, com mouse ou teclado, uma seta pequena no canto do balão abre as mesmas ações.
- A citação de uma resposta mostra "Você" ou o nome de quem escreveu a mensagem citada, e nenhum nome enquanto a mensagem citada não está carregada.
- Campo de escrever: campo arredondado, botão de emoji, sugestões de @ (só na conta hospedada e online), botão de enviar redondo, que só aparece com texto, e barra de resposta com **Cancelar**. A caixa fica acima da área inferior do celular.
- Menções tocadas abrem o perfil.
- Pedidos de mensagem e conversa bloqueada seguem como antes.
- Grupo: o cabeçalho mostra o nome e "N membros", e um só ícone de ajustes do grupo, que não aparece quando a pessoa age como página. A comunidade aparece como uma linha pequena e tocável abaixo do cabeçalho.
- Comunidade: o cabeçalho mostra o avatar quadrado, o nome e "N membros", com os ícones de compartilhar e de informações; tocar no nome também abre Informações. Informações da comunidade usa o mesmo cabeçalho.
- Grupo: cada pessoa forma as suas sequências. Na primeira mensagem de uma sequência de outra pessoa aparece o nome, numa cor fixa para cada pessoa; o avatar fica ao lado da última.
- Grupo: toque longo abre **Responder**, **Copiar**, **Esconder** ou **Mostrar**, **Banir** e **Denunciar**, conforme as permissões de cada um. Responder não aparece quando a pessoa age como página.
- Grupo: uma resposta real mostra a citação na nova bolha. Tocar na citação rola até a mensagem original, quando ela está carregada, e a resposta continua aparecendo depois de recarregar.
- Grupo: o painel da página aparece uma vez, sob o cabeçalho.
- Nenhuma tela mostra **lida**, **entregue** ou **digitando**, nas conversas privadas nem nos grupos.

Android (AVD `varanda-api36`, build de debug, primeiro):

- [ ] Conversa privada e grupo em tema claro e em tema escuro: balões, caudas, hora dentro do balão, marcadores de dia, nome por pessoa no grupo e avatar ao lado da última.
- [ ] Toque longo abre as ações de cada tela, sem botão **⋯** em cada linha: Responder, Copiar e Denunciar na conversa privada; Responder, Copiar, Esconder ou Mostrar, Banir e Denunciar no grupo, conforme as permissões.
- [ ] Resposta real num grupo: a citação aparece na nova bolha, tocar nela rola até a original quando ela está carregada, e a resposta continua depois de recarregar o app.
- [ ] Campo de escrever: emoji, sugestões de @ com conta hospedada e online, enviar redondo só com texto, Cancelar na barra de resposta, e a caixa acima da área inferior do celular.
- [ ] Cabeçalhos: a conversa privada abre o perfil ao tocar; o grupo mostra "N membros", os ajustes do grupo (ausentes quando a pessoa age como página) e a linha da comunidade.
- [ ] Comunidade: compartilhar e informações abrem pelos ícones do cabeçalho; a lista de grupos mostra a última linha e o contador de novas.
- [ ] Menções tocadas abrem o perfil. Pedidos de mensagem e conversa bloqueada seguem como antes.
- [ ] Nenhuma tela mostra lida, entregue ou digitando.
- [ ] Texto grande e movimento reduzido: nenhum texto cortado, sobreposto ou escondido, e nenhum alvo de toque menor que 44 pt. Capturas fora do git, uma pasta por plataforma.

iOS (simulador iPhone 16e, depois do Android):

- [ ] Os mesmos passos do Android, em tema claro e em tema escuro.
- [ ] Texto grande e movimento reduzido, com a mesma conferência de corte, sobreposição e alvo de toque do Android.
- [ ] A caixa de escrever fica acima da área inferior do aparelho, e o gesto de borda do sistema não disputa com o do app ao voltar de uma conversa.

Web (Chrome, depois do iOS):

- [ ] Em 390 px e em 1280 px, nos temas claro e escuro: os passos acima de balões, respostas, cabeçalhos e campo de escrever.
- [ ] Em 390 px e em 1280 px, com mouse ou teclado, a seta no canto do balão abre as mesmas ações do toque longo.
- [ ] Texto grande e movimento reduzido, nas duas larguras, sem corte nem sobreposição.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.

Limites desta caminhada:

- Na Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), as conversas e os grupos são dados de exemplo. Envio, resposta real e menção com conversas reais só se conferem no laboratório hospedado, com duas pessoas, como na seção 94.
- Nenhuma caixa acima foi executada nesta documentação.

## 102. Menções de pessoas e Páginas nas conversas (PR feat/chat-mentions-pages)

Roteiro das menções nas conversas privadas (Mensagem), nos grupos (Grupo) e em Publicar: sugestões de @ com pessoas e Páginas, e toque numa menção nas bolhas. O comportamento descrito está em [app.md](app.md), seções "Conversa" e "Grupo". Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e a captura, ou o registro, fica guardado.

Regras que os passos conferem:

- Sugestões de @: a partir de 2 caracteres, só na conta hospedada e online, na conversa privada, no grupo e em Publicar. Pessoas e Páginas aparecem juntas; uma Página tem o chip "Página", e pessoas vêm antes quando os dois casam igualmente.
- Página encerrada ou movida não aparece nas sugestões.
- Escolher uma sugestão só escreve o @nome no texto. Nenhuma tela abre.
- Um @nome tocado numa bolha de conversa privada ou de grupo abre o perfil da pessoa ou o diário da Página, na mesma tela de Membro. Nas publicações, o toque segue como antes.
- Menções em conversas não criam tipo novo de aviso: Avisos não ganha linha nova por causa delas.

Android (AVD `varanda-api36`, build de debug, primeiro):

- [ ] Conversa privada: um @ seguido de duas letras mostra pessoas e Páginas; escolher uma sugestão só escreve o @nome, e a mensagem enviada mostra a menção tocável.
- [ ] Conversa privada: tocar a menção de uma pessoa abre o perfil dela; tocar a de uma Página abre o diário da Página.
- [ ] Grupo: a mesma sugestão e o mesmo toque na bolha; cada toque abre o perfil ou o diário certo.
- [ ] Publicar: a sugestão com o chip "Página" aparece, e a publicação enviada mostra a menção tocável.
- [ ] Página encerrada ou movida não aparece nas sugestões das três telas.
- [ ] Escolher uma sugestão não abre nenhuma tela, nas três telas.
- [ ] Tema claro e tema escuro: chip, lista de sugestões e menções legíveis, sem texto cortado.
- [ ] Avisos não ganha linha nova por causa das menções em conversa.

iOS (simulador iPhone 16e, depois do Android):

- [ ] Os mesmos passos do Android, em tema claro e em tema escuro, incluindo a lista de sugestões sobre a caixa de escrever.

Web (Chrome, depois do iOS):

- [ ] Em 390 px e em 1280 px, nos temas claro e escuro: os passos acima de sugestões, chip "Página" e toque nas bolhas e em Publicar.
- [ ] Em 390 px e em 1280 px, com mouse ou teclado: escolher uma sugestão não navega, e o toque abre o perfil ou o diário certo.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.

Limites desta caminhada:

- O selo "Página" e o filtro de Páginas encerradas ou movidas dependem das marcas que o semeador manda na busca; um semeador antigo, sem essas marcas, mostra a Página como pessoa e não a filtra.
- As sugestões dependem de conta hospedada e online, e o toque em menção, de conta hospedada. Fora disso o @nome segue como texto.
- Nenhuma caixa acima foi executada nesta documentação.

## 103. Menu "mais", prévias nos Avisos e Busca ao digitar (PR feat/feed-polish)

Roteiro da barra de ações das publicações (A Rua, Diário, Conversa, Espiadinha e resultados da Busca), das folhas Republicar e "mais", da nota de números e do espaço do botão Publicar, da pílula "ver novidades", das linhas e prévias dos Avisos, da Busca ao digitar e da foto em Publicar. O comportamento descrito está em [app.md](app.md), seções "Telas", "Interações da Rua" e "Perfil fixo, Avisos, Mensagens e Publicar". Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e a captura, ou o registro, fica guardado.

Regras que os passos conferem:

- Barra de ações: responder, republicar, curtir e "mais" (⋯). Sem lápis, bandeira ou lixeira na barra. O toque duplo para curtir continua valendo no app nativo.
- Republicar abre a folha "Republicar" (ou "Desfazer republicação", quando já republicou) e "Citar". Sem rede, a folha traz só "Citar".
- O número de citações não aparece mais na barra (Citar está na folha); o número de republicações não soma citações, para bater com a lista de quem republicou. O leitor de tela anuncia o botão como "republicar ou citar".
- Na web, os campos arredondados (Busca, a pesquisa de Conversas, Nova conversa e o campo de escrever das conversas) mostram o foco com a borda da pílula na cor de destaque, sem o contorno retangular do navegador. Busca: Enter ou "pesquisar" sempre pesquisa de novo (depois de uma falha, é assim que se tenta outra vez); trocar para Contas cancela a pesquisa de Publicações que esperava a pausa; o teclado não corrige nem põe maiúscula no termo.
- "Mais" abre "Copiar link" (só quando a publicação tem link público), "Denunciar" (publicações de outros, com a conta conectada) e "Apagar" (publicações próprias, em vermelho, com a confirmação de sempre).
- "Compartilhar" só aparece quando a publicação tem link público. Hoje nenhuma publicação tem, então o botão não aparece.
- A Rua: "Alguns números podem estar incompletos." é uma nota pequena e suave, não uma linha; a lista deixa espaço para o botão de publicar não cobrir as ações da última publicação; "ver novidades" nunca aparece sobre o estado vazio.
- Avisos: cada linha tem o selo de ação no avatar, o nome e a ação numa linha, o @nome verificado na linha suave (quando existe) e, numa linha própria, o começo da publicação entre aspas (até 90 caracteres, em outra cor; nunca no lugar do @nome; sem prévia nas linhas de quem começou a seguir), o tempo à direita e um ponto nas linhas não lidas. As prévias vêm do próprio diário no nó; nada é buscado de fora.
- Busca: campo arredondado com lupa e X. Publicações pesquisa enquanto a pessoa digita (a partir de 2 caracteres, depois de uma pausa curta; respostas antigas são ignoradas) e ao tocar em enter ou em "pesquisar". Contas já pesquisava enquanto digitava.
- Publicar: o botão de foto segue a capacidade (seletor de fotos e mídia do nó). Na Vitrine o nó não oferece mídia, então o botão não aparece.

Android (AVD `varanda-api36`, build de debug, primeiro):

- [ ] Barra de ações em A Rua, Diário, Conversa, Espiadinha e Busca: responder, republicar, curtir e "mais"; nenhum lápis, bandeira ou lixeira na barra.
- [ ] Toque duplo curte e nunca descurte, como antes.
- [ ] Republicar abre a folha "Republicar" e "Citar"; "Desfazer republicação" aparece depois de republicar; sem rede, só "Citar".
- [ ] "Mais" em publicação de outra pessoa mostra "Denunciar"; em publicação própria mostra "Apagar", que pede a confirmação e apaga; "Copiar link" não aparece sem link público.
- [ ] A Rua: a nota "Alguns números podem estar incompletos." aparece como rodapé pequeno, não como linha; ao rolar até o fim, o botão de publicar não cobre as ações da última publicação; "ver novidades" não aparece sobre o estado vazio.
- [ ] Avisos: selo, nome e ação numa linha; o @nome verificado embaixo; a prévia entre aspas numa linha própria, até 90 caracteres; uma menção cujo texto é só "@outra_pessoa" não aparece no lugar do @nome; tempo à direita; ponto só nas linhas não lidas.
- [ ] Busca: campo arredondado com lupa; digitar em Publicações pesquisa depois de 2 caracteres e uma pausa; o X limpa o campo e a pesquisa; Contas continua pesquisando enquanto digita.
- [ ] Publicar: em conta hospedada num build nativo, o seletor de fotos abre e a foto é enviada. Este passo fica aberto: o login com passkey em build de debug está bloqueado (veja `docs/design-review.md`).
- [ ] Tema claro e tema escuro: selos, prévias, folhas e campo de busca legíveis, sem texto cortado.
- [ ] Fonte grande: folhas, linhas dos Avisos e barra de ações sem corte.
- [ ] TalkBack e VoiceOver numa linha dos Avisos: leem a ação, o @nome, a prévia entre aspas e "não lido" nas linhas não lidas.
- [ ] Na web, focar a Busca, a pesquisa de Conversas, Nova conversa e o campo de uma conversa: borda da pílula na cor de destaque, sem contorno azul retangular; Tab pelo teclado mostra onde está o foco.

iOS (simulador iPhone 16e, depois do Android):

- [ ] Os mesmos passos do Android, em tema claro e em tema escuro, e com fonte grande.

Web (Chrome, depois do iOS):

- [ ] Em 390 px e em 1280 px, nos temas claro e escuro: barra de ações, folhas Republicar e "Mais", nota de números, espaço do botão Publicar, pílula "ver novidades", linhas e prévias dos Avisos, e Busca digitando e limpando.

Como verificar, antes da caminhada, a partir da raiz:

- `npm run lint`, que tem de passar.

Limites desta caminhada:

- A Vitrine não tem mídia, então a foto de Publicar só se confere com conta hospedada em build nativo.
- "Compartilhar" fica sem efeito visível até existirem links públicos de publicação (próximo passo).
- Nenhuma caixa acima foi executada nesta documentação.

## 104. Blobs anônimos das conversas: selos, canal, conjunto e rota `/blob` (PR feat/blob-channel)

Roteiro do canal de mídia das mensagens diretas no semeador: o tipo de selo `blob`, o canal `'varanda/blob/1'`, o conjunto em `<dados>/blobs/` e a rota `GET|HEAD /blob/<id>/<índice>`. O formato está em [protocol.md](protocol.md), seção 13, e o tipo de selo na seção 11. O app passou a usar este canal nas seções 107 e 108. Nada abaixo foi executado nesta documentação: as caixas só são marcadas depois que o passo roda e o registro fica guardado.

Regras que os passos conferem:

- Quadro `VBL1` de 33137 bytes (token aleatório de selo e `check` de conteúdo, sem salt); os selos de blob são comprados antes, numa carteira de 300 (reabastecida abaixo de 150) no link identificado, e gastos depois no link anônimo; o selo de blob tem chave, `kid`, domínio FDH e limite diário (1024 por diário e por dia de Brasília) próprios, à parte dos de mensagem; um selo de um tipo nunca paga o outro.
- O conjunto guarda um blob por 7 dias a partir do primeiro pedaço (sem renovar), varre o incompleto em 1 hora, conta os pedaços guardados contra o teto de bytes (`--blob-bytes`, padrão 2 GiB, sem reserva adiantada) e responde `cheio` ao pedaço que passaria do teto, sem escrever nada e sem gastar o selo.
- `GET /blob/<id>/<índice>` não tem autenticação, cookie nem registro: só blobs completos, o mesmo 404 `não encontrado` (`no-store`) para qualquer falha e para qualquer query string, 200 com o quadro guardado e `Cache-Control: private, max-age=604800`.
- O Caddy repassa `/blob/*` como `/media/*` (Host reescrito, `X-Forwarded-For` e `X-Real-Ip` removidos, sem registro de acesso, zona `blob` de 300 requisições a cada 10 s por cliente) e continua sem repassar `/moderation-post/` nem `/moderation-group-post/`.
- `seed --no-dm` desliga o selo de blob, o canal e a rota.

Passos manuais, num semeador de teste (nunca na DHT pública; use `127.0.0.1` e a DHT local):

- [ ] `GET /blob/<id>/0` de um blob completo, sem cookie nem cabeçalho de autenticação, responde 200 com 33137 bytes, `application/octet-stream`, `nosniff`, `private, max-age=604800` e `Accept-Ranges: none`. Um `HEAD` traz os mesmos cabeçalhos e nenhum corpo.
- [ ] O mesmo caminho com `?` (mesmo vazio), um id desconhecido, um blob incompleto, um índice igual ao `count` e um id com maiúsculas dão o mesmo 404 `não encontrado` com `Cache-Control: no-store`. Um `POST` dá 405 com `Allow: GET, HEAD`.
- [ ] Pelo Caddy de verdade (`deploy/seeder/Caddyfile`): `/blob/*` chega ao semeador sem `X-Forwarded-For` nem `X-Real-Ip`; a 301ª requisição de um mesmo cliente em 10 s volta 429 com `Retry-After`; o Caddy não tem diretiva `log` de acesso.
- [ ] Pelo Caddy: `/moderation-post/...` e `/moderation-group-post/...` continuam não repassados (caem no app, não no semeador). `node apps/cli/test/caddyfile.test.js` passa.
- [ ] Um semeador com `seed --no-dm` responde 404 em `/blob/...` e o membro vê o canal e o tipo de selo como não suportados.
- [ ] Um `put` de um quadro novo recebe `ack` com `ok` verdadeiro; o mesmo quadro de novo também (repetido); outro quadro com o mesmo `(id, índice)` recebe `invalido`; com o conjunto no teto (`--blob-bytes` mínimo), o próximo pedaço recebe `cheio` e nada é escrito em `blobs/`.
- [ ] Um selo de mensagem usado como selo de pedaço recebe `invalido`, e um pedido de selo `blob` não gasta a cota de mensagens (conferir `blob-stamps.json` e `dm-stamps.json`).
- [ ] Com a carteira de selos de blob cheia, mandar uma mídia não emite nenhum selo durante o envio (observar o link de selos do semeador); com a carteira curta para o envio, uma compra de selos acontece primeiro, antes do primeiro `put`.
- [ ] Toda linha de registro ligada a blob traz só um evento fixo e um motivo ou uma contagem (`blob` com `completo`, `cheio`, `invalido` ou `postage`; `blob-stamp`; `peer-dropped`; `blob-put-failed`; `blob-pool-torn`, `-broken`, `-remove-failed` e `-sweep-failed`; `dm-stamp` com `blob-postage`), nunca id, token, chave, endereço nem diário.
- [ ] Um anexo grande baixa sem 429 nem 503 em velocidade normal, e um 503 do semeador é repetido depois do seu `Retry-After` (no máximo 3 repetições; um 404 falha na hora).
- [ ] Depois de 7 dias (ou com o relógio de teste adiantado), o blob some e o `GET` dá 404; os resumos dos selos usados seguem em `blobs/tokens.json` até 14 dias.
- [ ] Uma nova tentativa depois de uma pausa longa (mais de uma hora) reenvia a mídia e ela abre para o destinatário.
- [ ] Rotacionar a chave de selo de blob do semeador com a carteira cheia: o envio seguinte funciona, sem erros.
- [ ] O primeiro envio de um item de tamanho máximo, a partir de uma carteira vazia e numa conexão lenta, termina.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node packages/core/test/blob.test.js`, `blob-net.test.js`, `blob-pool.test.js`, `node apps/cli/test/blob-seeder.test.js` e `node apps/cli/test/caddyfile.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- O app envia e mostra mídia por este canal (veja as seções 107 e 108); esta caminhada exercita só o semeador.
- O horário e a leitura repetida do mesmo id continuam visíveis ao semeador (protocol.md, seção 13, "Privacidade"); isto não é resistência à análise de tráfego.
- Nenhuma caixa acima foi executada nesta documentação.

## 105. Mídia nas mensagens privadas e anexo nas denúncias (PR feat/dm-media-protocol)

Roteiro do protocolo e do nó para fotos e GIFs em mensagens privadas (corpo interno v2), do cache local cifrado no nó do navegador, da leitura de mídia pelas Páginas e do anexo de imagem nas denúncias de conversa. Ainda não há tela: o app recebe estas peças num PR posterior. O comportamento está em [protocol.md](protocol.md), seções 3, 11 ("Inner v2", "Local storage", "Reports") e 12, e em [rpc.md](rpc.md), 5.20, 5.75, 5.77, 5.78, 5.81 e 5.88. Nada abaixo foi executado nesta documentação.

Regras que os passos conferem:

- Uma mensagem só de texto continua no corpo v1, byte por byte; uma mensagem com mídia vai no v2 (um conjunto exato de chaves, prefixo de assinatura próprio), com 1 a 4 itens de ids distintos, texto vazio só com mídia, e o texto que cabe diminui a cada item.
- As chaves de mídia chegam só à interface dona da conversa, em `dm.thread`; nenhum evento, registro ou outro aparelho as recebe. O cache de mídia aberta fica cifrado sob a chave local, até 256 MiB (o mais antigo sai primeiro), e é apagado ao bloquear, ao sair e ao zerar.
- Numa conversa da pasta de pedidos, nada é baixado sozinho: a mídia só desce num toque (leitura explícita) ou depois de aceitar; no máximo 2 aberturas ao mesmo tempo.
- O envio sobe todos os pedaços antes de mandar a mensagem; uma falha de envio de mídia é um erro comum, nunca incerto, e nada é repetido sozinho.
- A Página guarda e devolve aos administradores os itens recebidos, nunca busca o blob, e responde só em texto.
- A denúncia com anexo usa a declaração v2 (conversa) ou v3 (grupo), com o resumo da imagem; a rota `POST /account/report/anexo` aceita JPEG, WebP ou GIF até 1 MiB (2 MiB recebe 413), confere o resumo, guarda o arquivo com modo 0600, e a denúncia vai sempre para uma pessoa; o painel mostra "com mídia" e "imagem enviada por quem denunciou, não conferida".

Passos (marcar só depois de executar e guardar o registro):

- [ ] Dois membros no laboratório hospedado: mandar uma foto com legenda e uma só foto; as duas chegam, `dm.thread` traz os itens com a chave, e nenhum evento `dm.changed` carrega item.
- [ ] Esvaziar o conjunto de blobs do semeador depois de abrir a foto: ela continua abrindo pelo cache; uma foto nunca aberta passa a `{ unavailable: true }` e o texto continua.
- [ ] Bloquear a identidade e desbloquear: o cache de mídia foi apagado e a foto abre de novo pelo semeador (se ainda estiver lá).
- [ ] Uma pessoa desconhecida manda várias fotos: abrir o pedido não baixa nada (observar `/blob` no semeador); um toque baixa só aquela; aceitar a conversa abre as outras, no máximo 2 por vez.
- [ ] Uma mensagem com mídia para uma Página aparece aos administradores com os itens, e a resposta da Página sai em texto (corpo v1).
- [ ] Uma denúncia de conversa com anexo chega ao painel com "com mídia", a imagem abre só com a sessão de moderador, e um anexo de 2 MiB recebe 413; uma denúncia v1 antiga ainda confere.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node packages/core/test/dm.test.js`, `dm-fold.test.js` e `report.test.js`; `node packages/rpc/test/dm-budget.test.js`, `methods.test.js` e `sizes.test.js`; `node packages/web-member/test/dm.test.js`, `dm-store.test.js`, `dm-e2e.test.js` e `blob.test.js`; `node apps/cli/test/pages-dm.test.js`, `dm-report.test.js`, `moderation-store.test.js`, `account-mod.test.js` e `panel.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- O app anexa e mostra mídia nas mensagens (veja a seção 107); esta caminhada exercita só o nó, o semeador e a RPC.
- A rota de anexo tem 4 vagas globais que corpos lentos e anônimos podem ocupar até o tempo limite de 10 s; se a autorização assinada nos cabeçalhos, antes de ler o corpo, já vale, esta caminhada não confere.
- Nenhuma caixa acima foi executada nesta documentação.

## 106. Fotos nos grupos públicos e privados: protocolo, nó e RPC (PR feat/group-media-protocol)

Roteiro do protocolo, do nó e da RPC para fotos e GIFs nos grupos, públicos e privados (registro de publicação v2 de grupo). O formato está em [protocol.md](protocol.md), seção 10 ("Group post media" e "Old readers"), e os métodos em [rpc.md](rpc.md), 5.39 (`group.post`), 5.40 (`group.read`) e 5.56 (`media.uploadFile`). Ainda não há tela: o app que mostra e envia fotos de grupo vem num PR posterior (`feat/chat-photos-gifs`), e a versão legal dos Termos não muda neste PR. Nada abaixo foi executado nesta documentação.

Regras que os passos conferem:

- Uma publicação de grupo só de texto continua no registro v1, byte por byte. Com mídia, vai no registro v2 (o conjunto exato de chaves `type`, `text`, `replyTo`, `media`, `card`, `fwd`, `seen`, `at`), com 1 a 4 itens de `(core, start)` distintos, `card` sempre `null` e `fwd` sempre `0`; o texto pode ser vazio só quando há mídia.
- Um leitor antigo pula o registro v2 inteiro, sem cair no texto: nada aparece como texto solto e o fold não falha.
- Grupo público: os itens são descritores de publicação comuns, e os bytes ficam no núcleo de mídia do autor, servidos em `/media` como as fotos do diário.
- Grupo privado: cada foto é selada no aparelho (secretbox, chave e nonce novos, preenchida até blocos inteiros de 32 KiB), e só o cifrado vai ao núcleo de mídia do autor. A chave viaja só dentro da publicação selada pelo grupo. O semeador guarda e serve só o cifrado.
- `group.read` devolve `media` em cada item (`null` em registro v1 e em publicação oculta); a mídia de uma publicação oculta não sai.
- `GROUP_LIMIT_MAX` e `GROUP_LIMIT_DEFAULT` valem 29: a página mais pesada de `group.read` (quatro itens privados por publicação) cabe em `MAX_MESSAGE`.
- A CLI (nó core) recusa mídia em `group.post` com `mídia disponível só na versão web`. No navegador, mídia cifrada só vai a grupo privado (`mídia cifrada só em grupo privado`), e grupo privado exige mídia cifrada (`grupo privado exige mídia cifrada`).
- Na lista de comunidades, a última publicação só com foto aparece como `Foto` (ou `GIF`).
- `media.readGroup` busca o cifrado na origem do semeador do próprio nó (rota `/media`, `no-store`, sem cookies e sem redirecionamentos) e abre a imagem; qualquer falha vira `mídia indisponível`, e um bloqueio durante o download é recusado.
- A CLI imprime ` [foto]` ou ` [gif]` depois do texto e nunca imprime chave nem nonce de item privado, nem no `--json`.
- As Páginas continuam gravando publicações de texto e leem registros v2.

Passos (marcar só depois de executar e guardar o registro):

- [ ] Num grupo público do laboratório hospedado (dois perfis do Chrome, `apps/cli/scripts/hosted-lab.js`), postar uma foto pelo console da fachada do nó e ler de volta: a publicação traz um item com `core`, `start`, `sha256` e as dimensões, e a foto abre pela `/media` do semeador.
- [ ] Num grupo público cuja última publicação é só uma foto, a lista de comunidades mostra `Foto`; com um GIF, mostra `GIF`.
- [ ] Num grupo privado, postar uma foto: o `group.post` vai com `sealed: true`, e a publicação aparece para o outro membro com a foto aberta por `media.readGroup`.
- [ ] Pela rota `/media` do semeador, o item de um grupo privado não começa com a assinatura de JPEG (`FF D8 FF`) nem de PNG (`89 50 4E 47`): são bytes cifrados.
- [ ] Na aba Rede do DevTools, o pedido de `media.readGroup` vai só à origem do semeador do próprio nó, sem cookie, sem usar o cache do navegador (`no-store`) e sem seguir redirecionamento.
- [ ] Com o nó bloqueado durante o download de uma foto privada, `media.readGroup` recusa, e a foto não aparece depois do desbloqueio sem novo pedido.
- [ ] Um nó do `main` anterior a este PR lê o grupo: a publicação com foto some sem erro, e as publicações só de texto aparecem como antes.
- [ ] Uma publicação só de texto escrita por este PR tem o mesmo registro v1 do `main` (comparar os bytes do bloco).
- [ ] Uma publicação com foto oculta: `group.read` devolve `media: null` para ela, e o texto oculto segue como antes.
- [ ] Uma página de `group.read` com 29 publicações de quatro fotos privadas cabe no limite de mensagem; o teste de tamanho confirma e uma página real também sobe.
- [ ] `varanda group read` mostra ` [foto]` depois do texto de uma publicação com foto; `varanda group read --json` não contém `key` nem `nonce` de item privado (conferir com `grep`).
- [ ] O comando de publicar em grupo da CLI recusa uma imagem com `mídia disponível só na versão web` e não grava nenhum registro.
- [ ] Uma Página que participa de um grupo lê uma publicação v2 e continua publicando só texto.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node packages/core/test/group-crypto.test.js`, `group-media.test.js`, `group.test.js` e `session-groups.test.js`.
- `node packages/rpc/test/methods.test.js` e `sizes.test.js`.
- `node packages/web-member/test/group-ops.test.js`, `groups-e2e.test.js`, `private-ops.test.js` e `node-bundle.test.js` (exigem Node 20.19 ou mais novo).
- `node apps/cli/test/group-commands.test.js`, `pages-groups.test.js` e `node apps/app/test/identityInstall.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- O app mostra e envia foto de grupo (veja a seção 107); esta caminhada exercita só o nó, o protocolo, a RPC e os testes.
- O semeador continua vendo o horário, o tamanho aproximado (em faixas de 32 KiB) e a leitura repetida de cada item privado; isto não é resistência à análise de tráfego.
- Nenhuma caixa acima foi executada nesta documentação.

## 107. Fotos e GIFs nas conversas e nos grupos, no app (PR feat/chat-photos-gifs)

Caminhada do app para enviar e ver fotos e GIFs em mensagens diretas e em grupos, públicos e privados, e para a denúncia com imagem. O protocolo e o nó estão nas seções 104, 105 e 106; a tela está em [app.md](app.md) ("Fotos e GIFs", "Nas conversas"). Os Termos de Uso e a Política de Privacidade passam à versão 17 para descrever isso, então quem já aceitou a 16 vê o aceite de novo.

Regras que os passos conferem:

- O clipe do compositor abre "Anexar" com uma só linha, "Foto" ("da galeria, até 4"). GIF por busca e áudio não aparecem, nem desabilitados.
- Até 4 imagens por mensagem, legenda opcional; nada sai do aparelho antes de tocar em enviar. Uma foto é reencodada sem EXIF nem GPS; um GIF vai como está.
- Mensagem direta: a foto sai cifrada pelo canal de blobs, sob um id aleatório, e some do semeador em 7 dias; quem abriu guarda a cópia cifrada no cache local, apagado ao bloquear a identidade, em Sair e em Recomeçar.
- Grupo público: a foto vem pela rota `/media` do semeador, como as fotos das publicações. Grupo privado: só o nó decifra; o app nunca busca o item privado por HTTP.
- Uma foto que não chega mostra "Mídia indisponível" e o texto da mensagem continua.
- Denúncia de mensagem direta ou de grupo privado com foto: a primeira imagem aparece em "Imagem que será enviada" antes do envio, como JPEG de até 700 KB; acima disso, "A imagem não coube e não foi enviada.". A denúncia de grupo público aponta para a mensagem, sem imagem.
- No app instalado, abrir uma foto depende do fetch do worklet Bare (`apps/app/worklet/bare-fetch.js`): só um build de aparelho feito depois de `npm run prepare:native -w apps/app` exercita isso.
- Os Termos e a Política estão na versão 17 (`LEGAL_VERSION` e `TERMS_VERSION` iguais) e não falam de áudio, busca de GIF, prévia de link nem encaminhamento.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho), depois no simulador iOS, depois no Chrome (web e PWA); a conversa entre duas pessoas usa o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`, dois perfis do Chrome) ou um aparelho e um perfil do Chrome:

- [ ] Num pedido de mensagem com foto (de alguém que você não segue), abrir o pedido não baixa nada: cada foto mostra "Toque para ver a foto" e a aba Rede (web) não registra nenhum pedido de mídia até o toque; depois de aceitar, as fotos abrem sozinhas.
- [ ] Android: na abertura depois da atualização, o aceite dos Termos aparece com a versão 17; aceitar e seguir.
- [ ] Android: "Anexar" mostra só "Foto"; escolher 5 imagens da galeria fica em 4; tirar uma miniatura e enviar 3 fotos com legenda numa mensagem direta; a outra pessoa vê as 3 na grade, com a legenda, e um toque abre a tela cheia.
- [ ] Android: mandar um GIF sem legenda numa mensagem direta; ele chega animado.
- [ ] Android: postar uma foto num grupo público e outra num grupo privado; as duas aparecem para o outro membro. A foto privada, lida na rota `/media` do semeador, são bytes cifrados (não começa com `FF D8 FF`).
- [ ] Android: denunciar uma mensagem direta com foto; a tela mostra "Imagem que será enviada" com a imagem, e o painel de moderação recebe a denúncia com a imagem marcada como "não conferida".
- [ ] Android: depois de abrir uma foto de mensagem direta, bloquear a identidade e desbloquear; a foto abre de novo pelo semeador (o cache local foi apagado). Em Sair, idem.
- [ ] Android: uma foto de mensagem direta com mais de 7 dias (ou com o conjunto de blobs esvaziado no laboratório), nunca aberta, mostra "Mídia indisponível".
- [ ] iOS (simulador): repetir os passos do Android acima, num build feito depois de `npm run prepare:native -w apps/app`, e anotar se a foto abre pelo fetch do worklet Bare.
- [ ] Chrome (web hospedada): repetir os passos acima; na aba Rede, a foto de grupo privado não gera pedido do app à rota `/media` fora do nó, e a foto de mensagem direta vai só a `/blob` na origem do semeador.
- [ ] Chrome (PWA instalado): enviar e abrir uma foto numa mensagem direta e num grupo; Sair apaga o cache local.
- [ ] Em todas as plataformas: a Política e os Termos abertos em Ajustes mostram "Versão 17" e não citam áudio, busca de GIF, prévia de link nem encaminhamento.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/legal.test.js`, `terms-version.test.js` e `node packages/core/test/terms.test.js`.
- `node apps/app/test/attachPlan.test.js`, `chatMedia.test.js`, `bareFetch.test.js`, `webnodeHandle.test.js`, `report.test.js`, `dm.test.js` e `group-flow.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- A abertura de foto no app instalado só é conferida num build de aparelho depois de `npm run prepare:native -w apps/app`; os testes rodam o fetch Bare isolado, não no worklet.
- Nenhuma caixa acima foi executada nesta documentação.

## 108. Mensagens de voz nas conversas (PR feat/voice-notes)

Caminhada do app para gravar, enviar e ouvir mensagens de voz em mensagens diretas e em grupos, públicos e privados, e para a denúncia com áudio. A tela está em [app.md](app.md) ("Mensagens de voz nas conversas"); o formato está em [protocol.md](protocol.md) e [rpc.md](rpc.md). Os Termos de Uso e a Política de Privacidade passam à versão 18 para descrever isso, então quem já aceitou a 17 vê o aceite de novo.

Regras que os passos conferem:

- Com o compositor vazio, o microfone ocupa o lugar do botão de enviar, só onde o aparelho ou o navegador grava `audio/mp4` (Android e iOS com `expo-audio`; Safari e Chrome recente com `MediaRecorder`). Onde não grava, não há microfone nem aviso.
- Segurar grava com o tempo correndo e "deslize para cancelar"; soltar envia. Um toque grava sem segurar, com "Parar" (envia) e "Cancelar". Aos 2:00 a gravação para e é enviada. Uma gravação por vez; a mensagem de voz vai sozinha, sem foto nem legenda.
- O microfone só é pedido quando a pessoa começa a gravar. Sem permissão: "Sem acesso ao microfone".
- Só `audio/mp4` de até 2 minutos e 1,5 MiB; um arquivo com faixa de vídeo é recusado pelos bytes, mesmo rotulado `audio/mp4`. "Anexar" continua com só "Foto", e a galeria não deixa escolher vídeo.
- Guarda como as fotos da seção 107: mensagem direta cifrada no canal de blobs por 7 dias; grupo público pela rota `/media`; grupo privado só o nó decifra. Num pedido de mensagem, nada baixa antes de "Toque para ouvir".
- Denúncia de mensagem direta ou de grupo privado com mensagem de voz: o áudio vai aberto se tiver até 700 KB, com escuta antes do envio; acima disso, "O áudio não coube e não foi enviado.". O painel mostra "áudio não conferido" e serve `audio/mp4` com `nosniff` e `no-store`.
- Os Termos e a Política estão na versão 18 (`LEGAL_VERSION` e `TERMS_VERSION` iguais) e não falam de vídeo nas conversas como recurso, busca de GIF, prévia de link nem encaminhamento.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA; a conversa entre duas pessoas usa o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`, dois perfis do navegador) ou um aparelho e um perfil do navegador:

- [ ] Android: na abertura depois da atualização, o aceite dos Termos aparece com a versão 18; aceitar e seguir.
- [ ] Android: abrir uma conversa e, antes de tocar no microfone, conferir que o sistema não pediu acesso ao microfone; o pedido aparece só ao começar a gravar. Negar mostra "Sem acesso ao microfone" e nada é enviado; permitir nas configurações e gravar de novo.
- [ ] Android: segurar o microfone, falar uns segundos e soltar numa mensagem direta; a outra pessoa recebe "Mensagem de voz", toca e pausa. Segurar e deslizar para a esquerda descarta, sem envio.
- [ ] Android: tocar no microfone sem segurar; gravar e tocar "Parar" envia; repetir e tocar "Cancelar" descarta.
- [ ] Android: gravar sem parar até 2:00; a gravação para sozinha e a mensagem chega com 2:00.
- [ ] Android: mandar uma mensagem de voz num grupo público e outra num grupo privado; as duas tocam para o outro membro. A do grupo privado, lida na rota `/media` do semeador, são bytes cifrados (não começa com uma caixa `ftyp`).
- [ ] Android: abrir "Anexar" e a galeria; um vídeo não pode ser escolhido (a galeria mostra só imagens).
- [ ] Android: denunciar uma mensagem direta com mensagem de voz curta; a tela deixa ouvir o áudio antes de enviar, e o painel de moderação mostra a denúncia com "áudio não conferido", que toca no navegador do moderador. Com uma mensagem de voz acima de 700 KB, a tela diz "O áudio não coube e não foi enviado.".
- [ ] iOS (simulador): repetir os passos do Android acima, num build feito depois de `npm run prepare:native -w apps/app`; conferir o texto do pedido de microfone do sistema.
- [ ] Safari (web hospedada, macOS e iPhone): o microfone aparece e grava; repetir envio, escuta, cancelamento e "Parar". O pedido de microfone do navegador só aparece ao começar a gravar.
- [ ] Chrome (web hospedada): numa versão que grava `audio/mp4` com `MediaRecorder`, repetir os passos; a mensagem gravada no Chrome toca no Safari e no Android, e a gravada no Safari toca no Chrome.
- [ ] Navegador sem `audio/mp4` no `MediaRecorder` (por exemplo um Firefox ou um Chrome antigo): nenhum controle de microfone aparece no compositor, nem desabilitado, nem com aviso; as mensagens de voz recebidas continuam tocando ou mostram "Mídia indisponível".
- [ ] PWA instalado (Chrome e Safari no iPhone): gravar, enviar e ouvir numa mensagem direta e num grupo; mandar o app para o segundo plano no meio de uma gravação a cancela.
- [ ] Duas pessoas no laboratório hospedado: um pedido de mensagem com mensagem de voz não baixa nada até "Toque para ouvir" (a aba Rede não registra pedido de mídia antes do toque); depois de aceitar, toca direto.
- [ ] Em todas as plataformas: a Política e os Termos abertos em Ajustes mostram "Versão 18" e descrevem a mensagem de voz de até dois minutos.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/legal.test.js`, `terms-version.test.js` e `node packages/core/test/terms.test.js`.
- `node packages/rpc/test/audio-bounds.test.js`, `node apps/app/test/voice.test.js`, `audio.test.js`, `report.test.js` e `node apps/cli/test/dm-report.test.js` (o anexo de áudio) e `panel.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- A gravação depende do aparelho e da versão do navegador: os testes rodam com gravadores falsos, não com o microfone.
- Nenhuma caixa acima foi executada nesta documentação.

## 109. Passkeys só de gerenciadores que sincronizam, caminho pelo celular (QR code) e saídas dos estados presos (PR fix/passkey-robustness)

### O que mudou

- Criar passkey: o app recusa uma passkey que não sincroniza entre aparelhos (chave USB ou NFC, Windows Hello, perfil local do navegador), porque ela ficaria presa a um aparelho e a conta perderia o acesso ao trocar de aparelho. A checagem lê a flag BE (backup eligible) dos dados de autenticação e exige que ela esteja ligada. Não há lista de gerenciadores no código: o critério é a flag. A recusa aparece como NOT_SYNCED, com o texto de `apps/app/src/passkeyOptions.js`.
- A flag vale só na criação. Entrar nunca a consulta, então uma passkey que já existe continua entrando, mesmo sem sincronização.
- Dados de autenticação ilegíveis não bloqueiam a criação: são aceitos.
- Caminho pelo celular: na criação, o navegador recebe as dicas `client-device` e `hybrid`; quando a pessoa toca "criar com o celular" ou "entrar com o celular", a dica é `hybrid`. As dicas são só orientação para o navegador e não forçam a tela do QR code. Sem gerenciador útil no computador, a página orienta a usar o celular (SYNC_ADVICE e PHONE_HINT em `apps/app/src/passkeyTrouble.js`).
- Estados presos ficam guardados:
  - na web, o registro `passkeyAttempts` (versão 1, por rpId) guarda a criação pendente (`pending`: id da credencial, id do usuário e telefone) e as passkeys recusadas (`refused`, até 32 entradas, com código e se foram limpas);
  - no nativo, o arquivo `varanda-passkey-attempts.json` na pasta de documentos do app, com o mesmo formato (`cleaned` é sempre `false`). Os códigos das recusadas são `NO_PRF`, `NOT_SYNCED`, `SUPERSEDED` (uma criação pendente trocada por outra criação ou por uma entrada com outra passkey), `INSTALL_FAILED` (a passkey nova não chegou a ser instalada) e, só no nativo, `MISSING` (o "concluir" não achou a passkey pendente). Uma recusa `NOT_SYNCED` criada aqui nunca é rebaixada por um `NO_PRF` posterior, então essa passkey nunca abre a conta.
- A criação pendente sobrevive a recarregar a página, então o "concluir" é pedido ao nó e não depende da memória da tela.
- Limpeza na web: `PublicKeyCredential.signalUnknownCredential` é chamado de melhor esforço, e só quando a própria cerimônia de criação desta carga da página recusa a passkey (NOT_SYNCED, ou NO_PRF na criação). Nunca no "concluir" (entre a criação e o "concluir" uma passkey que sincroniza pode já ter virado a conta em outro aparelho; a recusa fica guardada, sem pedido de remoção), nunca para uma criação pendente restaurada nem para a passkey conhecida. Quando o navegador aceita a chamada, a entrada sai marcada como `cleaned`, e a página mostra a linha "já pediu ao gerenciador" onde o recurso existe.
- Entrar: `unlock({ any, phone })` na web e `unlock({ any })` no nativo, para escolher outra passkey ou o celular.
- Exclusões no nativo: iOS repassa `excludeCredentials` ao módulo. No Android, a exclusão só limpa passkeys do Varanda no mesmo gerenciador, e depende de androidx.credentials 1.5.0.
- Android: `NoCredentialException` em Entrar vira o estado NONE, com o texto NONE_TEXT (`apps/app/src/passkeyTrouble.js`).
- PRF malformado conta como NO_PRF, não como erro genérico.
- Saída de passkey conhecida perdida: sair do cartão não apaga o diário deste aparelho. Se o aparelho não tem o diário, Entrar com uma passkey conhecida que não está mais no gerenciador abre um diário vazio.
- Passkeys nomeadas para apagar: o cartão só nomeia passkeys criadas nesta sessão da página que falharam agora, nunca as tiradas de `refused` guardado (uma recusa antiga pode ter virado a conta em outro aparelho ou navegador). Os nomes somem a cada entrada bem-sucedida e no "recomeçar", o cartão de navegador sem suporte não nomeia nenhuma, e o passo é condicional: "Se você não usou essa passkey para entrar em outro aparelho, apague a passkey ...".
- O texto de recuperação (SYNC_ADVICE) manda salvar a passkey num gerenciador que sincroniza, para a conta do Google ou da Apple devolvê-la num aparelho novo.

### Testes automatizados

- `packages/web-member/test/authenticator-data.test.js` (novo).
- `packages/web-member/test/passkey.test.js`.
- `packages/web-member/test/resume.test.js`.
- `packages/web-member/test/node-bundle.test.js`.
- `apps/app/test/passkeyOptions.test.js`.
- `apps/app/test/passkeyTrouble.test.js`.
- `apps/app/test/help.test.js`.
- `apps/app/test/sessionStoreNative.test.js`.

Resultados (Node 24.22.1, na raiz, sobre `origin/main@04f01a29`): `npm run lint` sem erros; `npm test` com 402 arquivos, 400 passaram de primeira; `packages/core/test/sync-delete.test.js` falhou uma vez na execução completa ("D lacks block 3 after its scan") e passou sozinho (3/3), intermitente e fora desta mudança; `apps/cli/test/ai-embedder.test.js` falha só porque o caminho desta cópia local contém "sharp" (o teste procura módulos com esse nome no caminho), igual na `main` e fora desta mudança; `npm run demo` terminou com DEMO OK. Os testes acima, um por arquivo, passaram.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Chave USB ou NFC: criar passkey é recusada com o aviso de sincronização (não realizada ainda).
- [ ] Windows Hello: criar passkey é recusada com o aviso de sincronização (não realizada ainda).
- [ ] Passkey local do perfil do Chrome num Mac: criar é recusada (não realizada ainda).
- [ ] iCloud Keychain, Google Password Manager, 1Password e Bitwarden: criar é aceito e a passkey entra depois (não realizada ainda).
- [ ] Computador sem gerenciador útil: o QR code leva a um Android e a um iPhone; criar, concluir e entrar funcionam pelo celular (não realizada ainda).
- [ ] Passkey já existente, criada num aparelho e sem sincronização, continua entrando (não realizada ainda).
- [ ] Passkey conhecida perdida: sair do cartão não apaga o diário deste aparelho (não realizada ainda).
- [ ] Recarregar a página durante "concluir": a criação pendente continua e "concluir" entra (não realizada ainda).
- [ ] Android com aparelho novo, sem passkey do Varanda: aparece NONE_TEXT (não realizada ainda).
- [ ] Onde o navegador tem `signalUnknownCredential`: após uma criação recusada, aparece a linha "já pediu ao gerenciador" (não realizada ainda).

### Limites que sobram

- A flag BE é autodeclarada pelo autenticador quando a atestação é `none`; o app não consegue provar que o gerenciador sincroniza.
- Dados de autenticação ilegíveis são aceitos, então um autenticador que não informa a flag passa na criação.
- As dicas (`client-device`, `hybrid`) são só orientação: não forçam a tela do QR code.
- No Android, a limpeza de passkeys é só exclusão, e só com androidx.credentials 1.5.0.
- No iOS nativo, o domínio associado já está no projeto (`Varanda.entitlements`); entrar com passkey numa instalação de produção depende da conta Apple Developer.
- O build de debug do Android (`app.varanda.debug`) não usa passkeys de produção.
- Entrar com uma passkey do Varanda antiga, num aparelho sem diário, ainda abre um diário vazio.
- Depois de recarregar a página, o cartão não lembra mais quais passkeys criadas aqui não serviram: a pessoa não recebe o nome para apagar. É de propósito, para nunca mandar apagar uma passkey que virou a conta em outro aparelho.
- Uma passkey recusada no "concluir" nunca recebe pedido de remoção, mesmo quando foi criada nesta carga da página: ela fica no gerenciador até a pessoa apagá-la.
- Há uma janela entre o autenticador criar a passkey e o registro local ser gravado: se a página cair nessa janela, a passkey existe no gerenciador sem registro local.
- A recusa de uma passkey presa a um aparelho (chave de segurança, Windows Hello) vale só no navegador ou na instalação que a recusou: ela sobrevive ao "recomeçar" e ao limite de 32 registros, mas em outro navegador, depois de limpar os dados do site ou depois de reinstalar o app, a mesma passkey pode entrar e abrir uma conta nova presa àquele aparelho. A entrada não lê a flag BE, por decisão do dono: passkeys que já existem continuam entrando. Por isso o cartão de passkey recusada nunca manda abrir o Varanda em outro navegador. Decisão registrada na auditoria de segurança deste PR.
- Pela mesma regra, uma chave de segurança que este navegador recusou na criação nunca entra neste navegador, mesmo que a pessoa tenha criado a conta com ela em outro computador; a conta continua acessível nos outros aparelhos.

## 110. Segunda passkey, troca e código de recuperação (PR feat/passkey-recovery)

### O que mudou

- Toda chave do membro continua vindo da raiz: o resultado PRF de 32 bytes da passkey com que a conta foi criada. Uma passkey extra ou o código de recuperação nunca deriva chave: só desembrulha essa raiz, então a identidade, os seguidores e as chaves derivadas continuam os mesmos. Não há registro novo no diário, e o nó não guarda cópia local das raízes embrulhadas.
- Passkey extra marcada: o identificador do usuário (`user.id`) é 16 bytes aleatórios seguidos de `WRAP_MARK` (`'varanda-wrap-v1\n'`, 16 bytes). Uma credencial marcada nunca é instalada direto: o PRF dela só deriva `lookupId` e `wrapKey`. Sem entrada no serviço, ela falha fechada e o nó fica bloqueado. Uma versão antiga do app, que não conhece a marca, criaria outra identidade com ela.
- Blob e código como em `docs/protocol.md` ("Web member storage (B2)"): HKDF-SHA-256 com o sal `'varanda/member-recovery/hkdf/v1'` e os rótulos `.../lookup/v1` e `.../wrap/v1` seguidos do byte do tipo (0x01 passkey, 0x02 código); texto claro de 66 bytes (versão, tipo, chave do membro, raiz) selado com `crypto_secretbox_easy`; código de 20 bytes em 36 símbolos Crockford (32 do segredo e 4 de soma de conferência, os 20 primeiros bits de BLAKE2b-256), em 9 grupos de 4.
- Entrar com uma passkey marcada busca o blob (`POST /account/recovery/fetch`), abre e instala a raiz presa a essa credencial. Entrar com uma credencial sem marca, ou que não devolveu identificador e não é a deste aparelho, instala o PRF da cerimônia direto, como antes, sem perguntar nada ao serviço: nenhum valor derivado do PRF de uma passkey comum vai ao serviço, e nenhuma resposta do serviço transforma uma passkey em outra identidade. Na busca de uma passkey marcada ou de um código, só o 404 `{ error: 'nao-encontrado', recovery: true }` quer dizer "sem entrada"; qualquer outra resposta (falha de rede, ou um 404 sem `recovery: true`, como a rota desconhecida de um servidor antigo) é o serviço indisponível, e o nó fica bloqueado nos dois casos.
- Código de recuperação: o código deriva `lookupId`, o blob é buscado e aberto, e o nó guarda a raiz por até 120 s enquanto a pessoa toca "Criar passkey nova". A raiz é instalada presa a essa passkey nova (sessão guardada normal) e embrulhada para ela, e o app a cadastra com um put assinado. O código sozinho não instala nem guarda sessão. Se o put falha, o aparelho continua ligado e conectado, e Ajustes oferece cadastrar de novo.
- Trocar a passkey deste aparelho: adiciona uma passkey marcada, cadastra e liga o aparelho a ela (`identity.recoveryBind` no worklet, `bindPasskey` no nó do navegador). A passkey original continua abrindo a conta onde existir; o Varanda não consegue invalidá-la, então a pessoa a apaga no gerenciador.
- Serviço de conta: `recovery.json` (modo 0600, arquivo à parte como o `terms.json`, fora de `directory.*`), exatamente `{ v: 1, seq, entries, removed }`, com linhas `{ member, kind, nonce, ciphertext, createdAt, gen }` e lápides `{ member, removedAt, gen }` por `lookupId`. As gerações são uma sequência única e crescente do arquivo inteiro: todo put, todo remove e toda lápide da normalização recebem `gen` = ++`seq`; a mescla fica com o maior `seq` e, por `lookupId`, com o registro de maior geração; um `gen` acima de `seq` torna o arquivo inválido. Duas linhas de código vivas depois de uma mescla: fica só a de geração estritamente maior; linhas empatadas na maior geração ficam as duas (nenhuma é mais nova, e escolher por `lookupId` poderia apagar o código confirmado), e o próximo put de código enterra as duas. Lápides vencem em 30 dias (por `removedAt`); o teto de 32 por membro tira primeiro as de menor geração, mas nunca uma lápide com menos de 10 minutos (`STALE_WINDOW_MS`) nem a mais nova do membro. Depois de uma gravação incerta, `list` e `fetch` releem e mesclam o arquivo antes de responder, ou respondem `indisponivel`. Tetos: 4 passkeys extras e 1 código por membro (`limite-recuperacao`, HTTP 409); um código novo enterra o anterior. Rotas `POST /account/recovery/start|put|remove|list|fetch`; o `lookupId` vai só no corpo do POST. O nonce do `/start` não guarda estado (validade, bytes aleatórios e um HMAC do processo sobre o membro) e não tem cota por membro, então pedir nonces em nome de outro membro não o bloqueia; ele só é gasto depois de uma prova válida e fica na lista de gastos até a própria validade. Respostas: put `{ createdAt, changed }`, remove `{ changed }`, list `{ entries }`, fetch `{ member, kind, blob }` ou 404 `{ error: 'nao-encontrado', recovery: true }` (só essa resposta quer dizer "sem entrada" para o app). Fora de `account export` e `account status`. Arquivo corrompido: 503 só nessas rotas.
- Declaração assinada `'varanda-recovery-v1'` (`packages/core/lib/recovery-proof.js`, RPC `recovery.sign`, `docs/rpc.md` 5.90): ação, nonce, membro, associação, tipo, `lookupId` e `blobHash`. O `blobHash` (BLAKE2b-256 de tipo, `lookupId`, nonce e texto cifrado) é calculado pela sessão e de novo pelo serviço; o app nunca calcula hash.
- put e remove mantêm o resultado desconhecido num 503 depois de uma gravação possível: o app mostra o aviso de resultado desconhecido e "conferir" (lista), sem repetir o pedido sozinho.
- Controles IPC do worklet: `identity.recoveryLookup`, `identity.recoveryOpen`, `identity.recoveryWrap` e `identity.recoveryBind` (`docs/rpc.md` 5.91 a 5.94). `identity.recoveryOpen` consome a chave de desembrulho pendente: repetido, falha com "entrada de recuperação inválida", e o app recomeça com uma cerimônia nova. `identity.recoveryBind` altera estado (regrava o registro da passkey) e só aceita um `userId` com a marca. Quando a entrada com passkey marcada não devolveu identificador, o app liga o aparelho ao `userId` sintético 16 bytes zero seguidos de `WRAP_MARK`.
- App: Ajustes › Passkeys e recuperação (adicionar passkey, trocar a passkey deste aparelho, criar código de recuperação mostrado uma vez, remover); no cartão Entrar, "entrar com outra passkey" sempre que há passkey conhecida e "Entrar com código de recuperação". Termos e Política na versão 19, que dizem que adicionar passkey ou código exige a conta vinculada ao Google.

### Testes automatizados

- `packages/web-member/test/recovery.test.js` (novo): derivação, embrulho e abertura, marca, código.
- `packages/core/test/recovery-proof.test.js` (novo): bytes da declaração, separação de domínio, `blobHashOf`.
- `apps/cli/test/recovery-store.test.js` (novo): arquivo, sequência de gerações, mescla e lápides (prazo, teto, janela de 10 minutos), tetos, troca do código, leituras depois de gravação incerta, arquivo inválido nunca regravado.
- `packages/rpc/test/methods.test.js` e `packages/rpc/test/server.test.js`: `recovery.sign` e os controles `identity.recovery*`.
- `apps/app/test/legal.test.js` e `packages/core/test/terms.test.js`: textos e versão 19.
- `packages/web-member/test/session.test.js`: `recovery.sign`.
- `apps/cli/test/account-recovery.test.js` (novo): rotas, nonce, prova, tetos, 404, 503 só nessas rotas, registros sem identificador.
- Worklet (`identity-install.js`): lookup, open, wrap e bind.
- `apps/app/test/recovery.test.js` (novo): transporte e fluxo puro.
- `packages/web-member/test/web-node-recovery.test.js` (novo): entrada marcada, sem identificador, código, adicionar e ligar no nó do navegador.
- `apps/app/test/identityRecoveryNative.test.js` (novo): a mesma tabela de decisão no nativo.
- `apps/app/test/passkeysScreen.test.js` (novo): a tela, sem API de navegador, e adicionar chamado antes de qualquer `await`.
- `apps/cli/test/account-recovery-e2e.test.js` (novo): de ponta a ponta, a passkey extra e o código abrem a mesma chave pública.

Resultados (CI local, Node 24.22.1, sobre `fix/passkey-robustness@d7514068`): lint e demo passam (DEMO OK); 415 de 418 arquivos de teste passam na execução completa. `packages/core/test/community-member-leave.test.js` e `group-member.test.js` esgotaram o tempo (180 s por arquivo) com a máquina carregada e passam sozinhos (46/46 e 52/52), como na branch de base. `apps/cli/test/ai-embedder.test.js` falha só porque o caminho desta cópia local contém "sharp", igual na `main`.

### Verificação humana

Nenhuma verificação foi feita ainda. Marcar só o que for de fato executado, com a saída.

- [ ] Build de preview do Android: adicionar uma segunda passkey noutro gerenciador (não realizada ainda).
- [ ] Um perfil novo do navegador entra com essa segunda passkey e chega à mesma chave pública (não realizada ainda).
- [ ] Criar um código de recuperação: aparece uma vez só, com "Anotei o código" (não realizada ainda).
- [ ] Recuperar com o código num navegador sem passkey: o app leva a criar uma passkey nova e a conta abre com a mesma chave pública (não realizada ainda).
- [ ] Serviço de conta fora do ar: entrar com a passkey extra mostra a mensagem e o nó fica bloqueado (não realizada ainda).
- [ ] Remover uma entrada: ela some da lista e deixa de abrir a conta num aparelho novo (não realizada ainda).
- [ ] Membro antigo sem entradas: entra exatamente como antes, também sem internet (não realizada ainda).
- [ ] iOS: sem regressão em entrar e criar passkey (não realizada ainda).

### Limites que sobram

- A passkey original não pode ser invalidada: enquanto existir em algum gerenciador, ela abre a conta.
- Uma passkey extra numa versão antiga do app cria outra identidade, porque a versão antiga não conhece a marca.
- A passkey original abre a conta sem internet em qualquer aparelho (nunca há busca no serviço para ela). Uma passkey extra ou o código precisa do serviço de conta a cada entrada nova com a passkey ou com o código; só uma sessão guardada no aparelho evita isso.
- Se um gerenciador de senhas fora do padrão não devolve o identificador do usuário de uma passkey extra (marcada) num aparelho onde ela não está ligada, o aparelho não vê a marca e essa passkey abre ali uma conta separada e vazia em vez da conta do membro. Nada da conta real é afetado, e o código ou a passkey original ainda a recuperam. Um autenticador que segue o padrão devolve o identificador numa entrada sem registro no aparelho.
- Remover ou trocar uma entrada não troca a raiz: quem buscou aquele blob enquanto a entrada valia e tem o segredo dela ainda abre a conta. Isso vem do desenho da raiz embrulhada. Remover a entrada ou criar um código novo só impede novas entradas num aparelho que ainda não a usou; quem já entrou com ela, ou um aparelho ainda aberto com ela, continua com acesso, porque a chave da conta não pode ser trocada. Se uma passkey adicionada ou o código vazar, o único caminho seguro é criar uma conta nova. O cartão do código, a confirmação de código novo e as duas confirmações de remover dizem isso, e os Termos e a Política também (a versão continua 17).
- Cancelar a recuperação não desfaz o que já terminou: uma instalação que concluiu antes do cancelamento continua (a conta fica aberta e presa à passkey nova), uma passkey criada durante a cerimônia continua no gerenciador (o Varanda não consegue apagá-la; no navegador ela fica recusada como `SUPERSEDED` e fora das próximas criações) e um put já enviado ao serviço pode ter sido gravado (a lista confirma).
- Remover uma entrada não desconecta um aparelho que já desembrulhou a raiz com ela.
- Se o disco do serviço se perder, as entradas somem: o membro entra com a passkey original ou num aparelho ainda conectado e cadastra de novo.
- Uma cópia de `recovery.json` mais antiga que uma lápide já podada pode trazer de volta aquela linha.
- Só membros com vínculo Google cadastram entradas.

## 111. Busca de GIFs pelo serviço de conta (PR feat/gif-search)

Caminhada da busca de GIFs nas conversas, ligada pelo operador. A tela está em [app.md](app.md) ("Busca de GIFs nas conversas"); as variáveis estão no `README.md` ("Variáveis de ambiente"). Os Termos de Uso e a Política de Privacidade passam à versão 19 para descrever isso, então quem já aceitou a 18 vê o aceite de novo.

Regras que os passos conferem:

- Sem `VARANDA_GIF_API_URL` e `VARANDA_GIF_API_KEY`, a busca fica desligada: `GET /account/gif/policy` responde `{ "enabled": false }`, as outras rotas `/account/gif/*` respondem 404 `feature-off` e o app não mostra "GIF" em "Anexar". Só uma das duas, ou um valor malformado, faz o serviço recusar subir com um erro que não repete o valor.
- O texto da busca vai do app ao serviço de conta; o serviço pergunta ao provedor a partir do próprio endereço, com a chave da associação e um User-Agent fixo. O provedor nunca recebe o endereço, a conta, a chave ou um cookie do membro.
- O app recebe só ids, largura, altura e tamanho; miniaturas e imagens chegam por `/account/gif/image/<id>`, na origem da associação. O GIF escolhido é enviado como uma foto da conversa, e quem recebe o lê da cópia do Varanda, nunca do provedor.
- Por membro e por dia, 120 buscas e 60 imagens inteiras; acima disso, 429 `limite-gif`. Uma busca ou imagem que falha no provedor (503 `indisponivel`) não conta. O app não repete o pedido sozinho.
- A busca é `POST /account/gif/search` com o corpo `{ q }` ou `{ q, cursor }`, e o token da sessão vai em `Authorization: Bearer <token>`: o registro de erros do Caddy guarda a URL e os cabeçalhos de um pedido que falha, esconde só `Authorization` e os cookies, e nunca guarda o corpo. `GET /account/gif/search` responde 404 e o cabeçalho `x-varanda-gif` não vale mais.
- Cada busca ou imagem confere de novo, no máximo a cada 60 s, que o membro continua vinculado e fora da lista de bloqueio; quem não passa recebe 401 `nao-autorizado` e perde a sessão.
- A chave de um membro é pública, então o início de sessão não guarda nem conta nada: o nonce não fica numa tabela, ele carrega a própria validade (600 s) e uma assinatura HMAC presa àquele membro, com uma chave que só existe na memória do serviço (reiniciar o serviço invalida os nonces em aberto). Pedir muitos inícios com a chave de outra pessoa não invalida o nonce que ela já tem, e um nonce de A não vale para B.
- No fim da sessão, o serviço confere o nonce (404 `expirado` se adulterado, de outro membro ou vencido) e a assinatura (400 `assinatura-invalida`) antes de contar o limite de 10 fins por membro a cada 10 minutos (429 `limite-gif`): fins forjados com a chave de outra pessoa nunca a bloqueiam. Um nonce com assinatura válida só vale uma vez; quem passou do limite não gasta o nonce. Se a tabela de nonces gastos estiver cheia de entradas válidas, a resposta é 503 `indisponivel`, sem esquecer nenhuma.
- Nenhum registro do serviço leva o texto da busca, o token da sessão, a chave da API ou uma URL do provedor: só `{ "event": "gif", "reason": ... }`.
- Os Termos e a Política estão na versão 19 (`LEGAL_VERSION` e `TERMS_VERSION` iguais), falam de "provedor de GIFs" sem nome de empresa e não falam de prévia de link nem de encaminhamento.

Provedor falso: o serviço só fala com hosts `https` que resolvem para endereços públicos, então um servidor em `127.0.0.1` é recusado de propósito. Use um servidor de teste com nome público e certificado válido, que responda `GET <base>/gifs/search` no formato compatível com o Giphy, sirva GIFs pequenos no mesmo host e registre, de cada pedido, só o endereço de origem, o caminho e a consulta. Nunca use a chave de um provedor real nestes passos.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA:

- [ ] Serviço sem as variáveis: o registro de partida mostra `gif` `desligada`; `curl -s https://<origem>/account/gif/policy` responde `{"enabled":false}` e `curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: https://<origem>' -d '{"q":"gato"}' https://<origem>/account/gif/search` responde 404 `feature-off`. No app, "Anexar" mostra só "Foto".
- [ ] Só `VARANDA_GIF_API_URL` definida: o serviço recusa subir com "VARANDA_GIF_API_URL e VARANDA_GIF_API_KEY vêm juntas". Uma URL `http` ou com IP: recusa com "VARANDA_GIF_API_URL inválido", sem repetir o valor.
- [ ] Serviço com as duas variáveis apontando para o provedor falso (e `VARANDA_GIF_MEDIA_HOSTS`, se as imagens vierem de outro host): o registro mostra `gif` `ligada` e a política responde `{"enabled":true}`.
- [ ] Android: na abertura depois da atualização, o aceite dos Termos aparece com a versão 19; aceitar e seguir.
- [ ] Duas pessoas (um aparelho e um perfil do navegador, ou dois perfis do navegador) na instalação de teste: A abre uma mensagem direta, "Anexar", "GIF", busca "gato", vê as miniaturas, escolhe uma e envia. B recebe o GIF como uma foto da conversa. Repetir num grupo público e num grupo privado.
- [ ] Na aba Rede do navegador de B: o GIF recebido vem só da origem da instalação (canal de mídia das conversas ou `/media`), nenhum pedido vai ao host do provedor. Na de A: as miniaturas e o GIF vêm só de `/account/gif/image/`, e nenhuma resposta de busca traz URL do provedor.
- [ ] No registro do provedor falso: todos os pedidos vêm do endereço do serviço de conta; nenhum vem do endereço de A ou de B, e nenhum traz cookie, chave do membro ou cabeçalho além do User-Agent fixo.
- [ ] Limite: com um teto baixado só no teste (ou um script com o token de sessão em `Authorization: Bearer`), a 121ª busca do dia responde 429 `limite-gif`, e o app mostra o erro sem repetir o pedido.
- [ ] Pedido antigo: `curl -s https://<origem>/account/gif/search?q=gato` responde 404 `nao-encontrado`, e uma busca com o token em `x-varanda-gif` em vez de `Authorization` responde 401 `nao-autorizado`.
- [ ] Nonce preso ao membro: com um script, pedir `POST /account/gif/session/start` para o membro A e guardar o nonce; pedir mais 20 inícios e 30 fins com nonce aleatório e assinatura qualquer para a chave de A (respostas 200 e 404 ou 400, nunca 429); depois o app de A abre a busca de GIFs normalmente. O mesmo nonce enviado com a chave de B responde 404 `expirado`, e reenviar um fim que já deu certo também.
- [ ] Re-conferência: com uma sessão aberta, bloquear o membro pelo painel de moderação (ou desfazer o vínculo numa instalação de teste); em até 60 s a próxima busca responde 401 `nao-autorizado` e a seguinte, mesmo depois de desbloquear, também (a sessão foi apagada). O app pede uma sessão nova.
- [ ] Registro de erros do Caddy: com o provedor falso parado, uma busca responde 503; a linha de erro do Caddy não tem o texto da busca (o corpo não é registrado) e mostra `Authorization` como `REDACTED`.
- [ ] Registros: `docker compose logs account` (ou o journal) depois das buscas tem só linhas `gif` com `sessao`, `sessao-revogada`, `busca`, `miniatura`, `imagem` ou `indisponivel`; procurar "gato", o token e a chave da API não encontra nada.
- [ ] iOS (simulador), Safari e Chrome na web hospedada e o PWA instalado: repetir a busca, o envio e a conferência da aba Rede (na web) ou do registro do provedor.
- [ ] Em todas as plataformas: a Política e os Termos abertos em Ajustes mostram "Versão 19" e descrevem a busca de GIFs pelo serviço de conta.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/legal.test.js`, `node apps/app/test/terms-version.test.js` e `node packages/core/test/terms.test.js`.
- `node apps/cli/test/gif-routes.test.js` (provedor falso em loopback, por requisição injetada), `node apps/app/test/gifClient.test.js`, `node apps/cli/test/account.test.js` e `node apps/cli/test/cli.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

- O laboratório hospedado (`apps/cli/scripts/hosted-lab.js`) ainda não liga a busca de GIFs, e o serviço recusa um provedor em loopback; os passos com duas pessoas usam uma instalação de teste com um provedor falso público.
- Nenhuma caixa acima foi executada nesta documentação.

## 112. Aviso push de mensagem nova não aparece no aparelho que enviou (PR fix/dm-wake-self-notification)

Num nó hospedado no navegador, o aviso push de mensagem direta nova (`dm-wake`, seção 11 de [protocol.md](protocol.md), "Push wake") é global: vai para todas as assinaturas, sem nome nem texto. Um aparelho que acabou de enviar uma mensagem recebia o aviso de volta, "Pode haver uma mensagem nova na Varanda", como se fosse de outra pessoa. A mudança faz três coisas, todas no navegador e sem nada novo no servidor:

- Depois de uma janela da Varanda sinalizar que enviou uma mensagem direta ou mexeu em pasta (o marcador `varanda-dm-sent`, mandado só ao worker do próprio site), o worker de `apps/app/scripts/sw.js` grava no cache `varanda-dm-state` um prazo de 120 s (`DM_WAKE_MUTE_MS`). Só o relógio do worker vale, e um prazo malformado ou longo demais é ignorado. Nesse prazo, esse aparelho não deixa o aviso de `dm-wake` na tela: mostra em silêncio e fecha na hora (ver abaixo).
- Enquanto uma janela da Varanda estiver visível e em foco, o aviso não fica na tela desse navegador: o worker entrega `varanda-dm-wake` a essa janela (que precisa responder em até 1 s), ela recarrega as Conversas no lugar (`apps/app/src/usePush.web.js` e `apps/app/App.js`), e as outras janelas da Varanda do mesmo navegador também recarregam.
- Quem envia: o núcleo do navegador (`packages/web-member/lib/dm.js`) emite `dm.sending` antes de cada gravação de uma mensagem ou de uma pasta; a página de Conversas como página (`apps/app/src/pages.js`) marca `dm-send` antes do pedido, também na nova tentativa, e nunca `dm-set`. Em `apps/app/src/node.js` o evento vira o marcador. No app instalado (`dmWakeMute.native.js`) não há nada a fazer.

O aviso é sempre `{ v: 1, kind: 'dm-wake' }`, e o servidor não sabe quem enviou. Limites que a conferência abaixo deve observar:

1. Uma pasta mexida com o aparelho travado é gravada na fila (`packages/web-member/lib/dm.js`, na abertura do cadeado) e sobe ao destravar. Essa gravação pode acontecer antes de a página estar anexada ao núcleo, e os eventos de sessão sem receptor são descartados (`packages/web-member/lib/session.js`, `send`). Assim, esse único aviso ainda pode aparecer no aparelho que enviou.
2. O evento `dm.sending` chega à página num microtask (`apps/app/src/client/browser.js`), e o marcador é um `postMessage` seguido de `cache.put`, enquanto o semeador dispara o aviso dentro do `put` da gravação (`packages/core/lib/dm-pool.js`). Um aviso muito rápido, em teoria, pode chegar antes do marcador. A conferência registra se isso acontece.
3. Um aviso entregue depois (o push vale até um dia, `PUSH_TTL_S` em `apps/cli/lib/account/web-push.js`) aparece, mesmo dentro dos 120 s de outro envio. Um aviso que não diz quem escreveu também não é distinguido: um aviso de outra pessoa que chegue nesses 120 s some no aparelho que enviou.

O push nunca termina sem aviso. Nos dois casos acima, o worker mostra o aviso em silêncio (`silent: true`, sem som nem vibração), com uma etiqueta própria (`varanda-dm-wake-quiet`), e o fecha na hora. A etiqueta própria garante que um aviso de verdade que ainda esteja na tela não é trocado nem fechado. Decisão do dono (2026-11-06), depois de a documentação do WebKit dizer que um push sem aviso visível, por qualquer motivo, revoga a assinatura.

### Risco: o aviso fechado na hora ainda pode aparecer, ou o navegador pode tratá-lo como silencioso

A assinatura é `userVisibleOnly` (`apps/app/src/pushClient.web.js`). O WebKit (Safari no Mac e PWA no iPhone) documenta que revoga a assinatura de um push que não mostra aviso. Mostrar e fechar na hora conta como mostrado pelo que o WebKit descreve, mas isso não foi conferido num aparelho. Também não foi conferido se o Chrome, com o app em segundo plano, conta um aviso fechado na hora como mostrado ou mostra o aviso genérico dele ("o site foi atualizado em segundo plano"), nem se o aviso pisca por um instante em algum sistema. Por isso a matriz abaixo é uma conferência, não uma garantia.

Se a matriz mostrar um aviso genérico, um aviso que pisca de forma incômoda ou uma assinatura revogada, o resultado vai ao dono da Varanda para decisão.

### Como verificar

Testes automáticos desta parte: `apps/app/test/sw.test.js` (prazo de 120 s e janela em foco), `apps/app/test/pages.test.js` (marcador em `dm-send`), `apps/app/test/dmWakeMute.test.js` (módulo do aparelho), `packages/web-member/test/dm.test.js` (`dm.sending` antes de cada gravação) e `packages/rpc/test/envelope.test.js` (o evento `dm.sending`). Verificação por lint: `npm run lint`. As caixas abaixo ficam desmarcadas até alguém executar o passo, num navegador de verdade com a instalação web hospedada.

Duas janelas da mesma passkey (A e B) mais um terceiro membro (C), com avisos ligados em A e B:

- [ ] Em A, enviar uma mensagem direta para C (com pelo menos 15 minutos desde o último aviso push de mensagem na instalação, por causa do intervalo global). Em até 2 minutos, A não mostra aviso nenhum; B mostra o aviso "Pode haver uma mensagem nova na Varanda".
- [ ] Com A visível e em foco, C escreve para você. A não mostra aviso; a bolinha de Conversas em A é atualizada sem recarregar. B, com a janela escondida, mostra o aviso.
- [ ] Em A (sem foco, mas com a janela aberta), enviar uma mensagem para C. A não mostra o aviso dessa mensagem nos 2 minutos seguintes.
- [ ] Pela Conversas como página (com a página administrada por você), enviar uma mensagem. A não mostra o aviso dessa mensagem.
- [ ] Em A, mudar uma conversa de pasta (`dm.set`, por exemplo aceitar um pedido de mensagem). Essa mudança grava um `ctl` no conjunto de mensagens, que também dispara o aviso: esperado, A não mostra o aviso nos 2 minutos seguintes.
- [ ] Agindo como página, mudar uma conversa da página de pasta (`dm-set` da página). Essa mudança não grava nada no conjunto de mensagens (fica no serviço de conta), então não ativa a regra de A: um aviso de outra mensagem que chegue logo depois aparece em A. Registrar o que foi visto.
- [ ] Com A travado (senha ou passkey pendente), gravar uma pasta e destravar. Registrar se o aviso dessa pasta aparece em A (limite 1 acima). Esperado: pode aparecer.
- [ ] Enviar uma mensagem de A para C muito logo depois de C ter respondido por outro aparelho, e registrar se o aviso de C aparece em A (limite 2 acima). Esperado: não aparece; se aparecer, registrar a ordem de chegada.

Matriz de navegadores. Em cada um, instalado como web hospedada (PWA quando houver), depois de três avisos escondidos seguidos (mostrados em silêncio e fechados na hora) e de uma espera de 10 minutos, registrar:

- se o aviso escondido chega a piscar na tela, tocar som ou vibrar;
- se aparece um aviso genérico do tipo "o site foi atualizado em segundo plano" ou equivalente, sem o texto da Varanda;
- se a assinatura continua ativa (registrar o estado que o app mostra para o aviso, ou se a Varanda pede para ativar de novo);
- se o aviso de outra mensagem chega normalmente depois disso.

- [ ] Chrome no computador (aba visível e em foco, depois aba escondida).
- [ ] Chrome no Android (PWA instalado).
- [ ] Firefox no computador.
- [ ] Safari no macOS.
- [ ] Safari no iOS (PWA instalado na tela de início).

Resultado da matriz: a registrar aqui por navegador, com a data e a versão do navegador. Se algum mostrar aviso genérico ou revogar a assinatura, não corrigir por conta própria: levar ao dono.

### Limites desta parte

- O aviso é do navegador. No app instalado não há aviso do sistema, e nada muda ali.
- Os 120 s são do aparelho que enviou: os outros aparelhos da mesma pessoa recebem o aviso normalmente, porque o servidor não sabe qual deles enviou.
- A supressão vale só no aparelho, e o marcador não sai dele: nenhum servidor aprende quem enviou.
- Os limites 1 e 2 acima são conhecidos e não corrigidos nesta parte. A conferência registra o que acontece.
- O serviço de conta manda no máximo um aviso de mensagem a cada 15 minutos para todo mundo (`DM_WAKE_COOLDOWN_MS`, já era assim). Se o primeiro aviso desse intervalo foi o do próprio envio, e por isso não apareceu, uma resposta que chegue depois dos 120 s e antes de acabar o intervalo também não gera aviso; ela aparece no próximo `dm.pull` (ao voltar para o app, ao puxar para atualizar ou a cada 5 minutos com o app visível). Antes desta parte essa resposta também não gerava aviso: só aparecia o aviso do próprio envio.
- A janela em foco só fica com o aviso se o app responder ao service worker em até 1 s (`DM_WAKE_ACK_MS`); uma aba em foco que não é o app (uma imagem aberta direto, por exemplo) não responde, e o aviso aparece.
- Com a janela em foco, o aviso vira só uma releitura. Se a identidade está travada, a releitura espera o destravar. Se já há um `dm.pull` em andamento, a releitura dele falha e a mensagem aparece no próximo. Mensagens de uma página só aparecem quando a pessoa está agindo como a página, como antes. Uma janela em foco fora da área de membro (a abertura, os Termos, a primeira configuração, ou o começo de um carregamento antes de o app ouvir) não responde ao worker, e o aviso aparece normalmente.
- Nenhuma caixa executada nesta documentação.

## 113. Estado de vistos sincronizado entre aparelhos (PR feat/seen-sync-service)

O serviço de conta guarda, por membro, um bloco cifrado com as marcas de visto de Avisos, Conversas e grupos (`apps/cli/lib/account/seen-store.js`, `seen-routes.js`). O formato, a chave e as regras de fusão e de compare-and-swap estão em [protocol.md](protocol.md), seção 14. Esta parte confere o serviço; o navegador, que grava e funde o bloco, e o app estão nas PRs desta pilha, e o roteiro do app está no fim desta seção. O serviço não lê o bloco, e nenhuma conferência abaixo precisa de acesso ao conteúdo.

### Testes automáticos

Rodar um arquivo por vez, com `node <arquivo>`:

- `node packages/core/test/seen-blob.test.js`: chave, cifra, limites (256, 4 x 32, 736 e 128, 32336 bytes no limite), corte determinístico e fusão comutativa.
- `node packages/core/test/seen-proof.test.js`: enunciado `varanda-seen-v1`, assinatura e recusa de outro prefixo.
- `node apps/cli/test/account-seen-store.test.js`: arquivo 0600 num diretório 0700, CAS, duas gravações concorrentes (uma só vence), arquivo de tamanho errado, link simbólico, zerar antes de apagar, limite de membros e registro sem membro nem bytes.
- `node apps/cli/test/account-seen.test.js`: as rotas `start` e `finish`, conflito 409, nonce de uso único, Termos pendentes, limite de 429, tamanho do arquivo e 503 sem armazenamento.
- `node apps/app/test/legal.test.js`: texto da Política e dos Termos na versão 21 (versão, nota de revisão e resumo do texto fixados).

### Roteiro no servidor de teste

Pré-requisito: uma conta de teste já vinculada, criada como em `apps/cli/test/account-seen.test.js` (sem Google), com o aceite da versão 21 dos Termos (`POST /account/terms/start` e `finish`). Sem o aceite, toda gravação responde 409 `termos-pendentes`. A chave de assinatura é gerada na hora, num script de uma linha em `node` que chama `signSeen` de `packages/core/lib/seen-proof.js` e imprime só a assinatura. Nem a chave nem a assinatura vão para o registro desta conferência.

- [ ] Leitura sem bloco: `POST /account/seen/start` com `{ "member": "<hex64>", "action": "read" }` responde 200 `{ nonce }`; `POST /account/seen/finish` com `prevHash` de 64 zeros responde 200 `{ hash: null, blob: null }`.
- [ ] Nonce de uso único: repetir o mesmo `finish` responde 404 `expirado`.
- [ ] Assinatura com um caractere trocado responde 400 `assinatura-invalida`.
- [ ] Gravação: `start` com `action: "write"` e `finish` com `prevHash` de 64 zeros, `newHash` igual ao hash do bloco (BLAKE2b-256 do bloco cifrado) e `blob` com 43744 caracteres em base64 de um bloco de 32808 bytes; responde 200 `{ ok: true, hash }`. O arquivo `<dados>/seen/<member>` tem 32808 bytes e modo 600 (`stat`).
- [ ] Tamanho constante: uma gravação com uma marca e outra com o limite cheio resultam no mesmo tamanho de arquivo (32808 bytes).
- [ ] Hash velho: uma gravação com um `prevHash` que não é o atual responde 409 `conflito`, com o `hash` atual e o `blob` atual em base64; o arquivo no disco não muda (o hash continua igual).
- [ ] Depois desse 409, uma gravação com o `hash` devolvido responde 200.
- [ ] Gravação sem o aceite da versão 21 responde 409 `termos-pendentes` e não muda o arquivo.
- [ ] Apagamento: com um hash velho responde 409 `conflito`; com o hash atual responde 200 `{ ok: true, changed: true }` e o arquivo some; apagar de novo responde 200 `{ ok: true, changed: false }`. Zerar o arquivo antes de apagar não se confere aqui, porque ele já não existe; a conferência é o teste `forget zeroes the file, then unlinks it` de `account-seen-store.test.js`.
- [ ] Sem armazenamento usável (por exemplo, `seen` trocado por um link simbólico num ensaio), todas as rotas respondem 503 `indisponivel` e nenhum arquivo de membro é tocado.
- [ ] Sem arquivos sobrando: depois das gravações, nenhum `.tmp.*` fica no diretório `seen`.
- [ ] Log: o registro do serviço durante o roteiro não tem o hex do membro, o base64 do bloco nem os hashes. Só aparecem linhas `{ "event": "seen", "reason": ... }`.
- [ ] Um pedido de outro membro, com a assinatura desse membro, não muda o arquivo do primeiro (a conferência também está em `account-seen.test.js`).

### Roteiro no app

Pré-requisito: a mesma passkey em dois navegadores (ou aba e app instalado) na versão hospedada, com os Termos da versão atual aceitos, e uma conta de teste sem Google. Os pontos são conferidos só com os dois aparelhos na tela; nada disto é verificado por teste automático.

- [ ] Avisos entre navegadores: no navegador A, abrir Avisos com um aviso novo; no B, o ponto do sino some depois da rodada (A grava em até 30 s depois da marca (até 90 s se uma rodada acabou de rodar), e o B perde o ponto ao voltar a aba ou na próxima rodada de 5 minutos).
- [ ] Conversas: uma mensagem não lida aberta no A deixa de ter ponto no B depois da rodada, e o ponto da aba só some quando não há outra conversa não lida.
- [ ] Grupos: um grupo aberto no A perde a contagem no B depois da rodada; a aba (`comunidades`) só perde o ponto quando nenhum grupo tem não lidas.
- [ ] Catch-up offline: com o B sem rede, marcar avisos e conversas no A; voltar a rede no B e esperar a rodada (ou voltar a aba). As marcas chegam e nenhuma some.
- [ ] Segunda passkey (outra identidade): não vê as marcas da primeira; os pontos dela seguem como antes.
- [ ] Bloco velho do servidor: colocar no serviço de teste uma cópia anterior do bloco (ensaio) e rodar uma leitura no B. O B não perde as marcas locais: os avisos que ele já viu continuam sem ponto, no máximo um ponto antigo reaparece.
- [ ] Sem Termos aceitos: a aba não faz nenhum pedido de vistos (conferir na aba de rede do navegador).
- [ ] Configuração manual e `varanda-serve`: nenhum pedido de vistos; os pontos são os de antes desta funcionalidade.
- [ ] Nativo (quando houver build de debug com a conta de teste): os mesmos pontos aparecem no app e no navegador. Se não houver build, a conferência fica pendente e não é dada como feita.

### Limites desta parte

- A rodada de vistos corre só depois que o nó está pronto e online, então um aparelho sem rede não mostra as marcas dos outros até voltar a rede.
- Migração: uma entrada antiga com enchimento só viaja quando uma linha carregada bate com ela, por isso outro aparelho pode mostrar um aviso antigo como novo até a pessoa abrir a aba onde ele aparece.
- Os limites do bloco (256 avisos, 4 x 32 em páginas, 736 mensagens de Conversas e 128 grupos) cortam o mais antigo; um item que sai do bloco pode voltar como novo em outro aparelho.
- O ponto da aba de grupos só é apagado até as versões que o app conhecia quando a fusão foi pedida. Uma publicação que chega durante a fusão mantém o ponto, mesmo que outro aparelho já a tenha lido; ele some ao abrir a aba ou o grupo.
- A trava da conta não é do sistema operacional. Se o processo perder a trava entre a conferência e o renomear, uma gravação antiga pode substituir um bloco que o novo titular já confirmou. A conferência não reproduz essa corrida; ela se recupera pela fusão, porque cada aparelho reescreve as suas marcas (`seen-store.js`, cabeçalho).
- Não há apagamento pedido por um aparelho: a rota `delete` existe, mas nenhum cliente a chama. O apagamento hoje é um pedido à associação.
- A exclusão da conta existe (seção 115) e apaga o bloco cifrado de vistos no serviço de conta.
- Não verificado em servidor real: esta seção foi escrita sem executar os roteiros acima, o do servidor e o do app.

## 114. Encaminhar mensagens nas conversas e nos grupos (PR feat/forwarding)

Caminhada de encaminhar uma mensagem de uma conversa (mensagem direta ou grupo) para até 5 conversas ou grupos. A tela está em [app.md](app.md) ("Conversa", "Encaminhar"). Não há mudança nos Termos de Uso nem na Política de Privacidade: nenhum tratamento de dado novo.

Regras que os passos conferem:

- Um toque longo numa mensagem de conversa ou de grupo oferece "Encaminhar", ao lado de Responder, Copiar e Denunciar. A folha lista as conversas e os grupos recentes; dá para escolher até 5 destinos, e a mensagem vai a cada um, em ordem, com o seu próprio estado: "Na fila", "Enviando…", "Encaminhada", "Não deu para confirmar o envio." ou "Não foi enviada.". Um envio sem confirmação mostra "Tentar de novo", que só reenvia com um toque, nunca sozinho.
- Fotos, GIFs e mensagens de voz são enviados de novo para o destino, cifrados no aparelho quando o destino é mensagem direta ou grupo privado. O destino nunca lê o arquivo do original, e o semeador não consegue dizer que duas conversas têm o mesmo arquivo.
- Se a mídia não existe mais no aparelho nem na origem (por exemplo, passaram os 7 dias), ela não é enviada e a linha mostra "A mídia expirou"; o texto da mesma mensagem é enviado.
- Mídia que era privada (mensagem direta ou grupo privado) enviada a um grupo público pede antes: "Esta mídia era privada. Enviar para um grupo público?". Sem o sim, nada vai para esse grupo.
- Uma mensagem encaminhada mostra a linha pequena "Encaminhada" e nunca diz quem a escreveu originalmente. A marca é posta só por quem encaminha (o campo `fwd`, 0 ou 1, no corpo interno v2 da mensagem direta e no registro de publicação v2 do grupo). Ela não prova de onde o conteúdo veio: qualquer app pode pôr essa marca.
- A relação de resposta da mensagem original não é mantida: a cópia não aparece como resposta.
- Num diário em nome de uma Página, "Encaminhar" não é oferecido.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA:

- [ ] Mensagem direta para mensagem direta: A abre uma conversa com B, toca longo numa mensagem de texto, escolhe "Encaminhar", escolhe a conversa com C e envia. Na conversa com C a mensagem aparece com a linha "Encaminhada" e sem nome de quem a escreveu originalmente; o estado passa de "Na fila" a "Enviando…" e a "Encaminhada".
- [ ] Mensagem direta para grupo privado: encaminhar uma foto de uma conversa para um grupo privado. O grupo recebe a foto como nova mensagem, cifrada; o semeador guarda só o cifrado (conferir no registro ou na aba Rede, sem ver a imagem em claro).
- [ ] Grupo para mensagem direta: encaminhar uma mensagem de texto de um grupo público para uma conversa. A linha "Encaminhada" aparece, sem o nome de quem escreveu no grupo.
- [ ] Grupo público para grupo público: encaminhar uma publicação de texto e uma foto. A foto vai como nova foto do grupo de destino e a origem continua intacta.
- [ ] Privado para público: encaminhar uma foto de uma mensagem direta para um grupo público. A tela pergunta "Esta mídia era privada. Enviar para um grupo público?"; com "Cancelar" nada chega ao grupo, e com o envio a foto aparece como pública no grupo.
- [ ] Mídia expirada: com uma foto cuja origem já não existe no aparelho nem no semeador (apagar o cache local e deixar passar a janela de 7 dias, ou remover a origem em instalação de teste), encaminhar a mensagem: a linha mostra "A mídia expirou" e o texto da mesma mensagem é enviado.
- [ ] Limite de 5 destinos: na folha, escolher 5 conversas e tentar uma sexta; a sexta não entra na escolha. Os 5 envios seguem na ordem escolhida.
- [ ] Envio incerto: com a rede caída no meio de um envio, a linha mostra "Não deu para confirmar o envio." e "Tentar de novo"; o app não reenvia sozinho. Só depois do toque em "Tentar de novo" o envio é feito de novo, e a mensagem aparece uma vez no destino.
- [ ] Linha "Encaminhada" sem autor: na mensagem encaminhada, a linha mostra só "Encaminhada" e nenhum nome de autor original, nem em grupo público, nem em grupo privado, nem em mensagem direta.
- [ ] Página: com a conta agindo como Página, abrir uma mensagem de conversa ou publicação de grupo e tocar longo; "Encaminhar" não aparece.
- [ ] Conferir que a conversa de origem continua igual depois de cada encaminhamento: a mensagem original não muda, não ganha a linha "Encaminhada" e não some.
- [ ] iOS (simulador): repetir os casos de mensagem direta para mensagem direta, de mídia privada para público e de envio incerto.
- [ ] Web e PWA instalado: repetir mensagem direta para mensagem direta, grupo para mensagem direta, o aviso de mídia privada e o limite de 5, nos mesmos passos que no Android.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/forward.test.js` e `node apps/app/test/forwardSheet.test.js`.
- `npm run lint`, que tem de passar.

Limites desta caminhada:

## 115. Excluir conta pelo app (PR feat/account-deletion)

Caminhada da exclusão da conta pelo próprio app, exigida pela diretriz 5.1.1(v) da App Store. O protocolo está em [protocol.md](protocol.md) ("Account deletion"); a operação, no `README.md` ("Excluir conta"). Os Termos de Uso e a Política de Privacidade passam à versão 22 para descrever isso, então quem já aceitou a 21 aceita de novo.

Regras que os passos conferem:

- A linha "Excluir conta" aparece em Ajustes, abaixo de "Sair", só com a passkey aberta numa instalação hospedada (app ou web). A tela explica o que sai na hora, o que sai em até 7 dias, o que fica e que as comunidades e os grupos criados pela pessoa deixam de existir para todos.
- O botão "Excluir conta" só fica ativo com o @nome digitado (com ou sem "@", qualquer caixa). Tocar nele pede a passkey de novo (Face ID, digital ou PIN do aparelho) antes de qualquer pedido; cancelar a passkey não manda nada ao serviço.
- O pedido assinado é `account.sign` na fase `delete` sobre o nonce e o @nome atual. Uma assinatura de outra fase, de outra chave ou com outro @nome responde 400 `assinatura-invalida`; um nonce já usado ou vencido, 404 `expirado`.
- Quem é dono de uma página que não foi encerrada nem transferida vê "Você ainda é dono de uma página" e o botão "Abrir Páginas" (409 `paginas-ativas`).
- Depois do pedido, o serviço de conta: enfileira no painel um bloqueio marcado "exclusão da conta pedida pela própria pessoa (não pode ser cancelada aqui)", sem botão de cancelar; responde 409 `conta-excluida` a cancelar ou desbloquear essa chave pelo painel; apaga o vínculo Google, os aceites, a faixa etária, as inscrições de push, as entradas de recuperação, os convites, as marcas de convites de surpresa e o bloco cifrado de vistos da pessoa; guarda só a chave pública, a data e os @nomes já usados.
- `GET /account/status?member=<chave>` responde `{"linked":false,"deleted":"pendente"}` até `mod apply` publicar a lista com a chave, e `"concluida"` depois. Nenhuma resposta ou registro leva e-mail, sub ou a chave; o registro do serviço tem só `exclusao` com `pedido`, `diretorio-incerto` ou `purga-pendente`.
- O app apaga a conta do aparelho na hora (como "Recomeçar") e volta para "Entrar", onde mostra "Conta excluída em <data>", o que já saiu, o prazo de 7 dias e como apagar a passkey. Quando o status vira `concluida`, mostra "Exclusão concluída" uma vez, com "Entendi".
- Entrar de novo com a mesma passkey, ou abrir outro aparelho que continuava com a sessão, mostra "Esta conta foi excluída" e só o botão "Apagar deste aparelho". A mesma chave não volta a se vincular, e os @nomes da conta não vão para outra pessoa. A mesma conta Google consegue criar uma conta nova com outra passkey.
- `mod apply` mostra `bloquear <chave> (exclusão pedida pela pessoa)`, e `mod apply --yes` assina e publica; o semeador derruba o diário.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA. O build de debug não entra com passkey numa instalação de produção (veja `docs/development.md`): use a instalação de teste ou o APK de preview do EAS para os passos que precisam de conta.

- [ ] Abertura depois da atualização: o aceite dos Termos aparece com a versão 22; aceitar e seguir.
- [ ] Conta de teste vinculada ao Google, com push ligado, uma passkey extra e um convite criado: Ajustes mostra "Excluir conta" abaixo de "Sair"; a tela abre com o texto e o campo "Para confirmar, digite @<nome>".
- [ ] Botão desativado com o campo vazio e com outro nome; ativo com "@Nome" em maiúsculas.
- [ ] Tocar em "Excluir conta" e cancelar a passkey: aparece "entrada com a passkey cancelada" e nada muda (`GET /account/status` continua `linked: true`, o painel não tem bloqueio pendente).
- [ ] Repetir e confirmar a passkey: o app volta para "Entrar" com "Conta excluída em <data>" e as instruções para apagar a passkey. `GET /account/status?member=<chave>` responde `{"linked":false,"deleted":"pendente"}`. No servidor, `terms.json`, `age.json`, `push.json` e `invites.json` não têm mais a chave, `seen/<chave>` não existe mais, e `recovery.json` tem só a marca de remoção.
- [ ] Painel de moderação: a mudança aparece com "exclusão da conta pedida pela própria pessoa" e sem "cancelar"; um `curl` de `api/pending/<id>/cancel` e de `api/unblock` com a sessão do painel respondem 409 `conta-excluida`.
- [ ] Na máquina do operador: `mod apply --yes` mostra `bloquear <chave> (exclusão pedida pela pessoa)`, publica, e `seed status` mostra a lista nova; o diário some de `/index` e da Espiadinha.
- [ ] De volta ao app em "Entrar": ao abrir de novo, aparece "Exclusão concluída: o diário saiu dos semeadores da associação." e, depois de "Entendi", não aparece mais.
- [ ] Entrar com a mesma passkey: aparece "Esta conta foi excluída" e "Apagar deste aparelho"; tocar apaga e volta para "Entrar".
- [ ] Dois aparelhos com a mesma passkey: excluir no primeiro; abrir o segundo mostra "Esta conta foi excluída" antes dos Termos e de A Rua.
- [ ] Bloqueio já pendente: decidir "bloquear" uma denúncia contra uma conta de teste (sem rodar `mod apply`) e então excluir essa conta pelo app. O painel mostra o bloqueio do moderador e o da pessoa; "cancelar" no do moderador (por `curl` com a sessão do painel) responde 409 `conta-excluida`; `mod apply --yes` assina os dois.
- [ ] Dono de página (`VARANDA_PAGE_KEYS` com a chave da página): a tela mostra "Você ainda é dono de uma página" e "Abrir Páginas"; depois de encerrar a página, a exclusão segue.
- [ ] Criar uma conta nova com a mesma conta Google e outra passkey: o vínculo funciona; escolher o @nome da conta excluída responde "esse nome já está em uso".
- [ ] Registros do serviço depois de tudo: só linhas `exclusao` com `pedido` (e `purga-pendente` só se algum arquivo estava indisponível); procurar o e-mail, o sub e a chave não encontra nada.
- [ ] iOS (simulador), Safari e Chrome na web hospedada e o PWA instalado: repetir os passos de exclusão, a passkey pedida de novo e o recibo em "Entrar".
- [ ] Em todas as plataformas: a Política e os Termos abertos em Ajustes mostram "Versão 22", dizem onde excluir a conta, o que fica e o prazo de 7 dias, e não dizem mais que o app não permite excluir a conta.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/cli/test/account-delete.test.js`, `node apps/cli/test/account-store.test.js`, `node apps/cli/test/moderation-store.test.js`, `node apps/cli/test/account-mod.test.js`, `node apps/cli/test/mod-apply.test.js`, `node apps/cli/test/account-age.test.js` e `node apps/cli/test/invite-drops.test.js`.
- `node packages/core/test/account-link.test.js`, `node packages/rpc/test/methods.test.js`, `node packages/web-member/test/passkey.test.js` e `node packages/web-member/test/web-node-recovery.test.js`.
- `node apps/app/test/accountDeletion.test.js`, `node apps/app/test/account.test.js`, `node apps/app/test/sessionStoreNative.test.js`, `node apps/app/test/legal.test.js`, `node apps/app/test/terms-version.test.js`, `node packages/core/test/terms.test.js` e `node apps/site/test/legal.test.js`.

- Sem passkey e sem código de recuperação ainda não há como pedir a exclusão pelo app; a página com o Google é um próximo passo.
- Nenhuma caixa acima foi executada nesta documentação.

## 116. Excluir conta confere a passkey no serviço de conta (PR feat/deletion-passkey-assertion)

Continua a seção 115. Antes, a confirmação com a passkey antes de excluir a conta era só uma checagem no aparelho (o sinal UV e o identificador da credencial), e um autenticador forjado numa sessão aberta passava por ela; o resíduo foi aceito em 06/11/2026 com esta continuação. Agora o serviço de conta guarda a chave pública da passkey que criou a conta e confere uma asserção nova sobre o nonce do pedido. O protocolo está em [protocol.md](protocol.md) ("Account deletion"); a operação, no `README.md` ("Excluir conta"). Os Termos de Uso e a Política de Privacidade passam à versão 23, então quem aceitou a 22 aceita de novo.

Regras que os passos conferem:

- Logo depois do vínculo Google, o app manda o objeto de atestado da criação da passkey (`POST /account/passkey/start` e `/add`, `account.sign` na fase `passkey` com o SHA-256 do objeto). O serviço aceita só na primeira hora depois do vínculo e só se a conta ainda não tem chave guardada (409 `vinculo-antigo` e `passkey-registrada` fora disso). Nada disso aparece na tela.
- Com chave guardada, "Excluir conta" pede a passkey com o nonce do pedido como desafio, e o serviço confere a assinatura com a chave guardada, a origem (o endereço público, ou `android:apk-key-hash:` do certificado de `VARANDA_ANDROID_CERT_SHA256` no app Android), o rpId, os sinais UP e UV e o contador. Uma asserção de outra passkey com o mesmo identificador, de outro desafio, de outra origem ou sem UV responde 403 `passkey-invalida` e não exclui nada.
- Sem chave guardada (toda conta vinculada antes, outra passkey, uma criação no iOS sem objeto de atestado), a tela explica a espera e o botão diz "Agendar exclusão". O pedido fica agendado por 7 dias: `GET /account/status` tem `scheduledDeletion`, todos os aparelhos com a conta aberta mostram "Exclusão da conta agendada para <data>" no topo, um aviso push "Pedido de exclusão da sua conta" chega se ligado, e "Cancelar exclusão" (em Ajustes > Excluir conta) cancela de qualquer aparelho. Pedir de novo mantém a data.
- Na data, a varredura de hora em hora exclui como antes (bloqueio `titular`, vínculo, sidecars, `passkeys.json`). Quem passou a ser dono de uma página fica de fora até encerrá-la.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA. O build de debug não entra com passkey numa instalação de produção (veja `docs/development.md`): use a instalação de teste ou o APK de preview do EAS para os passos que precisam de conta.

- [ ] Abertura depois da atualização: o aceite dos Termos aparece com a versão 23; aceitar e seguir.
- [ ] Conta nova (passkey criada agora, vínculo Google em seguida): `passkeys.json` no servidor passa a ter a chave da conta com `alg` -7 (ou -257), e os registros mostram `passkey` com `registrada`, sem chave nem identificador.
- [ ] Nessa conta, Ajustes > Excluir conta: o texto diz que os dados do aparelho são apagados logo depois do pedido; confirmar a passkey exclui na hora (`{"linked":false,"deleted":"pendente"}`), como na seção 115.
- [ ] iOS (simulador ou aparelho): conferir se a criação devolve o objeto de atestado (a conta nova ganha chave em `passkeys.json`) e se a exclusão na hora passa (a origem do iOS é `https://<rpId>`). Se não passar, anotar o motivo do registro (`passkey-origem`, por exemplo) e a exclusão cai na espera.
- [ ] Android pelo app instalado (APK de preview, com `VARANDA_ANDROID_CERT_SHA256` no serviço `account`): a exclusão na hora passa. Sem a variável, a mesma tentativa responde `passkey-invalida` com `passkey-origem` no registro; anotar.
- [ ] Conta antiga (vinculada antes desta versão): Ajustes > Excluir conta mostra o texto da espera e "Agendar exclusão"; confirmar a passkey agenda. O topo do app mostra "Exclusão da conta agendada para <data>" e "Ver"; um segundo aparelho com a mesma conta mostra o mesmo ao abrir; com push ligado, chega "Pedido de exclusão da sua conta".
- [ ] "Ver" abre Ajustes > Excluir conta com a data e "Cancelar exclusão"; cancelar some com o aviso em todos os aparelhos (`scheduledDeletion` some de `GET /account/status`).
- [ ] Agendar de novo e, no servidor, adiantar a data (ou esperar 7 dias numa instalação de teste): a varredura exclui, o registro mostra `agendada-executada`, e os aparelhos passam a mostrar "Esta conta foi excluída".
- [ ] Autenticador forjado: no Chrome da web hospedada, com a sessão aberta numa conta nova, ligar o autenticador virtual do DevTools (WebAuthn) e tentar excluir. Sem a passkey verdadeira, o pedido responde `passkey-invalida` (com chave guardada) ou é só agendado; nada é excluído na hora.
- [ ] Registros do serviço depois de tudo: só linhas `exclusao` e `passkey` com tokens; procurar a chave, o identificador da credencial, o e-mail e o sub não encontra nada.
- [ ] Em todas as plataformas: os Termos e a Política em Ajustes mostram "Versão 23" e descrevem a chave pública da passkey guardada e a espera de 7 dias.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/cli/test/webauthn.test.js`, `node apps/cli/test/passkey-store.test.js`, `node apps/cli/test/account-passkey.test.js` e `node apps/cli/test/account-delete.test.js`.
- `node packages/core/test/account-link.test.js`, `node packages/core/test/terms.test.js`, `node packages/rpc/test/methods.test.js`, `node packages/web-member/test/passkey.test.js`, `node packages/web-member/test/web-node-recovery.test.js` e `node packages/web-member/test/resume.test.js`.
- `node apps/app/test/accountDeletion.test.js`, `node apps/app/test/account.test.js`, `node apps/app/test/passkeyEnrol.test.js`, `node apps/app/test/sessionStoreNative.test.js`, `node apps/app/test/sw.test.js`, `node apps/app/test/legal.test.js` e `node apps/site/test/legal.test.js`.

Limites:

- A chave é confiada no primeiro uso, no cadastro: quem controlar o aparelho da pessoa na hora seguinte ao vínculo pode registrar um autenticador forjado no lugar.
- Uma sessão aberta guarda a chave do diário e pode agendar uma exclusão; a pessoa vê o pedido em todos os aparelhos e pode cancelar por 7 dias, mas quem não abrir nenhum aparelho nesse prazo perde a conta.
- As passkeys extras e a troca de passkey não registram chave; quem só tem uma delas espera os 7 dias.
- A origem do iOS e o objeto de atestado no iOS dependem do aparelho (passo acima).
- Nenhuma caixa acima foi executada nesta documentação.

## 117. Prévias de links e passada visual completa (PR feat/link-previews)

Caminhada da prévia de links nas conversas, nos grupos e nas publicações do diário, seguida da passada visual completa desta rodada de redesenho. As telas estão em [app.md](app.md) ("Conversa", "Prévias de links"); a linha LGPD está em [design.md](design.md). Os Termos de Uso e a Política de Privacidade sobem para a versão 24.

Regras que os passos conferem:

- A prévia é montada uma só vez, por quem envia: no app nativo pelo próprio aparelho; na web hospedada pelo serviço de conta da associação (`/account/preview`), que lê a página do próprio endereço, nunca com o IP nem a identidade do membro, e não guarda nem registra o link, o título nem a imagem. A sessão da prévia exige o aceite dos Termos atuais, como a busca de GIFs, e cada membro pede até 60 prévias por dia.
- O cartão (título, descrição e uma imagem de até 32 KB) vai dentro da mensagem direta, da mensagem de grupo ou da publicação do diário, com a proteção dela. Quem recebe vê só os dados guardados na mensagem e nunca busca nada no site; tocar no cartão abre o link, só por escolha de quem lê.
- No rascunho, o cartão tem um X para descartar; anexar uma foto tira o cartão; se a página falha, a mensagem segue só com o texto.
- A chave "Prévia de links" em Ajustes, desligada, faz o app não pedir prévia nenhuma; os cartões que outras pessoas enviam continuam aparecendo.
- Com `VARANDA_PREVIEW=0` no serviço de conta, `GET /account/preview/policy` responde `{ enabled: false }`, as demais rotas respondem 404 `feature-off`, e a web hospedada não monta prévias.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/feat/link-previews/<plataforma>/`, gravadas por `apps/app/scripts/review-shots.sh`.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node packages/rpc/test/link-card.test.js`, `node packages/core/test/link-card.test.js`, `node apps/cli/test/preview-routes.test.js`, `node apps/app/test/preview.test.js`, `node apps/app/test/previewPref.test.js` e `node apps/app/test/legal.test.js`.
- `npm run lint`, que tem de passar.

Prévia de links, primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA:

- [ ] Android: colar um link `https://` numa mensagem direta; o cartão aparece no rascunho com título, imagem e endereço; enviar. No aparelho de quem recebe, o cartão aparece igual, e tocar nele abre o link.
- [ ] Android: o mesmo num grupo público, num grupo privado e numa publicação do diário (Publicar). No grupo privado, o semeador guarda só o cifrado.
- [ ] Android: tocar no X do cartão no rascunho; a mensagem sai só com o texto e o link.
- [ ] Android: com o cartão no rascunho, anexar uma foto; o cartão some e a mensagem sai com a foto.
- [ ] Android: um link para um endereço que não responde, ou para uma página sem título; a mensagem sai só com o texto, sem erro na tela.
- [ ] Android: Ajustes, desligar "Prévia de links"; colar um link não monta cartão e o aparelho não faz pedido ao site (conferir no registro de rede do emulador ou do proxy); um cartão enviado por outra pessoa continua aparecendo.
- [ ] iOS (simulador): repetir a mensagem direta, o grupo privado, a publicação do diário, o X, a foto e a chave desligada.
- [ ] Web (Chrome, conta hospedada): colar um link numa mensagem direta; na aba Rede de quem envia, o único pedido da prévia vai para `/account/preview` da instalação, nunca para o site do link.
- [ ] Web, quem recebe: com a aba Rede aberta, abrir a conversa com o cartão; nenhum pedido sai além da origem da instalação (nada para o site do link, nem para a imagem do cartão).
- [ ] Web, quem recebe, com o serviço de prévia parado (serviço de conta com `VARANDA_PREVIEW=0` ou fora do ar): os cartões já enviados continuam aparecendo iguais, e a aba Rede segue sem pedido para fora da origem.
- [ ] Web: o mesmo cartão num grupo público, num grupo privado e numa publicação do diário.
- [ ] Web: Ajustes, desligar "Prévia de links"; colar um link não faz pedido a `/account/preview` (aba Rede); os cartões recebidos continuam aparecendo.
- [ ] Web: com o cartão no rascunho, anexar uma foto; o cartão some.
- [ ] Web: com `VARANDA_PREVIEW=0` no serviço de conta, `GET /account/preview/policy` responde `{ enabled: false }`, colar um link não monta cartão e não sai pedido a `/account/preview`.
- [ ] Celular: um link encurtado (que redireciona, por exemplo um bit.ly) não monta cartão e a mensagem sai como texto simples; na web o mesmo link monta o cartão com o endereço final (o serviço segue até 3 redirecionamentos conferidos).
- [ ] PWA instalado: repetir a mensagem direta com cartão e a conferência da aba Rede de quem recebe.

Passada visual completa desta rodada, pelo ciclo de [design-review.md](design-review.md):

- [ ] Android (AVD `varanda-api36`): a Vitrine sobe com `EXPO_PUBLIC_VARANDA_VITRINE=1`, e as telas do ciclo (A Rua, Conversa, Membro, Diário, Conversas e filtros, Mensagem, Comunidade, Grupo, ComunidadeInfo, Avisos, Busca, Publicar, Ajustes e Introdução) abrem com dados de exemplo, em tema claro e escuro, com texto grande e com movimento reduzido. Nenhum texto cortado, sobreposto ou escondido, nenhum alvo de toque menor que 44 pt.
- [ ] iOS (simulador iPhone 16e): as mesmas telas, nos dois temas, com texto grande e movimento reduzido.
- [ ] Chrome em 390 px e em 1280 px: as mesmas telas, nos dois temas, com texto grande e movimento reduzido.
- [ ] Laboratório hospedado no Chrome com duas sessões (Pessoa 1 e Pessoa 2), numa mensagem direta: foto, GIF, mensagem de voz, resposta, menção a uma Página, cartão de link e encaminhar; as duas telas mostram o que foi enviado.
- [ ] O mesmo num grupo público.
- [ ] O mesmo num grupo privado.
- [ ] Avisos, Busca, Publicar e o menu "Mais" (overflow) nas duas sessões, nos dois temas.
- [ ] Nenhuma tela mostra confirmação de leitura, indicador de digitação nem presença (online, visto por último), em nenhuma das duas sessões.

Entrada nativa real (caixa separada: não é parte da revisão visual):

- [ ] entrada nativa real: entrar com passkey e conta no app instalado, no Android e no iOS, e repetir a prévia de links numa mensagem direta. Pré-requisitos que ainda faltam:
  - iOS: o domínio associado da conta Apple Developer, sem o qual a passkey não entra.
  - Android: o `assetlinks.json` da instalação precisa associar o build de debug (`app.varanda.debug`), o que a instalação de produção não faz e não deve fazer com a chave pública de debug. Até lá, o login com conta no Android usa o APK de preview do EAS (ver a seção Android de [development.md](development.md)).
  - A configuração hospedada do app nativo exige `https`.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- No app nativo, quem monta a prévia é o aparelho de quem envia, que fala direto com o site do link e expõe a ele o próprio endereço de rede; a Política (versão 24) diz isso.

## 118. Mensagens diretas e grupos privados no app instalado (PR fix/native-dm-unlock)

Caminhada da issue #347. O app instalado com a instalação (tipo `web`) passa o resultado PRF da passkey ao nó (`identity.install`, [rpc.md](rpc.md) 5.50), e o nó deriva as chaves de mensagens diretas, a chave de caixa dos grupos privados e as chaves de escrita dos grupos com o HKDF do worklet, porque o WebCrypto do Bare não tem HKDF. Antes, com a conta aberta, Conversas mostrava "Algumas conversas ainda não carregaram." e "Entre com sua passkey para continuar." e nenhuma conversa privada.

Regras que os passos conferem:

- Depois de entrar com a passkey, ou de abrir o app com a sessão guardada, Conversas lista as conversas privadas e "Pedidos de mensagem" sem o aviso "Entre com sua passkey para continuar.".
- O app publica a chave de mensagens (`dm.enable`) quando a conta ainda não tem uma, e uma conversa de ponta a ponta funciona entre o app e a web, nos dois sentidos, com texto, foto e mensagem de voz.
- Um aparelho que entra agora recebe só o que o semeador ainda guarda (7 dias, protocol seção 11) e o que chegar depois: o histórico mais antigo, guardado em outro aparelho, não é copiado. Nesse aparelho, uma conversa vai para a caixa de entrada quando a pessoa segue o outro membro, quando há uma mensagem própria enviada ou quando o aceite está entre as mensagens guardadas; senão aparece em "Pedidos de mensagem".
- Um grupo privado criado no app recebe e entrega chaves de época; outro aparelho da mesma passkey participa sozinho e recebe as chaves (manutenção de aparelho).
- Uma passkey de outra conta é recusada com "passkey não corresponde ao diário guardado" antes de o PRF entrar no nó: o app fica bloqueado e, ao entrar de novo com a passkey certa, as conversas guardadas no aparelho continuam lá.

Passos (marcar só depois de executar e guardar o registro), primeiro no Android (build de debug, emulador ou aparelho, feito depois de `npm run prepare:native -w apps/app`), depois no simulador iOS, depois na web e no PWA. O build de debug não entra com passkey numa instalação de produção (veja `docs/development.md`): os passos que pedem passkey real usam o APK de preview do EAS e, no iOS, um build com o domínio associado (TestFlight).

- [ ] Conta com conversas privadas na web: entrar no app com a mesma passkey. Conversas mostra as conversas dos últimos 7 dias, sem "Entre com sua passkey para continuar.".
- [ ] Fechar e abrir o app (sessão guardada): as conversas aparecem de novo sem pedir a passkey.
- [ ] Conta nova criada no app: a primeira abertura de Conversas publica a chave de mensagens; da web, outra conta encontra a do app em "Nova conversa" e envia uma mensagem, que chega ao app como pedido; aceitar e responder com texto, foto e voz; tudo chega à web.
- [ ] Mesmo par, mensagem enviada da web pela conta do app (mesma passkey nos dois): aparece no app como mensagem própria.
- [ ] Grupo privado criado no app: convidar uma conta da web, que entra e lê as mensagens; uma mensagem da web aparece no app.
- [ ] Segundo aparelho com a mesma passkey (outro telefone ou a web): entra no grupo privado sozinho e lê as mensagens novas.
- [ ] Entrar no app com a passkey de outra conta (Ajustes, Sair, depois "entrar com outra passkey"): aparece "passkey não corresponde ao diário guardado"; entrar de novo com a passkey certa mostra as mesmas conversas de antes.
- [ ] iOS (TestFlight) no mesmo aparelho que tem o PWA instalado: os mesmos passos de conversa e de grupo privado.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/identityInstall.test.js`, `node apps/app/test/identityRecoveryNative.test.js` e `node apps/app/test/dm.test.js`.
- `node packages/web-member/test/session-hkdf.test.js`, `node packages/web-member/test/passkey.test.js`, `node packages/web-member/test/group-keys.test.js`, `node packages/web-member/test/dm-store.test.js` e `node packages/web-member/test/dm.test.js`.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- O histórico de mensagens de um aparelho não passa para outro: um aparelho novo só recebe o que o semeador guarda (7 dias).
- Uma passkey de outra conta ainda tranca o app e apaga o cache de mídia aberta, como todo bloqueio; as mensagens guardadas não são apagadas.

## 119. Ações em linha única e folhas de mais ações (PR fix/mobile-action-hierarchy)

Caminhada da hierarquia de ações no celular: uma ação principal por tela, fileiras que não quebram e ações raras atrás do botão de mais. As telas estão em [app.md](app.md) ("Telas", "Conversas", "Comunidades") e as peças em [app-design.md](../apps/site/artwork/app-design.md) ("Componentes").

Regras que os passos conferem:

- Uma ação principal por linha, as raras atrás do botão de mais (`MoreButton`, que abre o `ActionsSheet`) em toda tela: Membro mostra no máximo duas pílulas (Seguir ou Seguindo, Mensagem) e o botão de mais; Agir como a página, Ajustes da página, Seguir como a página, Compartilhar perfil e Denunciar a conta ficam na folha de ações. O botão de mais só aparece com ao menos uma ação usável.
- O pedido de mensagem mostra só Aceitar e Recusar, em partes iguais, acima da barra de gestos; Bloquear e Apagar ficam no menu da conversa. O menu de mais da Mensagem é compacto e o campo diz "Mensagem".
- Toda confirmação que não se desfaz (Banir, Sair, Remover, Apagar versão) é uma `ConfirmStack`: a ação em cima, Cancelar embaixo, as duas em largura total. Apagar uma conversa confirma numa folha de ações compacta, com Apagar e Cancelar em largura total.
- `Pill` e `Btn` aceitam ícone, têm 40 pt de altura e nunca cortam o rótulo (no Android, "Trocar passkey" aparecia como "Trocar"). Sem rótulo, a pílula é um círculo de 40 pt com nome falado e alvo de 44 pt.
- Linha do perfil: duas pílulas em partes iguais e o botão de mais; com texto grande a linha empilha em vez de cortar. No Diário, Editar perfil ocupa a linha.
- Cabeçalho de publicação e de citação: o @nome cede primeiro e some a partir da escala de fonte 1,29 (o 1,3 do Android chega como 1,2999999); a data nunca é cortada e o nome fica com o resto. "1 seguidor" no singular.
- Título da `Sheet` com folga lateral e limite de escala de fonte; menus longos limitados a 85% da tela, com rolagem por dentro.
- Escape na web (`src/ui/escapeLayer.js`): uma pilha compartilhada por folhas, menus, visualizador de foto e editor de foto; só a camada do topo fecha, e a tela de baixo não volta junto. Numa subpágina de Ajustes, Escape volta para a lista. O Android volta da subpágina de Ajustes para a lista com o botão voltar.
- Na web, o `Backdrop` não é parada de foco e o guarda de `src/ui/scrollerFocus.web.js` impede que o foco caia num corpo que rola (sem anel em volta da folha inteira). `html` e `body` ficam com `overflow: hidden` (sem pan da viewport).
- No Android, a área do teclado só entra no cálculo com o teclado aberto (`src/ui/keyboardAvoid.js`): sem isso a barra de escrita ficava sobre uma faixa vazia depois de fechar o teclado (Mensagem, Grupo, Perfil).
- Na Informação da comunidade, Sair fica no botão de mais da tela; na comunidade e nos Ajustes do grupo, Banir fica no botão de mais de cada pessoa (no grupo, também Tornar e Tirar admin), e nos Ajustes do grupo Sair do grupo segue como botão no fim e Desbanir e Tirar admin seguem como pílulas nas suas seções; Aprovar e Recusar são ícones; Quem pode convidar e Entrada são pílulas com chevron que abrem uma folha com a escolha atual marcada com um visto; painéis e divisor alinhados. Linhas de pessoa (membros e pedidos) têm avatar à esquerda.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/fix/mobile-action-hierarchy/<plataforma>/` (rodadas r1 a r15, Android, simulador iOS e Chrome), gravadas por `apps/app/scripts/review-shots.sh`, e o registro das rodadas em `~/Workspace/evidencias/fix/mobile-action-hierarchy/rounds.md`.

Como verificar, a partir de `apps/app` (um arquivo por vez):

- `node test/uiKit.test.js`, `node test/profileActions.test.js`, `node test/chatActions.test.js`, `node test/postOverflow.test.js`, `node test/escapeLayer.test.js`, `node test/scrollerFocus.test.js`, `node test/passkeysScreen.test.js`, `node test/group-flow.test.js`, `node test/groups.test.js`, `node test/conversas.test.js`, `node test/profileSave.test.js`, `node test/mediaCrop.test.js`, `node test/pwa.test.js`.
- `npm run lint`, a partir da raiz, que tem de passar.

Primeiro no Android (build de debug, emulador `varanda-api36`, Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`), depois no simulador iOS, depois no Chrome:

- [ ] Android: Membro de outra pessoa; Seguindo e Mensagem numa linha, com o botão de mais; a folha abre com Denunciar a conta em vermelho.
- [ ] Android: Diário; Editar perfil ocupa a linha, sem quebra.
- [ ] Android: Conversas › Pedidos de mensagem › um pedido; Aceitar e Recusar em partes iguais, acima da barra de gestos.
- [ ] Android: no mesmo pedido, menu da conversa › Apagar conversa neste aparelho; a confirmação é uma folha de ações com Apagar (com a frase) e Cancelar, em largura total.
- [ ] Android: Comunidade › Informações; dados e ações centralizados; Membros e Pedidos com avatar; o botão de mais de uma pessoa abre Banir; Quem pode convidar abre a folha com a escolha atual.
- [ ] Android: Grupo › Ajustes; o mesmo seletor de Quem pode convidar, pedidos com Aprovar e Recusar, linhas com avatar, o botão de mais de uma pessoa.
- [ ] Android: Editar perfil; a versão do perfil com a lixeira ao lado; tocar abre a pilha Apagar versão/Cancelar. Escolher foto abre o editor com as setas e o zoom sem corte.
- [ ] Android: Ajustes › Passkeys e recuperação; Adicionar passkey, Trocar passkey (inteiro, sem corte) e Criar código de recuperação; Trocar passkey abre a pilha Adicionar a nova passkey/Cancelar.
- [ ] iOS (simulador iPhone 16e, build de debug ligado ao Metro): as mesmas telas.
- [ ] Chrome em 390 px e em 1280 px, nos temas claro e escuro: as mesmas telas; na web, Escape fecha só a camada de cima (folha, menu, visualizador ou editor de foto) e, numa subpágina de Ajustes, volta para a lista.
- [ ] Android: abrir o teclado em Mensagem, Grupo e Perfil e fechá-lo; a barra de escrita volta ao rodapé sem faixa vazia. Em Ajustes, entrar numa subpágina e usar o botão voltar do sistema: volta para a lista.
- [ ] Texto grande (Android `font_scale` 1.3, iOS `accessibility-large`) e movimento reduzido: as mesmas telas sem rótulo cortado nem fileira quebrada; o @nome some dos cabeçalhos de publicação e citação e a data fica inteira; a linha do perfil empilha.

Ainda falta a um humano, em aparelho real (nenhuma caixa acima foi executada nesta documentação):

- [ ] celulares Android e iPhone físicos, não só emulador e simulador: as telas acima, o teclado e o texto grande.
- [ ] TalkBack e VoiceOver: o botão de mais, a lixeira, o círculo Compartilhar e os seletores com chevron leem o nome certo; a folha de ações lê as linhas e o foco volta ao botão que a abriu.
- [ ] iOS: as rodadas visuais 8 a 12 não rodaram no simulador (a ferramenta esperava aprovação por aparelho); as rodadas 6, 7 e 13 a 15 rodaram, e as duas últimas saíram limpas. Falta o iPhone físico.
- [ ] Android: a revisão final do teclado e do botão voltar em Ajustes (única checagem pendente no Android).

Pontos conhecidos, deixados como estão (P3):

- Cabeçalho de publicação e de citação com texto de acessibilidade extra-grande, tela de 320 pt e data de ano anterior: o nome fica com cerca de 80 pt na publicação e 40 pt no cartão de citação; não chega a zero, mas rever se um aparelho mostrar o contrário.
- Visualizador de foto da conversa: ícones da barra de status escuros sobre o fundo preto no Android (já era assim; a correção pede definir a barra antes de abrir o Modal ou trocar o Modal por uma sobreposição).
- Texto: "Fechar" e "Cancelar" ainda variam entre telas; "serviço indisponível" e "foto indisponível" em minúscula; marcador monoespaçado do convite; Perfil como folha no Diário e como página nos Ajustes; iniciais do cabeçalho de pedido contra o ícone da lista; o rótulo Denunciar na publicação e no perfil tem tintas diferentes (fixado pelos testes de `postActions`).
- Web: anel de foco do Fechar sem folga; seta de voltar de 40 x 40; foco depois de Escape volta ao topo em vez de à lista; campo da Busca 4 pt abaixo do de Conversas; abas da Busca sem `aria-selected`; foco depois de fechar a Publicar com Escape; o rascunho do Perfil zera ao voltar para a lista de Ajustes (igual com a seta; já era assim).
- Compartilhar sem origem da instalação mostra "Não foi possível copiar o link." (`communityShare.js`, fora desta PR).

Limites desta caminhada:

- Na Vitrine, Passkeys responde "serviço indisponível": a lista de passkeys com itens e a remoção se conferem no laboratório hospedado.
- Compartilhar perfil só aparece com a origem da instalação, que a Vitrine nativa não tem.

## 120. Mural de fotos no perfil (PR feat/profile-mural)

Caminhada do Mural: as abas Publicações e Mural no Diário e no perfil de outra pessoa (Membro). A tela está em [app.md](app.md) ("Mural") e as peças em [app-design.md](../apps/site/artwork/app-design.md) ("Abas do perfil", "Mural").

Regras que os passos conferem:

- O Mural é uma projeção das publicações que a tela já leu (`src/mural.js`): no Diário, as linhas do `log.read`; em Membro, os itens montados das páginas do índice, com o corte de página movida (`applyCut`). Entram só publicações (`post`) com foto, sem `replyTo` e sem citação; respostas, republicações e citações nunca viram quadrado. Uma publicação com data mais de 24 h no futuro fica escondida, como no feed.
- Uma lista só por tela (`RefreshableList`): o Mural troca as linhas, não a lista, então puxar para atualizar, a barra fixa do perfil e a rolagem continuam; a aba escolhida e a rolagem voltam iguais depois de abrir uma foto.
- Faltando foto, a tela lê páginas mais antigas sozinha até 6 páginas (`fillState`); depois, só a pílula "Ver mais" lê mais uma, nunca a rolagem. Uma página só conta quando a leitura começa de fato, a contagem zera quando a lista é recarregada, e uma atualização que falha não deixa a pílula presa.
- "Nenhuma foto ainda" só aparece quando a fonte acabou de verdade; antes disso, "Ver mais". "Algumas fotos podem faltar" quando o índice diz que está incompleto.
- Tocar numa foto abre a conversa da publicação com a publicação já carregada como semente (sem internet, a conversa ainda mostra a publicação e as fotos).
- Fotos de quem a pessoa não segue são buscadas sem guardar cópia no aparelho (`persist` falso), como no resto do app.
- Membro sem internet, ou fora do nó hospedado: o aviso de sempre, sem a aba Mural e sem leitura remota.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/feat/profile-mural/<plataforma>/` (rodadas r1 em diante, Android, simulador iOS e Chrome).

Como verificar, a partir de `apps/app` (um arquivo por vez):

- `node test/mural.test.js`, `node test/muralGrid.test.js`, `node test/muralScreen.test.js`, `node test/vitrine.test.js`, `node test/vitrineIndex.test.js`, `node test/vitrineGuard.test.js`, `node test/mediaFetch.test.js`.
- `npm run lint`, a partir da raiz, que tem de passar.

Primeiro no Android (build de debug, emulador `varanda-api36`, Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`), depois no simulador iOS, depois no Chrome:

- [ ] Android: Diário › Mural; quadrados com 2 pt entre colunas e fileiras, selo de várias fotos no canto, "Fim do Mural" no fim, a barra de abas não cobre a última fileira.
- [ ] Android: tocar numa foto abre a conversa com as fotos; voltar mantém a aba Mural e a rolagem.
- [ ] Android: puxar para atualizar na aba Mural; a barra fixa do perfil aparece ao rolar.
- [ ] Android: Membro de João (seguido) e de Bia (não seguida) › Mural; a última fileira curta fica com células vazias; Cecília e a página Biblioteca da Praça mostram o estado vazio.
- [ ] iOS (simulador, build de debug ligado ao Metro): as mesmas telas.
- [ ] Chrome em 375 px, 1280 px e 320 px, nos temas claro e escuro: as mesmas telas; Tab passa pelas abas e pelos quadrados; a aba escolhida tem `aria-selected`.
- [ ] Texto grande (Android `font_scale` 1.3, iOS `accessibility-large`): 2 colunas, rótulos das abas inteiros.
- [ ] Laboratório hospedado com duas identidades: publicar uma foto na primeira, ver no Mural dela no aparelho da segunda, apagar a publicação e ver o quadrado sumir depois de atualizar.

Ainda falta a um humano, em aparelho real:

- [ ] celulares Android e iPhone físicos: as telas acima, com fotos de verdade.
- [ ] TalkBack e VoiceOver: as abas leem nome e estado; cada quadrado lê "foto" ou "N fotos" e a data.
- [ ] um diário longo de verdade, com mais de 6 páginas sem foto entre as fotos: a pílula "Ver mais" aparece e não diz "vazio".

Limites desta caminhada:

- A Vitrine responde as fotos das publicações por um responder local de `/media` (`src/vitrine/publicMedia.js`, só no bundle de desenvolvimento); o caminho real (semeador, tamanho e SHA-256 conferidos) é o mesmo código, e a única coisa trocada é o transporte.
- Na Vitrine, nenhuma pessoa tem foto suficiente para mostrar "Ver mais".

## 121. Ponte de comunidades para a conversa privada (PR feat/community-bridge)

Caminhada da ponte entre comunidades, publicações e conversa privada: o menu de pessoa na comunidade e no grupo, "Mensagem em particular" nas publicações, a faixa de comunidades nos perfis e a busca de comunidades mais clara. As telas estão em [app.md](app.md) ("Conversar em particular", "Comunidades no perfil") e as peças em [app-design.md](../apps/site/artwork/app-design.md) ("Menu de pessoa", "Contexto na conversa", "Faixa de comunidades").

Regras que os passos conferem:

- **Menu de pessoa.** Na lista de Membros da comunidade (criador e administradores), o botão de mais e o toque longo de cada pessoa abrem a mesma folha: Conversar em particular, Ver perfil e as ações de administração. Escolher uma linha do toque longo executa a ação (a folha fica montada até fechar). No grupo, as ações da mensagem de outra pessoa têm Conversar em particular, que usa o diário conferido da mensagem, nunca o escritor, e não leva nada do grupo.
- **Mensagem em particular.** Aparece nas ações de uma publicação de outra pessoa no nó hospedado, nunca na própria nem na de uma página. Abre a conversa com o autor e mostra um chip de contexto acima do campo. Só a conversa no topo da pilha consome o pedido; uma conversa por baixo não muda.
- **Envio com contexto.** Só envia com texto escrito pela pessoa: a mensagem é `Sobre a sua publicação "<trecho de até 60 caracteres>" (<data>): <texto>`, ou "Sobre a sua foto" sem texto, com a data absoluta (nunca "5 min"). O total cabe em 1000 caracteres e o contador do campo já desconta o prefixo. Uma nova tentativa depois de um envio incerto manda exatamente o mesmo texto. O contexto nunca vira `replyTo`.
- **Faixa de comunidades.** No seu Diário, Suas comunidades (as que você criou, administra ou é membro, de `community.list`); no perfil de outra pessoa, só Comunidades em comum: no máximo 8 das suas comunidades, conferidas uma de cada vez na lista de membros (`community.members`, em ordem de chave, até 10 páginas por comunidade, sem banidos). A lista completa de outra pessoa nunca aparece. O Diário relê a lista ao voltar à aba e quando um grupo muda.
- **Comunidades.** Minhas comunidades e Descobrir em seções; a busca mostra a comunidade de cada grupo e os estados de carregando, erro com Tentar de novo, resultado parcial e busca indisponível.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/feat/community-bridge/<plataforma>/`.

Como verificar, a partir de `apps/app` (um arquivo por vez):

- `node test/privateReply.test.js`, `node test/communitiesBox.test.js`, `node test/communitiesBoxScreen.test.js`, `node test/groupScreen.test.js`, `node test/dm.test.js`, `node test/postActions.test.js`, `node test/conversasList.test.js`, `node test/conversas.test.js`.
- `npm run lint`, a partir da raiz, que tem de passar.

Primeiro no Android (build de debug, emulador `varanda-api36`, Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`), depois no simulador iOS, depois no Chrome:

- [ ] Android: A Rua › uma publicação de João › mais › Mensagem em particular; a conversa abre com o chip; Enviar só com texto; a mensagem enviada começa com o prefixo e o chip some; o X tira o chip sem enviar.
- [ ] Android: com o teclado aberto, o chip e o campo ficam acima do teclado.
- [ ] Android: perfil de João › Comunidades em comum acima das abas; tocar numa comunidade a abre; o seu Diário mostra Suas comunidades.
- [ ] Android: Comunidades › Minhas comunidades e Descobrir; buscar "horta".
- [ ] Android: uma comunidade › Informações › Membros; o mais e o toque longo de uma pessoa abrem a folha; Ver perfil abre o perfil.
- [ ] iOS (simulador, build de debug ligado ao Metro): as mesmas telas.
- [ ] Chrome em 375 px e 1280 px, temas claro e escuro: as mesmas telas; o X do chip tem nome e entra na ordem do Tab.
- [ ] Texto grande (Android `font_scale` 1.3, iOS `accessibility-large`): chip, faixa e folhas sem corte.
- [ ] Laboratório hospedado com duas identidades na mesma comunidade pública: a segunda vê Comunidades em comum no perfil da primeira; Mensagem em particular a partir de uma publicação chega à primeira só depois de Enviar, com o prefixo.

Ainda falta a um humano, em aparelho real:

- [ ] celulares Android e iPhone físicos: as telas acima.
- [ ] TalkBack e VoiceOver: a folha de pessoa, o chip (com o X "remover contexto") e a faixa de comunidades.
- [ ] uma comunidade grande de verdade, com mais de 100 membros: a outra pessoa numa página depois da primeira ainda aparece em comum.

Limites desta caminhada:

- Na Vitrine, as comunidades e os membros são fictícios e sempre respondem; o tempo das leituras em série de `community.members` num nó real fica para o laboratório.
- A lista de Membros continua só para criador e administradores; quem não administra chega à conversa privada pelo grupo e pelas publicações.


## 122. Depoimentos no perfil (PR feat/depoimentos)

Caminhada dos Depoimentos: escrever um depoimento para outra pessoa, aprovar no próprio Diário, mostrar no perfil, tirar do perfil e retirar o que escreveu. As telas estão em [app.md](app.md) ("Depoimentos") e as peças em [app-design.md](../apps/site/artwork/app-design.md) ("Depoimentos no perfil", "Linha de depoimento"). O contrato está em [rpc.md](rpc.md) 5.100 e o formato dos registros em [protocol.md](protocol.md).

Regras que os passos conferem:

- **Selado até mostrar.** Quem escreve publica no próprio diário só um compromisso (`testimonial`: destinatário, geração da chave, hash e caixa selada). O texto fica legível só para quem recebe; ele vira público apenas quando a pessoa escolhe Mostrar no perfil, que publica um `testimonial-show` no diário dela com o texto e o nonce.
- **Ninguém escreve para si.** `testimonial.write` para a própria chave responde "não pode escrever um depoimento para si"; para quem ainda não tem chave de mensagens, "a pessoa ainda não recebe mensagens". O texto tem de 1 a 400 caracteres.
- **Depoimentos para aprovar.** Só no seu Diário: a lista de `testimonial.pending`, um por pessoa, sem os já mostrados. Mostrar no perfil publica; Agora não esconde só neste aparelho e não grava registro. Mostrar de novo o mesmo depoimento não escreve nada.
- **Remover do perfil e Retirar.** Remover do perfil apaga todos os `testimonial-show` daquela pessoa no seu diário, para um antigo não voltar; o depoimento removido não volta para a lista de aprovar. Retirar (quem escreveu) apaga o bloco selado, e o depoimento some do perfil de quem recebeu: o nó da web confere cada `testimonial-show` contra o bloco vivo de quem escreveu (hash, destinatário, não retirado) e manda o que falha para `invalid`.
- **Perfil.** O índice do semeador (`/index/testimonials/<dono>`) só dá ponteiros, nunca texto; o texto vem do `diary.peek` do diário de quem recebeu, conferido, e passa por `displayText`. Sem curtidas, sem contagem e sem resposta. Cada linha tem Denunciar.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/feat/depoimentos/<plataforma>/`.

Como verificar, a partir de `apps/app` (um arquivo por vez):

- `node test/testimonials.test.js`, `node test/indexClient.test.js`, `node test/legal.test.js`, `node test/vitrine.test.js`, `node test/vitrineIndex.test.js`, `node test/vitrineGuard.test.js`, `node test/vitrineLarge.test.js`.
- A partir da raiz: `node packages/core/test/testimonials.test.js`, `node packages/core/test/records.test.js`, `node packages/web-member/test/session-e2e.test.js` (Node 20.19 ou mais novo).
- `npm run lint`, a partir da raiz, que tem de passar.

Primeiro no Android (build de debug, emulador `varanda-api36`, Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`), depois no simulador iOS, depois no Chrome. Na Vitrine, Lia mostra os depoimentos de João e de Cecília, tem o de Bia para aprovar e escreveu um para João, que ele mostra:

- [ ] Android: Diário de Lia com as abas Publicações, Mural e Depoimentos numa linha, sem corte, e nada entre as abas e o conteúdo; aba Depoimentos com João e Cecília, o mais novo primeiro; o texto longo de João quebra em várias linhas sem corte; nenhuma contagem nem curtida.
- [ ] Android: na aba Depoimentos, abrir o perfil de João por uma linha e voltar: a aba Depoimentos continua escolhida.
- [ ] Android: aba Depoimentos do Diário começa com "Depoimentos para aprovar (1)" e "Enviados", linhas de 44 pt com seta; a primeira abre a tela com o de Bia; Agora não esconde a linha; reabrir o app no mesmo aparelho continua sem a linha e sem a linha fixa.
- [ ] Android: com a linha de Bia de volta (dados do app limpos), Mostrar no perfil; a linha sai da lista e aparece na aba Depoimentos.
- [ ] Android: Remover do perfil no depoimento de Bia; a folha tem o título "Remover do perfil?" sem corte e o nome de Bia no texto; some do perfil e não volta para aprovar.
- [ ] Android: perfil de João › aba Depoimentos com o de Lia; Retirar depoimento (como Lia, no mais da linha ou do perfil), folha "Retirar depoimento?" com o nome de João no texto, e ver o depoimento sumir do perfil de João depois de atualizar.
- [ ] Android: perfil de Cecília › aba Depoimentos vazia com "Nenhum depoimento ainda" e "Toque em ⋯ no perfil para escrever um depoimento."; mais › Escrever depoimento, folha "Escrever depoimento" com o campo "Para Cecília"; contador até 400 (200 emojis contam 200, o campo aceita até 400 emojis e Enviar desliga acima de 400); enviar para si mesma não aparece como opção.
- [ ] iOS e Android com texto grande (accessibility-large, 1.3): na folha "Escrever depoimento" com o teclado aberto, Enviar fica no topo da folha, o campo para de crescer depois de umas seis linhas e rola por dentro, e o contador e o aviso de aprovação rolam para cima do teclado; tocar fora do campo não perde o texto.
- [ ] Android: com um nó que não é hospedado (`node.hosted` diferente de `true`), o perfil mostra só Publicações e Mural.
- [ ] iOS (simulador, build de debug ligado ao Metro): as mesmas telas.
- [ ] Chrome em 375 px, 1280 px e 320 px, nos temas claro e escuro: as mesmas telas; Tab passa por Mostrar no perfil, Agora não e Denunciar.
- [ ] Texto grande (Android `font_scale` 1.3, iOS `accessibility-large`): as três abas numa linha, sem corte; linhas de depoimento, linhas fixas e botões sem corte; títulos das folhas sem corte.
- [ ] Laboratório hospedado com duas identidades: a primeira escreve para a segunda; a segunda vê em Depoimentos para aprovar e toca Mostrar no perfil; no aparelho da primeira, o perfil da segunda mostra o depoimento; a segunda toca Remover do perfil e some; a primeira escreve de novo, a segunda mostra, e a primeira toca Retirar depoimento: some do perfil da segunda nos dois aparelhos.

Ainda falta a um humano, em aparelho real:

- [ ] celulares Android e iPhone físicos: as telas acima.
- [ ] TalkBack e VoiceOver: cada linha lê o nome, a data e o texto; os botões Mostrar no perfil, Agora não, Remover do perfil, Retirar depoimento e Denunciar têm nome; as abas leem Publicações, Mural e Depoimentos.
- [ ] aceite dos Termos e da Política na versão 30 numa instalação já aceita na versão anterior.

Limites desta caminhada:

- A Vitrine não cifra nada: a caixa dos fixtures é preenchimento do tamanho de uma caixa selada real, e o texto é aberto por uma tabela local. O hash é o SHA-256 real, então o compromisso, a conferência do `testimonial-show` e o `invalid` de um bloco retirado são os mesmos do nó da web.
- Na Vitrine, o índice `/index/testimonials/<dono>` responde do estado local da Vitrine aberta; a conferência no semeador real fica para o laboratório hospedado.

## 123. Momentos (PR feat/momentos)

Caminhada dos Momentos: publicar uma foto com texto curto que aparece por 24 horas para quem segue, ver os momentos de quem você segue, responder em particular e apagar o seu. As telas estão em [app.md](app.md) ("Momentos") e as peças em [app-design.md](../apps/site/artwork/app-design.md) ("Faixa de momentos", "Visualizador de momento", "Publicar em Momento", "Momentos no Diário"). O contrato está em [rpc.md](rpc.md) 5.113 e o formato do registro `moment` em [protocol.md](protocol.md).

Regras que os passos conferem:

- **Só no nó web (navegador ou worklet nativo).** A faixa, o modo Momento de Publicar e as linhas do Diário dependem de `node.hosted === true`; o nó core responde `USAGE` para `moment.create`, `moments.read` e `moment.delete`.
- **24 horas, do lado de quem lê.** Um momento some da faixa, do visualizador e de "Seus momentos (24 h)" quando passam 24 h do `at`. Um momento datado mais de 10 minutos à frente do relógio de quem lê espera a hora chegar. Esconder não é apagar: o registro fica no diário, e os seus aparecem em "Momentos anteriores" até você apagar.
- **A foto tem vida curta.** Ela vai para o depósito anônimo de blobs (um blob novo por momento, com a chave e o nonce públicos no registro), e os semeadores a apagam em até 7 dias. Depois disso o visualizador mostra "Foto indisponível", nunca um erro.
- **Sem curtidas, sem contagem de visualizações, sem resposta pública.** "Responder" abre a conversa privada com quem publicou, com o chip de contexto. O visto do anel fica só no aparelho e não grava registro.
- **Apagar.** Só o seu momento, no ar ou anterior: `moment.delete` de outra pessoa ou de outro tipo de registro responde "referência inválida". A confirmação diz que cópias feitas por outras pessoas não voltam, e o momento no ar traz a nota "A foto sai dos servidores em até 7 dias.".
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado. As capturas ficam fora do git, em `~/Workspace/evidencias/feat/momentos/<plataforma>/`.

Como verificar, a partir de `apps/app` (um arquivo por vez):

- `node test/moments.test.js`, `node test/momentosScreen.test.js`, `node test/legal.test.js`, `node test/vitrine.test.js`, `node test/vitrineIndex.test.js`, `node test/vitrineGuard.test.js`, `node test/vitrineLarge.test.js`.
- A partir da raiz: `node packages/core/test/moments.test.js`, `node packages/core/test/records.test.js`, `node packages/rpc/test/methods.test.js`, `node packages/web-member/test/moments-e2e.test.js` (Node 20.19 ou mais novo).
- `npm run lint`, a partir da raiz, que tem de passar.

Primeiro no Android (build de debug, emulador `varanda-api36` ou aparelho, Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`), depois no simulador iOS, depois no Chrome e no PWA, cada um nos temas claro e escuro e com texto normal e grande (Android `font_scale` 1.3, iOS `accessibility-large`). Na Vitrine, Lia segue João (dois momentos), Cecília e André (um cada), tem um momento seu no ar e dois anteriores; as datas seguem o relógio da demonstração, deslocado para a hora do aparelho, então os momentos estão sempre dentro das 24 h:

- [ ] Android: A Rua começa com a faixa de momentos; o anel "Você" vem primeiro, depois João, Cecília e André; todos com o anel verde de não visto; nomes numa linha, sem corte.
- [ ] Android: abrir João; a barra mostra dois segmentos; tocar à direita passa para o segundo, à esquerda volta; segurar pausa a barra; sem tocar, o momento passa sozinho em 5 s e, depois do último, vem a próxima pessoa da faixa; deslizar para baixo fecha.
- [ ] Android: depois de ver João, o anel dele fica com a cor de linha e vai para depois dos não vistos; reabrir o app no mesmo aparelho mantém isso.
- [ ] Android: com "Remover animações" (Reduzir movimento) ligado, o momento não passa sozinho; tocar à direita ainda avança.
- [ ] Android: no momento de João, "Responder" abre a conversa privada com João e o chip de contexto do momento acima do campo; o chip sai com o X.
- [ ] Android: em nenhum momento aparece curtida, coração, contagem de visualizações ou campo de resposta pública.
- [ ] Android: o seu momento mostra a nota "A foto sai dos servidores em até 7 dias." e "Novo momento"; o botão de mais tem Apagar; a folha "Apagar momento?" apaga e o anel "Você" volta a ter o "+".
- [ ] Android: tocar no anel "Você" com o "+" abre Publicar já em "Publicação | Momento", em Momento. Escolher foto, depois Trocar foto: fica uma foto só; tentar mais de uma diz "Um momento leva uma foto só."; o contador vai até 200 (200 emojis contam 200) e Publicar desliga acima disso; o momento aparece primeiro na faixa.
- [ ] Android: com um rascunho em Publicação, trocar para Momento: aparece "Seu rascunho da publicação continua guardado."; voltar para Publicação traz o rascunho e as fotos dele. Com o envio de um momento sem confirmação (rede cortada no meio), o rascunho do momento fica parado com "Descartar" e o aviso para conferir em Seus momentos; nada é enviado de novo sozinho.
- [ ] Android: Diário de Lia mostra, abaixo do topo do perfil e fora das abas, "Seus momentos (24 h)" (abre o visualizador) e "Momentos anteriores (2)", recolhida; abrir mostra os dois com data e começo do texto; Apagar num deles deixa "Momentos anteriores (1)".
- [ ] Android: num momento cuja foto já saiu do servidor (laboratório, com o relógio do semeador adiantado 8 dias, ou um blob apagado à mão), o visualizador mostra "Foto indisponível" no lugar da foto, sem banner de erro, e o texto continua.
- [ ] iOS (simulador, build de debug ligado ao Metro): os mesmos passos; deslizar para baixo fecha sem abrir a central de notificações; com "Reduzir movimento" ligado, nada passa sozinho.
- [ ] Chrome em 375 px, 1280 px e 320 px, e o PWA instalado: os mesmos passos; Tab chega aos anéis, ao botão de fechar, ao de mais e a "Responder"; Escape fecha o visualizador.
- [ ] Texto grande: nomes da faixa numa linha (encolhem um pouco e só um nome longo termina em "…"); a nota, "Responder", "Novo momento", as linhas do Diário e a escolha "Publicação | Momento" sem corte.
- [ ] Com um nó que não é hospedado (`node.hosted` diferente de `true`): sem faixa em A Rua, sem "Publicação | Momento" em Publicar e sem linhas de momentos no Diário.
- [ ] A regra das 24 horas, no laboratório hospedado: um momento publicado some da faixa e do visualizador de quem segue depois de 24 h (relógio do aparelho adiantado 24 h) e passa para "Momentos anteriores" de quem publicou; um registro `moment` datado 1 h à frente (escrito à mão no laboratório) só aparece quando a hora chega.
- [ ] Termos de Uso e Política de Privacidade na versão 31 apresentados para novo aceite numa instalação já aceita na versão 28; o texto diz que o momento deixa de aparecer depois de 24 horas, que a foto sai dos servidores da Varanda em até 7 dias, que o texto fica no diário até a pessoa apagar e que cópias feitas por outras pessoas não voltam.
- [ ] Laboratório hospedado com duas identidades (`apps/cli/scripts/hosted-lab.js`, dois perfis do navegador, ou um aparelho e um perfil): A publica um momento; B segue A e vê o anel de A na faixa, abre e vê a foto e o texto; B toca "Responder" e manda uma mensagem, que chega a A com o contexto; A apaga o momento; em B, depois de atualizar, o anel de A some e o momento não abre mais.

Ainda falta a um humano, em aparelho real:

- [ ] celulares Android e iPhone físicos: as telas acima, com uma foto da câmera.
- [ ] TalkBack e VoiceOver: cada anel lê "momentos de <nome>" ("seu momento" no seu); o visualizador lê "momento N de M", o nome, a hora e o texto; os botões fechar, mais ações, Responder, Novo momento e Apagar têm nome.
- [ ] Publicar um momento com a chave de mensagens bloqueada pede para desbloquear com a passkey ("Desbloqueie com a passkey para publicar um momento.").

Limites desta caminhada:

- A Vitrine não sobe nada: a foto de um momento é um dos desenhos locais da Vitrine (ou a foto escolhida, guardada só na memória da página), e o blob, a chave e o nonce são de mentira. A busca no semeador, a decifração e a conferência do tamanho e do SHA-256 ficam para o laboratório hospedado.
- Na Vitrine, as datas dos momentos são as do relógio da demonstração (5 nov, 15 h), deslocadas para a hora do aparelho; os momentos anteriores são os que já passaram das 24 h nesse relógio.

## 124. Aviso de rede cheia antes da passkey (PR feat/signup-seats-before-passkey)

Caminhada do aviso de rede cheia na tela Entrar. O serviço de conta responde `GET /account/admission` com exatamente `{ "open": true }` ou `{ "open": false }` (público, sem autenticação, mesmo limite de consultas de `GET /account/invites/policy`; `false` só enquanto `VARANDA_MAX_MEMBERS` está batido, nunca uma contagem). O app hospedado (web, e o app instalado ligado a uma instalação hospedada) pergunta antes de "Criar passkey". Telas em [app.md](app.md) ("Rede cheia"); contrato em [README.md](../README.md) ("Vínculo de conta Google e @nome").

O que muda:

- Com `open: false`, a tela Entrar mostra "A Varanda está cheia por enquanto..." com o botão "tentar de novo" e não oferece "Criar passkey", "criar mesmo assim" nem "criar com o celular".
- "Entrar com a passkey", "entrar com o celular", outra passkey, o código de recuperação, "concluir a criação da passkey" e "Criar passkey nova" depois de um código de recuperação seguem funcionando.
- Se a leitura falha (rede, serviço antigo que responde 404, outro corpo), o app não bloqueia.

O que não muda:

- A leitura não reserva vaga, e um convite não abre vaga. `required: false` na política de convites continua não significando que há vaga.
- As recusas "lista-de-espera" seguem em `POST /account/start`, na volta do Google (redireciona para `/?conta=lista-de-espera`), em `POST /account/finish` e em `POST /account/age/session`.
- A configuração manual, uma configuração digitada à mão na página hospedada e o `varanda-serve` não perguntam e mantêm o comportamento de antes.

Como verificar, a partir da raiz (um arquivo por vez):

- `node apps/cli/test/account.test.js`, `node apps/app/test/account.test.js`, `node apps/app/test/signupAdmission.test.js`, `node apps/app/test/passkeysScreen.test.js`, `node apps/app/test/passkeyTrouble.test.js`, `node apps/app/test/platformGate.test.js` e `node apps/site/test/site.test.js`.

Com `VARANDA_MAX_MEMBERS` igual ao número de contas vinculadas, primeiro no Android (build de debug), depois no simulador iOS, depois na web e no PWA:

- [ ] Android: com o teto cheio, a tela Entrar mostra a frase de rede cheia e "tentar de novo", e nenhum "Criar passkey".
- [ ] Android: "Entrar com a passkey" ainda abre uma conta existente.
- [ ] Android: com o serviço de conta parado, "Criar passkey" aparece.
- [ ] Android: depois de abrir uma vaga (subir o teto e reiniciar o serviço), "tentar de novo" mostra "Criar passkey".
- [ ] Android: trocar de instalação pergunta de novo.
- [ ] iOS (simulador): os mesmos cinco passos.
- [ ] Web: os mesmos cinco passos; na aba Rede aparece um único `GET /account/admission` por tentativa, e uma configuração digitada à mão não o faz.
- [ ] PWA instalado: os mesmos cinco passos.

Limites:

- Uma vaga pode acabar entre a leitura e o vínculo; o serviço recusa nesse caso.
- A leitura é um pedido só, não uma reserva.
- Uma configuração digitada à mão na página hospedada não recebe o aviso antecipado.

## 125. Recurso de quem foi bloqueado (PR feat/moderation-appeal, 2026-10-30)

### O que mudou

- `packages/core/lib/appeal.js`: declaração `varanda-appeal-v1` (nonce, membro, associação e `digest(texto)`), assinada pela chave do diário. Sem alvo: o recurso é sempre sobre a própria chave. Método RPC `appeal.sign` (`docs/rpc.md` 5.99) só no nó do navegador; o nó core, o `varanda-serve` e a CLI respondem `USAGE` `'assinatura disponível só no navegador'`.
- Serviço de conta (`apps/cli/lib/account/mod-routes.js`): `POST /account/appeal/start` (só membro com conta Google vinculada; nonce sem estado, domínio `varanda-appeal-nonce`, 600 s) e `POST /account/appeal` (confere o nonce, a assinatura e grava; o nonce só é gasto depois de a assinatura valer). Respostas `{ id, duplicate }`; `nao-bloqueado` (403) se a chave não está na lista publicada nem tem bloqueio pendente; `limite-recursos` (429) para um novo recurso em 30 dias depois de um recurso negado; `limite` (503) com 2000 abertos ou 20000 guardados.
- `moderation.json` passa a `v: 3` com `appeals` (linha: `id`, `at`, `member`, `text`, `nonce`, `signature`, `status` `aberta`/`aceito`/`negado`/`encerrado`, `decidedBy`, `decidedAt`, `note`). Um `v: 1` ou `v: 2` é lido sem recursos e regravado como `v: 3`. Linha malformada deixa o armazém `indisponivel`, como as denúncias. Eventos novos: `recurso-aceito`, `recurso-negado` e `recurso-encerrado` (a chave deixou de estar bloqueada com o recurso aberto: desbloqueio, bloqueio cancelado ou lista publicada sem ela), com `appealId`; nunca o texto, a assinatura, o nonce nem a nota.
- Painel: `GET api/appeals?estado=aberta|decidida` (a decidida aceita `antes=<id>`, como `api/reports`, e a aba tem "mostrar mais") e `POST api/appeals/<id>/decide { decision: 'aceitar'|'negar', note }`. O recurso fica fora da lista e responde `nao-encontrado` para a própria pessoa recorrente e para quem decidiu (por e-mail) uma denúncia `bloquear` daquela chave; a IA não conta como pessoa. `api/me` ganha `appeals` (abertos que a pessoa pode julgar). Aceitar acrescenta uma mudança `unblock` como o botão Desbloquear (se havia um bloqueio pendente ainda não enviado, as duas se anulam), e conta como reversão humana para a triagem por IA; negar não mexe em Pendentes.
- App: Ajustes › Recorrer de um bloqueio (`apps/app/src/screens/Recurso.js`, `apps/app/src/appeal.js`).
- Termos de Uso e Política de Privacidade versão 22, com novo aceite (`LEGAL_VERSION` e `TERMS_VERSION` 22): os Termos descrevem o recurso e a Política diz o que o serviço de conta guarda dele (chave pública, texto opcional, assinatura, data, estado, decisão e nota de quem julgou), quem o lê e que não é apagado automaticamente (issue #38).

### Testes automatizados

- `packages/core/test/appeal.test.js`: bytes do payload, todos os campos ligados pela assinatura, separação de domínio de denúncia e termos, limites do texto.
- `packages/rpc/test/methods.test.js`, `packages/core/test/session.test.js`, `packages/web-member/test/session.test.js`: validação do método, recusa no nó core e assinatura no navegador (bloqueado, sem identidade, sem chave).
- `apps/cli/test/moderation-store.test.js`: só chave bloqueada recorre, repetição devolve a mesma linha, janela de 30 dias só depois de recurso negado, recurso encerrado quando a chave é desbloqueada, teto de 2000, aceitar e negar, listagem com exclusões, trilha sem dado privado, leitura de `v: 2` e de linha malformada.
- `apps/cli/test/account-mod.test.js`: rotas do membro (não vinculado, não bloqueado, nonce de denúncia recusado, assinatura de outra chave, texto adulterado, Origin, repetição), painel (quem decidiu o bloqueio e a própria pessoa não veem nem decidem, aceitar vira desbloqueio pendente, negar mantém o bloqueio, limite de 30 dias).
- `apps/cli/test/panel.test.js`: aba Recursos (texto de par como texto, confirmação, corpo enviado, painel que ainda carrega contra serviço antigo, 401 vai ao login). `apps/app/test/appeal.test.js`: limites, erros fixos e pedidos. `apps/app/test/legal.test.js`: o recurso nos Termos e na Política, versão 25 e o digest do texto.

### Verificação humana

Marcar só o que for de fato executado, com a saída.

Execução de 2026-11-01 (itens 1, 2, 3, 5 e 6), num ambiente local montado só para isso, fora do repositório: a web exportada (`expo export`) servida em `https://varanda.localhost:8800` com certificado autoassinado, junto do `/varanda.json`, do WebSocket do semeador e do serviço de conta com o painel, atrás de um proxy que reescreve o `Host` como o Caddy. Chrome sem interface com passkey virtual (PRF), semeador, serviço de conta, painel e `mod apply` reais, DHT local presa a `127.0.0.1`. O Google é falso: um servidor local com tela de escolha de conta, injetado pelos `endpoints` do `createGoogle`. O OAuth real do Google não foi exercitado. Dois moderadores com e-mails diferentes (`moda` decidiu o bloqueio, `modb` julgou); o `mod apply` rodou no processo com a revisão no terminal respondida `s`.

- [x] O aceite dos Termos e da Política versão 9 aparece de novo para quem aceitou a versão 8. Executado em 2026-11-01: depois de aceitar a versão 9, o registro local `varanda-terms` foi regravado com `version: 8` (mesmo formato que a versão 8 gravava) e a página recarregada. A tela mostrou "Os Termos de Uso e a Política de Privacidade mudaram. Leia e aceite a versão 9 para continuar." com "Li e aceito". O registro de uma versão 8 de verdade não foi usado.
- [x] Conta bloqueada pela web hospedada: Ajustes › Recorrer de um bloqueio envia e mostra "recurso enviado"; enviar de novo mostra "você já tinha um recurso aberto". Executado em 2026-11-01 com a conta bloqueada pelo painel e publicada pelo `mod apply` (seq 2).
- [x] Conta não bloqueada: "esta conta não está bloqueada". Executado em 2026-11-01.
- [ ] App Android com a instalação: o mesmo fluxo, com a conta Google vinculada pelo app (não realizada ainda). Tentada em 2026-11-01 e não concluída: o emulador `LembraApi36` (API 36, `google_apis`) tem 0 contas Google, então o Credential Manager não tem provedor de passkey para criar a identidade com PRF; a passkey de um domínio só vale no Android com o `assetlinks.json` conferido pelo Google, o que um domínio local com certificado autoassinado não passa; e o app nativo só aceita uma instalação em https com certificado confiável. Também não há APK de debug compilado.
- [x] Segundo moderador no painel real: o recurso aparece em Recursos; o moderador que bloqueou não o vê; Aceitar cria o desbloqueio em Pendentes, `mod apply` pede confirmação e o desbloqueio sai da lista. Executado em 2026-11-01: `moda` viu "Nenhum recurso aberto."; `modb` viu o recurso, aceitou (confirmação do painel) e o desbloqueio apareceu em Pendentes; o `mod apply` fez uma pergunta ("Assinar e publicar estas mudanças? [s/N]"), publicou `seq 3` e a chave saiu da lista do semeador, com a outra chave bloqueada mantida.
- [x] Negar mantém o bloqueio e a pessoa vê "você já recorreu nos últimos 30 dias" ao tentar de novo. Executado em 2026-11-01: `modb` negou (confirmação do painel), a nova tentativa mostrou a mensagem e a chave continuou na lista do semeador.

### Limites

- Sem recurso pela CLI nem pelo nó nativo sem instalação (Hypercore 11, cuja chave não assina, `docs/protocol.md`): a CLI de membro também não tem cliente do serviço de conta (issue #142). O app com a instalação (tipo `web`) roda o nó do site e usa a mesma tela e as mesmas rotas, com o cabeçalho `x-varanda-client: app`; só os testes de pedido cobrem isso, a tela não foi exercitada em aparelho.
- `account reports` não exporta recursos; um pedido legal de acesso a esses dados ainda é manual (`moderation.json`).
- A independência de quem julga compara o e-mail de quem decidiu a denúncia. Um bloqueio feito fora do painel (`mod block`) ou pela IA não tem esse e-mail, e um segundo diário ligado a outra conta Google não é detectável (seção 14). Com um só moderador, o recurso de um bloqueio dele fica sem quem decida.
- O recurso vale para a chave do diário; bloqueio de chave de grupo (raiz) não tem recurso.
- O recurso também vale para um bloqueio ainda pendente (não publicado): a pessoa fica sabendo de uma decisão antes de o operador assinar a lista. É intencional: só quem prova a chave do diário envia, e o recurso aceito cancela o bloqueio pendente sem esperar o `mod apply`.
- A janela de 30 dias conta da negação, não do bloqueio: negado o recurso, uma chave desbloqueada por outro caminho e bloqueada de novo dentro de 30 dias só recorre depois dela.
- Não há aviso à pessoa quando o recurso é decidido: ela só vê o resultado pela própria conta (desbloqueada ou não) ou ao tentar de novo.
- Retenção das linhas de recurso é a mesma pendência das denúncias (issue #38).

## 126. Cartão de convite assinado (PR feat/invite-card-sign)

Um membro assina, com a chave do diário, o cartão que acompanha um convite de cadastro: desenho regional, nome, mensagem e validade. O cartão viaja só no fragmento do link e é conferido por quem abre. Esta etapa traz só o contrato, a assinatura e a conferência; ainda não há tela.

Regras que os passos conferem:

- O link tem a forma `origem/convite/<código>?c=<índice do desenho>#c1.<corpo>`. O `?c` é público e só serve à prévia do mensageiro: é opcional ao ler e, quando presente, tem de ser igual ao índice assinado. O fragmento nunca vai a um servidor.
- A assinatura cobre oito linhas (`varanda-invite-card-v1`, código, desenho, validade, resumo do nome, resumo da mensagem, membro, associação). Nome e mensagem entram por resumo BLAKE2b-256 calculado sempre pelo assinante, e o prefixo impede que a assinatura valha como outro pedido do protocolo.
- `inviteCard.sign` só existe no navegador (o nó do Node responde `assinatura disponível só no navegador`), exige a identidade aberta e aceita validade de 1 dia atrás a 8 dias à frente.
- `inviteCard.verify` roda nos dois nós, não precisa de identidade e funciona com a identidade bloqueada. No navegador a chave do membro passa antes por uma conferência estrita (ponto de ordem pequena ou fora da forma canônica é recusado como `malformed`). Um cartão com assinatura boa cuja validade passou há mais de um dia pelo relógio do nó volta `expired`.
- O link leva no fragmento o nome de quem recebe e a mensagem: o app que abrir o link precisa tirar o cartão da barra de endereço na mesma passada em que o guarda (fica para o PR do app).
- O link inteiro tem no máximo 400 caracteres.

Passos (marcar só depois de executar e guardar o registro). Ainda não há tela para criar nem abrir o cartão, então cada plataforma só confirma que nada mudou:

- [ ] Android (build de debug, emulador ou aparelho): o app abre e usa convites como antes; não há tela do cartão ainda.
- [ ] Simulador iOS: o app abre e usa convites como antes; não há tela do cartão ainda.
- [ ] Web e PWA: o cadastro por convite funciona como antes; não há tela do cartão ainda.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node packages/rpc/test/invite-card.test.js` e `node packages/rpc/test/methods.test.js`.
- `node packages/core/test/invite-card.test.js`, `node packages/core/test/page-proof.test.js` e `node packages/core/test/session.test.js`.
- `node packages/web-member/test/invite-card.test.js` e `node packages/web-member/test/session.test.js`.
- `node apps/app/test/vitrine.test.js`.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- O serviço de conta não muda: não recebe nem guarda o cartão.
- Links nativos (`varanda://`) continuam com no máximo 400 caracteres, como os de web.

## 127. Cartão de convite regional (PR feat/invite-card-app)

Quem convida pode mandar, junto do link de entrada, um cartão com o nome de quem recebe, uma mensagem curta e um de 13 desenhos regionais. Quem abre o link vê o cartão antes da introdução e, depois de entrar, pode seguir ou mandar um oi para quem escreveu. Esta seção descreve o que o código faz; o contrato e a assinatura estão na seção 126.

Regras que os passos conferem:

- O cartão viaja só no fragmento do link (`#c1.<corpo>`), mais o `?c=<desenho>` público e opcional. Nenhum servidor recebe o fragmento: o app o lê e o tira da barra de endereço na mesma passada em que guarda o código do convite (`captureSignupInvite`), antes de qualquer tela.
- O cartão é assinado e preso ao código do convite: a assinatura cobre o código, e `inviteCard.verify` roda no nó antes de qualquer tela mostrar o cartão. Um fragmento forjado, trocado de código ou com assinatura ruim não vira cartão, e o convite segue valendo como link comum.
- O link inteiro tem no máximo 400 caracteres. Por isso um app já instalado, que só conhece o caminho `/convite/<código>`, continua lendo o código e ignora o cartão.
- Guarda: na web, o registro fica no `sessionStorage` da aba, na chave `varanda-signup-invite-card`, por 24 horas; no app instalado, só na memória do processo. É lido como não confiável a cada uso (reconstruído campo a campo e conferido de novo) e some quando o convite é trocado ou expira.
- Prévia fora: um link `/convite/...` nunca vira prévia. `apps/app/src/preview.js` não monta cartão para ele e `apps/cli/lib/account/preview-routes.js` recusa o endereço em qualquer host, para o nome e a mensagem não irem ao serviço de prévia.
- Nada segue ninguém sozinho. Abrir o cartão não cria vínculo; Seguir e Mandar um oi são toques da pessoa, cada um conferido de novo (identidade, registro do cartão e associação) antes de escrever, sem repetição automática.
- Privacidade, em termos exatos: não há nenhum registro novo de quem convidou quem e nenhum aviso de cadastro. O diretório do serviço de conta já guarda o hash do convite usado no vínculo do novo membro (`apps/cli/lib/account/store.js`, `docs/design.md`, "Vínculo com a conta Google"), como antes do cartão. Tocar em Seguir manda o aviso comum de seguir (`packages/core/lib/notices.js`), como qualquer outro seguir.
- Os 13 desenhos são desenhados no código, com `View`, e inspirados em tradições regionais (Marajoara, Encontro das águas, Vitória-régia, Cordel, Bandeirinhas, Chita, Ipê-amarelo, Pantanal, Azulejo, Copacabana, Minas, Araucária, Chimarrão). Nenhum copia obra de artista nem padrão protegido.

O fluxo no app:

- Quem convida: em Convites, o botão "Mandar com um cartão" abre nome, região, desenho e mensagem (já vem uma sugestão por desenho). O contador mostra os bytes usados e os que cabem (`messageRoom`); se o nome ou a mensagem não servem, uma linha explica (nome vazio ou longo, mensagem vazia, com símbolos que não aparecem ou longa demais). O botão vira "Criar link com cartão" e "Assinando cartão" durante a assinatura. Se a assinatura falhar, o convite criado vale como link comum e o app avisa que o cartão não entrou.
- Quem abre, antes da introdução: o cartão aparece antes das telas de introdução, com Entrar, Como funciona (mostra a introdução e volta ao cartão) e Agora não (esconde só nesta abertura). A tela espera o nó ficar pronto por até 6 s (`OPEN_WAIT_MS`); passado esse tempo segue a introdução e, se a conferência terminar depois, o cartão assume o lugar das telas de introdução. Uma assinatura ruim, um cartão vencido, um membro sem vínculo ou uma retomada do Google/idade não mostram o cartão. Sem rede, a pertença do membro fica "desconhecida" e nada é oferecido.
- Quem chegou: o cartão de chegada aparece no app só para quem passou pela configuração neste aparelho segurando o cartão, nunca para um membro que já estava com a conta aberta. Mostra "Você chegou com o cartão de @nome", com Seguir, Mandar um oi (texto fixo "Oi! Cheguei.", nunca a mensagem do cartão; sem Conversas do outro lado, avisa) e Agora não.
- Movimento: o cartão entra com um fade e um crescimento curtos, uma vez; com movimento reduzido, já aparece no estado final. O desenho e os textos seguem o tema claro e escuro.

Passos (marcar só depois de executar e guardar o registro):

- [ ] Android (build de debug, emulador ou aparelho): criar um convite com cartão em Convites, abrir o link e conferir o cartão antes da introdução; Agora não; link comum (sem cartão); fragmento forjado; cartão de chegada com Seguir e Mandar um oi; sem rede (status offline); tema claro e escuro; movimento reduzido; os 13 desenhos.
- [ ] Simulador iOS: o mesmo roteiro do Android.
- [ ] Web e PWA: o mesmo roteiro, mais as duas barras de endereço (o fragmento e o `?c` somem), o nó lento (a espera de 6 s e a troca tardia pelo cartão) e um viewport de 390 px.
- [ ] Medir a carga a frio: em cada plataforma, anotar quanto o nó leva para ficar pronto depois de abrir o link com o cache limpo e comparar com os 6 s de `OPEN_WAIT_MS`. Registrar os tempos aqui; se passarem de 6 s com frequência, a espera precisa ser revista. Nenhuma medida foi feita nesta documentação.

Como verificar, a partir da raiz (só os arquivos desta área):

- `node apps/app/test/preview.test.js` e `node apps/cli/test/preview-routes.test.js`.
- `node apps/app/test/inviteCardCopy.test.js`, `node apps/app/test/inviteCardArt.test.js`, `node apps/app/test/inviteCardMotion.test.js` e `node apps/app/test/inviteCardFrame.test.js`.
- `node apps/app/test/signupInvite.test.js` e `node apps/app/test/linkReturn.test.js`.
- `node apps/app/test/inviteCardFlow.test.js` e `node apps/app/test/inviteCardCompose.test.js`.
- `node apps/app/test/help.test.js`.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- Alguns mensageiros tiram o fragmento do link: o link comum continua funcionando e o convite vale sem cartão.
- A mensagem é um bilhete curto, de cerca de 134 bytes no endereço bora.varanda.app, dividido com o nome (o contador do app mostra o espaço exato).
- Não há nota de voz, foto, desenho por estado, compartilhar como imagem nem arte encomendada; a prévia nos mensageiros vem na seção 128.
- Um app já instalado não mostra o cartão e ainda assim troca o código pelo convite.
- Quem usa uma configuração salva de outra associação não vê cartão (a conferência falha fechada), e o código continua valendo.
- Quem tem o link lê o cartão: nome, mensagem e desenho não são cifrados.
- Para mostrar o @nome de quem escreveu, o aparelho de quem abre o link consulta o status público da conta pela chave de quem convidou, antes do cadastro (o serviço não registra essa consulta; nome e mensagem não saem do aparelho). Um cartão vencido não faz consulta nenhuma.
- O histórico do próprio navegador pode guardar o endereço como foi aberto, com o fragmento, mesmo depois que o app o tira da barra.

## 128. Prévia do cartão de convite nos mensageiros (PR feat/invite-card-preview)

Quando alguém cola um link de convite no WhatsApp, no Telegram ou no iMessage, o robô do mensageiro lê uma página curta do serviço de conta e mostra o desenho escolhido e, se o convite estiver vivo, "@nome te mandou um convite pra Varanda". Robôs não veem o fragmento (`#c1...`), então o desenho viaja no `?c=N` público; o nome e a mensagem do cartão nunca chegam ao servidor.

Regras que os passos conferem:

- `GET` e `HEAD /account/og/convite/<código>?c=N` (`apps/cli/lib/account/og-routes.js`) respondem sempre 200 com uma página de metadados Open Graph. O título pessoal só sai para um convite vivo, com `c` válido (0 a 999, e que seja um dos 13 desenhos) e quem convidou com conta vinculada e @nome (`inviterOf` em `invites-store.js`, mais o status da conta). Um convite morto (usado, vencido ou desconhecido) com `c` válido ainda recebe a imagem daquele desenho, mas com o título genérico "Você recebeu um convite pra Varanda". Sem `c` válido, a imagem é `convite.png`.
- Um código malformado nunca é repetido na página: o `og:url` vira a raiz. O `og:url` de um código bem formado mantém o `?c`.
- Os endereços absolutos (imagem e `og:url`) partem da origem configurada, nunca do cabeçalho `Host`. Todo valor interpolado é escapado.
- A resposta leva `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `nosniff`, `Referrer-Policy: no-referrer` e uma CSP fechada. O registro guarda só contagens (`{ event: 'og', reason: 'pessoal' | 'generico' }`), nunca o código, a chave de quem convidou ou o @nome. A rota passa pelo limite global de consultas do serviço.
- As 14 imagens (`apps/app/public/og/convite-<desenho>.png`, 13 desenhos, e `convite.png`) são 1200 x 630, renderizadas por `apps/app/scripts/render-og.js` a partir de `apps/app/src/inviteCardArt.js`: cada uma é a moldura regional com uma cadeira de balanço de varanda no centro, gerada pelo script e commitada; as imagens ficam fora do cache do PWA, porque só os robôs de prévia as buscam. `node apps/app/scripts/render-og.js --check` compara os pixels com os arquivos.
- `deploy/seeder/Caddyfile`: `@previaConvite` casa `path /convite/*` mais uma lista de `User-Agent` (facebookexternalhit, facebot, whatsapp, telegrambot, twitterbot, slackbot, discordbot, linkedinbot, skypeuripreview, applebot) e reescreve para `/account/og{path}`, seguindo para o serviço de conta. O par é excluído de `@mutavel` (não leva `no-cache`) e de `@ausenteApp`. Uma pessoa em `/convite/*` continua recebendo o `index.html` do app, como antes.

Como verificar, a partir da raiz (um arquivo por vez):

- `node apps/app/test/renderOg.test.js`
- `node apps/cli/test/og-routes.test.js`
- `node apps/cli/test/invites-store.test.js`
- `node apps/cli/test/caddyfile.test.js`

Depois que o operador reimplantar o Caddy e o serviço de conta (o `Caddyfile` mudou, então só `up -d` do Caddy não basta sem recarregar a configuração):

- [ ] Colar um link de cartão (`/convite/<código>?c=3`) no WhatsApp, no Telegram e no iMessage e ver a imagem do desenho e "@nome te mandou um convite pra Varanda".
- [ ] Um link comum (sem `?c`) e um convite já usado ou vencido mostram a prévia genérica ("Você recebeu um convite pra Varanda", imagem `convite.png` ou a do desenho, conforme o caso).
- [ ] `curl -sA WhatsApp 'https://<domínio>/convite/<código>?c=3'` devolve `og:image` com `convite-cordel.png`. Isso prova que o `?c` sobrevive à reescrita do Caddy, o que não pôde ser testado sem o binário do Caddy.
- [ ] `curl -s 'https://<domínio>/convite/<código>'` com um `User-Agent` de navegador continua devolvendo o `index.html` do app, e uma pessoa num navegador abre o app normalmente.
- [ ] Com o serviço de conta parado, abrir o link com `curl -sA WhatsApp` e ver se o log de erro do Caddy registra o caminho `/convite/<código>`. Anotar aqui o resultado: ______.

Limites:

- Só os robôs conhecidos, pelo `User-Agent`, recebem a prévia pessoal; qualquer outro vê o título e a descrição de hoje.
- Quem tem um código vivo pode descobrir o @nome de quem convidou pela prévia (o cartão já o mostra).
- Um link comum postado em público com `?c` acrescentado revelaria quem o emitiu.
- As imagens são geometria gerada, não arte encomendada.
- O `User-Agent` é declarado pelo cliente: quem quiser pode se passar por um robô e ver a página de prévia, que não traz nada além do que está acima.

## 129. Carregamento mais rápido de A Rua, Diário e perfis (PRs chore/perf-harness até perf/app-render)

Caminhada da pilha de desempenho: medição, leituras do nó, partida, concessão do app instalado e renderização. Ciclo de medição, metas e números em [performance.md](performance.md).

O que muda:

- Medição: `startup-bench.js` ganha `--file`, `--reads-twice`, `--log`, `--lease-gap` e contadores por fase; o laboratório hospedado ganha `--dataset`, `--dataset-size` e `--rajada`; o app de desenvolvimento ganha marcas de tempo no console e um gancho que só aceita `follow.add`, `community.join` e `post.create`, as duas coisas só com `__DEV__` e `EXPO_PUBLIC_VARANDA_PERF=1`; a Vitrine ganha 200 linhas extras com `EXPO_PUBLIC_VARANDA_VITRINE_LARGE=1`.
- Nó: os núcleos de diário, réplica e grupo guardam os blocos em memória (um bloco apagado sai do cache antes e depois de cada limpeza, e o cache recusa guardar um bloco que o núcleo não tem); o feed valida cada registro uma vez por leitura.
- Partida: Conversas só lê a caixa e os grupos quando a aba é aberta (a coleta de mensagens espera a partida ficar quieta, para o ponto de não lidas continuar aparecendo); o ponto da aba espera as primeiras linhas de A Rua; os pedidos ao nó entram numa fila de 7 em andamento em vez de falhar no nono, e a fila descarta o que esperava antes de qualquer troca de identidade; a página baixa o nó do navegador enquanto busca `/varanda.json`; o Diário não repete `node.info` para a mesma identidade.
- Fotos: uma resposta 503 do semeador (ocupado) é tentada de novo, depois do `Retry-After` e com uma espera aleatória, no máximo três vezes.
- App instalado: a sincronização fica ligada enquanto o app está aberto, como no PWA (antes caía 8 s depois de terminar e cada leitura reabria todos os núcleos do armazenamento do aparelho).
- Renderização: as linhas do registro de sincronização e as dicas de download saem do contexto principal do app, e cada publicação só é desenhada de novo quando os dados dela mudam.

Como verificar, a partir da raiz (um arquivo por vez):

- `node packages/web-member/test/delete-purge.test.js`, `node packages/core/test/feed.test.js`.
- `node apps/app/test/requestQueue.test.js`, `node apps/app/test/conversas.test.js`, `node apps/app/test/mediaFetch.test.js`, `node apps/app/test/mediaCache.test.js`, `node apps/app/test/workletLease.test.js`, `node apps/app/test/syncSignals.test.js`, `node apps/app/test/feedRender.test.js`, `node apps/app/test/perfMarks.test.js`, `node apps/app/test/vitrineLarge.test.js`, `node apps/app/test/hardening.test.js`.
- `node apps/cli/test/lab-dataset-plan.test.js`, `node apps/cli/test/hosted-lab.test.js`.
- Números: os comandos de [performance.md](performance.md) ("Ferramentas e comandos").

Com uma conta de verdade, primeiro no Android, depois no iOS, depois na web e no PWA:

- [ ] Android (APK de preview): abrir o app frio mostra as primeiras linhas de A Rua mais cedo que a versão anterior; o registro de Sincronização não mostra parada "idle" com o app aberto nem "leitura sem esperar a partida".
- [ ] Android: com o app em segundo plano por um minuto, a sincronização para; ao voltar, ela recomeça.
- [ ] Android: Conversas mostra o ponto de não lidas quando chega uma mensagem com o app aberto em A Rua, sem abrir a aba.
- [ ] Android: rolar A Rua com fotos não engasga; uma curtida muda só a publicação curtida.
- [ ] iOS (TestFlight): os mesmos quatro passos.
- [ ] Web e PWA: A Rua aparece mais cedo; trocar de conta com publicações na fila de envio não publica nada da conta anterior na nova.
- [ ] Web: com o semeador sob carga (`VARANDA_MEDIA_MAX_IN_FLIGHT` baixo), as fotos que recebem 503 aparecem depois de alguns segundos em vez de ficarem com erro.

Limites:

- O caminho crítico que sobra é a partida do nó: ela verifica cerca de 122 assinaturas de certificados em JavaScript puro antes de responder à primeira leitura. Encurtar isso pede uma decisão (Ed25519 do WebCrypto no navegador, ou lembrar verificações entre aberturas).
- Cada app instalado aberto em primeiro plano segura uma conexão do semeador, como uma aba visível: `VARANDA_MAX_EXTERNAL` precisa contar os dois.
- O semeador limita `/media` de forma global (16 em andamento, 64 por segundo por padrão): com muita gente ao mesmo tempo, as fotos esperam; as variáveis `VARANDA_MEDIA_*` aumentam esses limites.
- Os números de celular só valem depois de publicar; simulador e emulador não substituem um aparelho.

## 130. Feira: anúncios, edição, apagamento, avaliações e índice do semeador (PR feat/feira-records)

Caminhada da base da Feira: os quatro registros (`listing`, `listing-edit`, `listing-status`, `listing-rate`), a dobra, os métodos `listing.*` do RPC (5.103 a 5.110), a denúncia de anúncio e o índice do semeador. O protocolo está em [protocol.md](protocol.md) (seção 2, "Feira records", seção 3, "Listing report", e a seção 15); o RPC em [rpc.md](rpc.md). Nesta rodada não há tela: as telas e as rotas HTTP vêm em PRs seguintes.

Regras que os passos conferem:

- Um anúncio mora no diário de quem anuncia. A edição é um retrato completo do conteúdo, e o `expectedRevision` (a posição do bloco da edição viva, ou 0) recusa com `conflito` a edição feita sobre uma versão velha, sem gravar nada.
- Editar grava, num só append, a edição nova e o apagamento da edição anterior com as fotos que só ela mostrava. A raiz fica no diário até o anúncio ser apagado: a primeira versão e as fotos continuam no registro.
- Apagar um anúncio grava, num só append, o apagamento da raiz e o da edição viva. O limite é de 30 anúncios vivos por diário (`limite`). Uma procura não fica reservada, e "vendido" nela aparece como "Encontrado".
- Uma avaliação só vale com o consentimento do autor do anúncio (assinatura sobre `varanda-feira-deal-v1`), de uma pessoa diferente, com cadastro de 7 dias ou mais na hora da leitura; vale uma por pessoa por anúncio, a mais nova. O semeador só guarda indícios; quem mostra estrelas é o app, pela verificação própria (`listing.ratings`).
- A proposta é um link do anúncio com `#oferta=<centavos>`; a resposta acrescenta `&aceite=<consentimento>` ou `&resposta=recusada`. Quem fez a proposta é o remetente autenticado da mensagem direta, e `listing.consent` só assina uma proposta recebida desse remetente e desse anúncio.
- O índice do semeador é só dica: o STATE por diário (status e edição atual) é atualizado antes de qualquer admissão na busca, e a varredura da Feira nunca pausa num teto. O cartão público (`listingPublic`) nunca publica a raiz antiga como atual, e uma página encerrada ou movida sai da Feira.
- Ordem de lançamento: semeadores, depois o pacote web, depois o app. Leitores antigos pulam os quatro tipos como desconhecidos.
- Uma caixa só é marcada depois que o passo foi executado e o registro guardado.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node packages/rpc/test/feira.test.js`, `node packages/rpc/test/methods.test.js` e `node packages/rpc/test/sizes.test.js`.
- `node packages/core/test/records.test.js`, `node packages/core/test/listing.test.js`, `node packages/core/test/deletion.test.js`, `node packages/core/test/feed.test.js`, `node packages/core/test/report.test.js` e `node packages/core/test/listing-session.test.js`.
- `node packages/core/test/feira-index.test.js` e `node packages/core/test/seeder-feira.test.js`.
- `node packages/web-member/test/listing-write.test.js` e `node packages/web-member/test/listing-report.test.js` (exigem Node 20.19 ou mais novo).
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada com dois nós (um semeador e dois membros de teste, na DHT local), a partir da CLI de teste ou dos testes acima:

- [ ] Criar um anúncio de produto com preço e outro "A combinar"; `listing.mine` lista os dois, o mais novo primeiro, com `editSeq` nulo.
- [ ] Editar o primeiro com o `expectedRevision` certo: sai `{ seq, ref }` com o mesmo `ref`; repetir com o valor velho responde `conflito` e o diário não cresce.
- [ ] Mudar o status para "reservado" e depois "vendido"; num anúncio de procura, "reservado" é recusado com "uma procura não fica reservada".
- [ ] Criar 30 anúncios vivos; o 31º responde `limite`. Apagar um libera uma vaga.
- [ ] Apagar um anúncio editado: o diário ganha dois apagamentos num só append e `listing.mine` não o lista mais.
- [ ] No semeador, a busca por cidade e categoria acha o anúncio e deixa de achar depois de "vendido" e depois de apagado; a lista do autor mantém o "vendido".
- [ ] O autor aceita uma proposta recebida (`listing.consent`); quem propôs avalia com `listing.rate`; uma avaliação com consentimento de outro anúncio responde `consentimento inválido`.
- [ ] `listing.ratings` mostra a avaliação só quando o cadastro de quem avaliou tem 7 dias ou mais; antes disso ela entra em `dropped`.
- [ ] Denunciar um anúncio com `report.sign` e `kind: 'listing'`; a assinatura não confere como denúncia de publicação.
- [ ] Com o semeador de uma versão anterior à Feira, os quatro tipos são ignorados e o diário não é rejeitado.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- O semeador guarda só as 16 últimas edições e os 16 últimos status de cada anúncio: com a janela estourada e todos apagados, o anúncio fica sem status conhecido, sai da busca e do mapa do site, e o cartão público responde 404 se a edição atual for desconhecida, até um novo status ou edição.
- Com duas avaliações da mesma pessoa para o mesmo anúncio, o índice guarda a mais nova; se ela for apagada, a antiga só volta ao índice depois que o semeador varrer o diário de novo (reinício ou reconstrução).

## 131. Feira: página pública, entrada por link, anúncio de página e denúncia (PR feat/feira-service)

Caminhada do serviço da Feira: as rotas públicas do semeador (`/index/feira/*`, `/f/*`), o Caddy, a entrada por link de anúncio, os anúncios de uma página, o cartão guardado na caixa da página e a denúncia de anúncio no painel. O protocolo está em [protocol.md](protocol.md) (seção 15, "The seeder's Feira routes and public pages" e "Feira entry"; seção 12, "Anúncios como página"; seção 3, "Reports").

Regras que os passos conferem:

- As rotas existem só quando o semeador tem `VARANDA_PUBLIC_ORIGIN` (no compose, `VARANDA_FEIRA_ORIGIN`). Sem ela, o padrão, `/f/*` e `/index/feira/*` respondem 404. A origem da conta é outra variável e não muda.
- A página pública escapa todo texto do diário, não tem script nem recurso externo, e responde `no-store`, `nosniff` e `no-referrer`. `index,follow` só para `disponivel` e `reservado`; `vendido` e status desconhecido saem `noindex,follow`, e só `vendido` leva também `X-Robots-Tag: noindex`. Uma publicação, um anúncio apagado, um diário bloqueado ou uma edição desconhecida dão a mesma página 404.
- As fotos (`/f/<diário>/<seq>/foto/1..4` e `capa`) só saem com tamanho, sha256 e bytes iguais ao descritor. O `sitemap.xml` lista só endereços de anúncios que não estão `vendido`. O Caddy serve o `/robots.txt` (permite só `/f/`) e limita `/f/*` a 30 pedidos por 10 s por endereço; o service worker não intercepta `/f/*`.
- A entrada: `GET /account/feira/policy` responde só `{ enabled }`; `POST /account/feira/start` devolve um código de 1 hora cobrado do dono do anúncio e lê o anúncio sem olhar o status (um anúncio vendido ainda abre a porta). A ordem: o corpo exato; depois o dono da cota (membro vinculado ou dono da página aberta), e sem dono responde `nao-encontrado` sem ler nada no semeador; depois a conferência do anúncio no semeador; por fim o código. Não há limite por chave de dono (qualquer um trancaria os anúncios de alguém). Exige `VARANDA_FEIRA_INVITES_PER_WEEK`, `VARANDA_INVITES_PER_WEEK` e `VARANDA_TRIAGE_TOKEN`.
- A conferência do anúncio usa a rota própria do semeador `GET /feira-listing/<diário>/<seq>` (com o token, nunca pelo Caddy), que responde só `{ ok: true }` e tem orçamento próprio (2 ao mesmo tempo, 4 por segundo, rajada 8): inundar essa rota nunca faz `/moderation-post` responder 503. O painel continua com `/moderation-listing`.
- O Caddy limita `/account/feira/*` na zona `feira-entrada`: 5 pedidos a cada 60 s por endereço, antes do handle genérico de `/account/*`. `POST /account/feira/idade` tem zonas próprias: `feira-idade`, 2 pedidos por hora por endereço, e `feira-idade-total`, 50 por hora no total. Cada teto é uma diretiva `rate_limit` separada, em ordem, dentro de um `route` (por endereço primeiro, global depois), para que um pedido recusado por endereço não gaste o teto global. Só um `POST` com `Content-Type: application/json` entra nas zonas da idade; qualquer outro pedido a `/account/feira/idade` recebe 405 do Caddy sem passar por zona nenhuma. O endereço fica só na memória do Caddy durante a janela, e os dois handles tiram `X-Forwarded-For` e `X-Real-Ip`. O serviço só atende `/account/feira/idade`, `/account/feira/start` e `/account/feira/policy` quando o caminho cru do pedido é exatamente esse (`/../`, `/./`, `%2F` ou `%2E%2E` dão 404), porque o Caddy e o serviço normalizam caminhos de jeitos diferentes.
- Sessões pagas de idade com código da Feira: no máximo 1 por código por dia e 50 por dia para todos os códigos da Feira juntos, sem teto por dono, sempre com `limite-idade`. Elas não contam no teto diário dos outros cadastros, e um convite comum funciona como antes. A sessão paga de um código da Feira só abre por `POST /account/feira/idade` (mesmo corpo de `/account/age/session`); um código da Feira em `/account/age/session` responde `use-a-rota-da-feira`, e um código comum na rota da Feira responde `pedido-invalido`, os dois antes de gastar qualquer janela. Resíduo aceito: quem troca de endereço IPv6 dentro de um /64 (ou usa muitas máquinas) chega só aos tetos globais (os 50 do dia e a zona `feira-idade-total`) e ainda pode parar os cadastros pela Feira naquele dia (com o custo de até 50 sessões pagas), nunca os cadastros comuns. Atrás de CGNAT, quem divide um endereço pode receber 429 do Caddy (2 por hora bastam para uma pessoa). Um código da Feira emitido numa semana anterior é recusado depois de segunda 00:00, para não escapar das duas contagens semanais.
- O teto semanal conta os códigos usados ou presos por um link do diretório, pela data de criação (um código emitido no domingo à noite e usado na segunda conta na semana em que saiu). Resíduo aceito: cadastros em andamento ao mesmo tempo podem passar do teto semanal de um dono pelo número de cadastros em andamento, cada um ainda com código de uso único. Um `feira-invites.json` quebrado desliga só os códigos da Feira.
- `feira-invites.json` guarda a chave de quem é cobrado, o resumo do código, a data e se foi usado; nunca quem se cadastra, o anúncio, o endereço nem o código.
- Uma página anuncia com `listing`, `listing-edit`, `listing-status` e `listing-consent` (admin ou dono). A edição responde a posição do bloco da edição, a edição velha dá `conflito`, o 31º anúncio dá `limite`, e `listing-consent` sem uma proposta recebida de quem avalia dá `oferta-ausente`. A página responde uma proposta em texto, com o link de aceite ou de recusa.
- A caixa da página guarda o cartão de link que um membro mandou (a foto do cartão só para dono e administradores); o serviço nunca busca o link nem a imagem.
- A denúncia de anúncio (`kind: 'listing'`) é sempre decidida por uma pessoa: a IA marca `anuncio` e nunca lê o texto. O painel tem o filtro "Anúncios", o link da página pública e "Ver anúncio" (versão atual lida no semeador, só como texto); `descartar` ou `bloquear`, e bloquear atinge o diário inteiro.
- Uma caixa só é marcada depois que o passo foi executado e o resultado conferido.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node apps/cli/test/feira-page.test.js`, `node apps/cli/test/seeder-feira-http.test.js` e `node apps/cli/test/seed-ws.test.js`.
- `node apps/cli/test/feira-read.test.js`, `node apps/cli/test/feira-routes.test.js`, `node apps/cli/test/invites-pair.test.js` e `node apps/cli/test/account-age.test.js`.
- `node apps/cli/test/pages-listing.test.js`, `node apps/cli/test/pages-dm-card.test.js` e `node packages/core/test/page-proof.test.js`.
- `node apps/cli/test/ai-worker.test.js`, `node apps/cli/test/account-mod.test.js`, `node apps/cli/test/moderation-store.test.js` e `node apps/cli/test/panel.test.js`.
- `node apps/cli/test/caddyfile.test.js`, `node apps/cli/test/deploy.test.js` e `node apps/app/test/sw.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada com um semeador, um serviço de conta e dois membros de teste (DHT local):

- [ ] Sem `VARANDA_PUBLIC_ORIGIN`, `GET /f/<diário>/<seq>` e `GET /index/feira/...` respondem 404. Com a origem, a página de um anúncio vivo abre com título, preço, cidade e fotos.
- [ ] Um anúncio marcado "vendido" mantém a página, com `noindex`, e sai do `sitemap.xml`. Um anúncio apagado dá a página 404.
- [ ] Abrir `/f/<diário>/<seq>/capa` entrega a primeira foto; depois de editar o anúncio com outra foto, o mesmo endereço entrega a nova.
- [ ] `GET /robots.txt` no domínio permite só `/f/` e aponta o sitemap.
- [ ] Com a entrada ligada, `GET /account/feira/policy` responde `{ enabled: true }`; `POST /account/feira/start` de um anúncio de membro devolve um código; um anúncio de um diário que não é de membro responde `nao-encontrado`. Pelo Caddy, o 6º pedido a `/account/feira/*` do mesmo endereço em 60 s responde 429.
- [ ] Com um código da Feira, a primeira sessão de idade abre e a segunda do mesmo código no mesmo dia responde `limite-idade`; um convite comum continua abrindo sessão.
- [ ] Pelo Caddy, com códigos da Feira novos: dois `POST /account/feira/idade` do mesmo endereço na mesma hora chegam ao serviço e o 3º responde 429 do Caddy; de outro endereço, o pedido seguinte ainda passa. Antes disso, vários `GET /account/feira/idade` do mesmo endereço respondem 405 e não gastam o limite. O mesmo código da Feira em `POST /account/age/session` responde `use-a-rota-da-feira` e não abre sessão paga.
- [ ] Usar o código no cadastro conta no teto semanal do dono; chegado o teto, o código seguinte é recusado como convite inválido. Quebrar o `feira-invites.json` (de propósito, numa cópia) desliga só os códigos da Feira.
- [ ] Como página: criar, editar (com o `expectedRevision` certo e com um velho), mudar o status e apagar um anúncio; o 31º vivo responde `limite`.
- [ ] Receber uma proposta na caixa da página; o administrador vê o cartão e a foto, pede `listing-consent` e responde em texto com o link de aceite.
- [ ] Denunciar um anúncio; no painel ele aparece com "Anúncios", o link da página e "Ver anúncio"; a IA marca `anuncio`; descartar fecha, bloquear avisa que atinge o diário inteiro.
- [ ] Verificação manual de prévia de link, pendente para o operador: colar o endereço `/f/<diário>/<seq>` de um anúncio de teste em um aplicativo de mensagens e num teste de rich results do buscador, com a Feira ligada num domínio real, e conferir título, descrição e imagem de capa.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação; a prévia de link fica pendente para o operador.
- Ligue `VARANDA_FEIRA_ORIGIN` só depois que o app e os Termos da Feira estiverem no ar.
- O `robots.txt` é servido pelo Caddy mesmo com a Feira desligada: o mapa do site que ele indica responde 404 até `VARANDA_FEIRA_ORIGIN` ser definido.
- Com `feira-invites.json` corrompido, os códigos da Feira param e a limpeza de convites de cada conta excluída fica pendente (`purga-pendente` no log) até o operador consertar o arquivo; os outros dados da conta são apagados normalmente.

## 132. Feira no app: aba, anúncio, links e entrada por anúncio (PR feat/feira-app)

Caminhada da Feira no app: a aba Feira, as telas Anúncio e Anunciar, Conversar com o rascunho e o cartão, os links `/f/` e `/anuncio/`, a entrada de quem chega por um anúncio, os anúncios de Página e a denúncia de anúncio. O comportamento está em [app.md](app.md), seção "Feira"; o formato, em [protocol.md](protocol.md), seção 15. Editar anúncio, propostas, avaliações, alertas de busca salva e os links no app nativo ficam na seção 133.

Regras que os passos conferem:

- A aba Feira existe só no nó hospedado (a barra tem seis abas: A Rua, Espiadinha, Conversas, Feira, Busca, Diário); a configuração manual e o `varanda-serve` ficam com quatro. O botão "publicar" some na Feira e nas telas dela.
- Abrir um link nunca age sozinho: a tela Anúncio só mostra o anúncio. Conversar só preenche o rascunho; nada é enviado sem o toque em enviar.
- O link de anúncio é lido e limpo da barra de endereço uma vez ao carregar e fica na aba no máximo 1 h; o anúncio abre uma vez, quando as abas aparecem.
- O estado e a cidade da Feira ficam só no aparelho.
- Uma caixa só é marcada depois que o passo foi executado e o resultado conferido.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node apps/app/test/platformGate.test.js`, `node apps/app/test/themeUsage.test.js`, `node apps/app/test/tabBar.test.js` e `node apps/app/test/nav.test.js`.
- `node apps/app/test/linkReturn.test.js`, `node apps/app/test/feiraLink.test.js`, `node apps/app/test/feiraEntry.test.js` e `node apps/app/test/feiraScreen.test.js`.
- `node apps/app/test/feira.test.js`, `node apps/app/test/feiraCompose.test.js`, `node apps/app/test/feiraChat.test.js` e `node apps/app/test/feiraSaved.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").
- Num nó hospedado com a Feira desligada, a aba Feira mostra "A Feira não está aberta nesta instalação".

Caminhada com a Feira ligada numa instalação de teste (semeador com `VARANDA_PUBLIC_ORIGIN`, entradas da Feira ligadas) e dois membros de teste, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Na aba Feira, "Na cidade" sem estado pede "Escolha o estado e escreva a cidade."; com estado, cidade e "Buscar", a lista aparece. Fechar e abrir o app mantém o estado e a cidade.
- [ ] "Anunciar", preencher, marcar "Público na web e em buscadores" e publicar: a tela Anúncio do novo anúncio abre no lugar do formulário, e Voltar leva à aba Feira. O anúncio aparece em "Meus".
- [ ] Prévia de link: em "Compartilhar", o aviso é "Link copiado." (ou a folha do sistema); colar o link `/f/<diário>/<seq>` num aplicativo de mensagens mostra título, descrição e foto de capa.
- [ ] Uma pessoa nova abre o link `/f/…` no navegador, toca em "Entrar para conversar", vê no Entrar o cartão "Anúncio da Feira" com "Entre para falar com quem anunciou.", toca em "Pedir entrada" (antes do toque nenhum código é pedido; na rede aberta o botão não aparece), faz o cadastro e, quando as abas aparecem, a tela Anúncio abre sozinha, uma vez. A barra de endereço fica em `/`.
- [ ] Com convites e verificação de idade ligados, uma pessoa nova que abre o link de um anúncio vê "Pedir entrada" já no passo da idade (sem "Verificar minha idade" antes do toque); depois do toque faz a verificação de idade e então o Google, sem convite pessoal.
- [ ] Com as entradas semanais de quem anunciou esgotadas, o cadastro pelo anúncio mostra "Quem anunciou não tem mais entradas nesta semana. Peça um convite a alguém da rede ou tente na próxima semana.".
- [ ] "Conversar" abre a conversa com o rascunho "Olá! Tenho interesse no seu anúncio "…" na Feira: <link>" e o cartão do link, sem enviar nada. Depois de enviar, o cartão na conversa tem "Ver anúncio", que abre a tela Anúncio.
- [ ] Quem anunciou toca em "Reservado"; uma segunda pessoa, ao abrir o anúncio (ou puxar para atualizar a lista), vê o selo "Reservado".
- [ ] Quem anunciou toca em "Apagar" e em "Confirmar: apagar": o anúncio sai de "Meus" e da busca, e a página pública `/f/<diário>/<seq>` responde "Anúncio não encontrado".
- [ ] Agindo como Página, anunciar: o anúncio aparece em "Meus" da Página. Outro membro toca em "Conversar": a conversa é com a Página, e a Página, na caixa dela, vê a mensagem com o cartão do anúncio; a resposta da Página chega ao membro na mesma conversa, com o cartão mantido.
- [ ] "Denunciar" no anúncio de outra pessoa abre a folha de denúncia com o título do anúncio; enviada, ela aparece no painel de moderação como "anúncio", no filtro "Anúncios", com "Ver anúncio".
- [ ] No perfil de um membro (e de uma Página) com anúncios, a linha "Anúncios" abre a lista só daquela pessoa, sem abas, filtros nem "Anunciar"; puxar para atualizar funciona e quem não tem anúncios vê "Nenhum anúncio por aqui.".

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- Numa conversa da Página, o cartão do anúncio aparece sem miniatura (o app não lê as fotos da caixa da Página).
- Uma linha velha do índice mostra "Situação desconhecida" até o semeador reler o diário.

## 133. Feira: ofertas, avaliações, edição, buscas salvas e links no app (PR feat/feira-extras)

Caminhada das partes da Feira que a seção 132 deixou de fora: ofertas na conversa, avaliações, editar anúncio, buscas salvas com o ponto na aba, os links `/anuncio/` que abrem o app instalado, "Já tem o app? Abrir no app" na página pública e a Feira da Vitrine. O comportamento está em [app.md](app.md), seção "Feira"; o formato, em [protocol.md](protocol.md), seção 15.

Regras que os passos conferem:

- Uma oferta, um aceite, uma recusa, uma avaliação ou uma edição só são enviados por um toque; sem resposta, só "Tentar de novo" reenvia o mesmo pedido.
- O estado das ofertas é lido da conversa; nada sobre ofertas fica guardado em outro lugar.
- Só aparecem avaliações que o nó conferiu, com o consentimento assinado por quem anunciou.
- As buscas salvas e as contagens ficam só no aparelho; não há aviso push nem busca em segundo plano.
- Uma caixa só é marcada depois que o passo foi executado e o resultado conferido.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node apps/app/test/platformGate.test.js`, `node apps/app/test/themeUsage.test.js`, `node apps/app/test/tabBar.test.js`, `node apps/app/test/nav.test.js` e `node apps/app/test/vitrineGuard.test.js`.
- `node apps/app/test/feiraOffer.test.js`, `node apps/app/test/feiraReview.test.js`, `node apps/app/test/feiraAlerts.test.js`, `node apps/app/test/feiraChat.test.js`, `node apps/app/test/feiraCompose.test.js` e `node apps/app/test/feiraScreen.test.js`.
- `node apps/app/test/vitrine.test.js`, `node apps/app/test/vitrineIndex.test.js` e `node apps/app/test/vitrineFeira.test.js`.
- `node apps/cli/test/feira-page.test.js` e `node apps/cli/test/deploy.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada com a Feira ligada numa instalação de teste e dois membros de teste em aparelhos diferentes, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Ofertas: o comprador abre a conversa de um anúncio (Conversar), toca em "Fazer oferta", digita o "Valor (R$)" e toca em "Enviar oferta": a mensagem "Ofereço … pelo seu anúncio … na Feira" chega com o link.
- [ ] No segundo aparelho, quem anunciou vê "Aceitar" e "Recusar"; "Aceitar" abre "Aceitar oferta" com o valor e a nota "Ao aceitar, você assina um consentimento que deixa esta pessoa publicar uma avaliação do seu anúncio. Você não escolhe as estrelas, e isso não é um pagamento."; "Aceitar e assinar" envia "Aceitei sua oferta de …. Agora você pode avaliar o anúncio" e o consentimento fica na conversa.
- [ ] Recusa: numa outra oferta, "Recusar" envia "Recusei sua oferta de …" e o comprador não vê "Avaliar" para ela.
- [ ] Avaliação: o comprador vê "Avaliar" na oferta aceita, escolhe as estrelas, escreve no "Comentário (opcional)" e toca em "Avaliar": a tela volta e a avaliação aparece na tela Anúncio e no perfil de quem anunciou, com "avaliações confirmadas pelo anunciante".
- [ ] Um aceite enviado por uma terceira pessoa (que não é dona do anúncio) não libera "Avaliar".
- [ ] Uma avaliação sem consentimento válido (por exemplo, a da Vitrine com o texto "Consentimento de demonstração inválido.") não aparece no anúncio nem no perfil.
- [ ] Página: agindo como Página, fazer uma oferta num anúncio de um membro; a oferta vai como texto com o link, o membro a aceita e a Página não publica avaliação (se "Avaliar" aparecer, a tela mostra "Uma página não avalia anúncios por enquanto. Para avaliar, use o seu perfil.").
- [ ] Editar: quem anunciou toca em "Editar", vê "A primeira versão (título, texto e fotos) continua no seu diário até você apagar o anúncio. A página pública mostra a versão nova.", muda o título e toca em "Salvar": a tela volta para o anúncio com o título novo. O link `/f/<diário>/<seq>` continua o mesmo, e colá-lo num aplicativo de mensagens mostra a prévia nova (a prévia de um link já colado pode ficar em cache no aplicativo).
- [ ] Conflito: com o mesmo anúncio aberto em "Editar" em dois aparelhos, salvar num e depois no outro mostra "Este anúncio mudou em outro aparelho. Recarregue para editar a versão atual." e "Recarregar" traz a versão atual.
- [ ] Buscas salvas: na aba Feira, fazer uma busca e tocar em "Salvar busca" ("Busca salva neste aparelho."); outra pessoa publica um anúncio que a busca acha; depois de 15 minutos, abrir a Feira mostra a busca em "Buscas" com "1 novo"; ao sair da aba Feira, a aba ganha o ponto, e abrir a busca zera a contagem e tira o ponto.
- [ ] Com 10 buscas salvas, "Salvar busca" mostra "Você já tem 10 buscas salvas. Remova uma para salvar outra.".
- [ ] App Links (pendente: precisa de um aparelho Android de teste com o build de produção `app.varanda`, porque o `app.varanda.debug` só abre depois de aprovação manual): tocar num link `https://bora.varanda.app/anuncio/<diário>/<seq>` fora do app abre a tela Anúncio no app; um link `/f/…` abre no navegador.
- [ ] Links universais no iOS (pendente: precisa da implantação republicar o `apple-app-site-association` com `applinks` e de um build assinado com o direito `applinks:bora.varanda.app`): tocar num link `/anuncio/…` no Notas ou no Mensagens abre a tela Anúncio no app.
- [ ] Na página pública `/f/<diário>/<seq>`, com o app instalado, "Já tem o app? Abrir no app" abre a tela Anúncio no app (Android e iOS).
- [ ] Vitrine: com `EXPO_PUBLIC_VARANDA_VITRINE=1`, a aba Feira mostra os anúncios de exemplo, um deles com a avaliação de 5 estrelas, e a conversa de exemplo mostra a oferta aceita.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- O ponto da aba Feira reflete o que a última abertura da Feira contou; ele não é atualizado em segundo plano.
- As contagens olham só a primeira página de cada busca.

## 134. Bloquear uma pessoa (PR feat/member-block)

Caminhada do bloqueio pessoal: o menu da publicação, o perfil, a lista em Ajustes e cada leitura que tem de obedecer a ele. A lista fica no aparelho (`docs/rpc.md` 5.111 e 5.112) e cobre o que a regra 1.2 da App Store pede.

Regras que os passos conferem:

- Quem filtra é o nó ao ler, não uma tela. A tela só limpa na hora o que já mostrava.
- A pessoa bloqueada não recebe nada: nenhum aviso, nenhum registro que diga que houve bloqueio. O deixar de seguir é um registro público comum.
- Como os diários são públicos, ela ainda pode ver o que você publica, seguir e responder. Só quem bloqueou deixa de ver.
- A dobra de um grupo não obedece à lista.
- Uma caixa só é marcada depois que o passo foi executado e o resultado conferido.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node packages/core/test/member-block.test.js`, `node packages/web-member/test/member-block.test.js` e `node packages/rpc/test/methods.test.js`.
- `node apps/app/test/memberBlocks.test.js`, `node apps/app/test/postActions.test.js`, `node apps/app/test/sw.test.js`, `node apps/app/test/vitrine.test.js` e `node apps/app/test/platformGate.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada com dois membros de teste, A e B, que se seguem e têm publicações, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Em A Rua, no menu **Mais** de uma publicação de B, aparecem **Denunciar** e **Bloquear**; numa publicação de A, nenhum dos dois.
- [ ] **Bloquear** abre "Bloquear B?" com a nota de que a pessoa não é avisada e de que ainda pode ver o que você publica. **Cancelar** não muda nada.
- [ ] Confirmar mostra "Pessoa bloqueada. Desfaça em Ajustes." e as publicações de B somem de A Rua na hora, sem puxar para atualizar. O botão de publicar não cobre o aviso.
- [ ] Em Seguindo, B não aparece mais. Depois de sincronizar, um terceiro membro vê A sem seguir B, e nada no diário de A diz que houve bloqueio.
- [ ] Uma republicação de uma publicação de B por um terceiro membro some de A Rua; uma citação de B por um terceiro mostra "Publicação indisponível"; a publicação do terceiro continua.
- [ ] Espiadinha: as publicações de B não aparecem, e a nota "N diários não aparecem" não conta B.
- [ ] Busca: uma palavra que só B publicou não traz a publicação de B. Em Contas, B ainda aparece, e tocar abre o perfil.
- [ ] Conversa de uma publicação com respostas de B: as respostas de B não aparecem; as dos outros, sim.
- [ ] Avisos: curtida, resposta, citação ou menção de B depois do bloqueio não geram linha. As linhas antigas de B somem.
- [ ] Perfil de B: mostra "Você bloqueou esta pessoa" e **Desbloquear**, sem publicações, sem Seguir e sem Mensagem.
- [ ] Conversas: uma mensagem de B enviada depois do bloqueio não aparece; a conversa antiga fica, com "Você bloqueou esta pessoa" e **Desbloquear**. Tentar enviar é recusado.
- [ ] Ajustes, **Pessoas bloqueadas**: B aparece com o nome ou o @nome. **Desbloquear** tira B da lista, e as publicações de B voltam a aparecer na Busca e na Espiadinha. B não volta a ser seguido.
- [ ] Reabrir o app depois de bloquear: B continua bloqueado, também sem internet.
- [ ] Sair e entrar com outra conta no mesmo aparelho: a lista da conta anterior não vale para a nova (**Apagar** a conta deste aparelho limpa a lista).
- [ ] Sem internet, **Bloquear** funciona, e o aviso de que o bloqueio de mensagens ainda não chegou aos outros aparelhos não impede o bloqueio.
- [ ] Web e PWA, com avisos push ligados e o app fechado: uma curtida de B depois do bloqueio não mostra notificação; a de outra pessoa mostra. Depois de **Desbloquear** e de abrir o app uma vez, a de B volta a aparecer. No Safari do iPhone, conferir que a assinatura de push continua válida depois de um push silenciado.
- [ ] Vitrine: com `EXPO_PUBLIC_VARANDA_VITRINE=1`, **Bloquear** num post de exemplo tira o post da tela, e a pessoa aparece em Pessoas bloqueadas.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação. Uma conferência prévia com a Vitrine, sem membros reais, passou no simulador iOS: bloquear pelo menu da publicação e pelo perfil, a lista em Ajustes e desbloquear. Android, a caminhada com dois membros e os avisos push em navegador real seguem por fazer.
- A lista entre aparelhos está na seção 135.
- Grupos, comunidades e Feira não são filtrados.

## 135. Lista de bloqueio em todos os aparelhos da passkey (PR feat/member-block-sync)

Caminhada da lista de pessoas bloqueadas entre os aparelhos da mesma passkey, pelo bloco cifrado de vistos (`docs/protocol.md`, seção 14, versão 2).

Regras que os passos conferem:

- O serviço de conta guarda um bloco do mesmo tamanho de antes e não consegue ler a lista.
- Em cada chave vale a mudança mais nova: um desbloqueio não é desfeito por um bloqueio mais antigo.
- A falta de uma entrada no bloco nunca conta como desbloqueio.
- Um aparelho com a versão anterior não usa o bloco novo nem grava por cima dele.
- Uma caixa só é marcada depois que o passo foi executado e o resultado conferido.

Como verificar, a partir da raiz (só os arquivos desta área, um por vez):

- `node packages/core/test/seen-blob.test.js`, `node packages/core/test/member-block.test.js` e `node packages/web-member/test/seen-sync.test.js`.
- `node apps/app/test/seenSync.test.js`, `node apps/app/test/vitrine.test.js` e `node apps/cli/test/account-seen.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada com a mesma passkey em dois aparelhos, A e B, com o terceiro membro C publicando, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Em A, bloquear C. Em até dois minutos, com B aberto, as publicações de C somem de A Rua e da Espiadinha em B, e C aparece em Ajustes, Pessoas bloqueadas, em B.
- [ ] Em B, desbloquear C. Em até dois minutos, C sai da lista em A, e as publicações de C voltam na Busca em A.
- [ ] Com B sem internet, bloquear C em A e desbloquear D em A. Ao voltar a internet em B, as duas mudanças chegam.
- [ ] Bloquear C em A e, com A sem internet, bloquear E em B. Com os dois de volta, os dois aparelhos ficam com C e E.
- [ ] Em A, **Apagar** a conta deste aparelho e entrar de novo com a mesma passkey: a lista volta depois da primeira passada de vistos.
- [ ] Um aparelho novo da mesma passkey recebe a lista.
- [ ] Marcas de visto seguem valendo: um aviso visto em A não aparece como novo em B.
- [ ] Um aparelho com a versão anterior do app ao lado de um com esta: nada quebra no anterior, ele para de receber vistos e, depois de atualizar, volta a receber, com a lista.

Limites desta caminhada:

- Nenhuma caixa acima foi executada nesta documentação.
- Passa o limite de 128 mudanças, a mais antiga fica só no aparelho onde já estava; um aparelho novo não a recebe.

Nota: não existe a seção 136. O número nunca foi usado (o histórico do arquivo não tem essa seção), então a numeração pula da 135 para a 137 sem roteiro perdido.

## 137. Termos 29 e manifesto de privacidade para a revisão da App Store (PR fix/terms-privacy-manifest-store)

As seções anteriores não mudam. Esta seção documenta os textos e o manifesto preparados para a primeira revisão da App Store (issue #46).

### O que mudou

- Termos e Política na versão 29 (`apps/app/src/legal.js`, `TERMS_VERSION` em `packages/core/lib/terms.js`), com novo aceite: tolerância zero com conteúdo censurável e abuso, a conferência de termos no aparelho antes de publicar, o bloqueio de outra pessoa, seção "Seu conteúdo", contato por e-mail, Instituto Varanda em constituição e conta individual nas lojas, sem a menção a protótipo.
- A verificação de idade, as denúncias, o recurso, a passkey, o vínculo Google e as fotos passam a constar como válidos também no app ligado à instalação da associação, como o código já fazia (`apps/app/App.js`, `Denunciar.js`, `Recurso.js`). A verificação de idade segue sem rodar no app com configuração manual.
- A Política deixa de dizer que a exclusão da conta não tem fluxo próprio, e passa a citar o registro de erros do servidor web, que pode guardar o texto de uma busca, e as estatísticas de uso.
- `NSPrivacyCollectedDataTypes` preenchido com os 13 tipos do formulário App Privacy (`docs/development.md`) em `apps/app/ios/Varanda/PrivacyInfo.xcprivacy` e em `ios.privacyManifests` do `apps/app/app.json`. Identificadores conferidos na documentação da Apple em 2026-11-08.

### Testes automatizados

- `node apps/app/test/legal.test.js`: versão, data, resumo do texto e as frases da versão 29.
- `node apps/app/test/terms-version.test.js` e `node packages/core/test/terms.test.js`: as duas constantes de versão.
- `node apps/site/test/legal.test.js`: as páginas `termos/` e `privacidade/` geradas de `legal.js`.
- `node apps/app/test/hardening.test.js`: a lista de dados no `app.json` e no manifesto, e o `expo prebuild --clean` numa cópia temporária reproduzindo o manifesto.

### Checagens humanas (a fazer)

- [ ] A conferência de termos no aparelho e o bloqueio de outra pessoa, com a lista guardada no bloco cifrado, já estão no ar antes de a versão 29 ir ao ar, porque os documentos os descrevem como existentes. Os dois já entraram (seções 134, 135 e 138); falta só conferir no ar.
- [ ] A caixa `contato@varanda.app` existe e recebe e-mail antes de a versão 29 ir ao ar. Em 2026-11-08, `varanda.app` não tinha registro MX.
- [ ] App Store Connect, App Privacy: as respostas publicadas (Publish) são as do manifesto (`docs/development.md`).
- [ ] App Store Connect, direitos de conteúdo: resposta dada com base na seção "Seu conteúdo".
- [ ] O nome em "O que é o Varanda" é o mesmo que a App Store mostra como vendedor.
- [ ] Revisão jurídica do texto novo: associação em constituição e conta individual, autorização de uso do conteúdo, lista do que é proibido, canal para pedidos sobre dados.
- [ ] `pod install` mantém `NSPrivacyCollectedDataTypes` e muda só a indentação do manifesto.
- [ ] Android e simulador iOS, com a instalação: o portão pede o novo aceite, e Ajustes › Termos e privacidade mostra a versão 29 com a seção "Seu conteúdo".

### Limites

- `supportUrl` em `apps/app/store.config.json` e a seção Contato do site continuam sem o e-mail.
- O texto promete "não tolera" sem prazo de resposta: os Termos não fixam em quantas horas uma denúncia é analisada.
- A autorização de uso vai do membro para a associação. A licença de uso comercial dentro da rede, do rascunho do estatuto, não entrou nesta versão.

## 138. Conferência de palavras no aparelho (PR feat/on-device-word-check)

O app recusa, antes de publicar, texto público com um termo de `apps/app/src/blockedTerms.js`. É o item "método para filtrar" da diretriz 1.2 da App Store. Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- A comparação é por palavra inteira, depois de dobrar acentos e maiúsculas, e lê o texto todo.
- A recusa é definitiva: o rascunho fica para editar, e não há como publicar mesmo assim.
- Momentos e depoimentos também passam pela conferência, inclusive ao tocar em "Mostrar no perfil" para um depoimento recebido (seção 143).
- Mensagens diretas, grupos privados, denúncias e recursos não passam pela conferência.
- Nada sai do aparelho: nenhum pedido, contador, log ou registro de recusa.

Como verificar, a partir da raiz:

- `node apps/app/test/wordCheck.test.js`, `node apps/app/test/search.test.js`, `node apps/app/test/feiraCompose.test.js`, `node apps/app/test/forward.test.js` e `node apps/app/test/groups.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA. Com `EXPO_PUBLIC_VARANDA_VITRINE=1` as telas abrem sem conta. Use `vou te matar` como termo de teste, ou outro da lista:

- [ ] Publicar: escrever `Bom dia, Vou te MATAR amanhã` e tocar em Publicar. Aparece `Não dá para publicar: "vou te matar" é um termo que o Varanda não permite em conteúdo público. Edite o texto e tente de novo.`, o rascunho continua na caixa e nada entra na fila nem em A Rua. Editar o texto e publicar funciona.
- [ ] Sem conexão: a mesma recusa, e nada entra na fila de envio.
- [ ] Responder e citar: a mesma recusa nas duas folhas.
- [ ] Agindo como Página: a mesma recusa, antes de assinar.
- [ ] Palavra maior: `a cultura do bairro` e `o macaco fugiu` publicam normalmente.
- [ ] Grupo público: a recusa aparece acima da caixa ao enviar, inclusive com foto e legenda.
- [ ] Grupo privado e mensagem direta: o mesmo texto é enviado.
- [ ] Encaminhar: uma mensagem com o termo é recusada para um grupo público e encaminhada para uma conversa ou um grupo privado.
- [ ] Editar perfil, e o passo do perfil na entrada: o termo no nome ou na bio mostra a recusa enquanto se digita e desliga Salvar ou Continuar.
- [ ] Feira: em Anunciar e em Editar, o termo no título, na descrição, na cidade ou no bairro mostra a recusa logo acima do botão, e nenhuma foto é enviada.
- [ ] Nome de grupo público e de comunidade, ao criar e ao renomear: a recusa aparece enquanto se digita e desliga o botão. Com a visibilidade "Privado" em Novo grupo, a recusa some.
- [ ] @nome: ao vincular a conta e em "trocar @nome", `vou_te_matar` mostra a recusa ao tocar no botão, e nada vai ao serviço de conta.
- [ ] Página: em Nova página, o termo no @nome, no nome ou na bio mostra a recusa enquanto se digita e desliga "Criar página". Nos ajustes da Página, o mesmo no nome e na bio (Salvar) e em "Novo @nome" (Trocar @nome).
- [ ] Avaliar, na Feira: o termo no comentário mostra a recusa ao tocar em Avaliar, e nada é publicado.
- [ ] Cartão de convite: o termo em "Pra quem?" ou em "Sua mensagem" mostra a recusa e desliga "Criar link com cartão". "Mandar sem cartão" continua funcionando.
- [ ] Denunciar: o termo na observação é enviado.
- [ ] Rede: com o inspetor de rede aberto na web, uma recusa não gera nenhum pedido.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- A conferência não cobre o título e a descrição de uma prévia de link, que vêm do site.
- O serviço de conta não conhece a lista, então um @nome só é recusado no app.
- Um @nome com letras e números colados (`termo123`) conta como uma palavra só e passa.
- Um app modificado, um build antigo ou a CLI publicam sem passar por ela. Isso se confere lendo `apps/app/src/wordCheck.js`: o protocolo e o semeador não têm a lista.
- Ela não lê fotos nem áudio, e grafias diferentes passam.

## 139. Mensagem em particular numa publicação de Página (PR fix/page-dm-from-posts)

Os itens do feed não dizem se o autor é uma Página, então **Mensagem em particular** aparece numa publicação de Página até o app aprender isso. Antes, o toque abria a conversa da página com o chip da publicação e sem o aviso único de "Conversar com a página". Agora o toque confere o autor antes de abrir. Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- Ao tocar, o app pergunta, em paralelo, ao índice de membros do semeador (dica de Página, guardada por 5 min) e ao nó (`page.read`). Um autor que o app já conhece como Página não gera pedido.
- Uma Página aberta passa pelo aviso "Conversar com a página" (uma vez por aparelho e por página, o mesmo do perfil e da Feira) e abre a conversa da página sem o chip de contexto.
- Uma Página encerrada ou que mudou de chave, confirmada pelo nó (`page.read`), mostra "Esta página não recebe mensagens." e não abre nada.
- Uma Página conhecida só pela dica do semeador nunca é recusada: recebe o aviso e abre sem o chip. A dica não é confiável e não pode calar a mensagem de uma pessoa.
- Uma pessoa abre a conversa com o chip, como antes.
- Um segundo toque enquanto a conferência não respondeu é ignorado, e uma resposta que chega depois de bloquear, desbloquear ou trocar de conta é descartada.
- Depois do toque, o app guarda que o autor é uma Página só quando o nó confirmou, e então a ação some das publicações dele. A dica do semeador sozinha não fica guardada.

Como verificar, a partir da raiz:

- `node apps/app/test/dm.test.js`, `node apps/app/test/postActions.test.js`, `node apps/app/test/privateReply.test.js`, `node apps/app/test/platformGate.test.js` e `node apps/app/test/feedRender.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA, com uma conta que segue uma Página aberta, uma Página encerrada e uma pessoa:

- [ ] A Rua, publicação da Página aberta, num aparelho que nunca conversou com ela: ⋯ e **Mensagem em particular** abrem o aviso "Conversar com a página". Continuar abre a conversa da página, sem chip acima do campo. Cancelar não abre nada.
- [ ] De novo, noutra publicação da mesma Página (se a ação ainda aparecer): a conversa abre direto, sem o aviso.
- [ ] Depois do primeiro toque, voltar à Rua: as publicações da Página não têm mais **Mensagem em particular**.
- [ ] Publicação da Página encerrada, com o diário dela já no nó: o toque mostra "Esta página não recebe mensagens." e nada abre.
- [ ] Publicação de uma pessoa: a conversa abre com o chip "Sobre a sua publicação de ...", como antes.
- [ ] Toque duplo rápido numa publicação de Página: só um aviso aparece.
- [ ] Sem internet: o toque numa publicação de pessoa ainda abre a conversa com o chip.
- [ ] O mesmo numa conversa (Conversa) e num perfil.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Quando o semeador não manda a dica de Página (um semeador antigo, `pageHintOf` em `apps/app/src/indexClient.js`) e o `page.read` responde `NOT_FOUND` (o diário está noutro lugar), o autor é tratado como pessoa e a conversa abre como antes, com o chip. É o padrão decidido: falhar aberto, para uma pessoa nunca ficar sem mensagem quando o semeador demora.
- Um autor desconhecido sem nome nem @nome não fica guardado como Página (`namesCache.js`), então a ação pode continuar aparecendo até o nome chegar. A conferência no toque continua valendo.

## 140. Conversa abre na mensagem mais nova (PR fix/conversation-newest-and-send)

Três ajustes das conversas (Conversa em particular e Grupo). Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- Uma conversa abre na mensagem mais nova e acompanha a lista enquanto ela desenha mais linhas: o fim é fixado por `onContentSizeChange` e, 50 ms depois, mais uma rolagem sem animação, quando o layout assentou.
- Qualquer gesto solta a fixação: toque, roda do mouse, arrastar, teclas (seta para cima, Page Up, Home, Shift+Espaço) e clique do mouse na lista. Uma rolagem para cima de mais de 48 px também solta. **Mensagens anteriores** solta, e no grupo o salto até uma citação também.
- Uma mensagem nova fixa de novo no fim.
- A seta que aparece ao passar o mouse numa mensagem não cobre mais a citação dentro do balão.
- Se a correção automática do teclado (iOS) muda a última palavra do rascunho no mesmo instante do **Enviar**, e só nos 400 ms seguintes, o campo é limpo mesmo assim, com o texto que a pessoa viu, e não convida a um envio duplo. Só a primeira mudança do campo depois do envio é acompanhada: uma edição seguinte, uma palavra a mais ou outra palavra alterada fica no campo. Reenviar uma mensagem retida continua mantendo um rascunho mais novo.

Como verificar, a partir da raiz:

- `node apps/app/test/chatActions.test.js`, `node apps/app/test/conversas.test.js`, `node apps/app/test/dm.test.js`, `node apps/app/test/groupScreen.test.js`, `node apps/app/test/group-flow.test.js`, `node apps/app/test/wordCheck.test.js`, `node apps/app/test/chatMedia.test.js` e `node apps/app/test/feedRender.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Abrir uma conversa longa: ela abre na mensagem mais nova, mesmo com fotos e cartões carregando depois.
- [ ] Rolar para cima durante o carregamento: a lista não volta ao fim sozinha. Chegar uma mensagem nova leva ao fim de novo.
- [ ] **Mensagens anteriores** e, num grupo, tocar numa citação: a lista fica onde a pessoa foi, sem pular para o fim.
- [ ] Web: a roda do mouse, as teclas e o clique na lista soltam o fim.
- [ ] Web, passando o mouse numa mensagem com citação: a seta não cobre a citação.
- [ ] iOS, digitar uma palavra que a correção automática troca (por exemplo "teh") e tocar **Enviar** sem tocar na barra de sugestões: o campo fica vazio.
- [ ] iOS, enviar e logo digitar outra palavra: o campo guarda o que foi digitado depois.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- A janela de 400 ms e a regra da última palavra são o que o teste cobre; o comportamento real do teclado do iOS só se confere no aparelho.
- Digitar mais depois do envio ("oi" para "oi!") ou apagar o fim ("oi" para "o") nunca conta como correção. Uma edição manual dentro da última palavra nos 400 ms seguintes ao **Enviar** (apagar uma letra do meio, por exemplo) não se distingue da correção automática e é limpa quando o envio dá certo: sem um sinal do teclado, o app não tem como separar as duas.

## 141. Toques na web: visualizador de fotos, botões aninhados, alvos de 44 pt e barra de abas opaca (PR fix/web-taps-and-targets)

Conjunto de correções de toque. Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- Web: tocar dentro do visualizador de fotos não abre mais a publicação que está por trás dele. O visualizador para a propagação do clique.
- Ações e contagens da publicação (curtir, republicar, responder, mais) e o botão de informações têm 44 pt de altura. A altura da linha não muda. Os pares divididos de curtir e republicar mantêm a largura estreita, para a barra caber em 320 pt.
- O botão de ajuda de A Rua tem 44 pt.
- As abas ficam com 48 pt de altura dentro da barra de 49 pt (a borda de 1 pt fica por cima). Toda a faixa sob o ícone é alvo de toque. A barra não tem mais preenchimento superior.
- No aplicativo (iOS e Android) a barra de abas é opaca, nos dois esquemas de cor: o conteúdo que passa por baixo não aparece através dela. Na web ela já era opaca.
- Miniatura de link (cartão de link) não é mais um botão aninhado dentro de outro botão. A nova tentativa de foto de anúncio da Feira também não (`tapRetry={false}`).

Como verificar, a partir da raiz:

- `node apps/app/test/appearance.test.js`, `node apps/app/test/themeUsage.test.js`, `node apps/app/test/tabBar.test.js`, `node apps/app/test/pwa.test.js`, `node apps/app/test/renderOg.test.js` e `node apps/app/test/momentosScreen.test.js`.
- `node apps/app/test/postActions.test.js`, `node apps/app/test/help.test.js`, `node apps/app/test/linkPreview.test.js` e `node apps/app/test/muralGrid.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Abas: tocar na faixa de baixo do ícone de cada aba troca de aba. A barra tem a mesma altura de antes, sem espaço vazio em cima dos ícones.
- [ ] iOS: com uma lista rolando por baixo da barra, o conteúdo não aparece através dela, no modo claro e no escuro.
- [ ] Publicação: curtir, republicar, responder e o menu de mais têm área de toque de 44 pt. Num aparelho de 320 pt de largura, a barra de curtir e republicar cabe sem cortar nenhum botão.
- [ ] A Rua: o botão de ajuda abre a folha de ajuda com a área de toque inteira.
- [ ] Web: abrir uma foto em tela cheia no visualizador e tocar nela (ou nos controles dentro dele) não abre a publicação de trás.
- [ ] Cartão de link com miniatura: tocar na miniatura faz o mesmo que tocar no cartão, e o app não reclama de botão dentro de botão.
- [ ] Feira: uma foto de anúncio que falha mostra "foto indisponível" sem botão próprio; tocar nela abre o anúncio, e a foto tenta de novo sozinha (2, 5 e 15 s) enquanto o cartão estiver na tela.
- [ ] Web e PWA: repetir as conferências de abas e de publicação na largura de celular.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes conferem o código-fonte dos estilos e a ausência de botões aninhados por leitura de arquivo, não o toque real. A área de 44 pt e a opacidade do iOS só se confirmam no aparelho ou no simulador.

## 142. Perfil: linha Anúncios, ícones do menu mais e pílulas com texto grande (PR fix/profile-polish)

Correções de acabamento do perfil. Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- No perfil de um membro ou de uma Página (nó hospedado), a linha "Anúncios" é um link com ícone da Feira à esquerda e seta à direita, e fica acima das abas, junto com a linha "Avaliações". Perfil bloqueado não mostra as duas.
- No menu "mais" de uma Página, "Agir como esta página", "Deixar de agir como a página", "Ajustes da página", "Seguir como a página" (e "Deixar de seguir") e "Compartilhar perfil" têm ícone.
- Com texto grande (escala de fonte acima de 1,3), as pílulas empilham em largura total e o botão "mais" fica na mesma linha da última pílula. No tamanho normal o layout não muda.

Como verificar, a partir da raiz:

- `node apps/app/test/profileActions.test.js`, `node apps/app/test/dm.test.js`, `node apps/app/test/muralScreen.test.js`, `node apps/app/test/profileBar.test.js`, `node apps/app/test/pageProfile.test.js` e `node apps/app/test/platformGate.test.js`.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Perfil de uma Página com anúncios: "Anúncios" aparece logo acima das abas, com o ícone e a seta, e tocar abre a lista.
- [ ] Perfil sem anúncios ou com perfil bloqueado: a linha não aparece.
- [ ] Menu "mais" de uma Página que você administra: cada item mostra o ícone certo.
- [ ] Texto do sistema no maior tamanho: as pílulas ficam empilhadas e o botão "mais" fica ao lado da última, sem terceira linha.
- [ ] Web e PWA: repetir as conferências acima na largura de celular.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes conferem o código-fonte por leitura de arquivo, não a tela. A posição da linha e o layout com texto grande só se confirmam no aparelho ou no simulador.

## 143. Conferência de palavras em momentos e depoimentos, Termos 32 (PR feat/word-check-moments-testimonials)

A conferência de palavras no aparelho passa a cobrir momentos e depoimentos, inclusive a exibição de um depoimento recebido no perfil. Os Termos descrevem essas superfícies na versão 32, com novo aceite dos Termos e da Política de Privacidade. A data continua 08/11/2026. Não muda protocolo, semeador nem RPC.

Regras que os passos conferem:

- Um momento com termo da lista é recusado antes de `putMoment`, sem enviar texto nem mídia. O rascunho fica para editar.
- Um depoimento com termo da lista é recusado antes de `testimonial.write`, com o texto preservado para edição.
- "Mostrar no perfil" confere o texto do depoimento recebido e recusa antes de `testimonial.show` se houver termo da lista, inclusive quando ele veio de um app antigo ou modificado.
- Texto permitido continua funcionando nas três ações. A comparação por palavra inteira e as exclusões da seção 138 continuam valendo.
- Nada dessa conferência sai do aparelho nem fica registrado.
- `LEGAL_VERSION` e `TERMS_VERSION` são 32, a nota de revisão acompanha a versão e o digest SHA-256 fixa o novo texto. Os Termos e a Política não contêm termos da lista.
- As páginas de Termos e Privacidade do site são regeneradas por `node apps/site/scripts/render-legal.js` e correspondem ao texto do app.

Como verificar, a partir da raiz:

- `node apps/app/test/wordCheck.test.js`, `node apps/app/test/momentosScreen.test.js` e `node apps/app/test/depoimentos.test.js`.
- `node apps/app/test/legal.test.js`, `node apps/app/test/terms-version.test.js`, `node apps/app/test/terms.test.js` e `node packages/core/test/terms.test.js`.
- `node apps/site/scripts/render-legal.js --check`, que deve sair com código 0, e `node apps/site/test/legal.test.js`, `node apps/site/test/site.test.js` e `node apps/site/test/brand.test.js`.
- `npx standard apps/app/src/legal.js packages/core/lib/terms.js packages/core/test/terms.test.js apps/app/test/legal.test.js apps/app/src/screens/Publicar.js apps/app/src/screens/Depoimentos.js apps/app/test/wordCheck.test.js apps/app/test/momentosScreen.test.js apps/app/test/depoimentos.test.js`.

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA. Use um termo da lista de `apps/app/src/blockedTerms.js`:

- [ ] Momento: escrever o termo, anexar uma foto e tentar publicar. A recusa aparece, o rascunho permanece e nada é enviado. Editar para texto permitido e publicar funciona.
- [ ] Escrever depoimento: inserir o termo e tentar enviar. A recusa aparece e o texto continua disponível para editar. Corrigir e enviar funciona.
- [ ] Depoimento recebido por um app antigo ou modificado: tocar em "Mostrar no perfil" com um termo no texto. A recusa aparece e o depoimento não é mostrado. Um depoimento permitido pode ser mostrado normalmente.
- [ ] Sem conexão: repetir as recusas e confirmar que nenhuma ação entra na fila de envio.
- [ ] Novo aceite: entrar com aceite anterior e conferir a apresentação da versão 32. Em Ajustes e nas páginas do site, conferir a mesma versão, data e redação sobre momentos e depoimentos.
- [ ] Web e PWA: repetir as conferências acima; uma recusa não gera pedido no inspetor de rede.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes por leitura do código não substituem a conferência das telas no aparelho ou no simulador.
- A lista continua local ao app; um app modificado, um build antigo ou a CLI podem publicar sem essa conferência. Fotos e áudio não são analisados.

## 144. Momentos, Feira e botão de publicar nos depoimentos: ajustes visuais (PR fix/momentos-feira-polish)

Ajustes de tela que sobravam de revisões anteriores. Não muda protocolo, semeador, RPC nem Termos.

Regras que os passos conferem:

- A faixa de aviso (toast) não aparece por cima do visualizador de momentos. Ela fica escondida enquanto o visualizador está aberto ou fechando, e abrir o visualizador descarta um aviso pendente. Assim, "A foto sai dos servidores em até 7 dias" não é coberto e não reaparece ao fechar.
- No compositor de momento, escolher uma foto rola a tela até o campo de texto e o contador, sem focar o campo. O teclado não abre sozinho.
- O botão flutuante de publicar fica escondido enquanto a aba Depoimentos do perfil está aberta, no Diário e no perfil de um membro ou de uma Página. Assim ele não cobre a seta "Enviados" nem a aba vazia de uma Página. Voltar para Publicações ou Mural o mostra de novo.
- Na Feira, o botão "Anunciar" tem o texto limitado a 1,3 de escala de fonte, para não cobrir "Salvar busca" com texto grande no iOS.
- Na Feira, as pílulas de filtro (tipo e categoria) têm espaço vertical e não encostam nas linhas divisórias.
- Na Feira, "Buscar" e Enter nos campos de cidade e palavras fecham o teclado antes de aplicar a busca, para o resultado aparecer sem ele por cima.

Como verificar, a partir da raiz:

- `node apps/app/test/feiraScreen.test.js`, `node apps/app/test/feira.test.js`, `node apps/app/test/feiraAlerts.test.js`, `node apps/app/test/feiraSaved.test.js`, `node apps/app/test/conversasList.test.js` e `node apps/app/test/platformGate.test.js`. O primeiro confere por leitura do código o botão "Anunciar", o fechamento do teclado em `applyFilters` e o espaçamento das pílulas.
- `node apps/app/test/momentosScreen.test.js`, `node apps/app/test/depoimentos.test.js` e `node apps/app/test/tabBar.test.js`, que cobrem o aviso sobre o visualizador, o compositor e o botão de publicar.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Momentos: com a barra de aviso ativa, abrir um momento. O aviso não aparece por cima do visualizador, e não reaparece ao fechá-lo.
- [ ] Momentos: no compositor, com o campo de texto no fim da tela, escolher uma foto. A tela rola até o campo e o contador, e o teclado não abre.
- [ ] Diário, aba Depoimentos: o botão de publicar some, e a seta "Enviados" fica livre. Voltar para Publicações ou Mural mostra o botão de novo.
- [ ] Perfil de uma Página sem depoimentos, aba Depoimentos: a aba vazia não tem o botão por cima.
- [ ] Perfil de um membro, aba Depoimentos: o botão some e volta ao trocar de aba.
- [ ] Feira com texto grande no iOS: "Anunciar" cabe no botão e não cobre "Salvar busca".
- [ ] Feira: as pílulas de tipo e de categoria têm respiro acima e abaixo e não encostam nas linhas.
- [ ] Feira: tocar em "Buscar", ou Enter na cidade ou nas palavras, fecha o teclado e mostra o resultado.
- [ ] Web e PWA: repetir as conferências acima na largura de celular.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes conferem o código-fonte por leitura de arquivo, não a tela. A posição do botão, o respiro das pílulas e o comportamento do teclado só se confirmam no aparelho ou no simulador.
- O fechamento do teclado em "Buscar" vale para todas as plataformas, porque a regra fica na função compartilhada; a conferência no Android é a que importa para o teclado.

## 145. Vitrine: fotos de anúncios, origem de demonstração, contagens ao vivo (PR chore/vitrine-demo-data)

Ajustes só do modo Vitrine (demonstração, `EXPO_PUBLIC_VARANDA_VITRINE=1`). Não mudam nada no uso real: protocolo, RPC, semeador e o nó de verdade ficam como estão.

O que mudou:

- As fotos dos anúncios da Feira carregam na demonstração. A mídia do anúncio é montada com bytes de fotos de verdade e o `publicMedia` a encontra.
- A origem de instalação da demonstração é `https://vitrine.invalid`. Com isso as buscas salvas da Feira persistem e os controles de oferta (Aceitar, Recusar, Fazer oferta e as respostas rápidas) aparecem na conversa de demonstração. Eles nunca apareciam na demonstração e por isso nunca foram revistos.
- As contagens de curtidas e de compartilhamentos seguem os toques ao vivo. Curtir ou compartilhar uma publicação e sair de A Rua e voltar mantém a contagem, e desfazer a leva de volta ao valor de antes. Cada instância da demonstração tem a sua lista, e os dados de exemplo não mudam.

Como verificar, a partir da raiz:

- `node apps/app/test/vitrineIndex.test.js`, `node apps/app/test/vitrine.test.js`, `node apps/app/test/vitrineGuard.test.js`, `node apps/app/test/vitrineFeira.test.js`, `node apps/app/test/vitrineLarge.test.js` e `node apps/app/test/engagement.test.js`. O teste "live likes and reposts move the counts" falha sem a junção dos registros ao vivo.
- `npm run lint`, `npm test` e `npm run demo`, que têm de passar (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA, com `EXPO_PUBLIC_VARANDA_VITRINE=1`:

- [ ] Feira: os anúncios mostram foto, na lista e na página do anúncio.
- [ ] Feira: salvar uma busca, sair da tela e voltar. A busca continua salva.
- [ ] Conversa de demonstração com um anúncio: aparecem Aceitar e Recusar numa oferta recebida, Fazer oferta e as respostas rápidas. Percorrer cada controle: aceitar, recusar, fazer uma oferta e tocar numa resposta rápida, conferindo o texto, o estado depois do toque e que nada quebra.
- [ ] A Rua: curtir uma publicação e compartilhar outra. Ir para outra aba e voltar: as contagens e os ícones continuam. Desfazer volta ao número de antes.
- [ ] Diário: um compartilhamento feito na demonstração aparece na lista do próprio Diário e some ao desfazer.
- [ ] Web e PWA: repetir as conferências acima na largura de celular.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes conferem as respostas da demonstração, não a tela. Fotos, controles de oferta e posição só se confirmam no aparelho ou no simulador.
- Os controles de oferta nunca foram revistos na demonstração antes desta mudança: a caminhada acima é a primeira revisão deles.

## 146. Entrar e criar conta em palavras simples (PR feat/simple-sign-in)

Só apresentação e texto: protocolo, RPC, handlers e o serviço de conta ficam como estão.

O que mudou:

- O primeiro passo "Bem-vindo à Varanda" é uma tela de boas-vindas. Não tem título na barra nem "Passo 1 de 3": só o botão de informação (i) no canto de cima, que abre "Como funciona a entrada" com todas as explicações.
- O hero tem a cadeira num disco (creme no escuro), o título "Bem-vindo à Varanda" (28 pt) e "Uma rede social feita entre pessoas.".
- Dois botões grandes de largura total (52 pt) perto de baixo: "Criar minha conta" (cheio) e "Já tenho conta" (contornado). Quando o aparelho já conhece a conta, só "Entrar". Com "Concluir e entrar" esperando, "Criar minha conta" vira secundário.
- Os avisos (conta não encontrada, conta conhecida que não apareceu, entrada perdida, rede cheia, convite, Feira, conta de outra passkey) aparecem em caixas suaves acima dos botões.
- O link calmo "Outras formas de entrar" com seta (no lugar de "Mais opções" e "Menos opções") tem o mesmo texto aberto ou fechado; leitores de tela anunciam expandido e recolhido. Some quando nenhuma opção se aplica. Aberto, mostra linhas: "Entrar com outra passkey", "Criar com o celular" ou "Entrar com o celular" (só na web, com QR code) e "Entrar com código de recuperação", cujo campo abre dentro da lista e fica acima do teclado no Android. Abre sozinho depois de uma entrada que não encontra a conta e pode ser fechado.
- A linha "Para criar a conta ou entrar, basta confirmar com o rosto..." saiu da tela; está na ajuda (i).
- Quando criar a conta precisa de uma confirmação extra, a tela diz "Falta só confirmar mais uma vez. Toque em Concluir e entrar.". Fechar a janela do Face ID ou da digital mostra "Você fechou a confirmação. Toque de novo quando quiser.".
- Em Ajustes › Conta o mesmo conteúdo aparece dentro do cartão, sem o hero.
- Peças novas: `apps/app/src/ui/Welcome.js` (WelcomeHeader), `apps/app/src/ui/OptionRow.js` (OptionsToggle, OptionList, OptionRow, OptionBlock), `Btn large`, `Page grow` e `type.heroTitle`. Nada muda em como a conta é criada ou aberta.

Como verificar, a partir da raiz:

- `node apps/app/test/entrarCard.test.js`, `node apps/app/test/passkeysScreen.test.js`, `node apps/app/test/passkeyTrouble.test.js`, `node apps/app/test/help.test.js`, `node apps/app/test/onboarding.test.js`, `node apps/app/test/signupAdmission.test.js`, `node apps/app/test/sessionStoreNative.test.js` e `node apps/app/test/uiKit.test.js`.
- `npm ci --ignore-scripts`, `npm run lint`, `npm test` e `npm run demo` (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (Android e iOS) e depois na web e no PWA (390 e 1280 de largura), em claro e escuro:

- [ ] Sem barra com título nem "Passo 1 de 3"; só o botão (i) no canto de cima.
- [ ] Um só título "Bem-vindo à Varanda".
- [ ] A cadeira aparece num disco, creme no escuro.
- [ ] Dois botões de largura total, 52 pt, perto de baixo num celular de 375 pt.
- [ ] "Outras formas de entrar" tem seta, abre e fecha; TalkBack e VoiceOver anunciam expandido e recolhido.
- [ ] As linhas da lista têm pelo menos 44 pt.
- [ ] Sem nenhuma linha para mostrar, o link some.
- [ ] O campo do código de recuperação abre dentro da lista e fica acima do teclado.
- [ ] Os avisos aparecem em caixa suave acima dos botões.
- [ ] Com "Concluir e entrar" esperando, "Criar minha conta" fica secundário.
- [ ] Texto grande (tamanho de fonte do sistema no máximo): nada cortado.
- [ ] Movimento reduzido: nenhuma animação nova.
- [ ] O botão (i) abre "Como funciona a entrada".
- [ ] Ajustes › Conta mostra o mesmo conteúdo no cartão, sem o hero.
- [ ] O passo 2 continua com "Passo 2 de 3".

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- O build de debug não conclui uma passkey numa instalação de produção (veja `docs/development.md`). A cerimônia real se confere com o APK de preview do EAS ou no iPhone com o domínio associado.
- Os estados nativos de criação pendente, código de recuperação e teclado com conta real só se conferem no APK de preview do EAS ou no TestFlight.
- Os testes conferem textos e ordem no código, não a tela.

## 147. Toda a entrada em layout moderno (PR feat/modern-onboarding)

Só apresentação e texto: protocolo, RPC, handlers, o serviço de conta, a idade e o vínculo Google ficam como estão.

O que mudou:

- Todo passo depois das boas-vindas usa um só layout (`apps/app/src/ui/Stepper.js`): barra do topo sem título, só com o botão (i) nos passos que têm ajuda; "Passo n de 3" centrado com pontos; um disco de 72 pt com um ícone (ou um spinner enquanto espera, ou o avatar do perfil); um título (28 pt, arredondado); uma frase curta; o corpo; botões grandes de largura total (52 pt) perto de baixo, um cheio e o segundo contornado; a terceira escolha como link calmo centrado; avisos em caixas suaves e quentes; nenhum cartão dentro do passo. As explicações ficam no (i).
- Termos (antes de entrar): ícone "file-text", título "Antes de começar" (ou "Atualizamos os termos" ou "Antes de continuar"), a frase de sempre, os dois documentos como uma lista de linhas que abrem no lugar ("Ler" e "Fechar"), o botão grande "Li e aceito os Termos de Uso e a Política de Privacidade" e, embaixo, "Sem aceitar, não é possível entrar no Varanda.". Ajustes › Termos não mudou.
- Introdução: título maior e arredondado, botão grande "Próximo" ou "Começar" e "Voltar" como link calmo embaixo.
- Buscando sua conta: spinner no disco; a linha repetida "Buscando sua conta…" e o "carregando…" saíram.
- Confirme sua idade: ícone "shield"; o (i) abre "Como funciona a confirmação de idade" (Didit, selfie ou documento, só a faixa guardada, retomar por cerca de uma hora, volta pelo app ou pelo navegador, política de privacidade). As linhas sobre a Didit e "a foto não chega à Varanda" saíram da tela. Os estados ficam em caixas suaves (em análise com continuar, inconclusivo, vencida, recusada, confirmada), com os botões grandes "Verificar minha idade", "Continuar a verificação", "Tentar com um documento" e "Conferir de novo". "Pedir entrada" da Feira fica numa caixa; o convite colado tem "Usar este convite"; a barra de offline repetida do shell fica escondida neste passo.
- Escolha seu @nome (Google): ícone "at-sign"; o campo @nome e o botão grande "Continuar com o Google"; a linha de privacidade sobre o vínculo Google está no (i). A linha "Sem a liberação da associação, este aparelho não publica nem sincroniza." não aparece mais neste passo (continua nos passos manuais e em Ajustes). A confirmação diz "Quase lá: você vai entrar como @x." com "Confirmar" grande e "Começar de novo" como link calmo. Convite, lista de espera e aviso de volta ficam em caixas suaves. Carregando: "Preparando sua conta…". Antes de abrir o Google: "Vamos abrir o Google. Na volta, confirme de novo com o rosto, a digital ou o bloqueio de tela.". Ajustes › Conta não mudou.
- Um instante: spinner, a linha "Buscando seu perfil." e "Continuar mesmo assim" depois de 10 s.
- Como você quer aparecer: o avatar é o herói, com os botões de foto embaixo; nome e bio; "Continuar" grande e "Pular por enquanto" como link calmo (os dois somem enquanto o editor de foto está aberto). A explicação da foto pública foi para o (i).
- Passos da configuração manual (nativo ou instalação própria): o mesmo quadro, botões grandes e os mesmos textos.
- Aviso antes da verificação de idade: "Vamos abrir a verificação. Na volta, confirme de novo com o rosto, a digital ou o bloqueio de tela.".
- Peças: `Stepper`, `StepLink` e `StepNotice`. Nada muda em como a conta, a idade ou o Google funcionam.

Como verificar, a partir da raiz:

- `node apps/app/test/{uiKit,help,onboarding,age,wordCheck,linkReturn,passkeyTrouble,passkeysScreen,signupInvite,account,profileSave,mediaCrop,intro,terms,terms-version,legal,platformGate,themeUsage,splashGate}.test.js`, um arquivo por vez.
- `npm run lint`, `npm test` e `npm run demo` (a demo termina com "DEMO OK").

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA, claro e escuro:

- [ ] Sem barra com título e com o título uma só vez em todo passo.
- [ ] "Passo n de 3" certo em cada passo, centrado com pontos.
- [ ] Botões de largura total e 52 pt; links calmos com 44 pt.
- [ ] Avisos em caixas suaves, sem cartão dentro do passo.
- [ ] Termos: as linhas abrem e fecham no lugar ("Ler" e "Fechar") e o aceite segue em frente.
- [ ] Introdução: "Próximo", "Começar" e "Voltar" funcionam.
- [ ] Idade: cada estado (em análise, inconclusivo, vencida, recusada, confirmada), a Feira "Pedir entrada", o convite colado com "Usar este convite" e, uma vez, o offline sem barra repetida.
- [ ] @nome: o formulário, a confirmação "Quase lá", o convite, a lista de espera e o aviso de volta.
- [ ] Um instante: "Continuar mesmo assim" aparece depois de 10 s.
- [ ] Perfil: com o editor de foto aberto, "Continuar" e "Pular por enquanto" somem.
- [ ] Texto grande (tamanho de fonte do sistema no máximo): nada cortado.
- [ ] Movimento reduzido: nenhuma animação nova.
- [ ] TalkBack e VoiceOver leem na ordem certa.
- [ ] O teclado não cobre os campos.
- [ ] Ajustes › Conta e Ajustes › Termos continuam como eram.

Limites desta caminhada:

- Nenhuma caixa acima foi marcada nesta documentação.
- Os testes leem o código-fonte, não a tela.
- Os fluxos reais do Google e da Didit e o Android não foram exercitados neste PR.
- Entrar de verdade no nativo precisa do APK de preview do EAS ou do TestFlight.

## 148. Conversas de página de ponta a ponta, Termos 33 (PR feat/page-e2e-dm)

As Conversas de Página passam a ser cifradas de ponta a ponta entre quem escreve e os aparelhos do dono e dos administradores. O serviço de conta não abre a caixa nem as mensagens: só publica a chave pública da caixa, guarda envelopes selados para os membros da lista e assina `varanda-dm-v3\n` mais o digest de 32 bytes que o aparelho preparou. A dona ativa a página, importa antes as linhas antigas quando houver e distribui a nova chave aos administradores. Termos e Política passam para a versão 33.

Como verificar, a partir da raiz:

- `node apps/cli/test/pages-dm.test.js`
- `node packages/web-member/test/page-dm.test.js`
- `node packages/core/test/page-secrets.test.js`
- `node apps/app/test/pages.test.js`
- `node apps/app/test/legal.test.js`

Caminhada, primeiro no celular (build de debug do Android e simulador iOS) e depois na web e no PWA, com A (dona), B (administradora) e C (membro):

- [ ] A abre as Conversas da Página, ativa a caixa e importa as linhas antigas, quando houver. A folha explica a mudança e **Enviar chave** entrega a chave a B.
- [ ] B recebe a chave e abre as Conversas da Página.
- [ ] C escreve para a Página. B lê a mensagem e responde como a Página; C vê a Página, não B.
- [ ] A remove B e gira a chave exigida pela remoção. B deixa de ler mensagens novas e não consegue enviar como a Página.
- [ ] Na Feira, A aceita uma oferta de C como Página sem existir uma conversa entre eles. O aceite não procura a oferta numa conversa da Página.
- [ ] Faça o `dm-key` público diferir da chave guardada por B. Ao tentar enviar como a Página, o aparelho de B recusa e mostra que a chave publicada não é a deste aparelho, até B receber a chave correta.

Limites desta caminhada:

- O serviço ainda guarda a chave de assinatura da Página. Ele poderia forjar uma mensagem como a Página ou publicar uma chave de caixa própria; os aparelhos administradores avisam da chave diferente e param de enviar.
- Mensagens escritas antes da ativação eram legíveis pelo serviço.
- Uma mensagem da Página que nenhum aparelho administrador coletar em 7 dias se perde.
- O serviço sabe quando um administrador envia, embora não veja a mensagem, o destinatário nem o envelope.

## 149. Grupos privados como página de ponta a ponta, Termos 34 (PR feat/page-e2e-groups)

As publicações de uma Página em grupo privado passam a ser seladas no aparelho do dono ou de um administrador. O serviço conserva somente o escritor Ed25519 da Página e acrescenta o bloco que recebe sem abrir o texto. A caixa do grupo vem dos segredos da Página mantidos nos aparelhos administradores. Ao trocar essa caixa, o escritor antigo sai, um escritor novo entra e o grupo fica aguardando a admissão dele e uma época nova. Termos e Política passam para a versão 34.

Como verificar, a partir da raiz:

- `node apps/cli/test/pages-groups.test.js`
- `node apps/cli/test/account-pages-groups.test.js`
- `node packages/web-member/test/page-groups.test.js`
- `node apps/app/test/groupScreen.test.js`
- `node apps/app/test/legal.test.js`

Caminhada, primeiro no celular, build de depuração do Android e simulador iOS, e depois na web e no PWA:

- [ ] Com uma Página em grupo privado, ler e publicar a partir de um aparelho administrador. O texto aparece para os membros autorizados.
- [ ] Conferir a resposta `group-read` do serviço: ela não traz texto de publicação privada.
- [ ] Remover um administrador da Página. O grupo fica aguardando renovação de chave; os administradores do grupo admitem o escritor novo, uma época nova cobre a saída e a publicação volta a funcionar.
- [ ] Na CLI, `page group-post` em grupo privado imprime a recusa `grupo privado: publique como a página pelo app`.
- [ ] Publicar uma vez, banir outro membro do grupo e reenviar a publicação selada antiga: o serviço responde `aguardando-chave`; uma publicação selada na época nova entra.
- [ ] Derrubar o serviço no meio de `group-rebox` (ou fazê-lo falhar) e reiniciar: `dm-box-read` mostra `reboxPending: true` e o serviço conclui sozinho na partida ou no tique seguinte; depois `reboxPending` é `false` e `reboxNeeded` é `0`.
- [ ] Numa Página ativada antes desta versão, conferir que a partida apaga `groupBoxSecretKey` de `page-keys.json` e que `reboxNeeded` conta os grupos privados que ainda precisam de `Renovar chave dos grupos`.
- [ ] Conferir a busca do semeador do grupo para um aparelho administrador da Página. Esta checagem não é coberta pelos testes automatizados.

Limites desta caminhada:

- O serviço ainda acrescenta registros como escritor da Página e vê associação, membros e horários. Sem a chave válida da época, um bloco selado que ele forja é descartado por quem lê.
- As épocas de grupo anteriores à primeira renovação eram conhecidas pelo serviço.
- Nenhuma caixa acima foi marcada nesta documentação.

## 150. Carrossel de fotos nas publicações (PR feat/post-carousel)

Uma publicação com uma foto continua como antes: a foto fica embaixo do texto, na proporção dela (entre 1:2 e 2:1), e um toque abre a tela cheia. Com 2 a 4 fotos, a publicação mostra um quadro só. A forma segue a proporção da primeira foto, presa entre 4:5 (retrato) e 1,91:1 (paisagem), e as outras fotos são cortadas para preencher o quadro. Deslizar para o lado troca a foto. Os pontos ficam embaixo do quadro (o da foto atual na cor de destaque) e a pílula "N de M" fica no canto superior direito da foto. Com o mouse, setas redondas aparecem sobre a foto enquanto o ponteiro está em cima. Um toque abre a tela cheia na mesma foto; lá dá para deslizar, usar as setas ou o teclado (esquerda e direita), e fechar devolve a publicação à última foto vista. O cartão da citação mantém a grade pequena (uma, duas lado a lado, três, 2x2), e a bolha da conversa também mantém a grade. O detalhe de um anúncio da Feira mostra o mesmo carrossel. Só a foto atual e as vizinhas carregam; uma foto que já apareceu continua carregada. Com "reduzir movimento" ligado, as setas trocam sem animação. No anúncio, a foto atual é o próprio botão "foto N de M".

Como verificar, a partir da raiz:

- `node apps/app/test/carousel.test.js`
- `node apps/app/test/postActions.test.js`
- `node apps/app/test/escapeLayer.test.js`
- `node apps/app/test/platformGate.test.js`
- `node apps/app/test/themeUsage.test.js`

Caminhada, primeiro no celular, build de depuração do Android e simulador iOS, e depois na web e no PWA:

- [x] Em A Rua, numa publicação com 2, 3 ou 4 fotos, deslizar de lado troca a foto. Os pontos embaixo do quadro e a pílula "N de M" acompanham. Executado em 2026-11-10: no Android (emulador, build de depuração) e no simulador iOS (iPhone 16e), deslizar devagar passa uma foto, um deslize rápido passa uma foto por vez e um arrasto curto e lento volta para a mesma; na web (Chrome), a rolagem lateral do trackpad encaixa na foto mais próxima e a pílula acompanha.
- [x] Começando o gesto em cima de uma foto, a lista continua rolando na vertical e o puxar para atualizar continua funcionando. Executado em 2026-11-10: rolagem vertical no Android e no iOS, com o carrossel parado na mesma foto; puxar para atualizar só no Android, onde a lista atualiza e a foto fica no lugar.
- [x] Um arrasto na diagonal, a partir de uma foto, não prende a lista: ela segue rolando ou atualizando, e o carrossel não fica no meio do gesto. Executado em 2026-11-10, no Android: um arrasto de 15 graus troca a foto e um arrasto inclinado rola a lista.
- [x] O deslize a partir da borda esquerda (24 px) volta a tela, numa conversa e num anúncio. Executado em 2026-11-10: no iOS, a conversa e o anúncio voltam, inclusive com o dedo começando em cima da foto do anúncio (a 20 pt da borda), sem trocar a foto. No Android, o gesto da borda é o Voltar do sistema, e o carrossel não pega o toque.
- [x] Um toque numa foto do carrossel abre a tela cheia nessa mesma foto, e fechar devolve a publicação a ela. Executado em 2026-11-10 no Android, no iOS e na web: a tela cheia abre na foto do toque, e fechar depois de passar para outra foto deixa a publicação na última foto vista. Na web, o foco do teclado vai para essa foto, e Enter abre a tela cheia nela; só a foto à vista entra na ordem do Tab.
- [x] Na tela cheia, deslizar e as setas trocam a foto, as teclas esquerda e direita também, e Escape e o Voltar do Android fecham. Executado em 2026-11-10: deslizar e as setas no Android e no iOS, o Voltar no Android, as teclas e o Escape na web.
- [x] Girar o aparelho e redimensionar a janela deixa a página no lugar, na mesma publicação e na mesma foto. Executado em 2026-11-10, na web: de 1024 para 375 px de largura, o carrossel fica na mesma foto. O app no celular só abre em retrato, então girar não se aplica.
- [x] Abrir a tela cheia na foto 3 não mostra a foto 1, nem por um instante. Executado em 2026-11-10: no Android, numa gravação da tela a 30 quadros por segundo; na web, medindo a posição da faixa a cada mudança da página antes de desenhar.
- [ ] O cartão de uma citação mantém a grade pequena (uma, duas lado a lado, três, 2x2).
- [x] O detalhe de um anúncio da Feira mostra o mesmo carrossel. Executado em 2026-11-10 no Android e no iOS, nos dois sentidos.
- [ ] A bolha de uma conversa mantém a grade (uma, duas, três ou 2x2).
- [x] Uma publicação com uma foto só continua na proporção dela (entre 1:2 e 2:1) e o toque abre a tela cheia. Executado em 2026-11-10 no Android.
- [ ] Uma foto que falhou ("foto indisponível") tenta de novo ao toque.
- [ ] Uma foto em GIF no carrossel desliza como as outras.
- [ ] Com "reduzir movimento" ligado, as setas trocam a foto sem animação.
- [x] Com o mouse, setas redondas aparecem sobre a foto enquanto o ponteiro está em cima. Executado em 2026-11-10 na web: a seta aparece ao passar o ponteiro, troca a foto sem abrir a tela cheia, e a seta da esquerda surge a partir da segunda foto.
- [x] Dois carrosséis no mesmo feed guardam posições separadas: passar a foto de um não muda o outro. Executado em 2026-11-10 no Android e no iOS.
- [ ] No anúncio, VoiceOver e TalkBack leem a foto atual como o botão "foto N de M".

Limites desta caminhada:

- Conferido em 2026-11-10 com os dados de demonstração do app (Vitrine), no emulador Android, no simulador iOS e no Chrome. O PWA instalado e o toque de verdade na web do celular não foram conferidos.
- Ficaram sem conferir, por falta de publicação de exemplo ou para não mexer nos ajustes do sistema: a citação, a bolha da conversa, a foto que falhou, o GIF, "reduzir movimento", VoiceOver e TalkBack. A citação tem uma asserção no código em `postActions.test.js`; a bolha da conversa não usa o `MediaGrid`, então esta mudança não a alcança.
- Na web, a animação da troca não foi observada (a aba de teste rodava em segundo plano); só a posição final de cada troca.
- Nas publicações do feed, as fotos continuam dentro do elemento único da publicação para leitores de tela, como antes. É um limite conhecido e fica para uma correção seguinte.

## 151. Ordem das fotos (PR feat/photo-order)

No Publicar, com duas fotos ou mais, cada miniatura ganha setas para mover a foto uma posição para antes ou para depois, antes de publicar. A primeira foto é a capa, marcada "capa": ela define a forma do quadro do carrossel e é a que aparece no Mural. As setas ficam indisponíveis enquanto a publicação é enviada (e enquanto uma publicação assinada espera o "Tentar de novo") e não aparecem quando há uma foto só; na primeira miniatura não há "antes", e na última não há "depois". Na web, depois de Enter numa seta, o foco fica numa seta da mesma foto.

Como verificar, a partir da raiz:

- `node apps/app/test/photoOrder.test.js`
- `node apps/app/test/momentosScreen.test.js`
- `node apps/app/test/group-flow.test.js`
- `node apps/app/test/platformGate.test.js`

Caminhada, primeiro no celular, build de depuração do Android e simulador iOS, e depois na web e no PWA:

- [x] Com 3 fotos, mover uma foto para o início e publicar: o quadro do carrossel segue a nova primeira foto, e a ordem das fotos na publicação é a das miniaturas. Executado em 2026-11-10, com três fotos de formas diferentes (paisagem, retrato e quadrada): no Android, a quadrada foi para o início e a publicação saiu com o quadro quadrado; no iOS, a paisagem foi para depois e a publicação saiu com o quadro 4:5 da foto em retrato; na web, a mesma ordem deu o quadro 4:5. O selo "capa" acompanha a primeira foto a cada troca.
- [ ] O Mural do perfil mostra a nova primeira foto.
- [ ] Mover uma foto enquanto outra ainda está sendo preparada não envia nada nem perde a foto.
- [ ] Durante o envio, e com "Tentar de novo" pendente, as setas e o "remover" ficam indisponíveis.
- [ ] Resposta, citação e publicação como página respeitam a ordem.
- [x] Com uma foto só não há setas nem "capa". Executado em 2026-11-10 no Android.
- [x] Na web, Enter numa seta move a foto e o foco fica na seta da mesma foto (na outra seta, quando a foto chega à ponta), e não vai para "Cancelar". Executado em 2026-11-10 no Chrome, três vezes seguidas.
- [ ] TalkBack e VoiceOver leem "mover foto N de M para antes" ou "para depois", e "capa" junto da primeira foto.

Limites desta caminhada:

- Conferido em 2026-11-10 com os dados de demonstração do app (Vitrine), no emulador Android, no simulador iOS (iPhone 16e) e no Chrome. Na Vitrine, a foto enviada aparece como "foto indisponível" no feed, então a ordem foi conferida pela forma do quadro, que segue a primeira foto, e não pela imagem.
- Os rótulos das setas e da capa foram conferidos na árvore de acessibilidade (Android e web), sem ligar TalkBack nem VoiceOver.
- Na Vitrine o envio termina na hora, então as setas indisponíveis durante o envio não foram observadas; o código usa o mesmo bloqueio do "remover".

## 152. Declaração de celular e `phone.sign` (PR1)

A verificação de celular brasileiro ganha uma declaração assinada pela chave do diário, o método `phone.sign` e os dois atestados do serviço de conta, com `phone.proof`. O número e o código não entram na declaração nem nos atestados.

- Declaração `varanda-phone-v1` (`packages/core/lib/phone.js`, `docs/protocol.md` e `docs/rpc.md` 5.115): cinco linhas unidas por LF, sem LF final, sem data, sem número e sem código. As ações são `send`, `check` e `status`. O membro, o nonce e a associação completam as linhas. A chave do diário assina. O número e o código seguem ao lado da assinatura, só até o serviço de conta.
- `phone.sign`: o nó do navegador assina e devolve só `{ signature: hex128 }`. Precisa de identidade e não precisa de certificado de membro. Não grava diário, não anexa bloco e não fala na rede. O mesmo código é o nó web dentro do app hospedado.
- Três superfícies do nó. O nó do navegador e o nó web do app hospedado assinam. O nó do núcleo (`packages/core/lib/session.js`), o `varanda-serve` e a CLI respondem USAGE `assinatura disponível só no navegador`, com ou sem identidade, e não abrem nada. Um nó anterior ao método responde USAGE `método desconhecido`.
- Atestados (`packages/core/lib/phone-proof.js`, `docs/rpc.md` 5.116): `varanda-phone-verified-v1` (o membro tinha um celular verificado naquela data) e `varanda-phone-since-v1` (desde quando a associação exige um celular verificado). Nenhum carrega número. O `phone-since` não avaliza certificado: só marca a exigência da associação.
- `phone.proof`: params `{ verified?, since? }`. `verified: null` apaga o atestado do membro (em `age.proof` esse `null` é recusado). `since: null` apaga o da associação. Antes de gravar, o nó confere `verified` com a própria chave, a associação e os emissores revogados, e `since` com a associação e os emissores revogados. Um `since` com data anterior à do atestado guardado, quando este ainda confere, é recusado do mesmo jeito, para que um atestado antigo repetido nunca substitua um mais novo. O kv é `phoneVerified` e `phoneSince`, cada um `{ v: 1, proof }`. O resultado é `{ phoneVerifiedDate, phoneSince }`, os mesmos campos de `node.info`. Só no nó do navegador (e no nó web do app hospedado). O nó do núcleo responde USAGE `disponível só no navegador`. Um objeto que não confere responde USAGE `comprovante de celular inválido` e não grava nada.

Como verificar, a partir da raiz:

- `npm run lint`
- `node packages/rpc/test/methods.test.js`
- `node apps/cli/test/cli.test.js`
- `node packages/core/test/phone.test.js`
- `node packages/core/test/phone-proof.test.js`
- `node packages/core/test/page-proof.test.js`
- `node packages/core/test/session.test.js`
- `node packages/web-member/test/session.test.js`
- `node apps/app/test/vitrine.test.js`

O layout dos bytes da declaração e dos atestados está em `packages/core/lib/phone.js` e `packages/core/lib/phone-proof.js`, e os dois testes do núcleo conferem o vetor exato. O bloco Help (R5.12, exact) de `docs/protocol.md` não muda.

### Não verificado

- O nó web dentro do app hospedado (Android e iOS) não foi exercitado: os testes rodam a sessão do navegador no Node. Nesta etapa nenhuma tela chama `phone.sign` nem `phone.proof`.

## 153. Verificação de celular no serviço de conta (PR2)

O serviço de conta, com `VARANDA_PHONE_KEY` definida, exige um celular brasileiro (`+55`) de cada membro hospedado. O código de uso único sai só por SMS, pelo mesmo parceiro da verificação de idade. Quem já é membro fica retido até verificar. Sem a variável, o recurso fica desligado e nada muda. A declaração `varanda-phone-v1`, o método `phone.sign` e o formato dos atestados continuam na seção 152.

O que este PR acrescenta:

- `phone.json` no serviço de conta (Brasil, modo 0600): o número selado e, no mesmo arquivo, o índice com chave. O índice é dado pessoal pseudonimizado, porque quem tem a chave pode enumerar o espaço de números. O número selado fica enquanto a conta existir (a linha viva de uma chave que nunca vinculou some em 7 dias) e até 180 dias depois de Excluir conta, de um bloqueio ou de uma troca de número. Excluir conta encerra a linha viva e mantém o selo nesse prazo.
- O número não entra em certificado, na camada P2P, em resposta a outro membro, em log nem no painel de moderação. Não é prova de identidade, o serviço não coleta CPF, e o número verificado não é fator de recuperação (a linha "Nunca só SMS" em `docs/design.md`).
- Se o número já está em uso, a resposta só vem depois de um código certo. Enviar o código responde igual para número livre, em uso ou queimado.
- O serviço assina e entrega o atestado `phone-verified` (sem número), para o membro verificado abrir o app sem o serviço de conta, e o atestado `phone-since`, que marca que a associação exige um celular. Um registro do aparelho nunca abre a porta (regra do dono de 2026-11-04, estendida ao celular em 2026-11-11). Sem nenhuma das duas provas e sem resposta do serviço, uma instalação que nunca exigiu celular abre como antes.
- Desbloqueio e liberação por ordem judicial (decisão do dono, 2026-11-11): o desbloqueio devolve o número na varredura seguinte, se o bloqueio durou menos de 180 dias (depois disso o membro verifica de novo, `telefone-pendente`); a liberação libera o número para uma conta nova e a chave antiga continua bloqueada. Depois da liberação o número selado fica até 180 dias. Só `account phone --release` faz a liberação, e ele a recusa enquanto o serviço de conta está em execução; `account phone --member` apenas mostra o número e pode rodar com o serviço no ar.
- Teto dos envios pagos: `VARANDA_PHONE_DAILY_LIMIT`. Não defina `VARANDA_PHONE_KEY` antes de o passo no app estar no ar.

Como verificar, a partir da raiz:

- `npm run lint`
- `node apps/cli/test/phone-store.test.js`
- `node apps/cli/test/phone-client.test.js`
- `node apps/cli/test/account-phone.test.js`
- `node apps/cli/test/account-phone-cli.test.js`
- `node apps/cli/test/account-phone-gates.test.js`
- `node apps/cli/test/account-phone-e2e.test.js`
- `node apps/cli/test/account-delete.test.js`

Os testes usam o Didit falso em `127.0.0.1` e diretório temporário. Não cobrem o parceiro real nem o checklist de sandbox do README.

### Verificação manual

Nenhuma verificação manual foi feita. Todos os itens estão em aberto:

- [ ] Recurso desligado (sem `VARANDA_PHONE_KEY`): nada muda.
- [ ] Checklist de sandbox do operador no README, antes de definir a chave.
- [ ] Liberação recusada com o serviço em execução; em seguida, com o serviço parado, o número é confirmado por um segundo membro.
