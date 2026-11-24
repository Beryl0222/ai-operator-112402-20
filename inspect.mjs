import { readFile } from 'node:fs/promises';

const input = new URL('./inputs/session.json', import.meta.url);
const session = JSON.parse(await readFile(input, 'utf8'));
const fields = Object.entries(session).map(([field, value]) => ({
  field,
  entries: Array.isArray(value) ? value.length : null,
}));
console.log(JSON.stringify({ fields }, null, 2));
