### Corrigido

- Aviso silencioso que sobrava no Android (PR `fix/android-quiet-notice-close`): no Android, com o app instalado, o aviso silencioso "Pode haver uma mensagem nova na Varanda" que o aparelho mostra e fecha depois de um envio próprio (mensagem ou reação) feito com o app aberto, ou de uma pessoa bloqueada, ficava na bandeja; agora o fechamento espera cerca de 2 s para o sistema exibir o aviso, e um aviso silencioso novo troca o anterior. Fora do Android nada muda. Sem mudança de protocolo, RPC nem Termos. Verificação em `docs/verification/fix-android-quiet-notice-close.md`.
