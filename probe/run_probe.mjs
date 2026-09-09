// Drives the probe host with real Chrome (H.264 for Daily MP4) against a fixture
// and reports whether the component plays, seeks, crosses session boundaries,
// survives a URL refresh and switches stages. Usage:
//   node run_probe.mjs <fixture> [--refresh] [--stage]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const [fixtureName, ...flags] = process.argv.slice(2);
if (!fixtureName)
  throw new Error('usage: node run_probe.mjs <fixture> [--refresh] [--stage]');
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(here, 'host/fixtures', `${fixtureName}.json`),
    'utf8',
  ),
);
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

const NS = 1e9;
const report = {
  fixture: fixtureName,
  startedAt: new Date().toISOString(),
  checks: [],
  samples: {},
  consoleErrors: [],
};
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

// Ruler math, mirrored from timeline.ts, for computing seek targets.
function stageOf(payload, name) {
  return payload[name];
}
function rulerSegments(tracks) {
  return tracks.camera.length ? tracks.camera : tracks.screen;
}
function spans(tracks) {
  const out = [];
  let total = 0;
  for (const seg of [...rulerSegments(tracks)].sort(
    (a, b) => a.started_at - b.started_at,
  )) {
    if (seg.started_at == null) continue;
    const prev = out[out.length - 1];
    if (prev && seg.started_at <= prev.endNs) {
      if (seg.ended_at > prev.endNs) {
        total += (seg.ended_at - prev.endNs) / NS;
        prev.endNs = seg.ended_at;
      }
      continue;
    }
    out.push({ startNs: seg.started_at, endNs: seg.ended_at, offsetS: total });
    total += (seg.ended_at - seg.started_at) / NS;
  }
  return { spans: out, totalS: total };
}
function wallToRuler(tl, ns) {
  for (const s of tl.spans)
    if (ns >= s.startNs && ns < s.endNs)
      return s.offsetS + (ns - s.startNs) / NS;
  return null;
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('console', (m) => {
  if (m.type() === 'error' && !m.location()?.url?.endsWith('/favicon.ico'))
    report.consoleErrors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) =>
  report.consoleErrors.push('pageerror: ' + e.message.slice(0, 300)),
);

await page.goto(`http://127.0.0.1:5199/?fixture=${fixtureName}`);
await page.waitForFunction(() => window.__probe?.loaded, null, {
  timeout: 30000,
});
await page.waitForSelector('.r41rp-player', { timeout: 60000 });

const snapshot = () =>
  page.evaluate(() => {
    const els = [
      ...document.querySelectorAll('.r41rp-player video, .r41rp-player audio'),
    ].map((el) => ({
      tag: el.tagName.toLowerCase(),
      src: el.currentSrc || el.src,
      currentTime: el.currentTime,
      paused: el.paused,
      readyState: el.readyState,
      error: el.error ? el.error.code : null,
    }));
    const times = window.__probe.times;
    const last = times[times.length - 1];
    const btn = document.querySelector('.r41rp-play');
    const scrub = document.querySelector('.r41rp-scrubber');
    return {
      t: last ? last.seconds : null,
      stage: window.__probe.stage,
      playing: btn ? btn.getAttribute('aria-label') === 'Pause' : null,
      scrub: scrub ? Number(scrub.value) : null,
      totalS: scrub ? Number(scrub.max) : null,
      buffering: !!document.querySelector('.r41rp-spinner'),
      refreshRequests: window.__probe.refreshRequests,
      layout: document.querySelector('.r41rp-stage')?.className,
      els,
    };
  });

function segmentFor(tracks, src) {
  const bare = (u) => u.split('?')[0];
  for (const name of ['camera', 'screen', 'mic', 'bot_mic']) {
    for (const seg of tracks[name])
      if (bare(seg.url) === bare(src)) return { name, seg };
  }
  return null;
}
function spread(tracks, snap) {
  const walls = [];
  for (const el of snap.els) {
    if (!el.src || el.paused) continue;
    const hit = segmentFor(tracks, el.src);
    if (!hit || hit.seg.started_at == null) continue;
    walls.push({
      name: hit.name,
      wall: hit.seg.started_at / NS + el.currentTime,
    });
  }
  if (walls.length < 2) return null;
  const v = walls.map((w) => w.wall);
  return {
    spread: Math.max(...v) - Math.min(...v),
    tracks: walls.map((w) => w.name),
  };
}
async function sample(label, seconds, tracks) {
  const rows = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const s = await snapshot();
    rows.push({
      at: Date.now(),
      t: s.t,
      playing: s.playing,
      scrub: s.scrub,
      buffering: s.buffering,
      spread: spread(tracks, s),
      srcs: s.els.map((e) => (e.src || '').split('?')[0].split('/').pop()),
      // media elements keyed by the track their current file belongs to
      byTrack: Object.fromEntries(
        s.els
          .filter((e) => e.src)
          .map((e) => {
            const hit = segmentFor(tracks, e.src);
            return [
              hit ? hit.name : e.tag,
              (e.src || '').split('?')[0].split('/').pop(),
            ];
          }),
      ),
      paused: s.els.map((e) => e.paused),
      rs: s.els.map((e) => e.readyState),
      err: s.els.map((e) => e.error),
    });
    await page.waitForTimeout(500);
  }
  report.samples[label] = rows;
  return rows;
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

let stageName = fixture.interview?.recording_available
  ? 'interview'
  : 'coding_assessment';
let tracks = stageOf(fixture, stageName).tracks;
let tl = spans(tracks);
const first = await snapshot();
check(
  'player mounted',
  !!first.totalS && first.totalS > 0,
  `totalS=${first.totalS} layout=${first.layout}`,
);
if (tl.totalS > 0)
  check(
    'ruler length matches fixture',
    Math.abs(first.totalS - tl.totalS) < 0.5,
    `ui=${first.totalS?.toFixed(2)} expected=${tl.totalS.toFixed(2)}`,
  );

// ── Play from the start ──────────────────────────────────────────────────────
await page.click('.r41rp-play');
const play = await sample('play', 10, tracks);
const progressed = (play.at(-1).t ?? 0) - (play[0].t ?? 0);
check(
  'playback progresses',
  progressed >= 6,
  `advanced ${progressed.toFixed(2)}s in 10s`,
);
check(
  'still playing after 10s',
  play.at(-1).playing === true,
  `playing=${play.at(-1).playing}`,
);
const spreads = play
  .slice(-8)
  .map((r) => r.spread?.spread)
  .filter((x) => x != null);
if (spreads.length)
  check(
    'tracks stay within 0.5s of each other',
    median(spreads) <= 0.5,
    `median spread ${median(spreads).toFixed(3)}s over ${spreads.length} samples, tracks ${JSON.stringify(play.at(-1).spread?.tracks)}`,
  );
check(
  'no media element errors while playing',
  play.every((r) => r.err.every((e) => e == null)),
  JSON.stringify(play.at(-1).err),
);
await page.screenshot({
  path: path.join(outDir, `${fixtureName}-playing.png`),
});

// ── Seek into the middle ─────────────────────────────────────────────────────
const mid = Math.max(5, Math.floor(first.totalS * 0.4));
await page.evaluate((s) => window.__seek(s), mid);
const seek = await sample('seek', 6, tracks);
const endT = seek.at(-1).t;
check(
  'seek lands near target and keeps playing',
  endT != null &&
    endT >= mid + 2 &&
    endT <= mid + 8 &&
    seek.at(-1).playing === true,
  `target ${mid}, after 6s t=${endT?.toFixed(2)} playing=${seek.at(-1).playing}`,
);

// ── Session boundary, when the clock track has more than one segment ────────
const clockSegs = tracks.mic.length ? tracks.mic : rulerSegments(tracks);
if (clockSegs.length > 1 && tl.spans.length > 1) {
  const firstEnd = wallToRuler(
    tl,
    Math.min(clockSegs[0].ended_at, tl.spans[0].endNs - 1),
  );
  const target = Math.max(0, firstEnd - 4);
  await page.evaluate((s) => window.__seek(s), target);
  const cross = await sample('boundary', 14, tracks);
  const before = cross[0];
  const after = cross.at(-1);
  // The mic re-sources across the boundary whether it drives the clock or follows it.
  const watched = tracks.mic.length
    ? 'mic'
    : rulerSegments(tracks) === tracks.camera
      ? 'camera'
      : 'screen';
  const srcBefore = before.byTrack?.[watched];
  const srcAfter = after.byTrack?.[watched];
  check(
    'clock track advances into the next segment',
    !!srcBefore && !!srcAfter && srcBefore !== srcAfter,
    `${watched} ${srcBefore} -> ${srcAfter}`,
  );
  check(
    'ruler time crosses the boundary and keeps running',
    (after.t ?? 0) > firstEnd + 2 && after.playing === true,
    `boundary ${firstEnd.toFixed(2)} end t ${after.t?.toFixed(2)} playing=${after.playing}`,
  );
  const s2 = cross
    .slice(-6)
    .map((r) => r.spread?.spread)
    .filter((x) => x != null);
  if (s2.length)
    check(
      'tracks in sync after the boundary',
      median(s2) <= 0.5,
      `median spread ${median(s2).toFixed(3)}s`,
    );
  await page.screenshot({
    path: path.join(outDir, `${fixtureName}-after-boundary.png`),
  });
} else {
  console.log('skip  boundary (single segment)');
}

// ── Tail: seek into the last second ─────────────────────────────────────────
await page.evaluate((s) => window.__seek(s), first.totalS - 0.2);
const tail = await sample('tail', 3, tracks);
const tailScrub = tail.at(-1).scrub;
check(
  'tail seek stays at the end instead of wrapping to the start',
  tailScrub != null && tailScrub >= first.totalS - 3,
  `scrub ${tailScrub?.toFixed(2)} of ${first.totalS?.toFixed(2)} playing=${tail.at(-1).playing}`,
);

// ── Refresh: swap to re-fetched URLs at the same position ───────────────────
if (flags.includes('--refresh')) {
  await page.evaluate((s) => window.__seek(s), Math.floor(first.totalS * 0.2));
  await page.waitForTimeout(3000);
  const beforeSwap = await snapshot();
  await page.evaluate(() => window.__swapPayload());
  const refreshed = JSON.parse(
    fs.readFileSync(
      path.join(here, 'host/fixtures', `${fixtureName}.refresh1.json`),
      'utf8',
    ),
  );
  tracks = stageOf(refreshed, stageName).tracks;
  const swap = await sample('refresh', 6, tracks);
  const afterSwap = swap.at(-1);
  const newSrcs = afterSwap.srcs;
  const changed = beforeSwap.els.some(
    (e, i) =>
      e.src &&
      newSrcs[i] &&
      e.src.split('?')[1] !== undefined &&
      !e.src.endsWith(newSrcs[i] + ''),
  );
  const srcNow = await page.evaluate(() =>
    [
      ...document.querySelectorAll('.r41rp-player video, .r41rp-player audio'),
    ].map((e) => e.src),
  );
  const signaturesChanged = srcNow.some(
    (s, i) => s && beforeSwap.els[i].src && s !== beforeSwap.els[i].src,
  );
  check(
    'refresh swaps signed URLs in place',
    signaturesChanged,
    `changed=${signaturesChanged}`,
  );
  check(
    'refresh keeps position and play state',
    Math.abs((swap[0].t ?? 0) - (beforeSwap.t ?? 0)) < 2.5 &&
      afterSwap.playing === true &&
      (afterSwap.t ?? 0) > (beforeSwap.t ?? 0),
    `before ${beforeSwap.t?.toFixed(2)} first-after ${swap[0].t?.toFixed(2)} end ${afterSwap.t?.toFixed(2)} playing=${afterSwap.playing}`,
  );
}

// ── Stage switch, when both stages carry a recording ────────────────────────
if (
  flags.includes('--stage') &&
  fixture.interview?.recording_available &&
  fixture.coding_assessment?.recording_available
) {
  const tBefore = (await snapshot()).t;
  await page.click('role=tab[name="Coding assessment"]');
  await page.waitForSelector('.r41rp-player', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const assessTracks = fixture.coding_assessment.tracks;
  await page.click('.r41rp-play');
  const stage = await sample('stage', 8, assessTracks);
  check(
    'coding assessment stage plays',
    (stage.at(-1).t ?? 0) - (stage[0].t ?? 0) >= 4 &&
      stage.at(-1).stage === 'coding_assessment',
    `advanced ${((stage.at(-1).t ?? 0) - (stage[0].t ?? 0)).toFixed(2)}s stage=${stage.at(-1).stage}`,
  );
  await page.screenshot({
    path: path.join(outDir, `${fixtureName}-assessment.png`),
  });
  await page.click('role=tab[name="Interview"]');
  await page.waitForTimeout(1500);
  const back = await snapshot();
  check(
    'interview position remembered across the switch',
    back.scrub != null && Math.abs(back.scrub - (tBefore ?? 0)) < 3,
    `left at ${tBefore?.toFixed(2)} back at ${back.scrub?.toFixed(2)}`,
  );
}

check(
  'no console errors',
  report.consoleErrors.length === 0,
  report.consoleErrors.slice(0, 3).join(' | '),
);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(
  path.join(outDir, `report-${fixtureName}.json`),
  JSON.stringify(report, null, 1),
);
await browser.close();
const failed = report.checks.filter((c) => !c.ok).length;
console.log(
  `\n${report.checks.length - failed}/${report.checks.length} checks passed for ${fixtureName}`,
);
process.exit(failed ? 1 : 0);
