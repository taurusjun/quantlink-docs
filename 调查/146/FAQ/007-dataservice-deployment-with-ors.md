# DataService 读取 SHM，是不是部署在 ORS 一起？

## 短答

**不是同一个进程，但 Streaming/SHM 模式必须和 ORS 同机。**

## 146 的两种 DataService

### Streaming 模式

```text
dataservice configStream_CTP.xml
```

读本机 SysV SHM：

- 872：行情
- 3872：ORS 请求
- 4872：ORS 回报
- 727272：ClientStore

要求：

- 和 ORS **同一台机器**；
- 同 IPC 命名空间（容器要 `--ipc=host` 或共享 IPC）；
- 独立进程，不是 ORS 的子模块。

### Service 模式

```text
dataservice configService.xml
```

监听 `20000`，通过 TCP 连 ORS：

```text
CME   127.0.0.1:1733
China 127.0.0.1:1732
```

理论上可跨机，但归档配置是 `127.0.0.1`，历史上仍同机。

## 结论

- `ors_server` 和 `dataservice` 是两个可执行文件、两个进程。
- SHM 模式必须同机；TCP 模式可同机/远程。
- DataService 不是 ORS 启动的；历史启动顺序里是单独执行 `runDataService.sh` 或 `runDataStream_CTP.sh`。
- DataService 不在策略下单主链路；它旁路读 ORS 请求/回报。

## 新系统

`aeron:ipc` 同样要求 DataService/只读订阅者和交易/ORS 进程：

- 同机；
- 共享同一个 `aeronDir`/media driver；
- 独立进程；
- 容器共享 `aeronDir` 卷 + IPC 命名空间。

## 证据

- `3/infra/dataservice_deploy/runDataStream_CTP.sh:1`
- `3/infra/dataservice_deploy/configStream_CTP.xml:16-35`
- `3/infra/dataservice_deploy/runDataService.sh:1`
- `3/infra/dataservice_deploy/configService.xml:2-30`
- `146/05-build-deploy-ops.md`
