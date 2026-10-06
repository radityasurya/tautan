import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The Hub starts only from its action or Phone setup pane, never when herdr starts.
if (!existsSync(resolve(import.meta.dir, '../dist/web'))) console.log('tautan: run the plugin build; dist/web is missing');
