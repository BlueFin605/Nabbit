import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFromText, htmlToText } from '../src/import/extract-text.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

const HEADED = `Fluffy Pancakes

Serves 6

Ingredients
1 1/2 cups plain flour
- 2 tbsp sugar
• 1 cup milk
2 eggs
pinch of salt

Method
1. Mix the dry ingredients together in a large bowl.
2) Whisk in the milk and eggs until just combined.
Step 3: Cook on a 350°F griddle until golden.
- Serve warm with maple syrup.
`;

const UNHEADED = `Quick Garlic Bread
2 tbsp butter, softened
3 cloves garlic, minced
1 loaf french bread
Salt and pepper to taste
Mix the butter and garlic together in a small bowl until smooth.
Spread over the sliced loaf and bake until the edges are crisp and golden.
`;

const CAPTION = `🍝 One pot creamy pasta you will make on repeat!
🧄 2 cloves garlic
🍅 400g tinned tomatoes
🧀 1/2 cup parmesan
1️⃣ Boil the pasta in the sauce until tender, stirring often.
2️⃣ Stir through the parmesan and serve straight away with extra cheese.
#pasta #OnePot #dinner #pasta
#weeknightdinner`;

describe('extractFromText', () => {
  it('parses a headed recipe with numbered steps', () => {
    const d = extractFromText(HEADED);
    expect(d.confidence).toBe('heuristic');
    expect(d.recipe.title).toBe('Fluffy Pancakes');
    expect(d.recipe.servings).toBe(6);
    expect(d.recipe.ingredients).toHaveLength(5);
    expect(d.recipe.ingredients[0]).toMatchObject({ quantity: 1.5, unit: 'cup' });
    expect(d.recipe.ingredients[0].metric).toBeDefined();
    expect(d.recipe.ingredients[1]).toMatchObject({ quantity: 2, unit: 'tbsp' });
    expect(d.recipe.ingredients[2]).toMatchObject({ quantity: 1, unit: 'cup' });
    expect(d.recipe.steps).toEqual([
      'Mix the dry ingredients together in a large bowl.',
      'Whisk in the milk and eggs until just combined.',
      'Cook on a 180°C griddle until golden.',
      'Serve warm with maple syrup.',
    ]);
  });

  it('handles an unheaded block of ingredient lines then sentences', () => {
    const d = extractFromText(UNHEADED);
    expect(d.recipe.title).toBe('Quick Garlic Bread');
    expect(d.recipe.ingredients).toHaveLength(4);
    expect(d.recipe.ingredients[0]).toMatchObject({ quantity: 2, unit: 'tbsp' });
    expect(d.recipe.steps).toHaveLength(2);
    expect(d.recipe.steps[0]).toMatch(/^Mix the butter/);
    expect(d.recipe.servings).toBe(4);
  });

  it('handles captions with emoji bullets and hashtags', () => {
    const d = extractFromText(CAPTION);
    expect(d.recipe.title).toBe('One pot creamy pasta you will make on repeat!');
    expect(d.recipe.ingredients).toHaveLength(3);
    expect(d.recipe.ingredients[1]).toMatchObject({ quantity: 400, unit: 'g' });
    expect(d.recipe.steps).toHaveLength(2);
    expect(d.recipe.steps[0]).toMatch(/^Boil the pasta/);
    expect(d.recipe.tags).toEqual(['pasta', 'onepot', 'dinner', 'weeknightdinner']);
    expect(JSON.stringify(d.recipe.steps)).not.toContain('#');
  });

  it('detects servings in several phrasings', () => {
    expect(extractFromText('Soup\nServes 6\n1 onion').recipe.servings).toBe(6);
    expect(extractFromText('Cookies\nMakes 24 cookies\n1 cup sugar').recipe.servings).toBe(24);
    expect(extractFromText('Stew\n8 servings\n1 kg beef').recipe.servings).toBe(8);
    expect(extractFromText('Stew\n1 kg beef').recipe.servings).toBe(4);
  });

  it('does not treat a servings line as an ingredient', () => {
    const d = extractFromText('Stew\n8 servings\n1 kg beef');
    expect(d.recipe.ingredients).toHaveLength(1);
  });

  it('uses titleHint and sourceUrl, keeping the first line as content', () => {
    const d = extractFromText('2 cups flour\n1 cup sugar', { titleHint: 'Cake', sourceUrl: 'https://x.example/cake' });
    expect(d.recipe.title).toBe('Cake');
    expect(d.recipe.sourceUrl).toBe('https://x.example/cake');
    expect(d.recipe.ingredients).toHaveLength(2);
  });

  it('does not use an ingredient line as the title', () => {
    const d = extractFromText('2 cups flour\n1 cup sugar');
    expect(d.recipe.title).toBe('');
    expect(d.recipe.ingredients).toHaveLength(2);
  });

  it('supports alternative headings, markdown decoration and CRLF', () => {
    const d = extractFromText('Pie\r\n\r\n## What you need:\r\n**1 cup** apples\r\n\r\n**Directions**\r\nBake it for 40 minutes at 400°F.\r\n');
    expect(d.recipe.ingredients).toHaveLength(1);
    expect(d.recipe.steps).toHaveLength(1);
    expect(d.recipe.steps[0]).not.toContain('°F');
  });

  it('returns an empty draft for empty or junk input and never throws', () => {
    for (const input of ['', '   \n\n  ', undefined as unknown as string, null as unknown as string, 42 as unknown as string]) {
      const d = extractFromText(input);
      expect(d.confidence).toBe('heuristic');
      expect(d.recipe).toMatchObject({ title: '', ingredients: [], steps: [], tags: [], servings: 4 });
    }
  });

  it('ignores an invalid sourceUrl', () => {
    const d = extractFromText('Pie', { sourceUrl: 'javascript:alert(1)' });
    expect(d.recipe.sourceUrl).toBeUndefined();
  });

  it('bounds work on hostile input', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `${i + 1} cup thing ${i}`).join('\n');
    const tags = Array.from({ length: 5000 }, (_, i) => `#t${i}`).join(' ');
    const t0 = Date.now();
    const d = extractFromText(`${big}\n${'x'.repeat(2_000_000)}\n${tags}`);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(d.recipe.ingredients.length).toBeLessThanOrEqual(200);
    expect(d.recipe.steps.length).toBeLessThanOrEqual(200);
    expect(d.recipe.tags.length).toBeLessThanOrEqual(10);
    expect(d.recipe.title.length).toBeLessThanOrEqual(120);
  });
});

describe('htmlToText', () => {
  it('strips script, style, nav, header, footer, aside and noscript but keeps block breaks', () => {
    const t = htmlToText(fx('plain-page.html'));
    expect(t).not.toMatch(/dataLayer|hero|Home|banner|newsletter|Copyright|JavaScript/);
    expect(t).toContain("Nana's Scones");
    expect(t.split('\n')).toContain('2 cups self-raising flour');
    expect(t.split('\n')).toContain('Ingredients');
  });

  it('feeds extractFromText to produce a heuristic draft from a plain page', () => {
    const d = extractFromText(htmlToText(fx('plain-page.html')), { sourceUrl: 'https://nana.example/scones' });
    expect(d.confidence).toBe('heuristic');
    expect(d.recipe.title).toBe("Nana's Scones");
    expect(d.recipe.servings).toBe(8);
    expect(d.recipe.ingredients).toHaveLength(4);
    expect(d.recipe.steps).toHaveLength(3);
    expect(d.recipe.steps[0]).toContain('°C');
    expect(d.recipe.steps[0]).not.toContain('°F');
  });

  it('handles empty input, br tags and deep nesting without throwing', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
    expect(() => htmlToText('<div>'.repeat(50_000) + 'deep')).not.toThrow();
  });

  it('caps output size', () => {
    expect(htmlToText('<p>' + 'x'.repeat(3_000_000) + '</p>').length).toBeLessThanOrEqual(500_000);
  });
});
