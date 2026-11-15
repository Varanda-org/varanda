# Índice do semeador: roda de uma conversa (branch feat/index-roda)

Este arquivo confere a rota `GET|HEAD /index/roda/<autor>/<seq>[/<cursor>]` do semeador (`Seeder#indexRoda`, `roda` em `packages/core/lib/engagement-index.js`, `INDEX_RODA_RE` e `rodaBody` em `apps/cli/lib/seed-ws.js`). Dada uma resposta, ela devolve a raiz da conversa, o comentário de cima (`top`) e todas as respostas dele, achatadas. O app ainda não chama a rota: isso vem em outro PR. Formato dos registros, RPC e Termos não mudam; `docs/protocol.md` seções 5 ("Seeder engagement index") e 7 ("Seeder index route") descrevem o contrato.

- Resposta: `{ ref, root, top, items: [{ ref, to }], next, total, authors, indexing, complete }`. `to` é a ref do pai. Qualquer chave a mais, tipo errado, linha a mais ou `next` que não é a última linha listada vira o 404 genérico.
- Limites: `RODA_PAGE` = 50 linhas por página; `RODA_SCAN` = 1000 em cada sentido: no máximo 1000 passos na subida até a raiz e no máximo 1000 arestas examinadas na descida.
- Ordem: uma resposta direta a `top` entra no horário dela; uma mais funda em `max(horário dela, horário de listagem do pai + 1 ms)`, então o pai vem sempre antes dos filhos. Mesmo desempate e mesma gramática de cursor (`<atMs>.<autor>.<seq>`) da leitura de `/index/post`.
- `complete: false` quando a descida foi cortada pelo limite. Nada é guardado: cada página é recalculada no pedido.
- 404 genérico para ref ou cursor malformado, publicação não indexada ou que não é resposta, e subida que encontra publicação ausente, apagada ou oculta, ciclo ou o limite.
- `root`, `top`, `items` e `total` são palavra do semeador: uma órfã cujo pai foi apagado antes de ser indexada pode aparecer como `root`. Quem lê só mostra uma resposta depois de lê-la do diário do autor e conferir que o `replyTo` assinado dela é `top` ou uma resposta já aceita, que o de `top` é `root` e que o de `root` é `null`.
- `/index/post` segue idêntico, byte a byte.
- Sem mudança no Caddy nem no service worker: o `handle /index/*` e o desvio do prefixo `/index/` já cobrem a rota, com o mesmo limite de 20 pedidos por 10 s por cliente.

Comandos, a partir da raiz:

```sh
node packages/core/test/engagement-roda.test.js
node apps/cli/test/seeder-index.test.js
node apps/cli/test/seed-ws.test.js
```

Implantação: o semeador precisa ser implantado antes de um app que chame `/index/roda`. Um app diante de um semeador antigo recebe 404 e cai no comportamento de reserva (essa mudança do app é de um PR posterior).

Situação:

- [ ] Os três testes acima passam: a conferir ao executar.
- [ ] Contra um semeador real: `curl` de `/index/roda/<autor>/<seq>` numa resposta devolve a raiz, o `top` e as linhas em ordem de pai antes de filho: pendente.
- [ ] `/index/roda/` com ref de uma publicação que não é resposta responde 404 `não encontrado`: pendente.
