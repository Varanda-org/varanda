# Ponto de não lidas em Conversas (branch fix/conversas-unread-dot)

O ponto da aba Conversas acendia sem nada não lido na tela. Ele comparava os contadores de versão dos grupos (`node.groupVersions`, que sobem a cada sincronização, publicação própria, reação ou mudança de membros) com um mapa local de vistos que recomeçava a cada época do nó. A tela mostra outra coisa: as contagens `unread` de `community.info` e o `inboxUnread` de `dm.list`. Agora o ponto segue as mesmas contagens que a tela.

## O que muda

- `apps/app/src/conversasDot.js`: regras puras do ponto. `groupsUnread(rows, { complete })` responde `true` com algum grupo não lido, `false` só depois de uma leitura completa sem nenhum e `null` (desconhecido) nos outros casos. `conversasDot` acende com conversa não lida ou pedido pendente na caixa de entrada em uso e, fora do modo Página, com grupo não lido. `settleGroups` mantém o valor anterior quando a leitura é desconhecida. `badgeListParams` pede a `dm.list` da caixa de entrada da Página enquanto a pessoa publica como Página. `showNaoLidasEmpty` só deixa mostrar "Nada novo por aqui" sem linhas, sem pedidos e sem páginas a buscar.
- `apps/app/src/groupsUnreadRead.js`: leitura dos grupos fora da tela Conversas (`community.list`, depois `community.info` de no máximo 4 comunidades por vez, parando no primeiro grupo não lido) e o agendador `createGroupsDotScheduler`: uma leitura por vez, no máximo um ciclo a cada 3 s mais um ciclo no fim da janela, prazo de 60 s por ciclo e uma nova tentativa 15 s depois de uma leitura desconhecida ou com falha. Um disparo novo nunca cancela a leitura em andamento.
- Só uma comunidade que falhou (erro ou nenhuma resposta) deixa a leitura desconhecida. Uma resposta com `incomplete: true` conta: sem isso, uma comunidade sempre incompleta deixaria o ponto aceso para sempre.
- `App.js`: saem o mapa de vistos por versão, a comparação e a chamada a `ackCaughtUp`. O ponto de grupos vem da leitura acima (disparada por `groups.changed`, pela marca de vistos, por `dmVersion`, pela pilha de telas e pela saída da aba Conversas) ou, com Conversas na tela, do que a própria tela mostra (`onGroupsUnread`). Uma reconexão do nó não apaga mais o ponto. O ponto de mensagens diretas lê a caixa de entrada em uso e, se a leitura falha, mantém o valor anterior e tenta de novo 15 s depois.
- `Conversas.js`: o filtro Não lidas busca as páginas mais antigas da caixa de entrada (até o limite da busca, com "Buscar mais" depois) antes de mostrar "Nada novo por aqui". A linha de Pedidos fica no alto em todos os filtros e durante a busca.
- `docs/rpc.md` (5.96): o ponto não usa `caughtUp`.

## Testes automatizados

Cada arquivo rodado sozinho (`node <arquivo>`): os arquivos de `apps/app/test` que mudaram e todos os que importam um módulo mudado (71 arquivos), entre eles `conversasDot.test.js`, `conversasDotWiring.test.js`, `inboxPaging.test.js`, `conversas.test.js`, `conversasList.test.js`, `chatSurfaces.test.js`, `gruposSnapshot.test.js`, `seenSync.test.js`, `groupVersions.test.js` e `tabBar.test.js`. Todos passam, com `npm run lint` limpo e `npm run demo` terminando em `DEMO OK`. A suíte inteira roda na CI do GitHub.

- `conversasDot.test.js`: tabela de verdade do ponto para a pessoa e para a Página, leitura desconhecida mantendo o valor anterior e a regra de "Nada novo por aqui".
- `conversasDotWiring.test.js`: a leitura dos grupos (comunidades consideradas, falha contra resposta incompleta, no máximo 4 pedidos ao mesmo tempo, parada no primeiro grupo não lido) e o agendador com relógio falso (um ciclo por janela, o ciclo do fim, disparos durante uma leitura lenta, `reset`, `stop`, prazo, nova tentativa e a pausa com Conversas na tela). Também confere em `App.js` que a comparação por versão saiu. Esse teste falha no código anterior.
- `inboxPaging.test.js`: o passo que busca páginas para o filtro Não lidas e o limite.

## No aparelho

Execute as verificações primeiro no build de debug do Android no emulador, depois no simulador iOS e por último na web.

| Verificação | Android (debug) | iOS | Web |
| --- | --- | --- | --- |
| Feche e reabra o app com tudo lido e várias atualizações de grupo para sincronizar. O ponto de Conversas permanece apagado durante a sincronização e depois dela. | a fazer | a fazer | a fazer |
| Com a conta de outro membro, publique no grupo. Na conta em teste, o ponto acende. Abra o grupo, leia a publicação e volte para Conversas. O ponto apaga sem reiniciar o app. | a fazer | a fazer | a fazer |
| Com tudo lido, faça uma publicação própria num grupo e volte para Conversas. O ponto permanece apagado. | a fazer | a fazer | a fazer |
| Prepare estados diferentes de leitura na caixa de entrada pessoal e na da Página. Alterne a identidade em Publicar como e confira que o ponto acompanha a caixa de entrada da Página enquanto ela estiver em uso. | a fazer | a fazer | a fazer |
| Deixe uma única conversa não lida em uma página mais antiga. Abra Não lidas e confira que o filtro encontra a conversa antes de mostrar “Nada novo por aqui”. | a fazer | a fazer | a fazer |
| Com um pedido de conversa pendente, passe pelos filtros Todas, Não lidas e Grupos e faça uma busca. A linha de Pedidos aparece no alto em todos. | a fazer | a fazer | a fazer |
| Com o ponto aceso, desligue e ligue a rede para o nó reconectar. O ponto não apaga durante a reconexão. | a fazer | a fazer | a fazer |
| Com o ponto aceso, bloqueie o app e desbloqueie de novo. O ponto volta só se ainda houver algo não lido. | a fazer | a fazer | a fazer |

## O que não foi conferido

- Nada foi conferido na tela: Android, iOS e web ficam devidos, na ordem da tabela acima.
- Dois aparelhos da mesma passkey: o ponto de um aparelho depois de ler no outro depende da sincronização de vistos, que este PR não muda.

## Limites conhecidos

- Uma resposta `incomplete: true` de `community.info` conta como resposta. Um grupo que falta nela aparece na lista pela linha guardada, sem contagem, e o ponto não acende por ele até a parte que falta chegar e a leitura seguinte o ver. É a mesma coisa que a tela mostra; a regra oposta deixaria o ponto aceso para sempre com uma comunidade sempre incompleta.
- Uma comunidade cujo `community.info` falha sempre deixa a leitura dos grupos desconhecida: o ponto mantém o último valor e não apaga sozinho até a comunidade responder.
- Depois que a tela Conversas foi aberta uma vez, ela continua recarregando os grupos fora da aba, e a leitura do App também roda. São pedidos a mais, sem efeito no valor do ponto.
- Anterior a esta mudança: em Todas, um grupo não lido com atividade mais antiga que a conversa direta mais antiga já carregada só aparece depois que a caixa de entrada termina de carregar. O ponto acende mesmo assim.
- A ligação em `App.js` é conferida por trechos do código-fonte, sem teste que renderize o App.
- `groupsUnreadRead.js` repete de `Conversas.js` a validação da chave, os papéis de membro e o filtro de comunidades.
