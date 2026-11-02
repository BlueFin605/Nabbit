export interface Environment {
  production: boolean;
  /** API origin with no trailing slash, e.g. https://api.nabbit.example.com. */
  apiBaseUrl: string;
  cognito: {
    region: string;
    userPoolId: string;
    clientId: string;
    /** Hosted UI domain without scheme, e.g. auth.nabbit.example.com. */
    domain: string;
    redirectUri: string;
  };
  /** Local dev only: skip Cognito and use a mock token. Always false in production builds. */
  disableAuth: boolean;
}
