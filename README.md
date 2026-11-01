# Nabbit

Recipe import and scaling app: an Angular PWA frontend, a Node.js Lambda backend, and a shared recipe-core library.

## Layout

- `shared/recipe-core` - shared recipe parsing/scaling code (`@nabbit/recipe-core`)
- `backend` - Node 24 + TypeScript Lambda handlers, one per `src/handlers/<name>.ts`
- `frontend` - Angular PWA (added later)

## Configuration

Copy `config.example.json` and set `prefix`, `region`, `environment` and `domain` for your deployment.

## Build

```
npm ci
npm run lint
npm test
npm run build -w backend
```

The backend build bundles each handler with esbuild to `backend/dist/<name>/index.js` (CommonJS, node24).

Deployment is handled by the private Home repo, not this one. CI here only builds and tests.
