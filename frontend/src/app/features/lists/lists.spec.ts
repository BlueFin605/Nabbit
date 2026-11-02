import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatAutocomplete } from '@angular/material/autocomplete';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { By } from '@angular/platform-browser';
import type { ListItem } from '@nabbit/recipe-core';
import { Subject, of, throwError } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { ShoppingList } from '../../core/api/api.types';
import { DOUBLE_TAP_MS, LONG_PRESS_MS, Lists, SUGGEST_DEBOUNCE_MS, UNDO_MS } from './lists';

const mkItem = (id: string, name: string, category: string, checked = false): ListItem => ({ id, name, category, checked });
const mkList = (items: ListItem[], version = 1): ShoppingList => ({
  id: 'L1',
  name: 'Shopping',
  items,
  version,
  updatedAt: '2026-01-01T00:00:00Z',
});
const START = [
  mkItem('a', 'Bread', 'Bakery'),
  mkItem('b', 'Milk', 'Dairy'),
  mkItem('c', 'Apples', 'Produce'),
  mkItem('d', 'Bananas', 'Produce', true),
];

describe('Lists', () => {
  let api: Record<string, jest.Mock>;
  let fixture: ComponentFixture<Lists>;
  let snackOpen: jest.Mock;
  let undo$: Subject<void>;
  let dialogResult: string | undefined;
  let dialogOpen: jest.Mock;

  async function setup(overrides: Partial<Record<string, jest.Mock>> = {}, items = START) {
    undo$ = new Subject<void>();
    snackOpen = jest.fn(() => ({ onAction: () => undo$ }));
    dialogOpen = jest.fn(() => ({ afterClosed: () => of(dialogResult) }));
    api = {
      listLists: jest.fn(() => of([{ id: 'L1', name: 'Shopping', itemCount: items.length, version: 1, updatedAt: '' }])),
      createList: jest.fn((name: string) => of({ ...mkList([]), name })),
      getList: jest.fn(() => of(mkList(items))),
      replaceList: jest.fn(),
      deleteList: jest.fn(() => of(undefined)),
      addItems: jest.fn(() => of(mkList(items, 2))),
      patchItem: jest.fn(() => of(mkList(items, 2))),
      deleteItem: jest.fn(() => of(mkList(items, 2))),
      suggestItems: jest.fn(() => of([{ name: 'Cheese', category: 'Dairy' }])),
      ...overrides,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: api },
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    });
    fixture = TestBed.createComponent(Lists);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = () => fixture.nativeElement as HTMLElement;
  const labels = () => Array.from(el().querySelectorAll('.item .label')).map((n) => n.textContent?.trim());
  const aisles = () => Array.from(el().querySelectorAll('h2.aisle')).map((h) => h.textContent);
  const row = (name: string) =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('.item')).find((b) => b.textContent?.includes(name)) as HTMLButtonElement;
  const tap = (name: string) => {
    row(name).click();
    fixture.detectChanges();
  };

  afterEach(() => jest.useRealTimers());

  it('creates the default Shopping list when none exist', async () => {
    await setup({ listLists: jest.fn(() => of([])) });
    expect(api['createList']).toHaveBeenCalledWith('Shopping');
  });

  it('groups by aisle in CATEGORIES order with checked items last in their group', async () => {
    await setup();
    expect(aisles()).toEqual(['Produce', 'Dairy', 'Bakery']);
    expect(labels()).toEqual(['Apples', 'Bananas', 'Milk', 'Bread']);
    expect(row('Bananas').classList).toContain('checked');
  });

  it('tap toggles checked optimistically and re-sorts', async () => {
    jest.useFakeTimers();
    await setup();
    tap('Bananas'); // uncheck: Bananas is unchecked, so it sorts above Apples
    expect(api['patchItem']).toHaveBeenCalledWith('L1', 'd', { checked: false });
    jest.advanceTimersByTime(DOUBLE_TAP_MS + 50);
    tap('Apples'); // check: Apples drops below the unchecked Bananas
    expect(api['patchItem']).toHaveBeenCalledWith('L1', 'c', { checked: true });
    expect(labels().slice(0, 2)).toEqual(['Bananas', 'Apples']);
    expect(row('Apples').classList).toContain('checked');
  });

  it('rolls back a failed toggle', async () => {
    jest.useFakeTimers();
    await setup({ patchItem: jest.fn(() => throwError(() => new Error('boom'))) });
    tap('Apples');
    expect(row('Apples').classList).not.toContain('checked');
    expect(labels().slice(0, 2)).toEqual(['Apples', 'Bananas']);
    expect(snackOpen).toHaveBeenCalledWith("Couldn't update that item", 'OK', expect.anything());
  });

  it('double-tap deletes with no net check change, and Undo re-adds by name/category', async () => {
    jest.useFakeTimers();
    await setup();
    tap('Apples');
    jest.advanceTimersByTime(DOUBLE_TAP_MS - 50);
    tap('Apples');
    expect(labels()).not.toContain('Apples');
    expect(api['patchItem']).toHaveBeenCalledTimes(1); // the second tap never re-toggles
    expect(api['deleteItem']).toHaveBeenCalledWith('L1', 'c');
    expect(snackOpen).toHaveBeenCalledWith('Deleted', 'Undo', { duration: UNDO_MS });
    undo$.next();
    expect(api['addItems']).toHaveBeenCalledWith('L1', [{ name: 'Apples', category: 'Produce' }]);
  });

  it('two taps further apart than 300 ms are two toggles', async () => {
    jest.useFakeTimers();
    await setup();
    tap('Apples');
    jest.advanceTimersByTime(DOUBLE_TAP_MS + 50);
    tap('Apples');
    expect(api['patchItem']).toHaveBeenCalledTimes(2);
    expect(api['deleteItem']).not.toHaveBeenCalled();
  });

  it('restores a row whose delete failed', async () => {
    jest.useFakeTimers();
    await setup({ deleteItem: jest.fn(() => throwError(() => new Error('boom'))) });
    tap('Milk');
    jest.advanceTimersByTime(100);
    tap('Milk');
    expect(labels()).toContain('Milk');
  });

  it('quick-add Enter uses the suggested category, else leaves it to the server', async () => {
    jest.useFakeTimers();
    await setup();
    const input = el().querySelector('input.quick-add') as HTMLInputElement;
    input.value = 'Cheese';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(api['suggestItems']).toHaveBeenCalledWith('Cheese');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(api['addItems']).toHaveBeenLastCalledWith('L1', [{ name: 'Cheese', category: 'Dairy' }]);

    input.value = 'Gizmo';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(api['addItems']).toHaveBeenLastCalledWith('L1', [{ name: 'Gizmo' }]);
    expect(input.value).toBe('');
  });

  it('choosing a suggestion adds it in that category', async () => {
    jest.useFakeTimers();
    await setup();
    const auto = fixture.debugElement.query(By.directive(MatAutocomplete));
    auto.triggerEventHandler('optionSelected', { option: { value: { name: 'Yoghurt', category: 'Dairy' } } });
    expect(api['addItems']).toHaveBeenCalledWith('L1', [{ name: 'Yoghurt', category: 'Dairy' }]);
  });

  it('long-press changes the category via PATCH and swallows the trailing click', async () => {
    jest.useFakeTimers();
    dialogResult = 'Dairy';
    await setup();
    row('Bread').dispatchEvent(new Event('pointerdown'));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    fixture.detectChanges();
    expect(api['patchItem']).toHaveBeenCalledWith('L1', 'a', { category: 'Dairy' });
    expect(aisles()).not.toContain('Bakery');
    row('Bread').click();
    expect(api['patchItem']).toHaveBeenCalledTimes(1);
  });

  it('reverts the category when the PATCH fails', async () => {
    jest.useFakeTimers();
    dialogResult = 'Dairy';
    await setup({ patchItem: jest.fn(() => throwError(() => new Error('boom'))) });
    row('Bread').dispatchEvent(new Event('pointerdown'));
    jest.advanceTimersByTime(LONG_PRESS_MS);
    fixture.detectChanges();
    expect(aisles()).toContain('Bakery');
  });
});
