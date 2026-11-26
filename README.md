# quantlink-docs

quantlink 工作区文档的集中副本，按 **调查** 与 **设计** 两大类组织。

- 快照日期：2026-11-26
- 性质：v1/v2/v3 与调查文档是集中副本；`设计/v4/` 是本仓维护的当前设计
- 原仓库：各自 `docs/`、`quantlink-trading-architecture/`、`146/` 均保持不变

## 目录

```text
quantlink-docs/
├── 调查/
│   ├── 146/                         历史 146 系统调查
│   ├── trading-architecture/        现有 trading 系统架构调查
│   ├── fasttrade/baselines/         FastTrade 基线记录
│   └── fin/
│       ├── evidence/                验收与运行证据
│       ├── reviews/                 架构/实现评审
│       ├── research/                专题调查
│       ├── incidents/               事故记录
│       ├── validation/              验证报告
│       └── status/                  里程碑与状态
└── 设计/
    ├── v1/
    │   ├── ors/
    │   └── fasttrade/
    ├── v2/
    │   ├── ors/
    │   └── fasttrade/
    ├── v3/
    │   ├── ors/
    │   └── fasttrade/
    ├── v4/                             当前设计（本仓维护）
    ├── 当前/
    │   ├── venue-contract/
    │   ├── simvenue/
    │   └── deploy/
    └── 现有系统-fin/
        ├── architecture/
        ├── tasks/
        ├── testing/
        ├── runbooks/
        ├── workflow/
        ├── security/
        └── ui/
```

## 来源映射

| 集中位置 | 原位置 |
|---|---|
| `调查/146/` | `quantlink-new/146/`（不含 `.git`） |
| `调查/trading-architecture/` | `quantlink-new/quantlink-trading-architecture/`（不含 `.git`） |
| `调查/fasttrade/baselines/` | `quantlink-fasttrade/docs/baselines/` |
| `调查/fin/evidence/` | `quantlink-fin/docs/evidence/` |
| `调查/fin/reviews/` | `quantlink-fin/docs/reviews/` |
| `调查/fin/research/` | `quantlink-fin/docs/research/` |
| `调查/fin/incidents/` | `quantlink-fin/docs/incidents/` |
| `调查/fin/validation/` | `quantlink-fin/docs/validation/` |
| `调查/fin/status/` | `quantlink-fin/docs/STATUS.md`、`01-里程碑与验收.md` |
| `设计/v1/ors/` | `quantlink-ors/docs/v1/` |
| `设计/v2/ors/` | `quantlink-ors/docs/v2/` |
| `设计/v3/ors/` | `quantlink-ors/docs/v3/` |
| `设计/v1/fasttrade/` | `quantlink-fasttrade/docs/v1/` |
| `设计/v2/fasttrade/` | `quantlink-fasttrade/docs/v2/` |
| `设计/v3/fasttrade/` | `quantlink-fasttrade/docs/v3/` |
| `设计/v4/` | 本仓维护，不复制自其他仓库 |
| `设计/v1/fasttrade/superpowers/` | `quantlink-fasttrade/docs/superpowers/` |
| `设计/当前/venue-contract/` | `quantlink-venue-contract/docs/` |
| `设计/当前/simvenue/` | `quantlink-simvenue/docs/` |
| `设计/当前/deploy/` | `quantlink-deploy/docs/` |
| `设计/现有系统-fin/architecture/` | `quantlink-fin/docs/architecture/` |
| `设计/现有系统-fin/tasks/` | `quantlink-fin/docs/tasks/` |
| `设计/现有系统-fin/testing/` | `quantlink-fin/docs/testing/` |
| `设计/现有系统-fin/runbooks/` | `quantlink-fin/docs/runbooks/` |
| `设计/现有系统-fin/workflow/` | `quantlink-fin/docs/workflow/` |
| `设计/现有系统-fin/security/` | `quantlink-fin/docs/security/` |
| `设计/现有系统-fin/ui/` | `quantlink-fin/docs/ui/` |

## 使用规则

1. v1/v2/v3 和调查文档修改时，先改原仓库文档；本仓只做集中快照。
2. `设计/v4/` 例外：直接在 `quantlink-docs` 修改，作为当前设计真源。
3. 跨版本相对链接在集中目录下可能失效；阅读时以原仓库路径为准。
4. `146` 使用工作区内的 `quantlink-new/146`，不是 `/Volumes/DevDisk/146` 历史代码盘。
5. `.git`、`.DS_Store`、`node_modules` 和构建产物不进入本仓。
