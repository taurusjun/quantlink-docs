# CTP 密钥本地加密

## 目标

CTP 的 `PASSWORD` / `AUTH_CODE` 不再以明文散落在多个 `.cfg` 中。

采用：

```text
/etc/quantlink-fin/secrets/ctp.key      root:quantlink 0600
/etc/quantlink-fin/secrets/ctp.enc      root:quantlink 0600
```

`ctp.enc` 是 AES-256-CBC + PBKDF2 加密后的 JSON，主密钥只存在本地
`ctp.key`，不提交仓库、不打印。

## 工具

```text
tools/security/ctp_secrets.py
```

### 初始化主密钥

```bash
ctp_secrets.py init-key --key /etc/quantlink-fin/secrets/ctp.key
chown root:quantlink /etc/quantlink-fin/secrets/ctp.key
chmod 640 /etc/quantlink-fin/secrets/ctp.key
```

### 初始化加密文件

```bash
ctp_secrets.py init --key /etc/quantlink-fin/secrets/ctp.key \
  --file /etc/quantlink-fin/secrets/ctp.enc
```

### 从现有 CTP 配置导入

```bash
ctp_secrets.py import-cfg \
  --key /etc/quantlink-fin/secrets/ctp.key \
  --file /etc/quantlink-fin/secrets/ctp.enc \
  --account TEST-SHENGLI \
  --config /etc/quantlink-fin/ctp/ors_server_shengli.cfg
```

导入只读取 `PASSWORD / AUTH_CODE / INVESTOR_ID / BROKER_ID / FRONT_ADDR_*`。

### 查看账号（不显示密钥）

```bash
ctp_secrets.py list --key ... --file ...
```

输出示例：

```text
TEST-SHENGLI  investor=99000943 broker=88888 password=set authCode=set
```

### 生成无密钥模板

```bash
ctp_secrets.py secure-template \
  --config /etc/quantlink-fin/ctp/ors_server_shengli.cfg \
  --out /etc/quantlink-fin/ctp/ors_server_shengli.cfg.tpl
```

模板中：

```text
PASSWORD = __PASSWORD__
AUTH_CODE = __AUTH_CODE__
```

### 启动前渲染

```bash
ctp_secrets.py render \
  --key /etc/quantlink-fin/secrets/ctp.key \
  --file /etc/quantlink-fin/secrets/ctp.enc \
  --account TEST-SHENGLI \
  --template /etc/quantlink-fin/ctp/ors_server_shengli.cfg.tpl \
  --out /run/quantlink-fin/ors_server_shengli.cfg
```

然后 ORS 使用 `/run/quantlink-fin/ors_server_shengli.cfg`。

## 切换顺序

1. 生成 key 和 `ctp.enc`
2. 导入 SimNow / SimShengli 账号
3. 生成 `.cfg.tpl`
4. 在日盘验证 `render` 输出与当前可用配置一致
5. 修改 RuntimeAgent `ors.command` 使用渲染后的 `/run/...cfg`
6. 验证 ORS 启动、登录、行情、交易
7. 从原 `.cfg` 清空明文 `PASSWORD / AUTH_CODE`

在日盘验证前，不要删除原配置，避免无法登录。
