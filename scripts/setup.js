#!/usr/bin/env node
/** `npm run setup` — install every npm and non-npm dependency needed to run. */
'use strict';
const path = require('path');
const { setup } = require('../sdk/logic/app-scripts');

setup({
  appName: 'ai-mentat-minecraft',
  root: path.resolve(__dirname, '..'),
  // limactl is only needed on macOS, where BDS has no native build. `setup`
  // reports a missing binary rather than failing, which is right here: a Linux
  // or Windows user never needs it.
  system: process.platform === 'darwin' ? ['limactl'] : [],
  extra: () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    try {
      require('child_process').execSync('node scripts/download-lima.js', { stdio: 'inherit' });
    } catch {
      console.warn('    (lima download skipped — `brew install lima` also works)');
    }
  },
});
