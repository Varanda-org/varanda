# Conversas abre onde a pessoa parou de ler (branch feat/conversas-read-position)

Uma conversa (mensagem direta em `Mensagem.js` ou grupo em `Grupo.js`) abre no fim quando tudo foi lido e, com mensagens novas, na primeira não lida, sob a linha "Mensagens novas". A posição é a dos vistos que já existiam (fichas de `dm.seen` e marca de `group.seen`): o app só marca o que a conversa mostrou, depois de posicionada, e o bloco de vistos leva isso aos outros aparelhos da mesma passkey sem mudar de formato.

## O que muda

- `dm.thread` devolve `firstUnread` (id ou `null`), calculado sobre a conversa inteira: a primeira mensagem de quem conversa depois da mais nova que é da pessoa ou já vista. Sem nenhuma das duas, `null`, e a conversa abre no fim.
- `dm.seen` aceita `upTo` (inclusivo): marca as mensagens recebidas até ali. Um id desconhecido não marca nada e nunca vira "marcar tudo".
- A página mais nova de `group.read` (sem `before`, fora de tópico, sem ser como Página) devolve `firstUnread` (`{ at, writer, seq }` ou `null`).
- `apps/app/src/readPosition.js`: plano de abertura (`openPlan`: fim, linha ou página mais antiga, até 3 páginas), cursor de leitura que só anda para a frente, tentativas limitadas (`settleStep`, com espera que dobra) e posicionamentos por crescimento do conteúdo, que não gastam tentativa e também têm limite (`GROWTH_PLACES`).
- `pinToEnd` ganhou a marca `opening`: os quadros da primeira rolagem não soltam mais o fim por engano.
- O fim conta como visto só quando a linha mais nova esteve na tela (o cursor chegou nela). Uma mensagem que chega enquanto a pessoa lê mais acima espera até aparecer.
- Uma página mais antiga em andamento não conta para o limite de 3 antes de chegar, e uma página que falha encerra a busca daquela abertura: a conversa para na linha mais antiga carregada, sem repetir o pedido. A falha vale até a pessoa abrir outra conversa, mesmo depois de uma leitura da página mais nova dar certo e apagar o aviso de erro. Nesse caso só o fim marca: uma marca numa linha mais nova marcaria também as não lidas da página que não chegou.
- No grupo, a busca da abertura não pede página enquanto uma recarga refaz o trecho já lido (`walkOlder`) e segue quando essa recarga termina, com ou sem gravar as páginas.

## Testes automatizados

Cada arquivo rodado sozinho (`node <arquivo>`), com lint limpo nos arquivos mudados (`npx standard`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/readPosition.test.js` | 8/8 | 45/45 |
| `apps/app/test/chatGestures.test.js` | 27/27 | 436/436 |
| `apps/app/test/group-flow.test.js` | 61/61 | 478/478 |
| `apps/app/test/mensagemRows.test.js` | 6/6 | 46/46 |
| `apps/app/test/chatActions.test.js` | 20/20 | 116/116 |
| `packages/web-member/test/dm.test.js` | 85/85 | 839/839 |
| `packages/rpc/test/methods.test.js` | 163/163 | 7550/7550 |
| `packages/rpc/test/sizes.test.js` | 42/42 | 431/431 |
| `packages/core/test/group-seen.test.js` | 7/7 | 82/82 |
| `packages/web-member/test/group-seen.test.js` | 11/11 | 84/84 |
| `packages/core/test/session-groups.test.js` | 16/16 | 638/638 |
| `packages/web-member/test/session-groups.test.js` | 25/25 | 249/249 |

Os testes de regressão da rodada de correção falham sem a correção: cada uma foi desfeita sozinha e o teste dela falhou (o grupo que pintava as linhas antes da leitura, o crescimento que gastava tentativas, o fim "visto" para sempre depois de abrir no fim, o cursor que não começava na linha mais nova, a página em andamento contada no limite, a página com falha repetida, a falha apagada por uma leitura seguinte, a falha de outra conversa contada nesta e a abertura do grupo parada depois de uma recarga que terminou sem gravar). O teste da marca depois de uma página com falha confere o texto das duas telas.

Tamanhos (`sizes.test.js`): pior caso de `dm.thread` com `firstUnread`, 262091 bytes; de `group.read` sem marcas, 262032; com marcas, 247843. Todos abaixo de 262144.

## No navegador

Chrome sem cabeça, controlado por CDP (`--remote-debugging-port`), tela de 390 x 844 com DPR 2, sobre a Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1 npx expo start --web`). Para ter conversas longas, um acréscimo temporário à Vitrine, desfeito antes do commit, pôs 60 mensagens numa conversa (uma em cada cinco da própria pessoa) com `firstUnread` na 6, e 60 publicações num grupo com `firstUnread` na 6. As duas ficam fora da página mais nova.

| Caso | Resultado |
|---|---|
| Conversa direta toda lida | abre no fim, a última mensagem inteira à vista (distância do fim 0) |
| Conversa direta, primeira não lida numa página mais antiga | carrega uma página mais antiga e abre com a mensagem 6 no alto, sob "Mensagens novas"; o botão de ir ao fim aparece |
| Grupo, primeira não lida duas páginas atrás | carrega duas páginas mais antigas e abre com a publicação 6 no alto, sob "Mensagens novas"; o botão de ir ao fim aparece |

O grupo falhou na primeira conferência: as linhas pintavam antes da leitura que decide a abertura, e o efeito que conduz a abertura parava depois de começá-la, sem pedir a página mais antiga. Corrigido nesta branch e conferido de novo.

O painel de navegador do app Claude, quando escondido, não desenha quadros: a lista não mede nenhuma linha e todo `scrollToIndex` falha. Por isso a conferência usou o Chrome sem cabeça.

## O que não foi conferido

- O abrir no meio, de antes da mudança, não foi reproduzido na tela. A causa vem da leitura do código: o primeiro `scrollToEnd` cai numa estimativa, um quadro seguinte desce mais de 48 px e `pinToEnd` lê isso como rolagem da pessoa e solta o fim.
- Android e iOS: nada foi conferido no emulador nem no simulador. O emulador e o Metro da máquina estavam em uso por outra sessão. Fica devido: no build de debug do Android e no simulador iOS, uma conversa toda lida abre no fim; uma com mensagens novas abre na primeira não lida; ler metade, sair e voltar abre na próxima não lida.
- Dois aparelhos: não foi conferido se uma leitura parcial num aparelho chega ao outro, nem o caso das 128 fichas (ler mais de 128 mensagens no aparelho A e abrir uma conversa parada no B).
- Contas reais: a Vitrine não passa por `node.request`.

## Limites conhecidos

- O bloco de vistos guarda só as 128 fichas de mensagem direta mais novas, de todas as conversas. Passadas 128 mensagens lidas entre duas fusões, a ficha mais nova de uma conversa parada pode não chegar ao outro aparelho, que então abre essa conversa na posição antiga dele. O ponto de não lidas de hoje tem o mesmo limite (`docs/protocol.md` §14).
- Primeira não lida mais de 3 páginas atrás: a conversa abre na linha mais antiga carregada, que ainda é não lida, e a marca dela (ou a do fim) também conta como lidas as não lidas mais antigas que não carregaram. A pessoa ainda chega a elas rolando para cima. Antes da mudança, abrir a conversa marcava tudo; um limite sem fim faria a abertura esperar páginas sem parar.
- Abrir como Página: a conversa abre no fim e não marca nada num grupo.
- Nada vai para quem conversa nem para o semeador: as marcas continuam locais e só o bloco de vistos, cifrado, viaja entre os aparelhos da pessoa.
