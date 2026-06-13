# Swarm Defense

A single-page, vanilla-JavaScript canvas tower-defense game. No build step, no bundler, no framework — just plain `<script>` files in `js/` and a sprite sheet in `assets/`.

## Play

**Live:** https://walkandre.github.io/swarm-defense/

## Run locally

Any static file server works. Two convenience options:

```bash
npm start      # serves on http://localhost:8000 (uses python3)
npm run serve  # serves via `npx serve`
```

Or just open `index.html` directly in a browser.

## Deploy

The site is served by **GitHub Pages from the `main` branch root**. To publish changes, just push:

```bash
git push
```

Pages redeploys automatically within a minute or so. No build is required because the game is pure static files.
