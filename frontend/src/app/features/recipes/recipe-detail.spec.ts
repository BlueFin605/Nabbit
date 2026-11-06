import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { Subject, of, throwError } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe } from '../../core/api/api.types';
import { ListTarget } from '../lists/list-target';
import { RecipeDetail, UNIT_MODE_KEY } from './recipe-detail';

const flour: Ingredient = {
  id: 'i1',
  original: '2 cups flour',
  quantity: 2,
  unit: 'cup',
  name: 'flour',
  note: 'sifted',
  scalable: true,
  metric: { quantity: 480, unit: 'ml' },
};
const salt: Ingredient = { id: 'i2', original: 'salt to taste', quantity: null, unit: '', name: 'salt', scalable: false };
const recipe = (): Recipe => ({
  id: 'r1',
  title: 'Pancakes',
  sourceUrl: 'https://example.com/p',
  imageKey: 'o/img1',
  servings: 4,
  ingredients: [flour, salt],
  steps: ['Heat oven to 350°F', 'Mix'],
  tags: [],
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('RecipeDetail', () => {
  let getRecipe: jest.Mock;
  let updateRecipe: jest.Mock;
  let deleteRecipe: jest.Mock;
  let addItems: jest.Mock;
  let deleteItem: jest.Mock;
  let getList: jest.Mock;
  let resolve: jest.Mock;
  let remember: jest.Mock;
  let fixture: ComponentFixture<RecipeDetail>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const click = async (selector: string) => {
    el().querySelector<HTMLElement>(selector)?.click();
    await settle();
  };
  const ingredients = () =>
    Array.from(el().querySelectorAll('.ingredients li')).map((l) => l.textContent?.replace(/\s+/g, ' ').trim() ?? '');

  async function setup(impl: () => unknown = () => of(recipe())) {
    getRecipe = jest.fn(impl);
    deleteRecipe = jest.fn(() => of(undefined));
    updateRecipe = jest.fn((_id: string, input: { servings: number }) => of({ ...recipe(), servings: input.servings, version: 2 }));
    addItems = jest.fn((_l: string, items: { name: string }[]) =>
      of({ id: 'L1', name: 'Shopping', items: [{ id: 'old', name: 'milk' }, { id: 'new1', name: items[0].name }], version: 2, updatedAt: '' }),
    );
    deleteItem = jest.fn(() => of(undefined));
    getList = jest.fn(() => of({ id: 'L1', name: 'Shopping', items: [{ id: 'old', name: 'milk' }], version: 1, updatedAt: '' }));
    resolve = jest.fn(() => of({ id: 'L1', name: 'Shopping' }));
    remember = jest.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ApiClient, useValue: { getRecipe, updateRecipe, deleteRecipe, restoreRecipe: jest.fn(), addItems, deleteItem, getList } },
        { provide: ListTarget, useValue: { resolve, remember } },
      ],
    });
    fixture = TestBed.createComponent(RecipeDetail);
    fixture.componentRef.setInput('id', 'r1');
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['wakeLock'];
  });

  it('shows title, photo, steps, source and edit link', async () => {
    await setup();
    expect(el().querySelector('h1')?.textContent).toBe('Pancakes');
    expect(el().querySelector('img.photo')).not.toBeNull();
    expect(el().querySelectorAll('.steps li')).toHaveLength(2);
    expect(el().querySelector('.source a')?.getAttribute('href')).toBe('https://example.com/p');
    expect(el().querySelector('a[href="/recipes/r1/edit"]')).not.toBeNull();
  });

  it('renders metric by default with the note separately and marks to-taste', async () => {
    await setup();
    expect(ingredients()[0]).toContain('480 ml flour');
    expect(ingredients()[0]).toContain('sifted');
    expect(ingredients()[1]).toContain('salt to taste');
    expect(el().querySelectorAll('.ingredients li.fixed')).toHaveLength(1);
    expect(el().textContent).toContain('180°C');
  });

  it('scales 4 -> 6 servings without changing the stored recipe or making a request', async () => {
    await setup();
    const stored = JSON.stringify(recipe());
    await click('mat-button-toggle[value="original"] button');
    await click('[aria-label="More servings"]');
    await click('[aria-label="More servings"]');
    expect(el().querySelector('output')?.textContent).toBe('6');
    expect(ingredients()[0]).toContain('3 cups flour');
    expect(ingredients()[1]).toContain('salt to taste');
    const c = fixture.componentInstance as unknown as { recipe(): Recipe };
    expect(JSON.stringify(c.recipe())).toBe(stored);
    expect(getRecipe).toHaveBeenCalledTimes(1);

    await click('mat-button-toggle[value="metric"] button');
    expect(ingredients()[0]).toContain('720 ml flour');
  });

  it('clamps servings at 1', async () => {
    await setup();
    for (let n = 0; n < 5; n++) await click('[aria-label="Fewer servings"]');
    expect(el().querySelector('output')?.textContent).toBe('1');
    expect(el().querySelector<HTMLButtonElement>('[aria-label="Fewer servings"]')?.disabled).toBe(true);
  });

  it('toggles units and persists the choice', async () => {
    await setup();
    await click('mat-button-toggle[value="original"] button');
    expect(ingredients()[0]).toContain('2 cups flour');
    expect(el().textContent).toContain('350°F');
    expect(localStorage.getItem(UNIT_MODE_KEY)).toBe('original');
  });

  it('starts in original mode when remembered', async () => {
    localStorage.setItem(UNIT_MODE_KEY, 'original');
    await setup();
    expect(ingredients()[0]).toContain('2 cups flour');
  });

  it('hides the wake lock toggle when unsupported', async () => {
    await setup();
    expect(el().querySelector('.wake')).toBeNull();
  });

  it('shows the wake lock toggle and releases on destroy when supported', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const request = jest.fn().mockResolvedValue({ release });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    await setup();
    expect(el().querySelector('.wake')).not.toBeNull();
    await click('.wake button');
    expect(request).toHaveBeenCalledWith('screen');
    fixture.destroy();
    await Promise.resolve();
    expect(release).toHaveBeenCalled();
  });

  it('shows "Recipe not found" on 404', async () => {
    await setup(() => throwError(() => new HttpErrorResponse({ status: 404 })));
    expect(el().textContent).toContain('Recipe not found');
    expect(el().querySelector('a[href="/recipes"]')).not.toBeNull();
  });

  it('shows "Recipe not found" for a soft-deleted recipe', async () => {
    await setup(() => of({ ...recipe(), deletedAt: '2026-02-01T00:00:00Z' }));
    expect(el().textContent).toContain('Recipe not found');
  });

  describe('save as new size', () => {
    const stubDialog = (ok: boolean) =>
      jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(ok) } as never);

    it('only offers the button when the stepper differs from stored', async () => {
      await setup();
      expect(el().querySelector('.save-size')).toBeNull();
      await click('button[aria-label="More servings"]');
      expect(el().querySelector('.save-size')?.textContent).toContain('Save as new size (5 servings)');
      await click('button[aria-label="Fewer servings"]');
      expect(el().querySelector('.save-size')).toBeNull();
    });

    it('confirm dialog lists before and after; PUT carries scaled quantities, new servings and stored version', async () => {
      await setup();
      await click('button[aria-label="More servings"]');
      await click('button[aria-label="More servings"]');
      await click('button[aria-label="More servings"]');
      await click('button[aria-label="More servings"]'); // 4 -> 8: doubles
      const open = stubDialog(true);
      await click('.save-size');
      const data = open.mock.calls[0][1]?.data as { lines: string[]; confirmLabel: string };
      expect(data.lines).toEqual(['480 ml flour → 960 ml flour', 'salt to taste → salt to taste']);
      expect(updateRecipe).toHaveBeenCalledTimes(1);
      const [id, body, version] = updateRecipe.mock.calls[0] as [string, { servings: number; ingredients: Ingredient[]; title: string }, number];
      expect(id).toBe('r1');
      expect(version).toBe(1);
      expect(body.servings).toBe(8);
      expect(body.title).toBe('Pancakes');
      expect(body.ingredients[0]).toMatchObject({ id: 'i1', quantity: 4, metric: { quantity: 960, unit: 'ml' } });
      expect(body.ingredients[0].original).toBeUndefined();
      expect(body.ingredients[1]).toEqual(salt);
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('id');
      // the view now treats 8 as the stored size
      expect(el().querySelector('.save-size')).toBeNull();
    });

    it('does not save when the dialog is cancelled', async () => {
      await setup();
      await click('button[aria-label="More servings"]');
      stubDialog(false);
      await click('.save-size');
      expect(updateRecipe).not.toHaveBeenCalled();
    });

    it('409 shows the reload prompt and Reload refetches', async () => {
      await setup();
      updateRecipe.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 409, error: { error: 'version_conflict' } })));
      await click('button[aria-label="More servings"]');
      stubDialog(true);
      await click('.save-size');
      expect(el().querySelector('.conflict')?.textContent).toContain('This recipe changed on another device — reload');
      getRecipe.mockReturnValue(of({ ...recipe(), servings: 6, version: 3 }));
      await click('.reload');
      expect(getRecipe).toHaveBeenCalledTimes(2);
      expect(el().querySelector('.conflict')).toBeNull();
      expect(el().querySelector('output')?.textContent).toBe('6');
    });
  });

  it('has a Delete button that confirms, deletes and goes back to the list', async () => {
    await setup();
    const nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    jest.spyOn(TestBed.inject(MatSnackBar), 'open').mockReturnValue({ onAction: () => new Subject<void>() } as never);
    const dialog = jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(true) } as never);
    expect(el().querySelector('.actions .delete')).not.toBeNull();
    await click('.actions .delete');
    expect(dialog).toHaveBeenCalled();
    expect(deleteRecipe).toHaveBeenCalledWith('r1');
    expect(nav).toHaveBeenCalledWith(['/recipes']);
  });

  it('opens the add-to-list dialog with the scaled ingredients and unit mode', async () => {
    await setup();
    await click('[aria-label="More servings"]');
    await click('[aria-label="More servings"]');
    const open = jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(undefined) } as never);
    await click('.actions button');
    const data = open.mock.calls[0][1]?.data as { ingredients: Ingredient[]; mode: string };
    expect(data.mode).toBe('metric');
    expect(data.ingredients[0].quantity).toBe(3);
  });

  describe('add one ingredient to the list', () => {
    const action = new Subject<void>();
    let snackOpen: jest.SpyInstance;
    const stubSnack = () => {
      snackOpen = jest.spyOn(TestBed.inject(MatSnackBar), 'open').mockReturnValue({ onAction: () => action } as never);
    };
    const addBtn = (n: number) => el().querySelectorAll<HTMLButtonElement>('.ingredients li .add-one')[n];

    it('has a labelled button on every ingredient row, including to-taste', async () => {
      await setup();
      expect(addBtn(0).getAttribute('aria-label')).toBe('Add flour to shopping list');
      expect(addBtn(1).getAttribute('aria-label')).toBe('Add salt to shopping list');
    });

    it('posts exactly one item with the metric text, remembers the list, shows a check and snackbar', async () => {
      await setup();
      stubSnack();
      await click('.ingredients li:nth-child(1) .add-one');
      expect(addItems).toHaveBeenCalledTimes(1);
      expect(addItems).toHaveBeenCalledWith('L1', [{ name: 'flour (480 ml)' }]);
      expect(remember).toHaveBeenCalledWith('L1');
      expect(snackOpen).toHaveBeenCalledWith('Added to Shopping', 'Undo', { duration: 5000 });
      expect(addBtn(0).textContent).toContain('✓');
      expect(addBtn(1).textContent).not.toContain('✓');
    });

    it('posts the original-mode text', async () => {
      await setup();
      stubSnack();
      await click('mat-button-toggle[value="original"] button');
      await click('.ingredients li:nth-child(1) .add-one');
      expect(addItems).toHaveBeenCalledWith('L1', [{ name: 'flour (2 cups)' }]);
    });

    it('adds a to-taste ingredient by name only', async () => {
      await setup();
      stubSnack();
      await click('.ingredients li:nth-child(2) .add-one');
      expect(addItems).toHaveBeenCalledWith('L1', [{ name: 'salt' }]);
    });

    it('Undo deletes the created item and clears the check', async () => {
      await setup();
      stubSnack();
      await click('.ingredients li:nth-child(1) .add-one');
      action.next();
      await settle();
      expect(deleteItem).toHaveBeenCalledWith('L1', 'new1');
      expect(addBtn(0).textContent).not.toContain('✓');
    });

    it('merge onto an existing item: says Already on, offers no Undo, deletes nothing', async () => {
      await setup();
      stubSnack();
      const same = { id: 'L1', name: 'Shopping', items: [{ id: 'old', name: 'flour (480 ml)' }], version: 1, updatedAt: '' };
      getList.mockReturnValue(of(same));
      addItems.mockReturnValue(of(same));
      await click('.ingredients li:nth-child(1) .add-one');
      expect(snackOpen).toHaveBeenCalledWith('Already on Shopping', 'OK', { duration: 5000 });
      expect(snackOpen).not.toHaveBeenCalledWith(expect.anything(), 'Undo', expect.anything());
      action.next();
      await settle();
      expect(deleteItem).not.toHaveBeenCalled();
    });

    it('check resets on servings change and on unit mode change', async () => {
      await setup();
      stubSnack();
      await click('.ingredients li:nth-child(1) .add-one');
      expect(addBtn(0).textContent).toContain('✓');
      await click('[aria-label="More servings"]');
      expect(addBtn(0).textContent).not.toContain('✓');
      await click('.ingredients li:nth-child(1) .add-one');
      expect(addBtn(0).textContent).toContain('✓');
      await click('mat-button-toggle[value="original"] button');
      expect(addBtn(0).textContent).not.toContain('✓');
    });

    it('ignores taps while a request is in flight', async () => {
      await setup();
      stubSnack();
      addItems.mockReturnValue(new Subject<unknown>());
      await click('.ingredients li:nth-child(1) .add-one');
      await click('.ingredients li:nth-child(1) .add-one');
      expect(addItems).toHaveBeenCalledTimes(1);
    });

    it('shows an error snackbar and no check when the add fails', async () => {
      await setup();
      stubSnack();
      addItems.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
      await click('.ingredients li:nth-child(1) .add-one');
      expect(snackOpen).toHaveBeenCalledWith("Couldn't add that ingredient", 'OK', { duration: 5000 });
      expect(addBtn(0).textContent).not.toContain('✓');
      expect(remember).not.toHaveBeenCalled();
    });
  });
});
