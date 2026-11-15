export type ImportErrorCode =
  | 'bad_url'
  | 'blocked_address'
  | 'too_large'
  | 'timeout'
  | 'bad_status'
  | 'not_html'
  | 'not_image'
  | 'too_many_redirects'
  | 'needs_text'
  | 'not_a_recipe';

export class ImportError extends Error {
  constructor(
    public readonly code: ImportErrorCode,
    message?: string,
    /** Only for not_a_recipe: the LLM's short explanation, returned to the client. */
    public readonly reason?: string,
  ) {
    super(message ?? code);
    this.name = 'ImportError';
  }
}
