# Varandinha no app (PR feat/varandinha-app)

Este arquivo confere as telas Varandinha e Varandas da rua, onde o nó é hospedado (web hospedada e app instalado). Use duas contas, A e B, em aparelhos ou navegadores diferentes; B segue A. Só as caixas marcadas foram executadas. Comece pelo Android, depois o iPhone e a web.

## Testes

- [x] `npm test -w apps/app -- test/nav.test.js test/tabBar.test.js test/platformGate.test.js test/stableHandlers.test.js test/vitrine.test.js test/vitrineGuard.test.js test/composePolish.test.js test/screensPolish.test.js test/themeUsage.test.js`: 9 arquivos, 0 falha.
- [x] `npm test -w apps/app -- test/garden.test.js test/varandinhaView.test.js` (com as telas presentes): 0 falha.
- [x] `npm test -w apps/app -- test/legal.test.js test/terms-version.test.js`, `npm test -w apps/site` e `npm test -w packages/core -- test/terms.test.js`: 0 falha.
- [x] `node apps/site/scripts/render-legal.js --check`: as duas páginas iguais à saída do gerador.
- [x] `npx standard` nos arquivos alterados.

## CI completa

- [x] `npm run lint`
- [x] `npm test -- --affected=origin/main`: 844 arquivos de teste, 0 falha (Node 24). A primeira rodada falhou em `apps/app/test/feiraCompose.test.js`, que fixava o texto antigo de `backGuardRef`; o teste agora fixa o conjunto de guardas e passou.
- [x] `npm run demo` termina com "DEMO OK"

## No aparelho

Limite conhecido: o build de debug (`app.varanda.debug`) não entra com passkey (AGENTS.md); por isso Android e iOS usam o Modo Vitrine, com `EXPO_PUBLIC_VARANDA_VITRINE=1`, depois de `npm run prepare:native -w apps/app`. Nunca `expo prebuild`. O fluxo com rede e duas contas se confere na web.

### Android (emulador, build de debug, Vitrine, Metro 8105), cada item com captura de tela

- [x] A Varandinha abre pelo Diário com dados de exemplo e sem rede: seis vasos em estágios diferentes, "Quem regou" com dois nomes e a linha Varandas da rua.
- [ ] A entrada por Ajustes (abaixo de Visitas) não foi aberta no aparelho; a linha e o handler são conferidos por `composePolish.test.js` e `nav.test.js`.
- [x] Vaso vazio: a folha lista as seis plantas; plantar mostra a barra "1 ação por guardar". Guardar grava (aviso "Varanda guardada.") e Descartar esvazia a fila sem gravar.
- [ ] Regar o próprio vaso e colher não foram tocados no aparelho; o redutor é o mesmo de `rpc.garden.applyActs`, coberto por `apps/app/test/garden.test.js`.
- [x] Varandas da rua lista as duas varandas de exemplo; abrir uma mostra de quem é a varanda (avatar e nome) e a linha de contagem.
- [x] Regar a varanda de um vizinho: aviso "Você regou esta varanda." e o botão some; um vizinho já regado hoje não oferece Regar.
- [x] Sair da Varandinha pede confirmação, com o texto inteiro; depois a tela mostra o estado desligado com Começar. O aviso de participação mostra as cinco linhas, a chave começa desligada e Começar fica inativo até ligar. Ligar de novo volta com os vasos vazios.
- [x] Com "1 ação por guardar", o Voltar do Android abre "Sair sem guardar?". "Continuar na varanda" mantém a fila; Voltar e "Descartar e sair" voltam ao Diário.
- [x] Varandas da rua, já com o filtro pela própria lista de quem a pessoa segue, lista Cecília e André, que a conta de exemplo segue.
- [ ] Sair enquanto Guardar ainda está gravando não foi conferido no aparelho (a tela sai sem perguntar; correção abaixo).
- [x] Escuro e claro; texto grande (escala de fonte 1,3) sem corte; movimento reduzido para o balanço das plantas prontas. No Android o React Native lê `transition_animation_scale`, não só `animator_duration_scale`: com só a segunda em 0 as plantas continuavam balançando. As configurações do emulador voltaram ao normal depois.

### iOS (simulador iPhone 17 Pro, build de debug, Vitrine, Metro 8105), cada item com captura de tela

- [x] A Varandinha abre pelo Diário com os dados de exemplo; a entrada por Ajustes não foi aberta.
- [x] Plantar mostra a barra "1 ação por guardar", acima do indicador de início do iPhone; Guardar esvazia a fila.
- [x] Varandas da rua lista as duas varandas; a varanda de um vizinho mostra de quem é e "1 vizinho regou".
- [x] Um vaso pronto não oferece Regar, e a linha diz "pronta · terra seca", sem repetir "pronta".
- [x] A varanda de Cecília, que a conta de exemplo já regou hoje (registro dos dados de exemplo), não oferece Regar. A de André oferece; regar mostra o aviso e a contagem passa a "1 vizinho regou" na hora.
- [x] Sair pede confirmação; o estado desligado mostra Começar; o aviso de participação mostra as cinco linhas, com a chave desligada, no escuro e no claro.
- [ ] Texto grande e movimento reduzido não foram conferidos no iOS (conferidos no Android).

### Web (Vitrine no navegador, Metro 8105)

- [x] 375x812 e 1280x800, escuro: a varanda abre pelo Diário; plantar mostra a barra (em 375 o texto "1 ação por guardar" quebra em duas linhas e cabe); Guardar esvazia a fila depois da pequena espera da Vitrine. Em 1280 a tela fica na coluna central.
- [ ] Claro na web: o app usa o tema salvo e não seguiu o esquema emulado; o claro foi conferido no Android e no iOS.
- Observação: um clique da automação durante a subida da folha de um vaso caiu no vaso 1, atrás da folha, e um clique seguinte completou esse toque e abriu a folha do vaso 1. Vem da folha compartilhada (`ui/Sheet`) no react-native-web, não desta tela; não foi corrigido aqui.

### Web (`apps/cli/scripts/hosted-lab.js`, duas contas), não executado

- [ ] A opta pelo jogo, planta e usa Guardar.
- [ ] B, que segue A, rega a varanda de A uma vez.
- [ ] A segunda rega de B no mesmo dia é recusada.
- [ ] A vê o nome de B em "Quem regou".
- [ ] Uma conta que não segue A é recusada ao regar.
- [ ] Sair marca os registros do jogo como apagados (`diary.peek`).
- [ ] Os Termos e a Privacidade estão na versão 78 e pedem novo aceite.
- [ ] Núcleo: no `varanda-serve` e no app com configuração manual, a tela não oferece o jogo.

O fluxo com rede é coberto por `packages/web-member/test/garden-e2e.test.js` (PR feat/varandinha-node), com um semeador local.

## Correções feitas durante a conferência

- A Vitrine responde no relógio de demonstração (`fixtures.now`); sem ajuste, toda planta de exemplo aparecia pronta e nenhuma rega cabia na janela. `apps/app/src/gardenClock.js` lê esse relógio só em bundles da Vitrine, e as datas de `garden.state` na Vitrine ficam no mesmo relógio (`vitrine/request.js`).
- A barra "N ações por guardar" ficava sob a barra de gestos do Android: ganhou a margem inferior da área segura.
- A varanda de outra pessoa não dizia de quem era: ganhou uma linha com avatar e nome no topo.
- O aviso de participação mostrava só quatro das cinco linhas e deixava de fora a linha sobre sair.
- A folha de um vaso pronto dizia "pronta" duas vezes.
- Regar aparecia na varanda de quem a pessoa já tinha regado hoje, ou depois do limite do dia, e o nó recusava. A tela agora usa a mesma regra do nó (`rpc.garden.helpAllowed`) sobre as regas que `garden.state` lista.
- Depois de regar, a contagem ainda dizia "Ninguém regou ainda" até a próxima leitura do índice; agora conta a rega confirmada na hora (uma rega incerta não conta). Uma rega incerta se resolve na próxima leitura da varanda: `garden.state` a lista quando foi gravada, e Regar some.
- Com ações por guardar, a seta do topo perguntava antes de sair, mas o Voltar do Android e o Esc na web saíam sem perguntar. Agora os três perguntam. App.js guarda um conjunto de guardas de volta, e cada um só responde quando a sua tela está no topo. Enquanto Guardar ainda está gravando, sair não pergunta nada: a jogada já foi para o nó, e a pergunta diria, sem razão, que ela seria descartada.
- Varandas da rua mostrava qualquer chave que o semeador listasse. Agora só aparece quem está na própria lista de quem a pessoa segue (`follow.list`, lida de novo a cada primeira página). Se essa leitura falha, a tela mostra o erro e nenhuma lista (`streetKeys` em `src/garden.js`, com teste).

## Limites

- O gesto de voltar deslizando no iPhone e o Voltar do navegador não consultam a guarda e saem sem perguntar, como já acontece em Anunciar. As ações na fila não são gravadas nesse caso: nada é enviado ao sair.

## Ordem de implantação

1. Semeadores (as rotas `/index/garden/<dono>` e `/index/garden/<dono>/rua`).
2. O nó hospedado da web.
3. Os apps.
