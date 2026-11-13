import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flattenSteps, MAX_STEP_DEPTH, stepDepth } from '@nabbit/recipe-core';
import { extractStructured } from '../src/import/extract-structured.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const URL_ = 'https://blog.example/recipes/x';

describe('extractStructured', () => {
  it('maps a plain JSON-LD recipe', () => {
    const d = extractStructured(fx('jsonld-plain.html'), URL_)!;
    expect(d.confidence).toBe('structured');
    expect(d.recipe.title).toBe('Fluffy Pancakes');
    expect(d.recipe.sourceUrl).toBe(URL_);
    expect(d.recipe.servings).toBe(4);
    expect(d.recipe.ingredients).toHaveLength(4);
    expect(d.recipe.ingredients[0]).toMatchObject({ quantity: 1.5, unit: 'cup' });
    expect(d.recipe.ingredients[0].metric).toBeDefined();
    expect(d.recipe.steps).toEqual(['Mix the dry ingredients.', 'Whisk in the milk and egg.', 'Cook on a 180°C griddle.']);
    expect(d.recipe.tags).toEqual(['breakfast', 'pancakes', 'easy', 'brunch']);
    expect(d.imageUrl).toBe('https://blog.example/img/pancakes.jpg');
    expect(d.recipe).not.toHaveProperty('imageKey');
  });

  it('finds a recipe inside @graph, handles ImageObject arrays, mixed steps and yield arrays', () => {
    const d = extractStructured(fx('jsonld-graph.html'), URL_)!;
    expect(d.recipe.title).toBe('Tomato Soup');
    expect(d.recipe.servings).toBe(6);
    expect(d.recipe.steps).toEqual(['Sweat the onion.', 'Add tomatoes and stock.', 'Blend until smooth.']);
    expect(d.imageUrl).toBe('https://cdn.example/soup-1.jpg');
    expect(d.recipe.tags).toEqual(['soup', 'vegetarian']);
  });

  it('keeps HowToSection as groups in order and accepts numeric yield', () => {
    const d = extractStructured(fx('jsonld-howtosection.html'), URL_)!;
    expect(d.recipe.servings).toBe(8);
    expect(d.recipe.steps).toEqual([
      { heading: 'Cake', steps: ['Cream butter & sugar.', 'Bake at 180°C for 30 minutes.'] },
      { heading: 'Frosting', steps: ['Whip the frosting.'] },
      'Assemble.',
    ]);
  });

  it('accepts array-typed @type inside a top-level array', () => {
    const d = extractStructured(fx('jsonld-array-type.html'), URL_)!;
    expect(d.recipe.title).toBe('Banana Bread');
    expect(d.recipe.servings).toBe(1);
    expect(d.imageUrl).toBe('https://img.example/banana.jpg');
    expect(d.recipe.steps).toEqual(['Mash bananas.', 'Bake.']);
  });

  it('falls back to microdata', () => {
    const d = extractStructured(fx('microdata-only.html'), URL_)!;
    expect(d.confidence).toBe('structured');
    expect(d.recipe.title).toBe("Grandma's Scones");
    expect(d.recipe.servings).toBe(12);
    expect(d.recipe.ingredients.map((i) => i.original)).toEqual([
      '2 cups self-raising flour',
      '1/2 cup cream',
      '1 pinch salt',
    ]);
    expect(d.recipe.steps).toEqual(['Rub in the butter.', 'Bake at 220°C for 12 minutes.']);
    expect(d.imageUrl).toBe('https://blog.example/photos/scones.jpg');
    expect(d.recipe.tags).toEqual(['baking', 'afternoon tea']);
  });

  it('skips a leading Organization block', () => {
    const d = extractStructured(fx('two-blocks-org-first.html'), URL_)!;
    expect(d.recipe.title).toBe('Omelette');
    expect(d.recipe.steps).toEqual(['Beat eggs. Cook in butter.']);
    expect(d.recipe.servings).toBe(4);
  });

  it('skips a broken JSON block', () => {
    expect(extractStructured(fx('broken-then-valid.html'), URL_)!.recipe.title).toBe('Good Rice');
  });

  it('returns undefined when there is no recipe', () => {
    expect(extractStructured(fx('no-recipe.html'), URL_)).toBeUndefined();
    expect(extractStructured('', URL_)).toBeUndefined();
  });

  it('strips tags and decodes entities in every text field', () => {
    const d = extractStructured(fx('entities.html'), URL_)!;
    expect(d.recipe.title).toBe('Salt & Pepper Chicken');
    expect(d.recipe.ingredients[0].original).toBe('½ cup flour');
    expect(d.recipe.ingredients[1].original).toBe('2 tbsp soy sauce');
    expect(d.recipe.steps).toEqual(['Coat the chicken & fry.']);
  });

  it('defaults servings to 4 when yield is unparseable', () => {
    const html = `<script type="application/ld+json">{"@type":"Recipe","name":"A","recipeYield":"serves a crowd","recipeIngredient":["1 egg"]}</script>`;
    expect(extractStructured(html, URL_)!.recipe.servings).toBe(4);
  });

  it('caps tags at 10 and limits work on pathological input', () => {
    const kw = Array.from({ length: 30 }, (_, i) => `Tag${i}`).join(',');
    const ings = Array.from({ length: 5000 }, (_, i) => `${i} g thing`);
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Big', keywords: kw, recipeIngredient: ings })}</script>`;
    const d = extractStructured(html, URL_)!;
    expect(d.recipe.tags).toHaveLength(10);
    expect(d.recipe.ingredients.length).toBeLessThanOrEqual(200);

    const json = '{"x":'.repeat(20000) + '{"@type":"Recipe","name":"Deep"}' + '}'.repeat(20000);
    const t0 = Date.now();
    expect(() => extractStructured(`<script type="application/ld+json">${json}</script>`, URL_)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('extractStructured nested steps', () => {
  const ld = (instructions: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Lasagne',
      recipeIngredient: ['1 onion'],
      recipeInstructions: instructions,
    })}</script></head></html>`;
  const step = (text: string) => ({ '@type': 'HowToStep', text });
  const section = (name: string | undefined, items: unknown[]) => ({
    '@type': 'HowToSection',
    ...(name === undefined ? {} : { name }),
    itemListElement: items,
  });

  it('flat HowToStep list stays a flat string array', () => {
    const d = extractStructured(ld([step('A.'), step('B.')]), URL_)!;
    expect(d.recipe.steps).toEqual(['A.', 'B.']);
  });

  it('one HowToSection becomes a group with its name as heading', () => {
    const d = extractStructured(ld([section('Filling', [step('Brown the mince.'), step('Add stock.')]), section('Sauce', [step('Melt butter.')])]), URL_)!;
    expect(d.recipe.steps).toEqual([
      { heading: 'Filling', steps: ['Brown the mince.', 'Add stock.'] },
      { heading: 'Sauce', steps: ['Melt butter.'] },
    ]);
  });

  it('keeps mixed top-level steps and sections in order', () => {
    const d = extractStructured(ld([step('Preheat.'), section('Filling', [step('Brown.')])]), URL_)!;
    expect(d.recipe.steps).toEqual(['Preheat.', { heading: 'Filling', steps: ['Brown.'] }]);
  });

  it('nests sections two deep', () => {
    const d = extractStructured(ld([section('Outer', [step('One.'), section('Inner', [step('Two.')])])]), URL_)!;
    expect(d.recipe.steps).toEqual([{ heading: 'Outer', steps: ['One.', { heading: 'Inner', steps: ['Two.'] }] }]);
  });

  it('a section without a name is a headingless group', () => {
    const d = extractStructured(ld([section(undefined, [step('One.')])]), URL_)!;
    expect(d.recipe.steps).toEqual([{ steps: ['One.'] }]);
  });

  it('an itemListElement object that is not typed HowToSection is still a group', () => {
    const d = extractStructured(ld([{ name: 'Part', itemListElement: [step('One.')] }]), URL_)!;
    expect(d.recipe.steps).toEqual([{ heading: 'Part', steps: ['One.'] }]);
  });

  it('drops empty sections', () => {
    const d = extractStructured(ld([section('Empty', []), step('One.')]), URL_)!;
    expect(d.recipe.steps).toEqual(['One.']);
  });

  it('converts Fahrenheit inside groups', () => {
    const d = extractStructured(ld([section('Bake', [step('Bake at 350°F.'), section('Rest', [step('Rest, then 400 °F.')])])]), URL_)!;
    expect(d.recipe.steps).toEqual([{ heading: 'Bake', steps: ['Bake at 180°C.', { heading: 'Rest', steps: ['Rest, then 200°C.'] }] }]);
  });

  it('flattens groups nested beyond the depth cap so the draft still validates', () => {
    let node: unknown = step('Deep.');
    for (let i = 0; i < 5; i++) node = section(`L${i}`, [node]);
    const d = extractStructured(ld([node]), URL_)!;
    expect(stepDepth(d.recipe.steps)).toBeLessThanOrEqual(MAX_STEP_DEPTH);
    expect(flattenSteps(d.recipe.steps)).toEqual(['Deep.']);
  });

  it('microdata HowToSection becomes a group', () => {
    const html = `<div itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name">Lasagne</h1>
      <span itemprop="recipeIngredient">1 onion</span>
      <div itemprop="recipeInstructions" itemscope itemtype="https://schema.org/HowToSection">
        <h3 itemprop="name">Filling</h3>
        <div itemprop="itemListElement" itemscope itemtype="https://schema.org/HowToStep"><span itemprop="text">Brown the mince.</span></div>
        <div itemprop="itemListElement" itemscope itemtype="https://schema.org/HowToStep"><span itemprop="text">Add stock.</span></div>
      </div></div>`;
    const d = extractStructured(html, URL_)!;
    expect(d.recipe.steps).toEqual([{ heading: 'Filling', steps: ['Brown the mince.', 'Add stock.'] }]);
  });
});
