### Adicionado

- `varanda page dm-list`, `page dm-read` e `page dm-reply` (PR `feat/cli-page-dm`, parte da #352): a CLI lista, lê e responde, só com texto, as Conversas de uma Página que o nó core administra, pelo mesmo motor do `varanda-serve --account-origin`. O texto de quem escreve sai escapado e as mídias aparecem só por tipo e tamanho; `dm-read --save <dir>` grava as mídias recebidas em modo `0600`, sem sobrescrever nada e recusando link simbólico. A CLI aceita `--account-origin` além de `VARANDA_ACCOUNT_ORIGIN`. Verificação em `docs/verification/feat-cli-page-dm.md`.
