import { createPlayerKeyboardShortcutHandler } from "../../web/src/lib/playerKeyboardShortcuts";
import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
const assert = (condition: unknown, message: string) => {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
};

interface TestEventOptions {
  code?: string;
  target?: EventTarget | null;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

function keyboardEvent(key: string, options: TestEventOptions = {}) {
  let prevented = false;
  const event = {
    key,
    code: options.code ?? "",
    target: options.target ?? null,
    repeat: options.repeat ?? false,
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    altKey: options.altKey ?? false,
    defaultPrevented: options.defaultPrevented ?? false,
    isComposing: options.isComposing ?? false,
    preventDefault: () => { prevented = true; },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
}

let hasTrack = true;
let currentTime = 50;
let duration = 100;
let volume = 0.5;
let toggles = 0;
let previous = 0;
let next = 0;
const seeks: number[] = [];
const volumes: number[] = [];

const handle = createPlayerKeyboardShortcutHandler({
  hasTrack: () => hasTrack,
  currentTime: () => currentTime,
  duration: () => duration,
  volume: () => volume,
  toggle: () => { toggles++; },
  previous: () => { previous++; },
  next: () => { next++; },
  seek: (seconds) => { seeks.push(seconds); currentTime = seconds; },
  setVolume: (value) => { volumes.push(value); volume = value; },
});

for (const [key, code] of [[" ", "Space"], ["k", "KeyK"]]) {
  const input = keyboardEvent(key, { code });
  handle(input.event);
  assert(input.prevented(), `${code} consumes the page-level key event`);
}
assert(toggles === 2, "Space and K toggle playback");

handle(keyboardEvent("ArrowRight").event);
handle(keyboardEvent("j").event);
assert(seeks.join(",") === "55,45", "arrow and J/L shortcuts seek by their conventional offsets");
currentTime = 2;
handle(keyboardEvent("ArrowLeft").event);
currentTime = 98;
handle(keyboardEvent("l").event);
assert(seeks.slice(-2).join(",") === "0,100", "keyboard seeking clamps to the track bounds");

handle(keyboardEvent("ArrowUp").event);
handle(keyboardEvent("ArrowDown").event);
assert(volumes.slice(-2).join(",") === "0.55,0.5", "arrow keys adjust volume in five-percent steps");
handle(keyboardEvent("m").event);
handle(keyboardEvent("m").event);
assert(volumes.slice(-2).join(",") === "0,0.5", "M restores the volume that was active before muting");

handle(keyboardEvent("N", { shiftKey: true }).event);
handle(keyboardEvent("P", { shiftKey: true }).event);
handle(keyboardEvent("n").event);
assert(next === 1 && previous === 1, "Shift+N/P changes track while unmodified letters remain free");

const repeatingToggle = keyboardEvent("k", { repeat: true });
handle(repeatingToggle.event);
assert(repeatingToggle.prevented() && toggles === 2, "held toggle keys do not flap playback state");
currentTime = 50;
handle(keyboardEvent("ArrowRight", { repeat: true }).event);
assert(currentTime === 55, "held seek keys continue stepping through the track");

const interactiveTarget = { closest: () => ({}) } as unknown as EventTarget;
const ignoredInput = keyboardEvent(" ", { code: "Space", target: interactiveTarget });
handle(ignoredInput.event);
const ignoredModified = keyboardEvent("ArrowRight", { ctrlKey: true });
handle(ignoredModified.event);
hasTrack = false;
const ignoredWithoutTrack = keyboardEvent(" ", { code: "Space" });
handle(ignoredWithoutTrack.event);
assert(
  !ignoredInput.prevented() && !ignoredModified.prevented() && !ignoredWithoutTrack.prevented() && toggles === 2,
  "editable controls, system modifiers, and an empty player retain their native keyboard behavior",
);

const playerBarSource = fs.readFileSync(path.resolve(__dirname, "../../web/src/components/PlayerBar.vue"), "utf8");
assert(
  playerBarSource.includes("Space / K")
    && playerBarSource.includes("Shift+P")
    && playerBarSource.includes("Shift+N")
    && playerBarSource.includes("↑ / ↓, M")
    && playerBarSource.includes("t('player.seekShortcut')"),
  "player controls disclose every supported shortcut group",
);
assert(playerBarSource.includes('step="0.01"'), "volume slider can represent five-percent keyboard steps exactly");

process.exit(failures ? 1 : 0);
