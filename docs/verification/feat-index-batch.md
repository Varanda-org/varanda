# Nomes em lote no índice (PR feat/index-batch)

Os testes cobrem a rota em `apps/cli/test` (seeder), o `indexClient.js` (junção de `fetchMember`, `fetchMembers`, o 404 como queda para um pedido por autor), a fila de `names.js` e `namesPeek.js` e a medição em `apps/cli/test/content-load.test.js`. A bancada é só do Node em loopback; nenhuma medida é de celular.

Ordem da atualização: primeiro o semeador, depois o site e os apps. Um app novo contra um semeador antigo recebe 404 na rota em lote e pede um autor por vez (A8), e um semeador novo continua respondendo `GET /index/member/<chave>`; então a ordem inversa também não quebra, só fica sem o ganho até o semeador atualizar.

- [ ] 1. Depois de atualizar o semeador: `curl -s https://<semeador>/index/members/<chave1>,<chave2>`, com duas chaves de diários servidos. Esperado: 200 e `{"members":[...]}` com duas entradas, na ordem pedida; um autor que o semeador não serve vem como `null`.
- [ ] 2. Mesmo pedido com 17 chaves. Esperado: 404 (o semeador aceita no máximo 16 autores distintos por pedido, e o app nunca pede mais que isso).
- [ ] 3. No site e no app novos, abra A Rua com 20 ou mais autores diferentes e olhe a aba de rede. Esperado: 2 ou 3 pedidos `/index/members/` em vez de um `/index/member/` por autor, e os nomes aparecem como antes.
- [ ] 4. Com o app novo e o semeador antigo (antes do item 1, ou um ambiente de teste), repita o item 3. Esperado: um 404 por lote, depois pedidos `/index/member/` um por autor, e os nomes aparecem.
- [ ] 5. Com o semeador novo e o app antigo, abra A Rua. Esperado: tudo como antes, pedidos `/index/member/`.
- [ ] 6. Medida: `node apps/cli/scripts/content-load.js --clients 4 --duration-ms 20000 --dataset-size 25x40 --names 25 --names-mode single --json` e o mesmo com `--names-mode batch`. Esperado: `indexRequests` por abertura cai de cerca de 26 para cerca de 3 (25 contra 2 pedidos de nome, mais as contagens) e o `names` p50 com `--rtt-ms 100` cai pela metade ou mais.
