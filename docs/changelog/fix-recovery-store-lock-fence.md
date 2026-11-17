### Corrigido

- Recuperação de conta, parte da #444 (PR `fix/recovery-store-lock-fence`): o serviço de conta apaga as marcas de remoção do `recovery.json` depois de 30 dias mesmo sem novas gravações, e um processo que perdeu a trava do diretório não grava mais o arquivo. Verificação em `docs/verification/fix-recovery-store-lock-fence.md`.
