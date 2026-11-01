// Placeholder API router. Replaced by the real router in later tickets; exists so the
// CDK stack has a backend/dist/api asset to package.
export const handler = async (): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => ({
  statusCode: 404,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: 'not_found' }),
});
