import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractImageCandidates,
  MAX_CANDIDATES,
} from "../src/import/extract-images.js";

const fx = (n: string) =>
  readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const P = "https://blog.example/recipes/x";

describe("extractImageCandidates", () => {
  it("puts the structured image first, then og/twitter, then ranked DOM images", () => {
    const out = extractImageCandidates(
      fx("images-dom.html"),
      P,
      "https://blog.example/ld.jpg",
    );
    expect(out).toEqual([
      "https://blog.example/ld.jpg",
      "https://blog.example/media/og.jpg",
      "https://cdn.example/tw.jpg",
      "https://blog.example/img/b.jpg",
      "https://blog.example/img/a.jpg",
      "https://blog.example/img/c.jpg",
    ]);
  });

  it("works without a structured image", () => {
    const out = extractImageCandidates(fx("images-dom.html"), P);
    expect(out[0]).toBe("https://blog.example/media/og.jpg");
  });

  it("drops http, data and unparseable urls, including a structured http image", () => {
    const html =
      '<meta property="og:image" content="http://a.example/x.jpg"><img src="data:image/png;base64,AA"><img src="https://ok.example/y.jpg">';
    expect(extractImageCandidates(html, P, "http://a.example/z.jpg")).toEqual([
      "https://ok.example/y.jpg",
    ]);
    expect(
      extractImageCandidates(
        '<meta property="og:image" content="http://[bad">',
        P,
        "https://[bad",
      ),
    ).toEqual([]);
  });

  it("excludes icon-like names and tiny images", () => {
    const out = extractImageCandidates(fx("images-dom.html"), P);
    expect(out.some((u) => /logo|sprite|small/.test(u))).toBe(false);
  });

  it("de-duplicates and caps at 6", () => {
    const out = extractImageCandidates(fx("images-many.html"), P);
    expect(out).toHaveLength(MAX_CANDIDATES);
    expect(new Set(out).size).toBe(out.length);
    expect(out[0]).toBe("https://blog.example/i/1.jpg");
  });

  it("returns [] for empty html", () => {
    expect(extractImageCandidates("", P)).toEqual([]);
  });

  it("stays within budget on hostile markup", () => {
    const imgs = '<img src="/h/1.jpg" width="200" height="200">'.repeat(
      100_000,
    );
    const deep =
      "<div>".repeat(50_000) +
      '<img src="/deep.jpg">' +
      "</div>".repeat(50_000);
    const start = Date.now();
    const a = extractImageCandidates(imgs, P);
    const b = extractImageCandidates(deep, P);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(a.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(b.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });
});
