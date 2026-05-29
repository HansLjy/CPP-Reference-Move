#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
// Import the core functions from your module file
const { generateMovePairs, simplifyReferences, updateReferences, moveFiles, getIncludeDirsFromCompileCommands } = require('./move.js');

function printHelp() {
  console.log(`
Usage: node index.js [options] source_dir (<source(s)> <destination> || --clean)

source_dir: The directory to search for the cpp files.

sources: The files to move, wildcards enabled

destination: The destination of the files.

source_dir sources and destination can be relative to cwd.

Options:
  --clean              Only clean the reference, do not move files
  --cmd-path <path>    Path to compile_commands.json. Defaults to searching in 'build/'
  --git                Move files using 'git mv' instead of native 'mv'
  -h, --help           Show this help manual
`);
}

function runCli() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  let cmd_path = null;
  let with_git = false;
  let clean_only = false;
  const positional_args = [];

  // Parse arguments out manually to avoid unnecessary dependencies
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cmd-path') {
      cmd_path = args[++i];
    } else if (args[i] === '--git') {
      with_git = true;
    } else if (args[i] === '--clean') {
      clean_only = true;
    } else {
      positional_args.push(args[i]);
    }
  }

  if (positional_args.length < 1) {
    console.error("Error: Too few arguments");
    printHelp();
    process.exit(1);
  }

  const src_dir = path.resolve(positional_args.shift());

  const final_cmd_path = cmd_path
        ? path.resolve(cmd_path)
        : path.resolve(process.cwd(), 'build', 'compile_commands.json');

  if (!fs.existsSync(final_cmd_path)) {
    console.error(`Error: Could not locate compile_commands.json at "${final_cmd_path}"`);
    process.exit(1);
  }

  console.log(`Using compile_commands.json found at: ${final_cmd_path}`);
  const commands = JSON.parse(fs.readFileSync(final_cmd_path, 'utf8'));

  const include_dir_map = getIncludeDirsFromCompileCommands(commands);


  if (clean_only) {
    simplifyReferences(src_dir, include_dir_map);
    console.log("Success: Simplify references safely.");
  } else {
    // Expecting at least 2 remaining positional arguments (source(s) and destination)
    if (positional_args.length < 2) {
      console.error("Error: Missing source or destination path parameters.");
      printHelp();
      process.exit(1);
    }

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
    updateReferences(src_dir, include_dir_map, move_pairs);
    moveFiles(move_pairs, with_git);

    console.log("Success: Files moved and C++ header references updated safely.");
  }

}

runCli();
