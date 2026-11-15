import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Help } from './help';
import { renderHelpMarkdown } from './help-markdown';

const INDEX = [{ slug: 'getting-started', title: 'Getting started', file: '01-getting-started.md' }];

function mount(topic?: string) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Help);
  if (topic) fixture.componentRef.setInput('topic', topic);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  return { fixture, http, el: fixture.nativeElement as HTMLElement };
}

describe('Help viewer', () => {
  it('lists topics at /help', () => {
    const { fixture, http, el } = mount();
    http.expectOne('assets/help-index.json').flush(INDEX);
    fixture.detectChanges();
    const link = el.querySelector('ul.topics a')!;
    expect(link.textContent).toContain('Getting started');
    expect(link.getAttribute('href')).toBe('/help/getting-started');
  });

  it('renders the markdown of the selected topic', () => {
    const { fixture, http, el } = mount('getting-started');
    http.expectOne('assets/help-index.json').flush(INDEX);
    fixture.detectChanges();
    http.expectOne('assets/help/01-getting-started.md').flush('# Hello\n\nSome **bold** text <script>x</script>');
    fixture.detectChanges();
    expect(el.querySelector('article h1')!.textContent).toBe('Hello');
    expect(el.querySelector('article strong')!.textContent).toBe('bold');
    expect(el.querySelector('article script')).toBeNull();
  });

  it('shows an error when the index cannot load', () => {
    const { fixture, http, el } = mount();
    http.expectOne('assets/help-index.json').flush('', { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();
    expect(el.textContent).toContain('Help could not be loaded');
  });
});

describe('renderHelpMarkdown', () => {
  it('links guides to /help/:slug and external links out', () => {
    const html = renderHelpMarkdown('[a](02-installing.md) [b](https://example.com)');
    expect(html).toContain('href="/help/installing"');
    expect(html).toContain('target="_blank"');
  });
});

describe('help routes', () => {
  it('are behind authGuard so unauthenticated visitors are sent to sign-in', async () => {
    const { routes } = await import('../../app.routes');
    const { authGuard } = await import('../../core/auth/auth-guard');
    for (const p of ['help', 'help/:topic']) {
      expect(routes.find((r) => r.path === p)!.canActivate).toEqual([authGuard]);
    }
  });
});
