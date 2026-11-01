# partner-dist — vendored build of eyeoverthink/MyAIPartner
Built 2026-11-01 from the sibling repo (vite build, 'npm run build'), committed here so
`/partner/` serves the REAL MyAIPartner UI out of any fresh clone (no sibling checkout needed).
Rebuild order (INTEGRATION.md): cd sibling MyAIPartner && npm install && npm run build ->
copy dist/* here, OR set CHANDRA_PARTNER_DIST to a sibling MyAIPartner/dist path.
Served by server/static.js: env CHANDRA_PARTNER_DIST > sibling MyAIPartner/dist > this folder > client/dist fallback.
