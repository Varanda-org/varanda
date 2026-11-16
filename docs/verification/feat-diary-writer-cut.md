# Corte pelo diário do escritor de um aparelho (branch feat/diary-writer-cut)

Parte da #350, item do PR #241: "O diário não corta o escritor de um aparelho perdido."

Decisão de Rodrigo, 16/11/2026: o corte é feito pelo diário. Um registro `group-cut` passa a valer para QUALQUER escritor do próprio diário, não só para as marcas do criador na raiz de um grupo: o que aquele aparelho escrever depois do corte deixa de contar, o que já estava visível continua contando, e o corte nunca deixa um diário reescrever decisões de outros diários nem desfazer a própria saída. Num grupo privado, o escritor cortado deixa de ter direito a chaves: o grupo precisa de uma chave nova, e o aparelho cortado não lê nada selado depois. O ponto do corte é escolhido pelo nó que grava a marca (o comprimento que ele tem daquele escritor). Este PR é só o lado da dobra; a lista de "aparelhos conectados" que grava as marcas vem depois.

## O que mudou

- `packages/core/lib/group.js`: `cutTable` lê as marcas uma vez por dobra (diário -> escritor -> menor corte, mais os diários com buraco). Em `bindCores`, um escritor w ligado pelo diário d (nunca a raiz de G, nunca a raiz de uma comunidade) perde os registros com seq >= max(corte, 1), como se o núcleo terminasse ali. Ficam sempre: o bloco 0, toda saída (`group-leave`) e todo bloco de chave (`group-key`).
- Duas passagens puras (`bindCut`): a primeira dobra com os cortes marcados; `cutFloors` acha o piso de cada escritor cortado, o maior entre os cortes em w das concessões, rebaixamentos, banimentos e admissões aplicados cujo sujeito é d, e `seq + 1` das refs de `basis` em w de blocos de chave de outro diário que valem para envio. A segunda dobra usa o corte efetivo, max(marcado, piso). `seen` e `replyTo` não sobem o piso, porque qualquer membro poderia citar o aparelho perdido e manter os registros dele contando.
- Um bloco de chave depois do corte vale só para leitura: abre o histórico, nunca envia e não acrescenta destinatário à regra 4. Um bloco cujo `auth` cita um CW cortado é julgado pelo comprimento que o leitor tem do CW (`heldSeq`), não pelo comprimento depois do corte: o histórico continua legível, e o CW cortado não dá autoridade de envio.
- Um escritor cortado nunca é `entitled`. A época selada para ele deixa de ser elegível e o grupo fica `rekeyPending` até um distribuidor girar a chave. O corte não é um requisito de `removals`: a regra 4 basta, e uma época antiga que nunca foi selada para ele pode continuar elegível, o que é seguro.
- O escritor cortado sai de `liveWriters` e `authorityWriters`, mas continua em `writers` e ocupando a vaga do diário.
- O resultado de `buildGroup` e de `buildCommunity` ganha `cuts` (Map escritor -> corte efetivo) e `cutUnknown` (Set dos diários com escritor contado cujas marcas, como lidas, têm buraco). Um `{ gap: true }` não corta nada; o nó não deve tomar a dobra como completa sobre cortes desses diários.
- A regra da raiz do criador ("Creator marks on group roots") não mudou. Numa comunidade, a mesma regra vale para o CW do próprio diário, sem cortar de forma implícita os escritores de grupo ligados a ele.
- `docs/protocol.md`: o registro `group-cut`, a lista de resultados de `buildGroup` (`liveWriters`, `cuts`, `cutUnknown`), o parágrafo "Diary cuts on own writers" com as regras finais, "Creator marks on group roots", "Removals", "Entitled writers" e os riscos residuais. `docs/design.md`: o limite do aparelho perdido.

## Como verificar

A partir da raiz:

- `node packages/core/test/community-fold.test.js` (105 testes, 975 asserções), com os testes novos:
  - "group-cut on an own writer: its records from the cut on stop counting (#350)".
  - "group-cut on an own writer: its authority from the cut on stops counting (#350)": moderação depois do corte não conta, a de antes conta; um corte muito acima do comprimento (1e9) não tira nada.
  - "group-cut: a creator mark on its own non-root writer cuts it, root marks keep their meaning (#350)".
  - "group-cut on a community writer: its records in C from the cut on stop counting (#350)".
  - "group-cut: a demoted or banned admin cutting its own writer never rewrites its past moderation (#350)": admin rebaixado ou banido que corta abaixo do próprio banimento de X ou da admissão de Y: X segue banido, Y segue membro, o que estava visível continua, e o corte sobe para 3, o corte do rebaixamento ou do banimento; já o corte de um admin ainda ativo, que nenhuma decisão de outro diário cobriu, fica onde foi marcado e o banimento gravado depois dele cai.
  - "group-cut: a cut never undoes a leave nor the rejoin naming it (#350)": cortes 0, 1 e 2 abaixo da saída deixam X fora; uma volta que nomeia a saída cortada continua valendo e o grupo não fica `incomplete`.
  - "group-cut: mark order and arrival give one result, a gap is reported (#350)": as 6 ordens das marcas dão o mesmo resultado; um buraco aparece em `cutUnknown` sem cortar.
- `node packages/core/test/group-private.test.js` (117 testes, 798 asserções), com:
  - "a writer its own diary cut is never entitled: the group rotates as after a removal (#350)".
  - "a key block past a diary cut stays readable, never sendable (#350)": o aparelho de A girou a chave depois de uma remoção, membros selaram nela, o diário de A corta esse escritor abaixo do bloco: o histórico continua legível, a época não envia, `rekeyPending`, a remoção continua contada.
  - "a key block citing a cut community writer stays readable (#350)".
  - "a diary cut below its own leave keeps the diary left and the removal (#350)".
  - "a mark that arrives after the rotation, in any order, gives the same fold (#350)".
- Outros arquivos de dobra e de grupos, cada um sozinho com `node <arquivo>`, sem falhas: `packages/core/test/group.test.js`, `group-crypto`, `group-events`, `group-index`, `group-media`, `group-poll-block`, `community-member` e `community-member-leave` (1 a 5): 281 testes, 2136 asserções. Na web: `packages/web-member/test/group-ops.test.js`, `community-ops.test.js` e `session-groups.test.js`: 153 testes, 1220 asserções.
- `npm run lint`.

Prova de regressão: com os testes no lugar e `packages/core/lib/group.js` do primeiro commit desta branch, falham os testes novos de bloco de chave, do CW cortado, da saída num grupo privado, do admin rebaixado, da saída e da volta, e o de formato de `emptyCommunity` (que agora lista `cutUnknown`). O teste de ordem das marcas já passava: a dobra anterior também não dependia da ordem. Com a correção de volta, tudo passa.

## Não verificado / limites conhecidos

- Ainda não há tela: nenhum nó grava marcas em escritores que não são a raiz. A lista de aparelhos conectados vem no próximo PR, que também deve pedir a troca de chave e respeitar `cutUnknown`.
- A troca de chave não acontece sozinha depois de um corte: o grupo fica `rekeyPending` até um distribuidor rodar `group.rekey` (ou o reparo depois da próxima mudança de chave dele).
- Uma saída gravada pelo aparelho perdido depois do corte continua valendo: quem estiver com ele pode fazer o diário sair, nunca desfazer uma saída.
- Um admin de outro diário que banir ou admitir d depois, listando w além do corte, ou um bloco de chave que cite w, sobe o corte até ali: o que essa decisão observou continua contando.
- Um bloco de chave gravado pelo aparelho perdido depois do corte ainda entrega, para leitura, chaves de épocas que ele já tinha.
- Um leitor cuja cópia do diário tem um buraco pode não ver a marca até o buraco ser preenchido (`cutUnknown` avisa).
- O corte não detém quem tem a identidade desbloqueada: essa pessoa também assina o diário e pode gravar marcas, inclusive nos outros aparelhos da dona.
- O escritor cortado continua ocupando a vaga do diário (outro item da #350 estuda liberar vagas).
