### Alterado

- A leitura do perfil e do @nome de um diário não clona nem valida mais os registros de outro tipo, e os percursos do histórico de grupos (cada entrada ainda é lida uma vez) não copiam de novo nem validam os registros de outro tipo (parte da #353). Verificação em `docs/verification/perf-record-type-filter.md`.
