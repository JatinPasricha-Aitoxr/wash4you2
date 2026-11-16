# SEO changes — branch `seo-fixes`

Pages here are generated: edit `src/data/*.json`, `src/templates/` and `src/build.py`, then `python3 src/build.py` (output in `dist/`, copied to the repo root by CI). Nothing generated was hand-edited. Run `python3 tools/verify-seo.py` after a build — it checks every invariant in the brief and passes on this branch (621 pages, 245 sitemap URLs, 372 noindex location pages).

## Read this first: `.htaccess` is not being honoured on the live site

On 2026-11-16, after an earlier `.htaccess` was deployed, `https://www.wash4you.in/about-us/` still answered **200** (no 301), HTML still returned `cache-control: no-cache` / `x-hcdn-cache-status: DYNAMIC`, and CSS/fonts still returned `max-age=3600`. The responses come from Hostinger's CDN (`server: hcdn`), which answers before the file is read (the file itself is deployed: `/.htaccess` returns 403). **Test the redirects (step 4 below) before relying on them.** This branch *deletes* the old pages the redirects replace, so if the redirects do not fire those URLs will 404. If they do not, use hPanel (Domains → redirects, SSL → force HTTPS, CDN/cache settings) or put Cloudflare in front, and do not merge until the six tests pass.

## What changed, per task

| # | Change | Files |
|---|---|---|
| 1 | `.htaccess`: www→apex, `//` collapse, `index.html`→folder, duplicate-page 301s, cache headers. CSS/JS (versioned `?v=`) get 1 year `immutable`; images and fonts (not versioned by URL) get 30 days — the brief's Task 9.1 fallback. | `.htaccess` |
| 2 | Removed the 10 `/pricing/<area>/` pages (the nav and picker already use `?location=`) and `/best-dryclean-near-me/`; footer link now reads "Best Dry Cleaning in Gurgaon" (the existing footer link to that page was relabelled instead of adding a duplicate). Stale folders `git rm`'d because CI only copies, never deletes. | build.py, landing.json, base.html, admin/server.py, 11 root folders |
| 3 | `..//` hrefs on `/steam-iron/` (two CTAs; root cause was a leading `/` in `steam-iron.json` URLs, fixed in the template so any similar URL is safe). Homepage FAQ H2 → "Frequently asked questions". | page-steam-iron.html, page-home.html |
| 4 | Stopped generating the 15 old `/services/<slug>/` noindex stubs; one 301 each in `.htaccess`; old folders removed. | build.py, .htaccess, 15 root folders |
| 5 | `indexable` flag in `coverage-pages.json` (default true). 372 pages set to `noindex, follow` and left out of the sitemap; canonicals/content/links unchanged. Count matches the brief exactly (372). The generator `tools/gen-coverage-pages.py` now preserves the flag on re-run. **To re-enable a page, set its `"indexable"` to `true` — one line.** | coverage-pages.json, build.py, gen-coverage-pages.py |
| 6 | `Shushant`→`Sushant`: **76 occurrences in 22 source files**. New `src/data/stores.json` (single source of truth; becomes `site.locations`). Sitewide `DryCleaningOrLaundry` node removed; Organization gets `subOrganization` (4 stores) + App Store `sameAs`; each store page gets its own `DryCleaningOrLaundry` (`@id` = page URL + `#store`). Placeholder properties are omitted with a build warning. The old per-store nodes on `/locate-us/` were removed too (only store pages may carry the type). Service nodes that pointed at `/#business` now point at `/#organization`. | stores.json, site.json, base.html, _store_schema.html, 8 templates |
| 7 | New `/laundry-service-vasant-vihar-delhi/` (template `page-store.html`; title 52 chars, description 146). Store block + schema on sushant-lok / sector-49 / sector-7. Store cards (hours, directions, store-page link) on `/locate-us/`; all four addresses on `/contact-us/`; Delhi store callout on `/laundry-service-delhi/`. Footer does not list stores (`show_stores` is false), so no footer link was added. | page-store.html, _store_block.html, page-location.html, page-locate-us.html, page-contact.html, page-coverage-hub.html, build.py |
| 8 | `/sitemap.xml` is now an index → `/sitemaps/{core,services,stores,areas,products,blog}.xml` (14 / 86 / 4 / 84 / 46 / 11 URLs). `lastmod` moves only when a page's rendered content changes (fingerprints in `seo/lastmod.json`, committed by CI). I did not use git dates: CI checks out one commit (`fetch-depth: 1`), which would give every page the same date. Admin page-picker updated to read the child sitemaps. | build.py, seo/lastmod.json, admin/server.py |
| 9 | Every CSS/JS URL already carries `?v=`; images/fonts do not (hence the 30-day cap above). All 12 `@font-face` rules already have `font-display: swap`; only the two above-the-fold fonts are preloaded. 287 `<img>` without dimensions on 51 pages now get real width/height at build time (verified: no rendered-size change on 572 images at 390 and 1280 px). Needs `Pillow` (added to requirements.txt). | build.py, requirements.txt |
| 10 | Real alt text on hero tiles (first pass; the duplicate pass is `aria-hidden` + empty), service-card photos, before photos (existing descriptive `alt_before`) and feature posters. Empty alts: **1,536 → 1,325 of 8,191** images in this build. What is left is intentionally decorative: mascot (846), step photos beside their headings (357), CTA backgrounds (55), blog thumbnails beside their titles. | page-home.html, page-services-list.html, _components.html, _posters.html |
| 11 | Damp-laundry post: new `meta_title` front-matter support. The title shows as "Why Overloaded Washing Machines Leave Clothes Damp" (the site's `fit_title` drops the brand suffix when over 60 chars; with it the title is 61). Description 150 chars. H1 untouched. | build.py, the post |
| 12 | `data-track` hooks added at build time: `whatsapp` (2,522 links), `call` (3,040), `book-pickup` (5,245). | build.py |

## `TODO(owner)` placeholders

All in `src/data/stores.json`, for each of the 4 stores: `openingHours` (format: `[{"days": "Mo-Sa", "opens": "10:00", "closes": "20:00"}]`), `lat`, `lng`, `mapUrl` (Google Maps place URL), `mapEmbedUrl`, `photo`, `google_review_url`. The build prints a warning per store and **omits** the matching schema property / page section (never visible text); the hidden spots are HTML comments marked `TODO(owner)` in `page-store.html`, `_store_block.html`, `page-contact.html`.
**Confirm every address and PIN against Google Business Profile** — in particular the Sector 7 PIN (122001) and the Vasant Vihar address, which came from the brief, not the previous data. Existing Google Maps links are kept as `directions_url`.

## Lists requested

### Task 2 — content on /best-dryclean-near-me/ that is NOT on /best-dryclean-in-gurgaon/ (deleted; owner to decide)
All five FAQs were unique to the near-me page (the two pages share no FAQ questions):
- How much does dry cleaning cost?
- Where is the nearest Wash4You dry cleaner?
- How long does dry cleaning take?
- Is pickup free near me?
- What makes a dry cleaner the best?
Also unique: the "Wash4You Near You" section ("Three Stores in Gurugram. Pickup Wherever You Are." — "The nearest dry cleaner is the one that comes to you…"), the hero line "The Best Dryclean Near You Comes to Your Door", and the CTA "Book the Best Dryclean Near You". Recoverable from git history: `git show main:src/data/landing.json`.

### Task 3 — headings containing "| Wash4You" (h1–h3)
- `/` (fixed → "Frequently asked questions")
- `/services/` — H2 "Frequently Asked Questions | Wash4You" (NOT changed; owner to decide — source: src/templates/page-services-list.html:234)

### Task 4 — pages with noindex + canonical to a different URL (now 301s; old folders deleted)
All 15 old service stubs: /services/{eco-friendly-laundry, accessories-cleaning, steam-ironing, linen-cleaning, shoe-cleaning, sofa-cleaning, toy-cleaning, wet-cleaning, premium-dry-cleaning, bag-cleaning, carpet-cleaning, blanket-quilt-cleaning, mattress-cleaning, curtains-cleaning, leather-cleaning}/ → /services/<slug>-best-premium-drycleaning-service/
Deliberately KEPT: /menu/ (noindex + canonical to the booking app) — it is the target of printed QR codes and forwards to the booking app. /book-pickup/ (noindex, no canonical) also kept as an old-link forwarder. Say so if you want them 301'd too.

### Task 11 — pages whose H1 uses the "Most Trusted / Careful / Convenient…" superlative pattern (not rewritten; owner to rewrite)
/about-us/ · /blog/ · /contact-us/ · /locate-us/ · /pricing/ · /services/ · /steam-iron/ ·
/services/{accessories-cleaning, bag-cleaning, blanket-quilt-cleaning, carpet-cleaning, curtains-cleaning, eco-friendly-laundry, leather-cleaning, linen-cleaning, mattress-cleaning, premium-dry-cleaning, shoe-cleaning, sofa-cleaning}-best-premium-drycleaning-service/
(Also superlative but a different pattern: /packages/ "Best-Value…" and /best-dryclean-in-gurgaon/ "The Best Dryclean in Gurgaon".)
"#1" claim: the homepage stat strip, "Gurgaon's #1 Laundry & Dry Cleaning Brand" (src/templates/page-home.html).

### Task 9 — fonts
All 5 woff2 files are `latin` subsets of three families. **IBM Plex Mono** is used in ~67 CSS rules across 14 files (phone number in the top bar, cart totals, `.mono` labels, eyebrows) and weight 500 in about 25 of them, so I kept both weights. Fraunces italic is the brass-italic keyword style in H1s (`base.css`, `redesign-*.css`). Only Fraunces-normal and Hanken Grotesk (latin) are preloaded.

## Other things you should know

- `/laundry-service-delhi/` and the Delhi coverage pages still say there is no Wash4You counter in Delhi (`coverage_note`, `_honesty_note` in `coverage-pages.json`). That is now wrong because of Vasant Vihar. I did not rewrite it.
- `src/data/site.json` no longer has `locations`; the admin's click-to-edit bindings for footer store names (`site:locations.N.*`) therefore do nothing (the footer's store list is switched off anyway). Edit stores in `stores.json`.
- The `content/` YAML generator (`/build.py`, `dist2`) is not the live generator and was not touched, other than the `Shushant` fix.

## Deployment

1. Merge `seo-fixes` into `main` (CI rebuilds and commits the site) — or deploy this branch, whose last commit is a full rebuilt copy of the site at the repo root.
2. Purge the Hostinger CDN cache.
3. Check Google Search Console isn't blocked by anything new (`robots.txt` is unchanged).
4. Test (all must return the stated result):
   - `https://www.wash4you.in/about-us/` → 301 to `https://wash4you.in/about-us/`
   - `https://wash4you.in/index.html` → 301 to `https://wash4you.in/`
   - `https://wash4you.in//pricing/` → 301 to `https://wash4you.in/pricing/`
   - `https://wash4you.in/pricing/mg-road/` → 301 to `https://wash4you.in/pricing/`
   - `https://wash4you.in/best-dryclean-near-me/` → 301 to `https://wash4you.in/best-dryclean-in-gurgaon/`
   - `https://wash4you.in/services/shoe-cleaning/` → 301 to `…/services/shoe-cleaning-best-premium-drycleaning-service/`
   - a CSS file's response has `cache-control: public, max-age=31536000, immutable`
5. In Google Search Console: submit `https://wash4you.in/sitemap.xml` (and remove the old sitemap entry if it lists URLs directly), and request indexing for the 4 store pages.
