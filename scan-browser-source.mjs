#!/usr/bin/env node
// @ts-check
/**
 * scan-browser-source.mjs — CLI host for login-state job sources.
 *
 *   node scan-browser-source.mjs                    # list available sources
 *   node scan-browser-source.mjs zhaopin            # scan 智联招聘 (uses portals.yml keywords)
 *   node scan-browser-source.mjs zhaopin --keyword java
 *   node scan-browser-source.mjs zhaopin --dry-run  # preview, don't write pipeline
 *   node scan-browser-source.mjs zhaopin --login    # save a logged-in session (once)
 *   node scan-browser-source.mjs zhaopin --debug    # dump page HTML for selector tuning
 *   node scan-browser-source.mjs zhaopin --all      # accepted for parity; no date filter yet
 *   node scan-browser-source.mjs zhaopin --keywords 产品经理,数据产品 --json
 *       # machine-readable scan (used by the web Explorer): --json implies --dry-run
 *       # and prints {source, offers[], errors[]} to stdout only.
 *   node scan-browser-source.mjs zhaopin --keywords 产品经理,数据产品 --jsonl
 *       # STREAMING machine-readable scan: one NDJSON line per keyword as it is
 *       # swept ({keyword, offers[], errors[], done, total}), then a terminal
 *       # {done:true, source, total}. Also implies --dry-run. Preferred by the
 *       # web Explorer so results render incrementally instead of at the end.
 *
 * One file per source lives in browser-sources/*.mjs, default-exporting a
 * BrowserSource instance (see lib/browser-source.mjs). Add a source by dropping
 * a file there — no registry list to edit. These sources are opt-in and never
 * run through `node scan.mjs` (which is zero-auth providers only).
 */

import { readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = path.join(ROOT, 'browser-sources');

/** Load every browser-sources/*.mjs into an id → source Map (alphabetical). */
async function loadSources() {
  const sources = new Map();
  let entries = [];
  try {
    entries = readdirSync(SOURCES_DIR).filter((f) => f.endsWith('.mjs')).sort();
  } catch {
    return sources;
  }
  for (const file of entries) {
    const mod = await import(pathToFileURL(path.join(SOURCES_DIR, file)).href);
    const src = mod.default;
    if (src && src.id && typeof src.run === 'function') sources.set(src.id, src);
  }
  return sources;
}

function printSummary(label, res) {
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`${label} Scan — ${res.date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Keywords searched:  ${res.keywords.length}`);
  console.log(`Filtered by title:  ${res.titleSkipped.length}`);
  console.log(`Filtered location:  ${res.locationSkipped.length}`);
  console.log(`Duplicates:         ${res.dupeSkipped.length}`);
  console.log(`New offers:         ${res.newOffers.length}`);

  if (res.errors.length) {
    console.log(`\nErrors (${res.errors.length}):`);
    for (const e of res.errors) console.log(`  ✗ "${e.keyword}": ${e.error}`);
  }

  if (res.newOffers.length) {
    console.log('\nNew offers:');
    for (const o of res.newOffers) {
      console.log(`  + ${o.company || '—'} | ${o.title} | ${o.location || 'N/A'}`);
    }
    console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const id = positional[0];

  const sources = await loadSources();

  if (!id) {
    if (sources.size === 0) {
      console.log('No login-state sources found in browser-sources/.');
      return;
    }
    console.log('Available login-state sources:\n');
    for (const s of sources.values()) console.log(`  ${s.id}  — ${s.label}`);
    console.log('\nUsage: node scan-browser-source.mjs <id> [--dry-run | --login | --debug | --keyword <k> | --keywords <k1,k2> | --json | --all]');
    return;
  }

  const source = sources.get(id);
  if (!source) {
    console.error(`Unknown source "${id}". Available: ${[...sources.keys()].join(', ') || '(none)'}.`);
    process.exit(1);
  }

  if (flags.has('--login')) {
    await source.login();
    return;
  }

  const kwIdx = args.indexOf('--keyword');
  const keyword = kwIdx !== -1 ? args[kwIdx + 1] : null;
  if (kwIdx !== -1 && (!keyword || keyword.startsWith('--'))) {
    console.error('--keyword requires a value, e.g. --keyword java');
    process.exit(1);
  }

  const kwsIdx = args.indexOf('--keywords');
  const keywordsArg = kwsIdx !== -1 ? args[kwsIdx + 1] : null;
  const keywords = keywordsArg ? keywordsArg.split(',').map((k) => k.trim()).filter(Boolean) : null;

  const jsonl = flags.has('--jsonl');

  const serializeOffer = (o) => ({
    company: o.company || '',
    title: o.title,
    url: o.url,
    location: o.location || '',
    postedAt: o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : '',
    source: o.source || source.id,
  });

  const res = await source.run({
    dryRun: flags.has('--dry-run') || flags.has('--json') || jsonl,
    debug: flags.has('--debug'),
    keyword,
    keywords,
    json: flags.has('--json') || jsonl,
    onKeyword: jsonl
      ? (kw, { offers, errors, done, total }) => {
          console.log(
            JSON.stringify({
              keyword: kw,
              offers: offers.map(serializeOffer),
              errors: errors.map((e) => `${e.keyword}: ${e.error}`),
              done,
              total,
            }),
          );
        }
      : null,
  });

  if (jsonl) {
    console.log(JSON.stringify({ done: true, source: source.id, total: res.newOffers.length }));
    return;
  }

  if (flags.has('--json')) {
    const offers = res.newOffers.map(serializeOffer);
    const errors = res.errors.map((e) => `${e.keyword}: ${e.error}`);
    console.log(JSON.stringify({ source: source.id, offers, errors }));
    return;
  }

  printSummary(source.label, res);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
