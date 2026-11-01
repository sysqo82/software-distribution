import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runnerScript = fileURLToPath(new URL('../remote/run_ps.py', import.meta.url));

function credentials() {
  const { REMOTE_USER: user, REMOTE_PASSWORD: password } = process.env;
  if (!user || !password) {
    throw new Error('REMOTE_USER and REMOTE_PASSWORD must be set in the .env file.');
  }
  return { user, password };
}

function run(file, args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ exitCode, stdout, stderr: stderr || (error && typeof error.code !== 'number' ? error.message : '') });
    });
    if (input) {
      child.stdin.end(input);
    }
  });
}

export async function copyFile(host, localFile, remoteRelativePath) {
  const { user, password } = credentials();
  const result = await run(
    'smbclient',
    [`//${host}/C$`, '-U', user.replace(/^\.\\/, ''), '-c', `put "${localFile}" "${remoteRelativePath}"`],
    { env: { PASSWD: password } }
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0 || /NT_STATUS_|Connection .* failed/i.test(output)) {
    throw new Error(`SMB file transfer failed: ${output.trim()}`);
  }
}

export async function runPowerShell(host, script) {
  const { user, password } = credentials();
  const result = await run('python3', [runnerScript], {
    input: JSON.stringify({ host, script }),
    env: { REMOTE_USER: user, REMOTE_PASSWORD: password }
  });
  if (!result.stdout.startsWith('{')) {
    throw new Error(`WinRM failed: ${result.stderr.trim()}`);
  }
  const { exitCode, stdout, stderr } = JSON.parse(result.stdout);
  return { exitCode, stdout, stderr };
}
