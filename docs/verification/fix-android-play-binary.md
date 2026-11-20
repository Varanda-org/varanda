# Binário Android para o Google Play (branch fix/android-play-binary)

## sodium-native 5.2.0 em todo o grafo do worklet

O Google Play exige que toda biblioteca nativa de 64 bits tenha segmentos `LOAD` alinhados a 16 KB. O `sodium-native` 4.3.3 entrava no worklet por três pacotes que pedem `sodium-universal` `^4`: `@hyperswarm/dht-relay` 0.4.3, o `noise-handshake` 3.1.0 dele e o `hypercore` 10.38.2 de `packages/web-member`. O `packages/core` já usava `sodium-universal` 5.0.1 e `sodium-native` 5.2.0.

Alinhamento lido com `llvm-readelf -lW` (NDK 27.1) nos `prebuilds/*/sodium-native.bare`:

| Versão | android-arm64 | android-x64 |
|---|---|---|
| 4.3.3 | `p_align` 0x1000 (4 KB) nos três `LOAD` | 0x1000 |
| 5.2.0 | 0x4000 (16 KB) nos três `LOAD` | 0x4000 |

O que muda:

- `package.json` da raiz: `overrides` por pai, nunca uma chave solta: `@hyperswarm/dht-relay` e `hypercore@10.38.2` recebem `sodium-universal` 5.0.1.
- `package-lock.json`: só saem as quatro entradas aninhadas (`node_modules/@hyperswarm/dht-relay/node_modules/sodium-native` 4.3.3 e `sodium-universal` 4.0.1, `packages/web-member/node_modules/sodium-native` 4.3.3 e `sodium-universal` 4.0.1). Nenhuma outra resolução muda; um segundo `npm install --ignore-scripts` fica "up to date" sem mexer no lockfile.
- `packages/web-member`, no Node e no worklet do app, passa a usar `sodium-native` 5.2.0.
- O shim do navegador (`packages/web-member/lib/sodium-browser.js`) seguia o `sodium-native` 4.3.3, que o teste diferencial de fato carregava, apesar do comentário dizer 5.2.0. O 5.2.0 tem a checagem de subgrupo completa do libsodium: recusa os pontos P0 + (0, -1), de ordem 2L, e falha com `Error('status: -1')`. O shim agora aceita só quando L * P é a identidade e continua lançando um Error próprio, nunca devolve -1.
- `docs/development.md`, "Adding a dependency": o motivo do pin.

Fica igual: a criptografia do navegador. Os bundles (`scripts/build.js`) continuam mapeando `sodium-native` e `sodium-javascript` para o shim; antes do ajuste do shim, a única diferença nos metafiles era a saída de uma cópia duplicada de `sodium-universal/index.js` (42 bytes, a reexportação do 4.0.1). O ajuste do shim muda só o próprio shim no bundle.

## Testes

- [x] `npm ls sodium-native --all`: só 5.2.0 (sob `packages/core` e `bare-bundle-id`). `npm ls sodium-universal --all`: só 5.0.1, e `@hyperswarm/dht-relay`, `noise-handshake` 3.1.0 e `hypercore` 10.38.2 resolvem o 5.0.1 da raiz. `package-lock.json` sem `sodium-native-4.3.3`.
- [x] `npm run pack:worklet -w apps/app`: o bundle liga só `libsodium-native.5.2.0.so` / `sodium-native.5.2.0.framework`, e o `hypercore` 10 do web-member não tem `sodium-*` aninhado. Varredura de built-ins do Node limpa.
- [x] `npm run build:node -w apps/app` (NODE_BUNDLE gerado).
- [x] `packages/web-member`, todos os arquivos (`VARANDA_TEST_CONCURRENCY=2 node ../../scripts/run-tests.js`): 140 arquivos, só `sodium-browser.test.js` falhava antes do ajuste do shim (testes 3, 4 e 5, pela referência nova).
- [x] `sodium-browser.test.js` sozinho: antes do ajuste, 5/8 testes e 224/227 asserções; depois, 8/8 e 227/227, inclusive o handshake Noise XX entre um par com o shim e um par nativo.
- [x] Prova de regressão, rodada de verdade: com a aceitação antiga de (0, -1) recolocada no shim, o diferencial de ordem 2L e o de bytes aleatórios falham (6/8, 225/227).
- [x] Arquivos que importam o shim, cada um sozinho: blob, bundle, dm-copy-auto, dm-copy-unit-2, dm-summary, outbox-seal e page-dm passam.
- [x] `packages/core`, todos os arquivos (`VARANDA_TEST_CONCURRENCY=2`): 196 arquivos, 0 falhas.
- [x] `packages/rpc`, todos os arquivos: 27 arquivos, 0 falhas.
- [x] `npm run demo` (termina com "DEMO OK")
- [x] `apps/app/test/workletGlobals.test.js` e `noticeClose.test.js` passam.
- [x] `npm run lint`

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## Conferências manuais pendentes

- [ ] Emulador Android, build de debug: entrar, sincronizar, mandar e receber uma conversa, fechar e abrir o app e ler os dados que já existiam.
- [ ] A mudança no lockfile enfileira um build iOS de loja (`ios-release.yml`): no TestFlight, os mesmos passos.

## Checagens de 16 KB e de permissões

- `apps/app/scripts/check-page-size.js`: leitor ELF64 sem dependências. Para cada `.so` sob os diretórios dados, todo `PT_LOAD` precisa de `p_align` >= 0x4000, de `p_offset % p_align == p_vaddr % p_align` e de `p_memsz` >= `p_filesz`, e os `PT_LOAD` não se sobrepõem; nenhuma página de 16 KB que o Bionic protege em volta do `PT_GNU_RELRO` pode conter byte gravável de fora dele. Arquivo que não é ELF, de 32 bits, big-endian, truncado, sem `PT_LOAD`, e diretório sem `.so` falham. As falhas vão para o stderr (o `prepare-native.sh` descarta o stdout da checagem final).
- `apps/app/scripts/link-addons.sh`: roda a checagem dentro do laço das ABIs do Android (`arm64-v8a`, `x86_64`), no modo de link e no `check`. O iOS não passa por ela.
- `apps/app/scripts/check-apk-permissions.js`: lê `aapt2 dump permissions`, imprime a lista ordenada, falha com `AD_ID`, `CAMERA`, `READ_EXTERNAL_STORAGE` e `WRITE_EXTERNAL_STORAGE` ou com entrada vazia, e imprime `targetSdkVersion` e `compileSdkVersion` do `aapt2 dump badging`.
- `.github/workflows/native.yml`, job `android-build`, depois de "Check the APK exists": descompacta `lib/*` do APK de debug em `$RUNNER_TEMP` e confere `arm64-v8a` e `x86_64` (React Native, Hermes, bare-kit, Expo e addons); depois passa o `aapt2` do build-tools 36.0.0 pela checagem de permissões. Sem `uses:` novo e sem segredo.

Testes:

- [x] `node test/pageSize.test.js` (apps/app): 21/21 testes, 46/46 asserções. Prova de regressão: com cada regra desligada (limite de 4 KB, RELRO, congruência, árvore vazia, ELF de 32 bits) o arquivo falha. Novos casos: RELRO no meio do `LOAD`, RELRO que atravessa o `LOAD` seguinte, `LOAD` gravável na página do fim do RELRO, `LOAD` sobrepostos, `p_memsz` menor que `p_filesz`, `phentsize` inesperado.
- [x] `node test/apkPermissions.test.js` (apps/app): 5/5 testes, 17/17 asserções. Com `AD_ID` fora da lista de proibidas, falha.
- [x] `node test/native.test.js` (apps/cli): 9/9 testes, 161/161 asserções. Um teste novo fixa que a checagem de 16 KB fica no laço das ABIs do `link-addons.sh` e fora do `check()` que o iOS divide; sem a chamada, ele falha.
- [x] `npm run prepare:native -w apps/app -- android`, com o `sodium-native` 5.2.0: todos os addons das duas ABIs passam (`check-page-size: ok`). Com a regra nova do RELRO, do `LOAD` sobreposto e do `p_memsz`: as 96 bibliotecas `arm64-v8a` e `x86_64` sob `react-native-bare-kit` (addons e `libbare-kit.so`) passam sem problema.
- [x] Com um `.so` alinhado a 4 KB plantado em `addons/arm64-v8a`, `bash apps/app/scripts/link-addons.sh check android` sai com 1 e o motivo no stderr (`libplanted.so: PT_LOAD at 0x0 has p_align 0x1000, needs >= 0x4000`). Arquivo removido; o check volta a passar.
- [x] T5: `AD_ID` fora do manifesto (`tools:node="remove"` em `AndroidManifest.xml`) e do plugin `with-hardening.js`, como guarda contra dependência futura: `node test/hardening.test.js` (apps/app) 36/36 testes, 449/449 asserções.
- [ ] Lista de permissões, `targetSdkVersion` e `compileSdkVersion` do APK: calculados pela CI no job `android-build` (não há APK local). O APK de debug tem a mais o `SYSTEM_ALERT_WINDOW` do manifesto de debug.

Checagens manuais do dono:

- [ ] No primeiro AAB real, o explorador de bundles do Play Console confirma suporte a 16 KB, as permissões e a API alvo.
- [ ] O app abre num emulador com imagem de 16 KB (`getconf PAGE_SIZE` = 16384) e numa de 4 KB.
