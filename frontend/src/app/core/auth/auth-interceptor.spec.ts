import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { Auth } from './auth';
import { authInterceptor, isApiUrl } from './auth-interceptor';

const API = `${environment.apiBaseUrl}/recipes`;

function setup(auth: Record<string, unknown>) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: Auth, useValue: auth },
    ],
  });
  return { http: TestBed.inject(HttpClient), ctrl: TestBed.inject(HttpTestingController) };
}

describe('authInterceptor', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('attaches the bearer ID token to API calls', () => {
    const { http, ctrl } = setup({ getIdToken: () => 'tok123' });
    http.get(API).subscribe();
    const req = ctrl.expectOne(API);
    expect(req.request.headers.get('Authorization')).toBe('Bearer tok123');
    req.flush([]);
  });

  it('does not attach credentials to other origins (e.g. presigned S3 uploads)', () => {
    const { http, ctrl } = setup({ getIdToken: () => 'tok123' });
    http.post('https://bucket.s3.amazonaws.com/', {}).subscribe();
    const req = ctrl.expectOne('https://bucket.s3.amazonaws.com/');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
  });

  it('sends no header when signed out', () => {
    const { http, ctrl } = setup({ getIdToken: () => null });
    http.get(API).subscribe();
    const req = ctrl.expectOne(API);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush([]);
  });

  it('on 401 refreshes the token and retries once', async () => {
    const auth = { getIdToken: () => 'old', refreshIdToken: jest.fn().mockResolvedValue('new'), signOut: jest.fn() };
    const { http, ctrl } = setup(auth);
    const result = jest.fn();
    http.get(API).subscribe(result);
    ctrl.expectOne(API).flush('no', { status: 401, statusText: 'Unauthorized' });
    await Promise.resolve();
    await Promise.resolve();
    const retry = ctrl.expectOne(API);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new');
    retry.flush(['ok']);
    expect(result).toHaveBeenCalledWith(['ok']);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('signs out when the refresh yields no session', async () => {
    const auth = { getIdToken: () => 'old', refreshIdToken: jest.fn().mockResolvedValue(null), signOut: jest.fn() };
    const { http, ctrl } = setup(auth);
    const error = jest.fn();
    http.get(API).subscribe({ error });
    ctrl.expectOne(API).flush('no', { status: 401, statusText: 'Unauthorized' });
    await Promise.resolve();
    await Promise.resolve();
    expect(auth.signOut).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe('isApiUrl', () => {
  it('matches the API origin and rejects lookalike hosts', () => {
    const base = environment.apiBaseUrl;
    expect(isApiUrl(`${base}/recipes`)).toBe(true);
    expect(isApiUrl(base)).toBe(true);
    const u = new URL(base);
    expect(isApiUrl(`${u.protocol}//${u.host}.evil.tld/recipes`)).toBe(false);
    expect(isApiUrl(`${u.protocol}//${u.hostname}.evil.tld${u.port ? ':' + u.port : ''}/x`)).toBe(false);
    expect(isApiUrl(`${base}@evil.tld/x`)).toBe(false);
    expect(isApiUrl('https://bucket.s3.amazonaws.com/')).toBe(false);
  });

  it('does not treat a relative URL as the API unless the API shares the app origin', () => {
    expect(isApiUrl('/img/abc.jpg')).toBe(false);
    expect(isApiUrl('not a url ::')).toBe(false);
  });
});
