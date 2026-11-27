# Pré-checagem dos cabeçalhos do Bunny

Branch `feat/bunny-header-precheck`. O script compara a chave do pedido direto com a zona e as chaves que o Caddy informa nos três pedidos pelo Bunny. A rota de eco só responde a pedidos com `X-Varanda-Precheck: 1`.

## Conferido

- [x] `node apps/cli/test/bunny-precheck.test.js` (29 testes, 353 asserções) cobre o formato da resposta, IPv4 e IPv6, os endereços de teste, os vereditos, a saída sanitizada, as opções do comando e o tempo limite de um pedido sem resposta. O servidor HTTP em `127.0.0.1` só responde ao eco com `X-Varanda-Precheck: 1`, como o Caddy, e confere a ordem, os cabeçalhos de cada pedido, a proteção da origem e os códigos de saída.
- [x] `node apps/cli/test/caddyfile.test.js` (36 testes, 796 asserções): a rota fica dentro de `handle /media/*`, só para `/media/precheck-*` com `X-Varanda-Precheck: 1`, responde nos três casos com a chave da zona de limite correspondente, sem refletir cabeçalho sem o segredo, com `no-store`, e o bloco só tem os dois `header` e os três `respond`.
- [x] `node apps/cli/test/deploy.test.js`: o `/media/*` encaminhado ao semeador continua sem `Cache-Control` do Caddy além da linha de `s-maxage`.
- [x] As suítes falham ao retirar, uma checagem por vez: no script, a comparação da chave com o endereço direto, a exigência da zona `media-cdn`, o aviso de perigo para endereços falsos e o `X-Varanda-Precheck` em p0 e em p1 a p3; no Caddyfile, o cabeçalho exigido pela rota, a chave `{header.X-Real-Ip}` em `@viaCdn`, um cabeçalho refletido sem o segredo e a rota inteira. Os arquivos voltam ao checksum original após cada execução.
- [x] `npm run lint`.
- [x] `npm run demo` termina com `DEMO OK`.

## Não conferido

- A rota num Caddy em execução (sem binário do Caddy nesta máquina; Docker só com aprovação).
- Se o Bunny repassa `X-Varanda-Precheck` à origem. Se não repassar, os três pedidos pelo Bunny recebem 404 e o script sai com 2.
- A pré-checagem com o Bunny e o servidor reais, que o mantenedor roda seguindo `docs/cdn.md`, seção "Bunny".
