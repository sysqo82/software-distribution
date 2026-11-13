import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// App name from its launch path, e.g. C:\Program Files\App\App.exe -> App.
export const appName = (launchPath) => path.win32.basename(launchPath, path.win32.extname(launchPath));

export function createAppStore(directory = process.env.DATA_DIR ?? './data') {
  const file = path.join(directory, 'apps.json');

  async function list() {
    try {
      const apps = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(apps) ? apps.filter((app) => typeof app?.name === 'string') : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async function save(apps) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify(apps, null, 2));
  }

  return {
    list,
    // Most recently used first; the latest switches and path replace older ones.
    async add({ silentFlags, launchPath }) {
      const name = appName(launchPath);
      await save([{ name, silentFlags, launchPath }, ...(await list()).filter((app) => app.name !== name)]);
    },
    async remove(name) {
      await save((await list()).filter((app) => app.name !== name));
    }
  };
}
