import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdates, RELOAD_PAGE } from './app-updates';

function setup(opts: { sw?: boolean; enabled?: boolean } = {}) {
  const events = new Subject<VersionEvent>();
  const navEvents = new Subject<unknown>();
  const sw = {
    isEnabled: opts.enabled ?? true,
    versionUpdates: events.asObservable(),
    checkForUpdate: jest.fn(() => Promise.resolve(false)),
    activateUpdate: jest.fn(() => Promise.resolve(true)),
  };
  const dismissed: Array<Subject<{ dismissedByAction: boolean }>> = [];
  const refs: Array<{ dismiss: jest.Mock }> = [];
  const snack = {
    // Mirrors MatSnackBar's private handle on the snackbar currently on screen (undefined when none).
    _openedSnackBarRef: undefined as unknown,
    openFromComponent: jest.fn((..._args: unknown[]) => {
      const d = new Subject<{ dismissedByAction: boolean }>();
      dismissed.push(d);
      const ref = { afterDismissed: () => d.asObservable(), dismiss: jest.fn() };
      refs.push(ref);
      snack._openedSnackBarRef = ref;
      return ref;
    }),
  };
  const reload = jest.fn();
  TestBed.configureTestingModule({
    providers: [
      ...(opts.sw === false ? [] : [{ provide: SwUpdate, useValue: sw }]),
      { provide: MatSnackBar, useValue: snack },
      { provide: Router, useValue: { events: navEvents.asObservable() } },
      { provide: RELOAD_PAGE, useValue: reload },
    ],
  });
  /** Another snackbar replaces the prompt: Material dismisses it without the user acting. */
  const replaceByOther = (n = 0) => {
    snack._openedSnackBarRef = { other: true };
    dismissed[n].next({ dismissedByAction: false });
    dismissed[n].complete();
  };
  const navigate = () => navEvents.next(new NavigationEnd(1, '/a', '/a'));
  return { svc: TestBed.inject(AppUpdates), sw, snack, reload, events, replaceByOther, navigate, dismissed, refs };
}

const ready = { type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } } as VersionEvent;
const flush = () => new Promise<void>((r) => setTimeout(r));
const becomeVisible = () => {
  jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
};

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

  it('checks for an update on startup and when the page becomes visible again', async () => {
    const { svc, sw } = setup();
    svc.start();
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    await flush();
    const vis = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not queue another check while one is in flight', async () => {
    const { svc, sw } = setup();
    let finish!: (v: boolean) => void;
    sw.checkForUpdate.mockImplementation(() => new Promise<boolean>((r) => (finish = r)));
    svc.start();
    becomeVisible();
    becomeVisible();
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    finish(false);
    await flush();
    becomeVisible();
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
    const cfg = snack.openFromComponent.mock.calls[0][1] as { duration?: number; panelClass?: string };
    expect(cfg.duration).toBeUndefined();
    expect(cfg.panelClass).toBe('update-prompt');
  });

  it('re-shows the prompt on the next navigation after another snackbar dismissed it', () => {
    const { svc, snack, events, replaceByOther, navigate } = setup();
    svc.start();
    events.next(ready);
    replaceByOther();
    // The other snackbar (e.g. Deleted/Undo) is still on screen: do not clobber it.
    navigate();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(1);
    // It went away; the next trigger brings the prompt back.
    snack._openedSnackBarRef = undefined;
    navigate();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(2);
    navigate();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(2);
  });

  it('re-shows the prompt when the page becomes visible after being dismissed by another snackbar', () => {
    const { svc, snack, events, replaceByOther } = setup();
    svc.start();
    events.next(ready);
    replaceByOther();
    snack._openedSnackBarRef = undefined;
    becomeVisible();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(2);
  });

  it('does not open the prompt over an Undo snackbar that is already showing', () => {
    const { svc, snack, events, navigate } = setup();
    snack._openedSnackBarRef = { undo: true };
    svc.start();
    events.next(ready);
    expect(snack.openFromComponent).not.toHaveBeenCalled();
    snack._openedSnackBarRef = undefined;
    navigate();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(1);
  });

  it('Dismiss stops the prompt until the next VERSION_READY', () => {
    const { svc, snack, events, navigate, dismissed, refs } = setup();
    svc.start();
    events.next(ready);
    svc.dismiss();
    expect(refs[0].dismiss).toHaveBeenCalled();
    dismissed[0].next({ dismissedByAction: false });
    snack._openedSnackBarRef = undefined;
    navigate();
    becomeVisible();
    expect(snack.openFromComponent).toHaveBeenCalledTimes(1);
    events.next(ready);
    expect(snack.openFromComponent).toHaveBeenCalledTimes(2);
  });

  it('Reload activates the update, then reloads the page, in that order', async () => {
    const { svc, sw, reload, events } = setup();
    svc.start();
    events.next(ready);
    const order: string[] = [];
    sw.activateUpdate.mockImplementation(async () => {
      await flush();
      order.push('activate');
      return true;
    });
    reload.mockImplementation(() => order.push('reload'));
    await svc.reload();
    expect(order).toEqual(['activate', 'reload']);
  });

  it('still reloads when activateUpdate rejects', async () => {
    const { svc, sw, reload } = setup();
    sw.activateUpdate.mockRejectedValue(new Error('no'));
    await svc.reload();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('survives a failing checkForUpdate and settles the in-flight check', async () => {
    const { svc, sw } = setup();
    const failing = Promise.reject(new Error('offline'));
    const catchSpy = jest.spyOn(failing, 'catch');
    sw.checkForUpdate.mockReturnValueOnce(failing);
    expect(() => svc.start()).not.toThrow();
    expect(catchSpy).toHaveBeenCalled();
    await flush();
    becomeVisible();
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
