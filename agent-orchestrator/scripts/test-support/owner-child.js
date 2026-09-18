'use strict';

const { acquireWorkspaceOwner, resolveWorkspace } = require('../workspace-owner');

process.send({ ready: true });
process.once('message', async ({ workdir, runtimeRoot }) => {
  try {
    const owner = await acquireWorkspaceOwner(resolveWorkspace(workdir), { _runtimeRoot: runtimeRoot });
    owner.setReadiness('live_dispatch_disabled');
    process.send({ acquired: true, discoveryPath: owner.discoveryPath });
    process.on('message', async (message) => {
      if (message === 'release') {
        await owner.release();
        process.exit(0);
      }
    });
  } catch (error) {
    process.send({ acquired: false, code: error.code, error: error.message });
    process.exitCode = 0;
    process.disconnect();
  }
});
