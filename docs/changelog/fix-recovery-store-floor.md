### Corrigido

- Recuperação de conta, parte da #444 (PR `fix/recovery-store-floor`): ao descartar registros antigos de remoção, o `recovery.json` passa a guardar, por membro, uma marca da última remoção descartada, e uma cópia mais antiga do arquivo não traz mais de volta uma passkey extra ou um código de recuperação já removido. Verificação em `docs/verification/fix-recovery-store-floor.md`.
- Operação: o `recovery.json` passa à versão 2, escrita na primeira gravação que muda algo. Uma versão anterior do serviço de conta não lê esse arquivo e responde 503 nas rotas `/account/recovery/*` até a versão nova voltar; o arquivo fica como está.
