# fix/publicar-event-scroll

Fecha #918. Só o app.

## O que mudou

- `apps/app/src/screens/Publicar.js`: `contentChangeScrolls` (puro, exportado) decide se uma mudança de tamanho do conteúdo move a rolagem. `useKeepInView` só reposiciona o campo quando o conteúdo mudou junto com a altura do campo (digitação); um editor que abre abaixo dele cresce o conteúdo sem mexer no campo e não rola mais. Causa: com o campo em foco, esse crescimento refixava o campo perto do topo, parando no meio da troca Publicação/Momento.

## Testes (`apps/app/test/momentosScreen.test.js`)

- `Publicar: an editor opening below the field does not re-pin the draft scroll (#918)`: falha sem a correção (a função não existe).

## Não conferido

- Emulador Android e simulador iOS: não rodados nesta sessão.
