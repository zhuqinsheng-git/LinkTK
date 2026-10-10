// Module: Error text normalization across features.
// Owns: errorMessage.
// Depends on: core/i18n.js.
// Called by: feature modules and app.js.

import { t } from "./i18n.js";

function errorMessage(error, fallback = t("error.fallback")) {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return fallback;
}

export { errorMessage };
