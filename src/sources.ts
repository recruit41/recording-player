import { TRACK_NAMES, type TrackSegment, type TrackSources } from './timeline';
import type { RecordingSegment, RecordingTracks } from './types';

const NS_PER_S = 1e9;

function isUnbounded(seg: RecordingSegment): boolean {
  return seg.started_at === null || seg.ended_at === null;
}

// A stage whose files carry no wall-clock bounds is a single stitched recording
// (Daily, or a merged LiveKit session); every file starts at the same instant,
// so a measured duration is enough to place it.
export function unboundedUrls(tracks: RecordingTracks): string[] {
  const urls: string[] = [];
  for (const name of TRACK_NAMES) {
    for (const seg of tracks[name]) {
      if (isUnbounded(seg)) urls.push(seg.url);
    }
  }
  return urls;
}

export function toTrackSources(
  tracks: RecordingTracks,
  durationsS: ReadonlyMap<string, number>,
): TrackSources {
  const sources: TrackSources = {
    camera: [],
    screen: [],
    mic: [],
    bot_mic: [],
  };
  for (const name of TRACK_NAMES) {
    const segs: TrackSegment[] = [];
    for (const seg of tracks[name]) {
      if (!isUnbounded(seg)) {
        segs.push({
          url: seg.url,
          started_at: seg.started_at as number,
          ended_at: seg.ended_at as number,
        });
        continue;
      }
      const duration = durationsS.get(seg.url);
      if (duration === undefined || !(duration > 0)) continue;
      segs.push({ url: seg.url, started_at: 0, ended_at: duration * NS_PER_S });
    }
    segs.sort((a, b) => a.started_at - b.started_at);
    sources[name] = segs;
  }
  return sources;
}

export function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    const done = () => {
      probe.removeEventListener('loadedmetadata', onMeta);
      probe.removeEventListener('error', onError);
      probe.removeAttribute('src');
    };
    const onMeta = () => {
      const duration = probe.duration;
      done();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`No finite duration for ${url}`));
    };
    const onError = () => {
      done();
      reject(new Error(`Could not load metadata for ${url}`));
    };
    probe.addEventListener('loadedmetadata', onMeta, { once: true });
    probe.addEventListener('error', onError, { once: true });
    probe.src = url;
  });
}
