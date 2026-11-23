### Alterado

- `VARANDA_ANDROID_CERT_SHA256` aceita de 1 a 4 certificados separados por vírgula: o `assetlinks.json` publica todos e o serviço de conta aceita a passkey do app Android vinda de qualquer um, para o app do Google Play e o APK de preview do EAS entrarem ao mesmo tempo. Repetição, item vazio, espaço, minúscula, a chave pública de depuração ou um quinto valor recusam a implantação e a subida do serviço; um só certificado gera os mesmos bytes de antes (PR `feat/android-cert-list`). Verificação em `docs/verification/feat-android-cert-list.md`.
