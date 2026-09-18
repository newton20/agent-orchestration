'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalPath } = require('./workspace-owner');

function assertArtifactPath(root, file) {
  const canonicalRoot = canonicalPath(root);
  if (canonicalRoot !== root) throw new Error('artifact workspace identity changed');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact path escapes canonical workspace');
  let directory = root;
  for (const part of relative.split(path.sep)) {
    directory = path.join(directory, part);
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink() || canonicalPath(directory) !== (process.platform === 'win32' ? directory.toLowerCase() : directory)) {
      throw new Error('artifact path contains a redirected link');
    }
  }
}

module.exports = { assertArtifactPath };
