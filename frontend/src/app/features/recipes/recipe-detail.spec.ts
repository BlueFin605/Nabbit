import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const recipe = (steps: Recipe['steps'] = ['Heat oven to 350°F', 'Mix']): Recipe => ({
  id: 'r1',
  title: 'Pancakes',
  sourceUrl: 'https://example.com/p',
  imageKey: 'o/img1',
  servings: 4,
  ingredients: [flour, salt],
  steps,
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

  describe('step groups', () => {
    it('flat steps render one top-level list with no headings or nested lists', async () => {
      await setup();
      expect(el().querySelectorAll('ol.steps')).toHaveLength(1);
      expect(el().querySelectorAll('.steps h3, .steps ol')).toHaveLength(0);
    });

    it('a group with a heading shows an h3 above its own ol', async () => {
      await setup(() => of(recipe(['Prep', { heading: 'Sauce', steps: ['Chop', 'Simmer'] }])));
      const h = el().querySelector('.steps h3');
      expect(h?.textContent?.trim()).toBe('Sauce');
      const inner = h?.parentElement?.querySelector('ol');
      expect(inner?.querySelectorAll(':scope > li')).toHaveLength(2);
      expect((h as Element).compareDocumentPosition(inner as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('nests two deep with headings visible and native nested lists for numbering', async () => {
      await setup(() => of(recipe([{ heading: 'Outer', steps: ['A', { heading: 'Inner', steps: ['B', 'C'] }] }, 'Last'])));
      const top = el().querySelector('ol.steps') as Element;
      expect(top.querySelectorAll(':scope > li')).toHaveLength(2);
      const headings = Array.from(el().querySelectorAll('.steps h3')).map((h) => h.textContent?.trim());
      expect(headings).toEqual(['Outer', 'Inner']);
      expect(el().querySelectorAll('.steps ol ol')).toHaveLength(1);
    });

    it('a headingless group is an indented ol without an h3', async () => {
      await setup(() => of(recipe(['A', { steps: ['B', 'C'] }])));
      expect(el().querySelectorAll('.steps h3')).toHaveLength(0);
      expect(el().querySelectorAll('.steps ol')).toHaveLength(1);
      expect(el().querySelectorAll('.steps ol > li')).toHaveLength(2);
    });

    it('group li is not a list-item, so it does not consume a number in the parent ol', async () => {
      await setup(() => of(recipe(['Prep', { heading: 'Sauce', steps: ['Chop'] }, 'Last'])));
      const group = el().querySelector('.steps li.group') as HTMLElement;
      const computed = getComputedStyle(group).display;
      if (computed === 'block') {
        // jsdom applied the component stylesheet
        expect(computed).not.toBe('list-item');
      } else {
        // jest does not compile the component .scss, so guard the rule in source
        const scss = readFileSync(join(__dirname, 'recipe-detail.scss'), 'utf8');
        const rule = /\.steps li\.group\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
        expect(rule).toMatch(/display:\s*block/);
      }
      // the numbered siblings are the only list-item children of the top-level ol
      expect(el().querySelectorAll('ol.steps > li:not(.group)')).toHaveLength(2);
    });

    it('converts temperatures inside nested steps in metric mode only', async () => {
      await setup(() => of(recipe([{ heading: 'Bake', steps: [{ steps: ['Heat oven to 350°F'] }] }])));
      expect(el().querySelector('.steps')?.textContent).toContain('180°C');
      await click('mat-button-toggle[value="original"] button');
      expect(el().querySelector('.steps')?.textContent).toContain('350°F');
    });
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

    it('save as new size sends the nested step tree unchanged', async () => {
      const steps: Recipe['steps'] = ['Prep', { heading: 'Sauce', steps: ['Chop', { steps: ['Simmer 350°F'] }] }, 'Last'];
      await setup(() => of(recipe(steps)));
      await click('button[aria-label="More servings"]');
      stubDialog(true);
      await click('.save-size');
      const [, body] = updateRecipe.mock.calls[0] as [string, { steps: unknown }];
      expect(body.steps).toEqual(steps);
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

  describe('scale by ingredient', () => {
    const milk: Ingredient = { id: 'milk', original: '4 l milk', quantity: 4, unit: 'l', name: 'milk', scalable: true, metric: { quantity: 4000, unit: 'ml' } };
    const rennet: Ingredient = { id: 'ren', original: '1 tsp rennet', quantity: 1, unit: 'tsp', name: 'rennet', scalable: true };
    const cheese = (scaleBy?: string): Recipe => ({ ...recipe(), ingredients: [milk, rennet, salt], ...(scaleBy ? { scaleBy } : {}) });
    const scaleSelect = () => el().querySelector<HTMLSelectElement>('select.scale-by');
    const amountBox = () => el().querySelector<HTMLInputElement>('input.anchor-amount');
    const unitSelect = () => el().querySelector<HTMLSelectElement>('select.anchor-unit');
    const reset = () => el().querySelector<HTMLButtonElement>('button.reset-scale');
    const factorText = () => el().querySelector('.factor')?.textContent ?? '';
    const choose = async (sel: HTMLSelectElement | null, value: string) => {
      (sel as HTMLSelectElement).value = value;
      sel?.dispatchEvent(new Event('change'));
      await settle();
    };
    const type = async (value: string) => {
      (amountBox() as HTMLInputElement).value = value;
      amountBox()?.dispatchEvent(new Event('input'));
      await settle();
    };

    it('lists Servings plus only scalable ingredients with a quantity, with a label', async () => {
      await setup(() => of(cheese()));
      const labels = Array.from(scaleSelect()?.options ?? []).map((o) => o.textContent?.trim());
      expect(labels).toEqual(['Servings', 'milk', 'rennet']);
      expect(el().querySelector('label[for="scale-by"]')?.textContent).toContain('Scale by');
    });

    it('opens in Servings mode (stepper, no Reset) when the recipe has no scaleBy', async () => {
      await setup(() => of(cheese()));
      expect(el().querySelector('.stepper')).not.toBeNull();
      expect(amountBox()).toBeNull();
      expect(reset()).toBeNull();
    });

    it('opens in ingredient mode on scaleBy, preset to the stored amount', async () => {
      await setup(() => of(cheese('milk')));
      expect(scaleSelect()?.value).toBe('milk');
      expect(el().querySelector('.stepper')).toBeNull();
      expect(amountBox()?.value).toBe('4');
      expect(unitSelect()?.value).toBe('l');
      expect(reset()).toBeNull();
    });

    it('ignores a scaleBy that is not an anchor', async () => {
      await setup(() => of(cheese('salt')));
      expect(el().querySelector('.stepper')).not.toBeNull();
    });

    it('milk 4 l -> 6 l gives x1.5, derived servings and scaled ingredients', async () => {
      await setup(() => of(cheese('milk')));
      await click('mat-button-toggle[value="original"] button');
      await type('6');
      expect(factorText()).toContain('×1.5');
      expect(el().querySelector('.derived-servings')?.textContent).toContain('6');
      expect(ingredients()[0]).toContain('6 l milk');
      expect(ingredients()[1]).toContain('1½ tsp rennet');
    });

    it('rounds derived servings to the nearest 0.5', async () => {
      await setup(() => of(cheese('milk')));
      await type('4.3');
      expect(el().querySelector('.derived-servings')?.textContent).toContain('4.5');
    });

    it('switching the unit ml -> l keeps the same target', async () => {
      await setup(() => of(cheese('milk')));
      await choose(unitSelect(), 'ml');
      await type('6000');
      expect(factorText()).toContain('×1.5');
      await choose(unitSelect(), 'l');
      await type('6');
      expect(factorText()).toContain('×1.5');
    });

    it('a comma decimal is accepted', async () => {
      await setup(() => of(cheese('milk')));
      await type('6,0');
      expect(factorText()).toContain('×1.5');
    });

    it('a wrong-family unit is not offered, but a bad programmatic unit shows an alert and keeps the factor', async () => {
      await setup(() => of(cheese('milk')));
      await type('6');
      const sel = unitSelect() as HTMLSelectElement;
      const opt = document.createElement('option');
      opt.value = 'g';
      sel.appendChild(opt);
      await choose(sel, 'g');
      const err = el().querySelector('.scale-error');
      expect(err?.getAttribute('role')).toBe('alert');
      expect(err?.textContent).toMatch(/can't convert/i);
      expect(factorText()).toContain('×1.5');
    });

    it('invalid amount shows an error and keeps the previous factor', async () => {
      await setup(() => of(cheese('milk')));
      await type('6');
      await type('abc');
      expect(el().querySelector('.scale-error')?.textContent).toMatch(/greater than zero/);
      expect(factorText()).toContain('×1.5');
      await type('0');
      expect(factorText()).toContain('×1.5');
      await type('8');
      expect(el().querySelector('.scale-error')).toBeNull();
      expect(factorText()).toContain('×2');
    });

    it('the unit select only offers the same family', async () => {
      await setup(() => of(cheese('milk')));
      const opts = Array.from(unitSelect()?.options ?? []).map((o) => o.value);
      expect(opts).toContain('ml');
      expect(opts).not.toContain('g');
    });

    it('Reset appears once scaled and restores the stored amount', async () => {
      await setup(() => of(cheese('milk')));
      await type('6');
      expect(reset()).not.toBeNull();
      await click('button.reset-scale');
      expect(reset()).toBeNull();
      expect(amountBox()?.value).toBe('4');
      expect(ingredients()[0]).toContain('4 l milk');
      expect(el().querySelector('.scale-error')).toBeNull();
    });

    it('Reset also works in Servings mode', async () => {
      await setup();
      await click('[aria-label="More servings"]');
      expect(reset()).not.toBeNull();
      await click('button.reset-scale');
      expect(el().querySelector('.stepper output')?.textContent).toBe('4');
      expect(reset()).toBeNull();
    });

    it('switching back to Servings shows the stepper at the stored servings', async () => {
      await setup(() => of(cheese('milk')));
      await type('6');
      await choose(scaleSelect(), 'servings');
      expect(el().querySelector('.stepper output')?.textContent).toBe('4');
      expect(reset()).toBeNull();
    });

    it('add-to-list receives the ingredient-scaled ingredients', async () => {
      await setup(() => of(cheese('milk')));
      await type('6');
      const open = jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(undefined) } as never);
      await click('.actions button');
      const data = open.mock.calls[0][1]?.data as { ingredients: Ingredient[] };
      expect(data.ingredients[0].quantity).toBe(6);
    });

    describe('derived servings bounds', () => {
      const save = () => el().querySelector<HTMLButtonElement>('button.save-size');
      const derived = () => el().querySelector('.derived-servings')?.textContent ?? '';

      it('a normal 4 l -> 6 l keeps Save enabled with 6 servings and no explanation', async () => {
        await setup(() => of(cheese('milk')));
        await type('6');
        expect(derived()).toContain('≈ 6 servings');
        expect(save()?.disabled).toBe(false);
        expect(save()?.textContent).toContain('6 servings');
        expect(el().querySelector('.size-bounds')).toBeNull();
      });

      it('a tiny target shows "< 1", disables Save with an aria-describedby explanation, and still scales', async () => {
        await setup(() => of(cheese('milk')));
        await type('0.1');
        expect(derived()).toContain('< 1');
        expect(derived()).not.toMatch(/≈ 0/);
        expect(save()?.disabled).toBe(true);
        expect(save()?.textContent).not.toContain('(0 servings)');
        const note = el().querySelector('.size-bounds');
        expect(note?.textContent).toContain('between 1 and 99');
        expect(save()?.getAttribute('aria-describedby')).toBe(note?.id);
        expect(ingredients()[0]).toContain('milk');
        expect(factorText()).toContain('×0.03');
      });

      it('a huge target shows "> 99" and disables Save', async () => {
        await setup(() => of(cheese('milk')));
        await type('1000');
        expect(derived()).toContain('> 99');
        expect(save()?.disabled).toBe(true);
        expect(el().querySelector('.size-bounds')).not.toBeNull();
      });

      it('add-to-list still works out of bounds', async () => {
        await setup(() => of(cheese('milk')));
        await type('0.1');
        const open = jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(undefined) } as never);
        await click('.actions button');
        const data = open.mock.calls[0][1]?.data as { ingredients: Ingredient[] };
        expect(data.ingredients[0].quantity).toBeCloseTo(0.1);
      });

      it('links the amount input to its error', async () => {
        await setup(() => of(cheese('milk')));
        await type('abc');
        const err = el().querySelector('.scale-error');
        expect(err?.id).toBeTruthy();
        expect(amountBox()?.getAttribute('aria-describedby')).toBe(err?.id);
      });

      it('Servings mode stepper is unchanged', async () => {
        await setup(() => of(cheese()));
        await click('button[aria-label="More servings"]');
        expect(el().querySelector('.stepper output')?.textContent).toContain('5');
        expect(el().querySelector('.size-bounds')).toBeNull();
        expect(save()?.disabled).toBe(false);
      });
    });

    it('announces the factor and servings politely', async () => {
      await setup(() => of(cheese('milk')));
      expect(el().querySelector('.scale-summary')?.getAttribute('aria-live')).toBe('polite');
    });
  });

  describe('first-size backup and restore original size', () => {
    const milk: Ingredient = { id: 'milk', original: '4 l milk', quantity: 4, unit: 'l', name: 'milk', scalable: true, metric: { quantity: 4000, unit: 'ml' } };
    const cheese = (extra: Partial<Recipe> = {}): Recipe => ({ ...recipe(), ingredients: [milk, salt], scaleBy: 'milk', ...extra });
    const backup = { servings: 3, ingredients: [{ ...milk, quantity: 3, original: '3 l milk', metric: { quantity: 3000, unit: 'ml' as const } }, salt] };
    const stubDialog = (ok: boolean) =>
      jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(ok) } as never);
    const typeAmount = async (v: string) => {
      const box = el().querySelector<HTMLInputElement>('input.anchor-amount') as HTMLInputElement;
      box.value = v;
      box.dispatchEvent(new Event('input'));
      await settle();
    };
    const restoreBtn = () => el().querySelector<HTMLButtonElement>('button.restore-original');
    const body = () => (updateRecipe.mock.calls[0] as [string, { servings: number; ingredients: Ingredient[]; scaleBy?: string; originalSize?: unknown }])[1];

    it('ingredient mode: milk 4 l -> 6 l with 4 servings saves 6 servings, keeps scaleBy', async () => {
      await setup(() => of(cheese()));
      await typeAmount('6');
      stubDialog(true);
      await click('.save-size');
      expect(body().servings).toBe(6);
      expect(body().scaleBy).toBe('milk');
      expect(body().ingredients[0]).toMatchObject({ id: 'milk', quantity: 6 });
    });

    it('first save writes originalSize with the pre-save stored values', async () => {
      const r = cheese();
      await setup(() => of(r));
      await typeAmount('6');
      stubDialog(true);
      await click('.save-size');
      expect(body().originalSize).toEqual({ servings: 4, ingredients: [milk, salt] });
    });

    it('the stepper path also writes the first backup', async () => {
      await setup(() => of(recipe()));
      await click('button[aria-label="More servings"]');
      stubDialog(true);
      await click('.save-size');
      expect(body().originalSize).toEqual({ servings: 4, ingredients: [flour, salt] });
    });

    it('a later save sends the existing originalSize unchanged', async () => {
      await setup(() => of(cheese({ servings: 6, originalSize: backup })));
      await typeAmount('8');
      stubDialog(true);
      await click('.save-size');
      expect(body().originalSize).toEqual(backup);
      expect(body().servings).toBe(12); // stored 6 servings at 4 l; 8 l is x2
    });

    it('hides Restore without a backup', async () => {
      await setup(() => of(cheese()));
      expect(restoreBtn()).toBeNull();
    });

    it('shows Restore with a backup', async () => {
      await setup(() => of(cheese({ originalSize: backup })));
      expect(restoreBtn()?.textContent).toContain('Restore original size');
    });

    it('opens the compare dialog with current and original, then PUTs the original without originalSize', async () => {
      const r = cheese({ servings: 6, originalSize: backup });
      await setup(() => of(r));
      const open = stubDialog(true);
      await click('button.restore-original');
      const data = open.mock.calls[0][1]?.data as { currentServings: number; originalServings: number; mode: string };
      expect(data.currentServings).toBe(6);
      expect(data.originalServings).toBe(3);
      expect(data.mode).toBe('metric');
      expect(updateRecipe).toHaveBeenCalledTimes(1);
      const [id, b, version] = updateRecipe.mock.calls[0] as [string, Record<string, unknown>, number];
      expect(id).toBe('r1');
      expect(version).toBe(1);
      expect(b['servings']).toBe(3);
      expect(b['ingredients']).toEqual(backup.ingredients);
      expect(b).not.toHaveProperty('originalSize');
      expect(b['scaleBy']).toBe('milk');
      expect(b['title']).toBe('Pancakes');
      expect(b).not.toHaveProperty('version');
    });

    it('cancelled restore sends nothing', async () => {
      await setup(() => of(cheese({ originalSize: backup })));
      stubDialog(false);
      await click('button.restore-original');
      expect(updateRecipe).not.toHaveBeenCalled();
    });

    it('a 409 on restore shows the reload offer', async () => {
      await setup(() => of(cheese({ originalSize: backup })));
      updateRecipe.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 409, error: { error: 'version_conflict' } })));
      stubDialog(true);
      await click('button.restore-original');
      expect(el().querySelector('.conflict')?.textContent).toContain('reload');
      getRecipe.mockReturnValue(of(cheese({ version: 3 })));
      await click('.reload');
      expect(getRecipe).toHaveBeenCalledTimes(2);
      expect(el().querySelector('.conflict')).toBeNull();
    });

    it('a non-conflict restore failure shows an error', async () => {
      await setup(() => of(cheese({ originalSize: backup })));
      updateRecipe.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
      stubDialog(true);
      await click('button.restore-original');
      expect(el().querySelector('.size-error')?.textContent).toContain("Couldn't restore");
    });

    it('after a successful restore the view shows the restored recipe and hides Restore', async () => {
      await setup(() => of(cheese({ servings: 6, originalSize: backup })));
      updateRecipe.mockImplementation((_i: string, input: { servings: number }) => of({ ...cheese(), servings: input.servings, version: 2 }));
      stubDialog(true);
      await click('button.restore-original');
      expect(restoreBtn()).toBeNull();
    });
  });
});
