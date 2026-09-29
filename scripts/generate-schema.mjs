// Regenerates schema.json from the config definition (run after `npm run build`).
import { writeFileSync } from 'node:fs';
import { configJsonSchema } from '../dist/config.js';

writeFileSync(new URL('../schema.json', import.meta.url), `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log('Wrote schema.json');
