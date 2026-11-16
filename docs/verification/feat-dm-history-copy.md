# Copiar conversas para outro aparelho (feat/dm-history-copy, #351 item 5)

## Decisões

- Começa só por toque, no aparelho antigo. Leva texto e fotos guardadas (cache), lacrados com a chave da própria conta; todo aparelho da mesma passkey importa.
- Um aviso (inner v7, `from === to ===` dono) aponta para o manifesto, que aponta para os pedaços. Fotos viram blobs novos (chave nova); o blob original nunca é reaproveitado.
- Selo `copy`: um selo de blob com cota semanal própria (8192 por diário e semana de Brasília, `copy-stamps.json`). Semeador antigo não responde: texto e manifesto caem para a cota diária; fotos nunca.
- Importação: linhas entram abaixo de tudo o que o aparelho tem (como `legacyHorizon`), com dedupe (mensagem por remetente e id, ctl por id, reação por remetente e id). Marcas de visto importadas não disparam a sincronização de vistos.
- Conversa apagada no aparelho de origem fica fora (só linhas que a dobra ainda mostra, mais os ctl). Páginas: o armazém da Página entra no aparelho que a guarda; senão espera cifrado (kv `dmCopyPend`) até a Página ser adotada ou até a retenção.
- Resultado: `{ id, messages, photos, notCached, leftOut }`. Sem bump de Termos (texto atualizado na versão 67).

## O que muda

`packages/rpc` (inner v7, eventos, método), `packages/core` (v7, selo `copy`, cota semanal no semeador), `packages/web-member` (`dm-copy.js`, blob com `copySource`, kv, sessão), `apps/app` (linha e folha em Conversas, aviso de importação), docs (`protocol.md` seção 11, `rpc.md` 5.151, `design.md`), Termos e Política.

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

Importação em um só trabalho: a remoção da junção em `importAll` não foi pega pelo teste 2 do `dm-copy-e2e-2` (a contagem de avisos continuou 1, porque o dedupe também a segura); o teste vale como regressão do resultado, não do mecanismo. O mecanismo (uma só tarefa, uma só leitura do registro) é coberto por `dm-copy-unit-2.test.js`, que falha sem a junção.

O seeder de teste do `blob.test.js` ganhou a opção `copyBudget` (nulo é um semeador de antes do tipo `copy`, que não responde). O teste do semeador antigo cobre a falha de `copySource` e o selo diário que passa a pagar o blob.

O `dm-copy-e2e-2` cobre a falha do selo `copy` no semeador real (o selo lança erro): fotos de fora, texto inteiro, descritor original intacto. Parte e manifesto ainda recuam para a cota diária nesse caso, para a cópia completar com um semeador antigo; só as fotos nunca gastam a cota diária. Com a cota semanal funcionando, o texto sai dela primeiro (reserva antes das fotos).

Limites conhecidos (não corrigidos de propósito):

- Se várias fotos de uma mensagem batem no limite no meio, todas contam como de fora.
- Selos de cópia comprados e não usados se perdem numa nova tentativa que falha antes de usá-los (uma nova tentativa na mesma sessão reaproveita os quadros e não compra outro).
- O ganho de custo do dedupe com `Set` na importação e a chamada de `checkLimits` dentro de `run` não têm teste de comportamento próprio (só pelo e2e e pelo teste unitário de `checkLimits`).
- Uma exclusão ou um bloqueio feito neste aparelho antes de um intervalo offline esconde as mensagens importadas que vieram depois dele (as linhas entram abaixo de tudo o que o aparelho tem).
- Os selos que sobram da reserva do texto (a estimativa leva um de folga por parte) se perdem; fica menos de uma parte por cópia.
- Se uma importação é cortada depois de arquivar as linhas e antes de gravar as marcas de visto, a nova tentativa pula as linhas já arquivadas e não regrava essas marcas.
- Quem tem o segredo da caixa abre o histórico inteiro, e o aviso é lacrado só para a geração atual da caixa (ver `docs/protocol.md`, riscos residuais).

## Conferências no aparelho (pendentes)

- Copiar de um aparelho com fotos para um segundo aparelho da mesma passkey e abrir a conversa.
- Cota esgotada: texto inteiro, fotos mais antigas de fora, mensagem de resultado correta.
- Conversa apagada no aparelho de origem não aparece no destino.

## Operador

Implante o semeador antes do app. O semeador cria `copy-stamps.json` ao primeiro pedido de selo `copy`; sem ele, um app novo recua para a cota diária de blobs nos textos e deixa as fotos de fora (as fotos nunca usam a cota diária).

O selo `copy` é um selo de blob: 8192 por conta e semana, pagos pelo semeador. Dimensione `--blob-bytes` para isso: uma cópia completa de uma conta com muitas fotos consome essa cota inteira de blobs, e os avisos de cópia têm o próprio balde de emissão (`issues.copy`, o das emissões, não um balde de erros). Qualquer conta admitida pode comprar os 8192 selos da semana sem fazer uma cópia: poucas contas bastam para encher o pool pela janela de retenção (dimensionamento do operador, #224).
