/**
 * Path-prefix grouping shared by every ref kind the Branches tree nests:
 * local branches, remote branches and tags.
 *
 * Pure and vscode-free so the folding rule has one definition and one set of
 * tests, rather than a copy per ref kind.
 */

/** A ref that can nest: anything with a slash-delimited name. */
export interface INamedRef {
  name: string;
}

/**
 * Split refs into the folders and leaves that belong at one level of the
 * tree, given the path already walked. A ref whose remaining suffix still
 * holds a `/` becomes (part of) a folder bucket; one that doesn't is a leaf
 * labelled with that trailing segment alone.
 *
 * Shared by branches and tags so the two can't drift: git4idea feeds one
 * `groupByPrefix` with every ref kind (`NodeDescriptorsModel.buildTreeNodes`
 * over a `RefsCollection` of local branches, remote branches and tags).
 *
 * Folders sort before leaves, each alpha-sorted, matching
 * `BranchTreeNodeComparator`.
 */
export function partitionRefsByPathSegment<T extends INamedRef>(
  refs: readonly T[],
  folderPath: string,
  remotePrefix: string | undefined
): {
  folders: Array<{ segment: string; childPath: string }>;
  leaves: Array<{ ref: T; displayName: string }>;
} {
  // The suffix of `name` below the path already walked, or undefined when
  // the ref doesn't live under this folder at all.
  const stripPrefix = (name: string): string | undefined => {
    let rest = name;
    if (remotePrefix) {
      const remoteWithSlash = `${remotePrefix}/`;
      if (!rest.startsWith(remoteWithSlash)) {
        return undefined;
      }
      rest = rest.slice(remoteWithSlash.length);
    }
    if (folderPath) {
      const folderWithSlash = `${folderPath}/`;
      if (!rest.startsWith(folderWithSlash)) {
        return undefined;
      }
      rest = rest.slice(folderWithSlash.length);
    }
    return rest;
  };

  const leaves: Array<{ ref: T; displayName: string }> = [];
  const folderSegments = new Set<string>();
  for (const ref of refs) {
    const suffix = stripPrefix(ref.name);
    if (suffix === undefined || suffix === '') {
      continue;
    }
    const slash = suffix.indexOf('/');
    if (slash === -1) {
      leaves.push({ ref, displayName: suffix });
    } else {
      folderSegments.add(suffix.slice(0, slash));
    }
  }

  leaves.sort((a, b) => a.ref.name.localeCompare(b.ref.name));

  return {
    folders: Array.from(folderSegments)
      .sort()
      .map((segment) => ({
        segment,
        childPath: folderPath ? `${folderPath}/${segment}` : segment,
      })),
    leaves,
  };
}
