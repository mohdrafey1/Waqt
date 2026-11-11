#!/usr/bin/env node
// Back up or restore a Waqt instance from the command line (Node 18+).
//
//   WAQT_URL=https://waqt.example.com WAQT_API_KEY=... node scripts/backup.mjs backup [file.json.gz]
//   WAQT_URL=https://waqt.example.com WAQT_API_KEY=... node scripts/backup.mjs restore file.json.gz
//
// Used by .github/workflows/waqt-backup.yml for the weekly backup.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createBackup, restoreBackup } from '../public/lib/backup.js';

const [cmd, file] = process.argv.slice(2);
const base = (process.env.WAQT_URL || '').replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
const key = (process.env.WAQT_API_KEY || '').trim();

if (!['backup', 'restore'].includes(cmd) || (cmd === 'restore' && !file)) {
  console.error('Usage: node scripts/backup.mjs backup [file.json.gz] | restore <file.json.gz|file.json>');
  process.exit(2);
}
if (!base || !key) {
  console.error('Set WAQT_URL (your Waqt address) and WAQT_API_KEY (your key).');
  process.exit(2);
}

async function api(path, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${base}/api/v1${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    throw new Error(`${path}: ${body.error || res.status + ' ' + res.statusText}`);
  }
}

let last = '';
const status = (msg) => {
  if (msg !== last) console.log(msg);
  last = msg;
};

if (cmd === 'backup') {
  const backup = await createBackup(api, status);
  const out = file || `waqt-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
  const json = JSON.stringify(backup);
  writeFileSync(out, out.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json);
  const rows = Object.values(backup.tables).reduce((a, t) => a + t.rows.length, 0);
  console.log(`Saved ${out}: ${rows} rows, ${backup.first_day || '—'} to ${backup.last_day || '—'}.`);
} else {
  const raw = readFileSync(file);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const r = await restoreBackup(api, JSON.parse(text), status);
  console.log(`Restored ${r.days} days (${r.rows} rows), ${r.first || '—'} to ${r.last || '—'}.`);
}
