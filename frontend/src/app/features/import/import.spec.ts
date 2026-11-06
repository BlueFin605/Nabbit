import { HttpErrorResponse } from '@angular/common/http';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router, provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import type { Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { ImportErrorCode, ImportResult, Recipe, RecipeInput } from '../../core/api/api.types';
import { IMPORT_ERROR_MESSAGES, Import, NEEDS_TEXT_GENERIC_MESSAGE, canonicalInstagramUrl, firstUrl, isInstagramUrl, mergeDrafts, toImportRequest } from './import';

const ing = (): Ingredient => ({
  id: 'i1',
  original: '1 cup flour',
  quantity: 1,
  unit: 'cup',
  name: 'flour',
  scalable: true,
  metric: { quantity: 240, unit: 'ml' },
});
const result = (over: Partial<ImportResult['draft']> = {}, imageUrl?: string, candidates?: string[]): ImportResult => ({
  draft: {
    confidence: 'structured',
    recipe: { title: 'Pancakes', servings: 4, ingredients: [ing()], steps: ['Mix', 'Fry'], tags: [] },
    ...over,
  },
  ...(imageUrl ? { imageUrl } : {}),
  ...(candidates ? { candidates } : {}),
});
const httpErr = (status: number, error?: unknown) => throwError(() => new HttpErrorResponse({ status, error }));

describe('Import', () => {
  let importRecipe: jest.Mock;
  let createRecipe: jest.Mock;
  let importImage: jest.Mock;
  let snack: jest.SpyInstance;
  let fixture: ComponentFixture<Import>;

  async function setup(inputs: Record<string, string> = {}, impl: (r: unknown) => unknown = () => of(result())) {
    TestBed.resetTestingModule();
    importRecipe = jest.fn(impl);
    createRecipe = jest.fn(() => of({ id: 'new1' } as Recipe));
    importImage = jest.fn(() => of({ imageKey: 'o/img.jpg' }));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: ApiClient, useValue: { importRecipe, createRecipe, importImage } }],
    });
    snack = jest.spyOn(TestBed.inject(MatSnackBar), 'open').mockReturnValue(undefined as never);
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
    // third-party photo is not loaded automatically and is labelled as unsaved
    expect(q('img.photo')).toBeNull();
    expect(q('.photo-note')?.textContent).toContain('Photo found, will be saved');
    q('.show-options')?.click();
    fixture.detectChanges();
    expect(q('img.photo')?.getAttribute('src')).toBe('https://example.com/p.jpg');
    expect(q('.photo-note')?.textContent).toContain('Photo found, will be saved');
    expect(q('.show-options')).toBeNull();
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

  it('save posts the (edited) recipe and navigates to it', async () => {
    await setup({}, () => of(result()));
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

  describe('photo fetch on save', () => {
    const cands = ['https://a.example/1.jpg', 'https://a.example/2.jpg'];
    async function ready(res: ImportResult) {
      await setup({}, () => of(res));
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      type('https://example.com/r');
      await tapImport();
    }
    const savedBody = () => (createRecipe.mock.calls[0] as [RecipeInput])[0];

    it('imports the first candidate then creates the recipe with the returned key', async () => {
      await ready(result({}, 'https://example.com/p.jpg', cands));
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledWith(cands[0]);
      expect(savedBody().imageKey).toBe('o/img.jpg');
    });

    it('imports the candidate the user chose', async () => {
      await ready(result({}, undefined, cands));
      q('.show-options')?.click();
      fixture.detectChanges();
      q<HTMLButtonElement>('.candidate:nth-child(2)')?.click();
      fixture.detectChanges();
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledWith(cands[1]);
    });

    it('falls back to imageUrl when there are no candidates', async () => {
      await ready(result({}, 'https://example.com/p.jpg'));
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledWith('https://example.com/p.jpg');
    });

    it('still creates the recipe and shows a snackbar when the image import fails', async () => {
      await ready(result({}, undefined, cands));
      importImage.mockReturnValue(httpErr(422, { error: 'not_image' }));
      q('.save')?.click();
      expect(createRecipe).toHaveBeenCalledTimes(1);
      expect(savedBody().imageKey).toBeUndefined();
      expect(snack).toHaveBeenCalledWith(expect.stringContaining('Saved without a photo - add one in the editor.'), 'OK', expect.anything());
    });

    it('makes no importImage call without candidates or imageUrl', async () => {
      await ready(result());
      q('.save')?.click();
      expect(importImage).not.toHaveBeenCalled();
      expect(createRecipe).toHaveBeenCalled();
    });

    it('declining the found photo saves with no photo and no importImage call', async () => {
      await ready(result({}, undefined, cands));
      q('.decline-photo')?.click();
      fixture.detectChanges();
      expect(q('.photo-note')).toBeNull();
      q('.save')?.click();
      expect(importImage).not.toHaveBeenCalled();
      expect(savedBody().imageKey).toBeUndefined();
    });

    it('after declining, a found photo can be picked again', async () => {
      await ready(result({}, undefined, cands));
      q('.decline-photo')?.click();
      fixture.detectChanges();
      q('.show-options')?.click();
      fixture.detectChanges();
      q<HTMLButtonElement>('.candidate:nth-child(2)')?.click();
      fixture.detectChanges();
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledWith(cands[1]);
    });

    it('a retry after createRecipe fails reuses the fetched key', async () => {
      await ready(result({}, undefined, cands));
      createRecipe.mockReturnValueOnce(httpErr(500));
      q('.save')?.click();
      fixture.detectChanges();
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledTimes(1);
      expect(createRecipe).toHaveBeenCalledTimes(2);
      expect((createRecipe.mock.calls[1] as [RecipeInput])[0].imageKey).toBe('o/img.jpg');
    });

    it('changing candidate after a fetch discards the cached key', async () => {
      await ready(result({}, undefined, cands));
      createRecipe.mockReturnValueOnce(httpErr(500));
      q('.save')?.click();
      fixture.detectChanges();
      q('.show-options')?.click();
      fixture.detectChanges();
      q<HTMLButtonElement>('.candidate:nth-child(2)')?.click();
      fixture.detectChanges();
      importImage.mockReturnValue(of({ imageKey: 'o/img2.jpg' }));
      q('.save')?.click();
      expect(importImage).toHaveBeenCalledTimes(2);
      expect(importImage).toHaveBeenLastCalledWith(cands[1]);
      expect((createRecipe.mock.calls[1] as [RecipeInput])[0].imageKey).toBe('o/img2.jpg');
    });
  });

  describe('AI import', () => {
    const IG = 'https://www.instagram.com/reel/abc/';
    const needsText = () => httpErr(422, { error: 'needs_text' });
    const onlyOnce = (first: () => unknown, then: () => unknown) => {
      let n = 0;
      return () => (n++ === 0 ? first() : then());
    };
    const withIng = (original: string, name: string): Ingredient => ({ ...ing(), id: name, original, name });

    it('needs_text shows an info panel (not the alert), keeps the URL and focuses a "Paste the caption" textarea', async () => {
      jest.useFakeTimers();
      try {
        await setup({}, needsText);
        document.body.appendChild(el());
        type(IG);
        q('.import-btn')?.click();
        fixture.detectChanges();
        jest.runAllTimers();
        fixture.detectChanges();
        expect(q('[role="alert"]')).toBeNull();
        expect(q('.info')?.textContent).toContain(IMPORT_ERROR_MESSAGES.needs_text);
        expect(q('mat-label')?.textContent).toContain('Paste the caption');
        expect(q<HTMLTextAreaElement>('textarea')?.value).toBe('');
        expect(document.activeElement).toBe(q('textarea'));
      } finally {
        jest.useRealTimers();
      }
    });

    describe('needs_text for a non-Instagram page', () => {
      const SITE = 'https://example.com/js-recipe';

      it('shows the generic JavaScript message and a "Paste the recipe text" label', async () => {
        await setup({}, needsText);
        type(SITE);
        await tapImport();
        expect(q('[role="alert"]')).toBeNull();
        expect(q('.info')?.textContent).toContain(NEEDS_TEXT_GENERIC_MESSAGE);
        expect(q('.info')?.textContent).not.toContain('Instagram');
        expect(q('mat-label')?.textContent).toContain('Paste the recipe text');
      });

      it('strips tracking params from the remembered URL used as sourceUrl', async () => {
        await setup({}, onlyOnce(needsText, () => of(result())));
        type(`${SITE}?id=2&utm_source=x&gclid=abc`);
        await tapImport();
        type('Pancakes\n2 eggs');
        await tapImport();
        jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        q('.save')?.click();
        expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: `${SITE}?id=2` }));
      });

      it('a lone Instagram URL pasted in generic mode imports as a URL', async () => {
        await setup({}, onlyOnce(needsText, () => of(result())));
        type(SITE);
        await tapImport();
        type(IG);
        await tapImport();
        expect(importRecipe).toHaveBeenLastCalledWith({ url: IG });
      });

      it('Instagram URLs keep the Instagram message', async () => {
        await setup({}, needsText);
        type(IG);
        await tapImport();
        expect(q('.info')?.textContent).toContain(IMPORT_ERROR_MESSAGES.needs_text);
      });

      it('pasted text re-imports as {text}, keeps the URL as sourceUrl and does not offer the comment appender', async () => {
        await setup({}, onlyOnce(needsText, () => of(result())));
        type(SITE);
        await tapImport();
        type('Pancakes\n2 eggs');
        await tapImport();
        expect(importRecipe).toHaveBeenLastCalledWith({ text: 'Pancakes\n2 eggs' });
        expect(q('.comment-appender')).toBeNull();
        jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
        q('.save')?.click();
        expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: SITE }));
      });
    });

    it('pasting the caption sends {text} and sets sourceUrl to the remembered URL', async () => {
      await setup({}, onlyOnce(needsText, () => of(result())));
      type(IG);
      await tapImport();
      type('Pancakes\n2 eggs');
      await tapImport();
      expect(importRecipe).toHaveBeenLastCalledWith({ text: 'Pancakes\n2 eggs' });
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.save')?.click();
      expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: IG }));
    });

    it('share params are stripped from the request and from the saved sourceUrl', async () => {
      await setup({}, onlyOnce(needsText, () => of(result())));
      type('https://www.instagram.com/reel/XyZ/?igsh=abc&utm_source=ig_web_copy_link&rpxt=1#f');
      await tapImport();
      expect(importRecipe).toHaveBeenLastCalledWith({ url: 'https://www.instagram.com/reel/XyZ/' });
      type('Pancakes\n2 eggs');
      await tapImport();
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.save')?.click();
      expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'https://www.instagram.com/reel/XyZ/' }));
    });

    it('canonicalInstagramUrl reduces posts and drops query/fragment elsewhere', () => {
      expect(canonicalInstagramUrl('https://instagram.com/someone/p/AbC/?igshid=1')).toBe('https://www.instagram.com/p/AbC/');
      expect(canonicalInstagramUrl('https://www.instagram.com/tv/Q9?srtk=1')).toBe('https://www.instagram.com/tv/Q9/');
      expect(canonicalInstagramUrl('https://www.instagram.com/someone/?hl=en#x')).toBe('https://www.instagram.com/someone/');
    });

    it('other 422 codes still show the red alert', async () => {
      await setup({}, () => httpErr(422, { error: 'bad_status' }));
      type(IG);
      await tapImport();
      expect(q('[role="alert"]')?.textContent).toContain("wouldn't let us read the page");
      expect(q('.info')).toBeNull();
    });

    it('shows the AI banner only for confidence ai', async () => {
      await setup({}, () => of(result({ confidence: 'ai' })));
      type('x');
      await tapImport();
      expect(q('.banner')?.textContent).toContain('AI-assisted - check the ingredients');
      await setup({}, () => of(result({ confidence: 'structured' })));
      type('x');
      await tapImport();
      expect(q('.banner')).toBeNull();
    });

    it('offers the comment appender for Instagram URLs and needs_text only', async () => {
      await setup({}, () => of(result()));
      type('https://example.com/r');
      await tapImport();
      expect(q('.comment-appender')).toBeNull();

      for (const host of ['instagram.com', 'www.instagram.com', 'instagr.am']) {
        await setup({}, () => of(result()));
        type(`https://${host}/p/x/`);
        await tapImport();
        expect(q('.comment-appender')).not.toBeNull();
      }

      await setup({}, onlyOnce(needsText, () => of(result())));
      type(IG);
      await tapImport();
      type('caption');
      await tapImport();
      expect(q('.comment-appender')).not.toBeNull();
    });

    it('does not treat lookalike hosts as Instagram', async () => {
      await setup({}, () => of(result()));
      type('https://notinstagram.com/p/x');
      await tapImport();
      expect(q('.comment-appender')).toBeNull();
    });

    async function toAppender(impl: () => unknown, caption = 'the caption') {
      await setup({}, onlyOnce(needsText, impl));
      type(IG);
      await tapImport();
      type(caption);
      await tapImport();
    }
    function writeComment(text: string) {
      const area = q<HTMLTextAreaElement>('.comment-appender textarea') as HTMLTextAreaElement;
      area.value = text;
      area.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }
    function editTitle(text: string) {
      const title = q<HTMLInputElement>('input.title') as HTMLInputElement;
      title.value = text;
      title.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('with a known caption, re-imports caption + comment and REPLACES the draft', async () => {
      const comment = result({
        recipe: {
          title: 'Other',
          servings: 2,
          ingredients: [withIng('1 cup flour', 'flour'), withIng('2 eggs', 'eggs')],
          steps: ['Mix', 'Bake'],
          tags: [],
        },
      });
      await toAppender(onlyOnce(() => of(result({}, undefined, ['https://a.example/1.jpg'])), () => of(comment)));
      writeComment('the comment');
      q('.add-comment')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(importRecipe).toHaveBeenLastCalledWith({ text: 'the caption\n\nthe comment' });
      expect(q<HTMLInputElement>('input.title')?.value).toBe('Other');
      expect(el().querySelectorAll('.ingredient')).toHaveLength(2);
      expect(q('.photo-note')).not.toBeNull(); // photo choice kept
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.save')?.click();
      const body = (createRecipe.mock.calls[0] as [RecipeInput])[0];
      expect(body.ingredients.map((i) => i.name)).toEqual(['flour', 'eggs']);
      expect(body.steps).toEqual(['Mix', 'Bake']);
    });

    it('with an unknown caption, sends just the comment and MERGES, skipping duplicates', async () => {
      const comment = result({
        confidence: 'ai',
        recipe: {
          title: 'Other',
          servings: 2,
          ingredients: [withIng('1 CUP flour', 'flour'), withIng('2 eggs', 'eggs')],
          steps: ['mix', 'Bake'],
          tags: [],
        },
      });
      await setup({}, onlyOnce(() => of(result()), () => of(comment)));
      type(IG);
      await tapImport();
      writeComment('the comment');
      q('.add-comment')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(importRecipe).toHaveBeenLastCalledWith({ text: 'the comment' });
      expect(q<HTMLInputElement>('input.title')?.value).toBe('Pancakes');
      expect(q('.banner')?.textContent).toContain('AI-assisted');
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.save')?.click();
      const body = (createRecipe.mock.calls[0] as [RecipeInput])[0];
      expect(body.ingredients.map((i) => i.name)).toEqual(['flour', 'eggs']);
      expect(body.steps).toEqual(['Mix', 'Fry', 'Bake']);
    });

    it('mergeDrafts is ai when either side is ai', () => {
      const d = (confidence: 'ai' | 'heuristic' | 'structured') => result({ confidence }).draft;
      expect(mergeDrafts(d('heuristic'), d('ai')).confidence).toBe('ai');
      expect(mergeDrafts(d('ai'), d('heuristic')).confidence).toBe('ai');
      expect(mergeDrafts(d('heuristic'), d('structured')).confidence).toBe('heuristic');
    });

    it('disables the appender once the editor is dirty so edits are never wiped', async () => {
      await toAppender(() => of(result()));
      writeComment('the comment');
      expect(q<HTMLButtonElement>('.add-comment')?.disabled).toBe(false);
      editTitle('My edited title');
      expect(q<HTMLButtonElement>('.add-comment')?.disabled).toBe(true);
      expect(q('.comment-appender .hint')).not.toBeNull();
      q('.add-comment')?.click();
      expect(importRecipe).toHaveBeenCalledTimes(2); // IG needs_text + caption only
      expect(q<HTMLInputElement>('input.title')?.value).toBe('My edited title');
    });

    it('a caption starting with https:// plus more text is still sent as {text} after needs_text', async () => {
      await setup({}, onlyOnce(needsText, () => of(result())));
      type(IG);
      await tapImport();
      type('https://example.com/r great pancakes\n2 eggs');
      await tapImport();
      expect(importRecipe).toHaveBeenLastCalledWith({ text: 'https://example.com/r great pancakes\n2 eggs' });
    });

    it('a single non-Instagram https URL after needs_text is a normal URL import', async () => {
      await setup({}, onlyOnce(needsText, () => of(result())));
      type(IG);
      await tapImport();
      type('https://example.com/r');
      await tapImport();
      expect(importRecipe).toHaveBeenLastCalledWith({ url: 'https://example.com/r' });
      expect(q('.comment-appender')).toBeNull();
      jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      q('.save')?.click();
      expect(createRecipe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'https://example.com/r' }));
    });

    it('trailing-dot and m. hosts count as Instagram', () => {
      expect(isInstagramUrl('https://instagram.com./p/x')).toBe(true);
      expect(isInstagramUrl('https://m.instagram.com/p/x')).toBe(true);
      expect(isInstagramUrl('https://instagram.com.evil.com/p/x')).toBe(false);
      expect(isInstagramUrl('https://instagram.com@evil.com/p/x')).toBe(false);
    });

    it('appender failure shows the alert, keeps the draft, and does not set needsText or move focus', async () => {
      await toAppender(onlyOnce(() => of(result()), needsText));
      document.body.appendChild(el());
      writeComment('the comment');
      (document.activeElement as HTMLElement | null)?.blur();
      jest.useFakeTimers();
      try {
        q('.add-comment')?.click();
        fixture.detectChanges();
        jest.runAllTimers();
        fixture.detectChanges();
        expect(q('.comment-appender [role="alert"]')?.textContent).toContain("Instagram wouldn't let us read this post");
        expect(q('.info')).toBeNull();
        expect(q<HTMLInputElement>('input.title')?.value).toBe('Pancakes');
        expect(q('mat-label')?.textContent ?? '').not.toContain('Paste the caption');
        expect(document.activeElement).not.toBe(q('textarea'));
      } finally {
        jest.useRealTimers();
      }
    });
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

describe('IMPORT_ERROR_MESSAGES', () => {
  const codes: ImportErrorCode[] = [
    'bad_url',
    'blocked_address',
    'too_large',
    'timeout',
    'bad_status',
    'not_html',
    'not_image',
    'too_many_redirects',
    'needs_text',
  ];

  it.each(codes)('has a message for %s', (code) => {
    expect(IMPORT_ERROR_MESSAGES[code]).toBeTruthy();
  });

  it('asks the user to paste the recipe text for non-Instagram needs_text', () => {
    expect(NEEDS_TEXT_GENERIC_MESSAGE).toBe(
      "That site builds its recipes with JavaScript, so we can't read it. Copy the recipe text from the page and paste it here.",
    );
  });

  it('asks the user to paste the caption for needs_text', () => {
    expect(IMPORT_ERROR_MESSAGES.needs_text).toBe(
      "Instagram wouldn't let us read this post. Paste the caption (and the recipe comment if it's in the comments).",
    );
  });
});
