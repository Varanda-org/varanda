# Sobras da mídia nas conversas, parte 2 (branch fix/chat-media-leftovers-app)

Segunda parte da #443, que a fecha: o que mora no app, no nó do navegador e no `@varanda/rpc`. A primeira parte (semeador, nó e serviço de conta) está em `docs/verification/fix-chat-media-leftovers.md`. Os Termos e a Política de Privacidade passam à versão 67.

Cada teste de regressão abaixo foi rodado contra o código anterior (o arquivo de `HEAD` no lugar do novo, ou só a correção removida) e falhou; depois, com a correção, passou.

## Do #367: `getMedia` transforma qualquer erro em nulo

- [x] Uma leitura do armazenamento que falha não diz nada sobre o item: agora essa leitura cai para a rede, e a entrada continua no cache para a próxima. Só um item perdido ou estragado (não abre) deixa de contar como guardado, como antes. Teste "a failed read of a cached item misses once and keeps the entry cached" (`packages/web-member/test/dm-store.test.js`); falha com o `dm-store.js` anterior.

## Do #368: fotos de grupo público na escrita

- [x] O nó do navegador conferia só a foto cifrada. Agora `mediaUpload` confere toda foto com `mediaBounds` (formato, lados declarados) antes de guardá-la, também numa publicação do diário e num grupo público. O nó da CLI não envia fotos. Casos novos em `packages/web-member/test/session-media.test.js`: "a public photo that is not the image it claims" e "a PNG labelled JPEG"; falham com a conferência anterior (`if (sealed && ...)`). Os testes que enviavam bytes quaisquer como foto ganharam um cabeçalho de verdade (`packages/web-member/test/helpers/photo.js`).

## Do #369: worklet e iOS

- [ ] O fetch do worklet testado com o `http` do Node, não com o Bare. Fica para a conferência em aparelho com conta (veja "Fica devendo").
- [x] Um force-quit do iOS deixa arquivos decifrados até a próxima abertura. Decisão do mantenedor: aceitar como está. A varredura na abertura já os apaga, e o segundo plano também, quando o sistema o entrega.

## Dos #370 e #371: mensagens de voz

- [x] A taxa de amostragem não era comparada com a escala de tempo. Um decodificador AAC solta um número fixo de amostras por unidade (1024, ou 960 com `frameLengthFlag`) na taxa que o `AudioSpecificConfig` diz, seja qual for o `stts`. Agora `audioBounds` lê esse `AudioSpecificConfig` (tipo de objeto, taxa por índice ou explícita, SBR e PS) e recusa a nota quando unidades vezes amostras sobre a taxa passam da duração das amostras por mais de `AUDIO_MS_TOLERANCE`. Só esse lado é recusado: uma falha de captura ou um desvio dos tempos do gravador alonga os tempos das amostras, não o áudio decodificado, e uma nota que acaba antes do que diz não toca nada sem conferência. Uma configuração SBR (HE-AAC) cuja taxa de saída não é a taxa do núcleo nem o dobro dela também é recusada, porque os decodificadores divergiriam. Teste "audioBounds: an AAC decoder plays the samples no longer than they say" (`packages/rpc/test/audio-bounds.test.js`, com uma nota de 60 s com uma falha de captura de 2 s, que passa); falha com o `audio-bounds.js` anterior. As amostras dos testes passaram a usar AAC com taxa explícita (1024000 Hz, unidade de 1 ms; no `group-media.test.js`, 102400 Hz, unidade de 10 ms, porque dois minutos de unidades de 1 ms passariam do teto de 20000 amostras).
- [x] Opus não é conferido: o pacote Opus traz a própria duração no byte TOC, que a conferência não lê. Decisão deste PR: o balão de voz já pausa quando a reprodução passa do ms conferido por `AUDIO_MS_TOLERANCE`, então um Opus que diz durar menos não toca além disso.
- [ ] Conferir uma nota de voz gravada no Android e outra no Safari, e a gravação nativa no Android, Safari e iOS: precisam de conta (veja "Fica devendo").

## Do #388: prévia de link no celular

- [x] No celular, links encurtados ficavam sem prévia. O aparelho continua sem seguir redirecionamentos. Quando a resposta é um redirecionamento (status 0, tipo `opaqueredirect`, 3xx ou `redirected`), o app ligado à instalação da associação (nó hospedado, com membro e `request`) pede a prévia ao serviço de conta, pela mesma rota da web hospedada (`apps/app/src/previewService.js`); sem isso, segue o caminho de antes (a miniatura do YouTube, senão sem prévia). Decisão do mantenedor: pedir ao serviço de conta, com os Termos e a Política na versão 67. Teste "native buildPreview: a link that redirects goes to the account service of a hosted node" (`apps/app/test/linkCardBuild.test.js`); falha com o `previewBuild.native.js` anterior.
- [x] A rotação EXIF podia trocar a proporção. Os decodificadores nativos giram o JPEG pela orientação EXIF antes de redimensionar, e o tamanho do cabeçalho é o guardado: para as orientações 5 a 8 os lados trocam. `encodeThumbnail` usa agora `orientedSize` (`apps/app/src/media/exif.js`). Testes em `apps/app/test/mediaExif.test.js` e "native encodeThumbnail: a JPEG taken sideways is resized to its turned sides" (`apps/app/test/linkCardBuild.test.js`); o segundo falha com o `encode.native.js` anterior.
- [x] `expo/fetch` com `redirect: 'manual'` e a rotação do decodificador num aparelho: conferidos no Android e no iOS (veja "Aparelhos").

## Do #392: cache de mídia aberta

- [x] O cache de mídia aberta era apagado em todo bloqueio. Decisão do mantenedor: manter entre bloqueios. O bloqueio (`identity.lock()` na web; no app, `identity.clear` com o campo opcional novo `keepMedia: true`, 5.51) e a passkey de outro diário mantêm a mídia aberta, cifrada sob a chave local; Sair, Recomeçar, uma instalação que falha ou é cancelada depois de as chaves entrarem e o desbloqueio com outra identidade a apagam. No app, essas reinstalações desfeitas (a parada da própria instalação, o desfazer da recuperação por código, um Sair cujo `identity.forget` falhou) chamam `identity.clear` sem `keepMedia` e apagam o cache, como na web. O mesmo vale para o resumo cifrado da lista de conversas (o do membro e o de cada Página), que o bloqueio também apagava. Enquanto bloqueado, nem o cache nem o resumo são lidos. Testes: "a lock and a passkey of another diary keep the opened direct message media; Sair and a relock wipe them" (`apps/app/test/identityInstall.test.js`), "identity: lock during the install relocks without saving" (`apps/app/test/sessionStoreNative.test.js`: o bloqueio manda `keepMedia: true`, o desfazer não manda), "identity.clear: only an optional keepMedia" (`packages/rpc/test/methods.test.js`), a asserção nova de `assertRolledBack` (`apps/app/test/identityRecoveryNative.test.js`), "dm media end to end: photo with caption and photo only, the sealed cache outlives the pool and a lock, Sair wipes it" (`packages/web-member/test/dm-e2e.test.js`) e as asserções novas de `packages/web-member/test/resume.test.js` (o bloqueio mantém `dmMediaIndex`, Sair o apaga). Os de `identityInstall`, `sessionStoreNative`, `methods`, `dm-e2e` e `resume` falham com o código anterior.

## Fora do escopo

- A conferência de vídeo (`video-bounds`) não entrou: a issue trata da mídia das conversas, e o vídeo só existe nas publicações.

## Aparelhos

Conferido em 16/11/2026, no build de debug com o Metro do branch na porta 8101 (`EXPO_PUBLIC_VARANDA_VITRINE=1`), primeiro no Android (emulador API 36), depois no simulador iOS (iPhone 17 Pro) e por fim na web. Os módulos foram chamados pelo depurador do Hermes, no próprio app, sem conta:

- `expo/fetch` de `https://google.com/` com `redirect: 'manual'`: no Android, status 301 com `redirected: true`; no iOS, status 301 com `redirected: false`. Nos dois o aparelho não segue o redirecionamento, e o status 3xx já basta para `previewBuild.native.js` pedir a prévia ao serviço de conta.
- Um JPEG de 320x240 com orientação EXIF 1 e o mesmo com orientação 6: `manipulateAsync` devolve 320x240 e 240x320 nos dois aparelhos, ou seja, o decodificador gira pela orientação. `encodeThumbnail` devolve 320x240 e 240x320, os lados girados que a correção espera.
- Android e iOS abrem o app até A Rua da vitrine; a web abre os cartões de introdução, sem erro no console.

O pedido real ao serviço de conta depois de um redirecionamento precisa de conta e fica em "Fica devendo".

## Fica devendo

Conferências que precisam de conta, anotadas no checklist da #224:

- o fetch do worklet no Bare, abrindo uma foto de mensagem direta no app instalado;
- uma nota de voz gravada no Android e outra no Safari passando pela conferência, e a gravação nativa no Android, Safari e iOS;
- a prévia de um link encurtado no celular pelo serviço de conta, com a instalação da associação.

## Documentos

- `docs/rpc.md` 5.51: o campo opcional `keepMedia`; o bloqueio o manda e mantém o cache de mídia aberta, as outras reinstalações não o mandam e apagam o cache.
- `docs/protocol.md`: o resumo da lista de conversas fica no bloqueio; a conferência do `AudioSpecificConfig` de uma nota de voz AAC; quem lê a página de um cartão de link (o aparelho no app nativo, o serviço de conta na web e depois de um redirecionamento no app) e o cache de mídia aberta entre bloqueios.
- `docs/design.md`, seção LGPD: as linhas das fotos das mensagens diretas e da prévia de links.
- `docs/verification.md`: os trechos de limites e as caixas das seções 105, 107, 111 e 117 que este PR e a parte 1 resolveram. As seções 104, 106, 108 e 114 não tinham limite resolvido aqui.
- Termos e Política na versão 67: `apps/app/src/legal.js`, `packages/core/lib/terms.js`, `apps/site/public/termos/index.html` e `apps/site/public/privacidade/index.html`.

## Comandos

Arquivos rodados sozinhos, com a correção:

```sh
node packages/rpc/test/audio-bounds.test.js
node packages/core/test/group-media.test.js
node packages/web-member/test/dm-store.test.js
node packages/web-member/test/dm.test.js
node packages/web-member/test/dm-e2e.test.js
node packages/web-member/test/resume.test.js
node packages/web-member/test/session-media.test.js
node packages/web-member/test/e2e-media.test.js
node apps/app/test/identityInstall.test.js
node apps/app/test/identityRecoveryNative.test.js
node apps/app/test/sessionStoreNative.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/linkCardBuild.test.js
node apps/app/test/mediaExif.test.js
node apps/app/test/mediaFetch.test.js
```
