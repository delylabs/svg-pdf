import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const EXCLUDED_DIRS = new Set(['node_modules', 'test-fixtures', 'build', 'dist']);

const shouldSkipDir = (name) => name.startsWith('.') || EXCLUDED_DIRS.has(name);

// Dotfiles sort first because '.' has a lower char code than any letter, ASCII or not.
const byNameCaseInsensitive = (a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
};

const listEntries = (dir) =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !(entry.isDirectory() && shouldSkipDir(entry.name)))
        .sort(byNameCaseInsensitive);

function buildTree(dir, prefix, lines) {
    const entries = listEntries(dir);
    entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const label = entry.isDirectory() ? `[${entry.name}]` : entry.name;
        lines.push(`${prefix}${connector}${label}`);
        if (entry.isDirectory()) {
            buildTree(path.join(dir, entry.name), `${prefix}    `, lines);
        }
    });
}

function generate(rootDir) {
    const lines = [];
    for (const entry of listEntries(rootDir)) {
        if (entry.isDirectory()) {
            lines.push(`[${entry.name}]`);
            buildTree(path.join(rootDir, entry.name), '    ', lines);
        } else {
            lines.push(entry.name);
        }
    }
    return lines.join('\n');
}

// Windows terminals default stdout redirects to the OEM codepage, which mangles the box-drawing chars.
const outputPath = process.argv[2]
    ? path.resolve(ROOT, process.argv[2])
    : path.join(ROOT, 'docs', 'project-structure.txt');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, generate(ROOT), 'utf8');
console.log(`Structure written to ${path.relative(ROOT, outputPath)}`);
