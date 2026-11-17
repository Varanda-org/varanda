# AVIF nas fotos: formato real dos codificadores (sonda T0)

Antes de ajustar o leitor de AVIF de `packages/rpc/lib/media-bounds.js`, esta sonda gravou arquivos AVIF de verdade com os dois codificadores que o app vai usar (ImageIO da Apple e libavif em WASM) e registrou a forma exata das caixas. As amostras de 16x16 viraram `packages/rpc/test/helpers/avif-samples.js`.

Máquina: MacBook com Apple M4 Pro, macOS 27.2.1 (26B131), Xcode 26.2 (17C52), Swift 6.2.3, Node 24.22.1. Data: 17/11/2026. O código descartável (`enc.swift`, `enc-libavif.mjs`, `dump.cjs`) ficou fora do repositório.

Imagens de entrada: bitmap novo de 8 bits sRGB, sem metadados, uma grade 8x8 de blocos de cor; a versão com alfa tem o quarto superior esquerdo transparente e blocos com 40% de alfa. Tamanhos: 16x16 opaca, 16x16 com alfa, 2048x1536 opaca, 1001x667 opaca.

## Resultado por item

| Item | Onde | Resultado |
|---|---|---|
| (a) ImageIO, macOS | macOS 27.2.1, `swiftc -O enc.swift` | `public.avif` está em `CGImageDestinationCopyTypeIdentifiers()` (`org.webmproject.webp` não está). Os quatro arquivos saíram com `kCGImageDestinationLossyCompressionQuality` 0.8. |
| (a) ImageIO, iOS | Simulador iOS 26.2 (iPhone 17 Pro, já ligado), `xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios18.0-simulator`, `xcrun simctl spawn` | Mesmo resultado. 16x16 e 2048x1536 idênticos byte a byte aos do macOS; 1001x667 tem a mesma estrutura e outro tamanho de bitstream (1895 contra 2069 bytes). |
| (b) libavif WASM | `@jsquash/avif` 2.1.1 (libavif 1.0.1 + libaom), Node 24.22.1, uma thread | Funciona no Node sem adaptador: basta `init(await WebAssembly.compile(avif_enc.wasm))`. Opções: `quality` 80, `subsample` 1 (4:2:0), `bitDepth` 8, `lossless` false. |
| (b) tempo 2048x1536 | mesmo | Blocos lisos: speed 6 343 ms, 8 217 ms, 10 136 ms. Com ruído (mais perto de uma foto): speed 6 2962 ms (895 KB), 8 368 ms (1,16 MB), 10 294 ms (1,16 MB). |
| (c) leitura das caixas | `dump.cjs` sobre os 12 arquivos, mais uma varredura de tamanhos no ImageIO | Tabelas abaixo. Nenhum arquivo tem bytes depois da última caixa. |
| (d) canvas, Chromium | `chrome-headless-shell` 151.0.7922.34 já presente em `~/Library/Caches/ms-playwright` (o pacote `playwright` não está instalado) | `toBlob('image/webp')` devolve `image/webp`; `toBlob('image/avif')` devolve `image/png`. |
| (d) canvas, WebKit | Safari do simulador iOS 26.2 (iPhone 17, ligado só para isso e desligado depois), página local em 127.0.0.1 | `toBlob('image/webp')` devolve `image/png`. `toBlob('image/avif')` devolve um Blob com `type` `image/avif` cujos bytes são um PNG (começam com `89 50 4E 47`). Não conferido em aparelho real nem no Safari do macOS. |
| (d) canvas, Firefox | | não rodou: Firefox não está instalado e o Playwright não tem navegadores além do Chromium. |
| (e) Android | `~/Library/Android/sdk` | Plataformas `android-34` e `android-36`; imagens de sistema só da API 36 (`google_apis` arm64-v8a e as AVDs `varanda-*`). Um emulador API 36 (Android 16) já estava ligado. |
| (e) exibição | | não rodou: AVIF no `Image` do React Native no Android e WebP animado no iOS precisam de um build do app. |
| (f) denúncia de foto AVIF | | não rodou: `manipulateAsync` decodificando um AVIF no Android (caminho de `reportImage.native.js`) precisa de um build do app. Num aparelho sem decodificador AVIF, denunciar uma foto AVIF não foi conferido. |

## Forma dos arquivos

### ImageIO (macOS 27.2.1 e iOS 26.2), imagem única

| Campo | Valor |
|---|---|
| `ftyp` | major `avif`, minor 0, compatíveis `MiPr avif miaf mif1`; com largura ou altura ímpar, só `avif mif1` (`ftyp` de 24 bytes) |
| Caixas de topo | `ftyp`, `meta`, `mdat` |
| Filhos de `meta` | `hdlr`, `dinf`, `pitm`, `iinf`, `iprp`, `iloc` (o `iloc` é o último); com alfa, `iref` entre `iinf` e `iprp` |
| `hdlr` | `pict`, nome vazio |
| `dinf` | `dref` v0 com 1 entrada `url ` flags 1 (autocontida) |
| `pitm` | v0, item 1 |
| `iloc` | v0, offset_size 4, length_size 4, base_offset_size 0, um extent por item, dentro do payload do único `mdat` |
| `iinf` | v0; `infe` v2, tipo `av01`, nome vazio |
| `ipco` (opaca) | `colr` nclx 2/2/6 full_range 1, `clli` (MaxCLL 203, MaxFALL 64), `ispe`, `irot` ângulo 0, `pixi` 8,8,8, `av1C` |
| `ipma` | v0 flags 0; item 1: `colr`*, `clli`, `ispe`, `pixi`, `av1C`*, `irot`* (* = essencial; a ordem não segue o índice) |
| `av1C` | perfil 0, 8 bits, 4:2:0, sem configOBUs |
| Bitstream | `TEMPORAL_DELIMITER`, `SEQUENCE_HEADER`, `FRAME`; `still_picture` 0, `reduced_still_picture_header` 0, frame máximo igual ao `ispe` |
| Alfa | segundo item `av01`, `iref auxl` 2 para 1, `auxC` `urn:mpeg:hevc:2015:auxid:1` (essencial), `pixi` 8, `av1C` monocromático, `irot` essencial |

Largura ou altura ímpar (1001x667, 1023x767, 513x513): o `ispe` vem arredondado para cima até o par (1002x668) e um `clap` essencial recorta (1001/1 x 667/1, deslocamento -1/2, -1/2).

Grade: com largura ou altura a partir de 1024 (1024x768, 1024x100, 100x1024, 2048x1536, 4032x3024), o ImageIO grava uma grade de ladrilhos de 512x512. 1023x1023 ainda sai como imagem única. Na grade, o item primário é do tipo `grid` (dados no `idat`, construction_method 1, `iloc` v1), os ladrilhos `av01` são ligados por `iref dimg`, cada um com `ispe` 512x512 essencial e sequence header 512x512, e o `ispe` da grade traz o tamanho real (2048x1536: 3 linhas x 4 colunas, `idat` `00 00 02 03 08 00 06 00`). Em grade com tamanho ímpar não há `clap`: o tamanho de saída da grade já recorta.

### libavif 1.0.1 (`@jsquash/avif` 2.1.1)

| Campo | Valor |
|---|---|
| `ftyp` | major `avif`, minor 0, compatíveis `avif mif1 miaf MA1B` |
| Caixas de topo | `ftyp`, `meta`, `mdat` |
| Filhos de `meta` | `hdlr`, `pitm`, `iloc`, `iinf`, `iprp`; com alfa, `iref` depois de `iinf`. Sem `dinf` |
| `hdlr` | `pict`, nome `libavif` |
| `iloc` | v0, offset_size 4, length_size 4, base_offset_size 0, um extent por item, dentro do payload do `mdat` |
| `iinf` | v0; `infe` v2, `av01`, nome `Color` (alfa: `Alpha`) |
| `ipco` (opaca) | `ispe`, `pixi` 8,8,8, `av1C`, `colr` nclx 2/2/6 full_range 1 |
| `ipma` | v0 flags 0; item 1: `ispe`, `pixi`, `av1C`*, `colr` |
| `av1C` | perfil 0, 8 bits, 4:2:0, sem configOBUs |
| Bitstream | `TEMPORAL_DELIMITER`, `SEQUENCE_HEADER`, `FRAME`; `still_picture` 1, `reduced_still_picture_header` 1, frame máximo igual ao `ispe` (inclusive 1001x667, sem `clap`) |
| Alfa | segundo item `av01`, `iref auxl` 2 para 1, `auxC` `urn:mpeg:mpegB:cicp:systems:auxiliary:alpha` (não essencial), `pixi` 8, `av1C` monocromático |
| Grade | não: 2048x1536 sai como um item só |

## O que isso pede do leitor

- Aceitar os dois tipos de `auxC` de alfa (`urn:mpeg:mpegB:cicp:systems:auxiliary:alpha` e `urn:mpeg:hevc:2015:auxid:1`) se alfa for aceito.
- `irot` com ângulo 0 e `clli` aparecem em toda saída do ImageIO; `clap` em toda imagem única de tamanho ímpar.
- `still_picture` vale 0 no ImageIO: não dá para exigir 1.
- A ordem dos filhos de `meta` muda entre os codificadores (`iloc` vem por último no ImageIO).
- O ImageIO grava grade (`grid`, `idat`, `iloc` v1, `iref dimg`) a partir de 1024 px de lado. Ou o leitor aceita grade, ou o app limita o lado a 1023 px antes de codificar no iOS.
- Na web, o tipo do Blob que o canvas devolve não prova o formato: o Safari do simulador rotula um PNG como `image/avif`. Conferir os bytes.

## Comandos

Resultados a preencher. Marcar só o que tiver sido executado.

- [ ] `npm run lint`
- [ ] `npm test -w packages/rpc`
- [ ] `npm test -w packages/core`
- [ ] `npm test -w packages/web-member`
- [ ] `npm test -w apps/cli`
- [ ] `npm test -w apps/app`
- [ ] `npm run demo`

## Conferência manual

- [ ] As listas fechadas de mime em `docs/protocol.md` e `docs/rpc.md` batem com `MEDIA_MIMES` de `packages/rpc/lib/limits.js` e `packages/core/lib/records.js` e com `DM_MEDIA_MIMES` de `packages/core/lib/dm.js`: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/avif`.
- [ ] Avatar (`image/jpeg`, `image/webp`), capa de vídeo (`image/jpeg`) e miniatura de link (`image/jpeg`) seguem iguais.
- [ ] Nos semeadores, JPEG, PNG, WebP e GIF continuam por magic bytes, e AVIF só pelo parser `mediaBounds`.
- [ ] O texto novo não contém U+2014.
