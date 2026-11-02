import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of, throwError } from 'rxjs';
import { scaleRecipeIngredients, type Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import { AddToListDialog, LAST_LIST_KEY, listItemName, type AddToListData } from './add-to-list-dialog';

const flour: Ingredient = {
  id: 'i1',
  original: '2 cups flour',
  quantity: 2,
  unit: 'cup',
  name: 'flour',
  scalable: true,
  metric: { quantity: 480, unit: 'ml' },
};
const salt: Ingredient = { id: 'i2', original: 'salt to taste', quantity: null, unit: '', name: 'salt', scalable: false };
const eggs: Ingredient = { id: 'i3', original: '2 eggs', quantity: 2, unit: '', name: 'eggs', scalable: true };

const summaries = [
  { id: 'l1', name: 'Shopping', itemCount: 0, version: 1, updatedAt: 'x' },
  { id: 'l2', name: 'Party', itemCount: 0, version: 1, updatedAt: 'x' },
];

describe('listItemName', () => {
  it('suffixes the quantity text and omits it when empty', () => {
    expect(listItemName(flour, 'metric')).toBe('flour (480 ml)');
    expect(listItemName(flour, 'original')).toBe('flour (2 cups)');
    expect(listItemName(salt, 'metric')).toBe('salt');
  });

  it('uses scaled amounts', () => {
    const [six] = scaleRecipeIngredients([flour], 4, 6);
    expect(listItemName(six, 'metric')).toBe('flour (720 ml)');
  });
});

describe('AddToListDialog', () => {
  let fixture: ComponentFixture<AddToListDialog>;
  let addItems: jest.Mock;
  let close: jest.Mock;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const boxes = () => Array.from(el().querySelectorAll<HTMLInputElement>('.row input[type="checkbox"]'));

  async function setup(addImpl: () => unknown = () => of({ id: 'l1', name: 'Shopping', items: [], version: 2 })) {
    addItems = jest.fn(addImpl);
    close = jest.fn();
    const data: AddToListData = { ingredients: scaleRecipeIngredients([flour, salt, eggs], 4, 6), mode: 'metric' };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClient, useValue: { listLists: () => of(summaries), createList: jest.fn(), addItems } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    fixture = TestBed.createComponent(AddToListDialog);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => localStorage.clear());

  it('ticks every row except to-taste', async () => {
    await setup();
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
  });

  it('posts scaled names for ticked rows only, and unticking removes a row', async () => {
    await setup();
    boxes()[2].click();
    await settle();
    el().querySelector<HTMLElement>('.confirm')?.click();
    await settle();
    expect(addItems).toHaveBeenCalledWith('l1', [{ name: 'flour (720 ml)' }]);
    expect(close).toHaveBeenCalledWith({ listId: 'l1', listName: 'Shopping', count: 1 });
  });

  it('includes a re-ticked to-taste row by bare name', async () => {
    await setup();
    boxes()[1].click();
    await settle();
    el().querySelector<HTMLElement>('.confirm')?.click();
    await settle();
    expect(addItems).toHaveBeenCalledWith('l1', [{ name: 'flour (720 ml)' }, { name: 'salt' }, { name: 'eggs (3)' }]);
  });

  it('defaults to the remembered list and remembers the one used', async () => {
    localStorage.setItem(LAST_LIST_KEY, 'l2');
    await setup();
    el().querySelector<HTMLElement>('.confirm')?.click();
    await settle();
    expect(addItems).toHaveBeenCalledWith('l2', expect.any(Array));
    expect(localStorage.getItem(LAST_LIST_KEY)).toBe('l2');
  });

  it('stays open and shows the error on failure', async () => {
    await setup(() => throwError(() => new Error('boom')));
    el().querySelector<HTMLElement>('.confirm')?.click();
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain("Couldn't add");
    expect(el().querySelector<HTMLButtonElement>('.confirm')?.disabled).toBe(false);
  });
});
