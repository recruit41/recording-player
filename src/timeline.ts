export interface TrackSegment {
  url: string;
  started_at: number;
  ended_at: number;
}

export interface TrackSources {
  camera: TrackSegment[];
  screen: TrackSegment[];
  mic: TrackSegment[];
  bot_mic: TrackSegment[];
}

export type TrackName = keyof TrackSources;

export const TRACK_NAMES: readonly TrackName[] = [
  'camera',
  'screen',
  'mic',
  'bot_mic',
];

const NS_PER_S = 1e9;

export interface SegmentWindow {
  seg: TrackSegment;
  // Ruler position at which this file's position 0 would sit. Negative, or
  // inside a collapsed gap, when the file opened before the ruler did.
  startS: number;
  endS: number;
  fileTime: number;
}

export interface TimelineSpan {
  startNs: number;
  endNs: number;
  // Where this span begins on the collapsed player ruler.
  offsetS: number;
}

export interface Timeline {
  spans: TimelineSpan[];
  totalS: number;
}

export const EMPTY_TIMELINE: Timeline = { spans: [], totalS: 0 };

// The ruler is the candidate's video: the camera, or the screen share when the
// camera was off for the whole recording (a coding assessment taken camera-off).
export function rulerTrack(sources: TrackSources): 'camera' | 'screen' {
  return sources.camera.length > 0 ? 'camera' : 'screen';
}

// Wall-clock stretches with no ruler video are left off the ruler rather than
// rendered as dead scrubber space, and gaps between ruler segments are
// collapsed: a candidate who abandons and resumes two days later must not get a
// two-day ruler.
export function buildTimeline(ruler: TrackSegment[]): Timeline {
  const spans: TimelineSpan[] = [];
  let totalS = 0;

  for (const seg of [...ruler].sort((a, b) => a.started_at - b.started_at)) {
    if (seg.ended_at <= seg.started_at) continue;

    const prev = spans[spans.length - 1];
    if (prev && seg.started_at <= prev.endNs) {
      if (seg.ended_at > prev.endNs) {
        totalS += (seg.ended_at - prev.endNs) / NS_PER_S;
        prev.endNs = seg.ended_at;
      }
      continue;
    }

    spans.push({
      startNs: seg.started_at,
      endNs: seg.ended_at,
      offsetS: totalS,
    });
    totalS += (seg.ended_at - seg.started_at) / NS_PER_S;
  }

  return { spans, totalS };
}

export function timelineToWallNs(timeline: Timeline, t: number): number | null {
  for (const span of timeline.spans) {
    const spanS = (span.endNs - span.startNs) / NS_PER_S;
    if (t >= span.offsetS && t < span.offsetS + spanS) {
      return span.startNs + (t - span.offsetS) * NS_PER_S;
    }
  }
  return null;
}

export function wallNsToTimeline(
  timeline: Timeline,
  ns: number,
): number | null {
  for (const span of timeline.spans) {
    if (ns >= span.startNs && ns < span.endNs) {
      return span.offsetS + (ns - span.startNs) / NS_PER_S;
    }
  }
  return null;
}

export function segmentAt(
  segs: TrackSegment[],
  t: number,
  timeline: Timeline,
): SegmentWindow | null {
  const wallNs = timelineToWallNs(timeline, t);
  if (wallNs === null) return null;

  for (const seg of segs) {
    if (wallNs >= seg.started_at && wallNs < seg.ended_at) {
      const fileTime = (wallNs - seg.started_at) / NS_PER_S;
      const startS = t - fileTime;
      return {
        seg,
        startS,
        endS: startS + (seg.ended_at - seg.started_at) / NS_PER_S,
        fileTime,
      };
    }
  }
  return null;
}

// A track that does not define the ruler can open inside a collapsed gap (the
// mic starts a couple of seconds before the camera in every session), so the
// next segment is entered where the ruler resumes, part-way into the file,
// rather than skipped because its first sample has no ruler position.
export function nextSegment(
  segs: TrackSegment[],
  current: SegmentWindow,
  timeline: Timeline,
): SegmentWindow | null {
  for (const seg of segs) {
    if (seg.started_at < current.seg.ended_at) continue;
    const span = timeline.spans.find(
      (s) => s.endNs > seg.started_at && s.startNs < seg.ended_at,
    );
    if (!span) continue;
    const enterNs = Math.max(seg.started_at, span.startNs);
    const fileTime = (enterNs - seg.started_at) / NS_PER_S;
    const enterS = span.offsetS + (enterNs - span.startNs) / NS_PER_S;
    const startS = enterS - fileTime;
    return {
      seg,
      startS,
      endS: startS + (seg.ended_at - seg.started_at) / NS_PER_S,
      fileTime,
    };
  }
  return null;
}

// Video is the lossy track: per-track egress writes only the frames it
// received, so a camera file runs seconds shorter than its wall-clock span and
// by an amount that varies with frame loss, not duration. Audio files are short
// by a near-constant teardown flush, so audio carries the clock and video is
// corrected toward it.
export const VIDEO_SEEK_THRESHOLD_S = 0.3;

// A hard seek on an audio element is an audible jump. A rate nudge is
// inaudible and clears 0.25s of error in roughly 8s; past the ceiling a nudge
// would take too long to converge, so a seek is still the only option.
export const AUDIO_NUDGE_CEILING_S = 0.75;
export const AUDIO_DEADBAND_S = 0.04;
export const AUDIO_NUDGE = 0.03;

// Egress tears the mic down before the camera, so the mic ends early by a few
// seconds (median 4.1s, worst 7.9s across 49 recordings). Forgiving that
// tail costs the last few seconds of scrubbing; refusing it would hand every
// such recording back to the video clock. A mic that dies far earlier does
// fall back.
const CLOCK_TAIL_SLACK_NS = 30 * NS_PER_S;

// Global time is linear in the clock file's position between seeks, which holds
// only inside one span: a mic segment running across a collapsed gap would carry
// the ruler through wall time the ruler does not have.
function straddlesAGap(seg: TrackSegment, timeline: Timeline): boolean {
  let overlapped = 0;
  for (const span of timeline.spans) {
    if (span.startNs < seg.ended_at && span.endNs > seg.started_at) {
      overlapped += 1;
    }
  }
  return overlapped > 1;
}

export function micCanDriveClock(
  sources: TrackSources,
  timeline: Timeline,
): boolean {
  if (sources.mic.length === 0 || timeline.spans.length === 0) return false;
  const coversEverySpan = timeline.spans.every((span) =>
    sources.mic.some(
      (seg) =>
        seg.started_at <= span.startNs &&
        seg.ended_at >= span.endNs - CLOCK_TAIL_SLACK_NS,
    ),
  );
  if (!coversEverySpan) return false;
  return !sources.mic.some((seg) => straddlesAGap(seg, timeline));
}

export function clockTrack(
  sources: TrackSources,
  timeline: Timeline,
): TrackName {
  return micCanDriveClock(sources, timeline) ? 'mic' : rulerTrack(sources);
}

const CLAMP_EPSILON_S = 0.05;

// Ruler stretches the clock track covers, as [start, end) in ruler seconds.
function coveredIntervals(
  clockSegs: TrackSegment[],
  timeline: Timeline,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (const seg of clockSegs) {
    for (const span of timeline.spans) {
      const startNs = Math.max(seg.started_at, span.startNs);
      const endNs = Math.min(seg.ended_at, span.endNs);
      if (endNs <= startNs) continue;
      intervals.push([
        span.offsetS + (startNs - span.startNs) / NS_PER_S,
        span.offsetS + (endNs - span.startNs) / NS_PER_S,
      ]);
    }
  }
  return intervals;
}

// A seek can only land where the clock track has samples; otherwise nothing
// drives the ruler and the player sits with the scrubber frozen. Outside
// coverage the seek moves to the nearest covered instant, which for the mic's
// early teardown means the last covered moment of the recording.
export function clampToClock(
  t: number,
  clockSegs: TrackSegment[],
  timeline: Timeline,
): number {
  const intervals = coveredIntervals(clockSegs, timeline);
  if (intervals.length === 0) return t;
  for (const [start, end] of intervals) {
    if (t >= start && t < end) return t;
  }
  const endsBefore = intervals.filter(([, end]) => end <= t);
  if (endsBefore.length > 0) {
    const [start, end] = endsBefore.reduce((a, b) => (a[1] > b[1] ? a : b));
    return Math.max(start, end - CLAMP_EPSILON_S);
  }
  return Math.min(...intervals.map(([start]) => start));
}

export interface AudioCorrection {
  seekTo: number | null;
  playbackRate: number;
}

export function audioCorrection(
  targetFileTime: number,
  actualFileTime: number,
  speed: number,
): AudioCorrection {
  const error = targetFileTime - actualFileTime;
  const magnitude = Math.abs(error);
  if (magnitude > AUDIO_NUDGE_CEILING_S) {
    return { seekTo: targetFileTime, playbackRate: speed };
  }
  if (magnitude < AUDIO_DEADBAND_S) {
    return { seekTo: null, playbackRate: speed };
  }
  return {
    seekTo: null,
    playbackRate: speed * (1 + Math.sign(error) * AUDIO_NUDGE),
  };
}

export function needsVideoSeek(
  targetFileTime: number,
  actualFileTime: number,
): boolean {
  return Math.abs(actualFileTime - targetFileTime) > VIDEO_SEEK_THRESHOLD_S;
}
