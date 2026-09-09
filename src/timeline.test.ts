import { describe, it, expect } from 'vitest';

import {
  buildTimeline,
  segmentAt,
  nextSegment,
  wallNsToTimeline,
  timelineToWallNs,
  audioCorrection,
  needsVideoSeek,
  micCanDriveClock,
  rulerTrack,
  clockTrack,
  clampToClock,
  type TrackSources,
  type TrackSegment,
  type Timeline,
} from './timeline';

const S = 1_000_000_000;

function seg(startS: number, endS: number, url = `u${startS}`): TrackSegment {
  return { url, started_at: startS * S, ended_at: endS * S };
}

function sources(partial: Partial<TrackSources>): TrackSources {
  return { camera: [], screen: [], mic: [], bot_mic: [], ...partial };
}

function ruler(media: TrackSources): Timeline {
  return buildTimeline(media[rulerTrack(media)]);
}

// Two sessions, each with the skew a real LiveKit recording showed: the mic
// opens 2.275s before the camera and closes 0.275s before it.
const SKEWED_RECONNECT = sources({
  camera: [seg(2.275, 1445.008, 'cam1'), seg(3002.275, 4445.008, 'cam2')],
  mic: [seg(0, 1444.732, 'mic1'), seg(3000, 4444.732, 'mic2')],
});

describe('rulerTrack', () => {
  it('is the camera whenever the camera recorded', () => {
    expect(
      rulerTrack(sources({ camera: [seg(0, 10)], screen: [seg(0, 10)] })),
    ).toBe('camera');
  });

  it('is the screen share for a camera-off recording', () => {
    expect(rulerTrack(sources({ screen: [seg(0, 10)] }))).toBe('screen');
  });
});

describe('buildTimeline', () => {
  it('uses the camera span for a single-session recording', () => {
    const tl = ruler(sources({ camera: [seg(100, 400)] }));
    expect(tl.totalS).toBe(300);
  });

  it('collapses the gap between camera segments', () => {
    const tl = ruler(
      sources({ camera: [seg(100, 200), seg(100_000, 100_500)] }),
    );
    expect(tl.totalS).toBe(600);
    expect(tl.spans[1].offsetS).toBe(100);
  });

  it('ignores tracks that outlive the camera', () => {
    const tl = ruler(
      sources({ camera: [seg(0, 60)], bot_mic: [seg(0, 60), seg(300, 600)] }),
    );
    expect(tl.totalS).toBe(60);
  });

  it('merges overlapping camera segments instead of double-counting', () => {
    const tl = ruler(sources({ camera: [seg(0, 100), seg(50, 150)] }));
    expect(tl.totalS).toBe(150);
    expect(tl.spans).toHaveLength(1);
  });

  it('sorts unordered camera segments', () => {
    const tl = ruler(sources({ camera: [seg(500, 600), seg(0, 100)] }));
    expect(tl.spans.map((s) => s.offsetS)).toEqual([0, 100]);
  });

  it('drops zero-length and inverted segments', () => {
    const tl = ruler(
      sources({ camera: [seg(0, 0), seg(90, 60), seg(100, 130)] }),
    );
    expect(tl.totalS).toBe(30);
    expect(tl.spans).toHaveLength(1);
  });

  it('rules a camera-off coding assessment by its screen share', () => {
    const media = sources({ screen: [seg(10, 310)], mic: [seg(8, 309)] });
    const tl = ruler(media);
    expect(tl.totalS).toBe(300);
    expect(segmentAt(media.screen, 0, tl)?.fileTime).toBe(0);
  });

  // A real recording: the candidate joined, dropped after about two minutes,
  // resumed 48 hours later, and a bot_mic egress outlived the camera by another
  // four minutes. A wall-clock ruler would report 176035 s, rendered as "2933:55".
  it('reports recorded length, not wall-clock span, for a resumed interview', () => {
    const tl = ruler(
      sources({
        camera: [
          seg(1784887944.115, 1784888057.011),
          seg(1785060540.262, 1785063447.17),
        ],
        bot_mic: [seg(1785063697.488, 1785063979.169)],
      }),
    );
    expect(Math.round(tl.totalS)).toBe(3020);
  });
});

describe('segmentAt', () => {
  const media = sources({
    camera: [seg(100, 200, 'cam1'), seg(100_000, 100_500, 'cam2')],
    screen: [seg(100_100, 100_400, 'screen1')],
    mic: [seg(99, 200, 'mic1')],
  });
  const tl = ruler(media);

  it('resolves the first camera segment at t=0', () => {
    const win = segmentAt(media.camera, 0, tl);
    expect(win?.seg.url).toBe('cam1');
    expect(win?.fileTime).toBe(0);
  });

  it('resolves the post-gap camera segment immediately after the collapse point', () => {
    const win = segmentAt(media.camera, 100, tl);
    expect(win?.seg.url).toBe('cam2');
    expect(win?.fileTime).toBe(0);
    expect(win?.startS).toBe(100);
  });

  it('maps another track by wall clock into the collapsed frame', () => {
    const win = segmentAt(media.screen, 200, tl);
    expect(win?.seg.url).toBe('screen1');
    expect(win?.fileTime).toBeCloseTo(0, 6);
  });

  it('returns null for a track with no coverage at that instant', () => {
    expect(segmentAt(media.screen, 50, tl)).toBeNull();
  });

  it('returns null past the end of the timeline', () => {
    expect(segmentAt(media.camera, tl.totalS, tl)).toBeNull();
  });

  it('keeps currentTime + startS equal to global time', () => {
    const win = segmentAt(media.camera, 150, tl)!;
    expect(win.fileTime + win.startS).toBeCloseTo(150, 6);
  });

  it('clips a track segment that starts before the camera to the visible window', () => {
    const win = segmentAt(media.mic, 0, tl)!;
    expect(win.fileTime).toBeCloseTo(1, 6);
  });
});

describe('nextSegment', () => {
  const media = sources({ camera: [seg(100, 200), seg(100_000, 100_500)] });
  const tl = ruler(media);

  it('lands on the post-gap segment with no dead time in between', () => {
    const current = segmentAt(media.camera, 0, tl)!;
    const next = nextSegment(media.camera, current, tl)!;
    expect(next.startS).toBe(100);
    expect(next.fileTime).toBe(0);
  });

  it('returns null on the last segment', () => {
    const last = segmentAt(media.camera, 100, tl)!;
    expect(nextSegment(media.camera, last, tl)).toBeNull();
  });

  it('enters a mic segment that opens inside the collapsed gap part-way in', () => {
    const tlSkewed = ruler(SKEWED_RECONNECT);
    const current = segmentAt(SKEWED_RECONNECT.mic, 0, tlSkewed)!;

    const next = nextSegment(SKEWED_RECONNECT.mic, current, tlSkewed)!;

    expect(next.seg.url).toBe('mic2');
    // The ruler resumes 2.275s into the mic file, so that is where the file is
    // entered, and file position + startS still equals ruler time.
    expect(next.fileTime).toBeCloseTo(2.275, 6);
    expect(next.fileTime + next.startS).toBeCloseTo(
      tlSkewed.spans[1].offsetS,
      6,
    );
  });

  it('skips a segment that lies entirely inside a gap', () => {
    const media2 = sources({
      camera: [seg(0, 100), seg(1000, 1100)],
      mic: [
        seg(0, 100, 'mic1'),
        seg(500, 600, 'gap-only'),
        seg(1000, 1100, 'mic3'),
      ],
    });
    const tl2 = ruler(media2);
    const current = segmentAt(media2.mic, 0, tl2)!;

    expect(nextSegment(media2.mic, current, tl2)?.seg.url).toBe('mic3');
  });
});

describe('timeline coordinate mapping', () => {
  const tl = ruler(sources({ camera: [seg(100, 200), seg(100_000, 100_500)] }));

  it('round-trips between collapsed seconds and wall clock', () => {
    const wall = timelineToWallNs(tl, 150)!;
    expect(wallNsToTimeline(tl, wall)).toBeCloseTo(150, 6);
  });

  it('has no collapsed position for wall clock inside a gap', () => {
    expect(wallNsToTimeline(tl, 50_000 * S)).toBeNull();
  });
});

describe('micCanDriveClock', () => {
  it('accepts the real shape of a LiveKit interview', () => {
    // The ordinary egress skew: the mic opens 2.275s before the camera and
    // closes 0.275s before it.
    const media = sources({
      camera: [seg(2.275, 1445.008)],
      mic: [seg(0, 1444.732)],
    });
    expect(micCanDriveClock(media, ruler(media))).toBe(true);
  });

  it('tolerates the worst teardown skew measured', () => {
    // The mic closed 7.87s before the camera, the largest tail gap measured
    // across 49 single-session recordings.
    const media = sources({
      camera: [seg(1.88, 3407.58)],
      mic: [seg(0, 3399.71)],
    });
    expect(micCanDriveClock(media, ruler(media))).toBe(true);
  });

  it('falls back to camera when there is no candidate audio', () => {
    const media = sources({ camera: [seg(0, 100)] });
    expect(micCanDriveClock(media, ruler(media))).toBe(false);
  });

  it('falls back to camera when the mic joins after the camera', () => {
    const media = sources({ camera: [seg(0, 100)], mic: [seg(10, 100)] });
    expect(micCanDriveClock(media, ruler(media))).toBe(false);
  });

  it('falls back to camera when the mic dies mid-recording', () => {
    const media = sources({ camera: [seg(0, 600)], mic: [seg(0, 300)] });
    expect(micCanDriveClock(media, ruler(media))).toBe(false);
  });

  it('requires every camera span to be covered, not just the first', () => {
    const media = sources({
      camera: [seg(0, 100), seg(1000, 1100)],
      mic: [seg(0, 100)],
    });
    expect(micCanDriveClock(media, ruler(media))).toBe(false);
  });

  it('accepts a reconnect where the mic covers both spans', () => {
    const media = sources({
      camera: [seg(0, 100), seg(1000, 1100)],
      mic: [seg(0, 100), seg(1000, 1100)],
    });
    expect(micCanDriveClock(media, ruler(media))).toBe(true);
  });

  it('accepts a reconnect with the ordinary mic-first skew in each session', () => {
    expect(micCanDriveClock(SKEWED_RECONNECT, ruler(SKEWED_RECONNECT))).toBe(
      true,
    );
  });

  it('refuses one mic segment that runs across a collapsed camera gap', () => {
    // A camera republish that leaves the mic publication alive. Linear file
    // time would carry the ruler through 900s the ruler does not have.
    const media = sources({
      camera: [seg(0, 100), seg(1000, 1100)],
      mic: [seg(0, 1100)],
    });
    expect(micCanDriveClock(media, ruler(media))).toBe(false);
    expect(clockTrack(media, ruler(media))).toBe('camera');
  });

  it('drives a camera-off assessment from the mic over the screen ruler', () => {
    const media = sources({ screen: [seg(10, 310)], mic: [seg(8, 309)] });
    expect(clockTrack(media, ruler(media))).toBe('mic');
  });

  it('falls back to the screen when a camera-off assessment has no mic', () => {
    const media = sources({ screen: [seg(10, 310)] });
    expect(clockTrack(media, ruler(media))).toBe('screen');
  });
});

describe('clampToClock', () => {
  const media = sources({
    camera: [seg(2.275, 1445.008)],
    mic: [seg(0, 1444.732)],
  });
  const tl = ruler(media);
  const micCoverageEndS = 1444.732 - 2.275;

  it('leaves a seek inside clock coverage alone', () => {
    expect(clampToClock(100, media.mic, tl)).toBe(100);
  });

  it('pulls a seek into the mic teardown tail back to the last covered instant', () => {
    const clamped = clampToClock(tl.totalS - 0.1, media.mic, tl);
    expect(clamped).toBeLessThan(micCoverageEndS);
    expect(clamped).toBeGreaterThan(micCoverageEndS - 0.1);
    expect(segmentAt(media.mic, clamped, tl)).not.toBeNull();
  });

  it('never moves a seek when the ruler track is the clock', () => {
    expect(clampToClock(tl.totalS - 0.1, media.camera, tl)).toBe(
      tl.totalS - 0.1,
    );
  });

  it('moves a seek in a covered-later gap forward to the next covered instant', () => {
    const media2 = sources({
      camera: [seg(0, 100), seg(1000, 1100)],
      mic: [seg(5, 100), seg(1000, 1100)],
    });
    const tl2 = ruler(media2);
    expect(clampToClock(2, media2.mic, tl2)).toBe(5);
  });
});

describe('audioCorrection', () => {
  it('leaves a track inside the deadband completely alone', () => {
    expect(audioCorrection(10, 10.02, 1)).toEqual({
      seekTo: null,
      playbackRate: 1,
    });
  });

  it('nudges rather than seeks for the drift recruiters actually hear', () => {
    const behind = audioCorrection(10.25, 10, 1);
    expect(behind.seekTo).toBeNull();
    expect(behind.playbackRate).toBeCloseTo(1.03, 6);

    const ahead = audioCorrection(10, 10.25, 1);
    expect(ahead.seekTo).toBeNull();
    expect(ahead.playbackRate).toBeCloseTo(0.97, 6);
  });

  it('scales the nudge by the chosen playback speed', () => {
    expect(audioCorrection(10.25, 10, 2).playbackRate).toBeCloseTo(2.06, 6);
  });

  it('seeks once the error is too large for a nudge to converge', () => {
    expect(audioCorrection(20, 10, 1)).toEqual({
      seekTo: 20,
      playbackRate: 1,
    });
  });

  it('restores the plain speed when it seeks', () => {
    expect(audioCorrection(20, 10, 1.5).playbackRate).toBe(1.5);
  });
});

describe('needsVideoSeek', () => {
  it('tolerates sub-threshold video error', () => {
    expect(needsVideoSeek(10, 10.2)).toBe(false);
  });

  it('seeks video past the threshold, in either direction', () => {
    expect(needsVideoSeek(10, 10.4)).toBe(true);
    expect(needsVideoSeek(10, 9.6)).toBe(true);
  });
});
