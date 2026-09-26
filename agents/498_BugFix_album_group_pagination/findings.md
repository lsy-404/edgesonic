# Findings

The current projection only emits a group card when the first ID in `memberAlbumIds` is present in `allAlbums`. Because pagination accumulates albums, the representative should be the first member encountered in that accumulated ordering. This makes an earlier fetched non-anchor edition visible while keeping the card stable as pages are appended.
