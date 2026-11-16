# Aviso silencioso que sobrava no Android (PR `fix/android-quiet-notice-close`)

Data: 2026-11-15.

Um aparelho Android com o app instalado (WebAPK de bora.varanda.app) deixou dois avisos silenciosos na bandeja depois de reações próprias enviadas por esse app. O aviso é o `varanda-dm-wake-quiet` de `apps/app/scripts/sw.js`, que o worker mostra em silêncio e fecha na hora nos três casos da seção 112 de `docs/verification.md` (envio próprio nos 120 s, janela em foco, ou push de uma pessoa bloqueada). A causa é uma inferência, não comprovada: o Android posta o aviso de forma assíncrona, e o fechamento mandado logo depois de `showNotification` se perde.

A correção: no Android (quando o `userAgent` contém `Android`), o fechamento espera `QUIET_CLOSE_WAIT_MS` (2000 ms). Um aviso silencioso novo, com a mesma etiqueta, troca o anterior e fecha depois da sua própria espera. Fora do Android o fechamento continua imediato. Um aviso real (`varanda-dm-wake`) nunca é fechado por essa parte.

Testes automáticos em `apps/app/test/sw.test.js`: `dm wake: on Android the quiet notice is closed only once the system has posted it`, `dm wake: outside Android the quiet notice is still closed at once`, `dm wake: on Android a second quiet notice inside the wait is closed after its own wait`, `dm wake: on Android the delayed close leaves a real DM wake on screen` e `push: on Android a failing showNotification neither waits nor throws`. Prova de regressão, executada localmente: com o `sw.js` anterior e estes testes, falham a primeira, a terceira e a quarta (80 de 83 testes passam), e as demais e todos os testes que já existiam passam.

Conferência em aparelho (não conferido em aparelho):

- [ ] Android com o app instalado, reação própria com o app na frente: o aviso "Pode haver uma mensagem nova na Varanda" não fica na bandeja (não conferido em aparelho).
- [ ] Android com o app instalado, reação própria e app mandado para o segundo plano antes do aviso (até cerca de 60 s de atraso do servidor mais a entrega): o aviso não fica na bandeja (não conferido em aparelho).
- [ ] Android com o app instalado, aviso de pessoa bloqueada: o aviso não fica na bandeja (não conferido em aparelho).
- [ ] Resultado esperado nos três casos: bandeja vazia cerca de 3 s depois do aviso, sem som (não conferido em aparelho).
- [ ] Um aviso real de outra pessoa, enviado com o app em segundo plano, ainda aparece e fica na bandeja (não conferido em aparelho).

Se ainda sobrar aviso, conferir em `chrome://inspect`, na página do app, rodando `(await navigator.serviceWorker.ready).getNotifications()` e anotando a etiqueta (`tag`) de cada um. Um aviso que está na bandeja e não aparece na lista teve o fechamento perdido. Um `varanda-dm-wake` listado é um aviso real (silêncio vencido ou envio não informado), e é outro defeito, a anotar à parte.
