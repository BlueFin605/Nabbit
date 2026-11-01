import { describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/health';

describe('health handler', () => {
  it('returns 200 and {status:"ok"}', async () => {
    const res = await handler();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
