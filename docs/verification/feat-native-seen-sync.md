# Sinal silencioso de leitura nos aparelhos

## O que muda

Os alertas nativos levam o horário `g` em que entraram na fila. Com `VARANDA_SEEN_SIGNAL=1` e aceite dos Termos 102 ou mais novos, o serviço pode enviar `seen-sync` aos aparelhos nativos, no mesmo agrupamento de 20 segundos e sob o mesmo teto por pessoa e por hora do sinal web. O sinal leva identificadores próprios de cada aparelho e um horário limite, sem texto de mensagem, remetente ou nome de grupo. Só fecha avisos correspondentes com horário conhecido que não passe desse limite. Abrir o app também fecha avisos já lidos, pelo identificador. Uma passagem de leitura acordada pelo sinal não fecha avisos pela leitura local guardada, que pode não conhecer uma mensagem nova; nesse caso quem fecha é o aparelho, com a checagem de horário. Os Termos e a Política explicam que a Apple ou o Google fica sabendo que o sinal chegou e quando, num horário que acompanha a leitura em outro aparelho.

## Testes automatizados

Aterrissagem em `06b32f16`, Node 24, local: `npm run lint` passou; os 179 arquivos de teste alcançados pelo diff contra `feat/app-native-push` passaram, cada um sozinho (4215 testes); `npm run demo` terminou com `DEMO OK`. O resto do diff contra `origin/main` é o de `feat/app-native-push` e `feat/native-push-transport`, conferido nas aterrissagens deles.

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/apns.test.js` | 14/14 | 192/192 |
| `apps/cli/test/fcm.test.js` | 15/15 | 217/217 |
| `apps/cli/test/push-device-store.test.js` | 32/32 | 1677/1677 |
| `apps/cli/test/account-push-device.test.js` | 31/31 | 229/229 |
| `apps/cli/test/account-push.test.js` | 86/86 | 2127/2127 |
| `apps/cli/test/push-e2e.test.js` | 2/2 | 84/84 |
| `apps/app/test/noticeClose.test.js` | 9/9 | 94/94 |
| `apps/app/test/noticeReadsWiring.test.js` | 11/11 | 117/117 |
| `apps/app/test/push-device-android.test.js` | 14/14 | 132/132 |
| `apps/app/test/hardening.test.js` | 36/36 | 447/447 |
| `apps/app/test/use-push-native.test.js` | 28/28 | 284/284 |
| `apps/app/test/vitrine.test.js` | 59/59 | 4575/4575 |
| `apps/app/test/platformGate.test.js` | 6/6 | 841/841 |
| `apps/app/test/legal.test.js` | 75/75 | 2390/2390 |
| `apps/site/test/legal.test.js` | 7/7 | 115/115 |
| `packages/core/test/terms.test.js` | 8/8 | 126/126 |

Regressão conferida removendo a correção: sem ela, a passagem acordada pelo sinal fecha o aviso de uma mensagem mais nova e `noticeReadsWiring.test.js` falha (10/11). O teste de `prebuild` em `hardening.test.js` confere que o modo `remote-notification` sai da configuração; o `prebuild` ainda acrescenta `fetch`, que o `Info.plist` mantido à mão deixa de fora.

## Builds nativos

Feitos sobre `4c98c9f4`; depois dele só mudaram arquivos JS, testes e documentos, e nenhum arquivo de `apps/app/ios`, `apps/app/android` ou `apps/app/modules`.

| Build | Comando | Resultado |
|---|---|---|
| Simulador iOS (arm64, Debug, sem assinatura) | `xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator ... CODE_SIGNING_ALLOWED=NO` | `BUILD SUCCEEDED` |
| Android debug | `./gradlew assembleDebug` (JDK 17) | `BUILD SUCCESSFUL`, sem `google-services.json` (caminho sem FCM) |

O `npm run prepare:native` reescreve o `Podfile.lock` e o `PrivacyInfo.xcprivacy`; os dois voltaram ao estado do commit depois do build.

## No aparelho

Conferências ainda devidas:

- No simulador iOS, preparar arquivos de payload para um alerta com `aps.alert`, `k`, `t` e `g` numérico e para um sinal silencioso `{"aps":{"content-available":1},"k":"seen-sync","c":["abcdefghijklmnop"],"a":1000}`. Usar a mesma tag no alerta e `g: 1000`. Enviar com `xcrun simctl push booted <bundle-id> <arquivo.json>`, primeiro o alerta, depois o sinal, e conferir o fechamento com o app em segundo plano. Repetir com `g: 1001`, sem `g`, com outra tag e com sinal inválido: os avisos devem ficar. Conferir também o recebimento em primeiro plano e o fechamento ao abrir o app.
- No emulador Android, conferir o alerta com `data.g` e `android.notification.event_time`, o sinal só com dados, o fechamento por tag e horário, a preservação de aviso mais novo, a rejeição de sinal inválido e o fechamento ao abrir o app. Conferir o atraso possível no modo Doze.
- Nos dois sistemas, com o app aberto e uma conversa marcada como lida, receber um aviso novo dessa conversa e depois um sinal de outra tag: o aviso novo deve ficar.
- Com as chaves do operador e builds adequados, conferir APNs e FCM reais, os cabeçalhos e a prioridade do sinal, o aceite mínimo 102, o sinal desligado, o agrupamento e o teto compartilhado com a web, nenhum envio com lista vazia e a remoção só do registro exato quando o provedor informa token inválido. Não guardar chaves nem tokens nos arquivos de payload ou no registro da verificação.
- No iOS real, forçar o fechamento do app, ler em outro aparelho e conferir que o sinal em segundo plano não fecha o aviso; reabrir o app e conferir o fechamento. A injeção pelo simulador não comprova a entrega pelo APNs.

## O que não foi conferido

- Nenhum simulador, emulador ou aparelho abriu o app; só os builds rodaram. Nenhuma entrega real APNs ou FCM, nem o caso de fechamento forçado. Os testes usam módulo, serviço e provedores falsos, sem rede externa.
- `expo prebuild` não foi rodado no repositório (proibido pelo AGENTS.md); o teste de `hardening.test.js` o roda numa pasta temporária.
- A suíte completa roda na CI do GitHub, em Node 20 e 24.

## Limites conhecidos

O iOS não entrega sinais em segundo plano depois que a pessoa força o fechamento do app e pode atrasá-los ou descartá-los por baixa prioridade ou economia de energia. O Android pode atrasar mensagens de prioridade normal em Doze. Um aviso pode ficar até a pessoa abrir o app ou removê-lo; não há reenvio. A Apple ou o Google vê que o sinal chegou ao aparelho e quando, o que permite relacionar esse horário com a leitura em outro aparelho mesmo sem receber o conteúdo. As limitações já documentadas das marcações de Página e de grupos continuam valendo.
