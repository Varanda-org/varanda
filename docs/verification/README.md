# Verificação por PR

A verificação de um PR (o que foi conferido, com quais comandos e aparelhos, e o que ficou de fora) fica num arquivo novo nesta pasta, com o nome da branch, `/` trocado por `-` e terminado em `.md`: a branch `fix/fetch-socket-retention` usa `fix-fetch-socket-retention.md`, o mesmo nome da entrada em [docs/changelog/](../changelog/README.md).

O arquivo não tem número de seção. A entrada do changelog, a descrição do PR e os comentários do código o citam pelo caminho (`docs/verification/fix-fetch-socket-retention.md`). Assim, dois PRs abertos ao mesmo tempo não disputam o mesmo número nem o fim do mesmo arquivo, e nenhum precisa renumerar a sua seção depois de um merge na `main`.

As seções numeradas de [verification.md](../verification.md) continuam lá, citadas pelo número, e ainda podem ser corrigidas no próprio arquivo. Não acrescente seção nova a ele.
