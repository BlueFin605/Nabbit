export type ImportErrorCode =
  | 'bad_url'
  | 'blocked_address'
  | 'too_large'
  | 'timeout'
  | 'bad_status'
  | 'not_html'
  | 'too_many_redirects';

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ImportError';
  }
}
