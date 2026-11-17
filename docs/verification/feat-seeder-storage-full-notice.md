# Aviso de semeador sem espaço (branch feat/seeder-storage-full-notice)

Fecha a #33. O orçamento do semeador e o motivo `storage-full` vêm do PR `feat/seeder-storage-budget`; este PR só muda o app (`apps/app`).

## O que muda

- `src/syncSignals.js`: o estado das linhas de sincronização ganha `storageFull`. Uma linha `rejected <diário próprio> storage-full` liga; `admitted <diário próprio> <n>` ou uma recusa por outro motivo desliga. Os nós (core e navegador) só imprimem `rejected` e `admitted` para o diário próprio, e só quando quem responde é o semeador verificado (`packages/core/lib/sync.js` e `packages/web-member/lib/sync.js`). O valor sobrevive ao fim e ao começo de uma sincronização, porque a recusa encerra a sincronização e a próxima só começa depois de uma espera. Uma linha de outra sincronização é ignorada, como as demais. `storageFullShown({ online, signals })` decide o aviso: sem rede, ele espera, porque a última resposta do semeador é antiga.
- `src/node.js`: `useRunFlags` repassa `storageFull` às telas.
- `src/ui/StorageFullNote.js` (novo): o aviso fixo no lugar e no visual do aviso de sem rede (`NoteBar`, ícone de sincronização, `accessibilityRole='alert'`, região viva educada), sem botão e sem fechar.
- `App.js`: o aviso entra no topo logo depois do aviso de aparelho desconectado. No Diário ele leva o recuo da área segura; os avisos abaixo dele (convite, atualização, instalação e notificações) deixam de levar esse recuo enquanto ele aparece. A decisão é pela capacidade (as linhas do nó), sem `Platform.OS`.

## Comandos e resultados

Da raiz, um arquivo por vez, em 17/11/2026:

- `node apps/app/test/syncSignals.test.js`: 26 testes, 268 asserções, todos passam. O teste novo cobre: a recusa liga; o aviso aparece com rede ou sem informação de rede e espera sem rede; o valor fica depois de `sync.stopped` e de um novo `sync.started`; uma linha de outra sincronização é ignorada; a admissão desliga; uma recusa por outro motivo (`blocked`) desliga; uma recusa repetida não muda o estado (mesmo objeto); linhas malformadas são ignoradas; `signals` nulo não mostra.
- `node apps/app/test/storageFullNote.test.js` (novo): 2 testes, 21 asserções, todos passam. Compila `NoteBar`, `syncSignals` e `StorageFullNote` com o babel do app, como `push-shell.test.js`, e confere o texto, o ícone, a ausência de botão, o papel `alert` com região viva educada, o recuo de 30 com área segura de 24 e nenhum `Platform` no arquivo. No `App.js`, confere que o aviso é montado uma vez, depois do aviso de aparelho desconectado e antes do de convite, com a condição e o recuo exatos, que os cinco avisos abaixo dele têm `!storageNoteShown` no recuo, que `useRunFlags` repassa `storageFull` e que não há travessão.
- `node apps/app/test/platformGate.test.js`: 789 asserções, todas passam.
- `npx standard` nos arquivos alterados: sem apontamentos.

## Falha sem a correção

Cada peça tirada sozinha, com o código restaurado depois (`cmp` igual ao original):

- Sem ligar `storageFull` na recusa, o teste novo de `syncSignals.test.js` falha (10 asserções).
- Sem desligar na admissão, ele falha (2 asserções).
- Com o aviso mostrado sem rede, ele falha (1 asserção).
- Com `storageFull` zerado a cada `sync.started`, ele falha (2 asserções).
- Com o aviso de atualização mantendo o recuo da área segura sob o aviso novo, `storageFullNote.test.js` falha.
- Com o aviso nunca montado (`{false ? ...}`), `storageFullNote.test.js` falha.
- Com `useRunFlags` sem repassar `storageFull`, `storageFullNote.test.js` falha.

## Conferência humana

Ordem: Android, simulador iOS, web. Feita em 17/11/2026 no modo vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`, Metro servindo esta branch), porque o build de debug não entra com passkey numa conta de produção. Com o app aberto, o valor `signals.storageFull` do nó de mentira foi trocado para `true` pelo inspetor do Metro (Android e iOS) ou pelo console (web), e uma troca de aba fez a tela ler o valor novo. Depois o valor voltou para `false` da mesma forma.

- [x] Diário com o aviso: a faixa "O semeador está sem espaço e não está guardando seu diário agora." aparece no topo, abaixo da barra de status (Android) e da Dynamic Island (iOS), com o ícone de sincronização, sem botão. Android: emulador API 36, build de debug `app.varanda.debug`. iOS: simulador iPhone 17 Pro, iOS 26.2. Web: painel de navegador do app de desktop (Chromium), largura de celular (375 x 812).
- [x] A Rua com o aviso: a faixa aparece logo abaixo da barra de título, sem recuo extra. Android, iOS e web.
- [x] Na web o elemento tem `role="alert"` e `aria-live="polite"`, e é o único alerta da tela.
- [x] Com o valor de volta a `false`, a faixa some (Conversas, nas três plataformas; na web, nenhum `role="alert"` e nenhum texto do aviso na página).
- [ ] O caminho completo num aparelho: um semeador real com orçamento pequeno recusa o diário próprio de uma conta com passkey, o aviso aparece, e some quando o semeador volta a ter espaço. Fica para a lista do #224.

## Não verificado / limites conhecidos

- O caminho do semeador até a linha do nó é coberto pelos testes do PR `feat/seeder-storage-budget` (o `rejected storage-full` chega a todos os pares) e pelo formato existente da linha (`packages/core/lib/sync-format.js`). O caminho da linha até o aviso é coberto pelos testes acima. Os dois juntos num aparelho com conta real não foram conferidos.
- Tema claro, texto grande e iPad não foram conferidos.
- Uma recusa `storage-full` de um par que não é o semeador verificado não liga o aviso: o nó do celular a trata como retirada (`withdrawn`) e o nó do navegador a ignora, sem linha `rejected`.
- Uma recusa por `timeout` desliga o aviso (é uma recusa por outro motivo); se o semeador continuar sem espaço, a próxima resposta liga de novo.
