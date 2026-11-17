# Codificação nativa de fotos paradas (branch feat/media-avif-encode)

Rodados: os comandos marcados abaixo e o codificador do `image-prep` compilado no macOS (não no iOS). Nada foi conferido em aparelho, simulador ou emulador. Os tamanhos da tabela não foram medidos.

## O que conferir

- Foto opaca no celular: no iOS, AVIF só quando a sonda diz que o codificador do sistema funciona e o AVIF não foi pulado nesta sessão depois de um tempo esgotado de 8 s; senão WebP; no Android, WebP. JPEG é o último recurso. Foto cujo tipo pode ter transparência (PNG, WebP, AVIF de origem): WebP, depois PNG, nunca AVIF nem JPEG. A capa de um vídeo é sempre JPEG. Lado maior 2048. Qualidade do AVIF 0,8 (no máximo 0,98, porque o codificador do sistema não grava nada em 1,0). WebP e JPEG 0,85. Os lados do AVIF são arredondados para baixo até o par. Cada resultado tem de passar no leitor estrito `mediaBounds`, com um quadro e dentro dos limites de tamanho, senão tenta o formato seguinte (`apps/app/src/media/stillPlan.js`, `apps/app/src/media/encode.native.js`).
- Módulo `apps/app/modules/image-prep`, só iOS (`ios/ImagePrepModule.swift`, pod `ImagePrep`, autoligado a partir de `apps/app/modules`): `canEncodeAvif()` (o ImageIO lista `public.avif` e uma prova de 16x16 funciona, em cache por execução) e `encodeAvif(uri, { maxSide, quality })`. Decodifica com a orientação aplicada, recusa origem acima de 100 megapixels antes de decodificar, desenha num bitmap opaco novo de 8 bits sRGB (o transparente vira branco, sem copiar metadados), recorta para lados pares (mínimo 16, máximo 4096), grava só em `image-prep/` no cache (arquivos com mais de 10 minutos são varridos), roda numa fila serial privada, devolve nulo em qualquer falha e nunca registra caminhos. Nenhuma biblioteca de codec AVIF entrou nos apps nativos. O Android não tem codificador AVIF e grava WebP pelo expo-image-manipulator.
- EXIF e GPS continuam de fora. GIFs ainda vão como estão. Avatar, capa de vídeo, miniatura de link e imagem de denúncia não mudam. O codificador da web não muda neste PR (WebP, senão JPEG). AVIF na web fica para um PR seguinte.

## Comandos

- [x] `npm run lint`
- [x] `node apps/app/test/stillPlan.test.js`
- [x] `node apps/app/test/imagePrepModule.test.js`
- [x] `node apps/app/test/encodeNative.test.js`
- [x] `node apps/app/test/hardening.test.js`
- [x] `node apps/app/test/podsLock.test.js`
- [x] `node apps/app/test/videoPrep.test.js`
- [x] `node apps/app/test/linkCardBuild.test.js`
- [x] `node apps/app/test/platformGate.test.js`
- [x] `node apps/app/test/encodePhotoCap.test.js`
- [x] `npm test -- --affected=origin/main` (549 arquivos, 0 falhas, Node 24, depois do merge da `main`)
- [x] `npm run demo` (DEMO OK)

## Conferência manual

Nada disto foi conferido.

- [ ] No simulador iOS, uma foto publicada sai como `image/avif` (ou `image/webp`, se a sonda for falsa). Conferir o mime gravado de fato: no build de debug o módulo `image-prep` vem do servidor de desenvolvimento na primeira foto, e uma falha nessa busca manda a foto em WebP sem aviso.
- [ ] No build de debug do Android, uma foto publicada sai como `image/webp`.
- [ ] A foto publicada no iOS aparece no Android e na web, e a foto publicada no Android aparece no iOS e na web.
- [ ] Uma publicação com vídeo continua saindo com capa JPEG.
- [ ] Denunciar uma foto AVIF de conversa continua produzindo o anexo JPEG.
- [ ] Um PNG com transparência sai como WebP.
- [ ] Num iPhone com a sonda falsa, a foto sai como `image/webp`, não `image/jpeg` (o WebP real do manipulador passa no leitor estrito).

## Codificador no macOS

As linhas do codificador de `ImagePrepModule.swift` compiladas com `swiftc` no macOS (ImageIO do macOS, não do iOS), com a saída lida por `rpc.mediaBounds`:

| Origem | Saída | `mediaBounds` | Observação |
|---|---|---|---|
| JPEG 4032x3024 | 2048x1536 | aceito, 1 quadro | cerca de 110 ms |
| JPEG 1001x667 | 1000x666 | aceito | sem caixa `clap` |
| JPEG 1001x667, orientação 6, GPS e comentário EXIF | 666x1000 | aceito | sem `Exif`, sem o comentário |
| PNG 800x600 meio transparente | 800x600 | aceito | opaco |
| JPEG 16x16 | 16x16 | aceito | a sonda devolveu verdadeiro |

## Tamanhos

Três fotos de amostra, as mesmas da sonda do formato. Nada foi medido.

| Foto | JPEG 0,85 | WebP 0,85 | AVIF 0,8 |
|---|---|---|---|
| 16x16 opaca | não medido | não medido | não medido |
| 2048x1536 opaca | não medido | não medido | não medido |
| 1001x667 opaca | não medido | não medido | não medido |
