// Single source of the e2e stack's ports/names (env-overridable); shared by stack.mjs and playwright.config.ts.
const n = (name, def) => Number(process.env[name] ?? def);
export const ports = {
  localstack: n('E2E_LOCALSTACK_PORT', 4577),
  backend: n('E2E_BACKEND_PORT', 3010),
  frontend: n('E2E_FRONTEND_PORT', 4210),
  fixture: n('E2E_FIXTURE_PORT', 4211),
  container: process.env.E2E_CONTAINER ?? 'nabbit-e2e-localstack',
  table: 'nabbit-e2e-data',
  bucket: 'nabbit-e2e-images',
};
