import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Landing } from './landing';

describe('Landing', () => {
  function render() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Landing);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('has a sign-in button pointing at /signin', () => {
    const btn = render().querySelector<HTMLAnchorElement>('.signin-btn');
    expect(btn?.getAttribute('href')).toBe('/signin');
  });

  it('renders the six FAQ panels', () => {
    const panels = render().querySelectorAll('mat-expansion-panel');
    expect(panels.length).toBe(6);
    expect(panels[0].textContent).toContain('What is Nabbit?');
  });

  it('renders the feature grid, three steps and a help link', () => {
    const el = render();
    expect(el.querySelectorAll('.feature').length).toBe(5);
    expect(el.querySelectorAll('.step').length).toBe(3);
    expect(el.querySelector('.help-link')?.getAttribute('href')).toBe('/help');
  });
});
