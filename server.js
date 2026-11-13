import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deploy, validateRequest, ValidationError } from './lib/deploy.js';
import { createTargetStore } from './lib/targets.js';
import { createAppStore } from './lib/apps.js';
import * as defaultRemote from './lib/remote.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const headers = {
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff'
};
const MAX_JOBS = 50;

function sendJson(response, status, body) {
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function createAppServer({ remote = defaultRemote, targets = createTargetStore(), apps = createAppStore() } = {}) {
  const jobs = new Map();

  function startJob(details, upload) {
    const id = randomUUID();
    const job = { state: 'running', steps: [], message: '' };
    jobs.set(id, job);
    if (jobs.size > MAX_JOBS) {
      jobs.delete(jobs.keys().next().value);
    }

    targets.add(details.targetPc)
      .then(() => apps.add(details))
      .then(() => deploy(details, upload, remote, (step) => job.steps.push(step)))
      .then((message) => {
        job.message = message;
        job.state = 'success';
      })
      .catch((error) => {
        job.state = 'failed';
        job.message = error.message;
      })
      .finally(() => rm(upload, { force: true }));
    return id;
  }

  async function handleDeploy(request, response, url) {
    let upload;
    try {
      const details = validateRequest({
        targetPc: url.searchParams.get('targetPc') ?? '',
        silentFlags: url.searchParams.get('silentFlags') ?? '',
        launchPath: url.searchParams.get('launchPath') ?? '',
        fileName: decodeURIComponent(request.headers['x-filename'] ?? '')
      });
      upload = path.join(tmpdir(), `${randomUUID()}${path.extname(details.fileName).toLowerCase()}`);
      await pipeline(request, createWriteStream(upload));
      const jobId = startJob(details, upload);
      upload = undefined;
      sendJson(response, 202, { jobId });
    } catch (error) {
      if (upload) {
        await rm(upload, { force: true });
      }
      sendJson(response, error instanceof ValidationError || error instanceof URIError ? 400 : 500, { error: error.message });
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const host = (request.headers.host ?? '').replace(/:\d+$/, '');
      // Rejects DNS-rebinding requests from other sites.
      if (!['localhost', '127.0.0.1'].includes(host)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/deploy') {
        await handleDeploy(request, response, url);
      } else if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
        sendJson(response, job ? 200 : 404, job ?? { error: 'Unknown job.' });
      } else if (request.method === 'GET' && url.pathname === '/api/targets') {
        sendJson(response, 200, { targets: await targets.list() });
      } else if (request.method === 'DELETE' && url.pathname === '/api/targets') {
        await targets.remove(url.searchParams.get('target') ?? '');
        sendJson(response, 200, { targets: await targets.list() });
      } else if (request.method === 'GET' && url.pathname === '/api/apps') {
        sendJson(response, 200, { apps: await apps.list() });
      } else if (request.method === 'DELETE' && url.pathname === '/api/apps') {
        await apps.remove(url.searchParams.get('name') ?? '');
        sendJson(response, 200, { apps: await apps.list() });
      } else if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { ...headers, 'Content-Type': type });
        response.end(await readFile(path.join(publicDirectory, file)));
      } else {
        response.writeHead(404);
        response.end('Not found');
      }
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: error.message });
      }
    }
  });
  server.requestTimeout = 0;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, '0.0.0.0', () => {
    console.log(`Software Distribution Platform listening on port ${port}`);
  });
}
