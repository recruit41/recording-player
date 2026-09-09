# @recruit41/recording-player

React component that plays a candidate's Recruit41 recordings: the AI interview
and the coding assessment. There is one partner route per stage, so the caller
fetches the stages it has ids for and passes them in under their stage keys:

```
GET /asyncapi/partner/v1/interviews/{interview_id}/raw-recordings
GET /asyncapi/partner/v1/assessments/{assessment_id}/raw-recordings
```

## Install

The package is published to GitHub Packages under the `@recruit41` scope.

```
# .npmrc
@recruit41:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```
npm install @recruit41/recording-player
```

React 18 or newer is a peer dependency. There are no other runtime
dependencies, and the component injects its own stylesheet, so no CSS import
or Tailwind setup is needed on the host.

## Use

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

  const load = useCallback(async () => {
    // Your backend calls the partner API with the partner key and returns each
    // JSON body unchanged. A stage the candidate never reached stays null.
    const [interview, coding_assessment] = await Promise.all([
      interviewId ? fetch(`/api/interviews/${interviewId}/recording`).then((r) => r.json()) : null,
      assessmentId ? fetch(`/api/assessments/${assessmentId}/recording`).then((r) => r.json()) : null,
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

### Props

| Prop            | Type                                              | Purpose                                                                                                                          |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `recordings`    | `CandidateRecordings`                             | The two raw-recording responses under `interview` and `coding_assessment`, either one null. The component picks the stages that carry a recording. |
| `onRefresh`     | `() => void`                                      | Called when a media file fails to load, or one minute before a stage's `expires_at`, which is shorter for a stitched recording than for per-track segments. Fetch again and pass the new payload in. |
| `onTimeUpdate`  | `(seconds: number, stage: RecordingStage) => void` | Fires about four times a second during playback with the position on the stage's ruler. Use it to highlight a transcript.        |
| `seekRef`       | `MutableRefObject<((seconds: number) => void) \| null>` | After mount, `seekRef.current(seconds)` seeks the stage on screen and plays. Use it for click-to-seek from a transcript.          |
| `onStageChange` | `(stage: RecordingStage) => void`                 | Fires when the viewer switches between the interview and the coding assessment.                                                  |

### Behaviour

- When both `interview` and `coding_assessment` carry a recording, a stage
  switcher appears and each stage remembers its position. With one stage the
  player renders it directly; with none it shows an empty state.
- Signed URLs expire. On `onRefresh`, replace the `recordings` prop with the new
  payload: the player swaps the URLs in place and keeps the position and play
  state.
- The transcript is not rendered. `recordings.interview.transcript` holds the
  sections and messages; render them yourself and drive seeks through
  `seekRef`. Ruler seconds count from the start of the candidate's video.
- Every seek entry point resumes playback: the scrubber, the 10-second skips,
  the arrow keys, and `seekRef`.

### Browser support

Recordings are WebM (VP8 video, Opus audio) or MP4 for older Daily-recorded
interviews, with candidate audio arriving as WebM/Opus for new recordings and
Ogg/Opus for older ones. Chrome, Edge and Firefox play all of these. Safari has
never played Ogg/Opus, and WebM/Opus in an `<audio>` element on Safari is not
yet verified.

## Develop

```
npm install
npm test
npm run typecheck
npm run build      # dist/index.js, dist/index.cjs, dist/index.d.ts
```

The sync engine in `src/timeline.ts` is the same wall-clock model Recruit41's own
review UI uses: per-track segments with nanosecond bounds are collapsed onto a
ruler defined by the candidate's video, one track drives the clock, and the
others follow it by rate nudges (audio) or threshold seeks (video).

### Verify against real recordings

`probe/` drives the built package in real Chrome against a `CandidateRecordings`
payload you supply. Drop `<name>.json` into `probe/host/fixtures/` (git-ignored,
since payloads carry signed URLs), and optionally `<name>.refresh1.json` with
re-signed URLs for the refresh check. The URLs may be signed partner URLs, or
files you place under `probe/host/fixtures/media/`, which the host serves with
byte-range support.

```
npm install
npm run build && npm pack --pack-destination probe
(cd probe/host && npm install && npx vite --port 5199 --strictPort --host 127.0.0.1 &)
node probe/run_probe.mjs <name> [--refresh] [--stage]
```

Each run reports pass/fail per check (mount, playback progress, cross-track
spread, seek, session boundary, tail seek, URL refresh, stage switch) and writes
screenshots and a JSON report to `probe/out/`. Chrome must be installed: MP4
recordings are H.264, which the browsers Playwright bundles do not decode.

## License

Apache License 2.0. See [LICENSE](LICENSE).
