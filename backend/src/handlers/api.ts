// API Lambda entry (built to dist/api/index.js). Later tickets register routes by importing
// their route modules here, before the handler is exported.
import '../routes/recipes.js';

export { handler } from '../router.js';
