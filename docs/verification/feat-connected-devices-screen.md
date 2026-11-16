# Tela de aparelhos conectados (branch feat/connected-devices-screen)

Parte da #350.

## O que mudou

Só o app (`apps/app`). O nó (`device.hello`, `device.list`, `device.disconnect`, `device.reconnect`) vem do PR `feat/connected-devices`, e o efeito do corte na leitura dos diários vem do PR `feat/diary-writer-cut`.

- `src/devices.js` (puro): textos, o nome curto do aparelho (`deviceName`, no máximo 40 caracteres), a forma da lista (`shapeList`), "Conectado desde dd/mm/aaaa", a decisão de capacidade (`unknownMethod`) e o estado compartilhado (`createDeviceStore`, `readDevices`, `sendHello`, `reconnectDevice`, `helloDue`).
- `src/useDevices.js`: o hook do estado e a leitura do ambiente (user agent e constantes da plataforma) para o nome.
- `src/screens/Aparelhos.js`: a tela. "Este aparelho" primeiro, os outros conectados, "Aparelhos anteriores" quando o nó informa, e os desconectados por último, sem ação. "Desconectar" abre uma folha de confirmação e nunca repete sozinho.
- `src/ui/DeviceOffNote.js`: o aviso fixo de aparelho desconectado, com "Conectar de novo" (um toque, uma chamada).
- `src/screens/Ajustes.js`: a entrada "Aparelhos conectados", só quando o nó respondeu `device.list`. Um "método desconhecido" (ou nenhuma resposta ainda) esconde a entrada.
- `App.js`: depois do desbloqueio, um `device.hello { name }` por abertura e por conta, sem repetir em caso de falha; o aviso fixo quando este aparelho está desconectado.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho. Conferem o código, não montam a interface num aparelho.

```sh
node apps/app/test/devices.test.js
node apps/app/test/platformGate.test.js
```

`devices.test.js` cobre: `deviceName` (navegador e sistema, constantes de Android e iOS, limite de 40, caracteres de controle, nome vazio), `unknownMethod`, `sinceDate` e `sinceText`, `shapeList` (este aparelho, outros, desconectados, anteriores, respostas malformadas), os rótulos e `disconnectParams`, `createDeviceStore`, `readDevices` (método desconhecido esconde a entrada, outra falha não), `sendHello` (uma chamada, silencioso, sem repetir), `reconnectDevice` e `helloDue`.

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar.

## Conferência humana

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador, e o resultado de cada item. Precisa do nó com o PR `feat/connected-devices`.

- [ ] Abrir Ajustes > Aparelhos conectados com dois aparelhos da mesma passkey: "Este aparelho" aparece primeiro com o nome, o outro aparece com o nome e "Conectado desde dd/mm/aaaa". Android, iOS, web: pendente.
- [ ] Desconectar o outro: a folha explica o efeito, cancelar não muda nada, confirmar mostra "Aparelho desconectado." e o aparelho passa para "Desconectados", sem ação. Pendente.
- [ ] No outro aparelho: o aviso "Este aparelho foi desconectado da conta" aparece, com "Conectar de novo". Um toque reconecta, o aviso some e o aparelho volta à lista com um registro novo. Pendente.
- [ ] Sem nó que ofereça `device.list` (nó antigo): a entrada não aparece em Ajustes. Pendente.
- [ ] Falha ao desconectar: aparece o texto do nó; numa falha incerta, a mensagem diz que pode ter sido feito em parte e pede para conferir a lista. Nada é repetido sozinho. Pendente.
- [ ] "Aparelhos anteriores" aparece só quando há aparelhos de antes da lista, com a explicação, e "Desconectar" funciona. Pendente.
- [ ] Texto grande, tema claro e escuro, largura de celular e alvos de 44 pt. Pendente.

## Não verificado / limites conhecidos

- Depende do PR do nó (`feat/connected-devices`) e do PR do corte no diário (`feat/diary-writer-cut`): sem eles a entrada fica escondida.
- Nada foi montado num aparelho nem no navegador; a interface só passou por lint e pelos testes das partes puras.
- O nome do aparelho vem do user agent (web) ou das constantes da plataforma (celular), sem dependência nova: num Android o modelo vem de `Platform.constants.Model`, num iPhone o nome é só "iPhone" ou "iPad".
- Os Termos e a Privacidade ainda não falam desta lista: a versão sobe na hora do merge.
