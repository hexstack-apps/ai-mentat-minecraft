#!/usr/bin/env node
/** `npm run build` — build for the current system into
 *  /.hexstack-app/ai-mentat-minecraft/ai-mentat-minecraft.<ext> */
'use strict';
const path = require('path');
const { build } = require('../sdk/logic/app-scripts');

build({ appName: 'ai-mentat-minecraft', root: path.resolve(__dirname, '..') });
