import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RecordingPlayer,
  type CandidateRecordings,
  type RecordingStage,
} from '@recruit41/recording-player';

// Everything the Playwright probe reads lives on window.__probe; the host itself
// is deliberately dumb so the component is what gets exercised.
declare global {
  interface Window {
    __probe: {
      fixture: string;
      loaded: boolean;
      stage: RecordingStage | null;
      times: Array<{ at: number; seconds: number; stage: RecordingStage }>;
      refreshRequests: number;
      payloadVersion: number;
    };
    __seek: (seconds: number) => void;
    __swapPayload: () => Promise<void>;
  }
}

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'livekit';

window.__probe = {
  fixture,
  loaded: false,
  stage: null,
  times: [],
  refreshRequests: 0,
  payloadVersion: 0,
};

async function loadPayload(version: number): Promise<CandidateRecordings> {
  const suffix = version === 0 ? '' : `.refresh${version}`;
  const response = await fetch(`/${fixture}${suffix}.json`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`fixture ${fixture}${suffix} missing`);
  return response.json();
}

function Host() {
  const [payload, setPayload] = useState<CandidateRecordings | null>(null);
  const [version, setVersion] = useState(0);
  const seekRef = useRef<((seconds: number) => void) | null>(null);

  useEffect(() => {
    loadPayload(0).then((p) => {
      setPayload(p);
      window.__probe.loaded = true;
      window.__probe.stage = p.interview?.recording_available
        ? 'interview'
        : p.coding_assessment?.recording_available
          ? 'coding_assessment'
          : null;
    });
  }, []);

  useEffect(() => {
    window.__seek = (seconds) => seekRef.current?.(seconds);
    window.__swapPayload = async () => {
      const next = version + 1;
      const p = await loadPayload(next);
      setPayload(p);
      setVersion(next);
      window.__probe.payloadVersion = next;
    };
  }, [version]);

  if (!payload) return <p>Loading fixture {fixture}</p>;

  return (
    <>
      <div className="bar">
        <span>
          fixture <code>{fixture}</code>
        </span>
        <span>payload v{version}</span>
        <span>
          stages{' '}
          <code>
            {[
              payload.interview && 'interview',
              payload.coding_assessment && 'coding_assessment',
            ]
              .filter(Boolean)
              .join(', ')}
          </code>
        </span>
        <button type="button" onClick={() => window.__swapPayload()}>
          Swap payload (simulate refresh)
        </button>
      </div>
      <RecordingPlayer
        recordings={payload}
        onRefresh={() => {
          window.__probe.refreshRequests += 1;
        }}
        onTimeUpdate={(seconds, stage) => {
          const times = window.__probe.times;
          times.push({ at: performance.now(), seconds, stage });
          if (times.length > 4000) times.splice(0, times.length - 4000);
        }}
        onStageChange={(stage) => {
          window.__probe.stage = stage;
        }}
        seekRef={seekRef}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
