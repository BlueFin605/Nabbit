import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { RecipeInput } from '../../core/api/api.types';
import { RecipeEditor } from './recipe-editor';

const flour = (): Ingredient => ({
  id: 'i1',
  original: '1 cup flour',
  quantity: 1,
  unit: 'cup',
  name: 'flour',
  scalable: true,
  metric: { quantity: 240, unit: 'ml' },
});
const salt = (): Ingredient => ({ id: 'i2', quantity: null, unit: '', name: 'salt', scalable: false });
const base = (): RecipeInput => ({
  title: 'Pancakes',
  servings: 4,
  ingredients: [flour(), salt()],
  steps: ['Mix', 'Fry'],
  tags: ['breakfast'],
  sourceUrl: 'https://example.com/p',
});

describe('RecipeEditor', () => {
  let fixture: ComponentFixture<RecipeEditor>;
  let saved: RecipeInput[];
  let presignImageUpload: jest.Mock;
  let uploadImage: jest.Mock;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(s: string) => el().querySelector<T>(s);
  const qa = <T extends HTMLElement>(s: string) => Array.from(el().querySelectorAll<T>(s));

  async function setup(recipe: RecipeInput = base()) {
    presignImageUpload = jest.fn(() => of({ imageKey: 'o/new.png', url: 'https://s3.example/b', fields: { k: 'v' }, expiresIn: 300 }));
    uploadImage = jest.fn(() => of(undefined));
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: { presignImageUpload, uploadImage } }] });
    fixture = TestBed.createComponent(RecipeEditor);
    fixture.componentRef.setInput('recipe', recipe);
    saved = [];
    fixture.componentInstance.saved.subscribe((v) => saved.push(v));
    await settle();
  }
  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  async function typeInto(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event = 'input') {
    input.value = value;
    input.dispatchEvent(new Event(event));
    await settle();
  }

  it('shows each ingredient as separate quantity, unit, name and note fields', async () => {
    await setup();
    expect(qa<HTMLInputElement>('input.qty')[0].value).toBe('1');
    expect(qa<HTMLSelectElement>('select.unit')[0].value).toBe('cup');
    expect(qa<HTMLInputElement>('input.name')[0].value).toBe('flour');
    expect(qa('input.note')).toHaveLength(2);
    expect(qa('select.unit')[0].querySelectorAll('option').length).toBeGreaterThan(10);
  });

  it('editing the quantity updates the metric text and drops original', async () => {
    await setup();
    expect(q('summary')?.textContent).toContain('240 ml');
    expect(q('details .original')?.textContent).toContain('1 cup flour');
    await typeInto(qa<HTMLInputElement>('input.qty')[0], '2');
    expect(q('summary')?.textContent).toContain('480 ml');
    expect(q('details .original')).toBeNull();
    expect(fixture.componentInstance.ingredients()[0].original).toBeUndefined();
    expect(fixture.componentInstance.ingredients()[0].metric).toEqual({ quantity: 480, unit: 'ml' });
  });

  it('changing the unit recomputes the metric', async () => {
    await setup();
    await typeInto(qa<HTMLSelectElement>('select.unit')[0], 'tbsp', 'change');
    expect(fixture.componentInstance.ingredients()[0].metric).toEqual({ quantity: 15, unit: 'ml' });
    expect(fixture.componentInstance.ingredients()[0].original).toBeUndefined();
  });

  it('adds and removes ingredients and steps', async () => {
    await setup();
    q('.add-ingredient')?.click();
    q('.add-step')?.click();
    await settle();
    expect(qa('.ingredient')).toHaveLength(3);
    expect(qa('textarea.step')).toHaveLength(3);
    qa('.remove-ingredient')[0].click();
    qa('.remove-step')[0].click();
    await settle();
    expect(qa('.ingredient')).toHaveLength(2);
    expect(fixture.componentInstance.steps().map((s) => s.text)).toEqual(['Fry', '']);
  });

  it('reorders ingredients and steps on drop', async () => {
    await setup();
    fixture.componentInstance.dropIngredient({ previousIndex: 0, currentIndex: 1 } as never);
    fixture.componentInstance.dropStep({ previousIndex: 1, currentIndex: 0 } as never);
    await settle();
    expect(fixture.componentInstance.ingredients().map((i) => i.name)).toEqual(['salt', 'flour']);
    expect(fixture.componentInstance.steps().map((s) => s.text)).toEqual(['Fry', 'Mix']);
  });

  it('is clean until edited, then dirty', async () => {
    await setup();
    expect(fixture.componentInstance.dirty()).toBe(false);
    await typeInto(q<HTMLInputElement>('input.title') as HTMLInputElement, 'Better pancakes');
    expect(fixture.componentInstance.dirty()).toBe(true);
    await typeInto(q<HTMLInputElement>('input.title') as HTMLInputElement, 'Pancakes');
    expect(fixture.componentInstance.dirty()).toBe(false);
  });

  it('emits the edited recipe, keeping unedited fields and dropping blank rows', async () => {
    await setup();
    await typeInto(q<HTMLInputElement>('input.title') as HTMLInputElement, 'New title');
    q('.add-step')?.click();
    q('.add-ingredient')?.click();
    await settle();
    q('.save')?.click();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: 'New title', servings: 4, tags: ['breakfast'], sourceUrl: 'https://example.com/p', steps: ['Mix', 'Fry'] });
    expect(saved[0].ingredients.map((i) => i.name)).toEqual(['flour', 'salt']);
    expect(saved[0].imageKey).toBeUndefined();
  });

  it('adds and removes tags', async () => {
    await setup();
    const input = q<HTMLInputElement>('input.tag-input') as HTMLInputElement;
    input.value = 'quick';
    input.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, key: 'Enter', bubbles: true }));
    await settle();
    expect(qa('.tag').map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('quick')]));
    q('.save')?.click();
    expect(saved[0].tags).toEqual(['breakfast', 'quick']);
  });

  it('uploads a photo: presign, direct upload, then sets imageKey', async () => {
    await setup();
    const file = new File(['x'], 'p.png', { type: 'image/png' });
    const input = q<HTMLInputElement>('input.photo-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    expect(presignImageUpload).toHaveBeenCalledWith('image/png');
    expect(uploadImage).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://s3.example/b' }), file);
    q('.save')?.click();
    expect(saved[0].imageKey).toBe('o/new.png');
  });

  it('rejects unsupported photo types without calling the API', async () => {
    await setup();
    const input = q<HTMLInputElement>('input.photo-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.gif', { type: 'image/gif' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    expect(presignImageUpload).not.toHaveBeenCalled();
    expect(q('.photo-error')?.textContent).toContain('JPEG, PNG or WebP');
  });

  it('shows an upload failure and keeps the old photo', async () => {
    await setup();
    uploadImage.mockReturnValue(throwError(() => new Error('s3')));
    const input = q<HTMLInputElement>('input.photo-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.png', { type: 'image/png' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    expect(q('.photo-error')).not.toBeNull();
    q('.save')?.click();
    expect(saved[0].imageKey).toBeUndefined();
  });

  describe('photo candidates', () => {
    const cands = ['https://a.example/1.jpg', 'https://a.example/2.jpg'];
    async function withCandidates() {
      await setup();
      fixture.componentRef.setInput('previewImage', cands[0]);
      fixture.componentRef.setInput('candidates', cands);
      await settle();
    }

    it('shows the note and loads no image before the tap', async () => {
      await withCandidates();
      expect(q('.photo-note')?.textContent).toContain('Photo found, will be saved');
      expect(qa('img')).toHaveLength(0);
    });

    it('loads thumbnails after the tap and emits the chosen candidate', async () => {
      await withCandidates();
      const chosen: (string | undefined)[] = [];
      fixture.componentInstance.candidateChosen.subscribe((c) => chosen.push(c));
      q('.show-options')?.click();
      await settle();
      const thumbs = qa<HTMLButtonElement>('.candidate');
      expect(thumbs).toHaveLength(2);
      expect(thumbs[0].classList).toContain('chosen');
      expect(thumbs[0].querySelector('img')?.getAttribute('src')).toBe(cands[0]);
      thumbs[1].click();
      await settle();
      expect(chosen).toEqual([cands[1]]);
    });

    it('uploading your own photo clears the candidate and hides the options', async () => {
      await withCandidates();
      const chosen: (string | undefined)[] = [];
      fixture.componentInstance.candidateChosen.subscribe((c) => chosen.push(c));
      const input = q<HTMLInputElement>('input.photo-input') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'p.png', { type: 'image/png' })], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settle();
      expect(chosen).toEqual([undefined]);
      expect(q('.photo-note')).toBeNull();
      expect(q('.candidate')).toBeNull();
    });
  });

  it('shows the conflict prompt and keeps the form; Reload emits', async () => {
    await setup();
    await typeInto(q<HTMLInputElement>('input.title') as HTMLInputElement, 'Mine');
    const reload = jest.fn();
    fixture.componentInstance.reload.subscribe(reload);
    fixture.componentRef.setInput('conflict', true);
    await settle();
    expect(q('.conflict')?.textContent).toContain('This recipe changed on another device — reload');
    expect(q<HTMLInputElement>('input.title')?.value).toBe('Mine');
    q('.reload')?.click();
    expect(reload).toHaveBeenCalled();
  });
});
