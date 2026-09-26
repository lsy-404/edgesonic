# Chromatic PCM 解码收据

## 第一对

- WAV object：`obj_08a4d6b81daada98`，路径为 A 盘第一轨。
- FLAC object：`obj_7e87c412100db7b0`，现有 FLAC 专辑第一轨。
- 两个对象都从生产 R2 只读下载，并由 FFmpeg 解码为 signed 32-bit little-endian PCM。
- WAV：44100 Hz、双声道、12348000 个时间基单位、98784000 个 PCM 字节、SHA-256 `8B13C2DB8C2F06D802EA1240E49BCCE3C3258E498DB2F8392CE9C312F5FD37C1`。
- FLAC：48000 Hz、双声道、13344000 个时间基单位、106752000 个 PCM 字节、SHA-256 `832A56D5B7205B193338EA41E7EDD12C467332DF19CF35584F8313E423E4A947`。
- 结论：第一对格式参数、PCM 长度和哈希均不同。该结论只覆盖第一对，不能外推到其余 23 对。
