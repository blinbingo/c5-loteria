// Identificação/versionamento do MOTOR usado numa finalização.
// Para auditoria/reprodutibilidade, cada sorteio grava qual engine produziu o
// resultado. ENGINE_VERSION combina uma versão semântica do motor com o SHA do
// build (injetado como BUILD_SHA no deploy), quando disponível.
export const ENGINE_SEMVER = "bicho-engine@1.0.0";

export const ENGINE_VERSION = process.env.BUILD_SHA
  ? `${ENGINE_SEMVER}+${process.env.BUILD_SHA.slice(0, 12)}`
  : ENGINE_SEMVER;
