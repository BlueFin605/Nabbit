import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import type { Ingredient } from '@nabbit/recipe-core';
import { RestoreSizeDialog, compareSizes, type RestoreSizeData } from './restore-size-dialog';

const ing = (id: string, name: string, quantity: number, unit: Ingredient['unit'] = ''): Ingredient => ({
  id,
  original: `${quantity} ${name}`,
  quantity,
  unit,
  name,
  scalable: true,
});
const milk = ing('milk', 'milk', 4, 'l');
const milk6 = ing('milk', 'milk', 6, 'l');
const eggs = ing('eggs', 'eggs', 2);
const salt = ing('salt', 'salt', 1, 'tsp');

describe('compareSizes', () => {
  it('matches by id, flags changed lines, and lists added and removed ingredients', () => {
    const r = compareSizes([milk6, salt], [milk, eggs, salt], 'original');
    expect(r.rows.map((x) => [x.id, x.changed])).toEqual([
      ['milk', true],
      ['salt', false],
    ]);
    expect(r.rows[0].current).toBe('6 l milk');
    expect(r.rows[0].original).toBe('4 l milk');
    expect(r.removedSince.map((x) => x.name)).toEqual(['eggs']);
    expect(r.addedSince).toEqual([]);
  });

  it('lists ingredients present now but not in the original as added since', () => {
    const r = compareSizes([milk, eggs], [milk], 'original');
    expect(r.addedSince.map((x) => x.name)).toEqual(['eggs']);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].changed).toBe(false);
  });
});

describe('RestoreSizeDialog', () => {
  let fixture: ComponentFixture<RestoreSizeDialog>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = (s: string) => el().querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  function setup(data: Partial<RestoreSizeData> = {}) {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MAT_DIALOG_DATA,
          useValue: { currentServings: 6, originalServings: 4, current: [milk6, salt], original: [milk, eggs, salt], mode: 'original', ...data },
        },
      ],
    });
    fixture = TestBed.createComponent(RestoreSizeDialog);
    fixture.detectChanges();
  }

  it('is labelled by a title and warns that changes since the first resize are lost', () => {
    setup();
    const title = el().querySelector('h2');
    expect(title?.textContent).toContain('Restore original size');
    expect(el().textContent).toContain('any changes made since the first resize will be lost');
  });

  it('shows servings current → original', () => {
    setup();
    expect(text('.servings')).toBe('Servings: 6 → 4');
  });

  it('marks changed lines in text, and unchanged lines are not marked', () => {
    setup();
    const rows = Array.from(el().querySelectorAll('.compare li'));
    expect(rows[0].textContent?.replace(/\s+/g, ' ')).toContain('Changed');
    expect(rows[0].textContent?.replace(/\s+/g, ' ')).toContain('6 l milk → 4 l milk');
    expect(rows[1].textContent).not.toContain('Changed');
    expect(rows[1].textContent?.replace(/\s+/g, ' ')).toContain('1 tsp salt → 1 tsp salt');
  });

  it('lists ingredients removed and added since', () => {
    setup({ current: [milk6, salt, ing('oil', 'oil', 1, 'tbsp')] });
    expect(text('.removed')).toContain('eggs');
    expect(text('.removed')).toContain('will come back');
    expect(text('.added')).toContain('oil');
    expect(text('.added')).toContain('will be removed');
  });

  it('omits the added/removed sections when nothing differs structurally', () => {
    setup({ original: [milk, salt] });
    expect(el().querySelector('.removed')).toBeNull();
    expect(el().querySelector('.added')).toBeNull();
  });

  it('renders quantities in the active measurement mode', () => {
    const cup: Ingredient = { ...ing('f', 'flour', 2, 'cup'), metric: { quantity: 480, unit: 'ml' } };
    setup({ mode: 'metric', current: [cup], original: [cup] });
    expect(text('.compare li')).toContain('480 ml flour → 480 ml flour');
  });

  it('has cancel and confirm buttons closing with false and true', () => {
    setup();
    expect(el().querySelector<HTMLButtonElement>('.cancel')).not.toBeNull();
    expect(el().querySelector<HTMLButtonElement>('.confirm')?.textContent).toContain('Restore');
  });
});
