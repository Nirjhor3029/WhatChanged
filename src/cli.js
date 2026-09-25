import fs from 'node:fs';

/*
 * Command line options. Imported first by server.js, so the values are in
 * process.env before config.js reads them.
 */
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

const HELP = `
  WhatChanged ${pkg.version} — click something in your app, see everything it changed.

  Usage
    whatchanged [options]

  Options
    -p, --port <number>   dashboard port (default 4477, env PORT)
        --host <address>  address to listen on (default 127.0.0.1, env DBC_HOST)
        --data <folder>   where connections and snapshots are saved
                          (default ~/.whatchanged, env DBC_STORAGE)
        --no-open         don't open the browser
    -v, --version         print the version
    -h, --help            show this help

  Examples
    npx whatchanged
    whatchanged --port 5000 --no-open
`;

function value(i, flag) {
  const v = args[i + 1];
  if (!v || v.startsWith('-')) {
    console.error(`  Missing value for ${flag}. Run "whatchanged --help".`);
    process.exit(1);
  }
  return v;
}

let open = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a, null];
  const get = () => inline ?? value(i++, flag);
  switch (flag) {
    case '-h': case '--help': console.log(HELP); process.exit(0); break;
    case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
    case '-p': case '--port': {
      const port = Number(get());
      if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('  --port needs a number between 1 and 65535.'); process.exit(1); }
      process.env.PORT = String(port);
      break;
    }
    case '--host': process.env.DBC_HOST = get(); break;
    case '--data': process.env.DBC_STORAGE = get(); break;
    case '--no-open': open = false; break;
    case '--open': open = true; break; // kept for older scripts
    default:
      console.error(`  Unknown option "${a}". Run "whatchanged --help".`);
      process.exit(1);
  }
}

export const cli = { open, version: pkg.version };
