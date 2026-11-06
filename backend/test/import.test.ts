import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes } from '../src/router.js';
import { setLlmParser } from '../src/import/llm-parse.js';
import { registerImportRoutes, setImportDeps, IMPORT_LIMIT_PER_HOUR } from '../src/routes/import.js';
import { setDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';
import { ImportError } from '../src/import/import-error.js';
import { setImagePutter } from '../src/routes/images.js';

function event(sub: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/recipes/import',
    rawQueryString: '',
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST', path: '/recipes/import' }, authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
}
const call = async (body: unknown, sub = 'u1') => {
  const res = (await handler(event(sub, body))) as { statusCode: number; body?: string; headers?: Record<string, string> };
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined, headers: res.headers ?? {} };
};

const LD_HTML =
  '<html><head><script type="application/ld+json">' +
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Pancakes',
    image: 'https://example.com/p.jpg',
    recipeYield: '4',
    recipeIngredient: ['1 cup flour', '2 eggs'],
    recipeInstructions: ['Mix.', 'Cook.'],
  }) +
  '</script></head><body></body></html>';
const PLAIN_HTML =
  '<html><body><h1>Toast</h1><h2>Ingredients</h2><ul><li>2 slices bread</li><li>1 tbsp butter</li></ul>' +
  '<h2>Method</h2><ol><li>Toast the bread.</li><li>Butter it.</li></ol></body></html>';

let db: ReturnType<typeof createMemoryDb>;
let fetched: string[];
let page: () => Promise<{ url: string; html: string }>;
let nowMs: number;

beforeEach(() => {
  db = createMemoryDb();
  setDb(db);
  fetched = [];
  nowMs = Date.UTC(2026, 10, 2, 10, 15, 0);
  page = async () => ({ url: 'https://example.com/r', html: LD_HTML });
  setImportDeps({
    safeFetch: async (url) => {
      fetched.push(url);
      return page();
    },
    now: () => nowMs,
  });
  resetRoutes();
  registerImportRoutes();
});

describe('POST /recipes/import', () => {
  it('url with structured data returns a structured draft and imageUrl, saving nothing', async () => {
    const res = await call({ url: 'https://example.com/r' });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('structured');
    expect(res.json.draft.recipe.title).toBe('Pancakes');
    expect(res.json.imageUrl).toBe('https://example.com/p.jpg');
    expect(fetched).toEqual(['https://example.com/r']);
    const keys = [...db.items.values()].map((i) => i.sk);
    expect(keys.filter((k) => !k.startsWith('RATE#'))).toEqual([]);
  });

  it('structured import returns ranked candidates with imageUrl first', async () => {
    page = async () => ({
      url: 'https://example.com/r',
      html: LD_HTML.replace('</head>', '<meta property="og:image" content="/og.jpg"></head>'),
    });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.json.candidates).toEqual(['https://example.com/p.jpg', 'https://example.com/og.jpg']);
    expect(res.json.imageUrl).toBe(res.json.candidates[0]);
  });

  it('heuristic fallback returns candidates from og:image and the DOM', async () => {
    page = async () => ({
      url: 'https://example.com/r',
      html: PLAIN_HTML.replace('<body>', '<head><meta property="og:image" content="https://example.com/og.jpg"></head><body><img src="/big.jpg" width="600" height="400">'),
    });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.json.draft.confidence).toBe('heuristic');
    expect(res.json.candidates).toEqual(['https://example.com/og.jpg', 'https://example.com/big.jpg']);
    expect(res.json.imageUrl).toBe('https://example.com/og.jpg');
  });

  it('omits imageUrl and candidates when the page has no images, and for text imports', async () => {
    page = async () => ({ url: 'https://example.com/r', html: PLAIN_HTML });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.json).not.toHaveProperty('candidates');
    expect(res.json).not.toHaveProperty('imageUrl');
    const t = await call({ text: 'Toast\n\nIngredients\n2 slices bread\n\nMethod\n1. Toast.' });
    expect(t.json).not.toHaveProperty('candidates');
    expect(t.json).not.toHaveProperty('imageUrl');
  });

  it('page without structured data falls back to heuristic', async () => {
    page = async () => ({ url: 'https://example.com/r', html: PLAIN_HTML });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('heuristic');
    expect(res.json.draft.recipe.sourceUrl).toBe('https://example.com/r');
    expect(res.json.draft.recipe.ingredients.length).toBeGreaterThan(0);
  });

  it('text body goes straight to the text extractor without fetching', async () => {
    const res = await call({ text: 'Toast\n\nIngredients\n2 slices bread\n1 tbsp butter\n\nMethod\n1. Toast the bread.' });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('heuristic');
    expect(fetched).toEqual([]);
  });

  it.each([
    ['neither', {}],
    ['both', { url: 'https://example.com', text: 'x' }],
    ['non-string url', { url: 5 }],
    ['empty text', { text: '' }],
    ['text over 50,000 chars', { text: 'a'.repeat(50_001) }],
    ['no body', undefined],
    ['array body', []],
  ])('400 for %s', async (_n, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(fetched).toEqual([]);
  });

  it('accepts text of exactly 50,000 chars', async () => {
    expect((await call({ text: 'a'.repeat(50_000) })).status).toBe(200);
  });

  it.each(['bad_url', 'blocked_address', 'too_large', 'timeout', 'bad_status', 'not_html', 'too_many_redirects'] as const)(
    'ImportError %s maps to 422 {error: code}',
    async (code) => {
      page = async () => {
        throw new ImportError(code);
      };
      const res = await call({ url: 'https://example.com/r' });
      expect(res.status).toBe(422);
      expect(res.json).toEqual({ error: code });
    },
  );

  it('unexpected fetch failures are 500 internal', async () => {
    page = async () => {
      throw new Error('boom');
    };
    expect((await call({ url: 'https://example.com/r' })).status).toBe(500);
  });
});

describe('import rate limit', () => {
  it('allows 30 per hour then 429 with retry-after; another owner is unaffected', async () => {
    expect(IMPORT_LIMIT_PER_HOUR).toBe(30);
    for (let i = 0; i < 30; i++) expect((await call({ text: 'Soup\n\nIngredients\n1 onion' })).status).toBe(200);
    const res = await call({ text: 'Soup' });
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: 'rate_limited' });
    expect(res.headers['retry-after']).toBe(String(45 * 60));
    expect((await call({ text: 'Soup' }, 'u2')).status).toBe(200);
  });

  it('resets in the next hour bucket', async () => {
    for (let i = 0; i < 31; i++) await call({ text: 'Soup' });
    nowMs += 3600_000;
    expect((await call({ text: 'Soup' })).status).toBe(200);
  });

  it('counts before the fetch, so failed imports still use quota', async () => {
    page = async () => {
      throw new ImportError('timeout');
    };
    for (let i = 0; i < 30; i++) await call({ url: 'https://example.com/r' });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.status).toBe(429);
    expect(fetched.length).toBe(30);
  });

  it('does not count invalid requests', async () => {
    for (let i = 0; i < 40; i++) await call({});
    expect((await call({ text: 'Soup' })).status).toBe(200);
  });

  it('stores a counter item with a 2 hour ttl', async () => {
    await call({ text: 'Soup' });
    const hour = Math.floor(nowMs / 3600_000);
    const item = db.items.get(`OWNER#u1\u0000RATE#import#${hour}`);
    expect(item?.count).toBe(1);
    expect(item?.ttl).toBe(Math.floor(nowMs / 1000) + 7200);
  });
});

describe('POST /recipes/images/import', () => {
  let imageUrls: string[];
  let image: () => Promise<{ url: string; contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array }>;
  let puts: { key: string; contentType: string; bytes: Uint8Array }[];
  const callImg = async (body: unknown, sub: string | null = 'u1') => {
    const ev = event(sub ?? 'x', body) as unknown as { rawPath: string; requestContext: { http: { path: string }; authorizer?: unknown } };
    ev.rawPath = '/recipes/images/import';
    ev.requestContext.http.path = '/recipes/images/import';
    if (sub === null) delete ev.requestContext.authorizer;
    const res = (await handler(ev as unknown as APIGatewayProxyEventV2)) as { statusCode: number; body?: string; headers?: Record<string, string> };
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined, headers: res.headers ?? {} };
  };
  beforeEach(() => {
    imageUrls = [];
    puts = [];
    image = async () => ({ url: 'https://example.com/p.jpg', contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) });
    setImportDeps({
      fetchImage: async (u) => {
        imageUrls.push(u);
        return image();
      },
      now: () => nowMs,
    });
    setImagePutter(async (r) => {
      puts.push(r);
    });
  });
  afterEach(() => setImagePutter(undefined));

  it('fetches, stores under the owner prefix and returns imageKey', async () => {
    const res = await callImg({ url: ' https://example.com/p.jpg ' });
    expect(res.status).toBe(200);
    expect(res.json.imageKey).toMatch(/^u1\/[0-9a-f-]{36}\.jpg$/);
    expect(imageUrls).toEqual(['https://example.com/p.jpg']);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(res.json.imageKey);
    expect(puts[0]!.contentType).toBe('image/jpeg');
  });

  it('scopes the key to the caller', async () => {
    const res = await callImg({ url: 'https://example.com/p.jpg' }, 'someone-else');
    expect(res.json.imageKey.startsWith('someone-else/')).toBe(true);
  });

  it.each([{}, { url: '' }, { url: 5 }, { url: 'http://example.com/p.jpg' }, { url: 'ftp://x/y.png' }, 'str'])(
    'rejects %j with 400 and does not fetch or count',
    async (b) => {
      expect((await callImg(b)).status).toBe(400);
      expect(imageUrls).toEqual([]);
      expect([...db.items.values()].filter((i) => i.sk.startsWith('RATE#'))).toEqual([]);
    },
  );

  it('401 without a sub', async () => {
    expect((await callImg({ url: 'https://example.com/p.jpg' }, null)).status).toBe(401);
    expect(imageUrls).toEqual([]);
  });

  it.each(['not_image', 'blocked_address'] as const)('maps ImportError %s to 422', async (code) => {
    image = async () => {
      throw new ImportError(code);
    };
    const res = await callImg({ url: 'https://example.com/p.jpg' });
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: code });
    expect(puts).toEqual([]);
  });

  it('shares the import rate limit: counts, and 429s the 31st call', async () => {
    for (let i = 0; i < 30; i++) expect((await callImg({ url: 'https://example.com/p.jpg' })).status).toBe(200);
    const res = await callImg({ url: 'https://example.com/p.jpg' });
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: 'rate_limited' });
    expect(res.headers['retry-after']).toBe(String(45 * 60));
    expect(imageUrls).toHaveLength(30);
  });

  it('counts against the same counter as /recipes/import', async () => {
    for (let i = 0; i < 29; i++) await call({ text: 'Soup' });
    expect((await callImg({ url: 'https://example.com/p.jpg' })).status).toBe(200);
    expect((await callImg({ url: 'https://example.com/p.jpg' })).status).toBe(429);
  });
});

describe('LLM fallback and Instagram needs_text', () => {
  const LOW = 'Mystery dish\n\nIngredients\n2 cups flour\n';
  const LOW_WITH_STEP = 'Dish\n\nIngredients\n2 cups flour\n\nMethod\n1. Mix.';
  const GOOD = 'Toast\n\nIngredients\n2 slices bread\n1 tbsp butter\n\nMethod\n1. Toast the bread.\n2. Butter it.';
  const aiRecipe = {
    title: 'AI Dish',
    servings: 4,
    ingredients: [{ name: 'flour', quantity: 240, unit: 'g' }],
    steps: ['Mix.', 'Bake.'],
    tags: [],
  };
  let parsed: { text: string; sourceUrl?: string }[];
  let result: () => Promise<unknown>;

  beforeEach(() => {
    parsed = [];
    result = async () => aiRecipe;
    setLlmParser({
      parse: async (text, ctx) => {
        parsed.push({ text, sourceUrl: ctx.sourceUrl });
        return (await result()) as never;
      },
    });
  });
  afterEach(() => setLlmParser(undefined));

  it.each(['https://instagram.com/p/abc/', 'https://www.instagram.com/reel/abc/', 'https://instagr.am/p/abc', 'https://WWW.Instagram.com/p/x'])(
    'instagram url %s -> 422 needs_text without fetching, still counted',
    async (url) => {
      const res = await call({ url });
      expect(res.status).toBe(422);
      expect(res.json).toEqual({ error: 'needs_text' });
      expect(fetched).toEqual([]);
      const hour = Math.floor(nowMs / 3_600_000);
      expect(db.items.get(`OWNER#u1\u0000RATE#import#${hour}`)?.count).toBe(1);
    },
  );

  it.each(['https://instagram.com./p/abc/', 'https://www.instagram.com./p/abc/', 'https://m.instagram.com/p/abc/'])(
    'trailing-dot and mobile host %s -> needs_text',
    async (url) => {
      const res = await call({ url });
      expect(res.status).toBe(422);
      expect(res.json).toEqual({ error: 'needs_text' });
      expect(fetched).toEqual([]);
    },
  );

  it.each([
    'https://notinstagram.com/r',
    'http://instagram.com/p/abc',
    'https://instagram.com.evil.com/p/abc',
    'https://instagram.com@evil.com/p/abc',
    'https://instagram.com..evil.com/p/abc',
  ])('lookalike %s is not treated as instagram', async (url) => {
    page = async () => ({ url, html: LD_HTML });
    const res = await call({ url });
    expect(res.json).not.toEqual({ error: 'needs_text' });
    expect(fetched).toEqual([url]);
  });

  it('low-confidence text calls the parser and returns an ai draft', async () => {
    const res = await call({ text: LOW });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('ai');
    expect(res.json.draft.recipe.title).toBe('AI Dish');
    expect(res.json.draft.recipe.ingredients[0].unit).toBe('g');
    expect(parsed).toHaveLength(1);
  });

  it('page-text fallback passes sourceUrl to the parser', async () => {
    page = async () => ({ url: 'https://example.com/r', html: '<html><body><p>Just some words</p></body></html>' });
    const res = await call({ url: 'https://example.com/r' });
    expect(res.json.draft.confidence).toBe('ai');
    expect(parsed[0].sourceUrl).toBe('https://example.com/r');
  });

  it('good heuristic text does not call the parser', async () => {
    const res = await call({ text: GOOD });
    expect(res.json.draft.confidence).toBe('heuristic');
    expect(parsed).toHaveLength(0);
  });

  it('structured data never calls the parser', async () => {
    const res = await call({ url: 'https://example.com/r' });
    expect(res.json.draft.confidence).toBe('structured');
    expect(parsed).toHaveLength(0);
  });

  it('parser returning undefined keeps the heuristic draft', async () => {
    result = async () => undefined;
    const res = await call({ text: LOW });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('heuristic');
  });

  it('parser throwing keeps the heuristic draft', async () => {
    result = async () => {
      throw new Error('boom');
    };
    const res = await call({ text: LOW });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('heuristic');
  });

  it('keeps the heuristic draft when the LLM has more ingredients but fewer steps', async () => {
    result = async () => ({
      ...aiRecipe,
      ingredients: [
        { name: 'flour', quantity: 240, unit: 'g' },
        { name: 'egg', quantity: 2 },
      ],
      steps: [],
    });
    const res = await call({ text: LOW_WITH_STEP });
    expect(res.json.draft.confidence).toBe('heuristic');
  });

  it('keeps the heuristic draft when the LLM has more steps but fewer ingredients', async () => {
    result = async () => ({ ...aiRecipe, ingredients: [], steps: ['Mix.', 'Bake.'] });
    const res = await call({ text: LOW_WITH_STEP });
    expect(res.json.draft.confidence).toBe('heuristic');
  });

  it('keeps the heuristic draft when the LLM has fewer ingredients and fewer steps', async () => {
    result = async () => ({ ...aiRecipe, ingredients: [], steps: [] });
    const res = await call({ text: LOW_WITH_STEP });
    expect(res.json.draft.confidence).toBe('heuristic');
  });

  it('skips the parser once the daily cap is used, with a ttl on the counter', async () => {
    for (let i = 0; i < 30; i++) {
      await call({ text: LOW });
      // keep under the hourly limit by moving to the next hour every 20 calls
      if (i === 19) nowMs += 3_600_000;
    }
    expect(parsed).toHaveLength(30);
    const res = await call({ text: LOW });
    expect(res.status).toBe(200);
    expect(res.json.draft.confidence).toBe('heuristic');
    expect(parsed).toHaveLength(30);
    const item = db.items.get('OWNER#u1\u0000RATE#llm#2026-11-02');
    expect(item?.count).toBe(31);
    expect(item?.ttl).toBe(Math.floor(nowMs / 1000) + 2 * 86400);
  });

  it('401 without a sub is unchanged', async () => {
    const res = await call({ text: LOW }, null as never);
    expect(res.status).toBe(401);
  });
});
