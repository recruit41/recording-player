import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMediaShim, type MediaShim } from './test/mediaShim';
import type { TrackSegment, TrackSources } from './timeline';
import { TrackPlayer } from './TrackPlayer';

const S = 1e9;

// Absolute URLs matter: `prepareEl` compares `el.src` (always absolute) against
// the segment url, and a relative url would look like a new source every seek.
function seg(url: string, startS: number, endS: number): TrackSegment {
  return {
    url: `http://media.test/${url}`,
    started_at: startS * S,
    ended_at: endS * S,
  };
}

function sources(partial: Partial<TrackSources>): TrackSources {
  return { camera: [], screen: [], mic: [], bot_mic: [], ...partial };
}

// One 60s session with the ordinary skew: the mic and bot open 2s before the
// camera and close half a second before it. The mic drives the clock.
const SKEWED = sources({
  camera: [seg('cam.webm', 2, 62)],
  mic: [seg('mic.webm', 0, 61.5)],
  bot_mic: [seg('bot.webm', 0, 61.5)],
});

let shim: MediaShim;

beforeAll(() => {
  shim = installMediaShim();
});

beforeEach(() => {
  shim.reset();
  shim.setDuration(60);
});

const els = () => ({
  screen: document.querySelectorAll('video')[0] as HTMLVideoElement,
  camera: document.querySelectorAll('video')[1] as HTMLVideoElement,
  mic: document.querySelectorAll('audio')[0] as HTMLAudioElement,
  bot: document.querySelectorAll('audio')[1] as HTMLAudioElement,
});

const scrubber = () =>
  document.querySelector('input[type="range"]') as HTMLInputElement;

async function mount(
  media: TrackSources = SKEWED,
  props: Partial<ComponentProps<typeof TrackPlayer>> = {},
) {
  const view = render(<TrackPlayer media={media} {...props} />);
  // let the mount-time seek settle, then count from a clean slate
  await act(async () => {});
  shim.reset();
  return view;
}

async function scrubTo(value: string) {
  const el = scrubber();
  await act(async () => {
    fireEvent.pointerDown(el);
    fireEvent.change(el, { target: { value } });
    fireEvent.pointerUp(el, { target: { value } });
  });
}

describe('seek behaviour', () => {
  it('keeps playing after a timeline scrub', async () => {
    await mount();

    await scrubTo('30');

    // camera + mic + bot resume; a seek must never park the player
    expect(shim.counters.playCalls).toBe(3);
  });

  it('keeps playing after skip backward and skip forward', async () => {
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Skip backward 10 seconds'));
    });
    expect(shim.counters.playCalls).toBe(3);

    shim.reset();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Skip forward 10 seconds'));
    });
    expect(shim.counters.playCalls).toBe(3);
  });

  it('seeks once on scrub release, not on every drag step', async () => {
    await mount();
    const el = scrubber();

    await act(async () => {
      fireEvent.pointerDown(el);
      for (const v of ['10', '15', '20', '25', '30']) {
        fireEvent.change(el, { target: { value: v } });
      }
    });
    expect(shim.counters.seekWrites).toBe(0);

    await act(async () => {
      fireEvent.pointerUp(el, { target: { value: '30' } });
    });
    // one write per element that has a segment at 30s
    expect(shim.counters.seekWrites).toBe(3);
  });

  it('resumes from pause without re-seeking', async () => {
    await mount();
    await scrubTo('30');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Pause'));
    });

    shim.reset();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Play'));
    });

    expect(shim.counters.playCalls).toBe(3);
    // The elements never moved, so resuming must not re-seek them.
    expect(shim.counters.seekWrites).toBe(0);
  });

  it('pulls a seek into the mic teardown tail back to covered time', async () => {
    await mount();
    shim.setDuration(62, els().mic);

    // The mic covers ruler time up to 59.5s; the camera runs to 60s.
    await scrubTo('59.8');

    expect(Number(scrubber().value)).toBeCloseTo(59.45, 6);
    expect(els().mic.currentTime).toBeCloseTo(61.45, 6);
  });
});

describe('clock and followers', () => {
  it('reads global time from the mic and corrects the camera toward it', async () => {
    const onTimeUpdate = vi.fn();
    await mount(SKEWED, { onTimeUpdate });
    const { camera, mic } = els();

    // Mic file position 12s is ruler time 10s, since the mic opened 2s early;
    // the camera opened at ruler zero, so its file sits at 10s there too.
    await act(async () => {
      shim.advance(mic, 12);
    });

    expect(onTimeUpdate).toHaveBeenLastCalledWith(10);
    expect(camera.currentTime).toBeCloseTo(10, 6);
  });

  it('enters the next mic segment where the ruler resumes, not at its first sample', async () => {
    const media = sources({
      camera: [
        seg('cam1.webm', 2.275, 1445.008),
        seg('cam2.webm', 3002.275, 4445.008),
      ],
      mic: [seg('mic1.webm', 0, 1444.732), seg('mic2.webm', 3000, 4444.732)],
    });
    await mount(media);
    const { mic } = els();

    await act(async () => {
      shim.fire(mic, 'ended');
    });

    expect(mic.src).toBe('http://media.test/mic2.webm');
    expect(mic.currentTime).toBeCloseTo(2.275, 6);
    expect(shim.counters.playCalls).toBe(1);
  });

  it('falls back to the camera clock when one mic segment straddles a camera gap', async () => {
    const onTimeUpdate = vi.fn();
    const media = sources({
      camera: [seg('cam1.webm', 0, 100), seg('cam2.webm', 1000, 1100)],
      mic: [seg('mic.webm', 0, 1100)],
    });
    await mount(media, { onTimeUpdate });
    const { camera, mic } = els();

    await act(async () => {
      shim.advance(mic, 50);
    });
    expect(onTimeUpdate).not.toHaveBeenCalled();

    await act(async () => {
      shim.advance(camera, 50);
    });
    expect(onTimeUpdate).toHaveBeenLastCalledWith(50);
  });

  it('reports a media error to the host', async () => {
    const onMediaError = vi.fn();
    await mount(SKEWED, { onMediaError });

    await act(async () => {
      shim.fire(els().camera, 'error');
    });

    expect(onMediaError).toHaveBeenCalledTimes(1);
  });
});

describe('clock file position off the ruler', () => {
  it('plays from the start when the clock file settled a hair before its window', async () => {
    await mount();
    const { mic } = els();
    // The mount seek asked the mic for file position 2s (ruler 0); an Ogg seek
    // can settle at 1.98s, which maps to ruler -0.02 where nothing has a segment.
    mic.currentTime = 1.98;
    shim.reset();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Play'));
    });

    expect(shim.counters.playCalls).toBe(3);
  });
});

describe('files shorter than the ruler', () => {
  it('parks a seek past the end of the file instead of wrapping to the start', async () => {
    // Every file here is 60s long while the ruler runs to 60s and the mic's
    // segment claims 61.5s: a seek into the tail lands beyond the mic file.
    await mount();
    const { mic } = els();

    await scrubTo('59.8');

    expect(mic.currentTime).toBe(60);
    expect(mic.paused).toBe(true);
  });

  it('holds a follower on its last frame when its file ran out ahead of the ruler', async () => {
    await mount();
    const { camera, mic } = els();
    // The camera file is 10s short of its span, the way frame loss leaves it.
    shim.setDuration(50, camera);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Play'));
    });
    shim.reset();
    // Mic at file 57s is ruler 55s, past the end of the camera file.
    await act(async () => {
      shim.advance(mic, 57);
    });
    await act(async () => {
      shim.advance(mic, 57.25);
    });

    expect(camera.currentTime).toBe(50);
    expect(shim.counters.playCalls).toBe(0);
  });
});

describe('refresh and layout', () => {
  it('re-sources every element at the same position when the URLs change', async () => {
    const view = await mount();
    await scrubTo('30');
    shim.reset();

    const refreshed = sources({
      camera: [seg('cam.webm?sig=2', 2, 62)],
      mic: [seg('mic.webm?sig=2', 0, 61.5)],
      bot_mic: [seg('bot.webm?sig=2', 0, 61.5)],
    });
    await act(async () => {
      view.rerender(<TrackPlayer media={refreshed} />);
    });

    const { camera, mic, bot } = els();
    expect(camera.src).toBe('http://media.test/cam.webm?sig=2');
    expect(mic.src).toBe('http://media.test/mic.webm?sig=2');
    expect(bot.src).toBe('http://media.test/bot.webm?sig=2');
    expect(mic.currentTime).toBeCloseTo(32, 6);
    expect(Number(scrubber().value)).toBe(30);
    // it was playing before the refresh, so it plays after it
    expect(shim.counters.playCalls).toBe(3);
  });

  it('uses the screen share as the ruler and a single pane when the camera was off', async () => {
    const media = sources({
      screen: [seg('screen.webm', 10, 310)],
      mic: [seg('mic.webm', 8, 309)],
    });
    await mount(media);

    expect(document.querySelector('.r41rp-stage--screen')).not.toBeNull();
    expect(screen.getByText('00:00 / 05:00')).toBeTruthy();
  });

  it('shows the split layout while a screen share is active', async () => {
    const media = sources({
      camera: [seg('cam.webm', 0, 60)],
      screen: [seg('screen.webm', 0, 60)],
    });
    await mount(media);

    expect(document.querySelector('.r41rp-stage--split')).not.toBeNull();
  });
});
