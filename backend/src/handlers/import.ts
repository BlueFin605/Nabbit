// Import Lambda entry (built to dist/import/index.js): its own function so reserved concurrency caps
// import floods (see infrastructure/SYSDOC.md). Only the import route is registered here.
import '../routes/import.js';

export { handler } from '../router.js';
