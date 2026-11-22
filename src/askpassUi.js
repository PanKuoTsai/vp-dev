'use strict';
// Password login to the simulation host (vpStudio.remote.auth): the askpass server and the stored password.
const vscode = require('vscode');
const path = require('path');
const askpass = require('../lib/sim/askpass');
const shared = require('./shared');
const common = require('./common');

// ssh asks through VP Studio's askpass program (lib/sim/askpass.js); the password
// is asked once in VS Code and kept in this window's memory, or, when the user
// chooses so, in VS Code's secret storage (the Windows Credential Manager, the
// login keyring on Linux).

const sshPasswords = new Map();   // "<host>|<what>" -> password, this window only
const askingPassword = new Map(); // the same key -> the pending input box, so parallel ssh calls ask once
const newPasswords = new Set();   // hosts whose password was just typed: offer to remember it once it works
const secretKey = (host) => `vpStudio.ssh.password.${host}`;

/** Start the askpass server (when password login is set or chosen). */
function ensureAskpass() {
  if (shared.askpassServer) return Promise.resolve(shared.askpassServer);
  if (!shared.askpassStarting) {
    shared.askpassError = undefined;
    shared.askpassStarting = askpass.startServer(askpassAnswer).then((srv) => {
      try {
        shared.askpassLauncher = askpass.writeLauncher(path.join(shared.extContext.globalStorageUri.fsPath, 'askpass'));
      } catch (e) {
        srv.close();
        throw e;
      }
      shared.askpassServer = srv;
      return srv;
    });
    shared.askpassStarting.catch((e) => {
      shared.askpassStarting = undefined;
      shared.askpassError = e;
      common.outputChannel().appendLine(`Password login could not start: ${e.message}`);
    });
  }
  return shared.askpassStarting;
}

/** rc.askpass for a host: the ssh environment and what to do when the password is refused or accepted. */
function askpassFor(host) {
  if (!shared.askpassServer) {
    const why = shared.askpassError;
    ensureAskpass().catch(() => {});
    throw new Error(why ? `Password login could not start: ${why.message}` : 'Password login is starting; try again in a moment.');
  }
  // The Windows copy of the launcher (non-ASCII user folders) is checked before each use.
  if (common.IS_WINDOWS && !askpass.launcherIntact(shared.askpassLauncher)) shared.askpassLauncher = askpass.writeLauncher('');
  return {
    env: askpass.sshEnv({ launcher: shared.askpassLauncher, node: process.execPath, port: shared.askpassServer.port, token: shared.askpassServer.token, host }),
    onRefused: () => forgetPassword(host, { keepStored: false }),
    onAccepted: () => offerRememberPassword(host),
  };
}

/** Answer one ssh prompt: a password (asked once), "no" to yes/no questions. */
async function askpassAnswer({ host, prompt, kind }) {
  if (kind === 'confirm') return 'no'; // an unknown or changed host key: not accepted silently
  // A key's passphrase or a one-time code is asked every time; the host password once.
  const reusable = kind === 'password' && !/passphrase|verification|one-time|OTP|token/i.test(prompt);
  const key = `${host}|${reusable ? 'password' : prompt}`;
  if (reusable && sshPasswords.has(key)) return sshPasswords.get(key);
  if (reusable) {
    try {
      const stored = await shared.extContext.secrets.get(secretKey(host));
      if (stored) { sshPasswords.set(key, stored); return stored; }
    } catch (e) { /* no secret storage here */ }
  }
  if (askingPassword.has(key)) return askingPassword.get(key);
  const asking = Promise.resolve(vscode.window.showInputBox({
    title: `VP Studio: ssh ${host}`,
    prompt: reusable ? `${prompt.trim()} (VP Studio keeps it while this window is open)` : prompt.trim(),
    password: kind !== 'other' || /pass|code|PIN/i.test(prompt),
    ignoreFocusOut: true,
  })).then((v) => {
    askingPassword.delete(key);
    if (v === undefined) return null;
    if (reusable) { sshPasswords.set(key, v); newPasswords.add(host); }
    return v;
  });
  askingPassword.set(key, asking);
  return asking;
}

/** After the first login with a typed password: keep it in the secret storage? */
function offerRememberPassword(host) {
  if (!newPasswords.delete(host)) return;
  vscode.window.showInformationMessage(`Logged in to ${host} with the password. Remember it in VS Code's secret storage, so VP Studio does not ask in the next sessions?`,
    'Remember', 'This Session Only').then(async (pick) => {
    if (pick !== 'Remember') return;
    const pw = sshPasswords.get(`${host}|password`);
    if (pw === undefined) return;
    try { await shared.extContext.secrets.store(secretKey(host), pw); } catch (e) { vscode.window.showWarningMessage(`Could not store the password: ${e.message}`); }
  });
}

/** Forget a host's password (a refused one, or on request). */
async function forgetPassword(host, { keepStored = false } = {}) {
  sshPasswords.delete(`${host}|password`);
  newPasswords.delete(host);
  if (!keepStored) { try { await shared.extContext.secrets.delete(secretKey(host)); } catch (e) { /* none */ } }
}

/**
 * When key login was refused and the server takes passwords: offer to switch
 * to password login. Resolves true when switched.
 */
async function offerPasswordLogin(rc, err) {
  if (!rc || rc.askpass || !err || !askpass.offersPassword(err.sshStderr)) return false;
  const pick = await vscode.window.showWarningMessage(`${rc.host} did not accept a key login, but it takes a password.`, {
    modal: true,
    detail: 'VP Studio can log in with your password instead: it asks once and keeps it while this window is open (you can also have it remembered). A key login (ssh-keygen, then add the public key to ~/.ssh/authorized_keys on the host) needs no password at all.',
  }, 'Use Password');
  if (pick !== 'Use Password') return false;
  await ensureAskpass();
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await common.cfg().update('remote.auth', 'password', target);
  return true;
}

/** Forget Remote Password: the current host's, from this session and the secret storage. */
async function cmdForgetPassword() {
  const host = String(common.cfg().get('remote.host') || '').trim();
  if (!host) { vscode.window.showInformationMessage('No simulation host is set.'); return; }
  await forgetPassword(host);
  vscode.window.showInformationMessage(`VP Studio forgot the password of ${host}.${common.cfg().get('remote.auth') === 'password' ? ' It asks again at the next login.' : ''}`);
}

Object.assign(exports, { ensureAskpass, askpassFor, offerPasswordLogin, cmdForgetPassword });
