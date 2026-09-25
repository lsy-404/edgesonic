// SPDX-License-Identifier: AGPL-3.0-or-later

export function retainCompilationAlbum(
  currentAlbum: { name: string | null; compilation: number | null } | null,
  albumName: string,
  incomingAlbumArtist: string | undefined,
  currentAlbumArtist: string | null | undefined,
): boolean {
  return currentAlbum?.compilation === 1
    && currentAlbum.name === albumName
    && (incomingAlbumArtist === undefined || incomingAlbumArtist === (currentAlbumArtist ?? undefined));
}
