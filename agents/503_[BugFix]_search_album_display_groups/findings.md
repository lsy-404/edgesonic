# Findings

- 线上普通专辑网格已经把 Rain 与 Dream 等分组折叠；搜索 `Lost In Tianyi` 返回两张原始专辑卡。
- `Library.vue` 的搜索结果模板直接遍历 `searchResults.albums`，未调用现有 `foldAlbumDisplayCards`。
- 搜索可能在尚未载入普通专辑网格时触发，因此需要让搜索请求一并确保显示组摘要已载入。
- 首轮线上验收发现搜索卡能显示为一张分组卡，但点击后的版次详情被 `isSearchActive` 条件隐藏；需要让分组详情覆盖搜索结果并允许返回原搜索。
