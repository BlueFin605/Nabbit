// Import Lambda entry (built to dist/import/index.js): its own function so reserved concurrency caps
// import floods (see infrastructure/SYSDOC.md). Only the two import routes (/recipes/import, /recipes/images/import) are registered here, not the presign route.
import '../routes/import.js';

export { handler } from '../router.js';
