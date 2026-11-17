# Copiar conversas para outro aparelho (feat/dm-history-copy, #351 item 5)

## Decisões

- Começa só por toque, no aparelho antigo. Leva texto e fotos guardadas (cache), lacrados com a chave da própria conta; todo aparelho da mesma passkey importa.
- Um aviso (inner v7, `from === to ===` dono) aponta para o manifesto, que aponta para os pedaços. Fotos viram blobs novos (chave nova); o blob original nunca é reaproveitado.
- Selo `copy`: um selo de blob com cota semanal própria (8192 por diário e semana de Brasília, `copy-stamps.json`). Semeador antigo não responde: texto e manifesto caem para a cota diária; fotos nunca.
- Importação: linhas entram abaixo de tudo o que o aparelho tem (como `legacyHorizon`), com dedupe (mensagem por remetente e id, ctl por id, reação por remetente e id). Marcas de visto importadas não disparam a sincronização de vistos.
- Conversa apagada no aparelho de origem fica fora (só linhas que a dobra ainda mostra, mais os ctl). Páginas: o armazém da Página entra no aparelho que a guarda; senão espera cifrado (kv `dmCopyPend`) até a Página ser adotada ou até a retenção.
- Resultado: `{ id, messages, photos, notCached, leftOut }`. Termos 75 (os Termos e a Política ganham um parágrafo sobre a cópia).

## O que muda

`packages/rpc` (inner v7, eventos, método), `packages/core` (v7, selo `copy`, cota semanal no semeador), `packages/web-member` (`dm-copy.js`, blob com `copySource`, kv, sessão), `apps/app` (linha e folha em Conversas, aviso de importação), docs (`protocol.md` seção 11, `rpc.md` 5.152, `design.md`), Termos e Política.

## Testes

| Arquivo | Resultado | Sem a correção |
|---|---|---|
| `packages/rpc/test/dm-budget.test.js` | 15/15 | |
| `packages/core/test/dm.test.js` | 63/63 | |
| `packages/core/test/dm-stamp-net.test.js` | 26/26 | |
| `packages/core/test/seeder-dm.test.js` | 13/13 | |
| `packages/core/test/activity.test.js` | 9/9 | |
| `packages/web-member/test/dm-copy-e2e.test.js` | 52 asserções, 3 testes (~128 s) | com a importação desligada, o teste 1 espera `dm.copyImported` e estoura em 170 s (falha, como exigido) |
| `dm-copy-e2e.test.js`, teste "the conversations of a Página come along" | 20 asserções (~35 s) | sem o arquivamento dos pendentes (`settle` nunca arquiva): `tempo esgotado: copyImported after adoption`; sem guardar o armazém de uma Página não adotada (`hold` sem efeito): falha em "its conversations wait sealed" e depois no mesmo tempo esgotado |
| `packages/web-member/test/blob.test.js` | 46 testes, 399 asserções (eram 43 e 364) | ver as três linhas abaixo |
| `blob.test.js`, "a copy source buys copy stamps in batches..." | 16 asserções | pedindo selo `blob` em vez de `copy`: falham 4 asserções (contagem de selos de cópia e "the daily blob allowance was never asked", "still no daily stamp") |
| `blob.test.js`, "a copy source whose weekly allowance ends..." | 11 asserções | sem marcar `exhausted` no `teto`: falham 8 asserções (mensagem do limite semanal, `exhausted`, `bought`) |
| `blob.test.js`, "a copy source on a seeder from before the copy kind..." | 8 asserções | sem a falha pegajosa (`failure = err`): falha em "the key is not asked again" |
| `apps/app/test/historyCopy.test.js` | 5/5 (40 asserções) | |
| `apps/app/test/help.test.js`, `platformGate.test.js`, `conversas*.test.js`, `legal.test.js` | passam | |

Revisão da PR 5 (correções, cada teste novo conferido sem a sua correção):

| Arquivo | Testes novos / contagem | Sem a correção |
|---|---|---|
| `packages/web-member/test/dm-copy-unit.test.js` | 4 testes, 37 asserções | `cleanRow` sem as checagens estritas (texto, hora ISO, `mine`, `peer`, bloqueio): falham 11 asserções do teste 1 e as 2 do teste 2; `checkLimits` vazio: falham 4 asserções do teste 4; a validação de `shownAt` (teste 3) não foi conferida removendo-a |
| `packages/web-member/test/dm-copy-e2e-2.test.js` | 2 testes, 27 asserções (~78 s) | Página vazia sem a correção do armazém vazio: estoura `copyImported` (P1); foto pagando com a cota diária: falham "no photo", "left out" e "not re-put"; sem `shownAt` na criação das linhas: falham "shown as on the maker" e "a received message too"; marcas de visto na ordem errada: falha "own marks stay last" |
| `packages/web-member/test/dm-copy-e2e-3.test.js` | 2 testes, 12 asserções (~88 s) | falha de pedaço tratada como final (sem `Soft`): falham 3 asserções do teste 1; aviso anotado depois do cursor: o teste 2 estoura `copyImported after unlock` |
| `packages/core/test/dm-fold.test.js` | 34 testes, 566 asserções (era 33) | sem `shownAt` na dobra: falham 2 asserções do teste novo |
| `packages/web-member/test/dm-copy-e2e.test.js` | asserção nova: o próprio aviso não busca nada | |
| `apps/app/test/historyCopy.test.js` | 5/5, 43 asserções | os textos novos (fotos de Página, cota de cópia, duração) falham sem a troca |

Revisão 2 (reexame de 88447b08): `shownAt` limitado ao relógio de quem importa; horizonte da importação guardado no pendente (e no armazém de Página retido) antes do primeiro bloco, para uma importação cortada continuar na mesma ordem; o texto reserva os selos da cota semanal antes das fotos (`copySource.reserve` e `stampsNeeded`), então as fotos nunca empurram o texto para a cota diária; `a.stores` só é gravado depois da checagem de partes; uma falha conta uma vez por `dm.pull`; o teste da cota semanal passou de 2 para 5 selos (o texto reserva 3 antes); o teste da Página mudou para `dm-copy-e2e-4.test.js`.

| Arquivo | Testes novos / contagem | Sem a correção |
|---|---|---|
| `packages/web-member/test/dm-copy-unit-2.test.js` | 6 testes, 31 asserções (~0,2 s) | sem o teto de `shownAt`: falham 3 asserções do teste 1; sem reaproveitar o horizonte: falham 5 do teste 2; sem a junção em `importAll`: falha "the second call gets the running job"; contando a falha por passagem: falha "three overlapping pulls, one failure"; `a.stores` gravado antes da checagem: falham 2 do teste 5 ("the retry is refused the same way", "and put nothing more") |
| `packages/web-member/test/dm-copy-e2e-4.test.js` | 2 testes, 29 asserções (~71 s) | sem a reserva (`a.held = []`): falham 3 asserções do teste 2 (fotos 3 em vez de 1, nenhuma de fora, carteira diária 12 em vez de 13) |
| `packages/web-member/test/dm-copy-e2e.test.js` | 2 testes, 33 asserções (~87 s; era 137 s) | |
| `packages/web-member/test/blob.test.js` | 47 testes, 405 asserções (era 46 e 399): `copySource.reserve` | |
| `apps/app/test/historyCopy.test.js` | 5/5, 43 asserções | o texto novo do aviso ("na data em que foram enviadas") |

Revisão 3 (reexame de 6a104269): a reserva dos selos do texto passou a ser feita em lotes de até 256, cada lote numa conexão própria, e `copySource.take` continua numa conexão nova quando o prazo de uma conexão que já comprou algo se esgota (uma recusa, o fim da cota ou uma conexão sem nenhum selo ainda encerra a fonte); entre os lotes a cópia confere o desbloqueio e emite `dm.copyProgress`. Um selo recusado como `invalido` ao enviar um pedaço ou o manifesto zera os selos guardados (`a.held`), para a nova tentativa comprar selos novos (`refusal` agora leva `reason`). As linhas importadas são arquivadas em `horizonte - span + n`, com `span` vindo dos índices do pacote (não das linhas que passam no filtro), então desbloquear um remetente entre uma importação cortada e a nova tentativa não repete um `filedAt`; um `n` de 200000 ou mais deixa de valer. Textos do app: singular e plural concordam ("ficou"/"ficaram", "Ela aparece ... foi enviada"). O texto sobre os selos de cópia no balde de emissão foi corrigido, e `docs/protocol.md` e `docs/rpc.md` descrevem os lotes.

| Arquivo | Testes novos / contagem | Sem a correção |
|---|---|---|
| `packages/web-member/test/blob.test.js` | 48 testes, 414 asserções (eram 47 e 405); novo: "a reserve larger than one stamp link goes on over new links, in batches..." (prazo de 1,5 s por conexão, 40 selos pedidos, lotes de 16) | com o `blob.js` da 6a104269: falham 4 asserções (volta com cerca de 13 selos, uma só conexão, sem chamadas entre lotes) |
| `packages/web-member/test/dm-copy-unit-2.test.js` | 13 testes, 70 asserções (eram 6 e 31; ~0,3 s) | selo guardado não zerado após `invalido`: falha 1 asserção em cada um dos dois testes (pedaço e manifesto); `filedAt` pela posição filtrada: falham 3 asserções do teste do desbloqueio; `stampsNeeded` sem `BLOB_MAC_BYTES`: falham 3 do teste da borda do pedaço; `readState` sem `horizons`: falha 1 do teste da retomada da loja própria (reinício com nova instância); `readPendMeta` sem `horizon`: falha 1 do teste da Página retida; o retorno do lote sem checar o desbloqueio: falha "the reservation goes on while unlocked and stops after a lock" |
| `apps/app/test/historyCopy.test.js` | 5/5, 44 asserções | os textos singulares novos |
| `packages/web-member/test/dm-copy-e2e.test.js`, `-2`, `-3`, `-4` | contagens iguais (33, 27, 12, 29) | |

Tempos (`node <arquivo>`, uma vez cada, esta máquina): `blob.test.js` ~57 s; `dm-copy-unit-2` 0,3 s; `dm-copy-unit` 0,1 s; `historyCopy` 0,03 s; `dm-copy-e2e` 74 s; `-2` 65 s; `-3` 73 s; `-4` 60 s.

Revisão 4 (reexame de b9b052dc): um bloqueio ou o desbloqueio (`stop`) passa por `take` e `reserve` até `buyCopyStamps`, que confere antes de cada selo e antes de cada conexão; um `take` interrompido termina como qualquer compra curta (falha simples, os selos comprados ficam e `reserve` os entrega), sem lançar em `reserve`. Cada lote da reserva é um passo do progresso (`total` = mensagens com foto + 2 + lotes; `done` sobe a cada lote e vira o número de lotes ao fim; uma nova tentativa que já guarda os selos não tem lote), e o primeiro evento sai antes da primeira compra. O `n` de toda linha crua com `n` válido é reservado antes do filtro (um bloqueio não passa o lugar a outra linha com o mesmo `n`). O lote da reserva tem no mínimo 1 selo. Os docs dizem "cortada (prazo, conexão perdida)" e registram o limite do `invalido`.

| Arquivo | Testes novos / contagem | Sem a correção |
|---|---|---|
| `packages/web-member/test/blob.test.js` | 51 testes, 445 asserções (eram 48 e 414; ~59 s) | sem a conferência de `stop` em `buyCopyStamps`: falham 4 (compra o lote inteiro, 40 emissões); sem ela no laço de `take`: falham 2 ("no link opened"); continuar depois de uma recusa (sem `!cut`): falham 6 do teste da recusa `ruim`; lote sem o mínimo de 1: falham 3 do teste do lote 0 ou fracionário (ele usa `between` para não girar sem fim) |
| `packages/web-member/test/dm-copy-unit-2.test.js` | 18 testes, 93 asserções (eram 13 e 70; ~0,35 s) | lotes fora do `total`: falham 3 (um em cada teste de progresso); lotes contados também na nova tentativa: falha 1; `stop` não passado a `reserve`: falham 4; `n` reservado só depois do filtro: falham 2 do teste do `n` repetido; `span` só das linhas filtradas: falham 3 do novo teste com a linha bloqueada no maior `n` (o caso do `n` 1 continua passando, como o reexame notou); sem o teto `n >= rows`: falham 3 |
| `packages/web-member/test/dm-copy-e2e.test.js` | 2 testes, 34 asserções (era 33; ~93 s) | |
| `apps/app/test/historyCopy.test.js`, `dm-copy-unit.test.js` | 5/5 44 e 4/4 37, iguais | |

A asserção de conexões do teste da reserva em lotes passou a usar um prazo de 1 s por conexão (cabem cerca de 12 selos), o que garante pelo menos 4 conexões para 40 selos em qualquer máquina.

Importação em um só trabalho: a remoção da junção em `importAll` não foi pega pelo teste 2 do `dm-copy-e2e-2` (a contagem de avisos continuou 1, porque o dedupe também a segura); o teste vale como regressão do resultado, não do mecanismo. O mecanismo (uma só tarefa, uma só leitura do registro) é coberto por `dm-copy-unit-2.test.js`, que falha sem a junção.

O seeder de teste do `blob.test.js` ganhou a opção `copyBudget` (nulo é um semeador de antes do tipo `copy`, que não responde). O teste do semeador antigo cobre a falha de `copySource` e o selo diário que passa a pagar o blob.

O `dm-copy-e2e-2` cobre a falha do selo `copy` no semeador real (o selo lança erro): fotos de fora, texto inteiro, descritor original intacto. Parte e manifesto ainda recuam para a cota diária nesse caso, para a cópia completar com um semeador antigo; só as fotos nunca gastam a cota diária. Com a cota semanal funcionando, o texto sai dela primeiro (reserva antes das fotos).

Depois do PR #707 (grupos de envelopes): o aviso da cópia vai para o grupo da própria caixa, a mesma para a qual é lacrado, e não sem grupo, que todo aparelho baixaria. `dm-copy-unit-2.test.js`, "the pointer is put in the bucket of the own box it is sealed to": 19 testes, 95 asserções (eram 18 e 93); com `link.put(bytes)` sem o grupo, falha a asserção "one put, tagged with the own bucket".

Limites conhecidos (não corrigidos de propósito):

- Se várias fotos de uma mensagem batem no limite no meio, todas contam como de fora.
- Selos de cópia comprados e não usados se perdem numa nova tentativa que falha antes de usá-los (uma nova tentativa na mesma sessão reaproveita os quadros e não compra outro).
- O ganho de custo do dedupe com `Set` na importação e a chamada de `checkLimits` dentro de `run` não têm teste de comportamento próprio (só pelo e2e e pelo teste unitário de `checkLimits`).
- Uma exclusão ou um bloqueio feito neste aparelho antes de um intervalo offline esconde as mensagens importadas que vieram depois dele (as linhas entram abaixo de tudo o que o aparelho tem).
- Os selos que sobram da reserva do texto (a estimativa leva um de folga por parte) se perdem; fica menos de uma parte por cópia.
- Se uma importação é cortada depois de arquivar as linhas e antes de gravar as marcas de visto, a nova tentativa pula as linhas já arquivadas e não regrava essas marcas.
- O pool responde `invalido` também por outros motivos (um selo gasto, uma repetição diferente), então essa recusa zera também selos guardados que ainda valiam; eles são comprados de novo, e o texto só recua para a cota diária se a cota semanal não bastar.
- Quem tem o segredo da caixa abre o histórico inteiro, e o aviso é lacrado só para a geração atual da caixa (ver `docs/protocol.md`, riscos residuais).

## Conferências no aparelho

Feito com a Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), no Android (emulador, build de debug), no simulador iOS (iPhone 17 Pro) e na web, nessa ordem: a linha "Copiar conversas para outro aparelho" aparece em Conversas, a folha mostra todos os textos (14 dias, cota semanal de fotos, 30 a 50 minutos) e o botão "Copiar agora"; o toque mostra "Preparando a cópia" e depois "método desconhecido" com "Tentar de novo", porque a Vitrine não roda o nó. Depois do merge da `main`, o teste de contrato da Vitrine exige uma resposta para todo método que o app usa: `dm.historyCopy` passou a recusar com "indisponível no modo vitrine", como os métodos de Página (`apps/app/test/vitrine.test.js`, 42 testes; sem a resposta, falham 2 asserções e o arquivo para). A folha mostra esse texto no lugar de "método desconhecido"; não conferido de novo no aparelho. Pendentes, com uma conta de passkey (#224):

- Copiar de um aparelho com fotos para um segundo aparelho da mesma passkey e abrir a conversa.
- Cota esgotada: texto inteiro, fotos mais antigas de fora, mensagem de resultado correta.
- Conversa apagada no aparelho de origem não aparece no destino.

## Operador

Implante o semeador antes do app. O semeador cria `copy-stamps.json` ao primeiro pedido de selo `copy`; sem ele, um app novo recua para a cota diária de blobs nos textos e deixa as fotos de fora (as fotos nunca usam a cota diária).

O selo `copy` é um selo de blob: 8192 por conta e semana, pagos pelo semeador. Dimensione `--blob-bytes` para isso: uma cópia completa de uma conta com muitas fotos consome essa cota inteira de blobs, e os selos de cópia têm o próprio balde de emissão (`issues.copy`). Qualquer conta admitida pode comprar os 8192 selos da semana sem fazer uma cópia: poucas contas bastam para encher o pool pela janela de retenção (dimensionamento do operador, #224).
