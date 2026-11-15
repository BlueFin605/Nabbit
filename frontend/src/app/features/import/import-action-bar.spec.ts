import { TestBed } from '@angular/core/testing';
import { ImportActionBar } from './import-action-bar';

describe('ImportActionBar', () => {
  function make(mode: 'preview' | 'edit', saving = false) {
    const fixture = TestBed.createComponent(ImportActionBar);
    fixture.componentRef.setInput('mode', mode);
    fixture.componentRef.setInput('saving', saving);
    fixture.detectChanges();
    return fixture;
  }
  const btn = (f: ReturnType<typeof make>, c: string) => (f.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(c) as HTMLButtonElement;

  it('labels the toggle Edit in preview and Back to preview in edit', () => {
    expect(btn(make('preview'), '.toggle-edit').textContent?.trim()).toBe('Edit');
    expect(btn(make('edit'), '.toggle-edit').textContent?.trim()).toBe('Back to preview');
  });

  it('emits save, edit and discard', () => {
    const f = make('preview');
    const seen: string[] = [];
    f.componentInstance.save.subscribe(() => seen.push('save'));
    f.componentInstance.edit.subscribe(() => seen.push('edit'));
    f.componentInstance.discard.subscribe(() => seen.push('discard'));
    btn(f, '.save').click();
    btn(f, '.toggle-edit').click();
    btn(f, '.discard').click();
    expect(seen).toEqual(['save', 'edit', 'discard']);
  });

  it('disables the buttons while saving', () => {
    const f = make('preview', true);
    expect(btn(f, '.save').disabled).toBe(true);
    expect(btn(f, '.discard').disabled).toBe(true);
  });

  it('disables all three buttons while busy (a re-import is in flight)', () => {
    const f = make('edit');
    f.componentRef.setInput('busy', true);
    f.detectChanges();
    expect(['.save', '.toggle-edit', '.discard'].map((c) => btn(f, c).disabled)).toEqual([true, true, true]);
  });

  it('is a toolbar named by its label', () => {
    const f = make('preview');
    f.componentRef.setInput('label', 'Import actions (top)');
    f.detectChanges();
    const bar = (f.nativeElement as HTMLElement).querySelector('[role="toolbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Import actions (top)');
  });
});
