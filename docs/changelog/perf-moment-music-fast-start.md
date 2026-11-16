### Alterado

- A música de um momento começa mais rápido: o serviço de conta reabre direto o endereço de armazenamento já usado por aquele ticket, as conexões ao Audius e ao armazenamento são reaproveitadas, e o visualizador abre o áudio do próximo momento assim que o atual começa a tocar. Verificação em `docs/verification/perf-moment-music-fast-start.md`.
- No limite de retransmissões de áudio por membro, uma abertura nova troca a retransmissão mais antiga em vez de falhar com 503. Os limites de uso, de bytes e de aberturas não mudam.
