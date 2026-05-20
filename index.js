const fs = require('fs');
const path = require('path');
const { updateReferences, moveFiles } = require('./move.js');

const args = process.argv.slice(2);

if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node index.js <root_dir> <compile_commands_path> <move_pairs_json_path> [--git]

Arguments:
  root_dir               The C++ project root directory.
  compile_commands_path  Path to the compile_commands.json file.
  move_pairs_json_path   Path to the JSON list containing the move mappings.

Options:
  --git                  Use git mv to execute structural moving operations (Optional)
  `);
  process.exit(args.length === 0 ? 0 : 1);
}

const root_dir = path.resolve(args[0]);
const compile_commands_path = path.resolve(args[1]);
const move_pairs_json_path = path.resolve(args[2]);
const use_git = args.includes('--git');

console.log('--- Commencing Reference Refactoring Pipeline ---');

try {
  if (!fs.existsSync(root_dir)) {
    throw new Error(`Root directory does not exist: ${root_dir}`);
  }
  if (!fs.existsSync(compile_commands_path)) {
    throw new Error(`Compile commands file does not exist: ${compile_commands_path}`);
  }
  if (!fs.existsSync(move_pairs_json_path)) {
    throw new Error(`Move pair file does not exist: ${move_pairs_json_path}`);
  }

  // Run string mutations first while files are still stationary
  console.log('[1/2] Rewriting C++ inclusion strings based on future layout schema...');
  updateReferences(root_dir, compile_commands_path, move_pairs_json_path);

  // Execute physical migrations
  console.log(`[2/2] Migrating project items physically (Git mode: ${use_git ? 'ENABLED' : 'DISABLED'})...`);
  moveFiles(root_dir, move_pairs_json_path, use_git);

  console.log('------------------------------------------------');
  console.log('SUCCESS: Structural layout configuration finalized cleanly.');

} catch (error) {
  console.error('\nExecution Failure Exception Encountered:');
  console.error(error.message);
  process.exit(1);
}
