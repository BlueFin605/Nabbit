import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdates, RELOAD_PAGE } from './app-updates';

function setup(opts: { sw?: boolean; enabled?: boolean } = {}) {
  const events = new Subject<VersionEvent>();
  const sw = {
    isEnabled: opts.enabled ?? true,
    versionUpdates: events.asObservable(),
    checkForUpdate: jest.fn(() => Promise.resolve(false)),
    activateUpdate: jest.fn(() => Promise.resolve(true)),
  };
  const ref = { afterDismissed: () => new Subject<void>().asObservable() };
  const snack = { openFromComponent: jest.fn((..._args: unknown[]) => ref) };
  const reload = jest.fn();
  TestBed.configureTestingModule({
    providers: [
      ...(opts.sw === false ? [] : [{ provide: SwUpdate, useValue: sw }]),
      { provide: MatSnackBar, useValue: snack },
      { provide: RELOAD_PAGE, useValue: reload },
    ],
  });
  return { svc: TestBed.inject(AppUpdates), sw, snack, reload, events };
}

const ready = { type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } } as VersionEvent;

describe('AppUpdates', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is a no-op when SwUpdate is not provided', () => {
    const { svc, snack } = setup({ sw: false });
    expect(() => svc.start()).not.toThrow();
    expect(snack.openFromComponent).not.toHaveBeenCalled();
  });

  it('is a no-op when the service worker is disabled', () => {
    const { svc, sw, snack, events } = setup({ enabled: false });
    svc.start();
    events.next(ready);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    expect(snack.openFromComponent).not.toHaveBeenCalled();
  });

  it('checks for an update on startup and when the page becomes visible again', () => {
    const { svc, sw } = setup();
    svc.start();
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    const vis = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('shows one persistent prompt on VERSION_READY and ignores other events', () => {
    const { svc, snack, events } = setup();
    svc.start();
    events.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } });
    expect(snack.openFromComponent).not.toHaveBeenCalled();
    events.next(ready);
    events.next(ready);
    expect(snack.openFromComponent).toHaveBeenCalledTimes(1);
    const cfg = snack.openFromComponent.mock.calls[0][1] as { duration?: number };
    expect(cfg.duration).toBeUndefined();
  });

  it('reload activates the update then reloads the page', async () => {
    const { svc, sw, reload } = setup();
    await svc.reload();
    expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('survives a failing checkForUpdate', async () => {
    const { svc, sw } = setup();
    sw.checkForUpdate.mockRejectedValue(new Error('offline'));
    expect(() => svc.start()).not.toThrow();
    await Promise.resolve();
  });
});
