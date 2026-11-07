# App screenshots for varanda.app

The "Como funciona" section (`#como-e-usar`) of `public/index.html` shows four screenshots of the real iOS app, captured on an iPhone 17 Pro simulator (iOS 26.2, 402x874 pt, captured at 1206x2622 px). The app runs in Vitrine mode, with the fixture data in `apps/app/src/vitrine/fixtures.js`, so every person and every post on screen is fictional. Nothing is repainted.

## Files

All eight are in `apps/site/public/assets/screens/`. Each one is encoded from a full-size PNG capture kept outside the repository.

| File | Size | Bytes | Budget |
|---|---|---|---|
| `a-rua-402.webp` | 402x874 | 33 650 | 45 KB |
| `a-rua-804.webp` | 804x1748 | 77 812 | 120 KB |
| `diario-402.webp` | 402x874 | 27 278 | 45 KB |
| `diario-804.webp` | 804x1748 | 62 390 | 120 KB |
| `conversas-402.webp` | 402x874 | 26 602 | 45 KB |
| `conversas-804.webp` | 804x1748 | 61 438 | 120 KB |
| `conversa-402.webp` | 402x874 | 18 542 | 45 KB |
| `conversa-804.webp` | 804x1748 | 42 510 | 120 KB |

All files are encoded with `cwebp -q 82`, and every one came in under its budget, so the quality was never lowered. The PNG originals stay outside the repository.

## What each screen shows

- **A Rua** (`a-rua`): the top of the feed. Posts by João Nascimento, Lia Oliveira, Horta do Bairro (text only), Biblioteca da Praça (mentioning @bia_araujo) and André Costa, then Cecília Ramos's post with a link, cut off by the tab bar the way a feed looks while you scroll. The publish button is in the corner.
- **Diário** (`diario`): Lia Oliveira's own Diário. The sunset band, her initials in place of a photo, the bio "Café, livros e encontros na praça.", 5 seguindo and 2 seguidores, "Editar perfil", then her posts: a text post and her quote of Cecília Ramos's "As primeiras flores apareceram na horta". No photos (see Pitfalls).
- **Conversas** (`conversas`): the search field, the Todas, Não lidas and Grupos filters, Pedidos de mensagem, Comunidades, then the conversations with Bia Araújo and André Costa and the groups Passeios de bicicleta, Organização do clube, Nosso Bairro and Clube de Leitura, with unread counts.
- **Conversa** (`conversa`): the direct conversation with Bia Araújo. Messages about the book club, a reply that quotes "Você", and a message with two photos ("Fotos do encontro de domingo."). The photos are the Vitrine's small drawings (`apps/app/src/vitrine/pictures.js`), not real photos. The composer is empty and there is no keyboard.

## Fictional content

The people in the Vitrine are:

- Lia Oliveira (the Vitrine's own account)
- João Nascimento
- Cecília Ramos
- André Costa
- Bia Araújo
- Tomás Ferreira

Applicants: Nina Souza, Caio Lima.

Pages: Biblioteca da Praça, Horta do Bairro.

Community: Horta Comunitária. Groups: Passeios de bicicleta, Organização do clube, Nosso Bairro, Clube de Leitura.

Before using a capture, check that every name on screen is in this list.

The account service reserves the @handles of the people and pages above (`RESERVED` in `apps/cli/lib/account/store.js` and `apps/cli/lib/account/pages-routes.js`), so no member can take one and seem endorsed by the site. A new or renamed handle in a capture goes into both lists too.

## Recipe

1. Install the dependencies and build the Debug app for the simulator:

   ```sh
   npm ci --ignore-scripts
   npm run prepare:native -w apps/app -- ios
   (cd apps/app/ios && xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build build)
   ```

   `pod install` rewrites two `SPEC CHECKSUMS` lines of `Podfile.lock` and the privacy manifest (see "iOS" in `docs/development.md`). After the build, and only if you made no lock change of your own, put the committed files back:

   ```sh
   git status --short apps/app/ios
   git restore --worktree apps/app/ios/Podfile.lock apps/app/ios/Varanda/PrivacyInfo.xcprivacy
   ```

   Restoring breaks the next build's "Check Pods Manifest.lock" phase, so run `prepare:native` again before building again. Never run `expo prebuild`. The `ios/` folder is maintained by hand.

2. Create and boot a dedicated simulator. List the runtimes to find the iOS 26.2 id, then create the device:

   ```sh
   xcrun simctl list runtimes
   xcrun simctl create "Varanda Vitrine" "iPhone 17 Pro" <iOS 26.2 runtime id>
   xcrun simctl boot <udid>
   ```

   Always address the simulator by its UDID, never `booted`, so other simulators in use are never touched.

3. Start Metro with the Vitrine on its own port. Run it from `apps/app`:

   ```sh
   EXPO_PUBLIC_VARANDA_VITRINE=1 CI=1 npx expo start --localhost --port 8082
   ```

   `CI=1` keeps Metro non-interactive, so it can run in the background. Do not pass `--clear`: the Metro cache is shared with other checkouts. Wait until this prints `packager-status:running` (use `localhost`: Metro may listen only on IPv6 `[::1]`, and then `127.0.0.1` gets no answer):

   ```sh
   curl -s http://localhost:8082/status
   ```

4. Install and open the app:

   ```sh
   xcrun simctl install <udid> apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
   xcrun simctl launch <udid> app.varanda -RCT_jsLocation localhost:8082
   ```

   If the app still loads port 8081, set the Metro address in the app defaults, stop the running app and launch it again (`simctl launch` does not restart an app that is already running):

   ```sh
   xcrun simctl spawn <udid> defaults write app.varanda RCT_jsLocation localhost:8082
   xcrun simctl terminate <udid> app.varanda
   xcrun simctl launch <udid> app.varanda -RCT_jsLocation localhost:8082
   ```

   The Debug app's default Metro port is set at pod install, so `RCT_METRO_PORT` at launch has no effect.

5. Check that it is the Vitrine. A Rua must show the follows of Lia Oliveira (João Nascimento, Cecília Ramos, and so on). Skip the intro cards.

6. Set the status bar and the light appearance:

   ```sh
   xcrun simctl status_bar <udid> override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
   xcrun simctl ui <udid> appearance light
   ```

7. Capture each screen. Save the PNGs in a scratch folder outside the repository:

   ```sh
   xcrun simctl io <udid> screenshot <scratch>/<stem>.png
   ```

8. Encode each capture at both sizes. Install the encoder once with `brew install webp`:

   ```sh
   sips -z 1748 804 <scratch>/<stem>.png --out <scratch>/<stem>-804.png
   sips -z 874 402 <scratch>/<stem>.png --out <scratch>/<stem>-402.png
   cwebp -q 82 -metadata none <scratch>/<stem>-804.png -o apps/site/public/assets/screens/<stem>-804.webp
   cwebp -q 82 -metadata none <scratch>/<stem>-402.png -o apps/site/public/assets/screens/<stem>-402.webp
   ```

   If a file is over its budget, lower `-q` only as far as needed and note it in the table.

## Pitfalls

- No LogBox or dev overlay may be on screen. Dismiss it before capturing.
- No keyboard on screen.
- Avoid the Horta do Bairro post: its photo shows "foto indisponível".
- The Vitrine is dev-only. It needs a `__DEV__` bundle and `EXPO_PUBLIC_VARANDA_VITRINE=1` (see `apps/app/src/vitrine/enabled.js`), so a release build never shows it.
- The Diário has no photos, because Vitrine media exists only for direct messages and groups (`apps/app/src/vitrine/media.js`).
- Never touch another session's simulator or the Metro server on port 8081.
- The dates on screen depend on the simulator's real clock, not on the status bar override. The fixtures are dated 4 and 5 November 2026 (`apps/app/src/vitrine/fixtures.js`), and `apps/app/src/format.js` shows them as "4 nov" and "5 nov" only from 7 November 2026 to the end of 2026. Earlier they read "hoje", "ontem" or "N h"; from 2027 on they gain the year ("5 nov 2026"). A recapture outside that window changes how the screens look.
- After replacing a capture, update the Bytes column of the table above and run `node apps/site/test/site.test.js`.

## Environment

- App commit: `ff5958f2` (`main`). Debug build `apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app`, JS served by Metro on port 8082 with `EXPO_PUBLIC_VARANDA_VITRINE=1`. The `-RCT_jsLocation localhost:8082` launch argument worked on the first try.
- Simulator: a dedicated "Varanda Vitrine" iPhone 17 Pro, iOS 26.2 (UDID `92F47855-662C-4707-AD55-9769AB60E735`), light appearance.
- Network: none needed. The Vitrine answers every request from fixtures.
- Captured on 2026-11-07. The fixtures date everything 4 and 5 November 2026; only the status bar clock was overridden.
