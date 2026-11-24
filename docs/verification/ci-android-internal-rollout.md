# Lançamento automático no teste interno do Android

O fluxo `android-release` enviava cada build para a faixa de teste interno como rascunho (`releaseStatus` `draft`), e alguém precisava abrir o Play Console para lançar a versão. A aprovação no ambiente `google-play` já é a porta de cada envio, então o clique a mais não protegia nada além dela.

Agora `submit.production.android` em `apps/app/eas.json` usa `releaseStatus` `completed`: a versão chega já disponível para quem está na lista de teste interno. A faixa continua `internal`; promover uma versão a teste fechado, aberto ou produção continua manual no Console.

O que muda:

- `apps/app/eas.json`: `releaseStatus` `completed`;
- `apps/cli/test/android-release.test.js` exige `completed` na faixa `internal`;
- o comentário do início de `.github/workflows/android-release.yml`, `docs/google-play.md`, `docs/development.md` e a entrada `docs/changelog/ci-android-release.md`.

Conferido:

- `node apps/cli/test/android-release.test.js` passa; com `draft` de volta no `eas.json`, o teste "internal track, completed, no key path" falha;
- `npm run lint` e `npm run demo`.

Não conferido aqui: a API da Play só aceita rascunho enquanto o app ainda é rascunho no Console. Em 24/11/2026 o primeiro lançamento manual já tinha sido feito e a lista de apps mostrava o Varanda em "Teste interno", então o envio `completed` deve passar, mas só o primeiro envio pelo fluxo depois deste PR prova isso. Se a Play recusar, o envio falha no expo.dev com o fluxo verde, e a saída é voltar para `draft`.
