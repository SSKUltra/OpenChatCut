// The packaged version nails cwd to the .env.local path of userData:keystore and the default upload directory is anchored in
// process.cwd() (module top-level evaluation), use chdir once to let the two naturally fall into the user-writable area, server side
// Zero modifications. Must be evaluated before the import chain of embedded-server - keep this module in main.ts
// The first import (ESM is executed depth first in declaration order). dev (unpackaged) inherits the startup cwd (worktree root).
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { app } from 'electron';

// Real-weight packaged smoke must not touch the user's production profile.
if (process.env.CC_SMOKE === '1' && process.env.CC_SMOKE_USER_DATA_DIR) {
  const directory = process.env.CC_SMOKE_USER_DATA_DIR;
  if (!isAbsolute(directory)) throw new Error('CC_SMOKE_USER_DATA_DIR must be absolute');
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

if (app.isPackaged) {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
}
