// SPDX-License-Identifier: Apache-2.0

// Point d'entrée du package @appstrate/module-anonymizer.
//   - `default`        = l'AppstrateModule chargé par le module loader (MODULES).
//   - exports nommés   = les briques que le seam LLM-proxy consomme :
//                        détecteur in-process + session réversible.
//
// Aucun de ces re-exports ne charge le binding natif onnxruntime à l'import :
// detector.ts n'importe GLiNER qu'en `import type` (effacé) + `import()`
// dynamique dans init(). Charger ce module = zéro empreinte runtime.
export { default } from "./module.ts";

export { InProcessDetector } from "./detector.ts";
export { AnonSession, type AnonBackend, type Mapping } from "./run-session.ts";
