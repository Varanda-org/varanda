# Comentário na hora (branch fix/comment-instant-feedback)

Comentário e resposta passam a aparecer na hora em cada lugar de onde saem: a barra rápida da Conversa, a Publicar e o cartão da A Rua. Na web e no nó do próprio app, `post.reply` espera a sincronização que já está alcançando o diário. Aqui está o que rodou nesta worktree, e o que ficou de fora.

## Ambiente

Node v24.22.1, macOS. Na worktree rodou `npm ci --ignore-scripts`. Cada arquivo de teste rodou sozinho, com `node <arquivo>` a partir da raiz. Quando um teste abriu a DHT, foi a local, em `127.0.0.1`.

## Testes

### T1. Linha pendente em `roda.js`

- `node apps/app/test/roda.test.js`: 30/30.
- `node apps/app/test/threadRows.test.js`: 10/10.
- Antes da mudança, 6 dos testes novos de `roda.test.js` falhavam.

### T2. `PostRow` com `sending`

- `node apps/app/test/postRowLayout.test.js`: 6/6.
- `node apps/app/test/hit.test.js`: 5/5.
- `node apps/app/test/postShareRow.test.js`: 9/9.
- `node apps/app/test/postOverflow.test.js`: 15/15.
- `node apps/app/test/perfMarks.test.js`: 21/21.
- `node apps/app/test/postLayout.test.js`: 17/17.

### T5. `ReplyBar` com `sendingShown`

- `node apps/app/test/replyBar.test.js`: 21/21.

### N1. `post.reply` espera a sincronização ao vivo

- `node packages/web-member/test/session.test.js`: 87/87 (781 asserções).
- `node packages/web-member/test/passkey-e2e.test.js`: 2/2 (172 asserções).
- `node packages/web-member/test/sync-gate.test.js`: 15/15.
- Sem `{ ride: true }`, `session.test.js` fica em 82/87. O teste novo de dois aparelhos em `passkey-e2e.test.js` falha, e aparece uma rodada de portão.
- Depois da revisão: um teste novo encerra a execução contínua com um erro enquanto a resposta espera nela. A resposta passa para a rodada de alcance, que grava uma vez só. `session.test.js` fica em 88/88 (791 asserções). Sem o aviso de fim de execução para quem espera, a resposta espera os 15 s inteiros e é recusada.

### N2. `ownReply.js`

- `node apps/app/test/ownReply.test.js`: 10/10.

### N3. `replyFloor` e `lastSeqStale`

- `node apps/app/test/replySend.test.js`: 20/20.
- `node apps/app/test/replyHandoff.test.js`: 2/2.
- Sem o piso, `replySend.test.js` fica em 18/20. Sem a conciliação de folga zero, fica em 19/20.
- Depois da revisão: a folga zero vale só para um piso passado por quem chama. Um piso que o próprio envio leu do diário é atual e mantém a folga de sempre. `replySend.test.js` fica em 21/21, e em 20/21 sem essa correção.

### N4. Ajudantes de `feedFold`

- `node apps/app/test/feedFold.test.js`: 37/37.
- `node apps/app/test/foldRounds.test.js`: 18/18.
- `node apps/app/test/visibleFirst.test.js`: 5/5.
- `node apps/app/test/feedRender.test.js`: 16/16.
- Com os ajudantes desligados, os 6 testes novos falham.

### T3. Linha pendente na Conversa

Nesse ponto do trabalho:

- `node apps/app/test/conversaScreen.test.js`: 94/94.
- `node apps/app/test/threadRows.test.js`: 10/10.
- `node apps/app/test/platformGate.test.js`: 6/6.
- Sem as linhas de `setPending` e de `pendingJump`, `conversaScreen.test.js` fica em 89/94.

### N5. Anúncio da Publicar

- `node apps/app/test/publicarAnnounce.test.js`: 4/4.
- `node apps/app/test/musicDraft.test.js`: 46/46.
- `node apps/app/test/videoCompose.test.js`: 33/33.
- `node apps/app/test/postShareCompose.test.js`: 14/14.
- `node apps/app/test/composePolish.test.js`: 15/15.
- `node apps/app/test/linkCardBuild.test.js`: 23/23.
- `node apps/app/test/momentosScreen.test.js`: 177/177.
- `node apps/app/test/wordCheck.test.js`: 22/22.
- `node apps/app/test/a11yCompose.test.js`: 4/4.
- `node apps/app/test/pageMoment.test.js`: 16/16.
- Sem o anúncio, `publicarAnnounce.test.js` fica em 2/4.
- Depois da revisão: a resposta de uma Página tinha o autor lido de um `ref` que a resposta da Página não traz (`{ seq, length, pushed }`), e não era anunciada. Agora a Página é a autora, no primeiro envio e no "Tentar de novo". Sem essa correção, `publicarAnnounce.test.js` fica em 3/4.

### N6. Dobra própria na A Rua

- `node apps/app/test/feedPreviews.test.js`: 18/18.
- `node apps/app/test/postShareRow.test.js`: 9/9.
- `node apps/app/test/feedFold.test.js`: 38/38.
- `node apps/app/test/feedRender.test.js`: 16/16.
- `node apps/app/test/visibleFirst.test.js`: 5/5.
- `node apps/app/test/foldRounds.test.js`: 18/18.
- `node apps/app/test/platformGate.test.js`: 6/6.
- Sem o aumento da contagem, `feedPreviews.test.js` fica em 17/18.
- Depois da revisão: a cópia local de uma resposta sai assim que o feed a traz (`dropFedReplies`), então uma resposta apagada em outro aparelho não continua no cartão. `feedFold.test.js` cobre a função, e `feedPreviews.test.js` confere a ligação na A Rua.
- Depois da revisão: só as respostas da própria conta entram na lista local da A Rua. Uma resposta como Página não ocupa uma das 20 vagas. `feedPreviews.test.js` confere a ordem do filtro.
- O aumento da contagem fica em `socialRowProps`, que a lista de Página e a prévia da abertura também usam. Nelas, a contagem passa a ser a maior entre o índice e os comentários que o cartão já mostra.

### N7. Conversa ao vivo

- `node apps/app/test/conversaScreen.test.js`: 105/105 (952 asserções), depois das correções da revisão.
- `node apps/app/test/replySend.test.js`: 21/21.
- `node apps/app/test/ownReply.test.js`: 10/10.
- `node apps/app/test/platformGate.test.js`: 6/6.
- Sem `lastSeq` na chamada, `conversaScreen.test.js` fica em 102/105. Com o corpo de `placeOwnReply` esvaziado, os testes dele falham.
- Depois da revisão: uma resposta da Publicar que a Conversa aberta ainda não consegue posicionar (tela carregando, outro fio) fica guardada para a próxima leitura desse fio. O teste de `placeOwnReply` cobre esse caso.
- Depois da revisão: um comentário que a Publicar confirma enquanto a Conversa carrega entra na lista que o carregamento mostra, em vez de sumir até a leitura seguinte. A cópia guardada de uma resposta que o índice já lista, mas cuja leitura falhou, continua na lista em vez de virar "comentário indisponível". Isso vale também para uma resposta que chega durante as leituras de citação. Uma Conversa aberta sem conexão guarda a resposta da Publicar para o próximo carregamento. Há um teste para cada caso em `conversaScreen.test.js`, que passa a 108/108 (957 asserções), e cada um falha sem a sua correção.
- Depois da revisão: depois de um envio que falhou, o seguinte lê o diário antes de enviar, até um envio ser confirmado. Sem isso, o comprimento sincronizado podia ficar atrás de uma escrita que o envio incerto fez. Há teste em `conversaScreen.test.js`, que falha sem a correção.

## CI de entrada (`npm run lint`, arquivos de teste do diff, `npm run demo`)

Depois de juntar a `origin/main` (6719f693), no Node v24.22.1: `npm run lint` passou; os 146 arquivos de teste que o diff alcança (cada arquivo de teste mudado e cada um que importa um módulo mudado), rodados 4 por vez, passaram todos; `npm run demo` terminou com DEMO OK.

## Não executado

Nenhum aparelho. Não houve emulador Android, simulador iOS, sessão web nem PWA. A ordem devida era o build de debug do Android, depois o simulador iOS, depois a web e o PWA contra um semeador local, sem DHT pública. Nenhum cenário abaixo rodou:

- Comentário na raiz, com a lista rolada bem para baixo.
- Resposta sob uma roda fechada.
- Resposta funda.
- Teclado aberto.
- Texto grande.
- Leitor de tela.
- Agindo como Página.
- Toque duplo rápido.
- Falha no meio de um envio.
- Navegação durante um envio.
- Resposta enviada logo em seguida de outra, com a sincronização ainda rediscando.
- Resposta com o semeador parado: recusa, nada escrito, texto mantido na barra.
- Dois aparelhos de uma mesma passkey, respondendo um de cada vez.
- Resposta com foto pela Publicar, por cima de uma conversa aberta.
- Resposta a partir do cartão da A Rua, e a volta à A Rua.
- Apagar o comentário recém-enviado.

A suíte inteira não rodou nesta worktree. Ela roda na CI do GitHub, no PR, no Node 20 e no Node 24.

## Limites conhecidos

A sincronização ao vivo é a execução contínua que já está no ar. A rodada de alcance é a que uma escrita abre para alcançar o semeador antes de gravar.

- Só `post.reply` espera a sincronização ao vivo. As outras escritas seguem na rodada de alcance.
- Sem execução contínua, ou logo depois de uma escrita com outro pedido já na fila, `post.reply` usa a rodada de alcance.
- Os 15 s não são um máximo de ponta a ponta.
- Uma resposta na fila de saída só aparece depois de publicada, quando a tela recarrega.
- Uma resposta enviada como Página não aparece no cartão da A Rua antes de o feed recarregar.
- O cartão de link ou de música de uma resposta publicada pela Publicar aparece na leitura seguinte.
- Puxar para atualizar durante um envio pode mostrar a linha confirmada ao lado da que está enviando, até o envio responder.
- Enquanto uma resposta espera a sincronização ao vivo, a queda do link com o semeador a recusa na hora, com `seederDownTtlMs` ligado, no ponto em que a rodada de alcance poderia ter rediscado. O texto fica na barra e nada é reenviado.
- A espera na sincronização ao vivo dura no máximo 5 s. Depois a resposta segue na rodada de alcance, pelo tempo que restar dos 15 s.
- Uma resposta publicada pela Publicar para uma resposta dentro de uma roda (não para o comentário que abre a roda) aparece só quando esse fio é lido de novo, se nenhuma Conversa estiver aberta, se a Conversa ainda estiver carregando ou se a resposta respondida não estiver carregada na tela.
- Até o feed trazer a própria resposta, ela aparece primeiro no cartão da A Rua, mesmo que um comentário mais novo chegue antes.
- Um `post.delete` incerto tira a resposta da lista local da A Rua, como já tirava do cache da Conversa. Se a exclusão não aconteceu, a resposta volta quando o feed a trouxer.
- Uma resposta que sai da fila de saída ao ser publicada não é anunciada às telas abertas.
