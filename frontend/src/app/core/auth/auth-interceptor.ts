import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Auth } from './auth';

/** Set on the single retry so a second 401 does not loop back into refresh (fresh context; never mutated). */
export const RETRIED = new HttpContextToken<boolean>(() => false);

/** Attaches `Authorization: Bearer <id token>` to calls to the Nabbit API; on 401 refreshes once, else signs out. */
export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  if (!req.url.startsWith(environment.apiBaseUrl)) return next(req);

  const auth = inject(Auth);
  const token = auth.getIdToken();
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) return throwError(() => err);
      if (req.context.get(RETRIED)) {
        auth.signOut();
        return throwError(() => err);
      }
      return from(auth.refreshIdToken()).pipe(
        switchMap((refreshed) => {
          if (!refreshed) {
            auth.signOut();
            return throwError(() => err);
          }
          const retry = req.clone({
            setHeaders: { Authorization: `Bearer ${refreshed}` },
            context: new HttpContext().set(RETRIED, true),
          });
          return next(retry).pipe(
            catchError((retryErr: unknown) => {
              if (retryErr instanceof HttpErrorResponse && retryErr.status === 401) auth.signOut();
              return throwError(() => retryErr);
            }),
          );
        }),
      );
    }),
  );
};
