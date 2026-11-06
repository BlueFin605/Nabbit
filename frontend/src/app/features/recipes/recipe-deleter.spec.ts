import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject, of, throwError } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import { RecipeDeleter } from './recipe-deleter';

describe('RecipeDeleter', () => {
  let api: { deleteRecipe: jest.Mock; restoreRecipe: jest.Mock };
  let nav: jest.SpyInstance;
  let snackOpen: jest.SpyInstance;
  let action: Subject<void>;

  function setup(confirm: boolean) {
    api = { deleteRecipe: jest.fn(() => of(undefined)), restoreRecipe: jest.fn(() => of({})) };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiClient, useValue: api }] });
    nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    action = new Subject<void>();
    snackOpen = jest.spyOn(TestBed.inject(MatSnackBar), 'open').mockReturnValue({ onAction: () => action } as never);
    jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(confirm) } as never);
    return TestBed.inject(RecipeDeleter);
  }

  it('puts the recipe title in the confirm message when given', () => {
    const d = setup(true);
    d.confirmAndDelete('r1', {}, 'Pancakes');
    const cfg = (TestBed.inject(MatDialog).open as jest.Mock<unknown, [unknown, { data: { message: string } }]>).mock.calls[0][1];
    expect(cfg.data.message).toContain('"Pancakes"');
  });

  it('calls onDeleting then onSettled around the delete (success and error)', () => {
    const d = setup(true);
    const calls: string[] = [];
    const hooks = { onDeleting: () => calls.push('deleting'), onSettled: () => calls.push('settled') };
    d.confirmAndDelete('r1', hooks);
    expect(calls).toEqual(['deleting', 'settled']);
    calls.length = 0;
    api.deleteRecipe.mockReturnValue(throwError(() => new Error('x')));
    d.confirmAndDelete('r1', hooks);
    expect(calls).toEqual(['deleting', 'settled']);
  });

  it('does nothing when the dialog is cancelled', () => {
    const d = setup(false);
    const onDeleted = jest.fn();
    d.confirmAndDelete('r1', { onDeleted });
    expect(api.deleteRecipe).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(snackOpen).not.toHaveBeenCalled();
  });

  it('deletes, runs onDeleted and opens the Undo snackbar', () => {
    const d = setup(true);
    const onDeleted = jest.fn();
    d.confirmAndDelete('r1', { onDeleted });
    expect(api.deleteRecipe).toHaveBeenCalledWith('r1');
    expect(onDeleted).toHaveBeenCalled();
    expect(snackOpen).toHaveBeenCalledWith('Recipe deleted', 'Undo', { duration: 8000 });
  });

  it('Undo restores then calls onRestored; default navigates to the recipe', () => {
    const d = setup(true);
    const onRestored = jest.fn();
    d.confirmAndDelete('r1', { onRestored });
    action.next();
    expect(api.restoreRecipe).toHaveBeenCalledWith('r1');
    expect(onRestored).toHaveBeenCalledWith('r1');
    expect(nav).not.toHaveBeenCalled();
  });

  it('default Undo navigates to the recipe', () => {
    const d = setup(true);
    d.confirmAndDelete('r2');
    action.next();
    expect(nav).toHaveBeenCalledWith(['/recipes', 'r2']);
  });

  it('a delete error calls onError and skips the snackbar', () => {
    const d = setup(true);
    api.deleteRecipe.mockReturnValue(throwError(() => new Error('x')));
    const onError = jest.fn();
    const onDeleted = jest.fn();
    d.confirmAndDelete('r1', { onError, onDeleted });
    expect(onError).toHaveBeenCalledWith("Couldn't delete the recipe. Try again.");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(snackOpen).not.toHaveBeenCalled();
  });

  it('default delete error shows a snackbar message', () => {
    const d = setup(true);
    api.deleteRecipe.mockReturnValue(throwError(() => new Error('x')));
    d.confirmAndDelete('r1');
    expect(snackOpen).toHaveBeenCalledWith("Couldn't delete the recipe. Try again.", undefined, { duration: 5000 });
  });

  it('a restore error shows the restore snackbar', () => {
    const d = setup(true);
    d.confirmAndDelete('r1');
    api.restoreRecipe.mockReturnValue(throwError(() => new Error('x')));
    action.next();
    expect(snackOpen).toHaveBeenLastCalledWith("Couldn't restore the recipe", undefined, { duration: 5000 });
  });
});
