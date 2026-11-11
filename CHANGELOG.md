# Changelog

Every Waqt release, newest first. Deployed copies pick these up through the
**Update Waqt** workflow (Actions → Update Waqt → Run workflow), and the
dashboard tells you when a new version is out.

## 1.2.1 · 2026-11-11

### Fixed
- Browser extensions and web-view apps (user agents starting with `Mozilla/5.0`) now show as Chrome, Safari, Firefox, Edge, Slack and so on, instead of "AppleWebKit", and imports no longer list "Mozilla" as an AI model.
- AI model names stored before Waqt kept raw user agents are tidied, e.g. "Opus 5-5" becomes "Opus 5.5".
- When WakaTime refuses the `WAKATIME_API_KEY` secret, Waqt now shows WakaTime's own reason, and **Setup → Test the WakaTime key** checks whether the key can sign in and read your history. OAuth access tokens are accepted too (sent as a Bearer token).

## 1.2.0 · 2026-11-11

### New
- **Device keys and a dashboard sign-in.** Give each editor its own key (Setup → Create a key for this device) that can only send activity and read stats, and revoke it any time. The dashboard now signs in with a password or the main key into a secure session cookie, instead of keeping the key in the browser. Settings lists signed-in browsers and can sign out the others.
- **Waqt Wrapped.** `/wrapped/` turns a year of coding into shareable slides, ending with a card you can download as an image, post, or embed (`/card/wrapped.svg?year=2026`).
- **Friends leaderboard.** Compare the last 7 or 30 days with friends who have a public Waqt or WakaTime profile.
- **Files and branches per project.** Click a project in the Projects tab to see its daily time, branches, languages, editors and busiest files.
- **Backups.** Download or restore a backup from Setup, or turn on the weekly *Back up Waqt* workflow, which saves one as a release in your private repository.
- **AI cost estimate.** An editable price table turns token counts into what the same use would cost at API list prices. Private unless you choose to show it.
- **Goal and streak nudges.** Discord or Telegram messages when you reach a daily or weekly goal, or when a streak is about to end; optional goal progress in the editor status bar.
- **Free-plan usage meter.** Setup shows requests, database reads and writes and database size against Cloudflare's free limits, with a warning on the Overview at 70%.
- **Heartbeat inspector.** The latest heartbeats exactly as stored, with the raw user agent, to spot plugin quirks.
- **Version check.** The dashboard shows the running version and when a newer one is out.

### Improved
- Importing from WakaTime no longer misses the days between an older WakaTime export and Waqt's first heartbeat: they are fetched one day at a time.
- The README walks through every field of Cloudflare's setup screen and has an after-deploy checklist.
- The raw user agent of every heartbeat is kept, and old heartbeats are re-read automatically whenever the parser learns something new.
- The update workflow no longer fails when workflow files change upstream; it lists them for you, or applies them with a `WAQT_UPDATE_TOKEN` secret. Its commits and pull requests now name the version.

## 1.1.0 · 2026-11-11

### New
- Import your history from WakaTime (in the browser, nothing counted twice).
- AI insights: agent time, AI vs human lines, sessions, tokens and models.
- Time of day, days of the week and your "Night Owl" or "Early Bird" persona.
- Projects tab to rename, merge, label and hide projects.
- Daily and weekly goals, and a weekly report to Discord or Telegram.
- Timesheets with hourly rates, CSV export and printable invoices.
- A GitHub Action that writes your stats into a profile README.
- A weekly workflow that keeps deployed copies up to date.
- Automated tests and CI.
- Database migrations apply themselves if a deploy skipped them.

### Fixed
- `<<LAST_LANGUAGE>>` from browser and desktop plugins, AI model names shown as editors, and desktop-app editor names.

## 1.0.0 · 2026-11-11

First release: a WakaTime-compatible API on Cloudflare Workers and D1, a private dashboard, a shareable public profile with embed mode, README cards and badges, optional forwarding to WakaTime, and a Deploy to Cloudflare button.
