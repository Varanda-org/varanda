### Alterado

- O semeador passa a registrar, no log JSON, o instante absoluto (`at`, em ms desde 1970) nos eventos `ws` e `ready` e, ao desligar, o evento `stopped` com `drainMs`, `closeMs` e `stopListeningAt`, para medir numa implantação real o tempo de fechamento e o tempo em que a porta ficou sem escuta; nenhum comportamento muda (PR `feat/seeder-shutdown-timing`). Verificação em `docs/verification/feat-seeder-shutdown-timing.md`.
