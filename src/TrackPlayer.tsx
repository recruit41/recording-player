import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { formatTime } from './format';
import {
  ChevronDownIcon,
  LoaderIcon,
  MaximizeIcon,
  MutedIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
} from './icons';
import {
  audioCorrection,
  buildTimeline,
  clampToClock,
  clockTrack,
  needsVideoSeek,
  nextSegment,
  rulerTrack,
  segmentAt,
  TRACK_NAMES,
  type SegmentWindow,
  type TrackName,
  type TrackSources,
} from './timeline';

export interface TrackPlayerProps {
  media: TrackSources;
  initialTime?: number;
  onTimeUpdate?: (seconds: number) => void;
  seekRef?: MutableRefObject<((seconds: number) => void) | null>;
  onMediaError?: (error: MediaError | null) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_S = 10;
// An in-buffer seek lands in tens of milliseconds; a spinner shown for those
// reads as "it reloaded again", so it only appears once a seek is actually slow.
const SPINNER_DELAY_MS = 200;

type Elements = Record<TrackName, HTMLMediaElement | null>;

function waitMeta(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('loadedmetadata', done);
      el.removeEventListener('error', done);
      resolve();
    };
    el.addEventListener('loadedmetadata', done, { once: true });
    el.addEventListener('error', done, { once: true });
  });
}

function waitSeeked(el: HTMLMediaElement): Promise<void> {
  if (!el.seeking) return Promise.resolve();
  return new Promise((resolve) =>
    el.addEventListener('seeked', () => resolve(), { once: true }),
  );
}

// A file can be shorter than the span its manifest claims (camera egress drops
// frames; a stitched file is trimmed). Seeking past the end parks the element
// at its last frame; a browser would otherwise restart it from zero on the next
// play(), which is what a viewer sees as the recording wrapping around.
function seekWithin(el: HTMLMediaElement, fileTime: number): void {
  const duration = el.duration;
  el.currentTime =
    Number.isFinite(duration) && duration > 0
      ? Math.min(fileTime, duration)
      : fileTime;
}

async function prepareEl(
  el: HTMLMediaElement,
  win: SegmentWindow | null,
): Promise<void> {
  if (!win) {
    el.pause();
    return;
  }
  if (el.src !== win.seg.url) {
    el.src = win.seg.url;
    await waitMeta(el);
  }
  seekWithin(el, win.fileTime);
  await waitSeeked(el);
}

function syncAudioEl(el: HTMLMediaElement, win: SegmentWindow, speed: number) {
  const { seekTo, playbackRate } = audioCorrection(
    win.fileTime,
    el.currentTime,
    speed,
  );
  if (seekTo !== null) seekWithin(el, seekTo);
  el.playbackRate = playbackRate;
}

function syncVideoEl(el: HTMLMediaElement, win: SegmentWindow) {
  if (needsVideoSeek(win.fileTime, el.currentTime)) {
    seekWithin(el, win.fileTime);
  }
}

const isAudio = (name: TrackName) => name === 'mic' || name === 'bot_mic';

export function TrackPlayer({
  media,
  initialTime = 0,
  onTimeUpdate,
  seekRef,
  onMediaError,
}: TrackPlayerProps) {
  const cameraRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const micRef = useRef<HTMLAudioElement>(null);
  const botRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);

  const clockWin = useRef<SegmentWindow | null>(null);
  const speedRef = useRef(1);
  const seekAC = useRef<AbortController | null>(null);
  const scrubbing = useRef(false);
  const spinnerTimer = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(initialTime);
  // Re-sourcing a follower is async and `timeupdate` fires about 4x/s, so
  // without this the same element gets a new src on every tick mid-load.
  const resourcing = useRef<Set<HTMLMediaElement>>(new Set());

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  const ruler = useMemo(() => rulerTrack(media), [media]);
  const timeline = useMemo(() => buildTimeline(media[ruler]), [media, ruler]);
  const clock = useMemo(() => clockTrack(media, timeline), [media, timeline]);
  const totalS = timeline.totalS;

  const elements = useCallback(
    (): Elements => ({
      camera: cameraRef.current,
      screen: screenRef.current,
      mic: micRef.current,
      bot_mic: botRef.current,
    }),
    [],
  );

  const layout =
    ruler === 'screen'
      ? 'screen'
      : segmentAt(media.screen, currentTime, timeline)
        ? 'split'
        : 'camera';

  const settleSpinner = useCallback(() => {
    if (spinnerTimer.current) window.clearTimeout(spinnerTimer.current);
    spinnerTimer.current = null;
    setIsBuffering(false);
  }, []);

  // A seek in a container with no index (Ogg audio) can settle a few
  // milliseconds shy of its target. When the clock file opened before the ruler
  // that puts the derived position just below zero, where no track has a
  // segment and nothing would play, so the position is held to the ruler.
  const rulerTime = useCallback(
    (clockEl: HTMLMediaElement) => {
      const win = clockWin.current;
      if (!win) return currentTimeRef.current;
      return Math.min(Math.max(clockEl.currentTime + win.startS, 0), totalS);
    },
    [totalS],
  );

  const seekAll = useCallback(
    (t: number): Promise<number | null> => {
      seekAC.current?.abort();
      const ac = new AbortController();
      seekAC.current = ac;
      if (spinnerTimer.current) window.clearTimeout(spinnerTimer.current);
      spinnerTimer.current = window.setTimeout(
        () => setIsBuffering(true),
        SPINNER_DELAY_MS,
      );

      const els = elements();
      const clockEl = els[clock];
      if (!clockEl) {
        settleSpinner();
        return Promise.resolve(null);
      }
      for (const name of TRACK_NAMES) els[name]?.pause();

      const target = clampToClock(t, media[clock], timeline);
      clockWin.current = segmentAt(media[clock], target, timeline);
      currentTimeRef.current = target;
      setCurrentTime(target);

      return Promise.all(
        TRACK_NAMES.map((name) => {
          const el = els[name];
          return el
            ? prepareEl(el, segmentAt(media[name], target, timeline))
            : Promise.resolve();
        }),
      ).then(() => {
        // A newer seek aborted us; the winning seek owns the spinner now.
        if (ac.signal.aborted) return null;
        seekAC.current = null;
        settleSpinner();
        return target;
      });
    },
    [media, timeline, clock, elements, settleSpinner],
  );

  const playAll = useCallback(
    (t: number) => {
      const els = elements();
      for (const name of TRACK_NAMES) {
        const el = els[name];
        if (el && !el.ended && segmentAt(media[name], t, timeline)) {
          el.play().catch(() => {});
        }
      }
    },
    [media, timeline, elements],
  );

  // Every seek entry point (scrubber, skips, host-driven seek) means "take me
  // there and keep playing"; a seek must never park the player.
  const seekAndPlay = useCallback(
    (t: number) => {
      seekAll(t).then((target) => {
        if (target !== null) playAll(target);
      });
    },
    [seekAll, playAll],
  );

  useEffect(() => {
    if (!seekRef) return;
    seekRef.current = seekAndPlay;
    return () => {
      seekRef.current = null;
    };
  }, [seekRef, seekAndPlay]);

  // Mount, and every later change of `media` (a URL refresh or a re-fetched
  // payload): park all four elements on the current position, then resume if
  // the viewer was watching.
  useEffect(() => {
    const els = elements();
    if (els.camera) els.camera.muted = true;
    if (els.screen) els.screen.muted = true;
    // The sync loop trims audio rate by a few percent; without this the
    // correction is audible as a pitch bend rather than nothing at all.
    if (els.mic) els.mic.preservesPitch = true;
    if (els.bot_mic) els.bot_mic.preservesPitch = true;

    const wasPlaying = isPlayingRef.current;
    seekAll(currentTimeRef.current).then((target) => {
      if (target !== null && wasPlaying) playAll(target);
    });
  }, [media, elements, seekAll, playAll]);

  useEffect(() => {
    const els = elements();
    const handlers = TRACK_NAMES.map((name) => {
      const el = els[name];
      const handler = () => onMediaError?.(el?.error ?? null);
      el?.addEventListener('error', handler);
      return () => el?.removeEventListener('error', handler);
    });
    return () => handlers.forEach((off) => off());
  }, [media, elements, onMediaError]);

  // Clock-track wiring: global time, follower sync, segment advance.
  useEffect(() => {
    const els = elements();
    const clockEl = els[clock];
    if (!clockEl) return;
    const clockSegs = media[clock];

    const follow = (
      el: HTMLMediaElement | null,
      win: SegmentWindow | null,
      audio: boolean,
      speed: number,
    ) => {
      if (!el || el === clockEl) return;
      if (!win) {
        if (!el.paused) el.pause();
        return;
      }
      // A follower that has crossed into a new segment needs a fresh source,
      // which a seek cannot express.
      if (el.src !== win.seg.url) {
        if (resourcing.current.has(el)) return;
        resourcing.current.add(el);
        prepareEl(el, win)
          .then(() => {
            if (!clockEl.paused) el.play().catch(() => {});
          })
          .finally(() => resourcing.current.delete(el));
        return;
      }
      if (resourcing.current.has(el)) return;
      // A follower whose file ran out ahead of the ruler holds its last frame.
      if (el.ended) return;
      if (audio) syncAudioEl(el, win, speed);
      else syncVideoEl(el, win);
      if (!clockEl.paused && el.paused && !el.ended) el.play().catch(() => {});
    };

    const onTime = () => {
      if (seekAC.current) return;
      // Mid-drag the scrubber owns the position; playback must not fight the
      // viewer's thumb.
      if (scrubbing.current) return;
      if (!clockWin.current) return;
      const t = rulerTime(clockEl);
      currentTimeRef.current = t;
      setCurrentTime(t);
      onTimeUpdate?.(t);

      const speed = speedRef.current;
      for (const name of TRACK_NAMES) {
        if (name === clock) continue;
        follow(
          els[name],
          segmentAt(media[name], t, timeline),
          isAudio(name),
          speed,
        );
      }
    };

    const onPlay = () => {
      isPlayingRef.current = true;
      setIsPlaying(true);
    };
    const onPause = () => {
      isPlayingRef.current = false;
      setIsPlaying(false);
      for (const name of TRACK_NAMES) {
        if (name !== clock) els[name]?.pause();
      }
    };
    const onEnded = () => {
      if (!clockWin.current) return;
      const next = nextSegment(clockSegs, clockWin.current, timeline);
      if (!next) return;
      clockWin.current = next;
      prepareEl(clockEl, next).then(() => clockEl.play().catch(() => {}));
    };

    clockEl.addEventListener('timeupdate', onTime);
    clockEl.addEventListener('play', onPlay);
    clockEl.addEventListener('pause', onPause);
    clockEl.addEventListener('ended', onEnded);
    return () => {
      clockEl.removeEventListener('timeupdate', onTime);
      clockEl.removeEventListener('play', onPlay);
      clockEl.removeEventListener('pause', onPause);
      clockEl.removeEventListener('ended', onEnded);
    };
  }, [media, timeline, clock, elements, onTimeUpdate, rulerTime]);

  const handleScrub = (e: ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    currentTimeRef.current = t;
    setCurrentTime(t);
  };

  const commitScrub = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    seekAndPlay(Number((e.target as HTMLInputElement).value));
  };

  const handlePlay = () => {
    const clockEl = elements()[clock];
    const t = clockEl ? rulerTime(clockEl) : 0;
    // Pausing leaves every element parked at `t`, so resuming is just play().
    // Re-seeking here made pause then play look like a reload.
    if (!seekAC.current && clockWin.current) {
      playAll(t);
      return;
    }
    seekAC.current?.abort();
    seekAC.current = null;
    seekAndPlay(t);
  };

  const handlePause = () => {
    seekAC.current?.abort();
    seekAC.current = null;
    const els = elements();
    for (const name of TRACK_NAMES) els[name]?.pause();
  };

  const togglePlay = () => (isPlaying ? handlePause() : handlePlay());

  const skipForward = useCallback(() => {
    seekAndPlay(Math.min(currentTimeRef.current + SKIP_S, totalS));
  }, [seekAndPlay, totalS]);

  const skipBackward = useCallback(() => {
    seekAndPlay(Math.max(currentTimeRef.current - SKIP_S, 0));
  }, [seekAndPlay]);

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen().catch(() => {});
    }
  };

  // speedRef is what the sync loop multiplies its nudge against, so the two
  // never fight over playbackRate.
  useEffect(() => {
    speedRef.current = playbackSpeed;
    const els = elements();
    for (const name of TRACK_NAMES) {
      const el = els[name];
      if (el) el.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, elements]);

  useEffect(() => {
    if (micRef.current) micRef.current.muted = isMuted;
    if (botRef.current) botRef.current.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        skipForward();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        skipBackward();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [skipForward, skipBackward]);

  useEffect(() => {
    if (!showSpeedMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!speedMenuRef.current?.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showSpeedMenu]);

  useEffect(
    () => () => {
      seekAC.current?.abort();
      if (spinnerTimer.current) window.clearTimeout(spinnerTimer.current);
    },
    [],
  );

  return (
    <div className="r41rp-player" ref={containerRef} tabIndex={0}>
      <audio ref={micRef} preload="auto" />
      <audio ref={botRef} preload="auto" />

      {/* Both video elements stay mounted; only classes change between
          layouts, so a preloaded src survives a layout switch. */}
      <div className={`r41rp-stage r41rp-stage--${layout}`}>
        <div className="r41rp-pane r41rp-pane--screen">
          <video ref={screenRef} playsInline />
        </div>
        <div className="r41rp-pane r41rp-pane--camera">
          <video ref={cameraRef} playsInline />
        </div>
        {isBuffering && (
          <div className="r41rp-spinner" role="status" aria-label="Buffering">
            <LoaderIcon />
          </div>
        )}
      </div>

      <div className="r41rp-controls">
        <input
          type="range"
          className="r41rp-scrubber"
          aria-label="Seek"
          min={0}
          max={totalS || 0}
          step={0.5}
          value={currentTime}
          onChange={handleScrub}
          onPointerDown={() => {
            scrubbing.current = true;
          }}
          onPointerUp={commitScrub}
          onPointerCancel={commitScrub}
        />

        <div className="r41rp-toolbar">
          <button
            type="button"
            className="r41rp-btn"
            onClick={skipBackward}
            aria-label="Skip backward 10 seconds"
          >
            <SkipBackIcon />
          </button>
          <button
            type="button"
            className="r41rp-btn r41rp-play"
            onClick={togglePlay}
            disabled={isBuffering}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="r41rp-btn"
            onClick={skipForward}
            aria-label="Skip forward 10 seconds"
          >
            <SkipForwardIcon />
          </button>
          <span className="r41rp-time">
            {formatTime(currentTime)} / {formatTime(totalS)}
          </span>

          <div className="r41rp-toolbar-right">
            <button
              type="button"
              className="r41rp-btn"
              onClick={() => setIsMuted((prev) => !prev)}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MutedIcon /> : <VolumeIcon />}
            </button>

            <div className="r41rp-speed" ref={speedMenuRef}>
              <button
                type="button"
                className="r41rp-btn r41rp-speed-btn"
                onClick={() => setShowSpeedMenu((prev) => !prev)}
                aria-label="Change playback speed"
                aria-haspopup="menu"
                aria-expanded={showSpeedMenu}
              >
                {playbackSpeed}x
                <ChevronDownIcon />
              </button>
              {showSpeedMenu && (
                <div className="r41rp-speed-menu" role="menu">
                  {SPEEDS.map((speed) => (
                    <button
                      type="button"
                      key={speed}
                      role="menuitemradio"
                      aria-checked={playbackSpeed === speed}
                      className="r41rp-speed-option"
                      onClick={() => {
                        setPlaybackSpeed(speed);
                        setShowSpeedMenu(false);
                      }}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="r41rp-btn"
              onClick={toggleFullscreen}
              aria-label="Toggle fullscreen"
            >
              <MaximizeIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
