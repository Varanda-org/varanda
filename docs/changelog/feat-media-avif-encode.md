### Alterado

- Fotos menores no celular (PR `feat/media-avif-encode`): no iPhone a foto sai em AVIF quando o codificador do sistema funciona, senão em WebP; no Android, em WebP. JPEG só em último caso. Uma foto com transparência sai em WebP, sem EXIF nem GPS. GIFs, avatar, capa de vídeo e miniatura de link não mudam. Uma publicação ou anúncio só com fotos AVIF fica sem imagem de prévia (`og:image`) na página pública. No navegador a foto continua em WebP ou JPEG. Verificação em `docs/verification/feat-media-avif-encode.md`.
