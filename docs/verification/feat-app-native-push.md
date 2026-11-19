# Avisos nativos no app (branch feat/app-native-push)

## O que muda

- Módulo Expo local `apps/app/modules/push-device`, por autolinking: Swift no iOS (APNs) e Kotlin no Android (FCM). Ele responde permissão, token, transporte e o toque de abertura, e emite `onToken` e `onIntent`. Sem código nativo (Node, web), responde indisponível. Nada disso pede `expo prebuild`: `ios/` e `android/` mudam só no `Podfile.lock` (a entrada `PushDevice`) e no entitlement `aps-environment`.
- Android: só o cliente `firebase-messaging` na versão exata, fora do Gradle e do manifesto mantidos à mão. A configuração vem de um `google-services.json` do operador, fora do git e do upload do EAS; sem ele, o build segue sem FCM e a linha de Ajustes não aparece. O serviço FCM próprio desliga auto-init e analytics, usa um canal de alta importância e um ícone monocromático, e não mostra aviso recebido em primeiro plano.
- `account.js` ganha info, start, finish e check de aparelho, com respostas de chaves exatas. Finish sem resposta é `uncertain`, como no helper web.
- O nó assina `pushDevice.sign` (5.170); o cliente nunca preenche membro nem associação. A capacidade vem de `transport()` e de `/account/push/device/info`, sem `Platform.OS`.
- O registro `{ transport, token, key }` fica por membro no `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). A chave do aparelho é da instalação (`varanda.push-device.key`), o que deixa outra conta do mesmo celular assumir o token, regra do serviço em `feat/native-push-transport`.
- A entrada `.pending` guarda o registro e a ação (`on` ou `off`) só depois do nonce e de uma assinatura válida, logo antes de `/device/finish`. Uma recusa de assinatura ou uma falha no início é falha simples, sem pendência. Com pendência, nada se renova sozinho, o controle mostra o estado ainda não confirmado e um toque repete a ação pendente.
- Uma renovação por desbloqueio e uma por token novo. Abrir Ajustes não renova; check sem resposta não é remoção. Bloquear ou trocar de identidade encerra a escuta daquela identidade.
- O toque abre Conversas (`dm`, `group`, `group-private`) ou a lista de Páginas (`dm-page`) depois do desbloqueio. O toque que chega antes de o JS escutar fica guardado no módulo até ser lido ou observado.

## Testes automatizados

Aterrissagem em `0e47ba8d`, Node 24, local: `npm run lint` passou; os 145 arquivos de teste alcançados pelo diff contra `feat/native-push-transport` passaram, cada um sozinho; `npm run demo` terminou com `DEMO OK`. O resto do diff contra `origin/main` é o de `feat/native-push-transport`, conferido na aterrissagem dele.

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/hardening.test.js` | 31/31 | 384/384 |
| `apps/app/test/push-device-android.test.js` | 12/12 | 114/114 |
| `apps/app/test/pushDevice.test.js` | 8/8 | 115/115 |
| `apps/app/test/use-push-native.test.js` | 28/28 | 284/284 |
| `apps/app/test/account.test.js` | 91/91 | 1420/1420 |
| `apps/app/test/platformGate.test.js` (rodado à parte) | 6/6 | 841/841 |

Regressões conferidas removendo a correção: a rotação do token sem a mesma chave e o bloqueio durante a gravação da pendência fazem `use-push-native.test.js` falhar.

## Builds nativos

Feitos sobre `37c2d53a`; depois dele só mudaram arquivos JS, testes e documentos, e nenhum arquivo de `apps/app/ios`, `apps/app/android` ou `apps/app/modules`.

| Build | Comando | Resultado |
|---|---|---|
| Simulador iOS (arm64, Debug, sem assinatura) | `xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug -sdk iphonesimulator ... CODE_SIGNING_ALLOWED=NO` | `BUILD SUCCEEDED` |
| Android debug | `./gradlew assembleDebug` (JDK 17) | `BUILD SUCCESSFUL`, sem `google-services.json` (caminho sem FCM) |

O `npm run prepare:native` reescreve os checksums do `Podfile.lock`; o PR guarda só a entrada `PushDevice`, e o build local usou o lock completo gerado pelo `pod install`, restaurado depois.

## No aparelho

| Ambiente | Conferência devida |
|---|---|
| Simulador iOS | Ajustes: negar e conceder permissão, ligar e desligar, bloquear e desbloquear, toque em avisos simulados dos quatro tipos com o app aberto e fechado. |
| Emulador Android | Build com e sem `google-services.json`; permissão no Android 13 ou mais novo e no 12; canal; ligar, desligar e destinos dos quatro tipos. |
| iPhone com APNs real | Chave do operador e build assinado; entrega em segundo plano, app encerrado e primeiro plano; rotação e remoção. Confirmar que o build de distribuição assina `aps-environment` como `production`. |
| Android com FCM real | Conta de serviço do operador e build com Firebase do mesmo projeto; entrega, rotação e remoção. |

Nos dois sistemas: Sair e Recomeçar durante uma ativação, token novo com a identidade bloqueada, troca de conta no mesmo aparelho (o token passa para a nova conta com a mesma chave), e uma pendência que sobrevive ao encerrar o app e se resolve com um toque. Depois dos aparelhos, conferir que o Web Push continua igual no navegador e no PWA.

## O que não foi conferido

- Nenhum simulador, emulador ou aparelho abriu o app; só os builds rodaram. Nenhuma entrega real APNs ou FCM. Os testes usam módulo, serviço e nó falsos, sem rede externa.
- `expo prebuild` não foi rodado (proibido pelo AGENTS.md); os testes de `hardening.test.js` conferem que o módulo entra por autolinking.
- A suíte completa roda na CI do GitHub, em Node 20 e 24.

## Limites conhecidos

- Precisa da configuração no build e das credenciais do operador. Sem as duas, a linha de Ajustes não aparece.
- Um membro com nó do core (CLI e `varanda-serve`) não liga os avisos: `pushDevice.sign` recusa ali com `USAGE`, e o toque termina em falha simples.
- O sistema pode negar a permissão, atrasar ou perder avisos. Nenhum finish é repetido sem toque.
- Um finish sem confirmação pode ter mudado o serviço; a interface mostra o resultado incerto até um toque confirmar.
- No Android, o SDK do Firebase guarda uma cópia do token FCM no armazenamento privado do app, apagada ao desinstalar ou limpar os dados. Desligar não apaga esse token, que serve a todas as contas da instalação.
- Só mensagens privadas, mensagens para Páginas e grupos. Avisos sociais, convites e o fechamento por `seen-sync` não chegam aos aparelhos nativos: um aviso lido em outro aparelho continua no celular.
