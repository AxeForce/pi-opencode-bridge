export function addFileDiffMetadata(
  metadata: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (metadata.filediff && typeof metadata.filediff === 'object') return metadata;

  const file = firstString(input.filePath, input.path, input.file, metadata.path, metadata.file);
  const legacyFileDiff = typeof metadata.filediff === 'string' ? metadata.filediff : undefined;
  const patch = typeof metadata.patch === 'string'
    ? metadata.patch
    : legacyFileDiff?.startsWith('--- ')
      ? legacyFileDiff
      : undefined;
  const before = typeof input.oldString === 'string' ? input.oldString : undefined;
  const after = typeof input.newString === 'string' ? input.newString : undefined;

  if (!file || (!patch && before === undefined && after === undefined)) return metadata;

  const counts = countPatchChanges(patch);
  return {
    ...metadata,
    filediff: {
      file,
      ...(patch ? { patch } : { before: before || '', after: after || '' }),
      ...counts,
    },
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function countPatchChanges(patch: string | undefined): { additions: number; deletions: number } {
  if (!patch) return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}
