import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export interface RequestCtx {
  ownerId: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}
export type RouteHandler = (ctx: RequestCtx) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface Route {
  method: Method;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}
const routes: Route[] = [];

const split = (path: string): string[] => path.split('/').filter(Boolean);

/** Register a route. Patterns support `{name}` path parameters, e.g. `/recipes/{id}`. */
export function route(method: Method, pattern: string, h: RouteHandler): void {
  if (routes.some((r) => r.method === method && r.pattern === pattern)) {
    throw new Error(`Route already registered: ${method} ${pattern}`);
  }
  routes.push({ method, pattern, segments: split(pattern), handler: h });
}

/** Test helper: clear all registered routes. */
export function resetRoutes(): void {
  routes.length = 0;
}

function match(r: Route, method: string, parts: string[]): Record<string, string> | undefined {
  if (r.method !== method || r.segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = r.segments[i]!;
    const part = parts[i]!;
    if (seg.startsWith('{') && seg.endsWith('}')) {
      try {
        params[seg.slice(1, -1)] = decodeURIComponent(part);
      } catch {
        return undefined;
      }
    } else if (seg !== part) return undefined;
  }
  return params;
}

const json = (statusCode: number, body?: unknown, headers?: Record<string, string>): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// Structurally a Lambda handler (the runtime passes extra args we ignore); the narrow return type
// (no `void`) lets the local dev server call it directly.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    // Ownership comes ONLY from the verified JWT claim, never from the request body.
    const sub = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims?.sub;
    if (typeof sub !== 'string' || sub === '') return json(401, { error: 'unauthorized' });

    const method = event.requestContext.http.method.toUpperCase();
    const parts = split(event.rawPath);
    for (const r of routes) {
      const params = match(r, method, parts);
      if (!params) continue;
      let body: unknown;
      if (event.body) {
        const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'invalid_json' });
        }
      }
      const query = Object.fromEntries(new URLSearchParams(event.rawQueryString ?? ''));
      const result = await r.handler({ ownerId: sub, params, query, body });
      return json(result.status, result.body, result.headers);
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'internal' });
  }
};
