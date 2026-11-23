# Envio do Android para a Google Play (branch ci/android-release)

Fluxo `android-release`, perfil de loja do Android no `eas.json`, trava do Firebase no build de loja e o roteiro do responsável em [docs/google-play.md](../google-play.md). Sem mudança de RPC, formato ou Termos.

## O que mudou

- `.github/workflows/android-release.yml`: a cada push na `main` que mexe no app, ou por Run workflow em `main`, espera a aprovação no ambiente `play-store` e roda `eas build --platform android --profile production --auto-submit --non-interactive --no-wait` com o `eas-cli` 27.2.0 e o segredo `EXPO_TOKEN`. Só roda com a variável `VARANDA_ANDROID_RELEASE` igual a `true`. O job `supersede` é o mesmo de `deploy`, `ios-release` e `site`.
- `apps/app/eas.json`: `build.production.android.buildType` `app-bundle`; `submit.production.android` com `track` `internal` e `releaseStatus` `draft`.
- `apps/app/scripts/check-firebase-config.js`, chamado por `apps/app/scripts/eas-post-install.sh` só no Android com o perfil `production`: para o build quando o arquivo de `VARANDA_GOOGLE_SERVICES_JSON` (ou, sem ela, `android/app/google-services.json`, o que o Gradle lê) falta ou não descreve `app.varanda`, e imprime só um motivo, nunca o caminho nem o conteúdo.
- `docs/google-play.md`: o roteiro do responsável, na ordem, do cadastro da conta à pausa dos envios, com a matriz de segurança dos dados e a qualificação antes da revisão. Índice em `docs/README.md`; seção "Envio para a Google Play (EAS)" e ponteiros em `docs/development.md`.
- `docs/development.md`: a frase que dizia que ligar os avisos no app ficava para depois foi corrigida, e a citação de `deploy/seeder/well-known.sh` por número de linha passou a citar `ler_associacoes`.
- `docs/verification.md`: as duas frases "Não há push nativo" foram corrigidas no lugar, com ponteiro para `docs/verification/feat-app-native-push.md`. Nenhuma seção nova.
- Comentários de `deploy.yml`, `ios-release.yml` e `site.yml` passam a citar `android-release.yml` entre os fluxos com o job `supersede`. Só comentários.

## Testes

Rodados nesta árvore (sobre `origin/main` 51e5f404), cada arquivo sozinho com `node <arquivo>`, Node 24:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/android-release.test.js` | 6/6 | 107/107 |
| `apps/cli/test/supersede.test.js` | 6/6 | 110/110 |
| `apps/cli/test/ios-release.test.js` | 6/6 | 99/99 |
| `apps/cli/test/deploy.test.js` | 66/66 | 916/916 |
| `apps/cli/test/promote.test.js` | 13/13 | 446/446 |
| `apps/cli/test/release.test.js` | 16/16 | 694/694 |
| `apps/cli/test/changelog.test.js` | 9/9 | 42/42 |
| `apps/cli/test/readme-pull.test.js` | 16/16 | 172/172 |
| `apps/cli/test/run-tests.test.js` | 30/30 | 228/228 |
| `apps/app/test/firebaseConfig.test.js` | 7/7 | 64/64 |
| `apps/app/test/eas-preview.test.js` | 12/12 | 129/129 |
| `apps/app/test/hardening.test.js` | 36/36 | 447/447 |
| `apps/app/test/authSession.test.js` | 5/5 | 56/56 |
| `apps/site/test/site.test.js` | 17/17 | 338/338 |
| `packages/web-member/test/resume.test.js` | 8/8 | 342/342 |

- [x] `npm run lint`
- [x] `bash -n apps/app/scripts/eas-post-install.sh`
- [x] Nenhum travessão (U+2014) no diff nem nos arquivos novos.

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## O que falhou

- Apontar a mensagem de erro de `check-firebase-config.js` para `docs/google-play.md` quebrou `apps/app/test/eas-preview.test.js`, que exige a saída de uma linha `check-firebase-config: <motivo>`. A mudança foi desfeita; a mensagem continua só com o motivo, e o roteiro lista cada motivo no passo 2.

## O que continua devido

Nada abaixo roda na CI nem num agente; é tudo do responsável (veja [docs/google-play.md](../google-play.md)):

- [ ] O primeiro build de loja aprovado prova que a variável de arquivo `VARANDA_GOOGLE_SERVICES_JSON` chega ao gancho `eas-build-post-install` (linha `check-firebase-config: ok` no log).
- [ ] Uma execução verde do fluxo `android-release` só prova que o build entrou na fila: conferir o build no expo.dev e o rascunho no teste interno.
- [ ] Assinatura de apps do Google Play com chave do Google, as duas impressões digitais em `VARANDA_ANDROID_CERT_SHA256` e o `assetlinks.json` publicado.
- [ ] Instalação pela Play (assinada pelo Google) com passkeys e App Links.
- [ ] 16 KB no Explorador de pacotes de apps e num aparelho com páginas de 16 KB.
- [ ] Entrega real pelo FCM no Android 12 e no 13 ou mais novo, devida desde `docs/verification/feat-app-native-push.md`.
- [ ] `seen-sync` real no Android, devido desde `docs/verification/feat-native-seen-sync.md`.
- [ ] Teste fechado, quando a conta estiver sujeita a ele, e acesso à produção.
- [ ] Formulários do Console, com a certificação de segurança infantil ainda em aberto.
