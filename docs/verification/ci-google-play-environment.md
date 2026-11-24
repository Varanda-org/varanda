# Ambiente `google-play` no envio do Android

O fluxo `.github/workflows/android-release.yml` pedia a aprovação no ambiente `play-store`, mas o ambiente criado no repositório se chama `google-play` (revisor obrigatório, só `main`). Com a variável `VARANDA_ANDROID_RELEASE` ligada, o GitHub criaria um ambiente `play-store` vazio, sem revisor, e o job `play` rodaria sem aprovação até parar na falta do `EXPO_TOKEN`.

O que muda:

- o job `play` usa o ambiente `google-play`, e o comentário do início do fluxo também;
- `apps/cli/test/android-release.test.js` exige `google-play`;
- `docs/google-play.md`, `docs/development.md` e a entrada `docs/changelog/ci-android-release.md` usam o nome novo. A verificação antiga, `docs/verification/ci-android-release.md`, fica como estava.

Conferido:

- `node apps/cli/test/android-release.test.js` passa; com o fluxo de volta em `play-store`, o teste "uses the google-play environment" falha;
- `git grep play-store` só encontra a verificação antiga e os arquivos da branch `feat/play-store-pages`;
- `npm run lint` e `npm run demo`.

Fica para o responsável: o segredo `EXPO_TOKEN` no ambiente `google-play` e, por último, a variável `VARANDA_ANDROID_RELEASE` (passo 5 de `docs/google-play.md`).
