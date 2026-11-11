<div align="center">

<img src="public/favicon.svg" width="64" height="64" alt="Waqt logo">

# Waqt

**A free, self-hosted coding time tracker.**
Works with every WakaTime editor plugin. Runs on Cloudflare's free plan.
Keeps your whole history. Costs nothing.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mohdrafey1/waqt)

</div>

![Waqt dashboard](docs/dashboard.png)

*Waqt* (وقت / वक़्त) means "time" in Urdu and Hindi.

## Why

WakaTime's free plan only keeps 1 week of history. Waqt is a small server you run on your own Cloudflare account. It speaks the same API, so the official WakaTime plugins for 70+ editors send your activity to **your** server instead. You get:

- **Your full history, forever.** Daily totals are never deleted.
- **README cards and badges** for your GitHub profile.
- **A public profile page** you can share or embed on your portfolio with an `<iframe>`.
- **A private dashboard** with projects, languages, editors, activity type, OS, machines and a year heatmap.
- **AI vs. you**: if your plugin reports AI line changes (Cursor, Copilot, Claude Code…), Waqt shows the split.
- **Privacy by default.** Project names, machine names and file paths are never public unless you say so.
- **₹0 / $0.** No credit card, no subscription. Cloudflare's free plan is plenty for one person.

## Deploy in about two minutes

1. **Make a key.** It must be a lowercase UUID v4, because the WakaTime plugins reject anything else. Open your browser console and run:
   ```js
   crypto.randomUUID()
   ```
   or use [uuidgenerator.net/version4](https://www.uuidgenerator.net/version4). Keep it somewhere safe.
2. **Click [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/mohdrafey1/waqt).** Sign in (or sign up free), connect GitHub, and paste your key into the `API_KEY` field. Cloudflare copies this repo to your GitHub, creates the database, and deploys it.
3. **Open your Worker URL** (something like `https://waqt.<you>.workers.dev`) and sign in with your key.

Every push to your copy of the repo redeploys automatically.

## Connect your editors

1. Install the WakaTime plugin for your editor from [wakatime.com/plugins](https://wakatime.com/plugins). You don't need a WakaTime account.
2. Edit `~/.wakatime.cfg` (Windows: `%USERPROFILE%\.wakatime.cfg`):
   ```ini
   [settings]
   api_url = https://waqt.<you>.workers.dev/api/v1
   api_key = <your key>
   ```
3. Restart your editor. After a couple of minutes your status bar shows today's time and the dashboard fills in.

The dashboard's **Setup** tab shows this snippet with your real URL filled in.

## Add stats to your GitHub README

Turn on **Public profile** in Settings (it's on by default), then use the **Share** tab to build a card, or write the URL yourself:

| Card | Example |
| --- | --- |
| Top languages | <img src="docs/languages.svg" width="300" alt="Top languages card"> |
| Coding stats | <img src="docs/stats.svg" width="340" alt="Coding stats card"> |
| Badge | <img src="docs/badge.svg" alt="Coding time badge"> |

![Activity heatmap card](docs/heatmap.svg)

```md
![Top languages](https://waqt.<you>.workers.dev/card/languages.svg?range=last_30_days)
![Coding stats](https://waqt.<you>.workers.dev/card/stats.svg)
![Activity](https://waqt.<you>.workers.dev/card/heatmap.svg)
![Coding time](https://waqt.<you>.workers.dev/badge/last_7_days.svg)
```

**Cards:** `languages`, `editors`, `os`, `categories`, `projects` (only if project names are public), `stats`, `heatmap`.

| Option | Values | Default |
| --- | --- | --- |
| `range` | `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_6_months`, `last_year`, `all_time` | `last_7_days` |
| `theme` | `auto` (follows the viewer's light/dark mode), `light`, `dark`, `transparent` | `auto` |
| `layout` | `list`, `compact` | `list` |
| `count` | 1–12 items | `6` |
| `hide` | comma-separated names, e.g. `json,markdown` | |
| `accent` | hex color without `#`, e.g. `22c55e` | `8b5cf6` |
| `title` | custom title | |
| `width` | 300–600 | per card |
| `hide_border` | `true` | |
| `cache_seconds` | 300–86400 | `1800` |

**Badges:** `/badge/<range>.svg` with optional `label`, `color` (hex) and `style=flat-square`. A [Shields.io endpoint](https://shields.io/badges/endpoint-badge) is at `/badge/<range>.json`.

## Embed on your website

The public profile lives at `https://waqt.<you>.workers.dev/profile/`. To embed it:

```html
<iframe
  src="https://waqt.<you>.workers.dev/profile/?embed=1&range=last_30_days&sections=stats,heatmap,languages"
  width="100%" height="560" style="border:0" loading="lazy" title="My coding activity"></iframe>
```

Options: `range` (`last_7_days`, `last_30_days`, `last_year`, `all_time`), `theme` (`auto`, `dark`, `light`), `sections` (`stats`, `heatmap`, `daily`, `languages`, `editors`, `categories`, `os`, `projects`). The SVG cards above also work as plain `<img>` tags on any site, and every public JSON endpoint sends CORS headers so you can build your own widget.

## Works with WakaTime tools

Waqt implements the parts of the WakaTime API that editors and popular tools use:

| Endpoint | Used by |
| --- | --- |
| `POST /api/v1/users/current/heartbeats.bulk` | every editor plugin (via wakatime-cli) |
| `GET /api/v1/users/current/statusbar/today` | the "today" time in your status bar |
| `GET /api/v1/users/:user/stats/:range` | [github-readme-stats](https://github.com/anuraghazra/github-readme-stats), dashboards |
| `GET /api/v1/users/current/summaries` | scripts and integrations |
| `GET /api/v1/users/:user/all_time_since_today` | profile widgets |

Use `current` with your key for private data. Any other username returns the public view. Examples:

```md
![WakaTime stats](https://github-readme-stats.vercel.app/api/wakatime?username=me&api_domain=waqt.<you>.workers.dev&layout=compact)
```

```yaml
# athul/waka-readme GitHub Action
- uses: athul/waka-readme@master
  with:
    WAKATIME_API_KEY: ${{ secrets.WAQT_API_KEY }}
    API_BASE_URL: https://waqt.<you>.workers.dev/api
```

## Will it stay free?

Yes, for one person. Rough numbers for a heavy coder:

| Cloudflare free plan | Allowance | Waqt's typical use |
| --- | --- | --- |
| Worker requests | 100,000 / day | ~1,000–3,000 |
| D1 rows written | 100,000 / day | ~3,000 |
| D1 rows read | 5,000,000 / day | well under 10% |
| D1 storage | 5 GB (500 MB per database) | ~150 MB per year of raw data |

To stay under the 500 MB limit, raw heartbeats older than **365 days** are deleted by a daily job (change it in Settings, `0` = keep forever). Daily totals per project, language, editor, OS, machine and activity are **kept forever**, so your all-time stats and heatmap never lose history. Public stats are cached for 10 minutes so a busy README doesn't use up your reads.

## How it works

```
editor plugin → wakatime-cli → POST heartbeats → Cloudflare Worker → D1 (SQLite)
                                                        │
                       cron every 15 min: heartbeats → daily summaries
                                                        │
             dashboard · README cards · badges · profile page · WakaTime-style API
```

Time is counted the way WakaTime counts it: each heartbeat gets credit for the gap until the next one, as long as that gap is under the idle timeout (15 minutes by default).

| Path | What's there |
| --- | --- |
| `src/routes/api.ts` | WakaTime-compatible API and settings |
| `src/routes/cards.ts` | SVG cards and badges |
| `src/ingest.ts` | validates and stores heartbeats |
| `src/summaries.ts` | turns heartbeats into daily totals, pruning |
| `src/stats.ts` | stats queries and the public cache |
| `public/` | dashboard and profile page (plain HTML/JS, no build step) |
| `migrations/` | D1 schema |

## Run it locally

```bash
git clone https://github.com/<you>/waqt && cd waqt
npm install
cp .dev.vars.example .dev.vars   # then put a UUID v4 in it
npm run dev                      # http://localhost:8787
```

Point a local `~/.wakatime.cfg` at `http://localhost:8787/api/v1` to test with a real editor.

## Deploy with the CLI instead

```bash
npm install
npx wrangler d1 create waqt          # copy the database_id into wrangler.json
npx wrangler secret put API_KEY      # paste your UUID v4
npm run deploy                       # applies migrations, then deploys
```

## FAQ

**Does any data go to WakaTime?** No. The plugins only talk to the `api_url` you set.

**Can I import my old WakaTime history?** Not yet. It's on the roadmap.

**Is it multi-user?** No. One instance per person keeps it simple and inside the free plan. Anyone can deploy their own with the button above.

**I lost my key.** Set a new one in the Cloudflare dashboard → Workers → waqt → Settings → Variables and Secrets, then update `~/.wakatime.cfg`.

## License

[MIT](LICENSE). Not affiliated with WakaTime. "WakaTime" is a trademark of its owner. Waqt only uses its open-source, BSD-licensed editor plugins as clients.
