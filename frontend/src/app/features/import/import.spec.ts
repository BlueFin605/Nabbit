import { HttpErrorResponse } from '@angular/common/http';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import type { Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { ImportResult, Recipe, RecipeInput } from '../../core/api/api.types';
import { Import, firstUrl, toImportRequest } from './import';

const ing = (): Ingredient => ({
  id: 'i1',
  original: '1 cup flour',
  quantity: 1,
  unit: 'cup',
  name: 'flour',
  scalable: true,
  metric: { quantity: 240, unit: 'ml' },
});
const result = (over: Partial<ImportResult['draft']> = {}, imageUrl?: string): ImportResult => ({
  draft: {
    confidence: 'structured',
    recipe: { title: 'Pancakes', servings: 4, ingredients: [ing()], steps: ['Mix', 'Fry'], tags: [] },
    ...over,
  },
  ...(imageUrl ? { imageUrl } : {}),
});
const httpErr = (status: number, error?: unknown) => throwError(() => new HttpErrorResponse({ status, error }));

describe('Import', () => {
  let importRecipe: jest.Mock;
  let createRecipe: jest.Mock;
  let fixture: ComponentFixture<Import>;

  async function setup(inputs: Record<string, string> = {}, impl: (r: unknown) => unknown = () => of(result())) {
    importRecipe = jest.fn(impl);
    createRecipe = jest.fn(() => of({ id: 'new1' } as Recipe));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: ApiClient, useValue: { importRecipe, createRecipe } }],
    });
    fixture = TestBed.createComponent(Import);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(s: string) => el().querySelector<T>(s);
  function type(value: string) {
    const box = q<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;
    box.value = value;
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  async function tapImport() {
    q('.import-btn')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('makes no network call before the user taps Import', async () => {
    await setup();
    type('https://example.com/r');
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it('routes https values as url and anything else as text', async () => {
    expect(toImportRequest(' https://x.com/a ')).toEqual({ url: 'https://x.com/a' });
    expect(toImportRequest('2 eggs\nwhisk')).toEqual({ text: '2 eggs\nwhisk' });
    expect(toImportRequest('http://x.com')).toEqual({ text: 'http://x.com' });
    await setup();
    type('2 eggs');
    await tapImport();
    expect(importRecipe).toHaveBeenCalledWith({ text: '2 eggs' });
  });

  it('sends a pasted https link as url', async () => {
    await setup();
    type('https://example.com/r');
    await tapImport();
    expect(importRecipe).toHaveBeenCalledWith({ url: 'https://example.com/r' });
  });

  it('share target prefills from url and imports automatically', async () => {
    await setup({ url: 'https://example.com/r', text: 'ignored', title: 'T' });
    expect(importRecipe).toHaveBeenCalledWith({ url: 'https://example.com/r' });
  });

  it('share target finds a URL embedded in text', async () => {
    expect(firstUrl('Look at this: https://example.com/r?a=1, yum')).toBe('https://example.com/r?a=1');
    await setup({ text: 'Great pancakes https://example.com/p.' });
    expect(importRecipe).toHaveBeenCalledWith({ url: 'https://example.com/p' });
  });

  it('shows a loading state', async () => {
    await setup({ url: 'https://example.com/r' }, () => NEVER);
    expect(q('[role="status"]')).not.toBeNull();
  });

  it('shows the rate-limit message on 429', async () => {
    await setup({}, () => httpErr(429, { error: 'rate_limited' }));
    type('hello');
    await tapImport();
    expect(q('[role="alert"]')?.textContent).toContain("You've imported a lot — try again in a while");
  });

  it('maps 422 codes to friendly messages with the paste-text fallback, focusing the box', async () => {
    jest.useFakeTimers();
    try {
      await setup({}, () => httpErr(422, { error: 'timeout' }));
      document.body.appendChild(el());
      type('https://example.com/r');
      q('.import-btn')?.click();
      fixture.detectChanges();
      jest.runAllTimers();
      fixture.detectChanges();
      const msg = q('[role="alert"]')?.textContent ?? '';
      expect(msg).toContain('took too long');
      expect(msg).toContain('Paste the recipe text instead');
      expect(document.activeElement).toBe(q('textarea'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the preview with metric ingredients and the original on expand', async () => {
    await setup({}, () => of(result({}, 'https://example.com/p.jpg')));
    type('x');
    await tapImport();
    expect(q<HTMLInputElement>('input.title')?.value).toBe('Pancakes');
    expect(q('summary')?.textContent).toContain('240 ml');
    expect(q('details .original')?.textContent).toContain('1 cup flour');
    expect(q('img.photo')?.getAttribute('src')).toBe('https://example.com/p.jpg');
    expect(q('.banner')).toBeNull();
  });

  it('shows the heuristic banner', async () => {
    await setup({}, () => of(result({ confidence: 'heuristic' })));
    type('x');
    await tapImport();
    expect(q('.banner')?.textContent).toContain('Check this one carefully');
  });

  it('empty extraction opens a blank editor with the source link kept', async () => {
    await setup({}, () =>
      of(result({ confidence: 'heuristic', recipe: { title: '', servings: 4, ingredients: [], steps: [], tags: [] } })),
    );
    jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    type('https://example.com/r');
    await tapImport();
    expect(q('input.title')).not.toBeNull();
    q('.save')?.click();
    expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'https://example.com/r' }));
  });

  it('save posts the (edited) recipe without an image and navigates to it', async () => {
    await setup({}, () => of(result({}, 'https://example.com/p.jpg')));
    const nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    type('https://example.com/r');
    await tapImport();
    const title = q<HTMLInputElement>('input.title') as HTMLInputElement;
    title.value = 'Better pancakes';
    title.dispatchEvent(new Event('input'));
    q('.save')?.click();
    const body = (createRecipe.mock.calls[0] as [RecipeInput])[0];
    expect(body.title).toBe('Better pancakes');
    expect(body.imageKey).toBeUndefined();
    expect(body.sourceUrl).toBe('https://example.com/r');
    expect(nav).toHaveBeenCalledWith(['/recipes', 'new1']);
  });

  it('discard returns to /recipes without saving', async () => {
    await setup();
    const nav = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    type('x');
    await tapImport();
    q('.discard')?.click();
    expect(nav).toHaveBeenCalledWith(['/recipes']);
    expect(createRecipe).not.toHaveBeenCalled();
  });
});
