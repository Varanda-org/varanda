### Corrigido

- O aparelho que já acompanha uma comunidade ou grupo de outro aparelho da mesma passkey passa a buscar logo o escritor novo que o diário passa a ligar a essa raiz, sem esperar a próxima paginação de cerca de 30 s. Uma entrada do diário que ainda não tinha chegado, ou cuja leitura falhou, não é mais pulada na adoção das raízes: ela é lida de novo e as entradas seguintes não esperam por ela (parte da #350). Verificação em `docs/verification/fix-diary-root-adoption.md`.
