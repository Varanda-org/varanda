### Corrigido

- Nó do core: num grupo em que um diário já ocupa as 32 vagas de escritor, a entrada mais antiga agora toma a vaga do último a entrar, como as entradas do diário mandam (PR `fix/group-cap-opening-writer`). Antes, saía outro escritor no lugar dele quando o último ainda estava abrindo, quando dois portões liam as entradas do diário ao mesmo tempo, ou quando a cópia guardada do diário ainda não tinha as últimas entradas; e um escritor despejado contava de novo enquanto seus blocos eram apagados, deixando 33 guardados.
