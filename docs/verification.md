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
| high | the page hook handed the member object (and its secret key) to any script; the secret key is stored unencrypted in IndexedDB | Claude, verifier | hook fixed (a frozen view with only `key`, `length` and `replicate`); **encryption at rest accepted as a known risk of this spike and deferred to PR 4** (decision 2026-10-23; resolved in section 10: the key is derived from a passkey and never stored) |
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
- The browser key was stored unencrypted in IndexedDB, by the page and inside Hypercore 10's own header, with no export or backup. Accepted for this spike (a loopback-only page, not distributed); resolved in PR 4 by deriving the key from a passkey and storing none (section 10).
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
| 3 | PWA manifest, service worker, icons | small, 1-2 d; shipped, with an offline outbox, in section 11 |
| 4 | Identity derived from a passkey (WebAuthn PRF): no key at rest, nothing to wrap or back up; write gate, push and own-diary recovery; hosted `/varanda.json` auto-connect. Built as section 10; export/import of a wrapped key and the passphrase fallback were dropped by that design | done, section 10 |
| 5 | Caddy (automatic TLS) and compose serving the PWA and `wss:///seeder` on one origin, CSP with `'wasm-unsafe-eval'` | small, 1-2 d, plus the user's DNS and hosting steps |
| 6 | Hardening of the WebSocket entry for the internet, and the dht-relay decision | medium, 3-5 d |

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
- CI result on the final tree (Node 20 and 24: `npm ci`, `npm run lint`, `npm test`, `npm run demo`): not recorded by this task; the orchestrator runs the sequence after the end-to-end test lands and the result belongs here.

### The flow, as built

1. The page asks `POST /account/start { member, username }` and gets a single-use `nonce` and the cookie `__Host-varanda-link` (600 s). The member signs the nonce with the diary key (RPC `account.sign`, phase `reserve`, `packages/core/lib/account-link.js`); `POST /account/authorize { signature }` verifies it and returns the Google URL.
2. The page navigates to Google (`openid email`, `state`, PKCE S256). Google returns to `GET /account/callback?code&state`. The service requires the cookie and the `state` to name the same pending row **before** any call to the token endpoint, exchanges the code server side with the client secret and the PKCE verifier, and checks `userinfo` and the `id_token` claims (`iss`, `aud`, `exp`, `sub`, `email_verified`; `apps/cli/lib/account/google.js`). It redirects to `/?conta=ok|erro|cancelado`, never with a code in the URL.
3. The page loads, reads `GET /account/pending`, shows the chosen @username and asks the member to confirm. The member signs again (phase `finish`, over the Google subject); `POST /account/finish { signature }` returns `{ cert, usernameRecord, nextChangeAt }`. The page runs `cert.add`, then `username.add`.
4. Rename: `POST /account/rename/start { member, username }` then `POST /account/rename/finish { member, nonce, signature }` (phase `rename`, no cookie: the key proof is the authority). Before 7 days the service answers 409 `troca-bloqueada` with `nextChangeAt`.

### What the server stores and what it never sees

- The directory (`<data>/directory.json`, mode 0600, replaced atomically; `apps/cli/lib/account/store.js`) keeps per link: member key, Google `sub`, e-mail, the current @username and its signed record, `usernameChangedAt`, `linkedAt`, the finish `nonce` and `signature`, and the certificate; plus `usedNames` (every name a member ever held). It never stores the Google tokens or the pending Google transaction (state, verifier), which live in memory for at most 600 s.
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

- **A name is held only once Google answered.** A pending row holds its @username and is protected from eviction only after the callback put the Google `sub` on it. A key-proven row (`/account/authorize` passed) holds nothing and is evictable like a bare start; `finish` re-checks the name. When two rows claim the same name (both started before either reached Google) the first to claim holds it and the other's finish answers `nome-em-uso`; neither blocks the other. Pending rows: at most 1000 live, at most 3 unclaimed per member (its oldest is replaced), at most **2 per Google subject** (a third claim for the same `sub` replaces its oldest row), the oldest unclaimed row evicted when the table is full, `lotado` only when every row is Google-claimed.
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

### Automated (CI)

- `packages/core/test/account-link.test.js`: constants, golden vector, every field bound, phases never cross-verify, shape rejections, pure module.
- `apps/cli/test/cert.test.js` and `apps/cli/test/records.test.js` (golden vectors and rejections for the issuer certificate, certificate v2 and the username record: wrong member, other association, swapped issuer signature, seq 0), `packages/core/test/session.test.js` and `packages/web-member/test/session.test.js` (`account.sign`, `username.add`), `packages/rpc/test/methods.test.js` (method lists).
- `apps/cli/test/google.test.js`: PKCE, authorize URL parameters, userinfo and `id_token` checks, size, redirect and timeout limits, no value echoed.
- `apps/cli/test/account-store.test.js`: pending rows, eviction (a key-proven row is evicted and holds no name; a Google-claimed row is kept and holds it; first claim wins; a third row per `sub` replaces the oldest), 0600 files, crash safety, conflicts, 7-day cooldown with an injected clock, names never reassigned.
- `apps/cli/test/account.test.js`: the full link, cookie-and-state binding before the token call, replay and wrong-key signatures, rename routes, request hygiene, rate limits (unauthenticated starts, rename/starts and finishes naming a member never block its own signed flow; the 6th signed authorize in 10 min is 429; a keyed window at capacity still admits a new key; an unmatched callback charges no per-row quota), unconfigured service, the data-dir lock, `account key|cert add|status|export`.
- `apps/app/test/account.test.js`: request builders, return parsing, fixed error messages, `formatNextChange`.
- `apps/cli/test/feed.test.js` (items carry the @username), `cli.test.js` and `readme-help.test.js` (flags and help).
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
