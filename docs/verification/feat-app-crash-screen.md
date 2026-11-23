# Tela de falha do app (branch feat/app-crash-screen)

Só app, em `apps/app/index.js`, `apps/app/src/crashReport.js`, `apps/app/src/crashSignal.js`, `apps/app/src/ui/CrashBoundary.js`, `apps/app/src/ui/dropPreSplash.web.js` e `.native.js`, e um efeito em `apps/app/src/node.js`. Sem mudança de RPC, formato ou Termos. `App.js` não muda.

## O que mudou

- `index.js` registra `withCrashBoundary(App)` no lugar de `App`. A ordem dos imports fica: `cryptoPolyfill` primeiro, `perfEntry` depois, `backgroundTask` antes de `App` e da tela de falha.
- `CrashBoundary` é um componente de classe com `getDerivedStateFromError`. Quando um render lança, guarda só o texto dos detalhes e mostra a tela: título "O Varanda parou", o pedido para fechar o Varanda e abrir de novo, a nota de que os detalhes dizem só a versão do app e o tipo do erro, o próprio texto dos detalhes e o botão **Copiar detalhes**, que copia por `copyText(shareNav(), ...)`, como Ajustes. O aviso "Detalhes copiados." ou "Não foi possível copiar." fica numa região viva.
- Ao pegar o erro, `componentDidCatch` chama `signalCrash()` (`crashSignal.js`, puro: roda cada ouvinte uma vez, engole o erro de cada um, e uma segunda chamada não faz nada). O provedor do nó em `node.js` registra `onCrash` num efeito passivo que fecha a conexão de `connRef`: a troca pela tela de falha desmonta o provedor, e nenhuma limpeza dele fechava a conexão, então um nó hospedado (web) seguia sincronizando por trás da tela, sem o caminho de parada por visibilidade. Efeito passivo, não de layout: numa subárvore apagada, a limpeza passiva roda depois do `componentDidCatch` da fronteira, então o ouvinte ainda está registrado. Antes de fechar, o ouvinte torna obsoleta a tentativa de conexão em andamento (`attemptsRef.current.begin()`, como em `forgetConfig`), então uma conexão que termina depois da falha cai no caminho `drop(conn)` e é fechada, em vez de ficar instalada com o provedor desmontado. Prova de regressão: sem essa linha, 1 teste de `crashSignal.test.js` falha. Depois da falha, nenhum nó começa nem fica: `connectNow`, o único lugar que chama `connectNode`, sai logo no início se `isCrashed()` e trata como obsoleta uma conexão que termina depois da falha (um `restart` ou `reconnect` que esperava o `close` antigo chama `connect` depois). Prova de regressão: sem a saída no início, ou sem `isCrashed()` em `obsolete`, o teste "no node starts or survives in connectNow after the crash" falha.
- Na web, quando a tela de falha entra (no `componentDidMount`, se o erro veio no primeiro render, ou no `componentDidUpdate`, se veio depois), o `#varanda-pre-splash` de `public/index.html` sai. Quem tira é `src/ui/dropPreSplash.web.js` (`getElementById` e `remove` em try/catch); o irmão `dropPreSplash.native.js` não faz nada, e a tela de falha, compartilhada, não toca no navegador (`platformGate.test.js` passa a ler `CrashBoundary.js`). Sem isso, um erro no primeiro render, antes do Splash assumir a camada, ficava escondido atrás dela até a expiração de 20 s do CSS.
- Cores fixas da paleta clara e espaço próprio no topo: a tela fica fora do `ThemeProvider` e do `SafeAreaProvider`.
- Sem botão de tentar de novo nem remontagem: o app mantém a árvore montada de propósito depois que o nó fica pronto, e remontar poderia abrir um segundo nó. Sem chamada de rede, sem SDK e sem ramo por `Platform.OS`. O código do app não registra o erro: o `componentDidCatch` não o recebe. O próprio React Native ainda escreve o erro pego no log do aparelho (`console.error` e, no build de release, o gerenciador de exceções nativo, que no Android vai para o logcat), como já fazia com o erro fatal antes desta mudança; na web, o React escreve no console do navegador.
- `crashReport.js` (puro): `crashDetails(erro, build)` devolve as linhas de versão de `versionDetails` (com `Servidor: desconhecido`, porque a tela não consulta o servidor) e `Erro: <nome>`. O nome só sai quando está na lista fechada (`Error`, `TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `EvalError`, `URIError`, `AggregateError`); qualquer outro nome, um getter que lança, um proxy ou um valor que não é objeto dá `Error`. Mensagem, pilha, `componentStack`, `cause`, props e estado da sessão nunca entram.

## Limite

A tela pega só erros de render do React. Falha ao carregar um módulo antes do primeiro render, travamento nativo e ANR não passam por ela: no Android, esses se leem em Android vitals, no Play Console.

## Testes

- [x] `apps/app/test/crashReport.test.js` (8 testes, 77 asserções): lista fechada, nomes hostis, getters que lançam, proxies, valores que não são `Error`, mensagem nunca presente, linhas de versão validadas, a tela guarda só os detalhes, e a camada pré-splash sai no mount e no update, pelo módulo da plataforma. Prova de regressão: com `crashName` devolvendo o nome sem a lista, 1 teste e 9 asserções falham; sem a remoção no `componentDidMount`, 1 asserção falha; sem o `StatusBar` escuro ou sem o `announce`, 1 asserção falha em cada caso; com `document` de volta em `CrashBoundary.js`, 1 asserção falha aqui e 1 em `platformGate.test.js`.
- [x] `apps/app/test/crashSignal.test.js` (10 testes, 24 asserções): uma vez por ouvinte, idempotente, um ouvinte que lança não para os outros, o cancelamento funciona, `isCrashed`, módulo puro, a fronteira sinaliza no `componentDidCatch` sem o erro, `node.js` fecha `connRef.current` num efeito passivo, e `connectNow` não começa nem mantém um nó depois da falha. Prova de regressão: sem o efeito em `node.js`, 1 teste falha.
- [x] `apps/app/test/platformGate.test.js` (6 testes, 867 asserções): `CrashBoundary.js` entra na lista das telas compartilhadas sem API do navegador.
- [x] `apps/app/test/backgroundTask.test.js`: o módulo da tarefa vem antes do app, da tela de falha e do registro, e a raiz registrada é `withCrashBoundary(App)`.
- [x] Arquivos de teste alvo, cada um sozinho com `node <arquivo>`, entre eles todos os de `apps/app/test` que leem `src/node.js` (nodeHandle, webnodeHandle, hostedContext, requestQueue, dm, sw e outros), platformGate, themeUsage, metroBlocked, hardening, perfMarks, uiKit, vitrine, vitrineGuard, buttonVariants, version e versionFooter (a guarda da leitura do commit passa a aceitar a tela de falha)
- [x] `npm run lint`, sobre `origin/main` 51e5f404
- [x] `npm run demo` (termina com "DEMO OK")

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## O que não foi conferido no aparelho

Primeiro o emulador Android, depois o simulador iOS, depois web e PWA, num build de debug com um erro de render forçado à mão (a injeção nunca entra no commit):

- [ ] A tela aparece no lugar do app, sem tela em branco
- [ ] TalkBack e VoiceOver: título como cabeçalho, botão **Copiar detalhes** e o aviso lido depois de copiar
- [ ] Fonte no maior tamanho: o texto rola e o botão continua à vista
- [ ] Contraste do texto e do botão
- [ ] Copiar e colar em outro app: o texto tem só as linhas de versão e `Erro: <nome>`, sem a mensagem do erro forçado
