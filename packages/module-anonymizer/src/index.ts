// SPDX-License-Identifier: Apache-2.0

// Point d'entrée du package @appstrate/module-anonymizer.
//   - `default`        = l'AppstrateModule chargé par le module loader (MODULES).
//   - exports nommés   = les briques réutilisables que le seam (palier b)
//                        consommera : détecteur in-process, session réversible,
//                        middleware AI SDK, wrapper d'outils.
//
// Aucun de ces re-exports ne charge le binding natif onnxruntime à l'import :
// detector.ts n'importe GLiNER qu'en `import type` (effacé) + `import()`
// dynamique dans init(). Charger ce module = zéro empreinte runtime.
export { default } from "./module.ts";

export { InProcessDetector } from "./detector.ts";
export { AnonSession, type AnonBackend, type Mapping } from "./run-session.ts";
export { createAnonymizerMiddleware } from "./ai-middleware.ts";
export { wrapToolWithAnonymizer, wrapToolsWithAnonymizer } from "./tool-wrapper.ts";
