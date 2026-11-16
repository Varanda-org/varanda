# Tela de aparelhos conectados (branch feat/connected-devices-screen)

Parte da #350.

## O que mudou

Só o app (`apps/app`). O nó (`device.hello`, `device.list`, `device.disconnect`, `device.reconnect`, o evento `devices.changed { off }`, a regra de passkey do `device.reconnect` e a recusa de `device.disconnect` num aparelho desconectado) vem do PR `feat/connected-devices`, e o efeito do corte na leitura dos diários vem do PR `feat/diary-writer-cut`.

- `src/devices.js` (puro): textos, o nome curto do aparelho (`deviceName`, no máximo 40 caracteres), a forma da lista (`shapeList`), as legendas ("Conectado desde dd/mm/aaaa" ou "Desconectado"), as decisões (`deviceMemberOf`, `devicesRowShown`, `shouldForceLock`, `notePasskeyUnlock`, `deviceStep`, `helloDue`, `unknownMethod`) e o estado compartilhado (`createDeviceStore`, preso a uma conta, com `readDevices`, `sendHello` e `reconnectDevice`).
- `src/deviceEnv.web.js` e `src/deviceEnv.native.js`: a leitura do ambiente (user agent e pontos de toque na web, constantes da plataforma no celular) para o nome. `src/useDevices.js`: o hook do estado.
- `src/screens/Aparelhos.js`: a tela. "Este aparelho" primeiro, os outros conectados, "Aparelhos anteriores" (no plural) quando o nó informa, e os desconectados por último, sem ação e com a legenda "Desconectado". "Desconectar" abre uma folha de confirmação e nunca repete sozinho. A lista é lida de novo toda vez que a tela aparece. Com este aparelho desconectado, "Desconectar" fica desligado e a tela mostra o aviso com "Conectar de novo".
- `src/ui/DeviceOffNote.js`: o aviso fixo de aparelho desconectado, com "Conectar de novo" (um toque, uma chamada). Depois de uma falha o app lê `device.list` uma vez (uma leitura, não uma repetição) e o aviso usa palavras simples.
- `src/screens/Identidade.js`: a tela de entrada diz "Este aparelho foi desconectado da conta. Entre com a sua passkey para usar de novo." depois que o app trava o aparelho.
- `src/node.js`: o evento `devices.changed { off }` entra no estado compartilhado.
- `src/screens/Ajustes.js`: a entrada "Aparelhos conectados" aparece quando o nó oferece `device.list` (uma resposta de `device.list` ou de `device.hello` com sucesso; "método desconhecido" esconde) e a identidade está destravada, ou não tem passkey (nó core). Não depende de `hosted`.
- `App.js`: com a conta conhecida (passkey destravada, ou a chave do próprio nó sem passkey), um `device.hello { name }` por abertura e por conta, sem repetir em caso de falha. Quando a conta volta depois de um bloqueio (o estado foi apagado e o hello não é enviado de novo), uma leitura de `device.list` traz o "desconectado" de volta; o que o diário próprio sincroniza depois chega pelo evento `devices.changed`. Se o aparelho está desconectado e a identidade veio de uma sessão guardada (sem passkey nesta abertura), o app esquece a sessão e trava. Depois de destravar com a passkey nesta abertura, ele nunca mais trava nessa abertura (mesmo que uma reconexão no celular volte a dizer "sessão guardada") e mostra o aviso fixo. Se o `signOut` falhar, o aviso aparece mesmo assim.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho. Conferem o código, não montam a interface num aparelho.

```sh
node apps/app/test/devices.test.js
node apps/app/test/composePolish.test.js
node apps/app/test/platformGate.test.js
```

`devices.test.js` cobre: `deviceName` (navegador e sistema, iPadOS com user agent de Mac, constantes de Android e iOS, limite de 40, caracteres de controle, nome vazio), `unknownMethod`, as datas e legendas, `shapeList`, os textos do plural de "Aparelhos anteriores", o estado preso a uma conta (resposta de outra conta descartada, reinício ao trocar de conta, `forced` até o próximo desbloqueio, evento), `visibleDevices`, `readDevices` (método desconhecido esconde a entrada, uma falha mantém a lista anterior), `sendHello` (uma chamada, silencioso, sem repetir), `reconnectDevice` (um toque, uma chamada; falha lê a lista uma vez e repassa o erro), `reconnectFailure`, `deviceMemberOf`, `devicesRowShown`, `shouldForceLock` (sessão guardada trava; passkey nesta abertura e nó core só mostram o aviso), `notePasskeyUnlock`, `deviceStep` e o caminho trava, destrava com a passkey e lê de novo o estado. `composePolish.test.js` confere as linhas de Ajustes, a nova inclusa.

Na raiz, na ordem da CI, `npm run lint`, `npm test` e `npm run demo` têm de passar.

## Conferência humana

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e, na web, o navegador, e o resultado de cada item. Precisa do nó com o PR `feat/connected-devices`.

- [ ] Abrir Ajustes > Aparelhos conectados com dois aparelhos da mesma passkey: "Este aparelho" aparece primeiro com o nome, o outro aparece com o nome e "Conectado desde dd/mm/aaaa". Android, iOS, web: pendente.
- [ ] Desconectar o outro: a folha explica o efeito, cancelar não muda nada, confirmar mostra "Aparelho desconectado." e o aparelho passa para "Desconectados", sem ação e com a legenda "Desconectado". Pendente.
- [ ] No outro aparelho, aberto com a sessão guardada: o app trava e a tela de entrada diz "Este aparelho foi desconectado da conta. Entre com a sua passkey para usar de novo." Os dados locais continuam. Pendente.
- [ ] Depois de entrar com a passkey nesse aparelho: o app não trava de novo e mostra o aviso "Este aparelho foi desconectado da conta" com "Conectar de novo". Um toque reconecta, o aviso some e o aparelho volta à lista. Em Aparelhos, enquanto desconectado, "Desconectar" fica desligado. Pendente.
- [ ] Falha ao conectar de novo (sem rede, por exemplo): o aviso fala em palavras simples, sem "incerto", e o app lê a lista uma vez. Pendente.
- [ ] Sem nó que ofereça `device.list` (nó antigo): a entrada não aparece em Ajustes. Num nó core (sem passkey) que oferece, a entrada aparece. Pendente.
- [ ] Falha ao desconectar: aparece o texto do nó; numa falha incerta, a mensagem diz que pode ter sido feito em parte e pede para conferir a lista. Nada é repetido sozinho. Pendente.
- [ ] "Aparelhos anteriores" aparece só quando há aparelhos de antes da lista, com a explicação, e "Desconectar" (no plural, na folha e na confirmação) funciona. Pendente.
- [ ] iPad com Safari: o nome sai como "Safari no iPad". Texto grande, tema claro e escuro, largura de celular e alvos de 44 pt. Pendente.

## Não verificado / limites conhecidos

- Depende do PR do nó (`feat/connected-devices`) e do PR do corte no diário (`feat/diary-writer-cut`): sem eles a entrada fica escondida. O evento `devices.changed` ainda precisa estar na lista de eventos do `@varanda/rpc` (vem no PR do nó).
- Nada foi montado num aparelho nem no navegador; a interface só passou por lint e pelos testes das partes puras.
- O nome do aparelho vem do user agent (web) ou das constantes da plataforma (celular), sem dependência nova: num Android o modelo vem de `Platform.constants.Model`, num iPhone o nome é só "iPhone" ou "iPad".
- O travamento usa o `signOut` da passkey (esquece a sessão guardada). Não há um caminho só de esquecer a sessão: o `signOut` também limpa o compartilhamento pendente e as marcas de momentos vistos deste aparelho ("os dados locais ficam" vale para o diário e as cópias). Ele não desliga as notificações do aparelho, como o "Sair" de Ajustes faz.
- Não há leitura depois da primeira sincronização: o primeiro fim de sincronização costuma ser o `preempted` causado pela escrita do próprio hello, então não é um sinal de que o diário alcançou. Fica o `devices.changed` e a leitura quando a conta volta.
- Os Termos e a Privacidade ainda não falam desta lista: a versão sobe na hora do merge.
