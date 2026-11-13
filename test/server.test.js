import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.js';
import { createTargetStore } from '../lib/targets.js';
import { createAppStore } from '../lib/apps.js';

async function start(remote, context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'targets-'));
  const server = createAppServer({ remote, targets: createTargetStore(directory), apps: createAppStore(directory) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function finishedJob(baseUrl, jobId) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = await (await fetch(`${baseUrl}/api/jobs/${jobId}`)).json();
    if (job.state !== 'running') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Job did not finish.');
}

const okRemote = {
  copyFile: async () => {},
  runPowerShell: async () => ({ exitCode: 0, stdout: '', stderr: '' })
};
const deployUrl = (baseUrl, target = 'pc-1') =>
  `${baseUrl}/api/deploy?targetPc=${target}&silentFlags=%2FS&launchPath=C%3A%5CApp%5Ca.exe`;

test('serves the dashboard assets', async (context) => {
  const baseUrl = await start(okRemote, context);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Push &amp; Install/);
  assert.equal((await fetch(`${baseUrl}/app.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/styles.css`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
});

test('a successful deploy reports success and remembers the PC', async (context) => {
  const seen = [];
  const remote = { ...okRemote, copyFile: async (host, local, remotePath) => seen.push([host, remotePath]) };
  const baseUrl = await start(remote, context);

  const response = await fetch(deployUrl(baseUrl), { method: 'POST', headers: { 'X-Filename': 'Setup.exe' }, body: 'binary' });
  assert.equal(response.status, 202);
  const job = await finishedJob(baseUrl, (await response.json()).jobId);

  assert.equal(job.state, 'success');
  assert.match(job.message, /Installed Setup\.exe on pc-1/);
  assert.equal(job.steps.length, 4);
  assert.deepEqual(seen, [['pc-1', 'Windows\\Temp\\Setup.exe']]);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/targets`)).json()).targets, ['pc-1']);
});

test('a failed deploy reports the error but still remembers the PC', async (context) => {
  const remote = { ...okRemote, copyFile: async () => { throw new Error('SMB down'); } };
  const baseUrl = await start(remote, context);

  const response = await fetch(deployUrl(baseUrl), { method: 'POST', headers: { 'X-Filename': 'a.exe' }, body: 'x' });
  const job = await finishedJob(baseUrl, (await response.json()).jobId);

  assert.equal(job.state, 'failed');
  assert.equal(job.message, 'SMB down');
  assert.deepEqual((await (await fetch(`${baseUrl}/api/targets`)).json()).targets, ['pc-1']);
});

test('rejects invalid requests and unknown jobs', async (context) => {
  const baseUrl = await start(okRemote, context);
  const invalid = await fetch(`${baseUrl}/api/deploy?targetPc=bad%3Bhost`, { method: 'POST', headers: { 'X-Filename': 'a.exe' } });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/jobs/nope`)).status, 404);
});

test('lists, orders and removes saved PCs', async (context) => {
  const baseUrl = await start(okRemote, context);
  for (const target of ['pc-1', 'pc-2', 'pc-1']) {
    const response = await fetch(deployUrl(baseUrl, target), { method: 'POST', headers: { 'X-Filename': 'a.exe' }, body: 'x' });
    await finishedJob(baseUrl, (await response.json()).jobId);
  }
  assert.deepEqual((await (await fetch(`${baseUrl}/api/targets`)).json()).targets, ['pc-1', 'pc-2']);

  const removed = await fetch(`${baseUrl}/api/targets?target=pc-1`, { method: 'DELETE' });
  assert.deepEqual((await removed.json()).targets, ['pc-2']);
});

test('saves switches and launch path per app, and removes them', async (context) => {
  const baseUrl = await start(okRemote, context);
  const push = async (flags, launch) => {
    const query = new URLSearchParams({ targetPc: 'pc-1', silentFlags: flags, launchPath: launch });
    const response = await fetch(`${baseUrl}/api/deploy?${query}`, { method: 'POST', headers: { 'X-Filename': 'a.exe' }, body: 'x' });
    await finishedJob(baseUrl, (await response.json()).jobId);
  };
  await push('/S', 'C:\\Old\\Lock.exe');
  await push('/qn', 'C:\\Deezer\\Deezer.exe');
  await push('/VERYSILENT', 'C:\\New\\Lock.exe');

  assert.deepEqual((await (await fetch(`${baseUrl}/api/apps`)).json()).apps, [
    { name: 'Lock', silentFlags: '/VERYSILENT', launchPath: 'C:\\New\\Lock.exe' },
    { name: 'Deezer', silentFlags: '/qn', launchPath: 'C:\\Deezer\\Deezer.exe' }
  ]);
  const removed = await fetch(`${baseUrl}/api/apps?name=Lock`, { method: 'DELETE' });
  assert.deepEqual((await removed.json()).apps.map((app) => app.name), ['Deezer']);
});

test('rejects foreign Host headers', async (context) => {
  const baseUrl = await start(okRemote, context);
  const { hostname, port } = new URL(baseUrl);
  const status = await new Promise((resolve) => {
    httpRequest({ hostname, port, headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).end();
  });
  assert.equal(status, 403);
});
