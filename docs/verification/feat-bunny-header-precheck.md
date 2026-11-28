# Pré-checagem dos cabeçalhos do Bunny

Branch `feat/bunny-header-precheck`. O script compara a chave do pedido direto com a zona e as chaves que o Caddy informa nos três pedidos pelo Bunny. A rota de eco só responde a pedidos com `X-Varanda-Precheck: 1`.

## Conferido

- [x] `node apps/cli/test/bunny-precheck.test.js` (29 testes, 353 asserções) cobre o formato da resposta, IPv4 e IPv6, os endereços de teste, os vereditos, a saída sanitizada, as opções do comando e o tempo limite de um pedido sem resposta. O servidor HTTP em `127.0.0.1` só responde ao eco com `X-Varanda-Precheck: 1`, como o Caddy, e confere a ordem, os cabeçalhos de cada pedido, a proteção da origem e os códigos de saída.
- [x] `node apps/cli/test/caddyfile.test.js` (36 testes, 796 asserções): a rota fica dentro de `handle /media/*`, só para `/media/precheck-*` com `X-Varanda-Precheck: 1`, responde nos três casos com a chave da zona de limite correspondente, sem refletir cabeçalho sem o segredo, com `no-store`, e o bloco só tem os dois `header` e os três `respond`.
- [x] `node apps/cli/test/deploy.test.js`: o `/media/*` encaminhado ao semeador continua sem `Cache-Control` do Caddy além da linha de `s-maxage`.
- [x] As suítes falham ao retirar, uma checagem por vez: no script, a comparação da chave com o endereço direto, a exigência da zona `media-cdn`, o aviso de perigo para endereços falsos e o `X-Varanda-Precheck` em p0 e em p1 a p3; no Caddyfile, o cabeçalho exigido pela rota, a chave `{header.X-Real-Ip}` em `@viaCdn`, um cabeçalho refletido sem o segredo e a rota inteira. Os arquivos voltam ao checksum original após cada execução.
- [x] `npm run lint`.
- [x] `npm run demo` termina com `DEMO OK`.
- [x] A rota num Caddy em execução, no Docker, com a imagem de `deploy/seeder/Dockerfile.caddy` e um segredo descartável:
  - `caddy adapt` mostra uma só rota para `/media/precheck-*`, que também exige `X-Varanda-Precheck: 1`.
  - Sem o cabeçalho, ou com `0`, `true`, `11` ou vazio, o pedido vai ao semeador. `1 ` chega como `1` (o HTTP tira os espaços em volta) e recebe o eco.
  - As três zonas respondem a chave certa: `media` com o endereço da conexão, `media-cdn` com o `X-Real-IP` e `media-cdn-borda` com o endereço da conexão. Respondem com `no-store`, `text/plain` e `nosniff`, e nunca mostram o segredo.
  - 600 pedidos à rota não gastam a janela de `/media/*`: depois deles, 480 pedidos de mídia dão 200, o 481º dá 429 e a rota continua respondendo.
  - O script, por um Bunny simulado, sai com 0 quando o Bunny põe o endereço da visita nos dois cabeçalhos, com 1 (PERIGO) quando repassa os da visita, com 1 sem a regra do segredo e com 2 quando descarta `X-Varanda-Precheck`. Com o segredo vazio no servidor, para em g1 com 2, antes de pedir ao Bunny. A saída nunca tem o segredo.

## Não conferido

- Se o Bunny repassa `X-Varanda-Precheck` à origem. Se não repassar, os três pedidos pelo Bunny recebem 404 e o script sai com 2.
- A pré-checagem com o Bunny e o servidor reais, que o mantenedor roda seguindo `docs/cdn.md`, seção "Bunny".
