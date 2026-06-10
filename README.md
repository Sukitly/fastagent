# fastagent

agent serving 的 WSGI —— 把现成 agent 定义(`AGENTS.md` + `skills/`)零重写编译/部署成 production 服务,引擎/模型/云中立。

这是按锁定的 [Agent Handler SPEC v0.1](docs/SPEC.md) **从头重建**的仓库(弃旧 `fastagent-mono`,不背兼容)。

## 文档(`docs/`)

| 文档 | 内容 |
|---|---|
| [SPEC.md](docs/SPEC.md) | **Agent Handler 协议**(契约层,引擎中立)。`status: locked` v0.1 |
| [core-design.md](docs/core-design.md) | core 参考实现设计(用 pi 实现 SPEC)+ §0.5 N×M×K 分层口径 |
| [session.md](docs/session.md) | **session-admin 标准**(草案):event-sourced DAG + 三层解耦(fork / 回退)。`status: design` |
| [fastagent.md](docs/fastagent.md) | 索引 / 产品定位概览 |
| [positioning.md](docs/positioning.md) · [comparisons.md](docs/comparisons.md) | 战略定位 / 竞品对比 |

## 构建顺序

1. **core**(`core/`)—— 先把 SPEC 用代码实现(`invoke` 参考实现:fan-in pi 双口 → 单流)。
2. **两端扩展** —— N triggers(channel)/ K hosts(target adapter)。
