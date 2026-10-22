// `npm run build` entry point.
// Bundles the JS, then runs the Python site generator. On a host with no
// Python (Hostinger's Node.js build) the generator cannot run, so the already
// built site committed at the repository root is used as-is and the build
// finishes successfully. A real Python failure still fails the build.
import { spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

let r = run('npm', ['run', 'build:js']);
if (r.status !== 0) process.exit(r.status || 1);

const py = ['python3', 'python'].find(has);
if (!py) {
  console.log('\nNo Python on this host: skipping the site generator.');
  console.log('Using the prebuilt site already committed in the repository (built by GitHub Actions).');
  process.exit(0);
}
const canImport = () => spawnSync(py, ['-c', 'import jinja2, markupsafe'], { stdio: 'ignore' }).status === 0;
if (!canImport()) {
  const pip = spawnSync(py, ['-m', 'pip', '--version'], { stdio: 'ignore' }).status === 0;
  if (pip) {
    r = run(py, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
    if (r.status !== 0) r = run(py, ['-m', 'pip', 'install', '--user', '-r', 'requirements.txt']);
    if (r.status !== 0) r = run(py, ['-m', 'pip', 'install', '--break-system-packages', '-r', 'requirements.txt']);
  }
  if (!canImport()) {
    console.log('\nPython is here but its packages (jinja2) cannot be installed: skipping the site generator.');
    console.log('Using the prebuilt site already committed in the repository (built by GitHub Actions).');
    process.exit(0);
  }
}
r = run(py, ['src/build.py']);
process.exit(r.status === null ? 1 : r.status);
