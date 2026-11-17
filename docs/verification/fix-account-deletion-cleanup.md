# Limpeza da exclusão de conta (branch fix/account-deletion-cleanup)

Parte da #31. Rastros de uma conta excluída que ficavam no serviço de conta, no semeador e no nó do navegador.

## O que mudou

- `apps/cli/lib/account/pages-store.js`: `holdsMember` e `forgetMember`. Em cada página, apaga o convite que esperava pela pessoa (com a parte da chave lacrada para ela), a oferta de propriedade para ela, a parte em `dm.pending`, a parte dela numa troca de chave ainda não promovida (`dm.rotatePending.shares`) e as linhas de delegado em que ela é ator ou diário. Ficam `owner`, `admins`, a lista assinada e as partes atuais (`dm.shares`), até o dono remover a chave.
- `apps/cli/lib/account/pages-routes.js`: `holdsInvites` e `forgetInvites` para `page-invite-rosters.json`; `saveInvites` só tira as linhas da memória depois de gravar. Um arquivo ausente vale como vazio; um arquivo ilegível, com JSON inválido ou com formato errado faz `holdsInvites` falhar e o aviso da varredura nomear `page-invite-rosters.json`, sem mexer no arquivo, até uma gravação bem-sucedida regravá-lo a partir da memória. Uma gravação que falhou (também ao aceitar um convite) é tentada de novo por `holdsInvites` antes de responder; se falhar outra vez, a purga fica pendente.
- `apps/cli/lib/account/pages-groups.js`: `pages-replicas` é esvaziado a cada partida (só guarda cópias de núcleos públicos). Cada cópia lembra o diário a que pertence (o do cabeçalho assinado, para um escritor de grupo); a de uma chave bloqueada, ou de um escritor cujo diário foi bloqueado, sai quando ninguém a usa e não volta a ser aberta. `purgeBlocked` roda a cada passagem da varredura de exclusão. Uma purga que falha numa chave bloqueada não conta como feita: a passagem seguinte tenta de novo, sem precisar abrir a cópia, e o log registra só a quantidade de falhas, nunca a chave.
- `apps/cli/lib/account/ai/ledger.js`, `exemplar-store.js`, `worker.js`: `holdsTarget`/`forgetTarget` e `forgetMember`/`holdsMember`. Saem as leituras (texto e vetor) e as marcas das denúncias contra a chave, num novo snapshot (o registro de marcas não as traz de volta), e todo precedente com ela como alvo, de qualquer modelo. O worker não lê, não marca e não aprende com denúncia contra essa chave. Se um dos dois arquivos falha, o worker apaga mesmo assim o que estiver no outro, para essa pessoa e para as seguintes do mesmo lote, e `holdsMember` responde que ainda guarda a pessoa quando um arquivo que respondeu ainda a guarda; só falha quando nenhum a guarda e algum não respondeu.
- `apps/cli/lib/account/ai/forget.js` (novo): com a triagem desligada ou sem conseguir iniciar, a varredura apaga o que uma execução anterior deixou, sem carregar o modelo, sem criar arquivo que não existe e sem pôr nenhum de lado. O registro abre no modo estrito (`openLedger(dir, { strict: true })`): um `triage.json`, registro de marcas ou `exemplars.json` ilegível deixa a purga pendente e o aviso nomeia o arquivo. O worker também informa o arquivo que não responde (`brokenFiles()`).
- `apps/cli/lib/account/moderation-store.js`: `isBlocked(member)` e `reportIdsAbout(member)`, calculados uma vez por versão da lista publicada e das denúncias, para os clientes de páginas e a varredura não percorrerem tudo a cada chamada.
- `apps/cli/lib/account/deletion.js`, `server.js`, `commands/account.js`: passos `paginas`, `convites-pagina` e `triagem`, e o gancho `tick`.
- `packages/core/lib/seeder.js`: ao adotar uma lista e na partida, o semeador apaga a linha de cada diário bloqueado em `dm-stamps.json`, `blob-stamps.json` e `copy-stamps.json`; regrava um arquivo só quando ele tinha uma dessas linhas.
- `packages/web-member/lib/node-store.js`, `sync.js`: a varredura de bloqueados apaga o bloco 0 guardado em kv `groupCerts` de um diário bloqueado.
- `docs/protocol.md` ("Account deletion", estampas do semeador, kv `groupCerts`) e `README.md` ("Excluir conta").

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-store.test.js
node apps/cli/test/account-delete.test.js
node apps/cli/test/pages-groups.test.js
node apps/cli/test/ai-ledger.test.js
node apps/cli/test/ai-exemplar-store.test.js
node apps/cli/test/ai-worker.test.js
node apps/cli/test/ai-forget.test.js
node apps/cli/test/moderation-store.test.js
node apps/cli/test/account-pages-groups.test.js
node apps/cli/test/account-pages.test.js
node packages/core/test/seeder-dm.test.js
node packages/web-member/test/blocklist.test.js
```

Cada teste novo falha sem a mudança correspondente (conferido desfazendo cada uma):

- `pages-store.test.js`: `forgetMember` apaga convite, oferta, partes pendentes e linhas de delegado, e mantém a lista assinada.
- `account-delete.test.js`: de ponta a ponta, uma administradora excluída de uma página de outra pessoa, as linhas de `page-invite-rosters.json`, o registro, os precedentes e o worker reais, conferidos de novo depois de reabrir; um `pages.json` que falha uma vez é concluído na varredura seguinte; um `page-invite-rosters.json` corrompido deixa a purga pendente, é nomeado no aviso e fica byte a byte igual; com a triagem desligada, as cópias de uma execução anterior saem na hora e nenhum arquivo é criado num diretório vazio.
- `pages-groups.test.js`: o esvaziamento na partida; `purgeBlocked`; uma purga que falha uma vez numa chave bloqueada não é contada e a passagem seguinte a conclui; a cópia de um escritor de grupo de um diário bloqueado sai com o diário (com semeador real) e não é reaberta.
- `ai-ledger.test.js`, `ai-exemplar-store.test.js`, `ai-worker.test.js`, `ai-forget.test.js`: cada `forget` apaga só o alvo, e nada volta do registro de marcas. Um `triage.json` ou registro de marcas corrompido faz a purga falhar, é nomeado e fica byte a byte igual; um registro de marcas sem `triage.json` não guarda nada e não cria `triage.json`; a abertura estrita não muda nada no disco; o worker nomeia o arquivo que não responde até ele voltar; com o registro falhando, os precedentes da pessoa saem de `exemplars.json`, inclusive os de outra pessoa do mesmo lote, e `holdsMember` responde que ainda a guarda enquanto `exemplars.json` a guarda.
- `moderation-store.test.js`: `isBlocked` e `reportIdsAbout` acompanham cada mudança (denúncia nova, bloqueio pendente que não conta, ack, desbloqueio, reabertura) e concordam com `blocked()`.
- `account-pages.test.js`: uma gravação de `page-invite-rosters.json` que falha ao aceitar um convite deixa a linha no disco; a varredura de exclusão tenta gravar de novo, fica pendente enquanto falha e, quando a gravação volta a funcionar, a linha sai do disco.
- `seeder-dm.test.js`: as linhas de um diário bloqueado saem dos três arquivos de estampas na adoção (em memória, no disco e depois de reiniciar) e na partida, e as dos outros diários ficam.
- `web-member/test/blocklist.test.js`: o bloco 0 de um diário de vínculo bloqueado sai de kv `groupCerts` na adoção e na varredura da partida.

## Não verificado / limites conhecidos

- Nenhum aparelho: a mudança não toca tela.
- O `group-certs.json` do nó do core continua sendo podado só na partida (entradas que nenhum núcleo guardado nomeia).
- Uma cópia `triage.json.corrupt-<ms>` (ou do registro de marcas) que a triagem pôs de lado numa partida anterior não é apagada: o operador a remove à mão (item na #224).
- O semeador só apaga as linhas de estampas depois que a lista com o bloqueio chega a ele; até lá, ficam como as de qualquer diário. Um tipo de estampa desligado no semeador (sem `dm` ou sem `blobPostage`) não tem o arquivo lido nem podado: as linhas que uma configuração anterior deixou ficam até o tipo voltar a ser ligado.
- Uma gravação da chave de conversas da página (`pages-dm.js`) que já estava em andamento quando a conta foi excluída pode regravar a parte pendente da pessoa (`dm.pending`) logo depois do `forgetMember`; a varredura seguinte, em até uma hora, apaga de novo.
- A oferta de propriedade para a pessoa sai de `pages.json`, mas o diário da página continua mostrando o `page-offer` até ele expirar (no máximo 7 dias); ninguém consegue aceitá-la, porque aceitar exige uma conta vinculada.
- Marcas da triagem de denúncias que já saíram de `moderation.json` não são encontradas pelo id; elas guardam só o id e um código, sem texto nem chave.
