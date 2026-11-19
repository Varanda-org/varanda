# Capa dos anúncios da Feira

## Escopo

Branch `fix/feira-og-image`, empilhada sobre `feat/og-transcode`. Um anúncio só com AVIF não tinha `og:image`, e os leitores de links não mostram AVIF.

- Página (`apps/cli/lib/feira-page.js`): com `view.cover`, um único `og:image` em `/f/<D>/<seq>/capa`, `image/jpeg`, com as dimensões de `coverSize`. Só vale o caminho `/capa` do próprio anúncio, na mesma origem. Sem `view.cover`, fica a escolha de antes (primeira foto de tipo conhecido que não seja AVIF).
- Semeador (`apps/cli/lib/seed-ws.js`): `listingView` só cria `cover` nas mesmas condições da capa automática dos posts (`automaticCover`). `/capa` converte a primeira foto quando ela precisa de capa e há conversor; recusa ou falha devolve a foto armazenada. Depois da leitura e da conversão, edição, estado e descritor são conferidos de novo: anúncio editado, apagado ou bloqueado no meio responde o 404 uniforme.
- Orçamento: `/capa` continua no orçamento das fotos da Feira (balde de `/media`, 8 em andamento, 503 quando esgota), antes de qualquer consulta. A conversão gasta também o orçamento de conversão das capas dos posts (2 por segundo, rajada de 4, 2 em andamento); sem ele, sai a foto armazenada, como antes.
- Sem conversor, visão, página e `/capa` são as de antes. `/foto/<n>` e o corpo não mudam. Sem mudança de registro nem de Termos.

## Verificação local

Node 24, fora de sandbox, com a DHT local dos testes:

- `node apps/cli/test/feira-page.test.js`: 19/19 testes, 107/107 asserções.
- `node apps/cli/test/seeder-feira-http.test.js`: 6/6 testes, 183/183 asserções.
- `node apps/cli/test/seeder-post-http.test.js`: 14/14 testes, 509/509 asserções.
- `npx standard` nos quatro arquivos JS alterados: sem diagnósticos.
- Regressões conferidas com `seed-ws.js` e `feira-page.js` de antes da mudança: `og:image uses the first AVIF cover, including before a PNG` falha (18/19) e `seeder-feira-http.test.js` falha nos testes da capa automática; com a mudança restaurada, os dois passam.

A suíte completa roda na CI do GitHub (Node 20 e 24).

## Staging, não executado

1. Com a Feira ligada e o conversor pronto, publicar um anúncio só com AVIF e outro com AVIF seguido de PNG. Pedir a página com `curl -A 'facebookexternalhit/1.1' '<origem>/f/<D>/<seq>'` e conferir um único `og:image` em `/capa`, `image/jpeg` e as dimensões reduzidas.
2. Pedir `/capa` com GET e HEAD com o mesmo User-Agent: 200, `image/jpeg`, tamanho exato e HEAD sem corpo. Conferir que `/foto/1` continua AVIF e que uma primeira foto JPEG pequena sai como foi guardada.
3. Editar, apagar e bloquear o anúncio durante uma conversão e depois de a conversão estar em cache: nenhuma capa antiga pode sair. Desligar o conversor ou recusar a foto e conferir que volta a foto armazenada.
