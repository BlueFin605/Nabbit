export interface HealthResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const handler = async (): Promise<HealthResponse> => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'ok' }),
});
