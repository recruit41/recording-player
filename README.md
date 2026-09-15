# @recruit41/recording-player

A React component that plays a candidate's Recruit41 recordings: the AI
interview and the coding assessment. It has no runtime dependencies, injects its
own stylesheet, and takes the raw JSON returned by the Recruit41 partner API as a
prop. React 18 or newer is the only thing the host must provide.

## Install

The package is published to the public npm registry under the `@recruit41`
scope. No registry configuration or token is needed.

```
npm install @recruit41/recording-player
```

`react` and `react-dom` (both `>=18`) are peer dependencies. The build ships ESM
(`dist/index.js`), CommonJS (`dist/index.cjs`), and TypeScript declarations
(`dist/index.d.ts`).

## Quick start

Recording data comes from two partner API routes, one per stage:

```
GET /asyncapi/partner/v1/interviews/{interview_id}/raw-recordings
GET /asyncapi/partner/v1/assessments/{assessment_id}/raw-recordings
```

The partner API key must stay on your server. Your backend calls those routes
with the key and forwards each JSON body to the browser unchanged. The browser
never sees the key. A stage the candidate never reached stays `null`.

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RecordingPlayer,
  type CandidateRecordings,
} from '@recruit41/recording-player';

function Recordings({
  interviewId,
  assessmentId,
}: {
  interviewId: number | null;
  assessmentId: number | null;
}) {
  const [recordings, setRecordings] = useState<CandidateRecordings | null>(null);
  const seekRef = useRef<((seconds: number) => void) | null>(null);

  // Each fetch hits your own backend, which proxies the partner API.
  const load = useCallback(async () => {
    const [interview, coding_assessment] = await Promise.all([
      interviewId
        ? fetch(`/api/interviews/${interviewId}/recording`).then((r) => r.json())
        : null,
      assessmentId
        ? fetch(`/api/assessments/${assessmentId}/recording`).then((r) => r.json())
        : null,
    ]);
    setRecordings({ interview, coding_assessment });
  }, [interviewId, assessmentId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!recordings) return null;
  return (
    <RecordingPlayer
      recordings={recordings}
      onRefresh={load}
      onTimeUpdate={(seconds, stage) => console.log(stage, seconds)}
      seekRef={seekRef}
      onStageChange={(stage) => console.log('now showing', stage)}
    />
  );
}
```

## Props

Only `recordings` is required.

| Prop            | Type                                                       | What it does                                                                                                                           |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings`    | `CandidateRecordings`                                      | The two raw-recording responses under `interview` and `coding_assessment`, either one `null`. The player shows the stages that carry a recording. |
| `onRefresh`     | `() => void`                                               | Called when a media element fails to load, and once about a minute before a stage's `expires_at`. Re-fetch and pass the new payload in. |
| `onTimeUpdate`  | `(seconds: number, stage: RecordingStage) => void`         | Fires during playback with the current position on the stage's ruler. Use it to follow along in a transcript.                            |
| `seekRef`       | `MutableRefObject<((seconds: number) => void) \| null>`    | After mount, calling `seekRef.current(seconds)` seeks the stage on screen and resumes playback. Use it for click-to-seek from a transcript. |
| `onStageChange` | `(stage: RecordingStage) => void`                          | Fires when the viewer switches between the interview and the coding assessment.                                                          |

## Data shape

Both stage responses share one shape. `RecordingStage` is
`'interview' | 'coding_assessment'`.

```ts
interface CandidateRecordings {
  interview: StageRecording | null;
  coding_assessment: StageRecording | null;
}

interface StageRecording {
  recording_available: boolean;
  expires_at: string | null;
  tracks: RecordingTracks;
  transcript: TranscriptSection[];
}

interface RecordingTracks {
  camera: RecordingSegment[];
  screen: RecordingSegment[];
  mic: RecordingSegment[];
  bot_mic: RecordingSegment[];
}

interface RecordingSegment {
  url: string;
  started_at: number | null;
  ended_at: number | null;
}
```

`CandidateRecordings`, `StageRecording`, `RecordingTracks`, `RecordingSegment`,
`RecordingStage`, `TranscriptSection`, `TranscriptMessage`, and
`RecordingPlayerProps` are all exported.

## Behaviour

- **Stage switching.** When both stages have `recording_available: true`, a tab
  strip appears and each stage keeps its own playback position. With one stage
  the player renders it directly. With none it shows a "No recording available"
  empty state. A stage whose `recording_available` is `false` is skipped.
- **Multi-track sync.** LiveKit recordings arrive as per-track segments (camera,
  screen, mic, bot_mic) carrying wall-clock bounds; the player collapses them
  onto a shared ruler and keeps the tracks in sync. Daily recordings, and merged
  LiveKit sessions, arrive as one stitched file per track with no bounds; the
  player measures its duration and places it from the start.
- **Seeking.** The scrubber, the skip buttons, the arrow keys, and
  `seekRef.current(seconds)` all seek and then resume playback.
- **Expiring URLs.** The signed media URLs expire; each stage response carries an
  `expires_at`. On `onRefresh`, replace the `recordings` prop with a freshly
  fetched payload. The player swaps the URLs in place and keeps the position and
  play state. It calls `onRefresh` once per payload.
- **Transcript.** `StageRecording.transcript` holds the sections and messages but
  the component does not render them. Render the transcript yourself and drive
  seeks through `seekRef`.

## Development

```
npm install
npm test           # vitest
npm run typecheck  # tsc
npm run build      # dist/index.js, dist/index.cjs, dist/index.d.ts
```

`probe/` drives the built package in real Chrome against a `CandidateRecordings`
payload you supply, to verify playback, seeking, and URL refresh against real
recordings. See `probe/run_probe.mjs` and run it with `npm run probe`.

## Releasing

Publishing is automated by `.github/workflows/release.yml`. Push a tag of the
form `v<version>` that matches the `version` in `package.json`; the workflow
runs the tests and build, checks the tag against `package.json`, and runs
`npm publish --provenance --access public`. It needs an `NPM_TOKEN` repository
secret with publish rights on the `@recruit41` scope.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
