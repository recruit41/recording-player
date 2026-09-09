import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { RecordingPlayer } from './RecordingPlayer';
import { installMediaShim, type MediaShim } from './test/mediaShim';
import type {
  CandidateRecordings,
  RecordingTracks,
  StageRecording,
} from './types';

const S = 1e9;

function tracks(partial: Partial<RecordingTracks>): RecordingTracks {
  return { camera: [], screen: [], mic: [], bot_mic: [], ...partial };
}

function stage(
  partial: Partial<StageRecording> & { tracks: RecordingTracks },
): StageRecording {
  return {
    recording_available: true,
    expires_at: null,
    transcript: [],
    ...partial,
  };
}

const LIVEKIT_INTERVIEW = stage({
  tracks: tracks({
    camera: [
      {
        url: 'http://media.test/i/cam.webm',
        started_at: 2 * S,
        ended_at: 62 * S,
      },
    ],
    mic: [
      {
        url: 'http://media.test/i/mic.webm',
        started_at: 0,
        ended_at: 61.5 * S,
      },
    ],
  }),
});

const DAILY_ASSESSMENT = stage({
  tracks: tracks({
    camera: [
      {
        url: 'http://media.test/a/camera.mp4',
        started_at: null,
        ended_at: null,
      },
    ],
  }),
});

function payload(partial: Partial<CandidateRecordings>): CandidateRecordings {
  return {
    interview: null,
    coding_assessment: null,
    ...partial,
  };
}

let shim: MediaShim;

beforeAll(() => {
  shim = installMediaShim();
});

beforeEach(() => {
  shim.reset();
  shim.setDuration(90);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stages', () => {
  it('shows an empty state when no stage carries a recording', () => {
    render(
      <RecordingPlayer
        recordings={payload({
          interview: stage({ recording_available: false, tracks: tracks({}) }),
        })}
      />,
    );

    expect(screen.getByText('No recording available')).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
  });

  it('renders a single stage directly, without tabs', async () => {
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: LIVEKIT_INTERVIEW })}
        />,
      );
    });

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelectorAll('video')).toHaveLength(2);
  });

  it('offers a stage switcher when both stages carry a recording', async () => {
    const onStageChange = vi.fn();
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({
            interview: LIVEKIT_INTERVIEW,
            coding_assessment: DAILY_ASSESSMENT,
          })}
          onStageChange={onStageChange}
        />,
      );
    });

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Interview',
      'Coding assessment',
    ]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      fireEvent.click(tabs[1]);
    });

    expect(onStageChange).toHaveBeenCalledWith('coding_assessment');
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('measures a stitched Daily file from its metadata and rules the stage by it', async () => {
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ coding_assessment: DAILY_ASSESSMENT })}
        />,
      );
    });

    expect(screen.getByText('00:00 / 01:30')).toBeTruthy();
  });

  it('injects its stylesheet once', async () => {
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: LIVEKIT_INTERVIEW })}
        />,
      );
    });
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: LIVEKIT_INTERVIEW })}
        />,
      );
    });

    expect(
      document.querySelectorAll('#r41-recording-player-styles'),
    ).toHaveLength(1);
  });
});

describe('refresh', () => {
  it('asks the host to refresh a minute before the stage expires', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const expiring = stage({
      ...LIVEKIT_INTERVIEW,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: expiring })}
          onRefresh={onRefresh}
        />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(3 * 60_000 + 59_000);
    });
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('asks the host to refresh once when media fails to load', async () => {
    const onRefresh = vi.fn();
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: LIVEKIT_INTERVIEW })}
          onRefresh={onRefresh}
        />,
      );
    });

    const [, camera] = Array.from(document.querySelectorAll('video'));
    const [mic] = Array.from(document.querySelectorAll('audio'));
    await act(async () => {
      shim.fire(camera, 'error');
      shim.fire(mic, 'error');
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('reports the position with its stage', async () => {
    const onTimeUpdate = vi.fn();
    await act(async () => {
      render(
        <RecordingPlayer
          recordings={payload({ interview: LIVEKIT_INTERVIEW })}
          onTimeUpdate={onTimeUpdate}
        />,
      );
    });
    const [mic] = Array.from(document.querySelectorAll('audio'));

    await act(async () => {
      shim.advance(mic, 12);
    });

    expect(onTimeUpdate).toHaveBeenLastCalledWith(10, 'interview');
  });
});
