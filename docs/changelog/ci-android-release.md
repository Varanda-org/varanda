### Adicionado

- Envio do Android para o Google Play pelo EAS: o fluxo `android-release` gera o app bundle do perfil `production` a cada push na `main` que mexe no app e o envia para a faixa de teste interno, já lançado para quem testa, depois da aprovação no ambiente `google-play`. Fica desligado até a variável `VARANDA_ANDROID_RELEASE` valer `true` (PR `ci/android-release`).
- O build de produção do Android para no gancho de pós-instalação quando a configuração do Firebase (`VARANDA_GOOGLE_SERVICES_JSON`) falta ou não descreve `app.varanda`, em vez de sair sem notificações. A mensagem traz só o motivo, nunca o caminho nem o conteúdo do arquivo.
- Roteiro do responsável para publicar o Android na Google Play, em `docs/google-play.md`: conta, Firebase, chave de upload, assinatura da Play, envio pela EAS, formulários do Console (com a matriz de segurança dos dados), teste fechado e a qualificação antes da revisão (PR `ci/android-release`).
