# varanda — development guide

How to work in this repository. Normative facts about formats and the wire are in [protocol.md](protocol.md) and [rpc.md](rpc.md). The iOS proof is in [ios-gate.md](ios-gate.md).

## Prerequisites

- Node.js 20 or newer (`engines.node` is `>=20`) and npm. On the Mac this was written on: Node v26.10.0 and npm 11.19.1 (an example, not a requirement).
- For the iOS app only: Xcode and CocoaPods. The gate passed with Xcode 26.2, CocoaPods 1.16.2 and an iPhone 17 Pro simulator (iOS 26.2). These are examples from [ios-gate.md](ios-gate.md).
- For a native Android build: an Android SDK and Java. Neither is installed on that Mac, so no native Android run has been verified (see "Android").

## Layout (npm workspaces)

The root `package.json` declares the workspaces `packages/*` and `apps/*`.

| Path | Package | Role |
|---|---|---|
| `packages/rpc` | `@varanda/rpc` | JSON contract between the UI and the node. No dependencies, no Node built-ins. |
| `packages/core` | `@varanda/core` | The protocol library and the node session. Runs on Node and on Bare (`#fs`, `#path` and `#process` resolve through the package `imports`, with the `bare` condition for Bare). |
| `apps/cli` | `varanda` | The CLI, the seeder, the demo and `varanda-serve`. |
| `apps/app` | `@varanda/app` | The Expo / React Native app and its Bare worklet. |
| `packages/web-member` | `@varanda/web-member` | The browser node: an RPC session on Hypercore 10 over IndexedDB that syncs through the seeder's WebSocket entry (`lib/session.js`, `lib/sync.js`, bundled from `web/node.js`), plus the spike page and the dht-relay evaluation. Private. |

`bin/varanda.js` and `bin/varanda-serve.js` at the root forward to `apps/cli/bin/`.

## Install

From the repo root:

```sh
npm install
```

Only the root `package-lock.json` exists. Do not create one inside a workspace and do not run `npm install` inside a workspace directory with a lockfile of its own: the workspaces share one tree under the root `node_modules`.

After every `npm install` or `npm ci`, the native app needs `npm run link:addons -w apps/app` again (see "iOS").

## Lint

```sh
npm run lint
```

Runs `standard` over the whole repo. `apps/cli` also has `npm run lint -w apps/cli`. Generated native projects and bundles are ignored (see the `standard.ignore` list in the root `package.json`).

## Tests

All workspaces, from the root:

```sh
npm test
```

This runs `npm test --workspaces --if-present`. Each workspace test script is `node ../../scripts/run-tests.js`, which runs every `test/*.test.js` of that workspace one per child process, in order, with a timeout per file (`VARANDA_TEST_TIMEOUT_MS`, default 180000).

One workspace:

```sh
npm test -w packages/rpc
npm test -w packages/core
npm test -w packages/web-member
npm test -w apps/cli
```

One file, from the repo root:

```sh
node apps/cli/test/serve.test.js
```

`apps/app` runs its pure helper tests with `npm test -w apps/app`: the form rules of `src/config.js` (`apps/app/test/config.test.js`, the web Conectar rules included, checked against `@varanda/web-member`'s seeder address rule), the display helpers of `src/format.js` (`apps/app/test/format.test.js`) and the Espiadinha helpers of `src/peek.js` (`apps/app/test/peek.test.js`: rule text, page merging, round separators and web-only/offline notices); the modules are loaded with `import()` through Node's module syntax detection, which prints a `MODULE_TYPELESS_PACKAGE_JSON` warning. There are no UI tests: the screens are checked by hand on the simulator and on the web. Network tests use an in-process local DHT bound to `127.0.0.1`. No test uses the public DHT.

### Bare desktop smoke test

The core must load and sync under the real Bare runtime. `packages/core/test/bare-load.test.js` (part of `npm test -w packages/core`) spawns `node_modules/.bin/bare` (devDependency `bare-runtime`) on `packages/core/test/bare/smoke.js`, which must print `BARE OK` and exit 0. There is no separate command: run the core tests, or `node packages/core/test/bare-load.test.js`.

## Demo

```sh
npm run demo
```

Runs `npm run demo -w apps/cli`, that is `node scripts/demo.js`: an automatic walkthrough with a local DHT, a seeder and two members. The root README describes it in "Demo automática".

## The web app with the node in the browser

The default web mode: the node runs in the page (`packages/web-member`) and syncs only through a seeder's WebSocket entry. The app bundle never contains the node (Metro blocks `packages/core` and `packages/web-member`); `npm run build:node -w apps/app` bundles it with esbuild (`packages/web-member/scripts/build.js --node`) into `apps/app/public/varanda-node.js`, which Expo serves at `/varanda-node.js` and copies into `dist` on export. The file is generated and ignored by version control. `npm run web` and `npm run export:web` (in `apps/app`) build it first.

`npm run export:web` is `npm run build:node && expo export --platform web && node scripts/finish-web.js`. The last step renders the service worker template `apps/app/scripts/sw.js` into `dist/sw.js` (this release's id, a hash of the template and of every file under `dist`, plus the precache list with a SHA-256 per file) and writes the same id into `dist/index.html` as `<meta name="varanda-release" content="...">`. It refuses an incomplete export and gives byte-identical files when run twice on the same `dist`. The worker is registered only on a hosted https page, in browser mode (the node in the page), whose document carries that meta. It is never registered on `localhost` (the dev server's `index.html` has no meta) and never in varanda-serve mode. That is by design: offline behaviour is verified in production or through the Node tests (`apps/app/test/sw.test.js` and the others listed in [verification.md](verification.md) section 11), not in local development.

On one machine, from the repo root, with a local DHT and a certified seeder (the same setup as [verification.md](verification.md) section 8):

```sh
node apps/cli/scripts/local-dht.js --port 49800
node bin/varanda.js seed --data <seeder> --ws-port 8789 \
  --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1      # ws://127.0.0.1:8789/seeder
npm run web -w apps/app                                   # http://localhost:8081
```

The identity comes from a WebAuthn passkey with the PRF extension, which needs a secure context and a domain `rp.id`: open the page at `http://localhost:8081`, never `http://127.0.0.1:8081` (an IP literal cannot be an `rp.id`; `localhost` counts as secure). Without a physical authenticator, use Chrome's DevTools: WebAuthn panel, "Enable virtual authenticator environment", add an authenticator with protocol CTAP2, transport internal, "Supports resident keys", "Supports user verification" and **"Supports PRF"** (the panel's own name for it, to be checked in the Chrome version in use). Without it, "criar passkey" ends with the no-PRF notice. In local development there is no `/varanda.json` (Expo's dev server answers `index.html`, which the app refuses), so the web Conectar form stays: type the association key and `ws://127.0.0.1:8789/seeder`, press "entrar" / "criar passkey", and paste the certificate from `node bin/varanda.js assoc certify --data <assoc> --member <key> ...`. The seeder's WebSocket entry accepts browser pages from loopback origins by default; a page served from elsewhere needs the seeder's origin allow-list (the hosting PR). A static export (`npm run export:web -w apps/app`) works the same once `apps/app/dist` is served over HTTP. Its CSP must allow `'wasm-unsafe-eval'` (the node compiles WebAssembly at load) and `connect-src` to the seeder.

To start over in a browser, use "recomeçar" in the app, or clear the site data (or delete the IndexedDB database `varanda-node` and the `localStorage` keys `varanda-web-config`, `varanda-web-discovered` and `varanda-web-outbox`). That deletes the diaries kept in the browser, not the identity: the same passkey derives the same key, and the own diary and certificate come back from the seeder. A new virtual authenticator (or a new passkey) is a new identity.

## varanda-serve with the web export

`varanda-serve` runs a node on this computer and exposes it to a browser UI over a loopback WebSocket. Its flags and security rules are in the root [README](../README.md) ("Servidor local para a interface web"). One way to use it with the exported web app:

```sh
cd apps/app
npx expo export --platform web      # writes the static site to apps/app/dist ("Exported: dist")
cd ../..
node bin/varanda-serve.js --data ./data --association <hex> \
  --bootstrap <host:port> --dht-host 127.0.0.1 --ui apps/app/dist
```

Use `--public-dht` instead of `--bootstrap` to opt in to the public DHT. The server prints the URL with the token in the fragment once. Open that URL: the token in the fragment is what puts the page in varanda-serve mode (the tab remembers it), instead of the node in the browser. In that mode the page never loads the browser node (varanda-serve's CSP, `script-src 'self'` without `'wasm-unsafe-eval'`, would block its WebAssembly anyway). Without `--ui`, serve the web build with `npm run web -w apps/app` (Expo dev server) and pass its exact origin with `--origin http://localhost:8081`.

The `dist` directory is ignored by version control. The first export was run on 2026-10-22 (see [verification.md](verification.md)): it reports `Exported: dist`. A full `npm run export:web` now leaves in `apps/app/dist`: `index.html` (with the `varanda-release` meta), `sw.js`, `manifest.webmanifest`, the icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`), `favicon.ico`, `varanda-node.js`, `metadata.json` and the bundle under `_expo/static/js/web/`. A bare `npx expo export --platform web` (as in the commands above) has no `sw.js` and no release meta, so the page it serves never registers a worker.

## iOS

The detail, with the simulator commands and the evidence, is in [ios-gate.md](ios-gate.md) ("Commands, in order"). The short form, from the repo root:

```sh
npm ci
npm run link:addons -w apps/app      # bare-link into react-native-bare-kit's addon directories
npm run pack:worklet -w apps/app     # bare-pack the worklet, then scan for Node built-ins
cd apps/app/ios
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install
cd ..
npm run ios                          # expo run:ios
```

- `link:addons` runs `scripts/link-addons.sh`. It fails unless rocksdb-native, udx-native, sodium-native and bare-fs are linked for every platform it handles. The linked addons live in `node_modules/react-native-bare-kit`, so every install wipes them.
- `pack:worklet` runs `scripts/pack-worklet.sh` and writes `apps/app/assets/worklet/main.bundle.js` (generated and ignored by version control).
- `ios/` and `android/` are committed. They are hand-maintained and must never be regenerated with `expo prebuild`, which would overwrite three hand edits it does not generate: `ios/Varanda/AppDelegate.swift` marks `Documents/varanda` (the node's key material) as excluded from iCloud and device backups; `android/app/build.gradle` signs release builds only with a key supplied outside the repository and gives debug builds the `.debug` application ID suffix. Android's `allowBackup: false` is in `app.json`, so prebuild keeps it.
- `npm run gate -w apps/app` is the gate driver (`scripts/gate-server.js`), used with a Metro started with `EXPO_PUBLIC_VARANDA_GATE_URL`. See ios-gate.md.

## Android

Status: the debug build runs on an x86_64 emulator (API 36) and passes the worklet gate (steps a to i of [ios-gate.md](ios-gate.md), 2026-10-28; the `.so` addons are packed in `lib/x86_64` and loaded). Not run: a real device, arm64-v8a and a release build. `npm run android` is `expo run:android`. Gradle needs JDK 17 or 21; the commands for the gate are in the "Android emulator" section of ios-gate.md.

Release signing: the committed `debug.keystore` is the public React Native debug key, so it signs debug builds only (application ID `app.varanda.debug`). A release build reads `VARANDA_RELEASE_STORE_FILE`, `VARANDA_RELEASE_STORE_PASSWORD`, `VARANDA_RELEASE_KEY_ALIAS` and `VARANDA_RELEASE_KEY_PASSWORD` from Gradle properties kept outside the repository (for example `~/.gradle/gradle.properties`) and fails at signing without them. Backups are off (`android:allowBackup="false"`), so the node's key material is not copied to cloud backups. Signing was not exercised in the emulator run (debug build only). See "Residual risks" in [ios-gate.md](ios-gate.md).

## Browser member spike (packages/web-member)

The spike of a member whose key lives in the browser, kept next to the browser node it led to (previous section). The spike page and the relay are private and not shipped; the results are in [verification.md](verification.md) section 8, and the browser node's in section 9. Its Node tests need Node 20.19 or newer (`engines` in its package.json): the browser crypto shim loads `@noble/curves` 2.x, which is ESM-only, through `require()`. From the repo root, with a local DHT and a certified seeder already set up (see section 8 for the setup):

```sh
node bin/varanda.js seed --data <seeder> --ws-port 8789 \
  --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1     # WebSocket entry, 127.0.0.1 only, off unless --ws-port
node packages/web-member/scripts/build.js              # esbuild: member bundle and relay bundle
node packages/web-member/scripts/serve-spike.js --port 8790   # http://127.0.0.1:8790/
node packages/web-member/scripts/dht-relay.js --port 8791 --host 127.0.0.1 \
  --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1     # optional: the relay evaluation
```

`node packages/web-member/scripts/build.js` also writes the browser node bundle, `dist/varanda-node.js`. `npm test -w packages/web-member` runs the CI tests, among them the browser node's: `test/session.test.js` (the RPC handlers), `test/sync-gate.test.js` (its quarantine gate and quota against a fake seeder), `test/node-storage.test.js` (the IndexedDB storage, through fake-indexeddb), `test/node-bundle.test.js` (the built bundle run in Node against a seeder), `test/session-e2e.test.js` (the web session and a CLI member exchanging posts through a CLI seeder), `test/passkey.test.js` (the passkey derivation and ceremonies against a fake CredentialsContainer) and `test/passkey-e2e.test.js` (two sessions with one key through a CLI seeder: the write gate, push and recovery); `spike/relay-eval.test.js` is manual.

A hang in `test/sodium-browser.test.js` ("Test did not end" in the Noise XX test with the shim as initiator, seen on Node 20 on macOS, issue #135): the shim-backed peer is a child process that printed its JSON report and called `process.exit()` at once. A pipe holds little (16 KB on macOS, and the report is about 17 KB), and `process.exit()` drops what the pipe has not taken, so the parent never got a report; the parent's `reject` also belonged to the native side's promise, already settled in that role, so the failure was lost and the test waited out its timeout. The peer now leaves only after stdout is flushed, and a peer that fails rejects its own promise. This was reproduced here by truncating the report on Linux, not on macOS itself: if the test still hangs there, run it alone and report the output.

## Site and brand assets

The landing page is static: `apps/site/public` is the deployable root, while `apps/site/artwork` (logo sources, `og.html`, `screens.md`) and `apps/site/scripts` are sources and are never uploaded. See [site.md](site.md) (in Portuguese) for the publishing steps.

```sh
npm run dev -w apps/site                                  # http://127.0.0.1:4173/
node apps/site/scripts/serve.js --prefix /varanda         # as it will look under /varanda
node apps/site/scripts/render-assets.js                   # regenerate every icon, splash and favicon
node apps/site/scripts/render-assets.js --check           # verify without writing
```

`render-assets.js` needs `rsvg-convert` (`brew install librsvg`); `cwebp` (`brew install webp`) is only for the screenshot recipe in `apps/site/artwork/screens.md`. The Android mipmaps are PNG bytes under `.webp` names, as Expo writes them. Never use `npx expo prebuild` to regenerate icons: `apps/app/ios/Varanda/AppDelegate.swift` (backup exclusion) and `apps/app/android/app/build.gradle` (release signing) carry hand-made security fixes that prebuild would overwrite (see [verification.md](verification.md)). After any `npm ci`, run `npm run link:addons -w apps/app` again before an iOS build.

## Adding a dependency

Every dependency in every `package.json` uses an exact version: no `^`, no `~`, no ranges. The lockfile stays at the root.

```sh
npm install --save-exact <name>@<version> -w <workspace>
npm install --save-exact --save-dev <name>@<version> -w <workspace>
```

For example `-w packages/core`. Then run `npm run lint` and `npm test`. For a package the worklet loads, also run `npm run pack:worklet -w apps/app`, whose scan fails if the bundle reaches a Node built-in. Workspace packages depend on each other by exact version (`"@varanda/rpc": "0.1.0"`).

Why some pins are what they are (chosen on 2026-10-22, preferring releases at least two weeks old):

- `expo` 55.0.31 and `react-native` 0.83.10, from `expo-template-blank` 55.1.38. SDK 55 is the line Holepunch's bare-expo example uses; the later 55.0.32 was one day old.
- The Expo-managed packages (`react-dom`, `react-native-web`, `@expo/metro-runtime`, `expo-file-system`, `expo-build-properties`, `react-native-safe-area-context`) take the versions in `expo/bundledNativeModules.json`. `react-native-web` is 0.21.3 rather than 0.21.4, which was two weeks old.
- `bare-pack` 2.2.4, not the 3.x line. 3.0.0 is a major released after `react-native-bare-kit` 0.16.0; 2.2.4 shipped the same day as bare-kit 0.16.0 and has the same `--linked`, `--host` and `--format` options.
- `bare-runtime` 1.34.1 (dev only, packages/core), for the desktop Bare smoke test.
- `npm audit` reports advisories in the Expo and React Native build toolchain (braces/micromatch, node-forge). npm's only fixes are majors outside SDK 55, and these packages run at build time on the developer's machine, not in the app.
