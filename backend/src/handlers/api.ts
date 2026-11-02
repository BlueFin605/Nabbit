// API Lambda entry (built to dist/api/index.js). Later tickets register routes by importing
// their route modules here, before the handler is exported.
import '../routes/recipes.js';
import '../routes/images.js';
import '../routes/lists.js';
// Also registered here for local dev; in AWS POST /recipes/import has its own route and Lambda (handlers/import.ts).
import '../routes/import.js';

export { handler } from '../router.js';
