# feat/native-social-push

Sobras de #47 e #77: avisos sociais e de convite de surpresa no app instalado (APNs e FCM).

## O que mudou

- `apps/cli/lib/account/push-routes.js`: `deliver` (seguir, resposta, citação, menção, curtida, republicação) e `notifyInvite` passam a incluir as linhas nativas de quem aceitou os Termos 111 (`NATIVE_SOCIAL_TERMS`), na mesma fila, com o mesmo cooldown, tetos, atraso, recolhimento ao desfazer e retirada ao ler. `deliverNative` manda o tipo `social` com "Você tem um aviso novo na Varanda" ou `invite-drop` com "Chegou um convite pra sua varanda", e a etiqueta do aparelho derivada da etiqueta web (`varanda-invite-drop` no convite). Nunca o autor, o nome, a `ref` ou o destinatário. O `g` do aviso nativo social e de convite é o momento do envio, não o de entrada na fila: este vem antes do atraso aleatório e deixaria a Apple ou o Google cruzar o aviso com o registro público. Os Termos são conferidos de novo no envio, e um convite passado do prazo é descartado antes do envio nativo. `room()` passa a aceitar qualquer transporte usável, mas continua 0 com a Web Push configurada e o armazenamento dela indisponível, para não gastar a vaga de quem só tem navegador.
- `apps/cli/lib/account/invite-drops.js`: o lote de convites de surpresa reserva espaço na fila para todos os navegadores e todos os aparelhos nativos de cada pessoa (`JOBS_PER_SLOT` passa de 4 para `PUSH_MAX_PER_MEMBER + PUSH_DEVICE_MAX_PER_MEMBER`, hoje 8). Com 4, uma vaga reservada para quem tem navegadores e aparelhos podia não caber na fila e se perder, e uma vaga reservada nunca se tenta de novo.
- `apps/cli/lib/account/apns.js` e `fcm.js`: aceitam os tipos `social` e `invite-drop`; no FCM eles vão pelo canal `avisos`.
- `apps/app/modules/push-device` (JS, Swift, Kotlin): o toque aceita `social` e `invite-drop`; o Android cria o canal "Avisos".
- `apps/app/src/pushDevice.js` e `App.js`: `social` abre Avisos (limpa a pilha e recarrega), `invite-drop` abre Convidar pessoas.
- `apps/app/src/push-state.js` e `Ajustes.js`: no nativo, a frase de Avisos no aparelho diz que o aviso não mostra quem fez a ação.
- Termos e Política, versão 111 (`legal.js`, `terms.js`, páginas do site): descrevem esses avisos, o que a Apple e o Google recebem e que eles não passam pela lista de bloqueios.

## Bloqueios

A lista de bloqueios da pessoa vai cifrada no blob de marcações: o serviço de conta não a conhece, e na web quem filtra é o service worker. O módulo nativo não roda código antes de o sistema mostrar o aviso (iOS sem extensão de serviço de notificação, Android com mensagem de notificação). Por isso o aviso social nativo não nomeia ninguém e pode sair por uma ação de alguém bloqueado; a lista de Avisos continua sem essa pessoa. Filtrar no aparelho fica para um passo seguinte (extensão no iOS, mensagem de dados no Android).

## Testes

- `apps/cli/test/account-push-device.test.js`: `social and invite stay web-only below the native social Terms`, `social and invite carry a fixed sentence, a keyed tag and nobody`, `social Terms are checked again at send, invites past the deadline drop`, `social and invite alerts carry the dispatch time, not the queue time`, `invite room needs a usable transport`.
- `apps/cli/test/apns.test.js`, `fcm.test.js`: os tipos novos e o canal `avisos`.
- `apps/cli/test/invite-drops.test.js`: `the batch follows room(): 0 takes nothing, 15 takes one slot` (com espaço 7, nenhuma vaga).
- `apps/app/test/push-device-android.test.js`: a lista de tipos aceitos no toque e o canal "Avisos".
- `apps/app/test/pushDevice.test.js`, `hardening.test.js`, `push-state.test.js`, `push-switch.test.js`, `legal.test.js`, `apps/site/test/legal.test.js`, `packages/core/test/terms.test.js`.

## Falha sem a correção

Com o `push-routes.js` da `main`, `account-push-device.test.js` para no teste da frase fixa (nenhum envio nativo, `TypeError` ao ler `s.calls[0]`). Com a correção: 33/33 testes, 250/250 asserções.

Enviando o `g` da fila, o teste do momento do envio falha; sem a checagem do armazenamento da Web Push em `room()`, `a broken web store claims nothing` falha. Com as correções: 34/34.

Com `JOBS_PER_SLOT = 4`, `invite-drops.test.js` falha em `a slot needs room for four browsers and four native devices` (26/27). Com a correção: 27/27.

## Comandos

```sh
npm run lint
node apps/cli/test/account-push-device.test.js
node apps/cli/test/apns.test.js
node apps/cli/test/fcm.test.js
node apps/cli/test/account-push.test.js
node apps/cli/test/push-e2e.test.js
node apps/cli/test/invite-drops.test.js
node apps/cli/test/account-invites.test.js
node apps/app/test/pushDevice.test.js
node apps/app/test/push-device-android.test.js
node apps/app/test/legal.test.js
npm run demo
```

## Limites

- Entrega real pela APNs e pelo FCM não conferida: exige as chaves do operador e aparelhos com o build de produção.
- Toque no aviso não conferido no simulador iOS nem no emulador Android (o módulo nativo muda só a lista de tipos aceitos e o canal do Android).
- O texto dos Termos 111 é rascunho e precisa da aprovação do mantenedor.
- O aviso nativo não leva o prazo à APNs nem ao FCM (sem `apns-expiration` nem `ttl`, como os avisos de conversa): um aparelho desligado pode receber o convite depois das 21h ou um aviso social depois de 24 h.
