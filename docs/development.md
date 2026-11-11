# varanda — development guide

How to work in this repository. Normative facts about formats and the wire are in [protocol.md](protocol.md) and [rpc.md](rpc.md). The iOS proof is in [ios-gate.md](ios-gate.md).

## Prerequisites

- Node.js 20 or newer (`engines.node` is `>=20`) and npm. On the Mac this was written on: Node v26.10.0 and npm 11.19.1 (an example, not a requirement).
- For the iOS app only: Xcode and CocoaPods. The gate passed with Xcode 26.2, CocoaPods 1.16.2 and an iPhone 17 Pro simulator (iOS 26.2). These are examples from [ios-gate.md](ios-gate.md).
- For a native Android build: an Android SDK and JDK 17 or 21. On an Apple Silicon Mac, "Android" below has the exact setup (JDK 17, SDK root, an arm64-v8a emulator). The debug build has run on an x86_64 emulator on another machine; a real device and a release build have not.

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

After every `npm install` or `npm ci`, the native app needs `npm run prepare:native -w apps/app` again (see "iOS").

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

This runs `node scripts/run-tests.js --workspaces`: one pool of child processes over the `test/*.test.js` files of every workspace, `VARANDA_TEST_CONCURRENCY` at a time, each file run from its own workspace directory, with a timeout per file (`VARANDA_TEST_TIMEOUT_MS`, default 180000). Every workspace test script is `node ../../scripts/run-tests.js`, which does the same for one workspace (`npm test -w <workspace>`); a workspace with any other test script makes the root run fail instead of being left out. With more than one file at a time, the slowest files start first, by the time each took on its last run, kept in `node_modules/.cache/varanda-test-durations.json` (`VARANDA_TEST_DURATIONS` changes the path; a file never measured starts first, and without the file the list order holds). Unset, the pool is half the CPU cores, rounded down, and at most 4 (4 on a 12-core Mac, 2 on a 4-core machine), because several tests assert timing bounds under 100 ms that move under load; `VARANDA_TEST_CONCURRENCY=1` runs one file at a time and streams the output live. With more than one file at a time, each file's output is printed as one block when that file ends (completion order, never interleaved), and the summary lists `# falha: <arquivo>` for each failing file before `# N arquivo(s) de teste, M falha(s)`. `VARANDA_TEST_SHARD=I/N` runs only the files whose position i (0-based, in the sorted list or the order given on the command line) satisfies `i % N == I - 1`; a slice with no files exits with failure (`# nenhum arquivo neste fragmento`), and an invalid value does too. When a timing test fails, rerun it alone (`node <arquivo>`) or with `VARANDA_TEST_CONCURRENCY=1` before blaming your change.

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

`npm run export:web` is `npm run build:node && expo export --platform web && node scripts/finish-web.js`. `apps/app/metro.config.js` (`scripts/resolve-build-info.js`) sets `EXPO_PUBLIC_VARANDA_COMMIT` and `EXPO_PUBLIC_VARANDA_BUILD_DATE` when the bundler starts, so `expo start`, `expo export` and the native `export:embed` all carry them; order: the public variables when already set, then `EAS_BUILD_GIT_COMMIT_HASH`, then `git rev-parse HEAD`, else the app shows `desconhecido` and the build still succeeds. `expo start` shows the commit and date of the moment it started; an export keys Metro's transform cache on both, so a second export of the same commit gets its own date. A public value counts only in the expected form (40 lowercase hex for the commit, a UTC instant `YYYY-MM-DDTHH:MM:SSZ` for the date): anything else falls through. An uppercase `EAS_BUILD_GIT_COMMIT_HASH` is lowercased and still counts. That order chooses the commit. The date keeps `EXPO_PUBLIC_VARANDA_BUILD_DATE` when it is already in that form and otherwise is the current UTC time, not a git or EAS value. Ajustes shows that stamp beside the commit the installation serves at `/version.json`. The last step renders the service worker template `apps/app/scripts/sw.js` into `dist/sw.js` (this release's id, a hash of the template and of every file under `dist`, plus the precache list with a SHA-256 per file) and writes the same id into `dist/index.html` as `<meta name="varanda-release" content="...">`. It refuses an incomplete export and gives byte-identical files when run twice on the same `dist`. The worker is registered only on a hosted https page, in browser mode (the node in the page), whose document carries that meta. It is never registered on `localhost` (the dev server's `index.html` has no meta) and never in varanda-serve mode. That is by design: offline behaviour is verified in production or through the Node tests (`apps/app/test/sw.test.js` and the others listed in [verification.md](verification.md) section 11), not in local development.

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
npm run prepare:native -w apps/app   # link:addons, pack:worklet and, on macOS, pod install
cd apps/app
npm run ios                          # expo run:ios
```

Phone first means the iOS simulator too: a screen change is checked on the Android debug build and on the simulator. On this kind of Mac (Xcode 26.2, iOS 26.2 simulator runtime, CocoaPods 1.16.2) the build and a run without `expo run:ios`:

```sh
npm ci --ignore-scripts
npm run prepare:native -w apps/app -- ios
(cd apps/app/ios && xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build)
git restore apps/app/ios/Varanda/PrivacyInfo.xcprivacy             # pod install rewrites it with whitespace only
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator              # the build does not boot it; skip if booted
xcrun simctl install booted apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
(cd apps/app && npx expo start --port 8081)                       # in another terminal
xcrun simctl launch booted app.varanda
xcrun simctl openurl booted 'varanda:///g/<64 lowercase hex>'     # a group link, as Linking delivers it
```

- `pod install` always rewrites two `SPEC CHECKSUMS` lines of `apps/app/ios/Podfile.lock`: `React-Core-prebuilt` and `ReactNativeDependencies` point at prebuilt tarballs under `Pods/`, and their podspec carries that absolute path, so the checksum depends on where the repository lives (section 7 of [verification.md](verification.md)). Do not commit those two lines; commit every other change, for example a new Expo module. `node apps/app/scripts/check-pods-lock.js <committed lock> <generated lock>` compares two locks without those lines and the `COCOAPODS:` version, and fails on a pod that is missing, extra or at another version (`git show HEAD:apps/app/ios/Podfile.lock > /tmp/Podfile.lock.committed` gives the committed one). After you put the committed lines back, the next Xcode build fails its "Check Pods Manifest.lock" phase until `pod install` runs again; that is expected on the machine that just ran it.
- `pod install` also rewrites `ios/Varanda/PrivacyInfo.xcprivacy` with other indentation only; revert it (`test/hardening.test.js` compares it without whitespace anyway).
- A simulator build is not signed with the Apple team, so iOS does not tie it to the installation's `apple-app-site-association` and the passkey stays unavailable: the simulator covers everything up to Conectar and the screens that need no account. Sign-in is checked on a real iPhone from TestFlight (see "Builds de teste (EAS)").
- The minimum is iOS 18.0, the first with the passkey PRF API that sign-in needs. It is set in `IPHONEOS_DEPLOYMENT_TARGET` (`project.pbxproj`), `ios.deploymentTarget` (`Podfile.properties.json`, and `expo-build-properties` in `app.json` for prebuild), the `Podfile` fallback and the podspecs of `modules/passkey-prf` and `modules/auth-session`, which rely on it instead of availability checks. `test/hardening.test.js` checks that they agree.

- `prepare:native` runs `scripts/prepare-native.sh [ios|android|all]`: the three steps below in order, then checks again that every addon is linked. `npm run ios` and `npm run android` run the same check (`scripts/link-addons.sh check`) before `expo run:*`, so a build without the addons fails with a message instead of producing an app whose worklet cannot load them.
- `link:addons` runs `scripts/link-addons.sh`. It fails unless rocksdb-native, udx-native, sodium-native, bare-fs, fs-native-extensions, bare-crypto and bare-tls are linked for every platform it handles. The linked addons live in `node_modules/react-native-bare-kit`, so every install wipes them.
- `pack:worklet` runs `scripts/pack-worklet.sh` and writes `apps/app/assets/worklet/main.bundle.js` (generated and ignored by version control).
- One bundle serves both node kinds of the worklet: the start argument's `kind` picks `core` (the default, `@varanda/core` on RocksDB) or `web` (`worklet/web-node.js`: the `packages/web-member` session on file storage under `<dataDir>/web-node`, syncing with the installation's seeder over `wss://`). The `web` kind is why `@varanda/web-member`, `bare-crypto` and `bare-ws` are runtime dependencies of `apps/app`: bare-pack bundles only what the worklet's module graph reaches. To check it, run `npm run pack:worklet -w apps/app` (it ends with `node scan: clean`: `scripts/check-bundle.js` refuses a bundle that could reach a Node built-in), then `bash apps/app/scripts/link-addons.sh ios` and `bash apps/app/scripts/link-addons.sh android` and read the `linked` lists. The `web` kind adds bare-crypto, bare-tls, bare-tcp, bare-dns, crc-native and a second sodium-native (4.3.3, Hypercore 10's, next to 5.2.0); the two sodium-native versions link side by side because each addon name carries its version. `link-addons.sh` also requires fs-native-extensions (the `web` kind's `LOCK` fails closed without it), bare-crypto and bare-tls. `node apps/app/test/identityInstall.test.js` covers the identity host controls (`docs/rpc.md` 5.50 to 5.55) in Node; the `web` kind itself only runs in the app.
- `ios/` and `android/` are committed and hand-maintained: do not run `expo prebuild` in `apps/app`. `plugins/with-hardening.js` (registered in `app.json`) reapplies the edits a prebuild would drop, and `test/hardening.test.js` runs a real `expo prebuild --clean --no-install` in a temporary copy, never in `apps/app`, and compares the three patched files with the committed ones. The edits: `ios/Varanda/AppDelegate.swift` marks `Documents/varanda` (the node's key material) as excluded from iCloud and device backups; `android/app/build.gradle` signs release builds only with a key supplied outside the repository and gives debug builds the `.debug` application ID suffix; `android/gradle.properties` limits `reactNativeArchitectures` to the two ABIs `link:addons` produces. Android's `allowBackup: false` and the iOS privacy manifest (`ios.privacyManifests`, which becomes `ios/Varanda/PrivacyInfo.xcprivacy`: no tracking and the required-reason API declarations) are in `app.json`, so prebuild keeps them; the test compares the generated manifest with the committed one. So is the passkey entitlement (`ios.associatedDomains`, which becomes `ios/Varanda/Varanda.entitlements`), and the plugin sets `VarandaWebCredentials` in `Info.plist` from its `webcredentials` entry; the test checks both in the generated project. A fresh prebuild still differs from the committed projects in generated files that are not security edits (the icon and splash images, `Info.plist` without `RCTNewArchEnabled`, `styles.xml` without `windowSplashScreenBackground`, `project.pbxproj` before `pod install`), so the two apps are not byte for byte the same; only the patched files, the privacy manifest and the entitlements are checked.
- `npm run gate -w apps/app` is the gate driver (`scripts/gate-server.js`), used with a Metro started with `EXPO_PUBLIC_VARANDA_GATE_URL`. See ios-gate.md.

## Android

Status: the debug build runs on an x86_64 emulator (API 36) and passes the worklet gate (steps a to i of [ios-gate.md](ios-gate.md), 2026-10-28; the `.so` addons are packed in `lib/x86_64` and loaded). Not run: a real device, arm64-v8a and a release build. `npm run android` is `expo run:android`. Gradle needs JDK 17 or 21; the commands for the gate are in the "Android emulator" section of ios-gate.md.

Release signing: the committed `debug.keystore` is the public React Native debug key, so it signs debug builds only (application ID `app.varanda.debug`). A release build reads `VARANDA_RELEASE_STORE_FILE`, `VARANDA_RELEASE_STORE_PASSWORD`, `VARANDA_RELEASE_KEY_ALIAS` and `VARANDA_RELEASE_KEY_PASSWORD` from Gradle properties kept outside the repository (for example `~/.gradle/gradle.properties`) and fails at signing without them. Backups are off (`android:allowBackup="false"`), so the node's key material is not copied to cloud backups. Signing was not exercised in the emulator run (debug build only). See "Residual risks" in [ios-gate.md](ios-gate.md).

### macOS setup (Apple Silicon)

The practical phone for development is Android: on iOS, passkey sign-in works only in a build signed with the Apple team (TestFlight) against `bora.varanda.app` (see [app.md](app.md), "No app instalado com a instalação", and "Builds de teste (EAS)" below). This host runs arm64 images, so use `arm64-v8a`; the earlier x86_64 run was another machine.

```sh
brew install openjdk@17
brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
mkdir -p "$ANDROID_HOME"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "cmdline-tools;latest"
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "emulator" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1" "system-images;android-36;google_apis;arm64-v8a"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
echo no | avdmanager create avd -n varanda-api36 -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
```

Accept the licenses before the first install: without them `sdkmanager` stops at the prompt and installs nothing. Installed on 2026-11-01: openjdk 17.0.21, cmdline-tools 23.0.0, build-tools 36.0.0, platforms android-36 2.0.0, NDK 27.1.12297006, CMake 3.22.1, emulator 37.2.13, platform-tools 37.0.1, system image 7.0.0.

- JDK: the Homebrew formula `openjdk@17` (no sudo) at the `JAVA_HOME` above, not a cask. There is one SDK root, `~/Library/Android/sdk`, with `cmdline-tools;latest` installed into it; pass `--sdk_root` on every `sdkmanager` call so nothing lands in the cask's own directory. Put the exports in your shell profile.
- The versions after `platforms;` and `build-tools;` are the ones this setup used; Gradle downloads anything else it needs (such as the NDK) once the licenses are accepted. If your Gradle run asks for different versions, install those.

Build and run, from the repo root:

```sh
npm ci --ignore-scripts
npm run prepare:native -w apps/app -- android
cd apps/app/android && ./gradlew assembleDebug && cd ../../..
emulator -avd varanda-api36 -no-snapshot
adb install -r apps/app/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
cd apps/app && npx expo start --port 8081 --clear
```

Open the installed Varanda debug app on the emulator; it loads the JavaScript from Metro through the reverse tunnel. Never run `expo prebuild` (`ios/` and `android/` are hand-maintained and carry security edits; see the bullet above on `plugins/with-hardening.js`). `npm ci` wipes the linked addons, so run `prepare:native` again after every install. The Android build needs no pod install. The iOS side needs one (see "iOS" above).

What the local loop cannot do: the debug build is `app.varanda.debug`, signed with the public debug key (`apps/app/android/app/build.gradle:124`), while the installation's `assetlinks.json` associates only `app.varanda` (`deploy/seeder/well-known.sh:61`). A debug build therefore cannot sign in with a passkey on a production installation. The local loop covers everything up to Conectar and the screens that need no account; signed-in phone checks use the EAS preview APK (release key, `app.varanda`) for now. Never add the public debug key to a production `assetlinks.json`: anyone could then build an app that uses the domain's passkeys. A development installation with its own debug association is a maintainer decision, not part of this change.

Phone first: `apps/app` is one codebase and a screen is checked on the phone before the web. `apps/app/test/platformGate.test.js` fails a shared screen that calls a browser API, and `.github/workflows/native.yml` builds the native app on every pull request that may touch it (it skips the builds only when every changed path is outside the app: `docs/`, `apps/site/`, `apps/cli/`, `deploy/`, top-level Markdown, the other workflows and the GitHub templates): the Android debug APK with the commands above (`ubuntu-24.04`, JDK 17, NDK 27.1.12297006, CMake 3.22.1), the iOS app for the simulator, unsigned (`macos-26`, Xcode 26.2, `check-pods-lock.js` against the committed lock), the Android and iOS JavaScript bundles with `expo export`, and the web app with `npm run export:web`, the command the deploy runs. A pull request that does not touch the app skips the builds; the `native` job reports both cases and is the name to make required. The builds prove the app compiles and its bundles resolve, not that a screen works on a device.

## Instalação hospedada local

`apps/cli/scripts/hosted-lab.js` sobe uma instalação hospedada inteira nesta máquina, para conferir o app web entrado no Chrome, sem Google, sem domínio e sem celular. Com a interface do Expo já rodando (`npm run web -w apps/app`, porta 8081):

```sh
node apps/cli/scripts/hosted-lab.js                          # http://localhost:8080
node apps/cli/scripts/hosted-lab.js --port 8090 --expo http://127.0.0.1:8081
node apps/cli/scripts/hosted-lab.js --ui apps/app/dist       # um export já feito
```

`--port` (padrão 8080), `--host` (só `127.0.0.1` ou `localhost`), `--ui <dist>` ou `--expo <http://127.0.0.1:porta>` (padrão `http://127.0.0.1:8081`). Ctrl-C encerra e apaga os dados do laboratório. O script nunca imprime chave secreta. Para medir o carregamento com dezenas de diários seguidos, `--dataset <semente>` (com `--dataset-size` e `--rajada`) cria um conjunto de dados: veja [performance.md](performance.md).

O que ele sobe, no mesmo processo:

- uma rede DHT de teste presa a loopback, ou a que `VARANDA_BOOTSTRAP` aponta (precisa ser loopback, por exemplo a de `apps/cli/scripts/local-dht.js`);
- uma associação e um semeador certificado, com a entrada WebSocket, como `seed --ws-port`;
- o serviço de conta, com a loja de termos ligada e sem verificação de idade (`GET /account/age/policy` responde `{ required: false }`);
- um só endereço, `http://localhost:<porta>`, que reúne `/varanda.json`, `/seeder`, `/media/*`, `/index/*` e `/account/*`; o resto vai para o servidor do Expo ou para o `dist` exportado.

### Provedor de entrada falso

`apps/cli/scripts/oauth-stub.js` ocupa o lugar do Google só no laboratório, com o mesmo contrato `{ authorizeUrl, exchange }` que o serviço de conta recebe. Sua página de autorização oferece Pessoa 1, Pessoa 2 e Pessoa 3. Cada uma tem um `sub` próprio (`lab-<n>`) e um e-mail (`lab<n>@example.test`), porque a loja recusa um mesmo `sub` ligado a dois membros. O desafio PKCE continua conferido na troca, e cada código vale uma vez, então o fluxo da conta roda como roda contra o Google. A passkey e os termos são os de verdade. Nada disso é ligado à CLI.

### Duas pessoas numa troca de mensagens

A identidade fica no navegador e no autenticador virtual do perfil do Chrome. Por isso a segunda pessoa entra num perfil novo, não numa aba: abas do mesmo perfil dividem o armazenamento e a passkey.

1. Abra `http://localhost:8080`. Use `localhost`, não `127.0.0.1`: o `rp.id` da passkey não pode ser um IP.
2. Em DevTools › More tools › WebAuthn, ative o ambiente de autenticador virtual e adicione um autenticador CTAP2 com transporte `internal`, chaves residentes, verificação do usuário e PRF. Sem PRF, o app segue o caminho de passkey sem PRF.
3. Toque em Entrar e escolha Pessoa 1 na página do laboratório.
4. Em outro perfil do Chrome, repita os passos 1 a 3 com o autenticador desse perfil e escolha Pessoa 2.
5. Troque uma mensagem direta e uma publicação em grupo entre os dois perfis.

### Por que o nó do aparelho não envia mensagens diretas

As Conversas selam cada mensagem para uma chave de caixa X25519 derivada da chave de identidade Ed25519 e falam com o semeador pela ligação do nó do navegador. Por isso só o nó do navegador oferece os métodos `dm.*`. Em `packages/core/lib/session.js` (linhas 614 a 621), o nó core responde a cada um com `mensagens diretas disponíveis só no navegador` e não abre nem lê nada. A troca de mensagens do laboratório portanto acontece no Chrome, nunca no app instalado.

### O que o laboratório não cobre

Entrar de verdade no app nativo. A configuração hospedada do app exige `https` (`apps/app/src/config.js`, linha 169); o `rp.id` não pode ser um IP (`apps/app/src/installation.js`, linhas 43 a 49); no iOS a passkey só vale para `bora.varanda.app`, o host do domínio associado; e o build de debug do Android não casa com o `assetlinks.json` da instalação (ver a seção Android). Uma revisão visual feita no laboratório não libera esse fluxo.

## Revisão visual

O ciclo completo, com a ordem das plataformas, a checklist de telas e os critérios de revisão, está em [design-review.md](design-review.md). Os pontos de operação:

- Alvos: Android (AVD `varanda-api36`, referência), iOS (simulador iPhone 16e) e Chrome em 390 px e 1280 px, nos temas claro e escuro. Cada tela também com texto grande e movimento reduzido.
- Vitrine: com `EXPO_PUBLIC_VARANDA_VITRINE=1` no Metro, as telas hospedadas aparecem com dados de exemplo, sem conta. Os dados estão em `apps/app/src/vitrine/fixtures.js`. `apps/app/src/vitrine/request.js` responde pelo mesmo contrato de `node.request`, a partir de uma cópia dos dados; cada instância guarda o próprio estado, então reabrir um cenário começa do zero. Conversas entre duas pessoas reais pedem o laboratório acima.
- Capturas: `bash apps/app/scripts/review-shots.sh android <pasta> <rótulo>` (ou `ios`). Grava `<pasta>/<rótulo>-<plataforma>-<n>.png`, com `n` sequencial, e imprime o caminho. O rótulo usa só letras, números, ponto, traço e sublinhado. Sem dispositivo ligado, o script para com `Nenhum simulador ou emulador ligado` e código de saída 1.
- Evidências ficam fora do git, em uma pasta de evidência do PR (por exemplo `~/Workspace/evidencias/<branch>/`), e o corpo do PR cita o caminho de cada captura.

## Tema claro e escuro

`app.json` tem `userInterfaceStyle` automatic, e a chave `UIUserInterfaceStyle` do `Info.plist` foi removida, para o aparelho decidir o modo. A cor do splash nativo fica creme nos dois modos: `splashscreen_background` no Android e o colorset `SplashScreenBackground` no iOS não têm variante escura, e `android/app/src/main/res/values-night/colors.xml` fica vazio de propósito, para não trocar o splash. A barra de status do iOS começa com `UIStatusBarStyleDarkContent`, para os ícones ficarem escuros sobre o creme antes do JS. As duas paletas ficam em `apps/app/src/appearance.js`; para migrar uma tela ao tema, siga a receita no comentário do topo de `apps/app/src/ui/ThemeProvider.js` (`useStyles` e `useTheme`). Continua proibido rodar `expo prebuild` para aplicar isso: as edições ficam nos arquivos commitados.

## Builds de teste (EAS)

Configuração em `apps/app/eas.json` (perfis `preview` e `preview-simulator`; o `production` está na seção seguinte) e `.easignore` na raiz. Nenhum comando abaixo roda na CI nem num agente: quem tem a conta Expo roda, da pasta `apps/app`. A única exceção é o fluxo `ios-release`, da seção seguinte.

```sh
eas login
eas init
eas env:create --name EXPO_PUBLIC_VARANDA_INSTALLATION --value https://<dominio> --environment preview --visibility plaintext
eas build --profile preview --platform android
eas credentials -p android
```

- O app já está ligado ao projeto `@varanda-org/varanda`: o `eas init` escreveu `owner` e `extra.eas.projectId` no `app.json`, e eles estão no repositório. Só rode `eas init` de novo para ligar o app a outra conta Expo.
- O hook `eas-build-post-install` (`scripts/eas-post-install.sh`) roda `prepare-native.sh` para a plataforma do build: link dos addons, `main.bundle.js` do worklet e, no iOS, `pod install`. No iOS o serviço pode rodar o `pod install` dele antes ou depois do hook, e o hook roda de novo; o script é idempotente, então a ordem não importa. Ele falha se `assets/worklet/main.bundle.js` não existir no fim.
- O perfil `preview` fixa o Node 24.22.1 (`"node"` no `eas.json`, que só aceita versão completa). A imagem da EAS vem com o Node 20, e o `bare-module-lexer` que o `pack-worklet` carrega exige Node ^22.21 ou >= 24.9: com o Node 20, o hook falha com `undefined symbol: node_api_is_sharedarraybuffer`.
- No log do primeiro build, confira as etapas `link-addons` e `pack-worklet` e a configuração de assinatura injetada pela EAS. `android/app/build.gradle` continua falhando fechado sem as credenciais `VARANDA_RELEASE_*`.
- Se a assinatura injetada não funcionar, o plano B é `credentialsSource: local` no perfil, com um `credentials.json` fora do git (ele está no `.gitignore` do app e no `.easignore`).
- `ios/` e `android/` continuam mantidos à mão: nunca rode `expo prebuild`.
- O `.easignore` substitui o `.gitignore` no envio, por isso repete as saídas de build e todos os padrões de segredo, e deixa de fora até o `debug.keystore` (o perfil `preview` compila release).
- O `.easignore` deixa o `.git` de fora, então o builder lê `EAS_BUILD_GIT_COMMIT_HASH` (ainda não visto neste repositório: a linha `build-info: commit ...` no log do primeiro build confirma; `desconhecido` quer dizer que a variável faltou e o build mesmo assim passou; nunca imprima o ambiente).
- iOS em ad hoc exige conta Apple Developer. Até lá, use `eas build --profile preview-simulator --platform ios`.
- Passkey no iOS: `ios/Varanda/Varanda.entitlements` declara `webcredentials:bora.varanda.app` (repetido em `ios.associatedDomains` do `app.json`, para o prebuild) e `ios/Varanda/Info.plist` tem `VarandaWebCredentials` em `true`; `test/hardening.test.js` confere que os dois, o host dos App Links do Android e o `apple-app-site-association` do deploy falam do mesmo app e do mesmo host. A passkey e a volta do Google só funcionam depois de três passos do operador: `VARANDA_IOS_APP_ID=<Team ID>.app.varanda` no `deploy/seeder/.env` da produção; um deploy que publique `https://bora.varanda.app/.well-known/apple-app-site-association` com esse id; e um perfil de provisionamento com Associated Domains. O `eas build` logado na conta Apple sincroniza a capacidade a partir do entitlement (linha `Synced capabilities` no terminal) e confere o perfil com a Apple; sem esse login ele não confere, e o perfil se refaz em `eas credentials -p ios`. A Apple lê o arquivo por uma CDN própria, então a mudança pode demorar a chegar aos aparelhos. O build de simulador não é assinado pelo time e não casa com o arquivo: a entrada se confere no TestFlight, num iPhone com iOS 18 ou mais novo.
- O módulo local `apps/app/modules/auth-session` devolve ao app a etapa do Google na ligação da conta, sem passar o código pelo esquema `varanda://`. No Android usa Auth Tab (androidx.browser 1.9.0): precisa do Chrome 137 ou mais novo e de `/.well-known/assetlinks.json` com `handle_all_urls`. No iOS usa ASWebAuthenticationSession com retorno https (iOS 17.4 ou mais novo), com o mesmo `webcredentials` e a mesma chave `VarandaWebCredentials` da passkey. O app usa o navegador padrão quando ele tem Auth Tab e, se não tiver, só o Chrome que veio instalado no aparelho (outro app poderia se declarar navegador e devolver um código de outra conta Google); sem nenhum dos dois, pede que a pessoa ligue a conta Google no site, com a mesma passkey.

## Envio para a App Store (EAS)

O perfil `production` do `apps/app/eas.json` gera o build de loja do iOS, e o perfil `submit.production` o envia ao App Store Connect (`ascAppId` 6831662804, bundle `app.varanda`). O fluxo `.github/workflows/ios-release.yml` roda `eas build --platform ios --profile production --auto-submit --non-interactive --no-wait` a cada push em `main` que mexe no app (`apps/app`, `packages`, `package.json`, `package-lock.json`, `.easignore`) ou por Run workflow em `main`. O runner só põe o build e o envio na fila: o resultado aparece no expo.dev e no App Store Connect, não no GitHub. O build chega ao TestFlight; mandar uma versão para a revisão da App Store continua manual, no App Store Connect.

Passos únicos, de quem tem as contas Apple e Expo, da pasta `apps/app`:

```sh
eas build:version:set -p ios
eas credentials -p ios
eas env:create --name EXPO_PUBLIC_VARANDA_INSTALLATION --value https://<dominio> --environment production --visibility plaintext
eas build -p ios --profile production --auto-submit
```

- `eas build:version:set` passou a numeração para a EAS (`"appVersionSource": "remote"`), e `autoIncrement` sobe o número do build a cada build, sem editar o projeto. O `CFBundleVersion` do `Info.plist` deixa de valer para a loja. Foi rodado em 2026-11-06, a partir de 1; o primeiro build de loja que terminou foi o 4.
- A versão (`CFBundleShortVersionString`, hoje `0.1.0`) continua no projeto nativo. Para uma versão nova na App Store, mude `MARKETING_VERSION` em `ios/Varanda.xcodeproj/project.pbxproj`, `CFBundleShortVersionString` em `ios/Varanda/Info.plist` e `version` no `app.json`, e confira que a versão aberta no App Store Connect tem o mesmo número.
- Em `eas credentials -p ios`, escolha `production`, deixe a EAS criar o certificado de distribuição e o perfil de provisionamento, e em "App Store Connect: Manage your API Key" configure a chave que o EAS Submit usa. Sem essa chave guardada na EAS, o envio com `--non-interactive` falha. Só Account Holder ou Admin da conta Apple cria a chave. Ela nunca entra no repositório (`*.p8` está no `.easignore` e o teste confere).
- O perfil `production` define `npm_config_ignore_scripts=true`. O builder da EAS roda `npm ci --include=dev` na raiz, e sem isso o script de instalação do `sharp` (dependência do `@huggingface/transformers` de `apps/cli`, sem uso no app) tenta compilar do código-fonte no macOS e o build para na etapa Install dependencies. É o mesmo `--ignore-scripts` da CI. O hook `eas-build-post-install` roda mesmo assim, porque o npm executa o script chamado pelo nome. Os perfis `preview` não têm a variável, então um build iOS deles pode cair no mesmo erro.
- Conformidade de exportação: `ITSAppUsesNonExemptEncryption` é `false` no `Info.plist` (mantido à mão) e em `ios.config.usesNonExemptEncryption` do `app.json` (para um `expo prebuild` gerar o mesmo), e `test/hardening.test.js` confere os dois. Assim o App Store Connect não pergunta a cada build, e o build da CI vai direto ao TestFlight. Vem das respostas dadas no App Store Connect em 2026-11-06: algoritmos padrão além dos do sistema (libsodium e o protocolo Noise) e sem distribuição na França; com elas, o próprio App Store Connect disse que não precisa de documentação e sugeriu declarar no `Info.plist`. A resposta só vale enquanto a França ficar fora da disponibilidade (Pricing and Availability) e a criptografia do app não mudar. Se a França entrar, a Apple pede a declaração francesa, e a chave e as respostas precisam ser revistas.
- Para ligar o fluxo: crie um token de acesso da Expo para a conta `varanda-org`; em Settings > Environments, crie o ambiente `app-store`, com deployment branches só `main` e o segredo `EXPO_TOKEN`; em Settings > Secrets and variables > Actions > Variables, crie `VARANDA_IOS_RELEASE` com o valor `true`. Qualquer outro valor pausa os envios, inclusive pelo Run workflow.
- O fluxo instala o `eas-cli` 27.2.0 com `--ignore-scripts`, a versão do primeiro build e envio deste perfil. Antes de trocar a versão, rode um build local com a nova.
- Cada push em `main` que mexe no app gasta um build iOS da EAS. `apps/cli/test/ios-release.test.js` fixa a forma do fluxo e os perfis do `eas.json`.

## Ficha da App Store (EAS Metadata)

`apps/app/store.config.json` guarda a ficha do iOS em pt-BR no formato do EAS Metadata (`configVersion: 0`): nome, subtítulo, descrição, palavras-chave, URLs, categoria e versão. Quem tem a conta Expo e acesso ao App Store Connect roda, da pasta `apps/app`; nenhum destes comandos roda na CI nem num agente, menos o `lint`:

```sh
eas metadata:lint   # confere o arquivo contra o esquema do eas-cli, sem falar com a Expo nem com a Apple
eas metadata:push   # envia a ficha para a versão editável do App Store Connect
eas metadata:pull   # baixa a ficha do App Store Connect e sobrescreve o arquivo
```

- O bloco `apple.review` fica fora do arquivo de propósito: o esquema exige nome, e-mail e telefone do contato da revisão, e o repositório é público. Contato, conta de demonstração e notas para a revisão se preenchem à mão em App Store Connect › App Review Information; sem o bloco, o `push` não mexe neles.
- Depois de um `pull`, apague o `apple.review` que ele escreve antes de commitar, e confira o diff inteiro.
- `apple.version` escolhe a versão editável: se ela não existir, o `push` renomeia a versão em preparação para esse número.
- `apple.copyright` fica no arquivo porque, sem ele, o eas-cli 27.2.0 envia `copyright: null` no `push`, o que pode apagar o copyright do App Store Connect. O texto segue a licença e a conta Apple, que hoje é individual. Se a conta passar para a associação, troque o texto aqui e no App Store Connect.
- A classificação etária (`apple.advisory`) também fica fora do arquivo e se responde à mão em App Store Connect › App Information › Age Rating, com a classificação 16+ (os Termos pedem 16 anos ou mais) e `https://varanda.app/termos/` como Age Suitability URL. O questionário da Apple tem perguntas que o esquema do eas-cli não tem (nem o 27.2.0 nem o 27.5.0): Social Media e Social Media Disabled for Users Under 13. Num app sem classificação, o `push` com o bloco falha em "Failed to update age rating declaration" (falta `socialMedia`); depois do questionário respondido, ele passa, mas regrava as outras respostas a partir de um arquivo que não diz tudo. Sem o bloco, o `push` não mexe na classificação ("Skipped age rating update, no advisory configured"), e ela fica num lugar só. Quando o eas-cli aceitar essas perguntas, o bloco pode voltar.
- Ficam no App Store Connect, fora do EAS Metadata: privacidade do app (o formulário de dados coletados), preço e disponibilidade, direitos de conteúdo, conformidade de exportação (criptografia) e, enquanto o arquivo não tiver `screenshots`, as capturas.
- As respostas do formulário de privacidade precisam bater com `NSPrivacyCollectedDataTypes` em `ios/Varanda/PrivacyInfo.xcprivacy` e em `ios.privacyManifests` do `app.json`, e `test/hardening.test.js` fixa a lista confirmada em 2026-11-08: nome, e-mail, ID de usuário, contatos (as listas públicas de quem se segue), localização aproximada (cidade e bairro da Feira), mensagens, fotos, áudio, outro conteúdo do usuário, informação sensível (selfie ou documento na Didit), outros dados (faixa de idade e registro do aceite), histórico de busca (sem ligação com a pessoa) e interação com o produto (contadores por membro e, quando ligadas, as estatísticas de uso; é o único tipo que também serve para análise). Todos servem ao funcionamento do app, e nada é marcado como rastreamento. Mensagens diretas e grupos privados cifrados ficam fora, porque o serviço não consegue lê-los e a Apple define coleta como acesso por mais tempo do que o necessário para atender ao pedido. Mudou o formulário, mude os dois arquivos e a lista no mesmo PR.
- A resposta sobre direitos de conteúdo se apoia na seção "Seu conteúdo" dos Termos.

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

`render-assets.js` needs `rsvg-convert` (`brew install librsvg`); `cwebp` (`brew install webp`) is only for the screenshot recipe in `apps/site/artwork/screens.md`. The Android mipmaps are PNG bytes under `.webp` names, as Expo writes them. Never use `npx expo prebuild` to regenerate icons: `apps/app/ios/Varanda/AppDelegate.swift` (backup exclusion) and `apps/app/android/app/build.gradle` (release signing) carry hand-made security fixes that prebuild would overwrite (see [verification.md](verification.md)). After any `npm ci`, run `npm run prepare:native -w apps/app` again before a native build.

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
- `expo-haptics` 55.0.18 comes from `expo/bundledNativeModules.json`, as an exact pin. It is a native module, so after `pod install` the rule for the two `SPEC CHECKSUMS` lines above applies, and the `ExpoHaptics` entry in `Podfile.lock` is committed.
- `expo-background-task` 55.0.22 and `expo-task-manager` 55.0.20 come from `expo/bundledNativeModules.json`, as exact pins (the first depends on the second, which brings `unimodules-app-loader` 55.0.5, pod `UMAppLoader`). They let the phone refresh A Rua's saved snapshot while the app is in the background, so the next launch opens on recent posts (PR19 of the instant-load run). Both autolink on Android (`android/settings.gradle`) and need no Gradle change. On iOS the `ExpoBackgroundTask`, `ExpoTaskManager` and `UMAppLoader` entries in `Podfile.lock` are committed, and `ios/Varanda/Info.plist` carries by hand the two keys the `expo-background-task` config plugin would add: `UIBackgroundModes` with `processing`, and `BGTaskSchedulerPermittedIdentifiers` with `com.expo.modules.backgroundtask.processing`. Neither module's plugin is listed in `app.json`, since there is no prebuild; the `expo-task-manager` plugin would also add the `fetch` mode, which only the old background fetch API uses, so it is left out. After pulling this change run `npm ci` and `npm run prepare:native -w apps/app`, then rebuild the native app (`npm run ios`, `npm run android` or a new EAS build): a JavaScript reload alone does not load the new native code.
- `bare-pack` 2.2.4, not the 3.x line. 3.0.0 is a major released after `react-native-bare-kit` 0.16.0; 2.2.4 shipped the same day as bare-kit 0.16.0 and has the same `--linked`, `--host` and `--format` options.
- `bare-runtime` 1.33.4 (dev only, packages/core), for the desktop Bare smoke test. It is the Bare that `react-native-bare-kit` 0.16.0 embeds (the gate prints `bare=v1.33.4`), so the smoke test and the app run the same runtime. 1.34.1 was used until 2026-10-29.

### Accepted `npm audit` advisories

Reviewed on 2026-10-29 (`npm audit`: 11 vulnerabilities, 5 low and 6 high, all below). The Expo and React Native packages run at build time on the developer's machine and are not in the app bundle, the worklet or any server.

| Package (path) | Advisory | Kind | Exposure and decision |
|---|---|---|---|
| `zod` 3.25.76 (`expo` > `@expo/cli`) | memory exhaustion validating oversized constrained collections | build | `@expo/cli` validates our own `app.json` and Expo's manifests, never data from a peer. Accepted. npm's only fix is `expo@51.0.39`, a downgrade outside SDK 55. |
| `deepmerge` 4.3.1 (`expo` > `@expo/config`), and the `@expo/*` packages that depend on it | `mergeObject()` prototype poisoning (low) | build | It merges our own config files. Accepted, same fix as above. |
| `node-forge` 1.4.0 (`expo` > `@expo/cli`, `@expo/code-signing-certificates`) | RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements | build | Used by Expo Updates code signing, which the app does not configure. The fix, 1.4.1 and 1.4.2, was published on 2026-10-27, under the two weeks we wait for. Accepted until the next review, then `npm update node-forge` (within `@expo/cli`'s `^1.3.3`). |
| `sharp` 0.34.5 (`@huggingface/transformers` 3.8.1, `apps/cli`) | libvips, libheif and librsvg vulnerabilities | runtime, account service only | The abuse triage reads text only: no image, HEIF or SVG ever reaches `sharp`, which `transformers.js` loads at require time. The model runs in a child process with an empty environment, off by default (`VARANDA_AI`). Accepted. The fix is `@huggingface/transformers` 4.x, a major: decide it together with the model files, not alone. |

Review routine: before each release, and whenever `react-native-bare-kit` or `expo` changes, run `npm audit`, compare it with this table and update it. Remove a row once the package is fixed; add a row, with its kind and exposure, for any new advisory or fix the build with a pin bump instead. In the same review check the pins above: `npm view react-native-bare-kit version`, and make `bare-runtime` match the Bare it embeds (the `bare=v...` line of the worklet gate), then run `npm test -w packages/core`.
