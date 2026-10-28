# iOS worklet gate

The gate shows that the real Varanda node runs inside the app on the iOS
simulator. The node is the `@varanda/core` session (`packages/core/lib/session.js`),
running in a Bare worklet from `react-native-bare-kit`. The gate checks that
the node keeps its data across an app kill, syncs with a CLI peer through a
certified seeder, survives a trip to the background, refuses a second
worklet on the same data directory, and stops cleanly (`node.close`), so a
restart needs no lock takeover.

The gate passed on 2026-10-22 on an iPhone 17 Pro simulator (iOS 26.2) with
Xcode 26.2 and CocoaPods 1.16.2.

## How it is built

| Part | File | Role |
|---|---|---|
| Worklet | `apps/app/worklet/main.js` | Runs in Bare. Creates the session with `storeOptions: { lock: 'worklet', recover, suspend: true }` and serves it over framed IPC with `@varanda/rpc`: `encodeFrame`/`createFrameDecoder`, `MAX_REQUEST` inbound, `MAX_MESSAGE` outbound. Bare's `suspend`/`resume` events call `session.suspend()`/`resume()`. It also registers `node.close` (docs/rpc.md 5.17, IPC only): the handler awaits `session.detach()` and `session.close()` (the data-dir lock is released), returns `{ closed: true }`, and once that response is written the worklet ignores every later frame. On an IPC end or error it closes the same way. `Worklet.wakeup` is not used. |
| Addon linking | `apps/app/scripts/link-addons.sh` | Runs `bare-link --preset ios` and `--preset android` on the worklet entry. The output goes into the directories that `react-native-bare-kit` already wires into its native projects: `ios/addons` through its podspec's `vendored_frameworks`, and `android/src/main/addons` through its `jniLibs.srcDirs`. With these directories, `ios/` and `android/` need no project edits. The script fails unless rocksdb-native, udx-native, sodium-native and bare-fs are all linked for iOS and for Android arm64-v8a and x86_64. |
| Packing | `apps/app/scripts/pack-worklet.sh` | Runs `bare-pack --base ../.. --linked --format bundle.cjs` with the hosts ios-arm64, ios-arm64-simulator, ios-x64-simulator, android-arm64 and android-x64, writing `apps/app/assets/worklet/main.bundle.js`. Then it runs `scripts/check-bundle.js` (see below). |
| Metro | `apps/app/metro.config.js` | `resolver.blockList` blocks only `packages/core/**` and `apps/app/worklet/*.js`. The React Native bundle therefore never contains the core or the worklet sources. |
| Client | `apps/app/src/client/native.js` | The only importer of `react-native-bare-kit`. It keeps one Worklet owner on `globalThis`, so Fast Refresh does not start a second node. The data dir is `Paths.document` turned into a plain path, plus `/varanda`. It runs a `@varanda/rpc` client over the framed IPC. `terminateNode()` sends `node.close` (bounded by a 10 s timeout), then calls `worklet.terminate()`. The stop counts as clean only when the response arrived. `startNode` passes `recover: true` by default: every start is a cold start or follows the termination of this context's previous worklet (a stop, a failed start, or an IPC that ended on its own, which also terminates the worklet), so only a crashed or force-terminated worklet's lock is ever taken over. If `startNode` fails after launch (`session.open` rejects or times out), the worklet is stopped the same way, the node is cleared and the error is rethrown. |
| Platform split | `src/client/index.native.js` / `index.web.js`, `connect.native.js` / `connect.web.js` | The web build resolves the `.web.js` files (the varanda-serve WebSocket client), so it never imports bare-kit or the bundle. |
| Gate harness | `apps/app/src/gate/*` | Mounted by `App.js` only when `EXPO_PUBLIC_VARANDA_GATE_URL` was set when the JS was bundled. Without it, the app shows the member UI ([app.md](app.md)). |
| Gate driver | `apps/app/scripts/gate-server.js` | Runs on the Mac (see "Gate steps"). |

### How the bundle reaches `worklet.start`

The packed bundle is a CommonJS module that exports the bundle text (bare-pack
format `bundle.cjs`). `native.js` imports it, and Metro bundles it as an
ordinary module outside the blocked `worklet/` folder. The text is passed to
`worklet.start('/app.bundle', text, [JSON args])`. We picked this over a Metro
asset (`assetExts` + `bundle`) for three reasons:

- It needs no runtime file read.
- It needs no `expo-asset` import, which is not a declared dependency of the app.
- It behaves the same in dev (Metro) and release (embedded JS).

The gate proved it: the dev bundle's module list contains
`assets/worklet/main.bundle.js` and `../../packages/rpc/*`, and no
`packages/core` module.

Because of `--linked`, the bundle holds no binaries: each addon is a `linked:`
reference to the frameworks or `.so` files that bare-link produced.
`--base ../..` gives the bundle paths of the form `/apps/app/...` and
`/node_modules/...`. With `apps/app` as the base, the hoisted modules would
have paths that start with `/../..`.

### Node built-in scan

`scripts/check-bundle.js` reads the bundle header and fails in two cases:

- Any specifier, or any `require()`/`import` in a bundled source, starts with `node:`.
- A source asks for a Node built-in name (`fs`, `path`, ...) that the bundle does not resolve to a bundled file.

Bare has no Node built-ins, so a missing one would throw inside the worklet.
Built-in names that resolve to Bare modules are allowed. For example, `fs`
resolves to `/node_modules/bare-fs/index.js` and `events` to bare-events.

## Commands, in order

Run them from the repo root unless a step says otherwise.

```sh
npm ci                                            # or npm install (the orchestrator owns the lockfile)
cd apps/app
npm run link:addons                               # bare-link into react-native-bare-kit's addon dirs; re-run after every install
npm run pack:worklet                              # bare-pack + node: scan
(cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)   # picks up the linked xcframeworks
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator
(cd ios && xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug \
  -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build)
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
# Metro with the gate URL (it is inlined into the JS bundle):
EXPO_PUBLIC_VARANDA_GATE_URL=http://127.0.0.1:8790 npx expo start --port 8081 --clear
# in another shell, from apps/app (the driver launches the app itself):
npm run gate -- --device booted                   # node scripts/gate-server.js [--port 8790] [--no-launch]
```

Do not start Metro with `CI=1`: in CI mode Metro does not watch files, so it keeps serving the code from its start (including the packed worklet) after you edit it. Restart Metro after `npm run pack:worklet` if in doubt.

`npx expo run:ios --device "iPhone 17 Pro"` can replace the xcodebuild and
install steps. If you use it, Metro must still run with
`EXPO_PUBLIC_VARANDA_GATE_URL` set.

## Gate steps

The driver starts these pieces, all in one Node process:

- a loopback hyperdht testnet;
- an association (`@varanda/core/lib/assoc`);
- a certified seeder (`@varanda/core/lib/seeder`);
- a CLI-equivalent member peer: the same core session, behind an in-memory `@varanda/rpc` pair. The peer publishes `post do par CLI (gate)` and syncs it to the seeder.

The driver then serves `GET /config`, `POST /certify` and `POST /report` on
`127.0.0.1:8790`. The simulator shares the Mac's loopback.

| Step | What the app does | What it proves |
|---|---|---|
| a | Waits for a diagnostics `warning` event the worklet sends after `session.open`: `structuredClone=function O_NOFOLLOW=yes O_EXCL=yes bare=<version>` | The worklet runtime has `structuredClone`, and the core's fs facade is loaded, emulating the flags bare-fs lacks |
| b | `identity.create` | The core writes its store (RocksDB, sodium) in the app sandbox |
| c | `POST /certify`, `cert.add`, `node.info` (`memberCert: true`) | A certificate issued off-device is accepted |
| d | `post.create`, then a continuous `sync.start` until `sync ready` | Publishing works. The running sync holds the data-dir lock during the kill. |
| e | The driver checks that `<container>/Documents/varanda-gate-<run>/.varanda-lock` exists, runs `xcrun simctl terminate`, then `launch`. The app starts with `recover: true` (cold start) and calls `log.read`. | The data persists across a kill. The lock left by the killed worklet is taken over only through `recover` on the cold start. |
| f | `follow.add` the CLI peer, `sync.start { once: true }`, `feed.read`. The driver then has the CLI peer follow the app, sync once and `log.read` the app's diary. | Sync works both ways through the seeder: the app gets the peer's post, and the peer gets the app's post |
| g | The driver opens Settings (the app goes to the background), waits 5 s, then opens `varanda://` (the app returns to the foreground). The app waits for AppState `background` then `active`, then calls `node.info`. | bare-kit suspends and resumes the worklet; the session's suspend and resume gate releases |
| h | Starts a continuous sync (the lock is held), starts a second worklet on the same data dir without `recover`, and calls `node.info` on it. The answer must be `LOCKED`. The second worklet is stopped with `node.close`, which must be clean and take under 5 s. The first worklet still answers. | The `lock: 'worklet'` mode refuses a second worklet. It has no same-pid heuristic. |
| i | `terminateNode()` (must be clean), then `startNode(config, { recover: false })` (the gate overrides the app's default), then `node.info` and `log.read` (the post is still there) | `node.close` releases the lock: a restart in the same JS context works without lock takeover |

## Evidence (2026-10-22)

Driver output of the final run, after `node.close` was added (lines shortened, `trace` lines omitted):

```
[gate 14:41:42] PASS a: diag structuredClone=function O_NOFOLLOW=yes O_EXCL=yes bare=v1.33.4
[gate 14:41:42] PASS b: identity.create 5297d96d...
[gate 14:41:42] PASS c: cert.add seq 0, node.info memberCert true
[gate 14:41:42] PASS d: post.create 5297d96d...:1
[gate 14:41:43] data-dir lock before the kill: present (.../Documents/varanda-gate-<run>/.varanda-lock)
[gate 14:41:43] app terminated (xcrun simctl terminate); lock after the kill: present
[gate 14:41:45] PASS e: log.read after kill+relaunch: seq 1 "post do app (gate)" (2 entries, recover true)
[gate 14:42:02] PASS f: app sync once done (seederConfirmed true, downloaded {"fb897971...":2}); feed.read has
                the CLI peer post | CLI peer sync once done downloaded 2 blocks of the app diary; log.read
                shows "post do app (gate)" at seq 1
[gate 14:42:09] PASS g: node.info after background/resume: publicKey 5297d96d, sync idle
[gate 14:42:17] PASS h: second worklet (no recover) node.info -> LOCKED; its node.close stop clean in 2 ms;
                first worklet still answers (5297d96d)
[gate 14:42:17] PASS i: terminateNode clean in 2 ms; startNode without recover + node.info + log.read in
                160 ms (publicKey 5297d96d, 2 entries)
GATE OK
```

Timings: a probe stop took 2 ms (node.close). Before node.close, the RN side's `IPC.end()` sent nothing: bare-kit's IPC stream has no `_final`. Every stop then waited the full 10 s timeout and force-terminated the worklet, so step h took about 19 s.

Other evidence:

- **Screenshot:** the harness screen after `done` was saved in the gate run's scratchpad as `gate-ok.png` (first run) and `gate-ok-2.png` (run with node.close). Neither is committed.
- **Linked addons:** identical for iOS (xcframeworks, all embedded in `Varanda.app/Frameworks`) and Android arm64-v8a/x86_64 (`.so`), except that bare-posix is linked for iOS only:
  - abort, fs, hrtime, inspect, os, path, pipe, signals, stdio, tty, type and url, each with the bare- prefix (bare-abort 2.0.13, bare-fs 4.8.4, ...);
  - fs-native-extensions 1.5.1, quickbit-native 2.4.9, rocksdb-native 3.19.1, simdle-native 1.3.9, sodium-native 5.2.0 and udx-native 1.21.3.
- **Bundle:** `assets/worklet/main.bundle.js` is about 1.9 MB as a module: 344 files and 38 `linked:` addon entries. The scan is clean.

## Android emulator

The same driver and harness run the gate on the Android emulator (steps a to i, same meaning). `gate-server.js --platform android` swaps `xcrun simctl` for `adb`:

| Step | iOS | Android |
|---|---|---|
| launch, kill | `simctl launch`, `terminate` | `monkey -p app.varanda.debug`, `am force-stop` |
| lock check (e) | the lock file in the simulator container | `run-as app.varanda.debug test -e files/varanda-gate-<run>/.varanda-lock` |
| background, return (g) | open Settings, then `varanda://` | `input keyevent KEYCODE_HOME`, then `am start -a VIEW -d varanda://` |

The Android debug build has the application ID `app.varanda.debug`, so the driver defaults to it. The driver also runs `adb reverse tcp:<port> tcp:<port>` for its own port, so the app reaches it on the same `127.0.0.1` URL as on iOS.

The emulator does not share the host's loopback, and `adb reverse` carries TCP only, while the DHT is UDP. So on Android the testnet, the seeder and the CLI peer bind to `--host` (default: the first non-loopback IPv4 address of the machine), and the app gets a bootstrap on that address. UDP from the emulator reaches it through the emulator's NAT. The driver also turns hyperdht's firewall probing off for those nodes (they are directly reachable): `createSwarm` keeps it on for a non-loopback host, and the seeder then asks the app to hole-punch through the emulator's NAT, which fails with `PEER_CONNECTION_FAILED` (step f: `sem pares`).

```sh
npm ci --ignore-scripts && (cd apps/app && npm run link:addons && npm run pack:worklet)
(cd apps/app/android && JAVA_HOME=<JDK 17 or 21> ./gradlew assembleDebug)    # JDK 26 is not supported by this Gradle
emulator -avd <avd> -no-snapshot                                            # API 36 google_apis x86_64 was used
adb install -r apps/app/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
(cd apps/app && EXPO_PUBLIC_VARANDA_GATE_URL=http://127.0.0.1:8790 npx expo start --port 8081 --clear)
(cd apps/app && npm run gate -- --platform android)                         # [--host <ip>] [--device <serial>]
```

The evidence is in [verification.md](verification.md) section 28.

## Residual risks

- **Android:** run on an emulator only (section 28 of verification.md). A real device, an arm64-v8a build and a release build were not run. Android's SELinux denies `link()` to apps, which `identity.create` used to publish `config.json` (`lib/link-new.js` now falls back to a rename).
- **fs facade TOCTOU:** O_EXCL, O_NOFOLLOW and O_NONBLOCK are emulated by an lstat before the open. A path swapped between the two calls is followed or clobbered. We accept this because the data dir is private to one worklet inside the app sandbox.
- **Bare version:** bare-kit 0.16.0 embeds Bare v1.33.4. The core's desktop Bare smoke test runs on bare-runtime 1.34.1. Both pass, but they are different runtimes, and a bare-kit upgrade must re-run this gate.
- **Addon dirs in node_modules:** the linked addons live in `node_modules/react-native-bare-kit/{ios/addons,android/src/main/addons}`. Every `npm install` or `npm ci` wipes them, so `npm run link:addons` (then `pod install`) must run again before a native build. Without it, the app builds but the worklet fails to load its addons.
- **Do not end the IPC from the worklet before termination:** in one run the worklet ended its IPC side right after the `node.close` response, and the harness then stalled after step g with no timeout firing. This looked like the RN JS thread blocked in `worklet.terminate()`. The cause is not fully established, because Metro was then also serving stale code (see `CI=1` above). The worklet now only stops accepting frames and leaves its IPC open until the host terminates it, and that version passed.
- **Dev reload:** a full JS reload (not Fast Refresh) creates a new JS context while the previous context's native worklet may still be alive. The next start then passes `recover: true` and can take over a live lock. This cannot happen in release builds. Terminating worklets on a dev reload is not implemented; RocksDB's own per-process lock is the remaining backstop (unverified).
- **Bundle loaded only when imported:** the worklet bundle is part of the React Native bundle because the member UI imports `src/client` (connect.native.js -> native.js). A build that stops importing the client would ship no node.
