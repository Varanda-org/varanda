# feat/app-store-version

- Teste puro em `apps/app/test/version.test.js` (validação e formato).
- A versão vem de `expo-constants` (já ligado pelo expo) e o número de compilação só no Android, via `modules/app-build`. O número de compilação do iOS (CFBundleVersion) não tem módulo instalado e fica desconhecido.
- Não conferido em aparelho (APK de preview, TestFlight).
