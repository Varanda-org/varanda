# Câmera em publicações e momentos (branch feat/camera-posts-moments)

## O que muda

- `apps/app/modules/camera-capture` (Kotlin, só Android): abre a câmera do sistema por `ACTION_IMAGE_CAPTURE` e `ACTION_VIDEO_CAPTURE`, com FileProvider próprio, não exportado e limitado a `<cache>/CameraCapture/`; `EXTRA_DURATION_LIMIT` no vídeo; cancelar apaga o arquivo; a concessão é revogada no resultado; provedores de conteúdo de fora são recusados; sobras com mais de 24 h são apagadas. O app não declara CAMERA (`tools:node="remove"` no manifesto, `with-hardening`, lista BANNED de `check-apk-permissions`), porque as intenções do sistema não exigem.
- iOS: `launchCameraAsync` do expo-image-picker (permissão de câmera na hora de capturar), `NSCameraUsageDescription` novo e texto de microfone mais amplo (`Info.plist`, `app.json`, `with-hardening.js`).
- Web e PWA: sem código de câmera; `canCapture` é falso e o seletor de arquivos do navegador oferece a câmera.
- `apps/app/src/cameraChoice.js` e `Publicar.js`: os botões de foto e de vídeo de publicações e momentos, e o quadro vazio do momento, abrem a folha "Galeria / Câmera" quando o aparelho captura; senão a galeria abre direto. Vídeo de publicação até 30 s, de momento até 15 s. A foto capturada é apagada depois de codificada (`discardCapture`), o vídeo pelo `videoPrep`, e `sweepCaptures` roda ao abrir Publicar.
- Termos e Privacidade versão 114 (`legal.js`, `terms.js`, páginas do site, `docs/design.md`, `docs/google-play.md`).

## Testes

Cada arquivo rodou sozinho (`node apps/app/test/<arquivo>.test.js`) e passou:

- `cameraCaptureModule`: 193 asserções.
- `cameraChoice`: 195 asserções.
- `cameraCompose`: 182 asserções.
- `videoPrep`: 373 asserções.
- `platformGate`: 915 asserções.
- `legal`: 2564 asserções; site (`apps/site/test/legal.test.js`): 321; core (`packages/core/test/terms.test.js`): 126.
- `hardening`, `terms-version`, `composePolish`, `videoCompose`, `momentosScreen`, `musicDraft`, `momentPhotos`, `publicarFrame`, `shareShell`, `feiraCompose`: passou.

O Kotlin não foi compilado aqui (sem JDK); a CI nativa (`native.yml`) compila o módulo e confere as permissões do APK no PR.

Landing: `npm run lint` passou; os testes do diff contra `origin/main` (566 arquivos, cada um com `node`, quatro ao mesmo tempo) passaram, menos `packages/core/test/seeder-relay.test.js`, que este PR não toca e que passou sozinho (28/28); `npm run demo` terminou com DEMO OK.

A suíte inteira roda na CI do GitHub.

## Limites conhecidos

- Um app de câmera que ignora `EXTRA_DURATION_LIMIT` grava um clipe que depois é recusado por passar do limite.
- Se o Android não resolve o provedor de um app de câmera que devolve um Uri de conteúdo próprio, a captura falha fechada (erro, nada é salvo).
- Um app de câmera que devolve `RESULT_CANCELED` depois de gravar o arquivo não deixa nada (o arquivo é apagado).
- Uma foto da câmera cuja codificação falhou e ficou para "tentar de novo" guarda o arquivo até a varredura de 24 horas.
- Uma foto da câmera fica no cache enquanto pode ser reenquadrada; sai quando a foto deixa o rascunho ou o compositor fecha.
- Se o Android recriar a tela enquanto a câmera está aberta, aquela captura pode se perder; a próxima captura funciona.
- Um app de câmera pode guardar também uma cópia própria na galeria, que o Varanda não controla.

## Nos aparelhos

Não conferido aqui, a fazer:

- Foto e vídeo em uma publicação e em um momento num aparelho ou emulador Android (build de debug), confirmando que `dumpsys package` não lista CAMERA.
- O mesmo num iPhone de verdade (o simulador não tem câmera); com a permissão de câmera negada, a mensagem aparece.
- Momentos exigem uma conta hospedada.
