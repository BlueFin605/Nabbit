# Instagram caption spike (NAB-87)

Checks whether Instagram posts can be read anonymously from AWS. Not part of any build.

1. Open AWS CloudShell. Upload `spike-instagram.mjs` and a `urls.txt` with 8-10 saved Instagram post URLs, one per line.
2. Run `node spike-instagram.mjs urls.txt` (Node 24; it makes plain, cookie-free requests, about 1.5 s apart).
3. Paste the whole output back (per-URL rows, `usable N of M`, the `GO` / `NO-GO` verdict, and the caption previews).
