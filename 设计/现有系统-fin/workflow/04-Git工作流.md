# Git 工作流

- 强制规则：**每个任务完成必须 commit 并 push 到 origin**
- 未 push 的任务不算 DONE
- 里程碑完成必须有独立 milestone commit

---

## 1. 分支

| 分支 | 用途 |
|---|---|
| `main` | 稳定主线 |
| `feat/T-xxx-*` | 单任务开发 |
| `fix/T-xxx-*` | 修复 |
| `milestone/Mx` | 里程碑集成（可选） |

小任务可直接在 `main` 上开发；跨多任务/大改动用 `feat/` 分支。

---

## 2. 提交信息

格式：

```
<type>(<task-id>): <summary>
```

类型：

| type | 用途 |
|---|---|
| feat | 新功能 |
| fix | 修复 |
| docs | 文档 |
| test | 测试 |
| refactor | 重构 |
| chore | 构建/工具 |
| milestone | 里程碑 |

示例：

```
docs(T-001): 初始化方案、任务分解与工程骨架
feat(T-002): SBE schema v0 与 Java/C++ 代码生成
test(T-003): Aeron Java/C++ 10 万条消息往返
milestone(M1): P0 技术验证通过
```

---

## 3. 任务完成流程

1. 更新任务文档状态为 `DOING` → 完成后 `DONE`
2. 跑通该任务全部测试用例
3. 归档可视化证据到 `docs/evidence/`
4. `git add` 相关文件
5. `git commit -m "<type>(<task-id>): ..."`
6. `git push origin <branch>`
7. 更新 `docs/tasks/README.md` 状态表
8. 在任务文档记录 commit hash / push 结果

### 任务完成检查清单

- [ ] 测试通过
- [ ] 截图/证据归档
- [ ] 任务文档更新
- [ ] `git status` 干净
- [ ] commit 已创建
- [ ] push 成功
- [ ] 记录 commit hash

---

## 4. Remote

新仓库需要配置 origin，例如：

```bash
git remote add origin git@github.com:<org>/quantlink-fin.git
git branch -M main
git push -u origin main
```

当前仓库尚未配置可用 remote；首次 push 前需要确认仓库地址与权限。

---

## 5. 禁止

- 不 commit 密钥/凭据
- 不 commit `node_modules/`、`build/`、`dist/`
- 不 commit 测试截图 diff 临时文件
- 不 force push `main`
- 不在未通过测试时标记 DONE
- 不在任务完成后只 commit 不 push

---

## 6. 失败处理

- push 失败：保留本地 commit，修复 remote/权限后重试
- 冲突：先 rebase，再跑测试，再 push
- 大文件：使用 Git LFS 或对象存储，不入库
- 敏感信息误提交：立即轮换密钥，清理历史

---

## 7. 里程碑 commit

每个里程碑完成时：

```bash
git add .
git commit -m "milestone(M1): P0 技术验证通过"
git push origin main
```

并在 `docs/01-里程碑与验收.md` 记录：

- 日期
- commit hash
- 验证证据路径
- Go/No-Go 结论
