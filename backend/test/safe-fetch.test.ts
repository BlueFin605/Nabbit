import { describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { safeFetch, isBlockedAddress, connectInOrder, orderAddresses, responseFromIncoming } from '../src/import/safe-fetch.js';
import { ImportError } from '../src/import/import-error.js';

const PUBLIC = '93.184.216.34';
const html = (body = '<html>ok</html>', type = 'text/html; charset=utf-8', status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImportError) return e.code;
    throw e;
  }
  return 'no_error';
}

const resolvePublic = async () => [PUBLIC];

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0',
    '0.1.2.3', '224.0.0.1', '239.255.255.255', '255.255.255.255', '240.0.0.1', '192.0.0.1',
    '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:192.168.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::',
    '::127.0.0.1', '2001:db8::1', 'not-an-ip',
  ];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  const allowed = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '169.253.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  it.each(allowed)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('safeFetch', () => {
  it('returns final url and html and pins the validated IP', async () => {
    const fetchImpl = vi.fn(async () => html());
    const resolve = vi.fn(resolvePublic);
    const page = await safeFetch('https://Example.com/recipe?x=1#frag', { resolve, fetchImpl: fetchImpl as never });
    expect(page).toEqual({ url: 'https://example.com/recipe?x=1', html: '<html>ok</html>' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('example.com');
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(calledUrl).toBe('https://example.com/recipe?x=1');
    expect(init.pinnedAddress).toBe(PUBLIC);
    expect(init.redirect).toBe('manual');
    expect(String((init.headers as Record<string, string>)['user-agent'])).toMatch(/Nabbit/);
  });

  it('accepts application/xhtml+xml', async () => {
    const page = await safeFetch('https://example.com/', {
      resolve: resolvePublic,
      fetchImpl: (async () => html('<x/>', 'application/xhtml+xml')) as never,
    });
    expect(page.html).toBe('<x/>');
  });

  describe('url validation', () => {
    const never = vi.fn(async () => html());
    const bad = [
      'http://example.com/', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://example.com/', 'javascript:alert(1)',
      'https://user:pw@example.com/', 'https://user@example.com/', 'https://example.com:8443/', 'https://example.com:80/',
      'https://example.com:22/', 'not a url', '', 'https://', '//example.com/',
    ];
    it.each(bad)('rejects %j as bad_url', async (u) => {
      expect(await codeOf(safeFetch(u, { resolve: resolvePublic, fetchImpl: never as never }))).toBe('bad_url');
    });
    it('allows explicit :443', async () => {
      const page = await safeFetch('https://example.com:443/a', { resolve: resolvePublic, fetchImpl: (async () => html()) as never });
      expect(page.url).toBe('https://example.com/a');
    });
    it('rejects unresolvable hosts', async () => {
      const code = await codeOf(safeFetch('https://nx.example/', { resolve: async () => [], fetchImpl: never as never }));
      expect(code).toBe('bad_url');
      const code2 = await codeOf(
        safeFetch('https://nx.example/', {
          resolve: async () => {
            throw new Error('ENOTFOUND');
          },
          fetchImpl: never as never,
        }),
      );
      expect(code2).toBe('bad_url');
    });
  });

  describe('blocked addresses', () => {
    const cases: Array<[string, string[]]> = [
      ['loopback', ['127.0.0.1']], ['10/8', ['10.1.2.3']], ['172.16/12', ['172.20.0.1']], ['192.168/16', ['192.168.0.9']],
      ['metadata', ['169.254.169.254']], ['cgnat', ['100.64.0.5']], ['unspecified', ['0.0.0.0']], ['multicast', ['224.0.0.251']],
      ['v6 loopback', ['::1']], ['v6 ula', ['fd00::1']], ['v6 link-local', ['fe80::1']], ['v6 unspecified', ['::']],
      ['v4-mapped loopback', ['::ffff:127.0.0.1']], ['v4-mapped metadata', ['::ffff:a9fe:a9fe']],
      ['mixed public + private (private last)', [PUBLIC, '10.0.0.1']],
      ['mixed public + private (private first)', ['192.168.1.1', PUBLIC]],
      ['mixed public v4 + v6 loopback', [PUBLIC, '::1']],
      ['garbage address', ['bogus']],
    ];
    it.each(cases)('blocks hostname resolving to %s', async (_n, addrs) => {
      const fetchImpl = vi.fn(async () => html());
      const code = await codeOf(safeFetch('https://evil.example/', { resolve: async () => addrs, fetchImpl: fetchImpl as never }));
      expect(code).toBe('blocked_address');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    const literals = [
      'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/',
      'https://2130706433/', 'https://0x7f.0.0.1/', 'https://017700000001/', 'https://127.1/', 'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:a9fe:a9fe]/', 'https://[fe80::1]/', 'https://[fd00::1]/', 'https://10.0.0.1/', 'https://0.0.0.0/',
      'https://foo.localhost/', 'https://localhost./',
    ];
    it.each(literals)('blocks literal/localhost %s without trusting the resolver', async (u) => {
      const fetchImpl = vi.fn(async () => html());
      // Even a resolver that claims a public address must not rescue a literal-IP or localhost URL.
      const code = await codeOf(safeFetch(u, { resolve: resolvePublic, fetchImpl: fetchImpl as never }));
      expect(code).toBe('blocked_address');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('redirects', () => {
    it('follows a relative redirect and reports final url', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(redirect('/final')).mockResolvedValueOnce(html());
      const page = await safeFetch('https://example.com/a', { resolve: resolvePublic, fetchImpl: fetchImpl as never });
      expect(page.url).toBe('https://example.com/final');
    });

    it.each(['https://localhost/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://10.0.0.1/x'])(
      'blocks redirect to %s',
      async (target) => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(target)).mockResolvedValue(html());
        const code = await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never }));
        expect(code).toBe('blocked_address');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );

    it('re-resolves each hop and blocks a hop whose host resolves privately', async () => {
      const resolve = vi.fn(async (h: string) => (h === 'internal.example' ? ['10.0.0.5'] : [PUBLIC]));
      const fetchImpl = vi.fn().mockResolvedValueOnce(redirect('https://internal.example/')).mockResolvedValue(html());
      const code = await codeOf(safeFetch('https://example.com/', { resolve, fetchImpl: fetchImpl as never }));
      expect(code).toBe('blocked_address');
      expect(resolve).toHaveBeenCalledWith('internal.example');
    });

    it('rejects redirect to http, other schemes, ports, credentials', async () => {
      for (const target of ['http://example.com/', 'file:///etc/passwd', 'https://example.com:8443/', 'https://u:p@example.com/', 'ftp://example.com/']) {
        const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(target)).mockResolvedValue(html());
        expect(await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never }))).toBe('bad_url');
      }
    });

    it('rejects a redirect with no Location', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
      expect(await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never }))).toBe('bad_status');
    });

    it('allows exactly 4 redirects', async () => {
      const fetchImpl = vi.fn();
      for (let i = 1; i <= 4; i++) fetchImpl.mockResolvedValueOnce(redirect(`/r${i}`));
      fetchImpl.mockResolvedValueOnce(html());
      const page = await safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never });
      expect(page.url).toBe('https://example.com/r4');
    });

    it('fails on the 5th redirect', async () => {
      const fetchImpl = vi.fn(async () => redirect('/loop'));
      const code = await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never }));
      expect(code).toBe('too_many_redirects');
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    });
  });

  describe('response checks', () => {
    const run = (res: () => Response, opts: Record<string, unknown> = {}) =>
      safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: (async () => res()) as never, ...opts });

    it.each([404, 500, 403, 204])('status %i -> bad_status', async (s) => {
      expect(await codeOf(run(() => (s === 204 ? new Response(null, { status: s }) : html('x', 'text/html', s))))).toBe('bad_status');
    });
    it.each(['application/json', 'application/pdf', 'image/png', 'text/plain', 'application/octet-stream'])('%s -> not_html', async (t) => {
      expect(await codeOf(run(() => html('x', t)))).toBe('not_html');
    });
    it('missing content-type -> not_html', async () => {
      expect(await codeOf(run(() => new Response('x', { headers: {} })))).toBe('not_html');
    });
    it('body over 2 MB -> too_large', async () => {
      expect(await codeOf(run(() => html('a'.repeat(2 * 1024 * 1024 + 1))))).toBe('too_large');
    });
    it('body of exactly 2 MB is accepted', async () => {
      const page = await run(() => html('a'.repeat(2 * 1024 * 1024)));
      expect(page.html.length).toBe(2 * 1024 * 1024);
    });
    it('lying content-length over cap -> too_large without reading', async () => {
      expect(
        await codeOf(run(() => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) } }))),
      ).toBe('too_large');
    });
    it('chunked stream over cap aborts early', async () => {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(512 * 1024));
        },
      });
      const code = await codeOf(run(() => new Response(stream, { headers: { 'content-type': 'text/html' } })));
      expect(code).toBe('too_large');
      expect(pulled).toBeLessThan(10);
    });
    it('slow body -> timeout', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('<html>'));
        },
        pull: () => new Promise(() => {}),
      });
      const code = await codeOf(run(() => new Response(stream, { headers: { 'content-type': 'text/html' } }), { timeoutMs: 50 }));
      expect(code).toBe('timeout');
    });
    it('hanging request (honours abort signal) -> timeout', async () => {
      const fetchImpl = (_u: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      const code = await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never, timeoutMs: 50 }));
      expect(code).toBe('timeout');
    });
    it('hanging request ignoring the signal still times out', async () => {
      const fetchImpl = () => new Promise<Response>(() => {});
      const code = await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never, timeoutMs: 50 }));
      expect(code).toBe('timeout');
    });
    it('hanging DNS resolution -> timeout', async () => {
      const code = await codeOf(
        safeFetch('https://example.com/', { resolve: () => new Promise(() => {}), fetchImpl: (async () => html()) as never, timeoutMs: 50 }),
      );
      expect(code).toBe('timeout');
    });
    it('timeout is total across redirect hops', async () => {
      const fetchImpl = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return redirect('/next');
      });
      const code = await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never, timeoutMs: 80 }));
      expect(code).toBe('timeout');
    });
    it('transport failure -> bad_status', async () => {
      const fetchImpl = async () => {
        throw new Error('ECONNRESET');
      };
      expect(await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: fetchImpl as never }))).toBe('bad_status');
    });
  });
});

describe('responseFromIncoming (hostile upstream status)', () => {
  const incoming = (statusCode: number | undefined, body = 'x') =>
    Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers: { 'content-type': 'text/html', 'set-cookie': ['a=1', 'b=2'] } });

  it.each([100, 101, 199, 600, 601, 999])('maps status %i to 502 without throwing', (status) => {
    const res = responseFromIncoming(incoming(status) as never);
    expect(res.status).toBe(502);
  });
  it('maps a missing status to 502', () => {
    expect(responseFromIncoming(incoming(undefined) as never).status).toBe(502);
  });
  it('never throws for any status 100-999', () => {
    for (let s = 100; s <= 999; s++) {
      const res = responseFromIncoming(incoming(s) as never);
      expect(res.status).toBe(s >= 200 && s <= 599 ? s : 502);
    }
  });
  it('keeps real statuses and headers, null body for 204/304', async () => {
    const ok = responseFromIncoming(incoming(200, 'hello') as never);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('hello');
    expect(ok.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(responseFromIncoming(incoming(204) as never).body).toBeNull();
    expect(responseFromIncoming(incoming(304) as never).body).toBeNull();
  });

  it('a real node http client receiving "HTTP/1.1 999" yields a 502, not a throw', async () => {
    const server = createServer((sock) => {
      sock.end('HTTP/1.1 999 Hostile\r\ncontent-type: text/html\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await new Promise<Response>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port }, (r) => {
          try {
            resolve(responseFromIncoming(r));
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(502);
      void res.body?.cancel();
    } finally {
      server.close();
    }
  });

  it('safeFetch reports a 502 upstream as bad_status', async () => {
    const res = responseFromIncoming(incoming(999) as never);
    expect(await codeOf(safeFetch('https://example.com/', { resolve: resolvePublic, fetchImpl: (async () => res) as never }))).toBe('bad_status');
  });
});

describe('connectInOrder', () => {
  it('returns the first success and stops', async () => {
    const tried: string[] = [];
    const out = await connectInOrder(['a', 'b', 'c'], async (x) => {
      tried.push(x);
      return x;
    });
    expect(out).toBe('a');
    expect(tried).toEqual(['a']);
  });
  it('falls back to the next address on failure, in order', async () => {
    const tried: string[] = [];
    const out = await connectInOrder(['a', 'b', 'c'], async (x) => {
      tried.push(x);
      if (x !== 'c') throw new Error('ENETUNREACH');
      return x;
    });
    expect(out).toBe('c');
    expect(tried).toEqual(['a', 'b', 'c']);
  });
  it('throws the last error when all fail', async () => {
    await expect(
      connectInOrder(['a', 'b'], async (x) => {
        throw new Error(`fail-${x}`);
      }),
    ).rejects.toThrow('fail-b');
  });
  it('stops trying once the signal is aborted', async () => {
    const ac = new AbortController();
    const tried: string[] = [];
    await expect(
      connectInOrder(
        ['a', 'b'],
        async (x) => {
          tried.push(x);
          ac.abort();
          throw new Error('boom');
        },
        ac.signal,
      ),
    ).rejects.toThrow('boom');
    expect(tried).toEqual(['a']);
  });
});

describe('address ordering and validation', () => {
  const V6 = '2606:4700:4700::1111';
  const fetchWith = () => vi.fn(async () => html());
  const initOf = (f: ReturnType<typeof fetchWith>) => f.mock.calls[0] as unknown as [string, Record<string, unknown>];

  it('orders IPv4 before IPv6, stably', () => {
    expect(orderAddresses([V6, '8.8.8.8', '2001:4860:4860::8888', '1.1.1.1'])).toEqual(['8.8.8.8', '1.1.1.1', V6, '2001:4860:4860::8888']);
  });
  it('passes all validated addresses to the transport, IPv4 first, pinnedAddress = first', async () => {
    const f = fetchWith();
    await safeFetch('https://example.com/', { resolve: async () => [V6, PUBLIC], fetchImpl: f as never });
    const init = initOf(f)[1];
    expect(init.pinnedAddresses).toEqual([PUBLIC, V6]);
    expect(init.pinnedAddress).toBe(PUBLIC);
    expect(initOf(f)[0]).toBe('https://example.com/'); // hostname kept for SNI/Host
  });
  it('a blocked address anywhere in the answer blocks the host (no connect)', async () => {
    for (const answer of [[PUBLIC, V6, '10.0.0.1'], ['fe80::1', PUBLIC], [V6, '::ffff:127.0.0.1', PUBLIC]]) {
      const f = fetchWith();
      expect(await codeOf(safeFetch('https://example.com/', { resolve: async () => answer, fetchImpl: f as never }))).toBe('blocked_address');
      expect(f).not.toHaveBeenCalled();
    }
  });
  it('re-resolves and re-validates every hop with its own address list', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://other.example/x'))
      .mockResolvedValueOnce(html());
    const resolve = vi.fn(async (h: string) => (h === 'example.com' ? [V6, PUBLIC] : ['8.8.8.8', V6]));
    await safeFetch('https://example.com/', { resolve, fetchImpl: f as never });
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ pinnedAddresses: [PUBLIC, V6] });
    expect((f.mock.calls[1] as unknown[])[1]).toMatchObject({ pinnedAddresses: ['8.8.8.8', V6] });
  });
  it('an IP-literal host yields a single pinned address', async () => {
    const f = fetchWith();
    await safeFetch(`https://[${V6}]/`, { fetchImpl: f as never });
    expect(initOf(f)[1].pinnedAddresses).toEqual([V6]);
  });
});
