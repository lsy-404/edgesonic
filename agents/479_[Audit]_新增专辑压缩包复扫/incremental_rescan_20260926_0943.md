# 增量复扫 2026-09-26 09:43 UTC

- 使用 `.zip`、`.rar`、`.7z`、`.tar`、`.gz`、`.tgz`、`.bz2`、`.xz` 后缀和 `LastWriteTimeUtc` 检查。此口径比 09:11 记录的后缀集合更宽，故 Downloads 顶层计数为 272，不能与先前 263 直接作增量差值。
- 首选 `Z:\OneDrive - 510V\Downloads\专辑` 递归有 154 个归档；`Z:\OneDrive - 510V\Downloads` 顶层有 272 个。两处均无 09:11 UTC 以后修改的归档。
- `F:\OneDrive - 510V\Downloads\专辑` 和 Downloads 顶层在同一口径下分别为 154 和 272，也无 09:11 UTC 以后修改的归档。源文件仍优先读取 Z 盘。
- `F:\OneDrive\Download` 递归有 11 个归档，无 09:11 UTC 以后修改的归档。
- 仅只读列举文件，未读取归档内容或修改来源文件。

## 10:08 UTC 复扫

- 沿用同一后缀及时间口径：Z 盘专辑目录 154 个、Downloads 顶层 272 个；F 盘对应目录分别 154 个、272 个；本机个人 OneDrive Download 11 个。
- 所有来源均无 09:11 UTC 以后修改的归档。Z 盘继续作为优先读取来源。

## 10:45 UTC 复扫

- 同一后缀口径下，Z 盘专辑目录 154 个、Downloads 顶层 272 个；F 盘对应目录仍分别 154 个、272 个；个人 OneDrive Download 仍为 11 个。
- 无 10:08 UTC 以后修改的归档；未发现新增压缩包，仍优先读取 Z 盘。

## 11:09 UTC 全目录复扫

- 将口径扩大为 Downloads 全目录递归、同一后缀集合。Z 与 F 的 510V Downloads 均为 1,023 个归档，个人 OneDrive Download 为 11 个。
- 三处均无 10:45 UTC 以后修改的归档；Z 盘继续作为首选来源。此次只读列举路径和修改时间。
