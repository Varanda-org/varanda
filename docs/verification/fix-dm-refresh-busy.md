# fix/dm-refresh-busy

Closes #910.

## O que mudou

- `packages/web-member/lib/dm.js`: um `pull` chamado enquanto outro do mesmo desbloqueio roda devolve a resposta desse (resultado ou erro), sem abrir outra leitura nem repetir nada. Só um pull de um desbloqueio anterior, ainda terminando, recebe `mensagens já em andamento`. O motor guarda `lastPullAt`, marcado só quando um pull começa de fato.
- `packages/web-member/lib/session.js`: o `dm.pull` manual não marca mais o horário antes de chamar o motor. A busca automática (no máximo a cada 120 s) se guia por `dmEngine.lastPullAt`, então uma recusa ou uma espera não a adia.
- `apps/app/src/screens/Mensagens.js` e `Conversas.js`: o erro de Atualizar aparece numa linha curta (`pullNotice` em `apps/app/src/dm.js`); a recusa vira "Já estou buscando mensagens. Tente de novo em instantes.". Em Conversas, só o puxar para atualizar mostra o erro; a busca automática continua quieta.
- `docs/rpc.md` 5.76 descreve a espera.

## Testes

- `packages/web-member/test/dm.test.js`: `a pull called while one runs gets that pull's answer; only a pull that starts moves lastPullAt` e `a failed pull can be called again; a second pull waits for the one running`.
- `apps/app/test/dm.test.js`: `pullNotice: the busy refusal in plain words, any other error through the fallback`.

## Falha sem a correção

Com o `dm.js` da `main`, os dois testes do motor falham: o segundo pull recebe `mensagens já em andamento` e `lastPullAt` não existe. Com a correção, passam.

## Limites

- A demora da busca original (2 a 3 minutos no laboratório) não foi medida nem explicada.
- Sem conferência em aparelho, simulador ou no laboratório com duas contas: a mudança está no nó do navegador e numa linha de erro das duas telas.
