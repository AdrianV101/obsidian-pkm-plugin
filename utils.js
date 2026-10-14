import fs from "fs/promises";
import path from "path";

export { extractFrontmatter } from "./frontmatter.js";

/** Recursively get all markdown files in a directory (skips dotfiles/dirs). */
export async function getAllMarkdownFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...await getAllMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  return files;
}
