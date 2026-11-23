### Segurança

- Os fluxos `ios-release` e `android-release` instalam o `eas-cli` 27.2.0 a partir de `.github/eas-cli/package-lock.json` (`npm ci --ignore-scripts`), em vez de resolver as dependências dele de novo a cada execução, e o job que recebe o `EXPO_TOKEN` deixa de usar o cache do npm (PR `ci/release-workflow-hardening`). Verificação em `docs/verification/ci-release-workflow-hardening.md`.
- Depois da aprovação, os jobs `testflight` e `play` conferem de novo se já existe uma execução mais nova do fluxo em `main` e, se existe, terminam verdes sem build: um Re-run de uma execução antiga não manda mais um build velho para as lojas. Para repetir um envio, use Run workflow.
