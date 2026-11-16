### Corrigido

- Leituras do nó do navegador sobre os cores emprestados pela sincronização ao vivo (PR `fix/borrowed-read-tombstone`, parte da #353): se a sincronização baixava uma lápide e limpava o bloco apagado no meio de uma leitura, essa resposta podia esconder as publicações seguintes (diário próprio ou de um seguido) ou parte do trecho mais novo de um seguido ainda em download. A leitura agora repete a passada, no máximo duas vezes, só quando o core cresceu com uma lápide válida depois da fotografia da passada. Verificação em `docs/verification/fix-borrowed-read-tombstone.md`.
