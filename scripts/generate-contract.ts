/**
 * Writes the part of the shared package that comes from the server (P1-09), or checks it.
 *
 *   npm run contract:generate    writes ../smart-depannage-shared/src/generated
 *   npm run contract:check       exits with an error when that folder is out of date
 *
 * Options: --out <folder> (another folder than ../smart-depannage-shared/src/generated).
 * Needs neither the database nor the network. Run it after changing the job's columns or its
 * views, the status table, or the page type, and then run `npm run sync` in the shared package.
 */
import * as fs from 'fs';
import * as path from 'path';

import { contractDrift, generateContract } from '../src/common/api-contract/generate';

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const outFlag = args.indexOf('--out');
const out = path.resolve(root, outFlag >= 0 ? args[outFlag + 1] : '../smart-depannage-shared/src/generated');

const files = generateContract((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));

/** Every file of the generated folder, by name (the folder is generated whole: nothing in it is written by hand). */
function filesOnDisk(folder: string): Record<string, string> {
  const found: Record<string, string> = {};

  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile()) found[entry.name] = fs.readFileSync(path.join(folder, entry.name), 'utf8');
  }

  return found;
}

if (check) {
  if (!fs.existsSync(out)) {
    console.error(`Nothing to check: ${out} does not exist. Is the smart-depannage-shared folder next to this one?`);
    process.exit(2);
  }

  const problems = contractDrift(files, filesOnDisk(out));

  if (problems.length) {
    console.error(`The generated folder is not what the server generates:\n  ${problems.join('\n  ')}\nRun "npm run contract:generate" here (a left over file is deleted by hand), then "npm run sync" in the shared package.`);
    process.exit(1);
  }

  console.log(`The ${Object.keys(files).length} generated files are up to date.`);
} else {
  fs.mkdirSync(out, { recursive: true });

  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), text);
  }

  console.log(`Wrote ${Object.keys(files).length} files to ${out}.\nNext, in the shared package: npm run sync`);
}
