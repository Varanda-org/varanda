### Alterado

- Quando o semeador recusa ou descarta o diário próprio por falta de espaço (motivo `storage-full`, #33), o app mostra no topo, no celular e na web, o aviso fixo "O semeador está sem espaço e não está guardando seu diário agora.". Ele continua entre uma tentativa de sincronização e a seguinte, some quando o semeador volta a aceitar o diário ou recusa por outro motivo, e espera enquanto o aparelho está sem rede. Não tem botão: nada neste aparelho libera espaço no semeador. Verificação em `docs/verification/feat-seeder-storage-full-notice.md`.
