# Verificação: compartilhamento de página

Escopo: em Membro, `isPage` seleciona “Compartilhar página” no menu e no título do painel, além de `link da página`, `copiar link da página` e `compartilhar página` em ShareProfile. Pessoas mantêm os rótulos padrão. Link, compartilhamento direto e Diario não mudaram.

Resultados:

- `node apps/app/test/profileActions.test.js`: `# tests = 10/10 pass`, `# asserts = 38/38 pass`.
- `node apps/app/test/uiKit.test.js`: `# tests = 32/32 pass`, `# asserts = 287/287 pass`.
- `node apps/app/test/platformGate.test.js`: `# tests = 6/6 pass`, `# asserts = 840/840 pass`.
- `npm run lint` e `npm run demo` ("DEMO OK") passaram, junto com os 17 arquivos de teste alcançados pela mudança. A suíte completa roda na CI do GitHub.
- Regressão por substituição temporária de Membro a partir de cópia: fonte antiga, código 1, `# tests = 6/10 pass`, `# asserts = 32/38 pass`; somente menu corrigido, código 1, `# tests = 8/10 pass`, `# asserts = 35/38 pass`. O segundo caso falhou no título e nos rótulos do painel. Fonte corrigida restaurada: código 0, `# tests = 10/10 pass`, `# asserts = 38/38 pass`.

Verificações manuais NÃO executadas, nesta ordem:

1. Android, build de debug, e simulador iOS: página mostra “Compartilhar página” no menu e no painel, com os três rótulos de página; pessoa mostra “Compartilhar perfil”.
2. Web: conferir os mesmos textos para página e pessoa.
