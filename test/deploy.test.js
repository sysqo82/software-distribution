import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCleanupScript, buildInstallScript, buildLaunchScript, deploy, validateRequest } from '../lib/deploy.js';

const base = { targetPc: '192.168.1.20', fileName: 'App.msi', silentFlags: '', launchPath: 'C:\\App\\a.exe' };

test('validates and trims input', () => {
  assert.deepEqual(validateRequest({ ...base, targetPc: ' pc-1 ' }).targetPc, 'pc-1');
  assert.throws(() => validateRequest({ ...base, targetPc: 'pc;calc' }), /hostname/);
  assert.throws(() => validateRequest({ ...base, fileName: '..\\evil.msi' }), /installer/);
  assert.throws(() => validateRequest({ ...base, fileName: 'a.zip' }), /installer/);
  assert.throws(() => validateRequest({ ...base, silentFlags: '/S; calc' }), /flags/);
  assert.throws(() => validateRequest({ ...base, launchPath: 'app.exe' }), /Launch path/);
  assert.throws(() => validateRequest({ ...base, launchPath: '' }), /Launch path/);
});

test('builds the MSI command from the PDR', () => {
  assert.match(
    buildInstallScript(base),
    /msiexec\.exe' -ArgumentList @\('\/i', '"C:\\Windows\\Temp\\App\.msi"', '\/qn', '\/norestart', 'ALLUSERS=1'\)/
  );
});

test('builds the EXE command with silent flags', () => {
  const script = buildInstallScript({ fileName: 'Setup.exe', silentFlags: '/VERYSILENT', launchPath: 'C:\\App\\a.exe' });
  assert.match(script, /Start-Process -FilePath 'C:\\Windows\\Temp\\Setup\.exe' -ArgumentList '\/VERYSILENT' -PassThru/);
  assert.match(script, /WaitForExit\(600000\)/);
  assert.match(script, /taskkill\.exe \/T \/F/);
  assert.match(script, /exit 1460/);
});

test('cleanup also kills a stuck msiexec started from a temp extraction folder', () => {
  const script = buildCleanupScript({ fileName: 'Setup.exe' });
  assert.match(script, /Name='msiexec\.exe'/);
  assert.match(script, /Remove-Item -Path 'C:\\Windows\\Temp\\Setup\*\.exe'/);
});

test('cleanup removes every earlier version of the installer', () => {
  const script = buildCleanupScript({ fileName: 'DeezerScrobbler-1.3.1.exe' });
  assert.match(script, /Remove-Item -Path 'C:\\Windows\\Temp\\DeezerScrobbler\*\.exe'/);
});

test('escapes single quotes in the launch path', () => {
  assert.match(buildLaunchScript({ launchPath: "C:\\Program Files\\O'Neil\\a.exe" }), /O''Neil/);
});

test('launches elevated and verifies the app is running', () => {
  const script = buildLaunchScript({ launchPath: 'C:\\Program Files\\Deezer\\DeezerScrobbler.exe' });
  assert.match(script, /-RunLevel Highest/);
  assert.match(script, /Get-Process -Name 'DeezerScrobbler'/);
  assert.match(script, /exit 1/);
  assert.match(script, /conhost\.exe' -Argument \('--headless powershell\.exe/);
});

test('copies, installs, then launches', async () => {
  const calls = [];
  const remote = {
    copyFile: async (...args) => calls.push(['copy', ...args]),
    runPowerShell: async (host, script) => {
      calls.push(['run', host, script.split('\n')[0]]);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  };
  const message = await deploy({ ...base, launchPath: 'C:\\App\\a.exe' }, '/tmp/x.msi', remote);
  assert.deepEqual(calls.map((call) => call[0]), ['run', 'copy', 'run', 'run']);
  assert.match(calls[0][2], /Stop-Process|Get-Process/);
  assert.equal(calls[1][3], 'Windows\\Temp\\App.msi');
  assert.match(message, /launched/);
});

test('fails on a bad installer exit code and skips launch', async () => {
  const scripts = [];
  const remote = {
    copyFile: async () => {},
    runPowerShell: async (host, script) => {
      scripts.push(script);
      return { exitCode: 1603, stdout: '', stderr: 'boom' };
    }
  };
  await assert.rejects(deploy({ ...base, launchPath: 'C:\\App\\a.exe' }, 'x', remote), /1603/);
  assert.equal(scripts.length, 2);
});

test('treats 3010 as success with a reboot note', async () => {
  const remote = {
    copyFile: async () => {},
    runPowerShell: async (host, script) => ({ exitCode: script.includes('msiexec') ? 3010 : 0, stdout: '', stderr: '' })
  };
  assert.match(await deploy(base, 'x', remote), /reboot is pending/);
});
