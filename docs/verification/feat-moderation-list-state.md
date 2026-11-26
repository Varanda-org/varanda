# Estado da lista de moderação (branch feat/moderation-list-state)

Parte da #21. Novo método de leitura `moderation.status` (`docs/rpc.md` 5.177) no nó do core e no nó do navegador, e uma linha em Ajustes › Sobre com a data da lista aplicada. Nada muda no protocolo, no formato da lista nem nos Termos.

- **O que responde.** `{ seq, date, moderatorDate }` da lista que o nó aplica: a guardada, só se ainda verifica para a associação configurada, a mesma que o sync e as leituras seguem. Sem lista, os três vêm `null`. Nenhuma chave sai: nem `blocked`, nem `revokedIssuers`, nem a chave do moderador.
- **Sem efeito colateral.** Lê só o armazenamento (`blocklist.json` no core, kv `blocklist` no navegador): não abre loja nem rede, não interrompe sincronização, não escreve nada.
- **No app.** Ajustes lê o método ao abrir Sobre. "Lista de moderação de DD/MM/AAAA." no dia local do aparelho; antes da primeira lista, "Nenhuma lista de moderação recebida ainda."; um nó antigo ou uma resposta ilegível deixa a seção de fora. A explicação fica na folha do (i) (`HELP.moderacao`).

Como verificar, a partir da raiz:

- `node packages/rpc/test/methods.test.js`: o método está na tabela, não altera estado e recusa parâmetros.
- `node packages/core/test/blocklist-member.test.js` e `node packages/web-member/test/blocklist.test.js`: sem lista, nulos; uma lista de outra associação não conta; uma lista válida responde número e datas, sem chaves.
- `node apps/app/test/moderationStatus.test.js`, `node apps/app/test/sobre.test.js`, `node apps/app/test/help.test.js` e `node apps/app/test/vitrine.test.js`.
- `npm run lint` e `npm run demo`. A suíte inteira roda na CI do PR.

Limites:

- [ ] Conferência visual no emulador Android e no simulador iOS não feita nesta sessão; a linha usa os mesmos componentes (`Label`, `Body`, `HelpNote`) das outras telas de Ajustes.
