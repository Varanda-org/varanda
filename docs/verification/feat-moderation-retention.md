# Retenção dos dados de moderação de uma conta excluída (branch feat/moderation-retention)

Parte da #31. Seis meses (180 dias) depois da exclusão de uma conta, o serviço de conta apaga os dados de moderação ligados a ela, e os Termos e a Política de Privacidade passam à versão 82.

## O que mudou

Seis rodadas (a implementação e cinco de correções da revisão) estão juntas aqui, refeitas sobre `origin/main@f050be63`, que já tem a limpeza da exclusão (#739) e as sobras da verificação por celular (#734).

- `apps/cli/lib/account/moderation-store.js`
  - Linha despida: uma denúncia pode ter a chave opcional `stripped` (data ISO canônica: o primeiro instante do mês UTC do expurgo, não o instante exato, para que junto da data de exclusão do diretório ela não aponte quem denunciou), com `reporter: null`, `text: ''`, `nonce: null` e `signature: null`. Ela é sempre decidida: `bloquear` mantém o trecho e o `anexo`; um registro (`bloquear` ou `descartar`) tem `quote: ''` e nenhum `anexo`. A validação recusa qualquer outra forma (o arquivo inteiro fica `indisponivel`, como antes). A versão do arquivo continua 3.
  - `deletedPlan(state, members, now)`: planeja todos os membros vencidos numa só leitura.
    - Uma chave conta como bloqueada se está na lista publicada ou se alguma mudança pendente a bloqueia. Um desbloqueio pendente não a libera, nem atrás de um bloqueio que o operador já puxou, então um cancelamento ainda encontra a prova.
    - Uma denúncia é sobre o membro só pelo `target`; o `writer` de um grupo não conta.
    - Sobre o membro: sai, salvo a decidida `bloquear` que sustenta o bloqueio de outra chave ainda bloqueada (um grupo), que fica, despida se quem denunciou também venceu.
    - Feita pelo membro sobre uma conta viva: a aberta sai; a `bloquear` cuja chave continua bloqueada é despida; qualquer outra decidida vira registro. Uma decidida que uma mudança pendente cita e que não sustenta bloqueio é despida se for `bloquear` e, se não, espera intacta (uma linha despida só guarda conteúdo como `bloquear`).
    - Uma linha despida cuja chave deixou de estar bloqueada vira registro, seja quem for que denunciou, salvo se uma mudança pendente a cita. Um registro sai com a conta denunciada.
    - Uma linha de menos de um dia (`DAY_MS`) espera, porque o limite diário de quem denuncia conta as linhas guardadas. Ela espera sozinha, com os eventos que a citam pelo `reportId`: qualquer membro vinculado pode denunciar qualquer chave todo dia, e uma linha recente que segurasse o membro manteria as outras linhas sobre ele, com trecho, anexo e observação, além dos 180 dias.
    - Enquanto uma linha sobre o membro espera o ack (citada por uma mudança pendente), as outras linhas e os eventos sobre ele esperam junto, para que um evento nunca fique citando uma linha que já saiu. Essa espera termina no ack do operador.
    - Uma linha que uma mudança pendente cita espera o ack (`humanReversed` continua lendo a ordem certa). Os eventos de decisão das linhas que ficam continuam.
  - `holdsDeleted(members)`: diz se há trabalho, pelas mesmas regras, mais a lista `forgetMedia`. Lista vazia ou chave inválida dão `pedido-invalido`, como em `forgetDeleted` (escolha de menor mudança: `deletedMembers()` só devolve chaves válidas, e as duas funções passam a recusar igual).
  - `revision()`: um contador que toda escrita incrementa.
  - `forgetDeleted(members, { revision })`: uma escrita que também lista, no campo opcional `forgetMedia` do arquivo, os anexos das linhas removidas ou transformadas em registro; depois dela, apaga esses arquivos (pula um id cuja linha voltou a ter `anexo`; arquivo ausente conta como apagado), sincroniza o diretório `report-media/` (se a sincronização falhar, a lista inteira fica) e uma segunda escrita limpa a lista ou guarda os ids que falharam, que a passagem seguinte termina. O resultado traz `filesLeft`, quantos ids continuam na lista. Nada é inferido da ausência: um `moderation.json` ausente ou antigo não apaga nenhum arquivo de `report-media/`. Se o contador mudou desde a leitura de quem chamou, não escreve nada e responde `stale: true`.
  - `reopen` recusa uma linha despida com `sem-permissao`.
  - Nunca mexe na lista publicada nem nas mudanças pendentes.
- `apps/cli/lib/account/deletion.js`
  - `MODERATION_RETENTION_MS` (180 dias) e `createModerationRetention`.
  - Vencidos são os membros com data de exclusão ISO canônica de 180 dias ou mais; data ausente, inválida ou fora do formato canônico nunca vence.
  - A passagem lê `revision()`, roda a varredura do celular (`beforeForget`) e chama `forgetDeleted` uma vez para todos; com `stale`, repete as três uma vez, e se ainda vier `stale` deixa para a próxima passagem (`moderacao-adiada`). Uma varredura do celular que falha tem código próprio (`moderacao-telefone-pendente`). A leitura do diretório também fica dentro do `try`: se falhar, o log é `moderacao-pendente`. Enquanto sobrar anexo na lista depois de uma passagem (um `unlink` que continua falhando), cada passagem registra `moderacao-anexo-pendente` com a contagem, para a falha não ficar em silêncio.
  - `createDeletionSweep` recebe `retention` e a espera depois do laço por membro.
  - Os logs levam só contagens (inclusive `records`).
- `apps/cli/lib/account/server.js`: monta a passagem com `beforeForget: () => phoneRoutes.sweepNow()` e a passa à varredura de exclusão.
- `apps/cli/lib/account/panel/app.js`: uma denúncia sem quem denunciou mostra "denunciada por: conta excluída" e, no Histórico, não oferece Reabrir.
- `apps/app/src/legal.js`, `packages/core/lib/terms.js`: Termos e Política na versão 82.
  - Termos, exclusão da conta: o prazo de 180 dias, ou logo depois da publicação da lista quando um bloqueio ainda espera; a denúncia de grupo que fica enquanto o grupo estiver bloqueado; a denúncia da pessoa que levou a um bloqueio que continua (de uma conta ou de um grupo) fica sem a chave, o comentário e a assinatura; as outras saem, e de uma já decidida sobre uma conta que ainda existe fica só um registro sem dados da pessoa.
  - Política: denúncias, imagem (inclui a denúncia que fica enquanto o grupo estiver bloqueado; registro sem conteúdo não guarda imagem), áudio, o resumo de retenção e o parágrafo da exclusão dizem o mesmo.
  - As páginas do site foram geradas de novo com `node apps/site/scripts/render-legal.js`.
- `docs/design.md` (tabela LGPD), `docs/protocol.md` (exclusão de conta) e o `README.md` ("Excluir conta") descrevem as mesmas regras: o que sai, o que é despido e o que vira registro.
- Testes: `apps/cli/test/moderation-store.test.js`, `account-delete.test.js`, `account-mod.test.js`, `panel.test.js`, `apps/app/test/legal.test.js` (resumo do texto e frases novas), `packages/core/test/terms.test.js` e `apps/site/test/legal.test.js` (versão 82).

## Como verificar

Cada arquivo rodado sozinho, a partir da raiz:

```sh
npm run lint
node apps/cli/test/moderation-store.test.js
node apps/cli/test/moderation-e2e.test.js
node apps/cli/test/account-delete.test.js
node apps/cli/test/account-mod.test.js
node apps/cli/test/account-phone.test.js
node apps/cli/test/account-phone-gates.test.js
node apps/cli/test/account-phone-e2e.test.js
node apps/cli/test/account-phone-cli.test.js
node apps/cli/test/account-phone-lookup.test.js
node apps/cli/test/account-phone-signup.test.js
node apps/cli/test/panel.test.js
node apps/cli/test/ai-worker.test.js
node apps/cli/test/dm-report.test.js
node apps/cli/test/mod.test.js
node apps/cli/test/mod-apply.test.js
node apps/cli/test/account-terms.test.js
node apps/cli/test/feira-routes.test.js
node apps/app/test/legal.test.js
node apps/app/test/termsCreate.test.js
node apps/app/test/terms-version.test.js
node packages/core/test/terms.test.js
node apps/site/test/legal.test.js
```

Resultado local, sobre `origin/main@f050be63`: todos passam (moderation-store 107/107, account-delete 32/32, account-mod 48/48, panel 73/73, ai-worker 44/44, ai-forget 8/8, dm-report 16/16, legal do app 57/57, terms-version do app 1/1, terms do core 8/8, legal do site 7/7).

## Testes conferidos sem a correção

Cada linha desfaz uma parte do código e roda o arquivo: o teste citado falha sem ela e passa com ela.

| Teste | Arquivo | O que prova | Sem a correção |
|---|---|---|---|
| `forgetDeleted: reports about the member, its appeals, events and anexos go; a report it filed against a key still blocked is stripped` | moderation-store | o expurgo completo, a linha despida que mantém o anexo e o bloqueio, os registros, a lista publicada e as pendências intactas, a segunda chamada sem escrita | sem despir, a linha some e o bloqueio perde a denúncia; com registros removidos ou com conteúdo, falha; com `holdsDeleted` sempre verdadeiro, falha "nada mais a fazer" |
| `forgetDeleted: a row a pending change names waits for the ack, and holds the other rows about the member` | moderation-store | a linha citada por uma mudança pendente espera o ack; uma linha mais antiga, descartada e não citada, sobre o mesmo membro espera junto com os eventos dela, e as duas saem depois do ack | sem adiar, o arquivo fica inválido; sem segurar os eventos, eles saem antes do ack; sem adiar as outras linhas do membro que espera, a descartada sai antes do ack |
| `forgetDeleted: a deferred row keeps the events about the member while its appeal goes in the same call` | moderation-store | o recurso sai na mesma chamada em que a linha espera | sem segurar os eventos, falha |
| `forgetDeleted: a row is about the member through its target only, never its group writer` | moderation-store | uma denúncia de um alvo vivo, bloqueado ou não, cujo escritor venceu, fica com o anexo e os eventos | com o `writer` contando, a linha sai |
| `forgetDeleted: a group block about the member stays while the group is published or a pending change blocks it; a cancelled unblock finds it` | moderation-store | a denúncia de grupo fica com o desbloqueio na fila; cancelado o desbloqueio, a linha, o anexo e os eventos estão lá; sai depois do ack do desbloqueio | olhando só o conjunto líquido (lista publicada mais pendentes, sem a lista publicada), sai com o desbloqueio na fila |
| `forgetDeleted: a kept row whose reporter is due too is stripped, whatever the order of the members` | moderation-store | a linha que fica é despida quando quem denunciou também venceu, nas duas ordens | sem despir, os dados de quem denunciou ficam |
| `forgetDeleted: a decided report the member filed about a live target becomes a record; decidedBefore still sees it` | moderation-store | a aberta sai, a decidida vira registro sem trecho nem anexo, o arquivo do anexo some, `exportRows` ainda mostra a decisão | removendo em vez de registrar, falha; com o anexo guardado, o arquivo fica |
| `forgetDeleted: a block the member filed whose key is no longer blocked becomes a record, without its anexo; humanReversed still holds` | moderation-store | o desbloqueio é do próprio operador (ack sem mudança do painel), então só a regra da linha bloqueada responde `humanReversed`; o registro `dm` relê do disco | sem a regra (c) de `humanReversed`, falha; sem `!stripped` na validação `dm`, a releitura falha |
| `forgetDeleted: a stripped row becomes a record once its key is no longer blocked, never on a pending unblock` | moderation-store | a linha despida espera o ack do desbloqueio; um cancelamento a mantém intacta; depois do ack vira registro, que relê do disco | sem a regra, a linha despida guarda o trecho e o anexo para sempre |
| `forgetDeleted: a row filed less than a day ago waits, so the daily reporter budget holds` | moderation-store | 20 denúncias, a varredura, e a 21ª recebe `limite-denuncias` | sem a espera, a 21ª passa |
| `forgetDeleted: several members in one write` | moderation-store | uma só escrita para vários membros; lista vazia ou chave inválida recusadas por `holdsDeleted` e por `forgetDeleted` | com `holdsDeleted` filtrando, falha |
| `forgetDeleted: a write since the caller read revision() makes it stale, with nothing written` | moderation-store | um add, uma decisão ou um ack entre a leitura e a chamada dão `stale` sem escrita | sem a checagem, a chamada escreve |
| `reopen: a stripped row cannot reopen (an open report needs its reporter)` | moderation-store | `sem-permissao`, nada escrito | sem a recusa, a linha volta a `aberta` sem quem denunciou |
| `forgetDeleted: an anexo whose unlink failed after the write is listed on disk and removed by the next call` | moderation-store | `unlinkSync` falha uma vez (EIO): o id fica em `forgetMedia` no disco, a reabertura e a chamada seguinte apagam o arquivo e limpam a lista; um `forgetMedia` inválido deixa o arquivo `indisponivel` | sem gravar a lista, o arquivo fica; sem a validação, o arquivo adulterado abre; com `holdsDeleted` ignorando a lista, falha |
| `forgetDeleted: a listed file already gone (a crash before the clearing write) clears from the list` | moderation-store | um id listado cujo arquivo já sumiu sai da lista, e `holdsDeleted` passa a falso | tratando `ENOENT` como falha, a lista fica para sempre |
| `forgetDeleted: a failed sync of report-media after the unlinks keeps the list for the next pass` | moderation-store | o `unlink` roda, a sincronização do diretório falha, o id continua listado; a passagem seguinte sincroniza e limpa | sem a sincronização, a lista sai antes de o apagamento ser durável |
| `forgetDeleted: a missing or older moderation.json never deletes a file in report-media` | moderation-store | com o arquivo ausente ou antigo, um anexo que nenhuma linha cita fica; um id listado cuja linha tem anexo fica | inferindo da ausência (a busca de órfãos antiga), os arquivos somem; sem pular a linha com anexo, ele some |
| `forgetDeleted: a stripped row is dated by the month of the sweep` | moderation-store | `2027-01-31T23:59:59.999Z` vira `2027-01-01T00:00:00.000Z` | com o instante exato, falha (e falha o teste principal) |
| `forgetDeleted: a pending unblock behind a claimed block keeps the evidence, named or not` | moderation-store | decidir, puxar (bloqueio reivindicado), decidir de novo (`ja-bloqueada`, linha não citada), desbloquear, expurgar, cancelar: o trecho, o anexo e o arquivo ficam, no caminho despido e no de grupo | olhando o conjunto líquido, as linhas viram registro ou saem |
| `forgetDeleted: a dismissed row the member filed that a pending block still names waits as it is` | moderation-store | bloqueio da IA, reaberto e descartado por uma pessoa, ainda citado pelo bloqueio pendente: espera intacto, vira registro depois do ack | sem esperar, vira registro antes do ack |
| `forgetDeleted: a stripped row, or a block of a due reporter, that a pending change names keeps its content` | moderation-store | uma mudança pendente (gravada no disco) cita uma linha despida e uma `bloquear` de quem venceu, sem bloquear as chaves delas: a despida fica como está, a outra é despida com trecho e anexo | sem cada checagem, a linha vira registro |
| `forgetDeleted: a recent row about the member waits alone, with its own events` | moderation-store | uma denúncia recente sobre o membro fica com os eventos dela; a mais antiga e os eventos sobre o membro saem na mesma passagem; no dia seguinte a recente sai com os eventos dela | com a espera da rodada 4 (a recente segurando o membro), a antiga fica; pondo a recente no mapa das removidas, os eventos dela saem |
| `forgetDeleted: a fresh report about a due member before every pass never holds the older rows` | moderation-store | uma denúncia nova sobre o membro antes de cada uma de três passagens, um dia entre elas: as antigas, os arquivos de anexo e os eventos saem na primeira, e cada passagem leva a nova do dia anterior | com a espera da rodada 4, as antigas, os anexos e os eventos ficam em todas as passagens |
| `forgetDeleted: a record leaves with its target` | moderation-store | o registro sai quando o alvo vence | ignorando linhas despidas no alvo, o registro fica |
| `forgetDeleted: the events of an open row the member filed go with it` | moderation-store | uma decisão da IA reaberta (linha aberta, eventos com `reportId`) sai com os eventos | sem mapear a linha removida, os eventos ficam |
| `a stripped row on disk must be a decided row without reporter, comment, nonce or signature; only a block keeps content` | moderation-store | a validação recusa uma linha despida fora da forma (aberta, descartada com trecho, com anexo) e aceita um registro | sem a validação, o arquivo adulterado abre; recusando o registro `descartar`, o arquivo fica `indisponivel` |
| `deletion sweep: the moderation data of a deleted key goes 180 days after the deletion, not a day sooner` | account-delete | o prazo exato, a varredura do celular antes, o formato do log, nenhuma segunda passagem | com outro corte, falha aos 179 dias; sem `retention` na varredura, nada sai |
| `moderation retention: a failing phone sweep skips the pass; a failing desk is counted as pending` | account-delete | sem lacre escrito, nada sai; a falha do celular tem código próprio; um diretório que lança é registrado, sem lançar | sem `beforeForget`, a denúncia sai; com `moderacao-adiada` no lugar do código novo, falha; com a leitura do diretório fora do `try`, a passagem lança |
| `moderation retention: an anexo whose unlink keeps failing is logged with its count every pass` | account-delete | com `EACCES`, a linha sai, o arquivo fica, e cada passagem registra `moderacao-anexo-pendente` com `count: 1`, sem id; quando o `unlink` volta a funcionar, o arquivo sai e a linha para | sem a linha de log, a falha não aparece |
| `deletion sweep: a retention pass that throws never fails the sweep` | account-delete | a varredura termina com o resultado de sempre | sem o `try` em volta de `retention`, a varredura rejeita |
| `moderation retention: a block acked late burns the number before its report goes` | account-delete | com o armazenamento real de celulares, o número é lacrado antes de a denúncia sair | sem `beforeForget`, o número nunca é lacrado |
| `moderation retention: an ack between the phone sweep and the purge makes it sweep again first` | account-delete | a corrida: o ack chega entre a varredura do celular e o expurgo, a passagem repete a varredura e o número é lacrado | sem `stale` ou sem a segunda tentativa, nenhum lacre |
| `moderation retention: a decision during the phone sweep makes the purge stale, and the pass sweeps again` | account-delete | uma decisão durante a varredura do celular dá `stale`, e a passagem varre de novo | sem a checagem no armazenamento, ou lendo o contador depois da varredura, a chamada escreve na primeira tentativa |
| `moderation retention: stale twice leaves the member to the next pass` | account-delete | uma só repetição, nada escrito | sem a checagem, a chamada escreve |
| `moderation retention: an absent, invalid or non-canonical deletion date is never due; due members go in one call` | account-delete | data ausente, inválida ou não canônica (`2025-01-01`) nunca vence; uma chamada com todos os vencidos | sem `isCanonicalIso`, a data curta vence |
| `Excluir conta: on the server, a block acked late burns the number from its reports before the 180-day pass removes them` | account-delete | com o `server.js` real e o armazenamento de celulares real: a conta é excluída com o bloqueio pendente, o ack chega uma hora antes dos 180 dias, e a varredura de exclusão lacra o número (por `burnable(m, since)`, que numa chave excluída depende de `blockReportsAfter`) antes de a denúncia sair; o lacre continua na passagem seguinte | sem `beforeForget` no `server.js`, ou com a varredura do celular depois do expurgo em `deletion.js`, o número não é lacrado |
| `Excluir conta: the server wires the retention pass into the sweep, after a phone sweep` | account-delete | `server.js` liga a passagem à varredura e passa a varredura do celular | sem a linha `retention`, nada sai; sem `beforeForget`, não há varredura extra |
| `a report stripped of its deleted reporter is listed with no reporter and still holds the block` | account-mod | a API lista a linha sem chave, @nome nem comentário, e o bloqueio continua apoiado nela | (rodada 1, conferido junto com o expurgo) |
| `Reabrir on an AI block stripped of its deleted reporter is refused with sem-permissao` | account-mod | a rota responde 403 `sem-permissao` e a linha continua decidida | sem a recusa, a rota reabre a linha |
| `Histórico: a report kept without its deleted reporter says "conta excluída" and offers no Reabrir` | panel | duas linhas que o armazenamento produz (uma `bloquear` despida e um registro `descartar`), o texto e o botão escondido | sem a linha no Histórico, falha |

## Implantação

- O `moderation.json` já está na versão 3 na `main`, e esta branch não muda a versão. O que muda é a forma de uma linha: a primeira passagem que despe uma denúncia ou grava um registro grava uma linha com `stripped` e `reporter: null` (um registro também com `quote: ''` e sem `anexo`, e pode ter estado `descartar`).
- Um binário anterior (o da `main`, `origin/main@f050be63`) confere cada denúncia com `exactKeys(r, REPORT_KEYS)` (ou `REPORT_KEYS_DM`) e exige a chave de quem denunciou. Nenhuma linha despida passa, seja `bloquear` ou registro, nem um arquivo com `forgetMedia` (a chave de topo não está na lista dele), e o arquivo inteiro fica `indisponivel` ao abrir: toda chamada do painel, das denúncias, dos recursos e de `mod pull`/`ack` responde `indisponivel`, e o binário nunca reescreve o arquivo. Falha fechada, sem perda de dados.
- Voltar a um binário anterior depois de uma linha despida exige uma destas saídas: ficar no binário novo, ou repor uma cópia do `moderation.json` feita pelo operador antes da atualização (perde o que entrou desde então). Antes da primeira linha despida, voltar não tem efeito no arquivo.
- A primeira passagem roda no início do serviço e depois de hora em hora. Se já houver exclusões com mais de 180 dias, o expurgo delas acontece nessa primeira passagem.

## Não verificado / limites

- Esta branch acrescenta aos Termos e à Política a frase sobre as cópias da triagem com IA; o código que as apaga na exclusão veio com a #739 (`apps/cli/lib/account/ai/forget.js` e `forgetMember` do worker: leituras e marcas das denúncias sobre a conta e os precedentes cujo alvo é ela). Uma cópia `triage.json.corrupt-<ms>` (ou do registro de marcas) que a triagem pôs de lado numa partida anterior não é apagada pelo serviço: o operador a remove à mão, como o README, o `docs/protocol.md`, os Termos e a Política dizem.
- Uma denúncia que uma pessoa reabriu de uma decisão da IA e deixou aberta até quem denunciou vencer sai com a marca `reopened`; depois de reiniciar o serviço, a IA pode decidir uma nova denúncia daquela publicação. Além disso, a regra (c) de `humanReversed`, na segunda parte (linha reaberta de um `bloquear` da IA), deixa de ver essa linha: depois que os eventos passam do teto e saem, a IA pode bloquear de novo aquele alvo.
- Recursos de um membro cuja linha espera o ack saem na hora, mas os eventos deles ficam até o ack, citando um `appealId` que já não existe. Os eventos não conferem o `appealId`, então o arquivo continua válido.
- Um registro guarda o alvo, a publicação, o motivo escolhido (`reason`, da lista fixa), a decisão, quem decidiu e a observação do moderador (`note`): nada disso é dado de quem denunciou.
- Com escritas constantes no armazenamento (muitas denúncias ou decisões por hora), o contador pode mudar a cada tentativa, e o expurgo fica para a próxima passagem (`moderacao-adiada`) até um intervalo sem escrita.
- A recusa de Reabrir numa linha despida usa `sem-permissao`, que o painel mostra como "Só uma decisão da IA pode ser reaberta." O painel já não oferece o botão nesse caso, então a frase só aparece numa chamada direta à API.
- O texto dos Termos e da Política ainda não foi conferido num aparelho.
- O expurgo só acontece na varredura de exclusão (no início e de hora em hora), não no momento exato em que os 180 dias se completam.
