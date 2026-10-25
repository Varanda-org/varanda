# App screenshots for varanda.app

> **Note (2026-10-22).** The page no longer shows these screenshots. It shows a design preview of the new app UI, drawn in HTML and CSS inside `public/index.html` and `public/styles.css` (the `.app` classes), with the design written down in [app-design.md](app-design.md). The six `.webp` files were removed from `public/assets/screens/`. The app now has that design (three tabs, publish button and sheet, profile header, settings), so the recipe below is kept for capturing the real app with it; the file sizes, the environment and the screen descriptions further down are the historical inventory of the first, now removed, screenshots and say nothing about the new design; the fictional people and posts are the same ones the preview uses.

The three screens on the site are screenshots of the real Varanda app: the iOS member UI on the iPhone 17 Pro simulator. They are not mockups and nothing was repainted. The people and the posts are fictional.

## Files

All six are in `apps/site/public/assets/screens/`. Each comes from one full-size simulator capture (1206x2622 PNG, kept out of the repository):

| File | Size | Bytes | Budget |
|---|---|---|---|
| `a-rua-804.webp` | 804x1748 | 52 888 | 120 KB |
| `a-rua-402.webp` | 402x874 | 23 440 | 45 KB |
| `publicar-804.webp` | 804x1748 | 21 570 | 120 KB |
| `publicar-402.webp` | 402x874 | 9 504 | 45 KB |
| `diario-804.webp` | 804x1748 | 44 312 | 120 KB |
| `diario-402.webp` | 402x874 | 19 570 | 45 KB |

All six were encoded at `-q 82`. Every file came in under budget, so the quality was never lowered.

What each one shows:

- **A Rua**: the top of the feed. Marília Prado, Bia Carvalho and Seu Nelson are on screen, then Helena Dias's reply with the line "resposta a 16caf418:2". The bottom card is cut off by the screen edge, the way a feed looks while you scroll.
- **Publicar**: an unsent draft ("Tem um livro parado na estante? Que tal uma troca no fim de semana?") with the "publicar" button enabled. There is no keyboard, no caret and no status notice.
- **Diário**: Helena's own diary: #3 her reply (with "resposta a 16caf418:2"), #2 her post, #1 her profile and #0 the member certificate.

The status bar is set to 9:41, full battery (charged), 4 cellular bars and 3 Wi-Fi bars. No dev overlay, Metro banner or keyboard is on screen.

## Environment

- App commit: `aa0366a`. This is the Debug build `apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app`, and the app source is unchanged since that commit. JS was served by Metro from `apps/app`, started without `EXPO_PUBLIC_VARANDA_GATE_URL` and without `CI=1`.
- Simulator: iPhone 17 Pro, iOS 26.2 (UDID `8802DF5C-6A82-406C-8D4D-29618AEEA2BC`).
- Network: loopback only. There was a local DHT on `127.0.0.1:49800` and one certified seeder, and nothing joined the public DHT.
- **The app was uninstalled first** (`xcrun simctl uninstall booted app.varanda`). That erased the old verification demo data on the simulator ("Iara iPhone" and its diary). The app stays installed afterwards with the Helena Dias data.
- Test data lived in a session scratchpad directory (`<scratch>` below), outside the repository.
- Captured on 2026-10-22, so the cards show that date. The simulator clock was not changed; only the status bar was overridden.

## Fictional content

People (CLI members unless noted):

| Name | Bio |
|---|---|
| Marília Prado | café passado na hora e conversa boa |
| Seu Nelson | aposentado, feirante de coração |
| Bia Carvalho | professora, corre no calçadão |
| Helena Dias (the iOS app) | converso de varanda, de frente pro mar |

Posts, in the order they were published:

1. Seu Nelson: "Alguém sabe se a feira de sábado muda de rua? A barraca da manga é a melhor."
2. Bia Carvalho: "Fim de tarde no calçadão, vento bom, o mar de um azul que não cabe na foto."
3. Marília Prado: "Choveu de tarde e a varanda encheu: café, bolo de fubá e conversa até escurecer."
4. Marília Prado, reply to Nelson's post: "Mudou sim, duas quadras pra cima. A manga continua lá."
5. Helena Dias (app): "Terminei de pintar a grade da varanda. Amanhã tem café pra quem passar."
6. Helena Dias (app), reply to Bia's post: "Esse azul eu conheço. Guarda um pouco de vento pra mim."
7. Seu Nelson: "Obrigado, Marília. Sábado cedo eu passo."
8. Bia Carvalho: "Amanhã tem corrida cedo. Quem vem junto?"
9. Marília Prado: "Helena, guarda uma xícara pra mim!"

There is also the unsent draft in Publicar: "Tem um livro parado na estante? Que tal uma troca no fim de semana?"

Posts 7 to 9 are extra and were not in the original brief. A Rua lists the newest posts first. With posts 1 to 6 alone, Helena's two entries sit next to each other and so do Marília's two. No screen-sized window (about 3.6 cards) could then show four different authors. The three short posts at the top of the feed fix that.

## Commands

Run from the repository root. `<scratch>` is a fresh empty directory.

```sh
node apps/cli/scripts/local-dht.js --port 49800 &            # background; note the PID
B="--bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1"

# association and seeder
line=$(node bin/varanda.js assoc init --data <scratch>/assoc); ASSOC=${line##* }
line=$(node bin/varanda.js seed key --data <scratch>/seeder --association $ASSOC); SEEDER=${line##* }
node bin/varanda.js assoc certify-seeder --data <scratch>/assoc --seeder $SEEDER --out <scratch>/certs/seeder.json
node bin/varanda.js seed cert add --data <scratch>/seeder --association $ASSOC --cert-file <scratch>/certs/seeder.json
node bin/varanda.js seed --data <scratch>/seeder --association $ASSOC $B &   # background; note the PID

# each CLI member (marilia, nelson, bia)
line=$(node bin/varanda.js id create --data <scratch>/<m> --association $ASSOC); KEY=${line##* }
node bin/varanda.js assoc certify --data <scratch>/assoc --member $KEY --age-band 18+ --method stub --out <scratch>/certs/<m>.json
node bin/varanda.js cert add --data <scratch>/<m> --cert-file <scratch>/certs/<m>.json
node bin/varanda.js profile set --data <scratch>/<m> --name '<name>' --bio '<bio>'

# posts 1-4 (with ~2 s between them), the reply with --to <nelson key>:<seq>
node bin/varanda.js post  --data <scratch>/nelson  --text '...'
node bin/varanda.js reply --data <scratch>/marilia --to <nelson key>:2 --text '...'
# then each member, so the seeder admits them:
node bin/varanda.js sync --data <scratch>/<m> --once --timeout-ms 30000 $B
```

iOS app:

```sh
xcrun simctl uninstall booted app.varanda
xcrun simctl install booted apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
(cd apps/app && npx expo start --port 8081 --clear) &        # background; no gate URL, no CI=1
xcrun simctl launch booted app.varanda
```

In the app: **Conectar** (association key, bootstrap `127.0.0.1:49800`, DHT host `127.0.0.1`). Then the standalone **Identidade** step (it shows alone until the identity and the certificate exist): "criar identidade", then `assoc certify --member <app key> ...` and paste the JSON into the certificate field, then "gravar certificado". **Diário › Editar perfil**: Helena Dias. **Seguindo**: the three CLI keys. Sync once from the sync chip (Ajustes › Sincronizar, "sincronizar uma vez"; obsolete: the sync is now automatic, so just wait for the posts). Post 5 with the green publish button. Post 6 with "responder" on Bia's post in **A Rua**. Sync again. Then the CLI posts 7 to 9 with `post` and `sync --once` for each member, and a third app sync.

Then, for each capture:

```sh
xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl io booted screenshot --type png <scratch>/<name>.png      # a-rua, publicar, diario
sips -Z 1748 <scratch>/<name>.png --out <scratch>/<name>-804.png
sips -Z 874  <scratch>/<name>.png --out <scratch>/<name>-402.png
cwebp -q 82 -m 6 -metadata none <scratch>/<name>-804.png -o apps/site/public/assets/screens/<name>-804.webp
cwebp -q 82 -m 6 -metadata none <scratch>/<name>-402.png -o apps/site/public/assets/screens/<name>-402.webp
xcrun simctl status_bar booted clear
```

Finally stop Metro, the seeder and the DHT by their PIDs. A process started in the background of a non-interactive shell ignores SIGINT, so use SIGTERM.

## How to redo it, and the pitfalls

- **Accented text.** Use the simulator's paste, not typed input. With simulated typing or the tool's text paste, "ã" and "é" arrived as MacRoman mojibake ("Amanh√£"). What worked: `printf '%s' '<text>' | LC_ALL=en_US.UTF-8 xcrun simctl pbcopy booted`, then tap the field, tap it again, and choose "Paste". ASCII text (keys, certificate JSON, the name and bio) types fine. Smart quotes in the certificate JSON are handled by the app.
- **Swallowed taps.** The first tap after typing into a field is sometimes swallowed (see docs/verification.md). Wait about a second before tapping the button, then check that it took effect. If it didn't, tap again.
- **Tab bar.** There are three tabs (A Rua, Seguindo, Diário) and the bar no longer scrolls. Sincronizar is no longer a tab and there is no sync chip any more: the sync state is in Ajustes › Avançado › Sincronização (the gear on the Diário header), and the sync runs by itself (there is no "sincronizar uma vez"). Offline, a 'Sem internet' note sits under the top bar: capture online. A post with photos shows its grid only on the hosted web app; in the iOS app it shows neutral 'foto' tiles. The Diário no longer shows the key or technical records (profile, certificate), only posts.
- **Stale notice (obsolete for the new design).** After a reply, Publicar keeps the notice "resposta publicada" while the screen stays mounted. For the Publicar shot, relaunch the app (`simctl terminate` and `launch`: it reopens on the saved config), then paste the draft. Tap an empty area above the card so the caret goes away. Obsolete: the composer is now a sheet and success is a short toast in the shell, so no notice lingers; kept for history.
- **Simulator screenshots.** The iOS Simulator tool's own screenshot can lag a step behind. Check every state with `xcrun simctl io booted screenshot`.
- **Before you encode.** Look at each PNG: right tab, no overlay, no keyboard, 9:41 in the status bar, and none of the old test strings.
