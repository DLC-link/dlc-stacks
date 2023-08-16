#!/usr/bin/env node
require('dotenv').config();
import path from 'path';
import { Command } from 'commander';
const version = require('../../package.json').version;

import addAttestor from './01_register-attestor';
import getRegisteredAttestor from './02_get-registered-attestor';
import fetchAllAttestors from './03_fetch-all-attestors';
import deregisterAttestorByDNS from './04_deregister-attestor-by-dns';
import registerContract from './05_register-contract';

async function main() {
  const program = new Command();

  program.name('dlc-link-stacks').description('CLI scripts to help with DLC.Link utilities').version(`v${version}`);

  program
    .command('register-attestor')
    .description('register attestor')
    .argument('<address>', 'address of attestor')
    .action(addAttestor);

  program
    .command('get-registered-attestor')
    .description('get registered attestor by id')
    .argument('<id>', 'id of attestor')
    .action(getRegisteredAttestor);

  program.command('fetch-all-attestors').description('fetch all registered attestors').action(fetchAllAttestors);

  program
    .command('deregister-attestor-by-dns')
    .description('deregister attestor by dns')
    .argument('<address>', 'address of attestor')
    .action(deregisterAttestorByDNS);

  program
    .command('register-contract')
    .description('register contract')
    .argument('<address>', 'address of contract')
    .argument('<name>', 'name of contract')
    .action(registerContract);

  const rootDir = path.join(__dirname, '..');
  process.chdir(rootDir);

  await program.parseAsync(process.argv);
}

// ---- main entry point when running as a script

// make sure we catch all errors
main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });