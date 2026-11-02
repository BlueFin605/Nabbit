/**
 * Local dev server: Express on port 3000 adapting HTTP requests to the same Lambda handlers
 * production uses. Local only; never bundled (the build only bundles src/handlers).
 */
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { handler as apiHandler } from './handlers/api.js';
import { handler as healthHandler } from './handlers/health.js';
import { fixtureFetchDeps } from './e2e-fixture-fetch.js';
import { safeFetch } from './import/safe-fetch.js';
import { setImportDeps } from './routes/import.js';
import { sendLambdaResult, toLambdaEvent, type LocalHandler } from './local-adapter.js';

/**
 * Local-dev-only e2e hook (see e2e-fixture-fetch.ts): when NODE_ENV=development and NABBIT_E2E_FIXTURE_FETCH=1,
 * the importer's safeFetch gets fixture resolver/transport deps. The guard itself is unchanged.
 * Returns whether the hook was installed. Never called from the Lambda handlers.
 */
export function installE2eFixtureFetch(env: NodeJS.ProcessEnv = process.env): boolean {
  const deps = fixtureFetchDeps(env);
  if (!deps) return false;
  setImportDeps({ safeFetch: (u) => safeFetch(u, deps) });
  return true;
}

export function createApp(): express.Express {
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-dev-sub');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.raw({ type: () => true, limit: '10mb' }));
  app.use(async (req, res) => {
    try {
      // /health is a standalone Lambda in production; everything else goes via the API router.
      const handler: LocalHandler = req.path === '/health' ? healthHandler : apiHandler;
      sendLambdaResult(res, await handler(toLambdaEvent(req)));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  return app;
}

export function start(port = Number(process.env.PORT ?? 3000)): Promise<Server> {
  return new Promise((resolve) => {
    const server = createApp().listen(port, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installE2eFixtureFetch();
  const server = await start();
  const addr = server.address();
  console.log(`Nabbit API listening on port ${typeof addr === 'object' && addr ? addr.port : addr}`);
}
