// makefun-site 1.0.0, the house entry, make.fun's own reference program: the harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. An entry keeps this driver and replaces solve.js with a
// faster module whose run(input) returns the same answer for every input. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
// --no-opt as well: every graded run is a fresh process over 3 cases, so
// TurboFan's optimisation cost (compiling the hot functions and the
// generated template functions) exceeds what the optimised code saves
// over so few runs; measured ~15% less CPU on a cold run with it off.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
// Each answer is written as it is produced, so no single string ever
// holds all the answers at once: the bytes are exactly JSON.stringify's
// of the array of answers ('[' + each answer + ',' ... + ']'), with a
// much smaller peak allocation.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let k = 0; k < cases.length; k++) {
  if (k > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[k].input)));
}
writeSync(fd, ']');
closeSync(fd);
