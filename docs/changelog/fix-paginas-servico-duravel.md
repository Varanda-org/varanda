### Corrigido

- Páginas, parte da #352 (PR `fix/paginas-servico-duravel`): o limite de 2 encerramentos ou mudanças de chave por dono em 24 h passa a ficar no `pages.json` e sobrevive a um reinício do serviço de conta; e um `group-post` ou `group-seal` reenviado depois de um reinício responde o mesmo `seq` em vez de publicar de novo. Os limites por minuto continuam na memória, por decisão. Sem mudança de RPC nem de Termos. Verificação em `docs/verification/fix-paginas-servico-duravel.md`.
- Operação: o README traz o procedimento de backup e restauração de `VARANDA_PAGE_KEYS`, e o `deploy/seeder/.env.example` passa a listá-la.
