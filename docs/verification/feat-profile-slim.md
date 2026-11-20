# Perfis mais enxutos

Escopo: PR `feat/profile-slim`. O Diário (`apps/app/src/screens/Diario.js`) e o perfil de outra pessoa (`apps/app/src/screens/Membro.js`), os dois sobre `apps/app/src/ui/ProfileHeader.js`, ficam mais enxutos sem perder funcionalidade. Os momentos passam para um anel na foto (`MomentRing` em `apps/app/src/ui/MomentosStrip.js`, decidido por `avatarMoments` em `apps/app/src/profileSlim.js`); as linhas "Seus momentos (24 h)" e "Momentos anteriores" saem do Diário, porque o app já apaga os momentos vencidos da própria pessoa (`docs/verification/feat-momentos-auto-delete.md`); os momentos de uma Página passam para Ajustes da página (`PaginaAjustes.js`). O link "Sobre mim ›" (Diário) ou "Sobre ›" (Membro) sob a bio abre uma folha (`apps/app/src/ui/ProfileAbout.js`), e os atalhos viram uma faixa de chips (`apps/app/src/ui/ProfileShortcuts.js`). O aviso de momento incerto do compositor (`MOMENT_UNCERTAIN`, `Publicar.js`) aponta para o anel da foto. Sem método novo do RPC, sem mudança de protocolo nem de Termos.

## Testes executados

Node 24.22.1, sem rede. Seleção: todo arquivo de teste alterado ou novo e todo arquivo de teste que cita o nome de um arquivo alterado em relação à `main`, cada um executado sozinho com `node <arquivo>`: 457 arquivos (191 de `apps/app`, 70 de `apps/cli`, 2 de `apps/site`, 106 de `packages/core`, 6 de `packages/rpc`, 82 de `packages/web-member`). Todos passaram, sem falha intermitente.

Os arquivos que exercitam a mudança diretamente:

```text
node apps/app/test/profileSlim.test.js: tests = 7/7 pass; asserts = 50/50 pass
node apps/app/test/profileSlimUi.test.js: tests = 3/3 pass; asserts = 12/12 pass
node apps/app/test/profileHeaderSlim.test.js: tests = 5/5 pass; asserts = 17/17 pass
node apps/app/test/diarioSlim.test.js: tests = 4/4 pass; asserts = 48/48 pass
node apps/app/test/membroSlim.test.js: tests = 6/6 pass; asserts = 47/47 pass
node apps/app/test/momentosScreen.test.js: tests = 178/178 pass; asserts = 1434/1434 pass
node apps/app/test/pageMoment.test.js: tests = 17/17 pass; asserts = 98/98 pass
node apps/app/test/profileActions.test.js: tests = 10/10 pass; asserts = 38/38 pass
node apps/app/test/profileExtraView.test.js: tests = 24/24 pass; asserts = 269/269 pass
node apps/app/test/profilePolish.test.js: tests = 15/15 pass; asserts = 79/79 pass
node apps/app/test/dm.test.js: tests = 62/62 pass; asserts = 584/584 pass
node apps/app/test/videoCompose.test.js: tests = 33/33 pass; asserts = 227/227 pass
```

Outros comandos:

- `npm run lint`: código 0.
- `npm run demo`: código 0, terminou com `DEMO OK`.

A suíte completa (`npm test`) roda na CI do GitHub, no Node 20 e no 24.

Os pinos de `momentosScreen.test.js` que saíram eram da interface removida (títulos de "Seus momentos" e "Momentos anteriores", o portão da seção do Diário, o Apagar atrás do menu); cada um foi trocado por um pino de ausência ou do comportamento novo, e o arquivo continua com o mesmo número de blocos `test(`.

Testes que falham sem o que conferem (a mudança foi desfeita numa cópia e restaurada byte a byte):

- `MOMENT_UNCERTAIN` com o texto antigo: o pino do novo texto em `momentosScreen.test.js` falha.
- Folha do Diário mostrando "Você ainda não escreveu o Sobre mim." sem esperar a leitura terminar: `diarioSlim.test.js` falha (46/48).

## Riscos residuais aceitos

1. **Sem apagar à mão um momento vencido.** Sem "Momentos anteriores", um momento próprio vencido não tem mais como ser apagado à mão: entre 24 h e 48 h depois de publicado, e quando o apagamento automático desistiu depois de três tentativas em cada aparelho. Decisão da manutenção ao tirar a lista.
2. **Aviso incerto numa Página.** Uma Página que publica um momento e recebe resposta incerta sem poder tentar de novo vê o aviso que aponta para o anel da foto no Diário, e não para Ajustes da página. O texto anterior também não servia para esse caso.
3. **Leitura por perfil aberto.** Membro pede `moments.read` a cada perfil aberto no nó hospedado, mesmo de quem a pessoa não segue, para decidir o anel.

## Verificações em dispositivos, não executadas

Ordem: build de debug do Android (emulador ou aparelho) e simulador iOS primeiro, depois web e PWA. Cada item em larguras de 320, 360 e 393 pt, no tema claro e no escuro, e com o maior tamanho de texto do sistema.

1. **Anel na foto do Diário: NÃO EXECUTADO.** Sem momento no ar, a foto aparece sem o anel de momentos. Com um momento não visto, anel pôr do sol; depois de ver todos, anel de contorno. Um toque na foto com anel abre o visualizador dos próprios momentos; sem anel, o toque não abre nada.
2. **Anel na foto de um Membro: NÃO EXECUTADO.** Os mesmos três estados num perfil que a pessoa segue. Num perfil que ela não segue, e num perfil bloqueado, nunca aparece anel. O toque abre o visualizador daquela pessoa.
3. **Visualizador: NÃO EXECUTADO.** "Novo momento" no visualizador dos próprios momentos abre o compositor no modo Momento. Apagar um momento próprio ainda no ar tira o momento do visualizador, e o anel some quando era o último.
4. **Disco de compartilhar: NÃO EXECUTADO.** Ao lado de "Editar perfil" no Diário; com o texto do sistema acima de 1,3 vez, ele passa para a coluna de ações sem cortar nem sobrepor.
5. **"Sobre mim ›" no Diário: NÃO EXECUTADO.** O link aparece sob a bio, com até dois dados (cidade, trabalho, estudos, aniversário) como dica. A folha mostra os dados "Sobre mim", os melhores amigos e a Sorte do dia. Conferir com só bio, só "Sobre mim", os dois e nenhum: a bio fica no corpo do perfil e "Sobre mim" só na folha, como dois registros separados. Enquanto a leitura não termina, a folha não diz que o Sobre mim está vazio; com a leitura falhando (offline, por exemplo), diz "Não deu para ler o seu perfil agora.". Em melhores amigos, tocar numa pessoa fecha a folha e abre o perfil dela; "Editar" fecha a folha e abre a edição.
6. **Sorte do dia num nó que não hospeda: NÃO EXECUTADO.** A Sorte continua na folha mesmo sem o perfil rico (num nó que não hospeda), e os melhores amigos não aparecem.
7. **"Sobre ›" num Membro: NÃO EXECUTADO.** A folha mostra os dados, os melhores amigos e "Avaliações" com o resumo. O link só aparece quando há algo para mostrar. Num perfil bloqueado, "Avaliações" some da folha e da dica, e os atalhos não aparecem.
8. **Atalhos: NÃO EXECUTADO.** No Diário: Posts salvos, Eventos, Visitas, Recados e Varandinha, cada um só quando já aparecia antes, e cada um abre a mesma tela de antes. Num Membro: Anúncios, Recados, Varandinha e Eventos, nas mesmas condições. Com o maior tamanho de texto, a faixa rola de lado sem cortar o texto dos chips nem os alvos de toque de 44 pt.
9. **Botão de fã: NÃO EXECUTADO.** Com uma resposta incerta de "Ser fã", o aviso com "Conferir" continua visível e funcionando no perfil enxuto.
10. **Abas fixas: NÃO EXECUTADO.** Ao rolar, a barra de abas fica presa no alto; trocar de aba pela barra presa leva ao conteúdo da aba certa nos dois perfis.
11. **Momentos de uma Página: NÃO EXECUTADO.** Em Ajustes da página, a lista dos momentos da Página aparece antes de Pessoas, com apagar funcionando. Com a leitura falhando (offline, por exemplo), aparece o aviso de leitura e nada quebra. Uma Página encerrada ou movida não mostra a lista.
12. **Compositor: NÃO EXECUTADO.** Com uma resposta incerta ao publicar um momento, o aviso diz para conferir no anel da foto, no Diário.

Não executados: builds, emulador, simulador, navegador e a suíte completa local (`npm test`, que roda na CI do GitHub). Nenhuma rede externa foi usada.
