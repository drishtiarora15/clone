// Syncs new Behance projects into projects.json.
// Runs in GitHub Actions (Node 20, no dependencies).
//
// Strategy
//  1. Discover project links: your Behance profile page, then (fallback) an RSSHub feed.
//  2. For every project id not already in projects.json, open the project page and read
//     its title + cover image (og:title / og:image).
//  3. Add new projects to projects.json. Existing entries are NEVER overwritten, so any
//     edits you make by hand (label, category, featured) are kept.
//
// Manual fallback: run the workflow by hand and paste project URLs into "extra_urls".

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const USER = process.env.BEHANCE_USERNAME || 'drishtiarora8';
const FILE = new URL('../projects.json', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_NEW_PER_RUN = 20;

const LABELS = { ux: 'UI / UX', brand: 'Branding', social: 'Social & ads', graphic: 'Graphic design' };
const RULES = [
  ['brand', /(brand|logo|identity|packaging)/i],
  ['ux', /\b(ux|ui)\b|\bapp\b|website|web design|case study|wireframe|prototype|dashboard|interface/i],
  ['social', /\b(social|instagram|post|ad|ads|advert|advertisement|campaign|email|reel|banner)\b/i],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

const decodeEntities = (s = '') =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Map of project id -> slug for every /gallery/<id>/<slug> link found in `text`. */
export function extractGalleryLinks(text) {
  const t = text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const re = /(?:https?:\/\/(?:www\.)?behance\.net)?\/gallery\/(\d{5,})\/([^"'\\\s<>?#&)]+)/gi;
  const out = new Map();
  for (const m of t.matchAll(re)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

export function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']*)["']`, 'i');
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(a) || html.match(b);
  return m ? decodeEntities(m[1]) : '';
}

export function guessFilter(text) {
  for (const [key, re] of RULES) if (re.test(text)) return key;
  return 'graphic';
}

export function parseProject(html, id, slug) {
  let title = metaContent(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  title = decodeEntities(title).replace(/\s*(?:on|\|)\s*Behance.*$/i, '').trim();
  if (!title) title = safeDecode(slug).replace(/[-_]+/g, ' ').trim();
  const image = metaContent(html, 'og:image');
  const description = metaContent(html, 'og:description');
  const filter = guessFilter(`${title} ${safeDecode(slug)} ${description}`);
  return {
    id: String(id),
    url: `https://www.behance.net/gallery/${id}/${slug}`,
    image,
    alt: `${title} thumbnail`,
    title,
    label: LABELS[filter],
    filter,
    autoAdded: true,
  };
}

/** Insert new projects right after any leading "featured" entries; never touch existing ones. */
export function mergeProjects(existing, additions) {
  const known = new Set(existing.map((p) => String(p.id)));
  const fresh = additions
    .filter((p) => !known.has(String(p.id)))
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (!fresh.length) return { list: existing, added: [] };
  let at = 0;
  while (at < existing.length && existing[at].featured) at++;
  return { list: [...existing.slice(0, at), ...fresh, ...existing.slice(at)], added: fresh };
}

async function main() {
  const data = JSON.parse(await readFile(FILE, 'utf8'));
  const existing = Array.isArray(data.projects) ? data.projects : [];
  const known = new Set(existing.map((p) => String(p.id)));

  // id -> { slug, trusted }   (trusted = you pasted the URL yourself, so skip the owner check)
  const candidates = new Map();

  for (const u of (process.env.EXTRA_URLS || '').split(/[\s,]+/).filter(Boolean)) {
    const hit = [...extractGalleryLinks(u)][0];
    if (hit) candidates.set(hit[0], { slug: hit[1], trusted: true });
    else console.log(`::warning::Not a Behance project URL, skipped: ${u}`);
  }

  const sources = [
    `https://www.behance.net/${USER}`,
    `https://www.behance.net/${USER}/projects`,
    process.env.RSSHUB_URL || `https://rsshub.app/behance/${USER}`,
  ];
  let discovered = 0;
  for (const src of sources) {
    try {
      const links = extractGalleryLinks(await get(src));
      console.log(`Source ${src}: ${links.size} project link(s)`);
      for (const [id, slug] of links) if (!candidates.has(id)) candidates.set(id, { slug, trusted: false });
      discovered += links.size;
      if (links.size) break;
    } catch (err) {
      console.log(`Source ${src} failed: ${err.message}`);
    }
    await sleep(800);
  }

  if (!discovered && !candidates.size) {
    console.log('::warning::Could not read any projects from Behance (it may be blocking the runner). ' +
      'Nothing changed. You can add projects manually: Actions -> Update projects -> Run workflow -> extra_urls.');
    return;
  }

  const additions = [];
  for (const [id, { slug, trusted }] of candidates) {
    if (known.has(id)) continue;
    if (additions.length >= MAX_NEW_PER_RUN) break;
    try {
      const html = await get(`https://www.behance.net/gallery/${id}/${slug}`);
      if (!trusted && !html.toLowerCase().includes(`behance.net/${USER.toLowerCase()}`)) {
        console.log(`Skipping ${id}: does not look like one of ${USER}'s projects`);
        continue;
      }
      const project = parseProject(html, id, slug);
      if (!project.image) { console.log(`::warning::No cover image found for ${id}, skipped`); continue; }
      additions.push(project);
      console.log(`New project: ${project.title} (${project.filter})`);
    } catch (err) {
      console.log(`::warning::Could not read project ${id}: ${err.message}`);
    }
    await sleep(800);
  }

  const { list, added } = mergeProjects(existing, additions);
  if (!added.length) { console.log('No new projects.'); return; }
  await writeFile(FILE, JSON.stringify({ updated: new Date().toISOString(), projects: list }, null, 2) + '\n');
  console.log(`Added ${added.length} project(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
