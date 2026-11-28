# Lista do Bunny atrasada na criação da zona

Branch `fix/bunny-zone-list-lag`. No Bunny real a lista demorou a mostrar a zona criada: o `apply` criou a zona e parou porque ela ainda não aparecia.

## Conferido

- [x] `node apps/cli/test/bunny.test.js` (24 testes, 637 asserções; antes, 20 testes e 603 asserções). Quatro testes novos rodam `bunny.main` no processo, com uma espera falsa e a lista escondendo a zona recém-criada:
  - atraso de 2 respostas: sai 0, espera 1 s e 2 s, imprime "esperando até 30 s" uma vez, faz um só `POST /pullzone`, e as regras (a de bloqueio primeiro) ainda entram antes da origem real;
  - atraso de 5 respostas: o mesmo, depois dos cinco intervalos, então a busca depois da última espera conta;
  - atraso que não acaba: sai 1, espera 1, 2, 4, 8 e 15 s, o erro manda rodar plan primeiro, a linha genérica "apply pode rodar de novo com segurança" não aparece, e a única escrita é o `POST /pullzone`, com a origem que nunca resolve;
  - busca que falha depois da criação: sai 1 sem esperar e também manda rodar plan primeiro.

  A saída não traz a chave nem o segredo.
- [x] Regressão, uma correção de cada vez: sem o laço de espera, 3 dos 24 testes falham; sem o aviso de plan numa busca que falha, 1 falha; com a linha genérica de volta, 1 falha. Com o código desta branch, o arquivo passa.
- [x] `node apps/cli/test/bunny-precheck.test.js` (29 testes, 353 asserções), que importa o script.
- [x] `npm run lint`.
- [x] `npm run demo`.
- A suíte inteira roda na CI do GitHub.

## Não conferido

- Quanto o Bunny real atrasa a lista. 30 s é uma estimativa. Se a zona não aparecer, o erro manda rodar plan e depois apply.
