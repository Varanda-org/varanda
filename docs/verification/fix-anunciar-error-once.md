# fix/anunciar-error-once

Issue #916. Em `apps/app/src/screens/Anunciar.js`, o rodapé mostrava `error` sem olhar o campo, repetindo o aviso já exibido sob o campo.

## O que mudou

`barError(error, field)` em `apps/app/src/anunciarSteps.js` devolve o erro só quando ele não pertence a um campo. O rodapé usa esse helper.

## Verificação

- `node apps/app/test/anunciarSteps.test.js`: o teste novo falha sem o helper (`barError is not a function`) e passa com ele: erro com campo não aparece no rodapé, erro sem campo aparece.
- `npm run lint`, `npm run demo`: ok.
- Não conferido em aparelho (emulador/simulador).
