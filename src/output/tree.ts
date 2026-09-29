interface Node {
  children: Map<string, Node>;
  isFile: boolean;
  note?: string;
}

/**
 * Render an ASCII directory tree for a list of POSIX file paths.
 * Files are listed before directories at each level, both alphabetically, matching the
 * order files appear in the packed document.
 */
export function renderTree(paths: readonly string[], notes: ReadonlyMap<string, string> = new Map(), rootLabel = '.'): string {
  const root: Node = { children: new Map(), isFile: false };
  for (const path of paths) {
    let node = root;
    const parts = path.split('/');
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), isFile: i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
    const note = notes.get(path);
    if (note) node.note = note;
  }

  const lines = [rootLabel];
  const visit = (node: Node, prefix: string) => {
    const entries = [...node.children.entries()].sort(([a, na], [b, nb]) => {
      if (na.isFile !== nb.isFile) return na.isFile ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      const label = child.isFile ? name : `${name}/`;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${label}${child.note ? `  ${child.note}` : ''}`);
      if (!child.isFile) visit(child, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  visit(root, '');
  return lines.join('\n');
}
