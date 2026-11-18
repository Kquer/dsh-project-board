# dsh-project-board · 项目看板

给 **DeepSeek Harness（DSH）** 用的只读项目看板。适合“文档和代码放在同一个仓库”的项目。

DSH 右侧栏只保留一个启动器；真正的主界面是**独立网页**：在任意浏览器全屏打开，查看当前项目的参考文档、可缩放拖拽的模块依赖画布、开发日志。插件不会修改项目文件。

## 三个区域

| 区域 | 默认数据源 | 行为 |
|---|---|---|
| 参考文档 | `docs/reference/**/*.md` | 只读 Markdown，按目录分组；支持参考目录下的图片 |
| 项目结构 | `docs/board/project-map.json` | 默认自上而下架构（概念子系统 → 模块），另有依赖 / 数据流 / 流程视图；缩放、平移、筛选、聚焦、导出 SVG/布局 |
| 开发日志 | `docs/DEVLOG.md` | 按 `##` 条目折叠，最新一条默认展开 |

看板会跟随**当前会话的工作目录**。切换到另一个 DSH 工作区时自动解析那个项目；也可以用页面顶部的项目切换器，打开 DSH 已登记的其他 Workspace。

## 一张结构图，四种视图

结构画布读同一份 `project-map.json`，默认是**自上而下的架构视图**：

| 视图 | 回答什么问题 |
|---|---|
| 架构（默认） | 项目由哪几个概念模块组成（渲染、第一人称移动、卡牌战斗等），各自完成度与跨系统依赖；双击卡片进入该子系统的模块依赖 |
| 依赖 | 模块之间谁依赖谁；有子模块的节点**双击下钻**，面包屑返回；跨出当前范围的依赖显示成「外部依赖」桩节点 |
| 数据流 | 一个关键属性在哪里定义、谁修改、传给谁读。选中属性后，画布标出定义/修改/读取处，并画写/读连线 |
| 流程 | 一次执行按什么顺序经过哪些系统。选中流程后，节点显示步骤编号，连线按顺序高亮，检查器给出时序步骤 |

架构视图按 **分而治之 → 逐步求精 → 关注点分离** 组织：先看少数 `subsystems` 卡片，再进入某个子系统的模块，再往下看属性和流程。每个子系统声明 `concern`（玩法/表现/服务/数据/内核/工具），用颜色区分。没有 `subsystems` 的旧项目会自动回退到依赖视图。

### 关键属性与执行流程

- `attributes` 只放**关键值**，不是所有配置字段；每条写清楚定义位置、`sourceModule`、`writtenBy`、`readBy`、影响、是否可调、默认值。`default: null` 表示「用户还没拍板」，插件不会替你填玩法数值。
- `flows` 是命名的步骤序列；每一步标模块、动作、读/写哪些属性。一个场景 3–10 步，不要把整个调用栈搬进来。
- Host 会校验属性/流程引用的模块和属性、父模块循环、重复 id、悬空依赖；坏数据会显示错误，不会白屏。

## 环境要求

- DSH `0.2.2-rc.3` 或更高的 `0.2.x`（依赖右侧栏、`ctx.webServer`、会话工作目录服务）。
- 插件是双半包（Host + 浏览器启动器），无构建步骤、无 npm 依赖。

## 仓库与开发

这个包在 [github.com/Kquer/dsh-project-board](https://github.com/Kquer/dsh-project-board)（私有仓库）维护。**仓库根目录就是插件包**，clone 下来后可直接用 **Plugins → Add plugin** 指向它。

```bash
git clone git@github.com:Kquer/dsh-project-board.git
cd dsh-project-board
node --check index.js client.js web/app.js
git tag -a v0.2.1 -m "dsh-project-board 0.2.1"   # 下一次发布
git push origin main --tags
```

改动时同步更新 `CHANGELOG.md` 和 `package.json` 的 `version`。项目侧继续维护自己的 `docs/reference`、`docs/board/project-map.json`、`docs/DEVLOG.md`；这个仓库只放插件本身。

## 安装（本地目录）

1. 把本目录放到机器的任意位置，例如 `<仓库>/plugins/dsh-project-board`。
2. 在 DSH 打开 **Plugins → Add plugin**，选择这个目录并启用。
3. 刷新一次 DSH 页面，让浏览器端启动器模块加载。

profile 里是目录链接，修改插件不用重装；Host 代码改动需要重载插件或重启 DSH。

## 打开看板

- 点输入框工具栏的 **「看板」** → 右侧栏启动器 → **「在浏览器打开看板」**。
- 或展开右侧栏，点页签栏 **「+」**，选 **「项目看板」**。

启动器会显示当前项目、文档/模块数量，以及带令牌的网页地址。地址在 DSH 重启前有效；每次从 DSH 打开都会拿到新的。

## 配置

包内 `cordis.patch.yml` 给了默认值，可在插件行的 config 里覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `''` | 项目根目录。留空时依次取：当前会话工作目录 → 配置的 root → 第一个已登记 Workspace |
| `referenceDir` | `docs/reference` | 扫描 `.md` 的目录 |
| `mapPath` | `docs/board/project-map.json` | 结构图数据 |
| `devlogPath` | `docs/DEVLOG.md` | 开发日志 |
| `projectPath` | `docs/PROJECT.md` | 允许只读接口读取（可选） |
| `layoutPath` | `docs/board/layout.json` | 可选的仓库内布局文件；浏览器本地布局会覆盖它 |

相对路径都相对项目根目录，且不能越界。

## 项目数据约定

```text
<项目>/
├── AGENTS.md
├── docs/
│   ├── reference/                 # 你写的技术 / 玩法文档
│   │   ├── INDEX.md
│   │   └── assets/                # 文档引用的图片
│   ├── board/
│   │   ├── project-map.json       # 模块、分层、依赖、状态
│   │   └── layout.json            # 可选的导出布局
│   ├── PROJECT.md
│   └── DEVLOG.md
└── ...
```

`project-map.json`：

```jsonc
{
  "schemaVersion": 2,
  "project": { "name": "我的游戏", "phase": "原型期", "updated": "2026-11-18" },
  "layers": [{ "id": "gameplay", "label": "Gameplay", "order": 1 }],
  "subsystems": [{
    "id": "first-person",
    "label": "第一人称移动模块",
    "order": 1,
    "concern": "gameplay",
    "summary": "输入 → 玩家状态 → 移动/躲避 → 相机",
    "modules": ["player", "movement", "player-view", "config"]
  }],
  "modules": [{
    "id": "cards",
    "label": "卡牌系统",
    "layer": "gameplay",
    "status": "todo",
    "summary": "纯 C# 规则内核",
    "path": "src/Gameplay/Cards",
    "focus": true
  }, {
    "id": "cards-rules",
    "label": "牌库与规则",
    "layer": "gameplay",
    "status": "unknown",
    "parent": "cards",
    "entry": "CardRules.Resolve"
  }],
  "attributes": [{
    "id": "cardEnergy",
    "label": "每回合能量",
    "kind": "config",          // config | state | derived
    "source": "Config/Cards.asset#energy",
    "sourceModule": "config",
    "default": null,           // null = 用户还没拍板
    "writtenBy": ["cards-rules"],
    "readBy": ["cards-rules", "card-ui"],
    "affects": ["出牌节奏"],
    "tunable": true,
    "status": "unknown"        // confirmed | pending | unknown
  }],
  "flows": [{
    "id": "card-play",
    "label": "打出一张牌",
    "trigger": "玩家操作",
    "status": "draft",         // draft | confirmed
    "steps": [
      { "module": "card-ui", "action": "选择卡牌" },
      { "module": "cards-rules", "action": "校验费用", "reads": ["cardEnergy"] },
      { "module": "cards-effects", "action": "执行效果" }
    ]
  }],
  "edges": [{ "from": "cards", "to": "config", "kind": "depends" }],
  "focus": [{ "module": "cards", "why": "先做这个" }]
}
```

`edges[].kind` 支持 `depends`（默认）、`uses`、`contains`、`event`。`parent` 形成层次，`attributes` / `flows` 驱动数据流与执行流程视图。悬空引用、父模块循环、重复 id、非法状态由 Host 校验并显示成错误，不会让页面崩掉。

## 画布操作

| 操作 | 方式 |
|---|---|
| 进入子系统 | 双击架构卡片；面包屑返回架构总览 |
| 缩放 | 滚轮、`+` / `-`、工具栏 |
| 平移 | 拖空白处 |
| 移动节点 | 拖节点 |
| 适应全部 | `0`、双击空白、或 **⤢** |
| 进入子模块 | 双击有子模块的节点（依赖视图）；面包屑返回 |
| 聚焦节点 | 双击叶子节点，或检查器里的「居中」 |
| 查看详情 | 单击节点；右侧显示说明、代码落点、依赖、被依赖、关键属性、流程 |
| 追属性链路 | 切「数据流」，选属性；橙色=写、绿色=读，定/改/读角标 |
| 走执行流程 | 切「流程」，选流程；`[` / `]` 或上一步/下一步 |
| 筛选 | 状态胶囊、**分层**菜单、搜索框（`Enter` 跳到第一个匹配） |
| 重置布局 | **重置布局** 清除本机拖动位置 |
| 跨设备共享布局 | **导出布局** → 提交为 `docs/board/layout.json` |

布局存在浏览器 `localStorage`（按项目区分）；仓库里的 `layout.json` 会作为底层布局合并，团队可以共享一个初始排版。

## 和 Git / 多人协作

- `docs/` 跟代码放同一个仓库，文档改动和代码改动进同一个 commit / PR。
- 每个人 clone 仓库，在本机 clone 里跑 DSH；看板读本地文件，私有库也不需要额外 token 或 GitHub API。
- 开工前 `git pull`；看板每 10 秒自动刷新，正文按 mtime 增量重读。
- `docs/reference/` 是用户维护区；即使 AI 参与，也建议在 `AGENTS.md` 里写死“只读”。插件本身没有任何写接口。
- `layout.json` 当普通受审文件提交即可，避免每个人排版不同。

## 发布到 DSH 插件索引

DSH 的 **Plugins → Discover** 读取用户自己添加的索引，没有官方商店。发布步骤：

1. 把包推到公开 Git 仓库（或 npm），固定一个 commit。
2. 写 format 1 索引，版本指向该 commit：

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins", "zh": "我的 DSH 插件" },
  "plugins": [{
    "name": "dsh-project-board",
    "metadata": {},
    "versions": [{
      "version": "0.2.0",
      "publishTimestamp": 1763500000,
      "source": {
        "type": "git",
        "url": "https://github.com/<你>/<仓库>",
        "commit": "<40 位 commit>"
      },
      "engines": { "dsh": ">=0.2.2-rc.3 <0.3.0" }
    }]
  }]
}
```

3. 把索引 JSON 托管到 HTTPS 地址（GitHub Pages 或 raw）。
4. 用户在 **Plugins → Discover → Index sources** 添加这个地址。

## 安全与只读保证

- 网页由本机 DSH 的 web server 提供。静态壳公开；所有数据接口都要求页面 URL 里的随机进程令牌。
- 数据接口只读：扫描文档目录、解析结构图和日志。插件没有写路由。
- 文档接口只允许参考目录、`DEVLOG.md`、`PROJECT.md`，并用 `realpath` 防越界；图片只允许参考目录下的常见位图格式。

## 限制

- Markdown 覆盖标题、列表、表格、引用、代码块、链接、粗斜体、图片；Mermaid 按源码显示，相对 `.md` 链接可在看板内跳转。
- 画布只编辑**布局**，不直接编辑架构数据；增删模块/依赖/属性/流程请改 `project-map.json`，或让 AI 改。关键属性刻意保持少量，不要把所有配置字段都搬进来。
- 布局不会实时同步给别人；要共享就提交 `layout.json`。
- 启动器令牌在 DSH 重启后失效，需要从 DSH 重新打开。
- DSH 仍是快速迭代的 pre-1.0 产品；本插件按 `0.2.x` 的右侧栏与 web server API 编写。

## 许可证

MIT，见 [LICENSE](LICENSE)。
