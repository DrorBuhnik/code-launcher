import Gio from 'gi://Gio';

import {
  findInPath,
  findToolboxScript,
  ideCmdForKey,
  shSingleQuote,
} from './utils.js';

/**
 * Launch a project via a JetBrains Toolbox script or PATH command.
 *
 * @param {string} projectPath
 * @param {string} ideKey
 * @param {(msg:string)=>void} notifyError
 */
export function launchProject(projectPath, ideKey, notifyError) {
  const cmd = ideCmdForKey(ideKey);

  const cmdPath = findToolboxScript(cmd) ?? findInPath(cmd);
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
