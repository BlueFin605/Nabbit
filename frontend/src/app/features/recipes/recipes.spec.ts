import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { RecipeQuery, RecipeSummary } from '../../core/api/api.types';
import { imageUrl } from '../../core/api/image-url';
import { RecipeDeleter, type DeleteHooks } from './recipe-deleter';
import { Recipes, SEARCH_DEBOUNCE_MS } from './recipes';

const mk = (id: string, title: string, tags: string[], imageKey?: string): RecipeSummary => ({
  id,
  title,
  tags,
  imageKey,
  servings: 2,
  updatedAt: '2026-01-01T00:00:00Z',
});
const ALL = [mk('1', 'Pancakes', ['breakfast', 'quick'], 'o/img1'), mk('2', 'Stew', ['dinner'])];

describe('Recipes', () => {
  let listRecipes: jest.Mock;
  let fixture: ComponentFixture<Recipes>;

  async function setup(impl: (q: RecipeQuery) => Observable<RecipeSummary[]> = () => of(ALL)) {
    listRecipes = jest.fn(impl);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: ApiClient, useValue: { listRecipes } }],
    });
    fixture = TestBed.createComponent(Recipes);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = () => fixture.nativeElement as HTMLElement;

  afterEach(() => jest.useRealTimers());

  it('renders cards with photo, placeholder, title and tags', async () => {
    await setup();
    const cards = el().querySelectorAll('a.card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Pancakes');
    expect(cards[0].querySelector('img')?.getAttribute('src')).toBe(imageUrl('o/img1'));
    expect(cards[0].querySelectorAll('.card-tags li')).toHaveLength(2);
    expect(cards[1].querySelector('img')).toBeNull();
    expect(cards[1].querySelector('.placeholder')).not.toBeNull();
    expect(cards[0].getAttribute('href')).toBe('/recipes/1');
  });

  it('shows skeletons while loading', async () => {
    await setup(() => NEVER);
    expect(el().querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('debounces search and sends q', async () => {
    await setup();
    jest.useFakeTimers();
    const input = el().querySelector('input') as HTMLInputElement;
    input.value = 'pan';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(listRecipes).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(listRecipes).toHaveBeenLastCalledWith({ q: 'pan', tag: undefined });
  });

  it('filters by tag chip and keeps the chips available', async () => {
    await setup((query) => of(query.tag ? ALL.filter((r) => r.tags.includes(query.tag as string)) : ALL));
    const chips = () => Array.from(el().querySelectorAll<HTMLElement>('mat-chip-option'));
    expect(chips().map((c) => c.textContent?.trim())).toEqual(['breakfast', 'dinner', 'quick']);
    chips()[1].click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(listRecipes).toHaveBeenLastCalledWith({ q: undefined, tag: 'dinner' });
    expect(el().querySelectorAll('a.card')).toHaveLength(1);
    expect(chips()).toHaveLength(3);
  });

  it('shows the empty state', async () => {
    await setup(() => of([]));
    expect(el().textContent).toContain('No recipes yet — tap + to add one');
  });

  it('shows an error with retry', async () => {
    let fail = true;
    await setup(() => (fail ? throwError(() => new Error('x')) : of(ALL)));
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    (el().querySelector('[role="alert"] button') as HTMLElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el().querySelectorAll('a.card')).toHaveLength(2);
  });

  describe('delete', () => {
    let confirmAndDelete: jest.Mock<void, [string, DeleteHooks]>;
    const hooksOf = () => confirmAndDelete.mock.calls[0][1];
    const deleteBtns = () => Array.from(el().querySelectorAll<HTMLElement>('button.card-delete'));

    async function setupDelete() {
      confirmAndDelete = jest.fn<void, [string, DeleteHooks]>();
      TestBed.overrideProvider(RecipeDeleter, { useValue: { confirmAndDelete } });
      await setup();
    }

    it('renders a labelled delete button per card', async () => {
      await setupDelete();
      expect(deleteBtns().map((b) => b.getAttribute('aria-label'))).toEqual([
        'Delete recipe Pancakes',
        'Delete recipe Stew',
      ]);
    });

    it('does not navigate when delete is clicked', async () => {
      await setupDelete();
      const router = TestBed.inject(Router);
      const nav = jest.spyOn(router, 'navigate').mockResolvedValue(true);
      const navUrl = jest.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
      deleteBtns()[0].click();
      expect(confirmAndDelete).toHaveBeenCalledWith('1', expect.any(Object));
      expect(nav).not.toHaveBeenCalled();
      expect(navUrl).not.toHaveBeenCalled();
    });

    it('removes the card once deleted', async () => {
      await setupDelete();
      deleteBtns()[0].click();
      hooksOf().onDeleted?.();
      fixture.detectChanges();
      expect(el().querySelectorAll('a.card')).toHaveLength(1);
      expect(el().textContent).not.toContain('Pancakes');
      expect(listRecipes).toHaveBeenCalledTimes(1);
    });

    it('re-fetches the list on undo', async () => {
      await setupDelete();
      deleteBtns()[0].click();
      const hooks = hooksOf();
      hooks.onDeleted?.();
      fixture.detectChanges();
      hooks.onRestored?.('1');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(listRecipes).toHaveBeenCalledTimes(2);
      expect(el().querySelectorAll('a.card')).toHaveLength(2);
    });
  });

  it('FAB navigates to /import', async () => {
    await setup();
    const nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    (el().querySelector('button.fab') as HTMLElement).click();
    expect(nav).toHaveBeenCalledWith(['/import']);
  });
});
