import { HttpErrorResponse } from '@angular/common/http';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject, of, throwError, type Observable } from 'rxjs';
import type { Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe } from '../../core/api/api.types';
import { unsavedChangesGuard } from '../../core/guards/unsaved-changes-guard';
import { RecipeEdit } from './recipe-edit';

const flour: Ingredient = {
  id: 'i1',
  original: '1 cup flour',
  quantity: 1,
  unit: 'cup',
  name: 'flour',
  scalable: true,
  metric: { quantity: 240, unit: 'ml' },
};
const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'r1',
  title: 'Pancakes',
  servings: 4,
  ingredients: [flour],
  steps: ['Mix'],
  tags: [],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});
const conflictErr = () => throwError(() => new HttpErrorResponse({ status: 409, error: { error: 'version_conflict' } }));

describe('RecipeEdit', () => {
  let fixture: ComponentFixture<RecipeEdit>;
  let api: { getRecipe: jest.Mock; updateRecipe: jest.Mock; deleteRecipe: jest.Mock; restoreRecipe: jest.Mock };
  let nav: jest.SpyInstance;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(s: string) => el().querySelector<T>(s);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function setup(getRecipe: () => unknown = () => of(recipe())) {
    api = {
      getRecipe: jest.fn(getRecipe),
      updateRecipe: jest.fn(() => of(recipe({ version: 4 }))),
      deleteRecipe: jest.fn(() => of(undefined)),
      restoreRecipe: jest.fn(() => of(recipe())),
    };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiClient, useValue: api }] });
    nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(RecipeEdit);
    fixture.componentRef.setInput('id', 'r1');
    await settle();
  }
  async function edit(selector: string, value: string) {
    const input = q<HTMLInputElement>(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }
  function stubDialog(result: boolean) {
    const open = jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(result) } as never);
    return open;
  }

  it('loads the recipe into the editor', async () => {
    await setup();
    expect(q<HTMLInputElement>('input.title')?.value).toBe('Pancakes');
    expect(api.getRecipe).toHaveBeenCalledWith('r1');
  });

  it('shows not found for a missing or deleted recipe', async () => {
    await setup(() => throwError(() => ({ status: 404 })));
    expect(el().textContent).toContain('Recipe not found');
  });

  it('saves with the loaded version and goes back to the recipe', async () => {
    await setup();
    await edit('input.title', 'Better');
    q('.save')?.click();
    expect(api.updateRecipe).toHaveBeenCalledWith('r1', expect.objectContaining({ title: 'Better' }), 3);
    expect(nav).toHaveBeenCalledWith(['/recipes', 'r1']);
  });

  it('409 shows the reload prompt and keeps the local edits; Reload refetches', async () => {
    await setup();
    api.updateRecipe.mockImplementation(conflictErr);
    await edit('input.title', 'Mine');
    q('.save')?.click();
    await settle();
    expect(q('.conflict')?.textContent).toContain('This recipe changed on another device — reload');
    expect(q<HTMLInputElement>('input.title')?.value).toBe('Mine');
    expect(nav).not.toHaveBeenCalled();
    api.getRecipe.mockReturnValue(of(recipe({ title: 'Theirs', version: 5 })));
    q('.reload')?.click();
    await settle();
    expect(api.getRecipe).toHaveBeenCalledTimes(2);
    expect(q<HTMLInputElement>('input.title')?.value).toBe('Theirs');
    expect(q('.conflict')).toBeNull();
    q('.save')?.click();
    expect(api.updateRecipe).toHaveBeenLastCalledWith('r1', expect.anything(), 5);
  });

  it('other save errors show a message', async () => {
    await setup();
    api.updateRecipe.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));
    q('.save')?.click();
    await settle();
    expect(q('[role="alert"]')?.textContent).toContain("Couldn't save");
    expect(q('.conflict')).toBeNull();
  });

  it('delete asks for confirmation, soft-deletes, and the snackbar Undo restores', async () => {
    await setup();
    const action = new Subject<void>();
    const open = jest.spyOn(TestBed.inject(MatSnackBar), 'open').mockReturnValue({ onAction: () => action } as never);
    const dialog = stubDialog(true);
    q('.delete')?.click();
    await settle();
    expect(dialog).toHaveBeenCalled();
    expect(api.deleteRecipe).toHaveBeenCalledWith('r1');
    expect(open).toHaveBeenCalledWith('Recipe deleted', 'Undo', expect.anything());
    expect(nav).toHaveBeenCalledWith(['/recipes']);
    expect(api.restoreRecipe).not.toHaveBeenCalled();
    action.next();
    expect(api.restoreRecipe).toHaveBeenCalledWith('r1');
    expect(nav).toHaveBeenLastCalledWith(['/recipes', 'r1']);
  });

  it('cancelling the delete dialog does nothing', async () => {
    await setup();
    stubDialog(false);
    q('.delete')?.click();
    await settle();
    expect(api.deleteRecipe).not.toHaveBeenCalled();
  });

  describe('dirty guard', () => {
    const run = (c: RecipeEdit) => TestBed.runInInjectionContext(() => unsavedChangesGuard(c, null as never, null as never, null as never));

    it('lets a clean form leave', async () => {
      await setup();
      expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
      expect(run(fixture.componentInstance)).toBe(true);
    });

    it('asks before leaving unsaved edits, and respects the answer', async () => {
      await setup();
      await edit('input.title', 'Changed');
      expect(fixture.componentInstance.hasUnsavedChanges()).toBe(true);
      const dialog = stubDialog(false);
      const stay = run(fixture.componentInstance);
      let allowed: boolean | undefined;
      (stay as Observable<boolean>).subscribe((v) => (allowed = v));
      expect(dialog).toHaveBeenCalled();
      expect(allowed).toBe(false);
      dialog.mockReturnValue({ afterClosed: () => of(true) } as never);
      (run(fixture.componentInstance) as Observable<boolean>).subscribe((v) => (allowed = v));
      expect(allowed).toBe(true);
    });

    it('does not block navigation after a successful save', async () => {
      await setup();
      await edit('input.title', 'Changed');
      q('.save')?.click();
      await settle();
      expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    });
  });
});
