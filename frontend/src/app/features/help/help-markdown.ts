import { Marked, type Tokens } from 'marked';

const ASSET_ROOT = 'assets/help/';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const isExternal = (href: string) => /^https?:\/\//i.test(href);
const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

function build(): Marked {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // No raw HTML passthrough: it is shown as escaped text.
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      image({ href, text }: Tokens.Image): string {
        const alt = escapeHtml(text);
        if (hasScheme(href) || href.split('/').includes('..')) return `<span class="help-image-missing">${alt}</span>`;
        return `<img class="help-image" src="${escapeHtml(ASSET_ROOT + href.replace(/^\.?\//, ''))}" alt="${alt}" loading="lazy">`;
      },
      link(this: { parser: { parseInline(t: Tokens.Link['tokens']): string } }, { href, tokens }: Tokens.Link): string {
        const inner = this.parser.parseInline(tokens);
        if (isExternal(href)) {
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        }
        const guide = /^(?:\.\/)?(?:\d\d-)?([\w.-]+)\.md$/.exec(href);
        if (guide && !hasScheme(href)) return `<a href="/help/${escapeHtml(guide[1])}">${inner}</a>`;
        // Anything else (repo-relative paths, other schemes) is not navigable in the app.
        return `<span>${inner}</span>`;
      },
    },
  });
  return marked;
}

/** Markdown to an HTML string. Safe to bind as HTML because raw HTML and all attribute values are escaped. */
export function renderHelpMarkdown(markdown: string): string {
  return build().parse(markdown, { async: false });
}
