#!/usr/bin/env node
// Wraps `ng serve`, honouring $PORT (Aspire sets it). The dev environment (src/environments/environment.ts)
// points at the local API on :3000 with auth disabled.
import { spawn } from 'node:child_process';

const port = process.env.PORT || '5173';
const ng = spawn('ng', ['serve', `--port=${port}`], { stdio: 'inherit', shell: true });
ng.on('exit', (code) => process.exit(code || 0));
ng.on('error', (err) => {
  console.error('Failed to start ng serve:', err);
  process.exit(1);
});
