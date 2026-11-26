# 附录 C — 未决问题与现场确认清单

> 这些不是“文档没写”，而是从仓库代码/脚本无法离线确认、需要 190 现场、数据库、柜台或负责人回答的问题。
> 优先级：P0 = 影响交易正确性/安全；P1 = 影响复刻/运维；P2 = 文档/优化。

## C.1 交易正确性（P0）

1. **`92204` 开盘后由谁激活？** 自动激活链只覆盖 `92221/92222`；`92204` 是当前启用策略之一，可能一直 inactive。证据：`02` §0、`07` §0/§2。
2. **`92221` 实际跑 IF 还是 TA？** day 目录同时存在两个 control（IF 与 TA），启动脚本/停用清单以哪个为准？
3. **`signal.txt` 是否存在？** `SIGTERM` 只有在该文件列出合约时才平仓；仓库没有该文件。若现场也没有，`stop_all` 的 SIGTERM 不平仓，最终 `kill -9`。
4. **`stop_all`/`tbstop` 收盘后是否真的空仓？** PairwiseArb 的 squareoff 是“撤单+等成交回报对冲”，不保证平光；需要现场核对券商持仓。
5. **`daily_init` 谁是最终修正者？** 当前代码只读，没有自动与 `position.csv`/CTP 对账修正；是否存在未入库的脚本/人工流程？
6. **账户净额与策略账本如何对账？** 当前没有自动对账；所有策略共享 `ACCOUNT=OWN`，同合约多策略会隐式净额。业务上允许吗？
7. **`MAX_POS_SIZE` 语义是否被现场理解？** 它是累计成交手数上限，不是持仓上限；策略持仓上限在 model 的 `MAX_SIZE/BID_MAX_SIZE/ASK_MAX_SIZE`。
8. **ORS 开平仓“整笔转开仓”是否可接受？** 数量超过可平量时，ORS 不拆单；可能把平仓意图变成开仓。现场是否有可平量保护/人工检查？
9. **RMS 规则实际启用哪些？** 生产 RMS 只启用 4 条；`ORDER_LIMIT_CHECK`/`ALLOWED_SYMBOL_CHECK` 被注释。需要确认 `prod.china.rms.xml` 现场版本。
10. **RMS 是否检查资金/保证金？** 代码不支持；如果业务要求，必须另加 pre-trade gate。

## C.2 部署与现场（P0/P1）

11. **190 的 `ors_server.cfg` 实际值**：`MAX_CLIENTS`/`REQUEST_SHMSIZE`/`POSITION_FILE`/SHM 线程/CPU 亲和；仓库不入库。
12. **`ipcs -m` 实际 SHM 段大小**是否与推算一致（MD 4096 槽等）；跨语言二进制契约必须现场核对。
13. **`STARTUP_GUIDE.md` 的 `MD_LEN_LIST=4096` 与 `md-recorder.yaml` 是否矛盾？** 需要现场定论。
14. **`tbadmin/lib` 的 `libyd/libmemlog/libpqhelper` 来源/版本/ABI**；仓库没有 `lib/` 和构建脚本。
15. **`check-md`/`md-recorder` 现场二进制构建来源**；仓库没有构建入口，只跑 `build_deploy_cpp.sh` 会缺这两个工具。
16. **190 的 `deploy_cpp`/crontab 是否与本 commit/`ops/crontab.txt` 一致**；包括夜盘是否仍停用。
17. **生产 CTP 前置/`PRODUCTION_MODE`/双登录窗口**；ORS 重启时同账号双登录互踢的风险。
18. **`/home/hft/tbdata` 软链是否存在**；缺失会导致 TradeBot 启动 `exit(1)`。
19. **`tbadmin` 私有库/YD 账户查询是否实际启用**；默认构建里 YD 代码被注释，账户/持仓页可能是空壳。
20. **`tbhft_strategy` 真实 DDL/索引/权限/`pg_hba`/PITR 状态**；仓库没有 DDL，字段类型/约束是反推。
21. **`tbhft_strategy.ref` 列类型**：C++ 写 `"1,-1"`，Python ORM 当 Integer；真实列是 int 还是 varchar？
22. **RDS→本地 `strategy_sync` 的冲突/覆盖规则是否符合预期**；它会覆盖 `active/core/corebind/path`。
23. **`ops/db.conf` 的 `WECHAT_WEBHOOK`/`MEMLOG_READER_CONFIG` 现场值**；不要打印值，只确认是否配置。
24. **生产实际启用策略集合**：DB 全量 277 行 vs 190 本机 6 个 sid；以哪个为准？
25. **`tbhft_product` 是否真有 ORM 声明的 `id` 列**；影响管理面查询。
26. **`tbhft_man_order.create_time` 默认值/`id` 生成方式**；C++ 从不写 `create_time`，前端按它过滤当日单。

## C.3 安全/管理面（P0）

27. **管理面端口实际暴露**：9980/9981/8882/5004/8080/8081/50003 是否被防火墙/安全组限制？是否只有回环？
28. **`tbadmin` ZMQ/HTTP 是否有认证/授权**；代码看起来没有。
29. **`popen()` 执行外部输入**是否在现网可达；`toadmin operation` 的 `sid/path` 来源是否可信。
30. **凭据是否已轮换**：CTP 密码、DB 密码、SSH 备用密码、webhook、Flask SECRET_KEY、YD/ESB 凭据；日志中是否出现明文。
31. **`.env`/`ops/db.conf` 权限**；是否 644、是否在 git、是否被备份到共享盘。
32. **SHM 权限**是否仍为 0666；本机是否有其他用户/进程。
33. **是否允许远程手工下单/撤单**；如果有，审计/双人复核在哪。
34. **是否存在不可篡改审计**；当前只有日志/DB 表，且可改。

## C.4 数据/备份（P1）

35. **DB 是否真的没有 `pg_dump`/WAL 归档/PITR**；`docs/RISK_NO_OFFSITE_BACKUP.md` 说没有，但需现场确认。
36. **`tbhft_strategy_bak_sync_*` 是否在同盘**；同盘表不是备份。
37. **`daily_init`/`position.csv`/`fee.csv`/`contractfile` 的备份/版本**；哪些在 git、哪些只在 190。
38. **`position.csv` 写路径是否已修好**（`live/data` 目录）；历史日志显示读/写失败，需确认当前。
39. **`check-md` 的 SHM 长度/退出码/日志**是否与 ops 脚本契约一致。
40. **日终 `ops_eod_report` 与 Dashboard 的端口**（8080 vs 28080）是否一致。

## C.5 文档/架构（P2）

41. **`main.cpp` 的 N-control-file 循环**是否还有生产用途；OptionManage 容器是否实际部署。
42. **`--commonBook` 是否在实盘使用**；会改变回报过滤/净额结论。
43. **`OptionManager::LoadOptionsParams()` 只在 SIGUSR2 调用**；启动不加载期权参数是否是预期。
44. **`docs/architecture/21-backup-pitr.md` 是否误引 `quantlink-fin`**；trading 仓库没有该文件。
45. **旧文档中的 “daily_init 自动修正”/“tbstop 保证平仓”**是否已被现场流程取代；代码不支持这些说法。

## C.6 复刻前必须拿到的外部材料

- 现场 `deploy_cpp/bin/config/ors_server.cfg`（脱敏后）。
- 现场 `crontab -l` / `ops/db.conf` 的键（不打印值）。
- `tbadmin/lib` 三个私有库及版本。
- `tbhft_strategy`/`tbhft_man_order`/`tbtrade_sections` 的真实 DDL 或 `pg_dump -s`。
- 生产 CTP 前置/账号/`PRODUCTION_MODE`（只给非敏感部分）。
- 近 1 个交易日的 ORS/TradeBot/tbadmin 日志样本（脱敏）。
- 账户/策略对账样例（`daily_init` + `position.csv` + 券商持仓）。
