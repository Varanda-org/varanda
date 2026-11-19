# Prévia de fotos pelo semeador

## Escopo

Branch `feat/og-transcode`. Sem capa do aparelho, `GET|HEAD /p/<diário>/<seq>/capa` converte a primeira foto (ou o pôster do vídeo) para JPEG quando ela é AVIF ou passa de 256 KiB, e a página da publicação passa a citar `/capa` no `og:image`.

- Conversor (`apps/cli/lib/og-transcode.js` e `og-transcode-child.js`): `sharp` 0.34.5 num processo filho com ambiente vazio, só IPC, heap de 256 MiB, só bytes, no máximo 8 MiB e 16 MP, um quadro, tamanho declarado igual ao lido, prazo de 4 s com SIGKILL, respawn com espera, fila de 4, cache em memória (64 entradas, 16 MiB) e conjunto de recusas (512). Sem disco, sem rede, sem log. Um JPEG com orientação EXIF diferente de 1 é recusado.
- Semeador (`apps/cli/lib/seed-ws.js`): a capa do aparelho vence; a fonte é relida e conferida por hash a cada pedido, inclusive HEAD e cópia em cache; o compartilhamento e o descritor são conferidos de novo depois da conversão; orçamento próprio (2 pedidos/s, rajada de 4, 2 em andamento) antes de qualquer consulta; toda falha é o mesmo 404.
- Página (`apps/cli/lib/post-page.js`): cita `/capa` só quando algum filho já confirmou AVIF no host, há um filho de pé, a foto precisa de capa e não foi recusada. Uma renderização com o filho caído inicia outro em segundo plano, um por vez e fora da espera de respawn. Sem conversor, a saída é idêntica à de antes.
- Recusas: as do filho são guardadas pelo hash da fonte; as que o semeador encontra antes de converter (quadros, tamanho, bytes ou tipo declarados) são guardadas pela chave do diário, o trecho do núcleo e os campos declarados, para que outro diário não desligue a capa de quem publicou os bytes certos.
- Termos e Política na versão 105, linha LGPD em `docs/design.md`, `docs/protocol.md` §16 e nota de operação no README.

## Verificação local

Node 26, fora de sandbox, com a DHT local dos testes:

- `node apps/cli/test/og-transcode.test.js`: 15/15 testes, 328/328 asserções, com o filho real (AVIF 16x16, grade ImageIO do iOS, PNG, WebP, JPEG grande, orientação EXIF 6 recusada).
- `node apps/cli/test/seeder-post-http.test.js`: 14/14 testes, 509/509 asserções.
- `node apps/cli/test/post-page.test.js`: 34/34 testes. Sem `autoCover`, o HTML é idêntico ao de antes (hashes capturados antes da mudança).
- `node apps/cli/test/cli.test.js` e `readme-help.test.js`: passam, sem opção nova.
- Regressões conferidas removendo a correção e rodando de novo: orientação EXIF (11/12 sem a correção), prontidão depois de falha na inicialização, novo filho iniciado por uma renderização depois de o filho cair, recusas antes da conversão e recusa feita por outro diário (`the same bytes declared right keep their cover`).
- Pico de RSS do filho: 84,5 MiB ao converter `ios.grid2048x1536`.

A suíte completa roda na CI do GitHub (Node 20 e 24, ubuntu-24.04, onde o teste com o filho real é a conferência no Linux).

## Staging, não executado

Com uma publicação de teste compartilhada, só com AVIF e sem capa do aparelho, pedir a página e a `/capa` com o User-Agent de um leitor de links (por exemplo `WhatsApp/2.24.1`). Conferir um único `og:image` apontando para `/capa`, `image/jpeg`, dimensões reduzidas, GET com JPEG e HEAD sem corpo. Repetir com um JPEG grande e depois publicar uma capa pelo aparelho: as dimensões dela devem ganhar. Retirar o compartilhamento e conferir 404 em `/capa`, mesmo depois de aquecer o cache. Conferir que `/previa` continua JSON. Colar o link no WhatsApp e no Telegram e conferir a imagem.

## Contêiner, só com aprovação do dono

Não executado. Uma vez cada, a partir da raiz:

```sh
docker build -f deploy/seeder/Dockerfile -t varanda-seeder-og-check .
docker run --rm --network none --entrypoint node varanda-seeder-og-check -e 'const { createOgTranscoder } = require("./apps/cli/lib/og-transcode"); (async () => { const t = createOgTranscoder(); try { const { avif } = await t.ready(); console.log("avif " + avif); if (!avif) process.exitCode = 1 } finally { await t.close() } })().catch(() => { process.exitCode = 1 })'
```

Resultado esperado do segundo comando: `avif true`.
