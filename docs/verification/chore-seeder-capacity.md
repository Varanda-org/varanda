# Padrões de capacidade do semeador web

Branch `chore/seeder-capacity`. Os padrões estão em `deploy/seeder/compose.web.yaml` e documentados em `deploy/seeder/.env.example` e em `docs/seeder-capacity.md`.

## Conferido

- `apps/cli/test/deploy.test.js` confere cada padrão no compose (`${NAME:-valor}`), a proporção da memória de quadros com maxExternal (96 contra 32), o rajada não menor que o ritmo, o `.env.example` com a linha de cada valor, e que o limite por endereço de `/media/*` no Caddyfile fica em no máximo 25% da taxa global de mídia na mesma janela (256 por segundo em 10 s: 640).
- `npx standard apps/cli/test/deploy.test.js` e `node apps/cli/test/deploy.test.js`: os testes novos e os de limites do compose passam. Na árvore compartilhada, o teste "Caddyfile: /media/* drops the client address headers and keeps the upstream cache header" falhava enquanto outra tarefa (o `Caddyfile`, fora deste PR) acrescentava `immutable` aos arquivos com hash; ele não lê nada deste PR.

## Não conferido

- Os números são propostas. O `content-load.js` desta branch não tem opções de capacidade, então as quatro rodadas de `docs/seeder-capacity.md` não foram repetidas com eles. A redução esperada dos 503 de mídia com um cliente (1088 de 3124 hoje) vem do ritmo medido de cerca de 104 pedidos por segundo contra o novo ritmo de 256, e não de uma rodada. Confirmar depois que `test/content-timing` entrar, e registrar o resultado em `docs/seeder-capacity.md`.
