const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Helper to recursively find all files in a directory matching an array of extensions.
 */
function getAllFiles(dir, extensions, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFiles(filePath, extensions, fileList);
    } else {
      if (extensions.includes(path.extname(file).toLowerCase())) {
        fileList.push(filePath);
      }
    }
  });
  return fileList;
}

/**
 * Helper to parse #include directives from a C++ file content.
 * Returns an array of objects containing the literal included string and its line content.
 * WARNING: We only deal with "" includes, not <> includes.
 */
function parseIncludes(fileContent) {
  const includeRegex = /#\s*include\s*["]([^"]+)["]/g;
  const matches = [];
  let match;
  while ((match = includeRegex.exec(fileContent)) !== null) {
    matches.push({
      literal: match[1],
      fullMatch: match[0]
    });
  }
  return matches;
}

/**
 * Helper to extract include directories from compile_commands.json for a given file.
 */
function getIncludeDirsFromCompileCommands(commands, cpp_file_path) {
  try {
    // Find matching entry for the file
    let entry = commands.find(cmd => path.resolve(cmd.file) === path.resolve(cpp_file_path));
    if (!entry) {
      const ext = path.extname(cpp_file_path).toLowerCase();
      if (['.h', '.hpp', '.hxx'].includes(ext)) {
        const base_name = path.basename(cpp_file_path, ext);
        const target_dir = path.dirname(cpp_file_path);
        const source_exts = ['.cpp', '.cc', '.cxx', '.c'];

        // Heuristic 1: Try to steal from the corresponding .cc/.c/.cxx/.cpp file with the same name
        entry = commands.find(cmd => {
          const cmd_file_abs = path.resolve(cmd.file);
          const cmd_ext = path.extname(cmd_file_abs).toLowerCase();
          return path.dirname(cmd_file_abs) === target_dir &&
                 path.basename(cmd_file_abs, cmd_ext) === base_name &&
                 source_exts.includes(cmd_ext);
        });

        if (entry) {
          console.log (`Compile commands for ${cpp_file_path} not found, stealing from ${entry.file}...`);
        }

        // Heuristic 2: Try to steal from any other source file in the exact same directory
        if (!entry) {
          entry = commands.find(cmd => {
            const cmd_file_abs = path.resolve(cmd.file);
            const cmd_ext = path.extname(cmd_file_abs).toLowerCase();
            return path.dirname(cmd_file_abs) === target_dir && source_exts.includes(cmd_ext);
          });
          if (entry) {
            console.log(`Compile commands for ${cpp_file_path} not found, stealing from ${entry.file} in the same directory...`);
          }
        }
      }
    }

    if (!entry) return [];
    if (!entry.directory) {
      console.log('No \'directory\' property for the entry');
    }

    const includeDirs = [];
    // Look for -I or -isystem flags in arguments or command string
    const args = entry.command.split(/\s+/);

    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-I')) {
        let dir = args[i].substring(2);
        if (!dir && i + 1 < args.length) dir = args[++i];
        if (dir) includeDirs.push(path.resolve(entry.directory, dir));
      } else if (args[i] === '-isystem' && i + 1 < args.length) {
        let dir = args[++i];
        includeDirs.push(path.resolve(entry.directory, dir));
      }
    }
    return includeDirs;
  } catch (e) {
    console.error("Error parsing compile_commands.json", e);
    return [];
  }
}

/**
 * Helper to resolve an include literal to its absolute path.
 */
function resolveIncludePath(cur_dir, inc_literals, inc_dirs) {
  // 1. Check relative to current file directory (quoted includes)
  const rel_path = path.resolve(cur_dir, inc_literals);
  if (fs.existsSync(rel_path)) {
    return rel_path;
  }
  // 2. Check search paths from compile commands
  for (const dir of inc_dirs) {
    const possible_path = path.resolve(dir, inc_literals);
    if (fs.existsSync(possible_path)) {
      return possible_path;
    }
  }
  return null; // Could not be resolved locally, do not change this
}

function simplifyPath(cur_dir, inc_dirs, ref_path) {
  let deepest_inc_dir = null;

  const rel_inc_dir_from_cur_dir = path.relative(cur_dir, ref_path);
  if (!rel_inc_dir_from_cur_dir.startsWith('..')) {
    if (!deepest_inc_dir || cur_dir.length > deepest_inc_dir.length) {
      deepest_inc_dir = cur_dir;
    }
  }

  inc_dirs.forEach(dir => {
    const rel_inc_dir = path.relative(dir, ref_path);

    if (!rel_inc_dir.startsWith('..')) {
      if (!deepest_inc_dir || dir.length > deepest_inc_dir.length) {
        deepest_inc_dir = dir;
      }
    }
  });

  if (deepest_inc_dir) {
    return path.relative(deepest_inc_dir, ref_path);
  } else {
    console.log (cur_dir, inc_dirs, ref_path);
    return null;
  }
}

function updateReferences(root_dir, compile_commands_path, move_pairs_json_path) {
  const cpp_exts = ['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'];
  const files = getAllFiles(root_dir, cpp_exts);
  console.log('All files:');
  console.log(files);
  const pairs = JSON.parse(fs.readFileSync(move_pairs_json_path, 'utf8'));
  const commands = JSON.parse(fs.readFileSync(compile_commands_path, 'utf8'));

  // moveMap is a map from absolute path of old location to absolute path of new location
  const move_map = new Map();
  pairs.forEach(pair => {
    move_map.set(path.resolve(root_dir, pair.oldLocation), path.resolve(root_dir, pair.newLocation));
  });

  console.log("Intended file renaming:")
  move_map.forEach((old_location, new_location) => {
    console.log(`${old_location} -> ${new_location}`);
  })

  files.forEach(file_path => {
    const src_path = path.resolve(file_path);
    let src_content = fs.readFileSync(src_path, 'utf8');
    const includes = parseIncludes(src_content);
    const include_dirs = getIncludeDirsFromCompileCommands(commands, src_path);

    const src_dir = path.dirname(src_path);
    const move_src = move_map.has(src_path);
    const moved_src_dir = move_src ? path.dirname(move_map.get(src_path)) : src_dir;

    let modified = false;

    includes.forEach(inc => {
      const ref_path = resolveIncludePath(src_dir, inc.literal, include_dirs);
      if (!ref_path) {
        console.log(`Header file ${inc.literal} in file ${src_path} not found!`);
        return;
      }

      const move_ref = move_map.has(ref_path);
      let moved_ref_path = move_ref ? move_map.get(ref_path) : ref_path;

      if (move_ref || move_src) {
        const new_rel_path = simplifyPath(moved_src_dir, include_dirs, moved_ref_path);
        if (!new_rel_path) {
          console.log(`File path ${ref_path} not found for file ${file_path}`);
        }
        const new_inc_statement = inc.fullMatch.replace(inc.literal, new_rel_path);
        console.log(`In file ${src_path}, renaming ${inc.literal} to ${new_rel_path}`);
        src_content = src_content.replace(inc.fullMatch, new_inc_statement);
        modified = true;
      }
    });

    if (modified) {
      fs.writeFileSync(src_path, src_content, 'utf8');
    }
  });
}

function moveFiles(root_dir, move_pairs_json_path, with_git) {
  if (!fs.existsSync(move_pairs_json_path)) {
    throw new Error(`Move list JSON not found at ${move_pairs_json_path}`);
  }

  const pairs = JSON.parse(fs.readFileSync(move_pairs_json_path, 'utf8'));

  pairs.forEach(pair => {
    const src_abs = path.resolve(root_dir, pair.oldLocation);
    const tar_abs = path.resolve(root_dir, pair.newLocation);

    if (fs.existsSync(src_abs)) {
      // Ensure target directory exists before running git mv
      fs.mkdirSync(path.dirname(tar_abs), { recursive: true });
      let move_with_git_success = true;
      if (with_git) {
        try {
          execSync(`git mv "${src_abs}" "${tar_abs}"`, { stdio: 'ignore' });
        } catch (err) {
          console.log('Unable to move with git, error message: ' + err.message);
          console.log('Try moving without git instead...')
          move_with_git_success = false;
        }
      }
      if (!with_git || !move_with_git_success){
        fs.renameSync(src_abs, tar_abs);
      }
    }
  });
}

module.exports = {
  updateReferences,
  moveFiles,
};
