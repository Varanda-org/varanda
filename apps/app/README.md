# @varanda/app

O aplicativo Varanda para iOS, Android e web (Expo e React Native), com a interface de membro em português. O nó roda num worklet Bare dentro do app nativo; na web, o nó roda no próprio navegador (o `@varanda/web-member`, carregado como `/varanda-node.js`) ou, quando a página é aberta no endereço do `varanda-serve`, a interface fala com ele. Pacote privado do monorepo.

Pontos de entrada:

- `index.js` e `App.js`: a raiz do app, as três abas (A Rua, Seguindo, Diário), o botão de publicar e as folhas (Publicar e Ajustes).
- `src/screens/`: as telas (A Rua, Seguindo, Diário, Publicar, Perfil, e Ajustes com Conexão, Sincronizar e Identidade); `src/node.js` guarda a conexão e o estado da sincronização; `src/config.js` valida a configuração.
- `src/ui/`: o kit de interface (`theme.js` com cores e tipografia, `PostRow`, `Sheet`, `TabBar`, `TopBar`, `SyncChip`, `Avatar`, `Fab`, `Pill` e outros), descrito em [apps/site/artwork/app-design.md](../site/artwork/app-design.md).
- `src/format.js`: os ajudantes puros de exibição (iniciais, cor do avatar, tempo relativo), com testes (`test/format.test.js`). `src/names.js`: o cache de perfis da sessão (`profile.read` em lote).
- Lógica pura, sem React, cada uma com seu teste em `test/`: `src/who.js` (a regra de nomes: nome, @nome ou "sem nome"; `who.test.js`), `src/paging.js` (cursores e junção das páginas; `paging.test.js`), `src/syncSignals.js` (as linhas de sincronização viram dicas e o estado do chip; `syncSignals.test.js`), `src/pull.js` (a matemática do gesto de puxar; `pull.test.js`), `src/autoSyncPolicy.js` (quando iniciar a sincronização automática e o backoff; `autoSyncPolicy.test.js`) e `src/onboarding.js` (a máquina dos três passos da primeira configuração; `onboarding.test.js`).
- Componentes novos em `src/ui/`: `RefreshableList.js` (lista com rolagem infinita, puxar para atualizar e a pílula "ver novidades"), `States.js` (carregando, vazio e erro) e `Stepper.js` (o passo "Passo n de 3").
- `src/client/`: o cliente do nó. No app nativo, `connect.native.js` usa o worklet (`native.js`, o único que importa `react-native-bare-kit`); na web, `connect.web.js` usa `browser.js` (carrega o nó do navegador e fala com ele em memória) ou, no modo `varanda-serve` (`mode.js`), `web.js`, que fala com o `varanda-serve` por WebSocket. Nenhum dos dois importa o worklet, e o Metro bloqueia `packages/core` e `packages/web-member`.
- `worklet/main.js`: o código que roda no Bare e serve a sessão do `@varanda/core` por IPC.
- `src/gate/` e `scripts/gate-server.js`: a prova do nó no simulador iOS ([docs/ios-gate.md](../../docs/ios-gate.md)).

Comandos (a partir da raiz, com `-w apps/app`, ou aqui dentro): `npm run link:addons`, `npm run pack:worklet`, `npm run ios`, `npm run android`, `npm run build:node` (gera `public/varanda-node.js`, o nó do navegador; ignorado pelo git), `npm run web` e `npm run export:web` (os dois rodam `build:node` antes), `npm run start`, `npm run gate`, `npm test` (os testes em `test/`: as regras dos formulários de conexão, os ajudantes de exibição e a lógica pura listada acima). Depois de qualquer `npm install`, rode `link:addons` de novo antes de um build nativo.

Os PNGs do ícone e da tela de abertura são gerados a partir de `apps/site/artwork/logo` por `apps/site/scripts/render-assets.js`; nunca os regenere com `expo prebuild`, que sobrescreveria as correções de segurança feitas à mão em `ios/` e `android/`.

Documentação: [docs/app.md](../../docs/app.md) (o que o app faz e as telas) e [docs/development.md](../../docs/development.md) (como construir). O contrato com o nó está em [docs/rpc.md](../../docs/rpc.md).
