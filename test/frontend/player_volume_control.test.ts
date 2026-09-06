const { clampVolume, toggledVolume, volumePercent } = await import(
  new URL("../../web/src/components/PlayerVolumeControl.ts", import.meta.url).href,
);

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

assert(clampVolume(-0.2) === 0 && clampVolume(1.2) === 1, "volume input is constrained to the player range");
assert(volumePercent(0.126) === 13 && volumePercent(0.994) === 99, "live display rounds the player volume to a whole percent");
assert(toggledVolume(0.4, 0.4) === 0, "the sound button mutes an audible player");
assert(toggledVolume(0, 0.37) === 0.37 && toggledVolume(0, 0) === 0.5, "unmuting restores the audible level or a usable default");

process.exit(failures ? 1 : 0);
