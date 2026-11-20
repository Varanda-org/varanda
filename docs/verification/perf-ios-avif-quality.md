# Qualidade do AVIF no iPhone (branch perf/ios-avif-quality)

O iPhone grava as fotos em AVIF com o codificador do sistema (`modules/image-prep`, `encode.native.js`); Android e web gravam WebP a 0,85. A qualidade do AVIF era 0,8 (`AVIF_QUALITY` em `apps/app/src/media/stillPlan.js`), e uma medição mostrou que ela gastava mais bytes que o WebP sem ganho que se veja. Esta branch a baixa para 0,75.

## O que muda

- `AVIF_QUALITY` passa de 0,8 para 0,75. `avifQuality()` só é chamado sem argumento, em `encode.native.js`, então só as fotos novas do iPhone mudam.
- A ordem das tentativas não muda: se o AVIF não passa em `accept`, vêm o WebP e o JPEG como antes. Fotos já publicadas, leitores, protocolo e rpc não mudam.

## Medição

- **Fotos:** 13 fotos JPEG de celular, cada uma girada pela orientação EXIF e reduzida para no máximo 2048 px no lado maior, com lados pares e sobre fundo branco, como faz `image-prep`.
- **Codificadores:**
  - AVIF pelo ImageIO do macOS 27, o mesmo codificador da Apple que o iPhone usa por `CGImageDestination`, de 0,4 a 0,95.
  - WebP pelo `cwebp` (libwebp, `-m 4`), de 50 a 95.
- **Métricas:** SSIMULACRA2 (libjxl 0.13), SSIM e VMAF do ffmpeg 9.0.2, cada imagem decodificada pelo ImageIO e comparada com a referência.

| | AVIF 0,75 | WebP 0,85 (Android e web) | AVIF 0,8 (antes) |
|---|---|---|---|
| SSIMULACRA2, mediana | 78,6 | 79,2 | 81,1 |
| SSIM, média | 0,98641 | 0,98635 | 0,98809 |
| Total das 13 fotos | 4605 KB | 4899 KB | 5384 KB |

A qualidade de AVIF que iguala o WebP 0,85, foto a foto, tem mediana de 0,745 pelo SSIMULACRA2 e de 0,746 pelo SSIM. Pelo VMAF, ela fica em 0,67, então 0,75 é o lado cauteloso. Resultado: cerca de 14% menos bytes que antes e cerca de 6% menos que o WebP 0,85.

## Testes

- `node apps/app/test/stillPlan.test.js`: o teste das constantes espera 0,75 e falha com 0,8.
- `node apps/app/test/encodeNative.test.js`: o codificador AVIF recebe `quality: 0.75`; o resto do caminho não muda.

## Fora desta branch

- Nenhum iPhone nem simulador foi usado: a medição foi no Mac. Falta conferir num aparelho que uma foto publicada sai em AVIF e com o tamanho esperado.
- AVIF no Android e na web, e JPEG XL (descartado depois desta medição).
