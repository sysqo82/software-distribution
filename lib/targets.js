import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createTargetStore(directory = process.env.DATA_DIR ?? './data') {
  const file = path.join(directory, 'targets.json');

  async function list() {
    try {
      const targets = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(targets) ? targets.filter((target) => typeof target === 'string') : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async function save(targets) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify(targets, null, 2));
  }

  return {
    list,
    // Most recently used first.
    async add(target) {
      await save([target, ...(await list()).filter((saved) => saved !== target)]);
    },
    async remove(target) {
      await save((await list()).filter((saved) => saved !== target));
    }
  };
}
