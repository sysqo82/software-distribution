const form = document.querySelector('#deploy-form');
const targetInput = document.querySelector('#target-pc');
const savedTargets = document.querySelector('#saved-targets');
const installer = document.querySelector('#installer');
const fileName = document.querySelector('#file-name');
const submit = document.querySelector('#submit');
const result = document.querySelector('#result');
const resultTitle = document.querySelector('#result-title');
const resultMessage = document.querySelector('#result-message');
const stepsList = document.querySelector('#steps');

function renderResult(state, steps, message = '') {
  result.hidden = false;
  result.className = `result ${state}`;
  resultTitle.textContent = { running: 'Working…', success: '✔ Succeeded', failed: '✖ Failed' }[state];
  stepsList.replaceChildren(...steps.map((step) => Object.assign(document.createElement('li'), { textContent: step })));
  resultMessage.textContent = message;
}

function renderTargets(targets) {
  const options = targets.map((target) => Object.assign(document.createElement('option'), { value: target, textContent: target }));
  savedTargets.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Previously used PCs…' }), ...options);
}

async function loadTargets() {
  try {
    renderTargets((await (await fetch('/api/targets')).json()).targets);
  } catch {
    renderTargets([]);
  }
}

savedTargets.addEventListener('change', () => {
  if (savedTargets.value) {
    targetInput.value = savedTargets.value;
  }
});

document.querySelector('#remove-target').addEventListener('click', async () => {
  const target = targetInput.value.trim();
  if (target) {
    const response = await fetch(`/api/targets?${new URLSearchParams({ target })}`, { method: 'DELETE' });
    renderTargets((await response.json()).targets);
  }
});

document.querySelector('#browse').addEventListener('click', () => installer.click());
installer.addEventListener('change', () => {
  fileName.textContent = installer.files[0]?.name ?? 'No file selected';
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(jobId) {
  for (;;) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    if (!response.ok) {
      throw new Error(job.error);
    }
    renderResult(job.state, job.steps, job.message);
    if (job.state !== 'running') {
      return job.state;
    }
    await sleep(1500);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = installer.files[0];
  if (!file) {
    renderResult('failed', [], 'Browse for an installer first.');
    return;
  }

  const query = new URLSearchParams({
    targetPc: targetInput.value,
    silentFlags: document.querySelector('#silent-flags').value,
    launchPath: document.querySelector('#launch-path').value
  });
  submit.disabled = true;
  renderResult('running', ['Uploading the installer']);

  try {
    const response = await fetch(`/api/deploy?${query}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      body: file
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error);
    }
    await waitForJob(body.jobId);
    await loadTargets();
  } catch (error) {
    renderResult('failed', [], error.message);
  } finally {
    submit.disabled = false;
  }
});

loadTargets();
