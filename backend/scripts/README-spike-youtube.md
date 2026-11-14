# YouTube caption spike (NAB-166)

Checks whether YouTube watch pages and their caption tracks can be read anonymously from AWS. Not part of any build.

1. Open AWS CloudShell (and, if possible, run it from the deployed Lambda too). Upload `spike-youtube.mjs` and a `urls.txt` with 3 or more YouTube URLs, one per line (include `https://youtu.be/yk6tQfArMvw`).
2. Run `node spike-youtube.mjs urls.txt` (Node 24; plain, cookie-free requests with `Accept-Language: en`, about 1.5 s apart).
3. Paste the whole output back (per-URL rows, `usable N of M`, and the `GO` / `NO-GO` verdict).

GO needs the player data present and a caption track of at least 200 characters for at least 2 of 3 URLs.
