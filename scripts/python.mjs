#!/usr/bin/env node
// Launches the repo's Python tools under whatever the host calls its interpreter.
//
// `python3` is the correct name everywhere except Windows, where it usually
// resolves to the App Execution Alias in `WindowsApps` — a real, executable stub
// that prints a localised "Python not found" and exits non-zero. That makes a
// Windows box fail as a *broken interpreter* rather than a missing one, which is
// why `npm run validate:art` died with exit 49 instead of anything diagnosable.
// The bundled `py` launcher finds the actual install.
//
// So probe candidates with `--version` and take the first that answers cleanly.
// Checking the exit code rejects the stub without anyone having to recognise its
// error message, which is translated into the user's display language.
//
//     node scripts/python.mjs scripts/validate-art.py [args...]
//
// Stdlib only on the Python side, and node-only here, so this adds no dependency.

import { spawnSync } from 'node:child_process';

const CANDIDATES =
  process.platform === 'win32'
    ? [
        ['py', ['-3']],
        ['python3', []],
        ['python', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];

function findInterpreter() {
  for (const [cmd, prefix] of CANDIDATES) {
    const probe = spawnSync(cmd, [...prefix, '--version'], {
      stdio: 'ignore',
      shell: false,
    });
    if (!probe.error && probe.status === 0) return [cmd, prefix];
  }
  return null;
}

const script = process.argv.slice(2);
if (script.length === 0) {
  console.error('usage: node scripts/python.mjs <script.py> [args...]');
  process.exit(2);
}

const found = findInterpreter();
if (!found) {
  const names = CANDIDATES.map(([c, p]) => [c, ...p].join(' ')).join(', ');
  console.error(
    `No working Python 3 found. Tried: ${names}.\n` +
      (process.platform === 'win32'
        ? 'Install Python from python.org (which provides the `py` launcher), or\n' +
          'disable the Store aliases under Settings > Apps > App execution aliases.'
        : 'Install Python 3 and make sure it is on PATH.'),
  );
  process.exit(1);
}

const [cmd, prefix] = found;
const run = spawnSync(cmd, [...prefix, ...script], {
  stdio: 'inherit',
  shell: false,
});

if (run.error) {
  console.error(`Failed to run ${cmd}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
