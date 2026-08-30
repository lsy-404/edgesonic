// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PlayerKeyboardControls {
  hasTrack: () => boolean;
  currentTime: () => number;
  duration: () => number;
  volume: () => number;
  toggle: () => void;
  previous: () => void;
  next: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
}

const INTERACTIVE_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "summary",
  "a[href]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='combobox']",
].join(",");

function isInteractiveTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selectors: string) => Element | null } | null;
  return typeof candidate?.closest === "function" && candidate.closest(INTERACTIVE_TARGETS) !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundedVolume(value: number): number {
  return Math.round(clamp(value, 0, 1) * 20) / 20;
}

export function createPlayerKeyboardShortcutHandler(controls: PlayerKeyboardControls): (event: KeyboardEvent) => void {
  let lastAudibleVolume = 0.8;

  return (event: KeyboardEvent) => {
    if (
      event.defaultPrevented
      || event.isComposing
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || !controls.hasTrack()
      || isInteractiveTarget(event.target)
    ) return;

    const key = event.key.toLowerCase();
    let action: (() => void) | null = null;
    let repeatable = false;

    if (event.shiftKey) {
      if (key === "n") action = controls.next;
      else if (key === "p") action = controls.previous;
      else return;
    } else if (event.code === "Space" || event.key === " ") {
      action = controls.toggle;
    } else if (key === "k") {
      action = controls.toggle;
    } else if (key === "m") {
      action = () => {
        const current = controls.volume();
        if (current > 0) {
          lastAudibleVolume = current;
          controls.setVolume(0);
        } else {
          controls.setVolume(lastAudibleVolume);
        }
      };
    } else if (key === "arrowleft" || key === "arrowright" || key === "j" || key === "l") {
      const delta = key === "arrowleft" ? -5 : key === "arrowright" ? 5 : key === "j" ? -10 : 10;
      action = () => controls.seek(clamp(controls.currentTime() + delta, 0, controls.duration()));
      repeatable = true;
    } else if (key === "arrowup" || key === "arrowdown") {
      const delta = key === "arrowup" ? 0.05 : -0.05;
      action = () => {
        const current = controls.volume();
        if (current > 0) lastAudibleVolume = current;
        controls.setVolume(roundedVolume(current + delta));
      };
      repeatable = true;
    }

    if (!action) return;
    event.preventDefault();
    if (!event.repeat || repeatable) action();
  };
}
