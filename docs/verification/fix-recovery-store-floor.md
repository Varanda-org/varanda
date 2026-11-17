# Marca por membro no recovery.json (branch fix/recovery-store-floor)

Parte da #444. O `recovery.json` (`apps/cli/lib/account/recovery-store.js`) apaga registros de remoção com mais de 30 dias (`TOMBSTONE_TTL_MS`) e guarda no máximo 32 por membro. Antes, apagado o registro, uma cópia mais antiga do arquivo unida à atual (`heal()`, a leitura depois de uma gravação incerta, a união antes de cada gravação, ou um backup restaurado com o serviço no ar) trazia de volta a entrada removida.

## O que muda

- Formato versão 2: `{ v: 2, seq, entries, removed, floors }`. `floors` liga a chave do membro (64 hex) a um `gen` (inteiro positivo, no máximo `seq`).
- Todo registro de remoção apagado, pelo prazo ou pelo teto por membro, sobe a marca do membro até o `gen` dele. A marca só sobe; a união fica com o maior valor por membro.
- Quando o serviço une o arquivo à memória, uma entrada que só o arquivo tem sai quando o `gen` dela é menor ou igual à marca da memória para aquele membro. A marca do arquivo nunca tira uma entrada da memória: o serviço pega a trava antes de abrir o arquivo e para de vez ao perdê-la, então a memória nunca está atrás do arquivo na mesma história, e um arquivo com marca acima de uma entrada da memória vem de outra história (uma cópia posta de volta depois de o serviço começar de uma cópia mais antiga ou sem arquivo). A marca da própria cópia também não conta.
- Arquivo versão 1 continua sendo lido (sem marcas); a próxima gravação que muda algo escreve a versão 2. Nada é regravado só para trocar a versão.
- Validação total: `floors` ausente na versão 2, presente na versão 1, membro fora do formato, `gen` não inteiro, zero, negativo ou acima de `seq`, ou chave a mais tornam o arquivo inválido, como os demais casos (o serviço não o regrava e responde `indisponivel`).

## Comandos e resultados

Da raiz, um arquivo por vez:

- `node apps/cli/test/recovery-store.test.js`: 39 testes, 390 asserções, todos passam (antes 29 testes). Novos:
  - "a tombstone pruned by the TTL leaves a floor: an older copy never brings its row back" (por `heal()` e pela união antes de um `put`);
  - "the file's floor never drops a row memory holds: a copy from another history is merged" (o serviço começou sem arquivo, o membro cadastrou de novo e uma cópia anterior, com marca acima dessa entrada, volta com o serviço no ar);
  - "removeMember, then the TTL: an older copy never brings the member's rows back" (Excluir conta seguida do prazo de 30 dias);
  - "a read after an uncertain write never brings back a row under the floor" (`fetch` e `list` depois de uma gravação recusada após o rename);
  - "a tombstone pruned by the per-member cap leaves a floor: an older copy never brings its row back";
  - "a version 1 file is read, and the next write that changes it is version 2";
  - "a version 1 file whose tombstone expired is rewritten as version 2 with the floor";
  - "a malformed floor makes the file malformed";
  - "floors merge as the max per member";
  - "the floor drops only rows at or under it, of its member, that its own copy lacks".
- `node apps/app/test/passkeyPrfAndroid.test.js`: 2 testes, 11 asserções, passam. Confere que `androidx.credentials:credentials` e `androidx.credentials:credentials-play-services-auth` em `apps/app/modules/passkey-prf/android/build.gradle` aparecem uma vez cada, com versão exata (sem `+`, intervalo nem variável) e no mínimo 1.5.0, comparando os números.
- `npx standard` nos arquivos alterados: sem apontamentos.

## Falha sem a correção

Conferido em 17/11/2026, com o código restaurado depois:

- Com `raiseFloor` sem efeito (nenhuma marca é criada): 31/39 testes, 366/390 asserções. Falham os testes de regressão (por exemplo "not back in memory", "not back on disk"), o de Excluir conta e os de marca e de versão 1.
- Com a regra nos dois sentidos (a marca do arquivo também tirando entradas da memória): 38/39 testes, 387/390 asserções; falha "the row memory holds stays".
- Com `credentials-play-services-auth:1.4.0`: "is at least 1.5.0: 1.4.0" falha. Com `credentials:1.5.+`: "has an exact version: 1.5.+" falha. O `build.gradle` voltou ao original (`git diff apps/app/modules` vazio).

## Limites

- Só servidor e um teste de texto do app: nenhuma conferência em aparelho é necessária.
- O procedimento de restauração de backup do operador está no README, no mesmo PR.
- A marca só age numa união de duas cópias. Uma cópia antiga posta no lugar com o serviço parado é lida como está: perde o que foi escrito depois dela e volta a ter o que foi removido depois dela.
- Voltar a uma versão anterior do serviço depois que o arquivo virou versão 2 deixa `/account/recovery/*` em 503 até a versão nova voltar.
- Uma cópia de outra história posta de volta com o serviço no ar entra como união, só com a marca da memória: as entradas que aquela história removeu podem voltar.
- Registros de remoção apagados por uma versão anterior do serviço, antes da versão 2, não deixaram marca.
- A frase da Política de Privacidade sobre o que fica das entradas de recuperação depois da exclusão ("por 30 dias") passa a citar a marca no PR das passkeys extras, que muda a versão dos Termos.
