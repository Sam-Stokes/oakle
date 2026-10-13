// Smoke test only: the built ROM boots in the emulator, takes its daily config, and starts in the Champion's room.
// Skipped until `npm run rom` has produced public/rom/oakle.gbc. Battle mechanics are the real game's, not tested here.
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {expect, it} from 'vitest';

const ROM = new URL('../public/rom/oakle.gbc', import.meta.url).pathname;
const {boot} = createRequire(import.meta.url)('./emu.cjs');

it.skipIf(!existsSync(ROM))('boots straight into the Champion\'s room with a patched config', async () => {
  const rom = Buffer.from(readFileSync(ROM));
  const {config} = JSON.parse(readFileSync(new URL('../public/rom/oakle.json', import.meta.url), 'utf8'));
  expect(rom.subarray(config, config + 5).toString('latin1')).toBe('OAKLE');
  rom[config + 6] = 2; // Oak's trainer number
  const emu = await boot(rom);
  emu.run(600);
  expect(emu.colors()).toBeGreaterThan(2); // the room and its text box are drawn
  expect(emu.extRam().length).toBe(32768);
}, 60_000);
