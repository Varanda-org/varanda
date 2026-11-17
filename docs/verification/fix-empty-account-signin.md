# Entrar com uma passkey que não abre nenhuma conta (branch fix/empty-account-signin)

Parte da #444, itens 5 e 6. Antes, num aparelho sem diário, uma passkey antiga do Varanda abria um diário vazio sem aviso, e uma passkey extra (marcada) cujo gerenciador de senhas não devolve o identificador do usuário, num aparelho onde ela não está ligada, abria uma conta separada e vazia.

## O que muda

- Num endereço com serviço de conta, o app passa `check: true` a `identity.unlock`. Uma credencial sem identificador, que não é a ligada ao aparelho nem conhecida como marcada, volta como `{ check: true, publicKey, lookupId }` sem instalar nada; o nó guarda a saída do PRF por no máximo 120 s. Tabela completa em `docs/protocol.md`, "Web member storage (B2)".
- O app lê `/account/status` da `publicKey`. Ligada, excluída, Página ou status ilegível: `identity.unlockDirect()` instala como antes, sem consulta e sem cartão. Sem conta: `POST /account/recovery/fetch` com o `lookupId`. Entrada achada: `identity.unlockWrapped` abre a conta do membro (no app nativo, o registro fica ligado com o identificador marcado sintético). O 404 marcado, qualquer outra falha da consulta ou um blob que não abre: instalação direta e o cartão, se o aparelho não tinha diário.
- Passkey com identificador não marcado (a original): depois de instalar, se o aparelho não tinha diário e o status diz sem conta e não excluída, o cartão aparece. Status ilegível não muda nada.
- O cartão "Esta passkey não abriu nenhuma conta" aparece antes da configuração. "Entrar com outra passkey" esquece neste aparelho a identidade que acabou de abrir (pela mesma limpeza do "Esquecer") e abre Entrar com qualquer passkey; na web, se o toque já não vale como ativação, a lista de passkeys fica para o próximo toque. "Criar conta com ela" segue como antes.
- Num aparelho que ainda não aceitou os Termos nesta carga da página (o caso de um aparelho novo), o cartão também vem antes dos Termos: a chave do cartão fica no contexto compartilhado da passkey (`apps/app/src/node.js`, `emptyCard`), e `recoverView` (`apps/app/src/termsCreate.js`) deixa a tela do cartão no lugar da abertura da recuperação e do portão. Antes, a abertura ficava 15 s, depois vinham os Termos e, depois do aceite, "Buscando sua conta..." sem botões. "Criar conta com ela" tira o cartão, e a espera de 15 s da recuperação recomeça daí, como depois de um Entrar comum; em seguida, os Termos e a configuração.
- O que vai ao serviço, só num endereço com serviço de conta: a chave pública do diário (`publicKey`) na leitura de `/account/status` e, só depois de o status dizer que a chave não tem conta, o `lookupId`. A saída do PRF, a chave secreta e a chave de embrulho não saem do aparelho.
- A saída do PRF guardada tem prazo de 120 s nas duas plataformas (no app nativo, um temporizador a zera); uma recusa ao abrir a entrada a descarta na hora (`cancelRecovery`).
- O cartão só aparece para a identidade que o levantou (desbloqueada, com essa chave ou ainda sem diário); outra entrada bem-sucedida o apaga. Uma falha ao esquecer mantém o cartão com o erro. Cancelar a lista aberta pelo cartão não mostra o aviso de passkey perdida. Depois de "recomeçar" por um MISMATCH de criação (Criar ou o "concluir" dela, não a recuperação por código), a primeira entrada bem-sucedida segue sem o cartão; uma entrada que falha encerra essa exceção. Ela vale pela ordem, não pela passkey: se essa primeira entrada for com outra passkey sem conta, o cartão também não aparece.
- Status ilegível (serviço fora do ar ou sem resposta) fica como antes desta mudança: a instalação direta liga a passkey ao aparelho como uma passkey comum, e as próximas entradas nele não consultam o serviço de novo, até "Esquecer" ou "recomeçar". Se ela era uma passkey extra de outra conta, essa conta continua aberta pelas outras passkeys e pelo código de recuperação.
- Sem serviço de conta (configuração manual), nada muda.
- RPC: `identity.recoveryLookup` (5.91) aceita `withKey` (só kind `'passkey'`) e devolve também a `publicKey`; novo controle do handle `identity.unlockDirect()`; `docs/rpc.md` 5.91 e seção 11.

## Testes automáticos

Da raiz, um arquivo por vez (Node 24):

- `node packages/web-member/test/web-node-recovery.test.js`: 20 testes, 298 asserções, passam. Novos: "check: an unknown passkey without a handle is held for the hosted app, which picks the blob or the direct install" e "check: a cancelRecovery right after the wrap key is held arms no PRF copy".
- `node apps/app/test/identityRecoveryNative.test.js`: 39 testes, 235 asserções, passam. Novos: "check: no handle and not known on a hosted app: held, then the member blob or the direct install", "check: an expired held PRF output is zero-filled by unlockDirect" e "check: the held PRF output is dropped and zero-filled by its 120 s timer".
- `node apps/app/test/identityInstall.test.js`: 304 asserções, passam. Novo: "recoveryLookup withKey also names the diary key of a passkey PRF, and installs nothing".
- `node apps/app/test/emptyAccount.test.js`: 14 testes, 104 asserções, passam (arquivo novo: a tabela de decisão, com o cartão depois de uma consulta que falha ou de um blob que não abre, `emptyCardShown`, `emptyKeyOf`, os dois botões e a ligação no provedor e na tela). Novo: "wiring: the card lives in the shared passkey context, so the shell renders it before the Termos gate".
- `node apps/app/test/termsCreate.test.js`: 18 testes, 184 asserções, passam. Novo: "recoverView: the empty card is rendered instead of the splash or the gate" (o cartão da identidade desbloqueada: nem abertura nem portão; sem cartão, a abertura e o portão como antes; o cartão de outra identidade não conta). A tabela de `recoverView` e a checagem de fonte de `gateDecision` foram ajustadas.
- `node packages/rpc/test/methods.test.js`: 7516 asserções, passam (`withKey` aceito com passkey, recusado com code ou não booleano).
- `node packages/web-member/test/resume.test.js` (7 testes) e `node packages/web-member/test/node-bundle.test.js` (2 testes): passam, com `unlockDirect` na lista de chaves do handle.
- Também passam, sozinhos: `passkey`, `passkeysScreen`, `requestQueue`, `platformGate`, `sessionStoreNative`, `recovery`, `accountDeletion` e os testes do app que leem o código das telas.
- `npx standard` nos arquivos alterados: sem apontamentos.

## Falha sem a correção

- Sem a linha que desvia para `holdCheck` no nó do navegador, `web-node-recovery` falha ("its own key and its added-passkey lookup id", "nothing installed yet").
- Sem a linha que desvia para `lookupCheck` no app nativo, `identityRecoveryNative` falha ("should deep equal").
- Com o ramo comum de `settleSignIn` devolvendo o resultado sem a marca, `emptyAccount` falha em "a plain sign-in: empty only for a key new here without an account" (9/10 testes).
- Com `unlockDirect` só anulando a entrada vencida (sem zerar), `identityRecoveryNative` falha em "check: an expired held PRF output is zero-filled by unlockDirect" (38/39 testes, 233/235 asserções).
- Sem o temporizador de 120 s no app nativo, `identityRecoveryNative` falha na asserção 1 de "check: the held PRF output is dropped and zero-filled by its 120 s timer" ("one timer armed for the held output") e para ali.
- Sem a checagem depois de `hold()` em `holdCheck`, `web-node-recovery` falha em "check: a cancelRecovery right after the wrap key is held arms no PRF copy" (19/20 testes, 295/298 asserções: a entrada resolve e `unlockDirect` instala).
- Com `emptyCardShown` olhando só se há chave, `emptyAccount` falha em "the card shows only for the identity it was raised for" (12/13 testes, 85/89 asserções, antes das checagens de fonte novas).
- Com a consulta que falha e o blob que não abre voltando a `direct()` sem a marca, `emptyAccount` falha em "no handle, key free, the lookup fails or the blob does not open: the direct install gets the card" (12/13 testes, 87/89 asserções, idem).
- Com `recoverView` como antes (sem a entrada `card`), `termsCreate` falha em "recoverView: the empty card is rendered instead of the splash or the gate" e na tabela, que agora espera a chave `card` (16/18 testes, 156/184 asserções).
- Com o `App.js` de antes, `emptyAccount` falha no teste novo de ligação (13/14 testes, 100/104 asserções) e `termsCreate` na checagem de fonte do `gateDecision` (17/18 testes, 182/184 asserções).
- Sem a linha que apaga o cartão a cada troca de identidade em `passkeyOp`, `emptyAccount` falha em "a sign-in, lock, sign-out or reset clears it" (13/14 testes, 103/104 asserções).
- Com o cartão de volta no estado local do `Identidade`, `emptyAccount` falha nos dois testes de ligação (12/14 testes, 99/104 asserções).

O código foi restaurado depois de cada prova.

## Conferência manual

Web, em 17/11/2026: Chrome headless (157) dirigido pelo protocolo do DevTools, com autenticador virtual WebAuthn (ctap2, PRF, BE/BS ligados), contra o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`) servindo esta árvore. Um "aparelho limpo" é a mesma aba depois de apagar todos os dados da origem (uma credencial importada noutro perfil não traz o segredo do PRF no Chrome), e a passkey que responde é escolhida pela lista de permitidas quando o app manda a lista vazia, no lugar do seletor de contas.

- [x] Aparelho limpo, sem Termos aceitos, Entrar com uma passkey antiga sem conta: o cartão aparece em menos de meio segundo, sem a espera da tela de abertura e sem os Termos antes dele. "Criar conta com ela" mostra os Termos e, depois de aceitar, "Confirme seu celular".
- [x] "Entrar com outra passkey" pede a passkey no mesmo toque, e a passkey de uma conta ligada abre essa conta, sem cartão e sem os Termos de novo.
- [x] A passkey de uma conta ligada, num aparelho limpo, abre a conta sem cartão.
- [x] Uma passkey extra criada em Ajustes, num aparelho limpo, com a resposta sem `userHandle`, abre a conta do membro.
- [x] A mesma passkey, com a entrada removida em Ajustes (`/account/recovery/fetch` 404), mostra o cartão, sem os Termos antes dele.
- [x] Com `/account/status` falhando, a passkey abre uma conta separada (Termos e depois "Confirme seu celular"), sem o cartão.
- [x] Recarregar a página com o cartão na tela volta para "Entrar"; Entrar com a mesma passkey mostra o cartão de novo.
- [ ] Conta excluída ou em exclusão: não conferido.
- [ ] PWA instalado: não conferido.

Android (build de debug) e iOS (simulador): pendentes. O laboratório local não serve passkeys ao app nativo (a configuração hospedada exige https e o rp.id não pode ser um IP), então os cinco passos vão para a lista de conferências da #224:

- [ ] Num aparelho limpo, Entrar com uma passkey antiga sem conta mostra o cartão, antes dos Termos.
- [ ] "Entrar com outra passkey" esquece a identidade nova e abre a lista de passkeys; entrar com a passkey de uma conta ligada abre essa conta.
- [ ] "Criar conta com ela" segue para os Termos e a configuração.
- [ ] A passkey de uma conta ligada não mostra o cartão.
- [ ] Sem internet, Entrar com a passkey original segue como antes, sem cartão.

## Parte: rastro da criação antes do create() (#444, §109 "Limites")

### O que muda

- Antes de pedir a passkey ao autenticador, a criação de conta grava um rastro com o identificador do usuário (e, na web, a escolha do celular), sem identificador da credencial: o campo `intent` do registro `passkeyAttempts` (web) e do arquivo de tentativas (`apps/app/src/passkeyLocal.native.js`). Na web a gravação vai para a fila sem esperar, para o `create()` continuar no gesto da pessoa; no app nativo ela é esperada antes da cerimônia.
- Se o app ou a página cair depois de a passkey existir e antes de o pedido pendente ser gravado, o rastro fica: o status responde `pending: true` e a tela oferece "concluir".
- "Concluir" de um rastro oferece todas as passkeys (lista de permitidas vazia) e só aceita a que tem aquele identificador de usuário. Outra passkey tem a saída PRF zerada, não instala nada, o rastro fica e o erro é `OTHER_PASSKEY`, "essa não é a passkey criada agora; escolha a passkey "Varanda xxxxxx"". No nativo, `NONE` (nenhuma passkey no aparelho) apaga o rastro e dá o mesmo texto de passkey sumida de hoje.
- Um "Entrar" cujo identificador de usuário é o do rastro passa pelas checagens da criação antes de qualquer outro caminho, inclusive a checagem da conta no serviço: BE desligado recusa `NOT_SYNCED` (criada aqui, nunca entra depois), sem PRF recusa `NO_PRF`, senão instala como criação (`created: true`) e consome o rastro.
- O rastro some quando o pedido pendente com o identificador da credencial é gravado (mesma gravação), quando qualquer passkey é ligada, quando a criação termina sem passkey (cancelar, falha: o registro volta a ser o anterior) e no "recomeçar". "Sair" o mantém, como mantém o pedido pendente. Um bloqueio ou "Sair" com o `create()` aberto também o mantém, porque a passkey pode existir.
- Formato: campo separado, sem subir a versão do registro. Um build antigo ignora o campo e lê o pendente como `null`, igual a hoje; nenhum identificador nulo chega a `excludeCredentials` nem a `allowCredentials`.
- Adição e recuperação (`addPending`) não mudam: o pendente delas continua só na memória e tem a mesma janela; na web, a entrada `ADD_PENDING` gravada depois do resultado só cobre o caso em que o resultado chegou.

### Testes automáticos

- `packages/web-member/test/resume.test.js`, teste novo "passkey attempts: a creation intent survives a crash after create(); concluir and sign-in finish it by user handle": cancelar não deixa registro; queda depois do `create()` deixa só o rastro, e a regra de leitura antiga não vê pendente; status pendente; outra passkey (com e sem PRF) dá `OTHER_PASSKEY` sem lista de permitidas, com a dica do celular, e o rastro fica; uma nova criação cancelada devolve o registro anterior; "concluir" instala como criação e não grava `passkeyEnrol`; BE desligado no "concluir" e no "Entrar" dá `NOT_SYNCED` registrado; sem PRF dá `NO_PRF`; `unlock({ any: true, check: true })` instala como criação; bloqueio com o `create()` aberto mantém o rastro; "recomeçar" o apaga. Arquivo: 8/8 testes, 342/342 asserções.
- `apps/app/test/sessionStoreNative.test.js`, teste novo "identity: a creation intent survives a kill after create; concluir and sign-in finish it by user handle": os mesmos casos no nativo (arquivo real do `passkeyLocal` para o formato), mais `NONE` no "concluir", que apaga o rastro e dá o texto de passkey sumida, o pendente com identificador substituindo o rastro e "Sair" contra "recomeçar". Arquivo: 69/69 testes, 545/545 asserções (antes: 68/68, 501/501).
- Rodados sozinhos e verdes, sem mudança: `apps/app/test/identityInstall.test.js` (51/51, 304/304), `apps/app/test/identityRecoveryNative.test.js` (37/37, 222/222), `packages/web-member/test/passkey.test.js` (30/30, 419/419), `packages/web-member/test/web-node-recovery.test.js` (19/19, 294/294), `packages/web-member/test/node-bundle.test.js` (2/2, 131/131).

### Falha sem a correção

Com a gravação do rastro desligada (`intent = mine` na web, `intentReg = mine` no nativo):

- Web: os 7 testes antigos passam; o teste novo falha nas asserções 5 ("the intent, with no credential id"), 7 ("the next page offers concluir"), 9, 10 ("it names the passkey to pick"), 11, 12, 13 ("the trace stays") e 17, e a execução para numa rejeição `CANCELLED` ("nenhuma criação de passkey pendente") do `complete()` sem rastro, antes do total.
- Nativo: os 68 testes antigos passam; o teste novo falha nas asserções 4 ("the trace, written before create"), 5 ("the file layout"), 7, 8 ("the next start offers concluir"), 9, 10, 13 ("the trace stays") e 14, e para na mesma rejeição `CANCELLED`.

Com a correção de volta, os dois arquivos ficam verdes de novo (números acima).

### Limites que ficam

- Uma criação concluída pelo rastro não tem o objeto de atestação (ele nunca foi gravado), então não há inscrição da passkey no serviço de conta: a conta fica sem chave de passkey registrada e uma exclusão espera 7 dias.
- Uma nova criação que substitui um rastro antigo (a pessoa tenta de novo sem "concluir") deixa a passkey antiga no gerenciador sem identificador para excluí-la das criações seguintes.
- Na web, uma queda depois de a identidade ser ligada e antes da gravação que apaga o rastro é coberta na leitura (o rastro cujo identificador de usuário é o da passkey ligada é descartado). No nativo não há essa checagem: o rastro pode sobrar e mostrar "concluir", que então dá `OTHER_PASSKEY` ou, com a mesma passkey, termina a criação de novo sem dano.
- Adição e recuperação continuam com a janela (pendente só na memória).
- Um gerenciador de senhas que omite o identificador do usuário numa entrada: o rastro da criação não reconhece a passkey, que entra como uma passkey comum. No "concluir", o mesmo gerenciador dá `OTHER_PASSKEY` toda vez, com o rastro mantido, até um Entrar ou uma nova criação o apagar.
- No nativo, `NONE` no "concluir" apaga o rastro, mesmo que a passkey exista num gerenciador que o Android não consultou.
- Uma falha depois de o gerenciador guardar a passkey e antes da gravação do pendente devolve o rastro anterior; a passkey nova fica no gerenciador sem registro.
- Na web, `bind` anula o `intent` antes de gravar: uma gravação das tentativas nesse meio tempo sai sem o rastro e, se o `bind` falhar, ele volta só na memória até a próxima gravação.
- No nativo, enquanto o arquivo de tentativas não pôde ser lido, um rastro que esta execução já descartou pode voltar do disco no `persist` seguinte (que adota o rastro do arquivo quando a memória não tem nenhum), e "concluir" aparece sem nada pendente.
- `refuseIntent` não trata uma recusa sem identificador da credencial, nem limpa o rastro quando um "recomeçar" mudou a época no meio; nos dois casos ela não toca no rastro.

### Conferência manual

- [x] Web, no mesmo laboratório (17/11/2026): criar conta e travar a página logo depois de o autenticador criar a passkey (o resultado do `create()` nunca chega à página; o PRF dessa passkey só responde numa segunda cerimônia), recarregar: aparece "Falta só confirmar mais uma vez. Toque em Concluir e entrar.", e "Concluir e entrar" termina a criação com a mesma passkey. Depois de recarregar, o primeiro toque abre os Termos (o aceite feito antes da queda era só daquela página) e o segundo pede a passkey; esse comportamento já existia antes desta mudança.
- [ ] Android (build de debug): matar o app durante a folha de criação depois de confirmar, reabrir: aparece "concluir"; escolher outra passkey mostra "essa não é a passkey criada agora". Vai para a #224.
