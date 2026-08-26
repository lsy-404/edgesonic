// SPDX-License-Identifier: AGPL-3.0-or-later

export type FileSortKey = "name" | "size" | "type" | "modified";
export type FileSortDirection = "asc" | "desc";

export interface SortableDirectoryEntry {
  name: string;
  modifiedAt: number | null;
}

export interface SortableFileEntry extends SortableDirectoryEntry {
  size: number;
}

function suffixOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

function directional(result: number, direction: FileSortDirection): number {
  return direction === "asc" ? result : -result;
}

function compareModified(
  a: SortableDirectoryEntry,
  b: SortableDirectoryEntry,
  direction: FileSortDirection,
): number {
  if (a.modifiedAt === null && b.modifiedAt === null) {
    return directional(a.name.localeCompare(b.name), direction);
  }
  if (a.modifiedAt === null) return 1;
  if (b.modifiedAt === null) return -1;
  return directional(a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name), direction);
}

export function compareDirectoryEntries(
  a: SortableDirectoryEntry,
  b: SortableDirectoryEntry,
  key: FileSortKey,
  direction: FileSortDirection,
): number {
  if (key === "modified") return compareModified(a, b, direction);
  return directional(a.name.localeCompare(b.name), direction);
}

export function compareFileEntries(
  a: SortableFileEntry,
  b: SortableFileEntry,
  key: FileSortKey,
  direction: FileSortDirection,
): number {
  if (key === "modified") return compareModified(a, b, direction);

  let result: number;
  if (key === "size") result = a.size - b.size || a.name.localeCompare(b.name);
  else if (key === "type") result = suffixOf(a.name).localeCompare(suffixOf(b.name)) || a.name.localeCompare(b.name);
  else result = a.name.localeCompare(b.name);
  return directional(result, direction);
}
