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

- **Your full history, forever.** Daily totals are never deleted, and you can **import your old WakaTime history** in one click.
- **A private dashboard** with projects, languages, editors, activity type, OS, machines, time of day, days of the week and a year heatmap.
- **AI insights.** Time spent with AI agents, the share of lines written by AI vs. you, sessions, prompts, tokens and time per model (Claude Code, Cursor, Copilot, Codex…).
- **Tidy projects.** Rename or merge projects and label them, for example by client.
- **Goals and a weekly report** to Discord or Telegram every Monday.
- **Timesheets** with hourly rates per client, CSV export and printable invoices.
- **README cards, badges and a stats block** for your GitHub profile, plus **a public profile page** you can share or embed on your portfolio.
- **Keep WakaTime too, if you want.** Waqt can pass every heartbeat on to WakaTime (with retries), so your WakaTime account and anything built on it keep working.
- **Privacy by default.** Project names, labels, machine names and file paths are never public unless you say so.
- **Updates arrive by themselves** through a weekly GitHub Action in your copy.
- **₹0 / $0.** No credit card, no subscription. Cloudflare's free plan is plenty for one person.

![AI insights](docs/ai.png)

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

### Keep sending to WakaTime too (optional)

Your editor can only send to one server, so Waqt can forward every heartbeat to WakaTime for you. In Cloudflare open your Worker → **Settings → Variables and Secrets → Add**, choose **Secret**, name it `WAKATIME_API_KEY` and paste your key from [wakatime.com/api-key](https://wakatime.com/api-key).

Waqt sends the heartbeats exactly as your editor sent them (AI fields, dependencies, user agent, machine name and time zone included), in the background, so your editor never waits on WakaTime. If WakaTime is down, batches are queued and retried for up to two weeks. The dashboard's **Setup** tab shows whether forwarding is working and lets you switch it off. To forward to another WakaTime-compatible server (Wakapi, Hackatime…) instead, also add a `WAKATIME_API_URL` variable such as `https://wakapi.dev/api`.

### Import your WakaTime history

With `WAKATIME_API_KEY` set, open **Setup → Import from WakaTime**. Waqt asks WakaTime for an export of all your heartbeats, your browser counts the time (with the same code the server uses) and Waqt stores compact daily totals, including time of day and AI usage. Only days before Waqt's first heartbeat are imported, so nothing is counted twice. Importing again replaces the previous import, and **Remove imported data** undoes it. You can also upload an export file you downloaded from WakaTime yourself.

## Add stats to your GitHub README

Turn on **Public profile** in Settings (it's on by default), then use the **Share** tab to build a card, or write the URL yourself:

| Card | Example |
| --- | --- |
| Top languages | <img src="docs/languages.svg" width="300" alt="Top languages card"> |
| Coding stats | <img src="docs/stats.svg" width="340" alt="Coding stats card"> |
| Time of day | <img src="docs/hours.svg" width="360" alt="Time of day card"> |
| AI coding | <img src="docs/ai.svg" width="360" alt="AI coding card"> |
| Badge | <img src="docs/badge.svg" alt="Coding time badge"> |

![Activity heatmap card](docs/heatmap.svg)

```md
![Top languages](https://waqt.<you>.workers.dev/card/languages.svg?range=last_30_days)
![Coding stats](https://waqt.<you>.workers.dev/card/stats.svg)
![Activity](https://waqt.<you>.workers.dev/card/heatmap.svg)
![When I code](https://waqt.<you>.workers.dev/card/hours.svg?range=last_30_days)
![AI coding](https://waqt.<you>.workers.dev/card/ai.svg?range=last_30_days)
![Coding time](https://waqt.<you>.workers.dev/badge/last_7_days.svg)
```

**Cards:** `languages`, `editors`, `os`, `categories`, `projects` (only if project names are public), `stats`, `heatmap`, `hours`, `ai`.

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

### A stats block in your profile README

Like the WakaTime README bots, but from Waqt: languages, editors, projects, OS, time of day (Night Owl or Early Bird), most productive weekday, AI use and your streak, as a text block.

1. Add these two lines to your profile README where the block should go:
   ```md
   <!--START_SECTION:waqt-->
   <!--END_SECTION:waqt-->
   ```
2. Optional: add your Waqt key as a repository secret named `WAQT_API_KEY` to include private data such as project names.
3. Save this as `.github/workflows/waqt.yml` in that repository:
   ```yaml
   name: Waqt stats
   on:
     schedule:
       - cron: '17 */6 * * *'
     workflow_dispatch:
   permissions:
     contents: write
   jobs:
     update:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: mohdrafey1/waqt/readme-action@main
           with:
             url: https://waqt.<you>.workers.dev
             api_key: ${{ secrets.WAQT_API_KEY }}
             range: last_7_days
   ```

Options: `range`, `sections` (`summary,languages,editors,projects,os,categories,hours,weekdays,ai,streak`), `readme`, `section_name`, `commit_message`. It only commits when your stats changed. The raw markdown is at `/api/v1/users/<user>/readme.md`.

## Embed on your website

The public profile lives at `https://waqt.<you>.workers.dev/profile/`. To embed it:

```html
<iframe
  src="https://waqt.<you>.workers.dev/profile/?embed=1&range=last_30_days&sections=stats,heatmap,languages"
  width="100%" height="560" style="border:0" loading="lazy" title="My coding activity"></iframe>
```

Options: `range` (`last_7_days`, `last_30_days`, `last_year`, `all_time`), `theme` (`auto`, `dark`, `light`), `sections` (`stats`, `heatmap`, `daily`, `hours`, `ai`, `languages`, `editors`, `categories`, `os`, `projects`). The SVG cards above also work as plain `<img>` tags on any site, and every public JSON endpoint sends CORS headers so you can build your own widget.

## Goals, weekly reports and timesheets

- **Goals:** set a daily and/or weekly goal in **Settings**. Progress bars show on the Overview.
- **Weekly report:** add a Discord webhook (Server settings → Integrations → Webhooks) and/or a Telegram bot (create one with @BotFather, get your chat ID from @userinfobot). Every Monday from 9:00 your time you get last week's total vs. the week before, goal hits, best day, top languages, projects and labels, AI use and your streak. **Send a test report** tries it right away.
- **Projects tab:** rename projects, merge several into one by giving them the same name, label them (e.g. by client) and hide them from public views.
- **Timesheets tab:** pick a period, group by label or project, round each day up to 6/15/30/60 minutes, set an hourly rate per label and a currency, then **Export CSV** or **Print invoice** (Save as PDF works too).

## Staying up to date

The Deploy button makes a copy of Waqt in your GitHub account (not a fork), so updates can't arrive by themselves. Your copy includes `.github/workflows/waqt-update.yml`, which once a week pulls the latest Waqt, keeps your own Worker name, database, routes and variables, and opens an **Update Waqt** pull request. Merge it and Cloudflare redeploys; database changes are applied during the deploy.

- To apply updates automatically instead, add the repository variable `WAQT_UPDATE_MODE` = `direct` (Settings → Secrets and variables → Actions → Variables).
- If GitHub doesn't allow the workflow to open pull requests, the run summary links to the ready-made branch, or allow it in Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".
- You can run it any time from the **Actions** tab.

## Works with WakaTime tools

Waqt implements the parts of the WakaTime API that editors and popular tools use:

| Endpoint | Used by |
| --- | --- |
| `POST /api/v1/users/current/heartbeats.bulk` | every editor plugin (via wakatime-cli) |
| `GET /api/v1/users/current/statusbar/today` | the "today" time in your status bar |
| `GET /api/v1/users/:user/stats/:range` | [github-readme-stats](https://github.com/anuraghazra/github-readme-stats), dashboards |
| `GET /api/v1/users/current/summaries` | scripts and integrations |
| `GET /api/v1/users/:user/all_time_since_today` | profile widgets |
| `GET /api/v1/users/:user/readme.md` | the README stats block |

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
| D1 rows written | 100,000 / day | ~3,000 (a one-time import of a few years: ~50,000) |
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
| `src/routes/api.ts` | WakaTime-compatible API, settings, timesheet and reports |
| `src/routes/importer.ts` | WakaTime history import |
| `src/routes/cards.ts` | SVG cards and badges |
| `src/ingest.ts` | validates and stores heartbeats |
| `public/lib/core.js` | how time is counted (shared by the Worker and the browser) |
| `src/summaries.ts` | turns heartbeats into daily totals, pruning |
| `src/stats.ts` | stats queries and the public cache |
| `src/forward.ts` | optional forwarding to WakaTime, with a retry queue |
| `src/report.ts` | weekly report to Discord / Telegram |
| `src/readme.ts`, `readme-action/` | the profile README stats block and its GitHub Action |
| `public/` | dashboard and profile page (plain HTML/JS, no build step) |
| `migrations/` | D1 schema |
| `test/` | tests that run inside the Workers runtime |

## Run it locally

```bash
git clone https://github.com/<you>/waqt && cd waqt
npm install
cp .dev.vars.example .dev.vars   # then put a UUID v4 in it
npm run dev                      # http://localhost:8787
```

Point a local `~/.wakatime.cfg` at `http://localhost:8787/api/v1` to test with a real editor.

```bash
npm test          # 38 tests in the Workers runtime (Vitest + @cloudflare/vitest-plugin)
npm run typecheck
```

## Deploy with the CLI instead

```bash
npm install
npx wrangler d1 create waqt          # copy the database_id into wrangler.json
npx wrangler secret put API_KEY      # paste your UUID v4
npm run deploy                       # applies migrations, then deploys
```

## FAQ

**Does any data go to WakaTime?** No. The plugins only talk to the `api_url` you set.

**Can I import my old WakaTime history?** Yes: Setup → Import from WakaTime (needs the `WAKATIME_API_KEY` secret).

**Is it multi-user?** No. One instance per person keeps it simple and inside the free plan. Anyone can deploy their own with the button above.

**I lost my key.** Set a new one in the Cloudflare dashboard → Workers → waqt → Settings → Variables and Secrets, then update `~/.wakatime.cfg`.

## License

[MIT](LICENSE). Not affiliated with WakaTime. "WakaTime" is a trademark of its owner. Waqt only uses its open-source, BSD-licensed editor plugins as clients.
