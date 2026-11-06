export interface Environment {
  production: boolean;
  /** API origin with no trailing slash, e.g. https://api.nabbit.example.com. */
  apiBaseUrl: string;
  /** Base for recipe images (`${imageBaseUrl}/${imageKey}`), no trailing slash. `/img` = same-origin CloudFront path. */
  imageBaseUrl: string;
  cognito: {
    region: string;
    userPoolId: string;
    clientId: string;
    /** Hosted UI domain without scheme, e.g. nabbit-auth-production.auth.<region>.amazoncognito.com. */
    domain: string;
    redirectUri: string;
  };
  /** Local dev only: skip Cognito and use a mock token. Always false in production builds. */
  disableAuth: boolean;
}
