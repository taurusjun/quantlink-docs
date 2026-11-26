# 参考对照

本目录是对照记录，不是正式设计文档；正式设计文档在 `../`，编号 `001-...` 起。

排序原则：先 TB 基准，再 ORS 基准，最后历史 146。

| 文件 | 基准 | 用途 |
|---|---|---|
| `001-tb-origin-parity.md` | `tb_origin = /Volumes/DevDisk/git/tb_origin/tbsrc` | 权威 TB/报单行为对照 |
| `002-china-ctp-ors-parity.md` | `/Users/wangjun/Documents/my/fin/fromCompany/gitrepo/ors/China` | 公司 ORS 的 CTP 分支对照 |
| `003-146-ors-parity.md` | `/Volumes/DevDisk/146/` | 历史 ORS 对照 |
| `004-new-ors-change-list.md` | 001–003 | 新系统 ORS 改动清单 |

规则：

- `tb_origin` 是业务逻辑基准；不要用“看起来合理”的逻辑替代。
- 新系统与基准的差异写在对应文件里，不直接改基准代码。
- 对照文档不占正式设计编号。
