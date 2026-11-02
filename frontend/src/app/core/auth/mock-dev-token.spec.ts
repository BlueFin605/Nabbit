import { mockDevToken } from './auth';

const payloadOf = (token: string): { sub?: string } =>
  JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string };

describe('mockDevToken', () => {
  it('is a three-part JWT whose payload carries the sub the local backend reads', () => {
    const token = mockDevToken('abc');
    expect(token.split('.')).toHaveLength(3);
    expect(payloadOf(token).sub).toBe('abc');
  });

  it('defaults to the local dev user', () => {
    expect(payloadOf(mockDevToken()).sub).toBe('local-dev-user-id');
  });
});
