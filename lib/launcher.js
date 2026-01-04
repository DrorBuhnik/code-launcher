import Gio from 'gi://Gio';

import {
  findInPath,
  findToolboxScript,
  ideCmdForKey,
  shSingleQuote,
} from './utils.js';

export function launchProject(projectPath, ideKey, notifyError) {
  const cmd = ideCmdForKey(ideKey);
  const cmdPath = findInPath(cmd) ?? findToolboxScript(cmd);

  if (!cmdPath) {
    notifyError?.(`Could not find "${cmd}" in PATH or Toolbox scripts.`);
    return;
  }

  const shellLine = `${shSingleQuote(cmdPath)} ${shSingleQuote(projectPath)}`;
  try {
    const p = new Gio.Subprocess({
      argv: ['/bin/sh', '-lc', shellLine],
      flags: Gio.SubprocessFlags.NONE,
    });
    p.spawn_async?.(null);
  } catch (e) {
    notifyError?.(`Failed to launch ${cmd}: ${e}`);
  }
}
