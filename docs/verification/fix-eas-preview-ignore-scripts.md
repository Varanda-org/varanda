# fix/eas-preview-ignore-scripts

## Causa

O build EAS `b71b739f-6818-4ff1-b592-4dfede5c8b92` (Android, perfil `preview`, commit `2e56f8ff`, Node 24.22.1) falhou na etapa Install dependencies. O builder rodou `npm ci --include=dev` na raiz, sem `--ignore-scripts`, e o script de instalação do `onnxruntime-node` 1.21.0 (`node ./script/install`) tentou baixar `https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/onnxruntime-linux-x64-gpu-1.21.0.tgz`. O endereço respondeu `404 Not Found` e o `npm ci` terminou com erro.

O script só baixa os binários CUDA no Linux x64 (`node_modules/onnxruntime-node/script/install.js`); o binário de CPU já vem no pacote. O pacote só existe por `apps/cli` (`@huggingface/transformers` 3.8.1, triagem com IA), e o app não o carrega. O perfil `production` já definia `npm_config_ignore_scripts=true` pelo mesmo motivo (`sharp` compilando no macOS); o `preview` não definia, como dizia `docs/development.md`.

## O que mudou

- `apps/app/eas.json`: o perfil `preview` define `"env": { "npm_config_ignore_scripts": "true" }`. O `preview-simulator` herda pelo `extends`, sem `env` próprio. O `production` não mudou.
- `apps/app/test/eas-preview.test.js`: o teste `the preview profiles run no dependency install script` exige essa `env` no `preview` e nenhuma `env` própria no `preview-simulator`.
- `docs/development.md`: um item novo em "Builds de teste (EAS)" e a última frase do item do `production` corrigida.

## Por que é seguro

A CI instala com `npm ci --ignore-scripts` (`.github/workflows/ci.yml`), e o job `android-build` de `.github/workflows/native.yml` instala assim, roda `prepare:native -- android` e compila o APK de debug com o Gradle. O hook `eas-build-post-install` continua rodando, porque o npm executa um script chamado pelo nome.

## Conferido

```sh
npm ls onnxruntime-node                   # varanda (apps/cli) > @huggingface/transformers@3.8.1 > onnxruntime-node@1.21.0
curl -sSI -o /dev/null -w '%{http_code}\n' https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/onnxruntime-linux-x64-gpu-1.21.0.tgz   # 404
node apps/app/test/eas-preview.test.js    # 11/11 testes, 61/61 asserções
node apps/cli/test/ios-release.test.js    # 99/99 asserções (env do production intacta)
```

Falha sem a correção: com a `env` tirada do `preview`, `eas-preview.test.js` falha no teste novo (10/11 testes, 60/61 asserções). Com a `env` de volta, passa (11/11).

## Não conferido

Nenhum build EAS rodou a partir desta sessão. Depois do merge, quem tem acesso à conta Expo roda, da pasta `apps/app`:

```sh
eas build --profile preview --platform android
```

e confere as etapas Install dependencies, `link-addons`, `pack-worklet` e o Gradle (`assembleRelease`). O job da CI compila o variante de debug, não o de release da EAS. Um build iOS de preview também não rodou.
