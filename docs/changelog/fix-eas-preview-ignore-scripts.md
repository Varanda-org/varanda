### Corrigido

- O build de preview da EAS (Android) não para mais na etapa Install dependencies. O perfil `preview`, e o `preview-simulator` que herda dele, passam a definir `npm_config_ignore_scripts=true`, como o perfil `production` e a CI, e o script de instalação do `onnxruntime-node` (só de `apps/cli`, sem uso no app) deixa de baixar binários CUDA que respondem 404 no builder Linux. O hook `eas-build-post-install` continua rodando (PR `fix/eas-preview-ignore-scripts`). Verificação em `docs/verification/fix-eas-preview-ignore-scripts.md`.
