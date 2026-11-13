import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of, throwError } from 'rxjs';
import { MAX_STEP_DEPTH, type Ingredient, type StepNode } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { RecipeInput } from '../../core/api/api.types';
import { RecipeEditor } from './recipe-editor';
import { shape } from './step-rows';

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
    q('.steps > .level-actions .add-step')?.click();
    await settle();
    expect(qa('.ingredient')).toHaveLength(3);
    expect(qa('textarea.step')).toHaveLength(3);
    qa('.remove-ingredient')[0].click();
    qa('.remove-step')[0].click();
    await settle();
    expect(qa('.ingredient')).toHaveLength(2);
    expect(shape(fixture.componentInstance.steps())).toEqual(['Fry', '']);
  });

  it('reorders ingredients and steps on drop', async () => {
    await setup();
    fixture.componentInstance.dropIngredient({ previousIndex: 0, currentIndex: 1 } as never);
    fixture.componentInstance.dropRow({ previousIndex: 1, currentIndex: 0 } as never, null);
    await settle();
    expect(fixture.componentInstance.ingredients().map((i) => i.name)).toEqual(['salt', 'flour']);
    expect(shape(fixture.componentInstance.steps())).toEqual(['Fry', 'Mix']);
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
    q('.steps > .level-actions .add-step')?.click();
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

  describe('nested steps', () => {
    const grouped = (): StepNode[] => ['Prep', { heading: 'Dough', steps: ['Mix', { steps: ['Knead'] }] }, 'Serve'];
    const topAdd = (cls: string) => q<HTMLButtonElement>(`.steps > .level-actions ${cls}`);
    const click = async (el: HTMLElement | undefined | null) => {
      el?.click();
      await settle();
    };
    const stubConfirm = (ok: boolean) => jest.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(ok) } as never);
    const rowByText = (t: string) => qa<HTMLTextAreaElement>('textarea.step').find((x) => x.value === t)!.closest('.step-row') as HTMLElement;
    const btn = (row: HTMLElement, cls: string) => row.querySelector<HTMLButtonElement>(cls) as HTMLButtonElement;

    it('loads a nested tree into group rows with headings and saves it back unchanged', async () => {
      await setup({ ...base(), steps: grouped() });
      expect(qa<HTMLInputElement>('input.group-heading').map((i) => i.value)).toEqual(['Dough', '']);
      expect(fixture.componentInstance.dirty()).toBe(false);
      await typeInto(q<HTMLInputElement>('input.title') as HTMLInputElement, 'Renamed');
      q('.save')?.click();
      expect(saved[0].steps).toEqual(grouped());
      expect(saved[0].title).toBe('Renamed');
    });

    it('a flat recipe still saves flat, with no wrapper group', async () => {
      await setup();
      expect(qa('.group-row')).toHaveLength(0);
      q('.save')?.click();
      expect(saved[0].steps).toEqual(['Mix', 'Fry']);
    });

    it('adds a group at the top level and a step inside it', async () => {
      await setup();
      await click(topAdd('.add-group'));
      expect(qa('.group-row')).toHaveLength(1);
      await click(q('.group-row .add-step'));
      await typeInto(q<HTMLInputElement>('input.group-heading') as HTMLInputElement, 'Sauce');
      await typeInto(qa<HTMLTextAreaElement>('.group-row textarea.step')[0], 'Simmer');
      q('.save')?.click();
      expect(saved[0].steps).toEqual(['Mix', 'Fry', { heading: 'Sauce', steps: ['Simmer'] }]);
    });

    it('indent moves a step into the group above; outdent moves it back out after the group', async () => {
      await setup({ ...base(), steps: [{ heading: 'G', steps: ['a'] }, 'b'] });
      await click(btn(rowByText('b'), '.indent'));
      q('.save')?.click();
      expect(saved[0].steps).toEqual([{ heading: 'G', steps: ['a', 'b'] }]);
      await click(btn(rowByText('b'), '.outdent'));
      q('.save')?.click();
      expect(saved[1].steps).toEqual([{ heading: 'G', steps: ['a'] }, 'b']);
    });

    it('disables Indent with no group above and Outdent at the top level, with per-button labels', async () => {
      await setup({ ...base(), steps: ['a', { heading: 'G', steps: ['b'] }] });
      const a = rowByText('a');
      expect(btn(a, '.indent').disabled).toBe(true);
      expect(btn(a, '.outdent').disabled).toBe(true);
      expect(btn(a, '.indent').getAttribute('aria-label')).toBe('Indent step 1');
      const b = rowByText('b');
      expect(btn(b, '.outdent').disabled).toBe(false);
      expect(btn(b, '.outdent').getAttribute('aria-label')).toBe('Outdent step 1');
      expect(btn(q('.group-row') as HTMLElement, '.outdent').getAttribute('aria-label')).toContain('G');
    });

    it('disables Indent when it would exceed the depth limit', async () => {
      let deep: StepNode = 'leaf';
      for (let i = 1; i < MAX_STEP_DEPTH; i++) deep = { steps: [deep] };
      await setup({ ...base(), steps: [{ steps: ['x'] }, deep] });
      const last = qa<HTMLElement>('.steps > .level > .group-row').at(-1) as HTMLElement;
      expect(btn(last, '.row-controls .indent').disabled).toBe(true);
    });

    it('drops blank steps and a group left empty on save, keeping real content', async () => {
      await setup({ ...base(), steps: ['Mix'] });
      await click(topAdd('.add-group'));
      await click(q('.group-row .add-step'));
      await click(topAdd('.add-step'));
      q('.save')?.click();
      expect(saved[0].steps).toEqual(['Mix']);
    });

    it('deleting a group with children asks first; cancel keeps it, confirm removes it', async () => {
      await setup({ ...base(), steps: [{ heading: 'G', steps: ['a'] }, 'b'] });
      const open = stubConfirm(false);
      await click(q('.remove-group'));
      expect(open).toHaveBeenCalled();
      expect(qa('.group-row')).toHaveLength(1);
      open.mockReturnValue({ afterClosed: () => of(true) } as never);
      await click(q('.remove-group'));
      expect(qa('.group-row')).toHaveLength(0);
      q('.save')?.click();
      expect(saved[0].steps).toEqual(['b']);
    });

    it('deleting an empty group does not ask', async () => {
      await setup();
      await click(topAdd('.add-group'));
      const open = stubConfirm(true);
      await click(q('.remove-group'));
      expect(open).not.toHaveBeenCalled();
      expect(qa('.group-row')).toHaveLength(0);
    });

    it('reorders within one level, leaving other levels alone', async () => {
      await setup({ ...base(), steps: [{ heading: 'G', steps: ['a', 'b', 'c'] }, 'x', 'y'] });
      const c = fixture.componentInstance;
      const gid = c.steps()[0].id;
      c.dropRow({ previousIndex: 0, currentIndex: 2 } as never, gid);
      c.dropRow({ previousIndex: 2, currentIndex: 1 } as never, null);
      await settle();
      q('.save')?.click();
      expect(saved[0].steps).toEqual([{ heading: 'G', steps: ['b', 'c', 'a'] }, 'y', 'x']);
    });

    it('becomes dirty when a step is indented, and clean again when undone', async () => {
      await setup({ ...base(), steps: [{ heading: 'G', steps: ['a'] }, 'b'] });
      await click(btn(rowByText('b'), '.indent'));
      expect(fixture.componentInstance.dirty()).toBe(true);
      await click(btn(rowByText('b'), '.outdent'));
      expect(fixture.componentInstance.dirty()).toBe(false);
    });
  });
});
