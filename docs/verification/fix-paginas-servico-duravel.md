# Sobras de Páginas: limites do serviço (branch fix/paginas-servico-duravel)

Parte da #352 ("Do #333", itens do serviço de conta). Não muda RPC nem Termos. O arquivo `pages.json` ganha uma tabela opcional `charges`.

## O que muda

- `group-post` e `group-seal` como página (`groupAction`, `apps/cli/lib/account/pages-routes.js`): depois de publicar, o nonce é gasto de forma durável (`pagesStore.spend`). Um reenvio depois de um reinício responde `{ seq, replay: true }` pela tabela de nonces gastos e não publica de novo. Se gravar o gasto falha, a resposta é incerta (`after()`), pois o post já saiu. Entradas, saídas e reboxes seguem como antes.
- Limite de 2 encerramentos ou mudanças por dono em 24 h: `charge` e `refund` em `apps/cli/lib/account/pages-store.js`, tabela `charges` em `pages.json`, com a linha `'<membro>:<nonce>:<página>'` para `{ at, page }`. O nonce prende o membro e a ação, não a página, por isso a página entra na chave: o nonce de um encerramento incerto usado em outra página é um uso novo. Validada por inteiro ao abrir (linha malformada faz o arquivo recusar abrir), no máximo 4096 linhas, linhas com mais de 24 h saem a cada escrita. Um arquivo sem a chave abre como vazio, e a chave não é escrita enquanto a tabela está vazia, para um build antigo ainda abrir o arquivo. `chargeLifecycle` e `refundLifecycle` (`pages-routes.js`) ficaram assíncronos e rodam sob o mesmo lock; falha do armazenamento recusa com `indisponivel`. Mesma regra de antes: um uso cobra uma vez, recusa definitiva devolve, `Uncertain` mantém, `caps.lifecycle` continua valendo.
- Item 7 (chaves de K1 depois de um `page-moved` cuja gravação de estado falhou): não estava coberto. `movePage` (`apps/cli/lib/account/pages-writer.js`) agora anuncia K2 mesmo quando a gravação do estado de K1 falha depois do `page-moved`, e `open()` anuncia qualquer K2 não anunciada que o `movedTo` de algum K1 aponte. `recoverTerminal` também roda com o estado de K1 perdido (`stateLost`), pois o registro terminal verificado basta. Assim K2 sobe ao semeador e as chaves de K1 saem de `page-keys.json`. Uma frase em `docs/protocol.md` §12.
- Docs: `docs/protocol.md` §12 (riscos residuais e "Mudar de chave"), procedimento de `VARANDA_PAGE_KEYS` no `README.md` e entrada em `deploy/seeder/.env.example`.

## Como verificar

Da raiz, um arquivo por vez:

- `node apps/cli/test/pages-writer.test.js` (29 testes; antes 26). Novos: uma falha de gravação do estado de K1 (o caminho vira uma pasta) logo depois do `page-moved` anuncia K2 e apaga as chaves de K1 quando K2 chega ao semeador, na hora e depois de reabrir (com o estado antigo de K1 e com ele perdido). Sem a mudança os três falham (K2 fica `announced: false`, as chaves de K1 ficam).
- `node apps/cli/test/pages-store.test.js` (40 testes; antes 37). Novos: "charges keep the 2 per 24 h cap across a reopen, a use once, a refund gives it back" (inclui o mesmo nonce em outra página), "a malformed charges row makes the file refuse to open; a file without the key opens" e "a store that cannot write refuses a charge with indisponivel". O teste "reopen equals memory and the file" agora confere que a chave `charges` não é escrita vazia.
- `node apps/cli/test/pages-lifecycle.test.js` (7 testes; antes 5). Novos: "the 2 per 24 h cap survives a restart, and a charged use resent after it is not charged twice" e "a move is charged to the cap that survives a restart". O teste de limite do primeiro cenário passou a usar um membro novo, porque o limite agora atravessa o reinício que o teste faz. Sem a mudança, o terceiro uso depois do reinício não é recusado.
- Conferido em 16/11/2026: com a chave da cobrança sem a página (um nonce já cobrado em qualquer página conta como o mesmo uso), "the same nonce on another page is a new use" (store) e "an uncertain close's nonce on another page is a new use" (lifecycle) falham; com a correção, passam.
- `node apps/cli/test/account-pages-groups.test.js` (1 teste, asserções novas): um `group-post` reenviado a uma instância nova das rotas (memória vazia) sobre os mesmos armazenamentos responde o mesmo `seq` com `replay: true`, e o grupo tem o post uma vez. Sem a mudança o grupo tem dois. Um gasto que não grava depois do post responde 202 com `uncertain: true`.
- `npm run lint`.

## Limites

- Os limites por minuto (avisos, 8 por página; operações por página; `caps.lifecycle` por minuto) continuam só na memória e zeram num reinício. Decisão de Rodrigo em 16/11/2026: limite aceito.
- O teste do grupo simula o reinício com novas rotas sobre os mesmos armazenamentos, não com um novo processo. O reenvio de `group-seal` depois de um reinício não tem teste próprio: usa o mesmo caminho do `group-post`.
- Um tombo entre o post do grupo e o gasto do nonce ainda publica de novo depois de um reinício. Uma linha de nonce expulsa pelo teto de 4096 também deixa um `group-post` repetir.
- Reversão só num sentido, como o `deleted` do diretório: um build sem a tabela `charges` recusa um `pages.json` com linhas de cobrança (a chave some enquanto a tabela está vazia). Até 24 h depois de um encerramento ou mudança, voltar a um build antigo faz toda rota de páginas responder `indisponivel` até a próxima atualização; nenhum dado se perde.
- Só os testes automatizados rodaram. Nada muda na tela.
