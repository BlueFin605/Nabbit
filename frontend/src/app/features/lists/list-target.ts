import { Injectable, inject } from '@angular/core';
import { type Observable, finalize, map, of, shareReplay, switchMap } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';

export const LAST_LIST_KEY = 'nabbit.lastListId';
export const DEFAULT_LIST_NAME = 'Shopping';

export interface ListChoice {
  id: string;
  name: string;
}

/** Decides which list new items go to: the last one used, else "Shopping", else the first. */
@Injectable({ providedIn: 'root' })
export class ListTarget {
  private readonly api = inject(ApiClient);

  private inflight: Observable<ListChoice> | null = null;

  /** Concurrent callers share one in-flight lookup so an empty account gets a single Shopping list. */
  resolve(): Observable<ListChoice> {
    if (!this.inflight) {
      this.inflight = this.lookup().pipe(
        finalize(() => (this.inflight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inflight;
  }

  private lookup(): Observable<ListChoice> {
    return this.api.listLists().pipe(
      switchMap((rows) =>
        rows.length > 0
          ? of(rows)
          : this.api.createList(DEFAULT_LIST_NAME).pipe(map((l) => [{ id: l.id, name: l.name }])),
      ),
      map((rows) => {
        const last = this.readLast();
        const pick = rows.find((r) => r.id === last) ?? rows.find((r) => r.name === DEFAULT_LIST_NAME) ?? rows[0];
        return { id: pick.id, name: pick.name };
      }),
    );
  }

  remember(listId: string): void {
    try {
      localStorage.setItem(LAST_LIST_KEY, listId);
    } catch {
      /* storage unavailable: remembered for this visit only */
    }
  }

  readLast(): string | undefined {
    try {
      return localStorage.getItem(LAST_LIST_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
