# Findings

`music-metadata` 11.15.0's `WaveParser` clamps the RIFF data chunk to `tokenizer.fileInfo.size`. `strtok3.fromBuffer` resets that size to the actual `Uint8Array.length`, regardless of the remote object size passed to `parseBuffer`. The reported 145 MB file therefore appears as a 2 MiB WAV and yields 12 seconds.

The partial scan now accepts duration/bitrate only when the bounded header contains a standard RIFF/WAVE `fmt ` and nonempty `data` declaration that fits both the RIFF end and actual object size, describes PCM or IEEE float with valid channels/container bit depth/block alignment, and has a consistent byte rate. Duration is computed from declared frames; invalid declarations and RF64 yield no partial WAV duration/bitrate. Complete-buffer WAVE parsing is unchanged. Metadata worker results also carry a finite positive `bitsPerSample` as `bitDepth` when the parser supplies it, including FLAC.

The regression uses a 145,849,948-byte virtual PCM object and materializes only its two 2 MiB range responses. It confirms the library-only parse gives 12 seconds while the task result gives 827 seconds and 1411 kbps. Existing short complete-range WAV coverage confirms title tags and duration survive; inconsistent data length is rejected.
