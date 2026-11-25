# feat/ios-release-on-version-bump

Subir a versão do app manda o iOS para a revisão da App Store. Só CI e documentação: nenhum código do app muda.

## O que mudou

- `scripts/ios-app-review.js` (novo, só módulos do Node):
  - `plan` confere que `app.json` `expo.version`, `store.config.json` `apple.version`, `ios/Varanda/Info.plist` `CFBundleShortVersionString` e todo `MARKETING_VERSION` do `project.pbxproj` são iguais. Depois pergunta ao App Store Connect se a versão ainda precisa ir à revisão (nenhuma versão com esse número, ou uma em `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED` ou `READY_FOR_REVIEW`) e escreve `release=true|false`. Sem a chave, avisa e escreve `release=false`. Com `release=true` e sem `releaseNotes` em algum idioma de `apple.info`, para antes do build.
  - `submit` lê o número do build na saída de `eas build --json`, espera o build ficar `VALID` em `GET /v1/builds` (até uma hora, consulta a cada 30 s) e confere de novo a versão. Depois cria (`POST /v1/appStoreVersions`) ou reaproveita (`PATCH /v1/appStoreVersions/{id}`, renomeando se preciso) a versão com o build e `releaseType: AFTER_APPROVAL`, grava `whatsNew` (`PATCH /v1/appStoreVersionLocalizations/{id}`), e por fim cria ou reaproveita a submissão em `READY_FOR_REVIEW` (`POST /v1/reviewSubmissions`, `POST /v1/reviewSubmissionItems`) e a envia (`PATCH /v1/reviewSubmissions/{id}`, `submitted: true`). Os campos foram conferidos na documentação da API do App Store Connect em 2026-11-25. Nenhum POST ou PATCH se repete: só a consulta do build tolera 429, 5xx e falha de rede.
  - JWT ES256 (`kid`, `iss`, `iat`, `exp` 10 minutos depois, `aud: appstoreconnect-v1`), um por pedido.
- `.github/workflows/ios-release.yml`: o passo `plan` vem logo depois do `setup-node`, antes de qualquer `npm ci`. O `eas build` ganhou `--json`, com saída em `$RUNNER_TEMP/eas-build.json`, e só leva `--no-wait` sem revisão; com revisão, o eas-cli 27.2.0 espera o build e o envio ao TestFlight e sai com erro se um deles falha (`runBuildAndSubmit.js`). O passo `Send the version to App Review` só roda com `release == 'true'`. Só `plan` e `submit` recebem `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` e `ASC_API_KEY_P8`, e o passo do build continua só com `EXPO_TOKEN`. `timeout-minutes` foi de 20 para 180. O cabeçalho descreve o fluxo novo e os passos únicos.
- `docs/development.md`, "Envio para a App Store (EAS)": o fluxo novo, o que fazer para subir a versão (quatro arquivos e `releaseNotes`) e a chave do App Store Connect.

## Testes

- `apps/cli/test/ios-app-review.test.js` (novo, 16 testes, 89 asserções), contra uma API falsa com uma chave criada na hora:
  - o repositório tem uma só versão nos quatro arquivos;
  - uma versão diferente é recusada, com o nome do arquivo;
  - JWT: cabeçalho, claims e assinatura;
  - `decide` em cada estado;
  - as consultas do `plan`;
  - a espera pelo build: 503, PROCESSING, VALID, INVALID, 401 e o prazo;
  - a sequência exata de escritas ao criar uma versão nova;
  - a reutilização de uma versão editável renomeada e de uma submissão que já tem o item;
  - nada é escrito quando a versão já foi enviada enquanto o build rodava;
  - um idioma ausente para o envio;
  - um 409 aparece uma vez e não se repete;
  - a saída do `eas build`;
  - o `main` com e sem chave, sem `releaseNotes` e com versões diferentes.
- `apps/cli/test/ios-release.test.js`:
  - flags do `eas build` (`--json` e `$wait_flag` no lugar de `--no-wait`) e o `RELEASE` vindo do passo `plan`;
  - o novo `if` do passo de envio;
  - um teste novo para a ordem `plan`, `npm ci`, build e `submit`, os segredos de cada passo e o timeout;
  - a lista de segredos.

## Comandos

```sh
npm run lint                                  # ok
node apps/cli/test/ios-app-review.test.js     # 89/89
node apps/cli/test/ios-release.test.js        # 157/157
node apps/cli/test/supersede.test.js          # ok
node apps/cli/test/android-release.test.js    # ok
node apps/cli/test/promote.test.js            # ok
npm run demo                                  # DEMO OK
```

O conjunto de testes roda na CI do GitHub do PR (seleção afetada, Node 20 e 24).

## Não rodado

- O fluxo não rodou contra o App Store Connect real: isso precisa da chave nova no ambiente `app-store` e de uma versão nova. A primeira versão depois do merge (subir para `0.1.1` ou `0.2.0`, com `releaseNotes`) é a verificação de verdade. Se um passo falhar, termine à mão no App Store Connect.
- Nenhum workflow foi disparado.
