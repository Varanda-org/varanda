### Corrigido

- Um aparelho que entrou num grupo privado antes de a raiz chegar passa a entrar de novo sozinho, com a chave certa, sem novo toque: a participação automática troca o escritor sem chave por um com a chave do aparelho, respeitando saída, banimento e reserva de vagas. A participação automática só replaneja por escritor novo nos grupos privados em que o aparelho escreve, no máximo 64 por sessão (PR `fix/device-upkeep-leftovers`, parte da #350). Verificação em `docs/verification/fix-device-upkeep-leftovers.md`.
