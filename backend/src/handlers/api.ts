// API Lambda entry (built to dist/api/index.js). Later tickets register routes by importing
// their route modules here, before the handler is exported.
import '../routes/recipes.js';
import '../routes/images.js';
import '../routes/lists.js';
// Deliberately NOT importing routes/import: POST /recipes/import lives only in handlers/import.ts (capped Lambda)
// and, for local dev, local.ts. This bundle must never be able to run imports.

export { handler } from '../router.js';
