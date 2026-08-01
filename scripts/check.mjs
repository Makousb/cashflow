#!/usr/bin/env node
//
// Parses every source file without running it: `node --check` over the
// JavaScript, and an EJS compile over the views.
//
// This exists because the schema is one long template literal — a stray
// backtick inside an SQL comment turns the whole file into a syntax error that
// nothing catches until the app refuses to boot. A view with an unclosed tag
// fails the same way, at render time, in front of whoever is looking.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import ejs from "ejs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".venv", "uploads", "coverage"]);

function collect(dir, extensions, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, extensions, found);
    } else if (extensions.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const failures = [];

// Spawning node per file is slow on Windows; check them a handful at a time.
async function checkScripts(files) {
  const size = 8;
  for (let i = 0; i < files.length; i += size) {
    await Promise.all(
      files.slice(i, i + size).map(async (file) => {
        try {
          await run(process.execPath, ["--check", file]);
        } catch (error) {
          failures.push(`${path.relative(root, file)}\n    ${error.stderr.trim().split("\n")[0]}`);
        }
      })
    );
  }
}

function checkViews(files) {
  for (const file of files) {
    try {
      ejs.compile(fs.readFileSync(file, "utf8"), { filename: file });
    } catch (error) {
      failures.push(`${path.relative(root, file)}\n    ${error.message.split("\n")[0]}`);
    }
  }
}

const scripts = collect(root, [".js", ".mjs"]);
const views = collect(path.join(root, "views"), [".ejs"]);

await checkScripts(scripts);
checkViews(views);

if (failures.length > 0) {
  console.error(`\n${failures.length} file(s) failed to parse:\n`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.info(`Parsed ${scripts.length} scripts and ${views.length} views — all clean.`);
