# Findings

Both shared song query projections already join `albums al`; they lacked only `al.year`. `mapSong` constructs the Subsonic child, and `SubsonicChild.year` already supports numeric years. An unset album year is omitted from the response object.
