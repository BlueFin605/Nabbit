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
import { safeFetch, safeFetchImage } from './import/safe-fetch.js';
// Importing the module registers POST /recipes/import on the shared router; production serves it from
// handlers/import.ts, and handlers/api.ts deliberately does not include it.
import { setImportDeps } from './routes/import.js';
import { setLlmParser } from './import/llm-parse.js';
import { parseIngredient, toMetric } from '@nabbit/recipe-core';
import { sendLambdaResult, toLambdaEvent, type LocalHandler } from './local-adapter.js';

/**
 * Local-dev-only e2e hook (see e2e-fixture-fetch.ts): when NODE_ENV=development and NABBIT_E2E_FIXTURE_FETCH=1,
 * the importer's safeFetch gets fixture resolver/transport deps. The guard itself is unchanged.
 * Returns whether the hook was installed. Never called from the Lambda handlers.
 */
export function installE2eFixtureFetch(env: NodeJS.ProcessEnv = process.env): boolean {
  const deps = fixtureFetchDeps(env);
  if (!deps) return false;
  setImportDeps({ safeFetch: (u) => safeFetch(u, deps), fetchImage: (u) => safeFetchImage(u, deps) });
  return true;
}

/** Marker a pasted text must contain for the e2e fake LLM to answer. */
export const FAKE_LLM_MARKER = '[[fake-llm]]';

/**
 * Local-dev-only e2e hook: when NODE_ENV=development and NABBIT_E2E_FAKE_LLM=1, the import route's LLM
 * parser is a deterministic stub (no Bedrock). Returns a fixed recipe for text containing FAKE_LLM_MARKER,
 * otherwise undefined (so the heuristic draft stands). Never called from the Lambda handlers.
 */
export function installE2eFakeLlm(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'development' || env.NABBIT_E2E_FAKE_LLM !== '1') return false;
  setLlmParser({
    parse: async (text) =>
      text.includes(FAKE_LLM_MARKER)
        ? {
            title: 'Fake AI Soup',
            servings: 4,
            ingredients: ['2 cups fake stock', '1 onion', '3 carrots'].map((l) => toMetric(parseIngredient(l))),
            steps: ['Chop the onion and carrots.', 'Simmer everything in the stock.', 'Serve hot.'],
            tags: [],
          }
        : undefined,
  });
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
  installE2eFakeLlm();
  const server = await start();
  const addr = server.address();
  console.log(`Nabbit API listening on port ${typeof addr === 'object' && addr ? addr.port : addr}`);
}
