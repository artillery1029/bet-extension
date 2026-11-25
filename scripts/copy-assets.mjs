import { copyFile, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['manifest.json', 'popup.html', 'popup.css']) {
  await copyFile(new URL(`../${name}`, import.meta.url), new URL(name, destination));
}
