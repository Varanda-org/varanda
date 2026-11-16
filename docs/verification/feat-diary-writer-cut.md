# Corte pelo diário do escritor de um aparelho (branch feat/diary-writer-cut)

Parte da #350, item do PR #241: "O diário não corta o escritor de um aparelho perdido."

Decisão de Rodrigo, 16/11/2026: o corte é feito pelo diário. Um registro `group-cut` passa a valer para QUALQUER escritor do próprio diário, não só para as marcas do criador na raiz de um grupo: as publicações e a autoridade daquele escritor a partir do corte deixam de contar. Num grupo privado, o corte conta como uma remoção: o grupo precisa de uma chave nova, e o aparelho cortado não lê nada selado depois. O ponto do corte é escolhido pelo nó que grava a marca (o comprimento que ele tem daquele escritor). Este PR é só o lado da dobra; a lista de "aparelhos conectados" que grava as marcas vem depois.

## O que mudou

- `packages/core/lib/group.js`: em `bindCores`, depois de aceitar um escritor w ligado pelo diário d (nunca a raiz de G, nunca a raiz de uma comunidade), `diaryCut` pega o menor `cut` entre as marcas válidas de d que nomeiam w. Os registros de w com seq >= max(cut, 1) saem antes da dobra, como se o núcleo terminasse ali; o bloco 0 fica. Toda regra seguinte (ordem, saídas, autoridade, `lastSeq`, chaves, envelopes) vê o log encurtado. Uma entrada `{ gap: true }` não corta escritores que não são a raiz.
- Um escritor cortado nunca é `entitled`, seja qual for o corte. Como `chooseEpoch` recusa uma época cujos destinatários incluem um escritor atual sem direito, a época selada para ele deixa de ser elegível e o grupo fica `rekeyPending` até um distribuidor girar a chave.
- O escritor cortado sai de `liveWriters` e `authorityWriters`, mas continua em `writers` e ocupando a vaga do diário.
- O resultado de `buildGroup` e de `buildCommunity` ganha `cuts` (Map escritor -> menor corte).
- A regra da raiz do criador ("Creator marks on group roots") não mudou.
- Numa comunidade, a mesma regra vale para o escritor de comunidade (CW) do próprio diário. Nenhum escritor de grupo ligado a esse CW é cortado de forma implícita.
- `docs/protocol.md`: o registro `group-cut`, o novo parágrafo "Diary cuts on own writers", "Creator marks on group roots", "Removals", "Entitled writers", os riscos residuais dos grupos privados e dos grupos. `docs/design.md`: o limite do aparelho perdido.

## Como verificar

A partir da raiz:

- `node packages/core/test/community-fold.test.js` (102 testes, 926 asserções), com os testes novos:
  - "group-cut on an own writer: its records from the cut on stop counting (#350)": grupo público, X com wX (perdido) e wX2; o corte em wX some com as publicações de seq >= corte, as anteriores ficam, wX2 e Y seguem; vale o menor corte; corte 0 e 1 deixam só o bloco 0; marca em outro diário, marca num escritor que o diário não liga, `{ gap: true }` sozinho e marca inválida não fazem nada.
  - "group-cut on an own writer: its authority from the cut on stops counting (#350)": ocultação, admissão e banimento de um admin depois do corte não contam, os de antes contam; uma saída gravada em wX depois do corte não faz X sair.
  - "group-cut: a creator mark on its own non-root writer cuts it, root marks keep their meaning (#350)".
  - "group-cut on a community writer: its records in C from the cut on stop counting (#350)".
- `node packages/core/test/group-private.test.js` (113 testes, 759 asserções), com "a writer its own diary cut is never entitled: the group rotates as after a removal (#350)": wX deixa de ter direito, a época atual (selada para wX) deixa de ser elegível e a dobra dá `rekeyPending`; depois de uma chave nova sem wX, os outros leem de novo e wX não abre o que foi selado na época nova.
- Outros arquivos de dobra e de grupos, sem falhas: `packages/core/test/group.test.js`, `group-crypto`, `group-events`, `group-index`, `group-media`, `group-poll-block`, `community-member` e `community-member-leave` (1 a 5): 281 testes, 2136 asserções. Na web: `packages/web-member/test/group-ops.test.js`, `community-ops.test.js` e `session-groups.test.js`: 153 testes, 1220 asserções.
- `npm run lint`.

Prova de regressão: com os testes no lugar e só `packages/core/lib/group.js` revertido, os cinco testes novos falham (community-fold 97/102, group-private 112/113; o teste de formato de `emptyCommunity`, que agora lista `cuts`, também falha). Com a correção de volta, tudo passa.

## Não verificado / limites conhecidos

- Ainda não há tela: nenhum nó grava marcas em escritores que não são a raiz. A lista de aparelhos conectados vem no próximo PR, que também deve pedir a troca de chave.
- A troca de chave não acontece sozinha depois de um corte: o grupo fica `rekeyPending` até um distribuidor rodar `group.rekey` (ou o reparo depois da próxima mudança de chave dele).
- Um leitor cuja cópia do diário tem um buraco pode não ver a marca até o buraco ser preenchido.
- O corte não detém quem tem a identidade desbloqueada: essa pessoa também assina o diário e pode gravar marcas, inclusive nos outros aparelhos da dona.
- O escritor cortado continua ocupando a vaga do diário (outro item da #350 estuda liberar vagas).
