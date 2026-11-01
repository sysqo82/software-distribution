# Software Distribution Platform

Web dashboard that uploads an `.exe`/`.msi`, copies it to a Windows target over SMB (`C$\Windows\Temp`), installs it silently via WinRM, and launches it minimized on the logged-in user's desktop.

Each push: clears any stuck installer and old copy, copies the file, installs (10-minute timeout, then the installer is killed), launches the app, and checks that it is running. Progress and the final result are shown on the dashboard, and PCs used before are saved in a dropdown (`targets` Docker volume).

## Setup

1. On the target PC (admin PowerShell, once):
   ```powershell
   Enable-PSRemoting -Force -SkipNetworkProfileCheck
   ```
2. Copy `.env.example` to `.env` and set `REMOTE_USER` / `REMOTE_PASSWORD` (a local administrator on the target, e.g. `Administrator`).
3. `docker compose up -d --build`
4. Open http://localhost:3000

The container uses `restart: always`; enable Docker Desktop's "Start Docker Desktop when you sign in" so it runs permanently.

Use the target's IP address if its hostname doesn't resolve from inside Docker.

## Launch field

Required full path of the installed program on the target. The app is started right after install, without a sign-in, through a one-off elevated scheduled task for the logged-in user (the app needs administrator rights). A hidden helper (`conhost --headless`) minimizes the window without taking focus, so nothing interrupts the user. A push fails if no user is logged in or the app isn't running afterwards.

## Silent switches

Used for `.exe` installers (ignored for `.msi`). Default `/qn /norestart ALLUSERS=1` suits jpackage/MSI-based setups such as DeezerScrobbler. Use `/VERYSILENT` for Inno Setup and `/S` for NSIS. Switches that don't match the installer make it wait on a hidden dialog until the timeout.

## Notes

- Installing the same version again depends on the installer; MSI-based ones may refuse it (e.g. exit code 1638).
- The target's installed app must not kill its own launcher on startup, or the launch check fails.

## Test

`yarn test`
