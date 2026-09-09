import { vi } from 'vitest';

// jsdom ships no media stack. This stands up just enough of one for the
// player's seek path: metadata is always ready, a seek settles immediately,
// play/pause flip `paused` and fire their events, and every element reports the
// configured duration.
export interface MediaShim {
  counters: { seekWrites: number; playCalls: number; pauseCalls: number };
  reset(): void;
  setDuration(seconds: number, el?: HTMLMediaElement): void;
  fire(el: HTMLMediaElement, type: 'timeupdate' | 'ended' | 'error'): void;
  advance(el: HTMLMediaElement, fileTime: number): void;
}

export function installMediaShim(): MediaShim {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const times = new WeakMap<HTMLMediaElement, number>();
  const perElementDuration = new WeakMap<HTMLMediaElement, number>();
  const counters = { seekWrites: 0, playCalls: 0, pauseCalls: 0 };
  let duration = 60;
  const durationOf = (el: HTMLMediaElement) =>
    perElementDuration.get(el) ?? duration;

  const proto = HTMLMediaElement.prototype;
  Object.defineProperty(proto, 'readyState', {
    get: () => HTMLMediaElement.HAVE_METADATA,
    configurable: true,
  });
  Object.defineProperty(proto, 'seeking', {
    get: () => false,
    configurable: true,
  });
  Object.defineProperty(proto, 'duration', {
    get(this: HTMLMediaElement) {
      return durationOf(this);
    },
    configurable: true,
  });
  Object.defineProperty(proto, 'ended', {
    get(this: HTMLMediaElement) {
      return (times.get(this) ?? 0) >= durationOf(this);
    },
    configurable: true,
  });
  Object.defineProperty(proto, 'paused', {
    get(this: HTMLMediaElement) {
      return paused.get(this) ?? true;
    },
    configurable: true,
  });
  Object.defineProperty(proto, 'currentTime', {
    get(this: HTMLMediaElement) {
      return times.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      counters.seekWrites += 1;
      times.set(this, value);
    },
    configurable: true,
  });
  // Assigning a source "loads" it: metadata arrives on the next microtask, so
  // the duration probe resolves the way a real element would.
  const src = Object.getOwnPropertyDescriptor(proto, 'src');
  if (src?.set) {
    Object.defineProperty(proto, 'src', {
      get: src.get,
      set(this: HTMLMediaElement, value: string) {
        src.set!.call(this, value);
        queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
      },
      configurable: true,
    });
  }
  proto.play = vi.fn(function (this: HTMLMediaElement) {
    counters.playCalls += 1;
    // Browsers restart an ended element from the beginning on play().
    if ((times.get(this) ?? 0) >= durationOf(this)) times.set(this, 0);
    paused.set(this, false);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  proto.pause = vi.fn(function (this: HTMLMediaElement) {
    counters.pauseCalls += 1;
    if (paused.get(this) === false) {
      paused.set(this, true);
      this.dispatchEvent(new Event('pause'));
    }
  });

  return {
    counters,
    reset() {
      counters.seekWrites = 0;
      counters.playCalls = 0;
      counters.pauseCalls = 0;
    },
    setDuration(seconds: number, el?: HTMLMediaElement) {
      if (el) perElementDuration.set(el, seconds);
      else duration = seconds;
    },
    fire(el, type) {
      el.dispatchEvent(new Event(type));
    },
    advance(el, fileTime) {
      times.set(el, fileTime);
      el.dispatchEvent(new Event('timeupdate'));
    },
  };
}
