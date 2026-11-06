/**
 * Local dev only: turns Express requests into API Gateway HTTP API (v2) events and Lambda
 * results back into Express responses. Lives outside src/handlers so it is never bundled.
 */
import type { Request, Response } from 'express';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface LambdaResult {
  statusCode?: number;
  headers?: Record<string, string | number | boolean>;
  body?: string;
  isBase64Encoded?: boolean;
}
export type LocalHandler = (event: APIGatewayProxyEventV2) => Promise<LambdaResult>;

/** Decode (without verifying) the `sub` of a dev JWT. */
export function subFromJwt(token: string): string | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the caller's `ownerId`. A bearer JWT's `sub` wins; `X-Dev-Sub` is honoured only
 * when NODE_ENV=development. Production verification is API Gateway's Cognito authorizer.
 */
export function resolveSub(headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const auth = headers['authorization'];
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const sub = subFromJwt(auth.slice(7).trim());
    if (sub) return sub;
  }
  if (env.NODE_ENV === 'development' && headers['x-dev-sub']) return headers['x-dev-sub'];
  return undefined;
}

export function toLambdaEvent(req: Request, env: NodeJS.ProcessEnv = process.env): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(',');
  }
  const qIndex = req.originalUrl.indexOf('?');
  const rawQueryString = qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : '';
  const hasBody = Buffer.isBuffer(req.body) && req.body.length > 0;
  const sub = resolveSub(headers, env);
  const now = Date.now();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: req.path,
    rawQueryString,
    headers,
    queryStringParameters: rawQueryString ? Object.fromEntries(new URLSearchParams(rawQueryString)) : undefined,
    body: hasBody ? (req.body as Buffer).toString('base64') : undefined,
    isBase64Encoded: hasBody,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: req.method,
        path: req.path,
        protocol: 'HTTP/1.1',
        sourceIp: req.ip ?? '127.0.0.1',
        userAgent: req.get('user-agent') ?? '',
      },
      requestId: `local-${now}`,
      routeKey: '$default',
      stage: '$default',
      time: new Date(now).toISOString(),
      timeEpoch: now,
      ...(sub ? { authorizer: { jwt: { claims: { sub }, scopes: [] } } } : {}),
    },
  };
}

export function sendLambdaResult(res: Response, result: LambdaResult): void {
  res.status(result.statusCode ?? 200);
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, String(v));
  const body = result.body ?? '';
  res.send(result.isBase64Encoded ? Buffer.from(body, 'base64') : body);
}
