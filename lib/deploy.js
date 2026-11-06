const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ .()+-]*\.(exe|msi)$/i;
const FLAGS_PATTERN = /^[A-Za-z0-9_\s/\-=.:",\\]*$/;
const LAUNCH_PATTERN = /^[A-Za-z]:\\[^<>|?*"\r\n]+$/;

export class ValidationError extends Error {}

export function validateRequest({ targetPc = '', fileName = '', silentFlags = '', launchPath = '' }) {
  const request = {
    targetPc: targetPc.trim(),
    fileName: fileName.trim(),
    silentFlags: silentFlags.trim(),
    launchPath: launchPath.trim()
  };

  if (!HOST_PATTERN.test(request.targetPc)) {
    throw new ValidationError('Enter a valid target hostname or IP address.');
  }
  if (!FILE_PATTERN.test(request.fileName)) {
    throw new ValidationError('Choose an .exe or .msi installer with a plain file name.');
  }
  if (!FLAGS_PATTERN.test(request.silentFlags)) {
    throw new ValidationError('Silent flags contain unsupported characters.');
  }
  if (!LAUNCH_PATTERN.test(request.launchPath)) {
    throw new ValidationError('Launch path must be an absolute Windows path such as C:\\Program Files\\App\\App.exe.');
  }
  return request;
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;

export const remoteInstallerPath = (fileName) => `C:\\Windows\\Temp\\${fileName}`;

export const INSTALL_TIMEOUT_MINUTES = 10;
export const TIMEOUT_EXIT_CODE = 1460;

// An installer that ignores its silent switches waits for a dialog nobody can see, so the whole process tree is killed after a timeout.
const waitForInstaller = [
  `if (-not $p.WaitForExit(${INSTALL_TIMEOUT_MINUTES * 60000})) {`,
  '  taskkill.exe /T /F /PID $p.Id | Out-Null',
  `  Write-Output 'The installer did not finish in ${INSTALL_TIMEOUT_MINUTES} minutes. It is probably waiting for input, so its silent switches are wrong. Installers built with jpackage or MSI need /qn /norestart ALLUSERS=1, Inno Setup needs /VERYSILENT, NSIS needs /S.'`,
  `  exit ${TIMEOUT_EXIT_CODE}`,
  '}',
  'exit $p.ExitCode'
].join('\n');

export function buildInstallScript({ fileName, silentFlags }) {
  const remotePath = remoteInstallerPath(fileName);
  if (fileName.toLowerCase().endsWith('.msi')) {
    const args = ['/i', `"${remotePath}"`, '/qn', '/norestart', 'ALLUSERS=1'].map(quote).join(', ');
    return `$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @(${args}) -PassThru\n${waitForInstaller}`;
  }
  const flags = silentFlags ? ` -ArgumentList ${quote(silentFlags)}` : '';
  return `$p = Start-Process -FilePath ${quote(remotePath)}${flags} -PassThru\n${waitForInstaller}`;
}

// Remote sessions run in session 0, so the app is started through a one-off task bound to the logged-in user.
// Run level Highest is required because the app's manifest asks for administrator rights.
// Java apps ignore a start-minimized flag, so a helper script in the user's session minimizes the window (without activating it) as soon as it appears.
// The helper runs under conhost --headless, because even "-WindowStyle Hidden" flashes a console window that steals focus.
// The process is checked afterwards, as a task can "start" without the app running.
const helperScriptPath = 'C:\\Windows\\Temp\\DeployDashboardLaunch.ps1';

export function buildLaunchScript({ launchPath }) {
  const processName = launchPath.split('\\').pop().replace(/\.exe$/i, '');
  return [
    '$u = (Get-CimInstance Win32_ComputerSystem).UserName',
    "if (-not $u) { Write-Output 'No user is logged in on the target PC.'; exit 1 }",
    `$helper = ${quote(helperScriptPath)}`,
    "Set-Content -LiteralPath $helper -Encoding UTF8 -Value @'",
    "Add-Type -Namespace Win -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr handle, int command);'",
    `Start-Process -FilePath ${quote(launchPath)}`,
    '$end = (Get-Date).AddSeconds(30)',
    'while ((Get-Date) -lt $end) {',
    `  $w = Get-Process -Name ${quote(processName)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    '  if ($w) { [Win.Native]::ShowWindowAsync($w.MainWindowHandle, 7) | Out-Null; break }',
    '  Start-Sleep -Milliseconds 50',
    '}',
    "'@",
    "$n = 'DeployDashboardLaunch'",
    "$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"' + $helper + '\"')",
    '$pr = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Highest',
    'Register-ScheduledTask -TaskName $n -Action $a -Principal $pr -Force | Out-Null',
    'Start-ScheduledTask -TaskName $n',
    '$limit = (Get-Date).AddSeconds(60)',
    'do { Start-Sleep -Seconds 1 } while ((Get-ScheduledTask -TaskName $n).State -eq "Running" -and (Get-Date) -lt $limit)',
    '$result = (Get-ScheduledTaskInfo -TaskName $n).LastTaskResult',
    'Unregister-ScheduledTask -TaskName $n -Confirm:$false',
    'Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue',
    `if (-not (Get-Process -Name ${quote(processName)} -ErrorAction SilentlyContinue)) { Write-Output ('The app is not running after launch (task result ' + $result + ').'); exit 1 }`
  ].join('\n');
}

// 0 = success, 1641/3010 = success with reboot pending.
export const isSuccessCode = (code) => [0, 1641, 3010].includes(code);

const detail = ({ stdout, stderr }) => stdout.trim() || stderr.trim();

// A previous stuck run can leave the installer, or the msiexec it spawned from a temp extraction folder, running. That locks the file and blocks every later Windows Installer run.
// Every earlier version shares the name before its version number, e.g. DeezerScrobbler-1.3.0.exe and DeezerScrobbler-1.3.1.exe.
export function versionsPattern(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const baseName = stem.replace(/[-_ ]?v?\d.*$/i, '') || stem;
  return `${baseName.replace(/[[\]*?`]/g, '')}*${fileName.slice(fileName.lastIndexOf('.'))}`;
}

export function buildCleanupScript({ fileName, launchPath }) {
  const remotePattern = quote(remoteInstallerPath(versionsPattern(fileName)));
  const processName = launchPath ? quote(launchPath.split('\\').pop().replace(/\.exe$/i, '')) : null;
  const killAppScript = processName
    ? `Stop-Process -Name ${processName} -Force -ErrorAction SilentlyContinue\nStop-Process -Name 'MediaBridge' -Force -ErrorAction SilentlyContinue\n`
    : '';

  return [
    killAppScript,
    `Get-Process | Where-Object { $_.Path -like ${remotePattern} } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    "Get-CimInstance Win32_Process -Filter \"Name='msiexec.exe'\" | Where-Object { $_.CommandLine -match '\\.tmp\\\\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'Start-Sleep -Seconds 1',
    `Remove-Item -Path ${remotePattern} -Force -ErrorAction SilentlyContinue`
  ].filter(Boolean).join('\n');
}

export async function deploy(request, localFile, remote, onStep = () => {}) {
  onStep(`Clearing all previous versions (${versionsPattern(request.fileName)}) from ${remoteInstallerPath('')} on ${request.targetPc}`);
  await remote.runPowerShell(request.targetPc, buildCleanupScript(request));

  onStep(`Copying ${request.fileName} to ${request.targetPc}`);
  await remote.copyFile(request.targetPc, localFile, `Windows\\Temp\\${request.fileName}`);

  onStep('Installing silently (can take several minutes)');
  const install = await remote.runPowerShell(request.targetPc, buildInstallScript(request));
  if (!isSuccessCode(install.exitCode)) {
    throw new Error(`Installer exited with code ${install.exitCode}. ${detail(install)}`.trim());
  }

  onStep('Launching the app on the user\'s desktop');
  const launch = await remote.runPowerShell(request.targetPc, buildLaunchScript(request));
  if (launch.exitCode !== 0) {
    throw new Error(`Installed, but launching failed: ${detail(launch)}`.trim());
  }

  const reboot = install.exitCode === 0 ? '' : ' A reboot is pending on the target.';
  return `Installed ${request.fileName} on ${request.targetPc} and launched it.${reboot}`;
}
