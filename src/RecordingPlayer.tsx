import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import { VideoOffIcon } from './icons';
import { probeDuration, toTrackSources, unboundedUrls } from './sources';
import { ensureStyles } from './styles';
import type { TrackSources } from './timeline';
import { TrackPlayer } from './TrackPlayer';
import type {
  CandidateRecordings,
  RecordingStage,
  StageRecording,
} from './types';

export interface RecordingPlayerProps {
  // The two raw-recording responses, each under its stage key.
  recordings: CandidateRecordings;
  // Called when a media element fails to load, or shortly before a stage's
  // `expires_at`. The host re-fetches and passes the new payload back in.
  onRefresh?: () => void;
  onTimeUpdate?: (seconds: number, stage: RecordingStage) => void;
  // Host-driven seek into the stage currently shown, in ruler seconds.
  seekRef?: MutableRefObject<((seconds: number) => void) | null>;
  onStageChange?: (stage: RecordingStage) => void;
}

const STAGE_LABELS: Record<RecordingStage, string> = {
  interview: 'Interview',
  coding_assessment: 'Coding assessment',
};

// Signed URLs are refreshed a minute ahead of expiry so a viewer mid-playback
// never reaches a URL that has already stopped working.
const REFRESH_MARGIN_MS = 60_000;

function hasRecording(stage: StageRecording | null): stage is StageRecording {
  return stage !== null && stage.recording_available;
}

type Resolution =
  | { status: 'loading' }
  | { status: 'ready'; sources: TrackSources }
  | { status: 'error' };

function useResolvedSources(recording: StageRecording): Resolution {
  const [durations, setDurations] = useState<Map<string, number> | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useMemo(() => unboundedUrls(recording.tracks), [recording]);

  useEffect(() => {
    if (pending.length === 0) return;
    let cancelled = false;
    setDurations(null);
    setFailed(false);
    Promise.all(
      pending.map((url) => probeDuration(url).then((d) => [url, d] as const)),
    )
      .then((entries) => {
        if (!cancelled) setDurations(new Map(entries));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pending]);

  return useMemo<Resolution>(() => {
    if (pending.length === 0) {
      return {
        status: 'ready',
        sources: toTrackSources(recording.tracks, new Map()),
      };
    }
    if (failed) return { status: 'error' };
    if (durations === null) return { status: 'loading' };
    return {
      status: 'ready',
      sources: toTrackSources(recording.tracks, durations),
    };
  }, [pending, recording, durations, failed]);
}

interface StagePlayerProps {
  recording: StageRecording;
  initialTime: number;
  onTimeUpdate: (seconds: number) => void;
  seekRef?: MutableRefObject<((seconds: number) => void) | null>;
  onRefresh?: () => void;
}

function StagePlayer({
  recording,
  initialTime,
  onTimeUpdate,
  seekRef,
  onRefresh,
}: StagePlayerProps) {
  const resolution = useResolvedSources(recording);
  // One refresh per payload: a failing URL set produces an error per element,
  // and the host should hear about it once.
  const refreshed = useRef(false);
  useEffect(() => {
    refreshed.current = false;
  }, [recording]);

  const requestRefresh = useCallback(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    onRefresh?.();
  }, [onRefresh]);

  useEffect(() => {
    if (!recording.expires_at || !onRefresh) return;
    const dueIn =
      new Date(recording.expires_at).getTime() - REFRESH_MARGIN_MS - Date.now();
    const timer = window.setTimeout(requestRefresh, Math.max(dueIn, 0));
    return () => window.clearTimeout(timer);
  }, [recording, onRefresh, requestRefresh]);

  if (resolution.status === 'loading') {
    return (
      <div className="r41rp-empty" role="status">
        <p>Loading recording</p>
      </div>
    );
  }
  if (resolution.status === 'error') {
    return (
      <div className="r41rp-empty" role="alert">
        <VideoOffIcon />
        <h3>Recording could not be loaded</h3>
        {onRefresh && (
          <button type="button" className="r41rp-retry" onClick={onRefresh}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <TrackPlayer
      media={resolution.sources}
      initialTime={initialTime}
      onTimeUpdate={onTimeUpdate}
      seekRef={seekRef}
      onMediaError={requestRefresh}
    />
  );
}

export function RecordingPlayer({
  recordings,
  onRefresh,
  onTimeUpdate,
  seekRef,
  onStageChange,
}: RecordingPlayerProps) {
  useLayoutEffect(ensureStyles, []);

  const available = useMemo(() => {
    const stages: RecordingStage[] = [];
    if (hasRecording(recordings.interview)) stages.push('interview');
    if (hasRecording(recordings.coding_assessment))
      stages.push('coding_assessment');
    return stages;
  }, [recordings]);

  const [chosen, setChosen] = useState<RecordingStage | null>(null);
  const stage =
    chosen && available.includes(chosen) ? chosen : (available[0] ?? null);
  const positions = useRef<Partial<Record<RecordingStage, number>>>({});

  const selectStage = (next: RecordingStage) => {
    if (next === stage) return;
    setChosen(next);
    onStageChange?.(next);
  };

  const rememberTime = useCallback(
    (seconds: number) => {
      if (!stage) return;
      positions.current[stage] = seconds;
      onTimeUpdate?.(seconds, stage);
    },
    [stage, onTimeUpdate],
  );

  if (!stage) {
    return (
      <div className="r41rp-root">
        <div className="r41rp-empty">
          <VideoOffIcon />
          <h3>No recording available</h3>
        </div>
      </div>
    );
  }

  const recording = recordings[stage] as StageRecording;

  return (
    <div className="r41rp-root">
      {available.length > 1 && (
        <div className="r41rp-tabs" role="tablist" aria-label="Recording stage">
          {available.map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              className="r41rp-tab"
              aria-selected={name === stage}
              onClick={() => selectStage(name)}
            >
              {STAGE_LABELS[name]}
            </button>
          ))}
        </div>
      )}
      <StagePlayer
        key={stage}
        recording={recording}
        initialTime={positions.current[stage] ?? 0}
        onTimeUpdate={rememberTime}
        seekRef={seekRef}
        onRefresh={onRefresh}
      />
    </div>
  );
}
