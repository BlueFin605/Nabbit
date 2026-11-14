import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { Ingredient } from '@nabbit/recipe-core';
import { RecipeView, type RecipeViewModel } from './recipe-view';

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
// A draft-shaped recipe: no id, version or timestamps.
const draft = (steps: RecipeViewModel['steps'] = ['Mix', 'Bake'], extra: Partial<RecipeViewModel> = {}): RecipeViewModel => ({
  title: 'Pancakes',
  ingredients: [flour],
  steps,
  ...extra,
});

describe('RecipeView', () => {
  let fixture: ComponentFixture<RecipeView>;
  const el = () => fixture.nativeElement as HTMLElement;

  function setup(recipe: RecipeViewModel, inputs: Record<string, unknown> = {}) {
    fixture = TestBed.createComponent(RecipeView);
    fixture.componentRef.setInput('recipe', recipe);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  }

  it('renders the title and flat steps in order', () => {
    setup(draft());
    expect(el().querySelector('h1')?.textContent).toBe('Pancakes');
    expect(Array.from(el().querySelectorAll('ol.steps > li')).map((l) => l.textContent?.trim())).toEqual(['Mix', 'Bake']);
  });

  it('renders a grouped step as a heading with nested steps', () => {
    setup(draft(['Prep', { heading: 'For the sauce', steps: ['Chop', { heading: 'Inner', steps: ['Stir'] }] }]));
    const group = el().querySelector('ol.steps > li.group') as HTMLElement;
    expect(group.querySelector('h3')?.textContent).toBe('For the sauce');
    expect(group.querySelector(':scope > ol > li')?.textContent?.trim()).toBe('Chop');
    expect(group.querySelector(':scope li.group h3')?.textContent).toBe('Inner');
    expect(group.querySelector(':scope li.group li')?.textContent?.trim()).toBe('Stir');
  });

  it('shows ingredients with metric amounts by default and original amounts on request', () => {
    setup(draft());
    expect(el().querySelector('.ingredients li')?.textContent).toContain('480 ml flour');
    expect(el().querySelector('.ingredients .note')?.textContent).toContain('sifted');
    fixture.componentRef.setInput('mode', 'original');
    fixture.detectChanges();
    expect(el().querySelector('.ingredients li')?.textContent).toContain('2 cup');
  });

  it('shows the photo only when imageUrl is set', () => {
    setup(draft());
    expect(el().querySelector('img.photo')).toBeNull();
    fixture.componentRef.setInput('imageUrl', 'https://example.com/p.jpg');
    fixture.detectChanges();
    expect(el().querySelector('img.photo')?.getAttribute('src')).toBe('https://example.com/p.jpg');
  });

  it('is read-only by default: no shopping-list buttons; shows tags and source', () => {
    setup(draft(['Mix'], { tags: ['breakfast'], sourceUrl: 'https://example.com/p' }));
    expect(el().querySelector('.add-one')).toBeNull();
    expect(el().querySelector('.tags')?.textContent).toContain('breakfast');
    expect(el().querySelector('.source a')?.getAttribute('href')).toBe('https://example.com/p');
  });

  it('offers add-to-list buttons when not read-only and emits the ingredient id', () => {
    setup(draft(), { readOnly: false });
    const emitted: string[] = [];
    fixture.componentInstance.addOne.subscribe((id) => emitted.push(id));
    el().querySelector<HTMLElement>('.add-one')?.click();
    expect(emitted).toEqual(['i1']);
  });
});
