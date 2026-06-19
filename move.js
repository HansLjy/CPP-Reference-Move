const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getAllFiles(inc_wildcards, exc_wildcards) {
  const matched_files = new Set();

  const cwd = process.cwd();
  fs.globSync(inc_wildcards).forEach(file_path => {
    matched_files.add(path.resolve(cwd, file_path));
  })

  const excluded_files = new Set();
  fs.globSync(exc_wildcards).forEach(file_path => {
    excluded_files.add(path.resolve(cwd, file_path));
  })

  return Array.from(matched_files).filter(file => !excluded_files.has(file));
}

/**
 * Helper to parse #include directives from a C++ file content.
 * Returns an array of objects containing the literal included string and its line content.
 */
function parseIncludes(fileContent) {
  const includeRegex = /#\s*include\s*[<"]([^>"]+)[">]/g;
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

function getIncludeDirsFromCompileCommands(commands) {
  const include_dir_map = new Map();
  commands.forEach(cmd => {
    const include_dirs = [];
    const args = cmd.command.split(/\s+/);
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-I')) {
        let dir = args[i].substring(2);
        if (!dir && i + 1 < args.length) dir = args[++i];
        if (dir) include_dirs.push(path.resolve(cmd.directory, dir));
      } else if (args[i] === '-isystem' && i + 1 < args.length) {
        let dir = args[++i];
        include_dirs.push(path.resolve(cmd.directory, dir));
      }
    }
    include_dir_map.set(cmd.file, include_dirs);
  });
  return include_dir_map;
}

function getIncludeDirs(cpp_file_path, include_dir_map) {
  let steal_include_dirs = include_dir_map.get(cpp_file_path);
  if (!steal_include_dirs) {
    const org_ext = path.extname(cpp_file_path).toLowerCase();
    if (['.h', '.hpp', '.hxx'].includes(org_ext)) {
      const cpp_file_name = path.basename(cpp_file_path, org_ext);
      const cpp_file_dir = path.dirname(cpp_file_path);
      const source_exts = ['.cpp', '.cc', '.cxx', '.c'];

      let stolen_path = null;

      // Heuristic 1: Try to steal from the corresponding .cc/.c/.cxx/.cpp file with the same name
      for (const ext of source_exts) {
        test_path = path.resolve(cpp_file_dir, cpp_file_name + ext);
        steal_include_dirs = include_dir_map.get(test_path);
        if (steal_include_dirs) {
          stolen_path = test_path;
          break;
        }
      }

      if (steal_include_dirs) {
        // This is too common a thing so we do not report it.
        // console.log (`Compile commands for ${cpp_file_path} not found, stealing from ${stolen_path}...`);
      }

      // Heuristic 2: Try to steal from any other source file in the exact same directory
      if (!steal_include_dirs) {
        for (const [test_path, test_include_dirs] of include_dir_map) {
          if (path.dirname(test_path) === cpp_file_dir) {
            stolen_path = test_path;
            steal_include_dirs = test_include_dirs;
            break;
          }
        }
        if (steal_include_dirs) {
          console.log(`Compile commands for ${cpp_file_path} not found, stealing from ${stolen_path} in the same directory...`);
        }
      }
    }
  }

  if (!steal_include_dirs) return [];
  return steal_include_dirs;
}

/**
 * Helper to resolve an include literal to its absolute path.
 */
function resolveIncludePath(cur_dir, inc_literals, inc_dirs) {
  const rel_path = path.resolve(cur_dir, inc_literals);
  if (fs.existsSync(rel_path)) {
    return rel_path;
  }
  for (const dir of inc_dirs) {
    const possible_path = path.resolve(dir, inc_literals);
    if (fs.existsSync(possible_path)) {
      return possible_path;
    }
  }
  return null; // Could not be resolved locally, do not change this
}

function generateMovePairs(src_wildcards, dest) {
  const src_list = [];
  const results = [];

  for (const pattern of src_wildcards) {
    try {
      const matches = fs.globSync(pattern);
      src_list.push(...matches);
    } catch (err) {
      console.error(`Error parsing pattern "${pattern}":`, err.message);
    }
  }

  if (src_list.length === 0) {
    console.log("No matching source files found for the provided arguments.");
    return [];
  }

  let is_dest_dir = false;
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    is_dest_dir = true;
  }

  if (!is_dest_dir && !fs.existsSync(path.dirname(dest))) {
    throw new Error(`Move directory ${path.dirname(dest)} does not exist!`);
  }

  if (src_list.length > 1 && !is_dest_dir) {
    throw new Error(`Moving multiple source files to the same location!`);
  }

  for (const src of src_list) {
    const tar_path = is_dest_dir
          ? path.join(dest, path.basename(src))
          : dest;

    results.push({
      oldLocation: path.resolve(src),
      newLocation: path.resolve(tar_path)
    });
  }
  return results;
}

function simplifyPath(cur_dir, inc_dirs, ref_path) {
  let deepest_inc_dir = cur_dir;
  let inc_dir_has_ref_path = !(path.relative(cur_dir, ref_path).startsWith('..'));

  inc_dirs.forEach(dir => {
    const rel_inc_dir = path.relative(dir, ref_path);

    if (!rel_inc_dir.startsWith('..')) {
      if (!inc_dir_has_ref_path || dir.length > deepest_inc_dir.length) {
        inc_dir_has_ref_path = true;
        deepest_inc_dir = dir;
      }
    }
  });

  return path.relative(deepest_inc_dir, ref_path);
}

function simplifyPathWOCurDir(inc_dirs, ref_path) {
  let deepest_inc_dir = null
  inc_dirs.forEach(dir => {
    const rel_inc_dir = path.relative(dir, ref_path);

    if (!rel_inc_dir.startsWith('..')) {
      if (!deepest_inc_dir || dir.length > deepest_inc_dir.length) {
        deepest_inc_dir = dir;
      }
    }
  });
  if (!deepest_inc_dir) {
    return null;
  } else {
    return path.relative(deepest_inc_dir, ref_path);
  }
}

function updateReferences(files, include_dir_map, move_pairs) {
  // moveMap is a map from absolute path of old location to absolute path of new location
  const move_map = new Map();
  move_pairs.forEach(pair => {
    move_map.set(pair.oldLocation, pair.newLocation);
  });

  console.log("Intended file renaming:")
  move_map.forEach((old_location, new_location) => {
    console.log(`${old_location} -> ${new_location}`);
  })

  files.forEach(file_path => {
    let file_content = fs.readFileSync(file_path, 'utf8');
    const includes = parseIncludes(file_content);
    const include_dirs = getIncludeDirs(file_path, include_dir_map);
    if (include_dirs.length == 0) {
      console.warn(`File ${file_path} has empty inclusion!`);
    }

    const src_dir = path.dirname(file_path);
    const move_src = move_map.has(file_path);
    const moved_src_dir = move_src ? path.dirname(move_map.get(file_path)) : src_dir;

    let modified = false;

    includes.forEach(inc => {
      const ref_path = resolveIncludePath(src_dir, inc.literal, include_dirs);
      if (!ref_path) {
        // console.log(`Header file ${inc.literal} in file ${src_path} not found!`);
        return;
      }

      const move_ref = move_map.has(ref_path);
      let moved_ref_path = move_ref ? move_map.get(ref_path) : ref_path;

      if (move_ref || move_src) {
        const new_rel_path = simplifyPath(moved_src_dir, include_dirs, moved_ref_path);
        const new_inc_statement = inc.fullMatch.replace(inc.literal, new_rel_path);
        if (new_rel_path.startsWith('..')) {
          console.warn(`In file ${file_path}, ${inc.literal} is renamed to ${new_rel_path} using relative path!`)
        } else {
          console.log('\x1b[32m%s\x1b[0m', `${inc.literal} -> ${new_rel_path}`);
        }
        file_content = file_content.replace(inc.fullMatch, new_inc_statement);
        modified = true;
      }
    });

    if (modified) {
      fs.writeFileSync(file_path, file_content, 'utf8');
      console.log(`File ${file_path} modified, see modification above.`);
    }
  });
}

function simplifyReferences(files, include_dir_map) {
  files.forEach(file_path => {
    let file_content = fs.readFileSync(file_path, 'utf8');
    const includes = parseIncludes(file_content);
    const include_dirs = getIncludeDirs(file_path, include_dir_map);
    if (include_dirs.length == 0) {
      console.warn(`File ${file_path} has empty inclusion!`);
    }

    const src_dir = path.dirname(file_path);

    let modified = false;

    includes.forEach(inc => {
      const ref_path = resolveIncludePath(src_dir, inc.literal, include_dirs);
      if (!ref_path) {
        // console.log(`Header file ${inc.literal} in file ${src_path} not found!`);
        return;
      }

      let new_rel_path = simplifyPathWOCurDir(include_dirs, ref_path);
      if (!new_rel_path) {
        console.log("Cannot locate reference without current directory");
        new_rel_path = simplifyPath(src_dir, include_dirs, ref_path);
        if (new_rel_path.startsWith('..')) {
          console.warn('\x1b[33m%s\x1b[0m', `Using relative path for inclusion statement in file ${file_path}: ${new_rel_path}`);
        }
      }
      if (new_rel_path != inc.literal) {
        const new_inc_statement = inc.fullMatch.replace(inc.literal, new_rel_path);
        console.log('\x1b[32m%s\x1b[0m', `${inc.literal} -> ${new_rel_path}`);
        file_content = file_content.replace(inc.fullMatch, new_inc_statement);
        modified = true;
      }
    });

    if (modified) {
      fs.writeFileSync(file_path, file_content, 'utf8');
      console.log(`File ${file_path} modified, see modification above.`);
    }
  });
}

function moveFiles(move_pairs, with_git) {
  move_pairs.forEach(pair => {
    const src_abs = pair.oldLocation;
    const tar_abs = pair.newLocation;

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
  getAllFiles,
  getIncludeDirsFromCompileCommands,
  generateMovePairs,
  updateReferences,
  simplifyReferences,
  moveFiles
};
