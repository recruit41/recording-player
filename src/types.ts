// Wire shapes of the two partner recording routes:
//   GET /asyncapi/partner/v1/interviews/{interview_id}/raw-recordings
//   GET /asyncapi/partner/v1/assessments/{assessment_id}/raw-recordings

export interface RecordingSegment {
  url: string;
  // Nanoseconds since the epoch. Null when the recording is a single stitched
  // file whose wall-clock span is unknown; the player then measures it.
  started_at: number | null;
  ended_at: number | null;
}

export interface RecordingTracks {
  camera: RecordingSegment[];
  screen: RecordingSegment[];
  mic: RecordingSegment[];
  bot_mic: RecordingSegment[];
}

export interface TranscriptMessage {
  role: string;
  content: string;
  timestamp: string | null;
  start_t_ms: number | null;
  t_ms: number | null;
}

export interface TranscriptSection {
  section_title: string;
  messages: TranscriptMessage[];
}

export interface StageRecording {
  recording_available: boolean;
  // ISO 8601. Every URL in `tracks` stops working at this instant.
  expires_at: string | null;
  tracks: RecordingTracks;
  transcript: TranscriptSection[];
}

// One route per stage, so the caller does the joining: put each response under
// its key, and null for a stage the candidate never reached.
export interface CandidateRecordings {
  interview: StageRecording | null;
  coding_assessment: StageRecording | null;
}

export type RecordingStage = 'interview' | 'coding_assessment';
