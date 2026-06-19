#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
// Import the core functions from your module file
const { getAllFiles, generateMovePairs, simplifyReferences, updateReferences, moveFiles, getIncludeDirsFromCompileCommands } = require('./move.js');

function printHelp() {
  console.log(`
Usage: node index.js source_files (--exc excluded_files) --cmd-path cmd_path (--show-changes-only) (--move <source(s)> <destination> | --clean) [options]

source_files: List of wildcards for all the files to scan.

excluded_files: List of wildcards for all the files to exclude from scan.

cmd_path: Path to compile_commands.json

sources: The files to move, wildcards enabled

destination: The destination of the files.

All path are relative to cwd or absolute.

Options:
  --show-changes-only  Only show changes, do not apply them
  --git                Move files using 'git mv' instead of native 'mv'
`);
}

function runCli() {
  const args = process.argv.slice(2);

  if (args.length == 0) {
    printHelp();
    process.exit(0);
  }

  let inc_wildcards = [], exc_wildcards = [];

  let current_arg_id = 0;
  while (current_arg_id < args.length && !args[current_arg_id].startsWith('--')) {
    inc_wildcards.push(args[current_arg_id]);
    current_arg_id++;
  }

  if (current_arg_id == args.length) {
    console.error('Error: Need options!');
    process.exit(1);
  }

  if (args[current_arg_id] === '--exc') {
    current_arg_id++;
    while (current_arg_id < args.length && !args[current_arg_id].startsWith('--')) {
      exc_wildcards.push(args[current_arg_id]);
      current_arg_id++;
    }
  }

  const files = getAllFiles(inc_wildcards, exc_wildcards);
  console.log('The files we are changing:');
  files.forEach(file => {
    console.log(file);
  })

  let cmd_path = null;
  if (args[current_arg_id] === '--cmd-path') {
    current_arg_id++;
    if (current_arg_id < args.length && !args[current_arg_id].startsWith('--')) {
      cmd_path = args[current_arg_id];
      current_arg_id++;
    }
  }

  if (!cmd_path) {
    console.error('Error: No path to compile_commands.json given');
  }

  cmd_path = path.resolve(process.cwd(), cmd_path);

  if (!fs.existsSync(cmd_path)) {
    console.error(`Error: Could not locate compile_commands.json at "${cmd_path}"`);
    process.exit(1);
  }

  const commands = JSON.parse(fs.readFileSync(cmd_path, 'utf8'));
  const include_dir_map = getIncludeDirsFromCompileCommands(commands);

  let show_changes_only = false;
  if (args[current_arg_id] === '--show-changes-only') {
    show_changes_only = true;
    current_arg_id++;
  }

  if (args[current_arg_id] === '--clean') {
    // clean only
    simplifyReferences(files, include_dir_map);
    console.log("Success: Simplify references safely.");
    process.exit(0);
  }

  if (args[current_arg_id] === '--move') {
    current_arg_id++;
    positional_args = args.slice(current_arg_id);
    const dest = path.resolve(positional_args.pop());
    const sources = positional_args.map(src => path.resolve(src));

    let move_pairs = null;
    try {
      move_pairs = generateMovePairs(sources, dest);
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }

    if (move_pairs.length === 0) {
      console.log("No moves to perform.");
      process.exit(0);
    }

    // Note: References must be updated first before files are missing from their old locations
    updateReferences(files, include_dir_map, move_pairs);
    moveFiles(move_pairs, with_git);

    console.log("Success: Files moved and C++ header references updated safely.");
  }
}

runCli();
