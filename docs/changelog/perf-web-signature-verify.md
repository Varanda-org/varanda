### Alterado
- O nó do navegador verifica as assinaturas de certificado e de nome de usuário com o WebCrypto Ed25519 do navegador quando ele existe, e guarda um resumo das assinaturas que já achou válidas, para a visita seguinte não verificar tudo de novo em JavaScript (parte da #353). Verificação em `docs/verification/perf-web-signature-verify.md`.
