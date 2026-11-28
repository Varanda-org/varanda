### Adicionado

- `node scripts/bunny-precheck.js` confere, antes de ligar o CDN, se o Bunny entrega à origem só o endereço real da visita em `X-Real-IP` e `X-Forwarded-For`. O Caddy ganha a rota `/media/precheck-*`, que só responde a pedidos com `X-Varanda-Precheck: 1` e diz a zona e a chave de limite que o pedido recebe, sem o segredo, sem registro e com `no-store`. Passos em `docs/cdn.md`, seção "Bunny". Verificação em `docs/verification/feat-bunny-header-precheck.md`.
