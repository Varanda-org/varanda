# Rolagem da conversa do grupo na web (branch fix/group-web-chat-scroll)

## O que muda

Na web, a conversa do grupo abria antes do ponto certo. Com tudo lido, parava alguns pixels antes do fim. Com mensagens não lidas, às vezes parava longe da primeira delas. A lista da web só monta uma janela de linhas, e a altura das linhas de fora da janela é estimada, então o alvo da abertura e o "fim" mudam enquanto a lista mede as linhas. A conversa privada já tinha resolvido isso com `allRowsOnWeb` (#874).

A correção leva o mesmo para `apps/app/src/screens/Grupo.js`. A `RefreshableList` do grupo passa a montar todas as linhas na web (`allRowsOnWeb`, `perfId='grupo'`). Para que digitar continue barato com todas as linhas montadas:

- A linha virou um componente memoizado, `GroupRow`. As funções da linha (perfil, citação, ações, reações) chegam por `liveGroupRowCalls(rowLive)`, que sempre chama a versão do render mais novo, e as ações leem o estado atual no momento do toque. O que cada linha mostra a partir da tela (nome, foto, citação, reações em envio, ações) é resumido em chaves simples, e a linha só redesenha quando uma delas muda. O `renderItem` é estável por meio de `renderRef`.
- A própria lista também é memoizada (`GroupChatList = memo(RefreshableList)`). Cabeçalho, rodapé e estado vazio chegam pelo contexto `GroupListSlots`, `onRefresh`, `onLayout` e `onContentSizeChange` são funções estáveis (`liveGroupListCalls`), a chave é `rowKeyOf`, e o `extra` só muda quando muda uma das suas dependências (`extraDeps`, com o estado da tela resumido em `viewKey`). Assim, uma tecla no campo de mensagem não renderiza a lista nem as células.

O plano de abertura (`openPlan`, `groupTarget`, a trava `openLatch` sobre `read.firstUnread`) continua o mesmo, com uma mudança. Antes, o plano esperava o fim de todo o carregamento (`loadedAt`). Com o servidor lento, a primeira leitura já tinha travado a primeira não lida, mas a lista seguia o fim enquanto o plano esperava (ver S5). Agora o plano é calculado assim que a trava tem a primeira não lida e já há linhas. Sem linhas, ele continua esperando, porque `openPlan` responderia "fim" para uma lista vazia.

Tudo isso vale também no app nativo, que usa o mesmo `Grupo.js`: a linha e a lista memoizadas, a leitura das ações no momento do toque e a mudança no plano. Só `allRowsOnWeb` é exclusivo da web.

Na web, com todas as linhas montadas, a mídia de todas as linhas carregadas é buscada ao abrir a conversa, e não à medida que a pessoa rola. A conversa privada já funciona assim desde #874.

Testes: `apps/app/test/grupoRows.test.js` (novo), `apps/app/test/groupReactions.test.js`, `apps/app/test/chatGestures.test.js`, `apps/app/test/dm.test.js` e `apps/app/test/webAnchor.test.js`.

## Como foi medido

- Modo Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`), bundle de desenvolvimento do Metro, sem rede externa. No Chrome, `--host-resolver-rules` bloqueava tudo que não fosse localhost.
- Edição temporária em `apps/app/src/vitrine/request.js`, desfeita no fim com `git checkout -- apps/app/src/vitrine`. Ela fazia três coisas:
  - acrescentava N mensagens antigas ("antiga 1..N", parâmetro `older`, padrão 60);
  - punha a marca de lido `mark` linhas antes do fim em "Passeios de bicicleta" e `privmark` em "Organização do clube";
  - fazia o `group.read` devolver `firstUnread` na página mais nova, aceitar um atraso opcional (`delay`) e registrar as chamadas de `group.read` e `group.seen`;
  - para as conferências de linha, atrasar perfis (`pdelay`) e reações (`rdelay`), recusar reações (`failreact`), tirar nomes (`noname`) e esvaziar um grupo (`empty`).
- Web: Chrome sem interface (`--headless=new`) a 375x812 com escala 2, guiado por CDP. A cada quadro (`requestAnimationFrame`), um amostrador registrava:
  - `scrollTop`, `scrollHeight` e `clientHeight` da lista;
  - o texto na altura de 300 px;
  - se o botão "ir para o fim" estava visível;
  - a posição da linha "Mensagens novas" em relação ao topo da lista.
- Contagem de linhas re-renderizadas: um gancho falso de DevTools do React, que compara as props de cada `GroupRow` entre um commit e o seguinte.
- Tempo de digitação: do `keydown` ao próximo quadro, com cerca de 306 linhas montadas (`older=300`, páginas antigas carregadas por eventos de roda). Foram 10 teclas de aquecimento e 40 medidas. Tudo no bundle de desenvolvimento, então os números absolutos são maiores que em produção, e vale a comparação entre builds medidos na mesma sessão.
- "Fim" significa `scrollTop = scrollHeight - clientHeight`.

## Resultados na web

Medidos com o código final desta branch.

| Cenário | Grupo e marca | Resultado |
|---|---|---|
| S1, tudo lido | Passeios, mark=0 | Primeiro quadro rolado (t=132 ms) já no fim exato (1580 = 2194 - 614). Nenhuma mudança de posição depois. Sem botão e sem "Mensagens novas". |
| S2, 20 não lidas | Passeios, mark=20 | Assenta em t=227 ms em st 354, com "Mensagens novas" a 0 px do topo e o botão visível. Antes, 8 quadros, todos em st 0 ("antiga 43" na altura de 300 px), de t=116 a 209 ms. Nenhum quadro no fim antes de assentar. |
| S2, botão de ir ao fim | Passeios, mark=20 | O toque leva ao fim exato (1612 = 2226 - 614) e o botão some. |
| S2, `group.seen` | Passeios, mark=20 | Antes do toque, até a linha visível (seq 64), não até o fim. Depois do toque, até a mensagem mais nova. |
| S2, reabrir | Passeios, já lido | Primeiro quadro no fim exato. Nenhuma mudança e sem botão. |
| S3, 2 não lidas | Passeios, mark=2 | No fim exato (1612) em t=229 ms, sem mudança depois. O botão aparece em 14 de 182 quadros (t=245 a 461 ms) e depois some (antes eram 22 de 184). |
| S4, 40 não lidas | Passeios, mark=40 | Precisa de uma página antiga (leituras: nova, nova, antiga). Assenta em t=223 ms em st 610 de 3762, com "Mensagens novas" no topo e o botão visível. Antes, 9 quadros. |
| S5, servidor lento | Passeios, mark=20, delay=150 | Nenhum quadro no fim antes de assentar. Detalhes abaixo. |
| S6, página antiga pela roda | Passeios, mark=20 | A linha na altura de 300 px continua "antiga 45" antes e depois da página carregar (st 104 para 1640, sh 2226 para 3762). |
| S7, enviar no fim | Passeios | Depois do envio, a lista fica no fim exato (1560 = 2174 - 614), com a mensagem enviada como última linha. |
| S8, rolar e voltar | Passeios, mark=0 | Um passo de roda mostra o botão. O toque volta ao fim exato (1580) e o botão some. |
| Console | todos | Nenhum erro. |

### S5 (servidor lento)

S5 usa "Passeios de bicicleta" porque é um grupo público: `forumOn` fica verdadeiro quando o `info` chega e dispara uma segunda leitura. Com 150 ms de atraso em cada chamada, saíram 3 leituras da página mais nova.

| t (ms) | st | sh | O que se vê |
|---|---|---|---|
| 394 a 493 | 0 | 2354 | topo (8 quadros) |
| 511 a 543 | 482 | 2354 | "Mensagens novas" no topo (3 quadros) |
| 584 | 354 | 2226 | mesma posição depois da releitura |
| 595 | 351 | 2226 | assenta com "Mensagens novas" a 3 px do topo |

Nenhum quadro no fim. Antes da trava do plano, a mesma medida pintava o fim em 11 quadros, ao longo de cerca de 194 ms, antes de assentar.

### Digitação

Mesmos dados nos três builds: cerca de 306 linhas montadas, 10 teclas de aquecimento e 40 medidas, do `keydown` ao quadro seguinte. "Janela na página" é o mesmo build com `allRowsOnWeb` tirado no momento de criar o elemento, sem mudar o resto.

| Build | Mediana | p90 | Células re-renderizadas por tecla |
|---|---|---|---|
| Final, rodada 1 | 13,4 ms | 19,2 | 0 |
| Final, rodada 2 | 14,6 ms | 19,9 | 0 |
| Final, janela na página (64 células) | 14,7 ms | 16,6 | |
| Antes da lista memoizada, rodada 1 | 36,6 ms | 45,2 | 306 |
| Antes da lista memoizada, rodada 2 | 43,0 ms | 52,1 | 306 |
| Antes da lista memoizada, janela na página | 14,7 ms | 19,1 | |
| Sem a linha `allRowsOnWeb`, rodada 1 | 14,9 ms | 16,7 | |
| Sem a linha `allRowsOnWeb`, rodada 2 | 14,1 ms | 16,4 | |

Com a lista memoizada, uma tecla não renderiza a lista, nenhuma célula e nenhuma `GroupRow`, e a mediana fica igual à da lista em janela. O critério ("no máximo o dobro da lista em janela") foi cumprido. Antes dela, a lista renderizava as 306 células a cada tecla, e a mediana era cerca de 2,9 vezes a da janela.

Tempo ocupado por tecla, no perfil de CPU (amostra de 100 µs): 22,7 ms no build final contra 12,8 ms na janela. Quase toda a diferença é tempo nativo fora do perfil de JS ("(program)", 11,5 contra 2,1 ms), mais cerca de 1,8 ms de propagação de contexto pela árvore de 306 linhas. A latência até o quadro não muda.

Os números são do bundle de desenvolvimento. Vale a comparação entre builds medidos na mesma sessão, não o valor absoluto.

Observação à parte: carregar as páginas antigas até 306 linhas fez 768 chamadas de `group.read` com todas as linhas montadas, contra 123 sem `allRowsOnWeb`. A diferença vem do roteiro de medida, não da lista. O roteiro sobe com 60 passos da roda do mouse, e cada passo fez uma leitura das mensagens mais novas (60) e releu as páginas antigas já carregadas (708 leituras: 12 páginas, cada uma até 59 vezes). Sem `allRowsOnWeb`, as leituras antigas usaram um cursor só, uma página antiga carregada, e cada passo também a releu (60 leituras das mais novas e 61 dessa página). O número cresce com as páginas carregadas, nos dois builds. Com a conversa parada, não há leitura nenhuma. Ficou fora desta mudança entender por que um passo da roda no topo relê as páginas carregadas.

### Conferência inversa

Sem `allRowsOnWeb`, S1 muda de posição 3 vezes depois do primeiro quadro rolado (st 644, depois 967, depois 1572) e para em 1572 de 1580, 8 px antes do fim. É o defeito antigo, e a correção o elimina (S1 acima).

### Linha e partes da lista (web)

- Reação: os chips ficam desabilitados durante o envio, e ❤️ 2 passa a ❤️ 1. Os commits mudaram 1 linha, 1 linha e depois as 26 (a releitura da versão troca os objetos das linhas).
- "Ver quem reagiu": a folha lista João (❤️) e Cecília (👍).
- Responder: a barra de resposta aparece, e a resposta enviada leva a citação.
- Toque numa citação: a linha citada fica destacada (fundo visível em +250 ms, some em +2,75 s).
- Arrastar para responder: a barra mostra "Você / Posso cuidar".
- Esconder e depois Mostrar: os dois funcionam.
- Tema: escuro para claro e claro para escuro renderizam as 26 linhas uma vez cada.
- Sem rede (`online` falso no lugar): os chips ficam desabilitados, e voltam com a rede.
- Atualizar: a ação "Atualizar" da web faz 2 leituras da página mais nova.
- Cabeçalho: a pílula "Mensagens anteriores" carrega duas páginas e some.
- Rodapé: o erro de reação recusada aparece dentro da lista.
- Grupo vazio ("Família"): as sugestões "Oi" e "Tudo bem?" aparecem, o toque preenche o rascunho, e o envio tira as sugestões e o estado vazio.
- Nomes atrasados (perfil com 5 s de atraso): 14 linhas mostram "Pessoa" no começo e nenhuma depois, com 12 linhas re-renderizadas.
- Cartão de tópico: abre o tópico.

## Celular nativo (simulador iOS, iPhone 16e, build de debug já instalado, JS do Metro)

O app nativo usa a mesma linha e a mesma lista memoizadas. Com o código final:

- Grupo todo lido ("Organização do clube", 60 mensagens antigas a mais): abre no fim, sem botão.
- Grupo com não lidas ("Passeios de bicicleta", marca 20 linhas acima do fim): abre com "Mensagens novas" no alto e o botão de ir ao fim com o selo 11. O toque leva ao fim, e o botão some.
- Reação: ❤️ 2 passa a ❤️ 1.
- Arrastar para responder: um arrasto lento abre a barra de resposta com a mensagem certa.
- Digitar no campo de mensagem funciona.
- Esconder e depois Mostrar na linha de João (admin): os dois funcionam.
- Puxar para atualizar no topo da conversa mostra o indicador de carregamento.
- Fotos de grupos públicos mostram "Mídia indisponível" na Vitrine nativa. Isso já acontecia e não tem relação com esta mudança.
- Para carregar o JS atual foi preciso gerar `apps/app/assets/worklet/main.bundle.js` (`bash scripts/pack-worklet.sh`). É um arquivo gerado, fora do git, e foi apagado no fim. Não rodou `prepare:native`, `pod install` nem build nativo.

## Pendente

- Android: nenhum aparelho ou emulador conectado. Não foi conferido.
- S4 (primeira não lida numa página antiga) e S5 (servidor lento) no nativo: não conferidos. No iOS rodou a abertura com não lidas em "Passeios de bicicleta", que relê o fórum, sem atraso.
- Aparelhos reais (iOS e Android).
- PWA instalado.
- Safari e Firefox (só rodou o Chrome sem interface).
- Build de produção: todas as medidas são do bundle de desenvolvimento.
- Uma conta real com um grupo real, fora da Vitrine.
- Puxar para atualizar por toque na web: o gesto simulado por CDP não disparou leitura. A ação "Atualizar" funcionou, e no iOS o gesto mostra o indicador.
- S6 pela pílula "Mensagens anteriores": o roteiro de medida esgota o tempo, como antes. A pílula em si funciona (conferência do cabeçalho).
- S3: o botão de ir ao fim ainda aparece por alguns quadros no começo antes de sumir.

## Comandos

```sh
EXPO_PUBLIC_VARANDA_VITRINE=1 npx expo start --clear --port 8081   # em apps/app
bash scripts/pack-worklet.sh                                        # só para o JS nativo
git checkout -- apps/app/src/vitrine                                # desfaz a edição temporária
```

Os cenários, a digitação e as conferências de linha rodaram por um roteiro local via CDP (Chrome sem interface), que não faz parte do repositório.
