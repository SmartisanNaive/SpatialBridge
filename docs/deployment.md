# SpatialBridge 部署与运维全指南

[← 返回文档索引](README.md) | [返回 README](../README.md)

SpatialBridge 默认以一个应用进程在 8000 端口提供前端和 API：

- **本地运行**：先构建前端，再启动带 `--frontend-dir frontend/dist` 的应用服务。
- **容器部署**：Docker Compose 或 Apple Container 将前后端一体化打包。
- **本地开发**：同样使用 8000 入口；前端改动后重新构建并刷新页面，后端改动后重启应用服务。

FastAPI 在同一 HTTP 端口提供前端生产静态页面、`/api` REST 接口、动态图像瓦片、验证叠加图和 CSV 下载，浏览器使用同源地址，不依赖客户端电脑的本地后端。

---

## 1. 系统模式与使用边界

- **共享单机服务模式**：适合实验室或课题组少量成员共同访问。项目不内置账号体系、RBAC 角色权限、用户数据隔离或多人协同编辑互斥锁。人工标注属于项目级数据；当前视野与观察设置通过浏览器标签页会话自动延续。
- **通信安全**：应用提供标准 HTTP 服务，不内置 TLS。生产环境暴露于公网时**必须**置于 Nginx / Caddy 等反向代理之后启用 HTTPS。
- **分片上传与断点续传**：
  - 文件按 **16 MiB** 分片上传，单片传输前自动计算 SHA-256 并由服务端校验；
  - 浏览器端自适应决策：充分压缩的 PNG 原样发送，可压缩数据启用无损 gzip 传输；
  - 支持重复分片幂等、暂停续传、页面刷新后重新选择原文件直接跳过已完成分片；
  - 服务端合并在后台异步执行，即使中途重启服务，已上传分片依旧保留。
- **单图像任务队列**：为防止多张 6.3 亿像素超大显微图并发处理导致服务器瞬时内存崩溃（OOM），后端设计为严格的单任务处理队列（`max_workers=1`），任务按提交顺序串行处理。
- **数据持久化隔离**：数据库、上传分片、计算报告和瓦片金字塔写入挂载的数据目录（容器内为 `/data`，本地开发默认为 `./workspace-data`），容器销毁不会丢失数据。

---

## 2. 本地原生运行

以下步骤从项目根目录执行，开发、日常使用与本地验收均使用同一单进程、单端口方式。

### 2.1 环境准备

#### 1. 基础运行时
- **Python**: 3.11 或更高版本，推荐安装 [uv](https://docs.astral.sh/uv/) 作为包管理工具。
- **Bun**: [Bun](https://bun.sh/) 1.4.4，与 CI 和 Docker 构建版本一致，无需单独安装 Node.js。

#### 2. 系统科学计算与 OCR 依赖（可选但推荐）
- **macOS (Homebrew)**：
  ```bash
  brew install libvips tesseract
  ```
- **Ubuntu / Debian**：
  ```bash
  sudo apt-get update && sudo apt-get install -y \
    libgl1 libglib2.0-0 libgomp1 libvips42 tesseract-ocr tesseract-ocr-eng
  ```

### 2.2 安装依赖

```bash
# 1. 安装后端依赖（包含大图瓦片加速与开发测试工具）
uv sync --extra tiles --extra dev

# 2. 安装前端依赖
bun install --cwd frontend --frozen-lockfile
```

> [!NOTE]
> `uv` 虚拟环境记录绝对路径。若移动或重命名了项目目录，请删除 `.venv` 后重新执行 `uv sync`；前端 `node_modules` 同理。

### 2.3 启动一体化服务

```bash
bun run --cwd frontend build
.venv/bin/spatialbridge serve --data-dir ./workspace-data --frontend-dir frontend/dist --port 8000
```

打开 `http://127.0.0.1:8000`。同一进程提供生产静态页面、API、光谱、图像瓦片与下载。`serve` 默认读取项目根目录下的 `frontend/dist`，也可通过 `--frontend-dir` 指定其他构建目录；首次启动前必须完成前端构建。`serve --help` 可核对 `--data-dir`、`--frontend-dir`、`--host`、`--port` 参数；需要局域网访问时加 `--host 0.0.0.0`。

### 2.4 开发时更新代码

保持一体化服务运行，在另一个终端从项目根目录重新构建前端：

```bash
bun run --cwd frontend build
```

构建结束后刷新 `http://127.0.0.1:8000`，应用会读取更新后的静态文件，无需为前端改动重启 Python 服务。此方式需要手动构建和刷新，不提供 Vite 热更新。

修改后端 Python 代码后，在运行服务的终端按 `Ctrl+C`，再执行原启动命令：

```bash
.venv/bin/spatialbridge serve --data-dir ./workspace-data --frontend-dir frontend/dist --port 8000
```

容器部署更新时，发布镜像用户拉取新镜像并重建容器；仅本地源码构建用户需要重新编译镜像，见[服务升级与版本回退](#61-服务升级与版本回退)。

### 2.5 离线批处理 CLI

若无需 Web 交互界面，可直接在命令行对包含显微图和 SBD 的来源目录执行自动化配准并导出报告：

```bash
uv run spatialbridge register --source-dir ./参考数据 --output-dir ./workspace-data/manual-check
```

---

## 3. 容器部署指南

SpatialBridge 提供基于 [Dockerfile.api](../Dockerfile.api) 的前后端一体化镜像。Compose 项目名和容器名均为 `spatialbridge`；默认拉取 GitHub Actions 发布的 `ghcr.io/smartisannaive/spatialbridge:latest`，无需在服务器安装 Bun 或编译源码。本地源码构建使用 `spatialbridge:local`。镜像名称使用小写；产品名称仍为 SpatialBridge。

[CI 工作流](../.github/workflows/ci.yml) 在 `main` 更新后先运行前后端测试，再构建 Linux amd64/arm64 镜像并发布到 GHCR；拉取请求只构建 amd64 镜像验证，不发布。也可在 GitHub Actions 的 CI 页面选择 `main` 手动运行。发布使用仓库自带的 `GITHUB_TOKEN`，无需额外配置 Docker Hub 密钥。

镜像已公开发布，可匿名拉取，无需执行 `docker login`。Docker 会按宿主机架构选择 amd64 或 arm64。镜像包含前端编译产物、Python 后端、libvips、OpenCV 运行依赖和 Tesseract；使用发布镜像的服务器无需安装第 2 节的 Python、uv、Bun 或系统计算依赖。

| 名称 | 用途 |
| --- | --- |
| `ghcr.io/smartisannaive/spatialbridge:latest` | 最近一次成功发布的默认版本；构建失败不会更新此标签 |
| `ghcr.io/smartisannaive/spatialbridge:sha-<完整提交 SHA>` | 指定源码提交的发布标签，用于固定版本和回退；只有发布成功的提交才有此标签 |
| `spatialbridge:local` | 本机源码构建使用的镜像名称，不由 GHCR 发布 |
| `spatialbridge` | Compose 项目名、服务名及容器名 |

[GitHub Actions](https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml) 只负责测试、构建和发布，**不会连接服务器更新容器**。更新服务器需要执行拉取与启动命令，见[服务升级与版本回退](#61-服务升级与版本回退)。同一 Docker 主机上，当前固定容器名适用于一个实例。

### 3.1 方案一：Linux 服务器生产部署（Docker Compose）

宿主机需要 [Docker Engine](https://docs.docker.com/engine/install/)、[Docker Compose V2](https://docs.docker.com/compose/install/) 和 Git；使用 `docker compose` 命令。可以先执行 `docker --version` 和 `docker compose version` 检查安装。以下首次部署步骤从服务器终端执行，后续 Compose 命令均在含 `compose.yaml` 和 `.env` 的部署目录中运行。

#### 1. 准备配置与目录
```bash
git clone https://github.com/SmartisanNaive/SpatialBridge.git
cd SpatialBridge

# 仅首次部署时复制模板；更新时保留已配置的 .env
cp .env.example .env

# 创建数据持久化目录，并将属主设为镜像内的运行用户 (UID 10001:10001)
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
```

#### 2. 检查 `.env` 配置
编辑 `.env` 文件，确认或修改以下关键配置：
```bash
# GitHub Actions 发布的镜像；也可改为已发布的 sha-<完整提交 SHA> 标签以固定版本
SPATIALBRIDGE_IMAGE=ghcr.io/smartisannaive/spatialbridge:latest

# 发布绑定的宿主机网卡（0.0.0.0 表示所有网卡，127.0.0.1 表示仅允许本机或反向代理访问）
SPATIALBRIDGE_BIND_ADDRESS=0.0.0.0

# 宿主机对外映射的端口
SPATIALBRIDGE_PORT=8000

# 数据持久化目录（与上面创建的目录一致）
SPATIALBRIDGE_DATA_DIR=/srv/spatialbridge/data
```

下表对应仓库的 `.env.example`；修改宿主机数据目录后，应创建该目录并赋予 UID/GID `10001:10001` 读写权限。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `SPATIALBRIDGE_IMAGE` | `ghcr.io/smartisannaive/spatialbridge:latest` | 拉取的发布镜像，也可固定到已发布的 SHA 标签 |
| `SPATIALBRIDGE_BIND_ADDRESS` | `0.0.0.0` | 发布到宿主机所有网络接口；仅本机或同机反向代理使用时设为 `127.0.0.1` |
| `SPATIALBRIDGE_PORT` | `8000` | 宿主机访问端口，容器内仍监听 8000 |
| `SPATIALBRIDGE_DATA_DIR` | `/srv/spatialbridge/data` | 宿主机持久化目录，挂载至容器 `/data` |

#### 3. 启动容器与验收
```bash
# 检查配置，再拉取 Actions 发布的完整应用镜像并后台启动
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d --no-build

# 查看运行状态、近期日志和健康接口
sudo docker compose ps
sudo docker compose logs --tail=100 spatialbridge
curl -fsS http://127.0.0.1:8000/api/health
```

健康接口应返回 `{"status":"ok"}`。Compose 配置会周期性检查此接口，启动后稍等再查看 `ps` 中的健康状态。浏览器访问 `http://<服务器IP>:8000`，检查首页和项目列表是否正常；自定义端口或监听地址时，相应替换以上访问地址。

前端、API、瓦片和 CSV 下载共用此端口。`/data` 保存数据库、完整上传文件、项目报告和缓存；停止或重建容器不会删除绑定挂载的宿主机数据。外部关联的 SBD 不包含在镜像或此目录内，需另外挂载，见[备份策略](#62-备份策略)。

#### 4. 日常操作与故障排查

```bash
sudo docker compose logs --tail=100 -f spatialbridge  # 持续查看日志；Ctrl+C 仅退出日志跟踪
sudo docker compose stop                           # 停止服务，保留容器和数据
sudo docker compose start                          # 启动已存在的容器
sudo docker compose down                           # 移除服务容器和网络，保留宿主机数据目录
```

| 现象 | 检查方法 |
| --- | --- |
| 拉取报 `manifest unknown` | 确认目标提交的 `Container image` 任务成功，且 SHA 标签是完整 40 位提交号；源码提交和发布完成有时间差 |
| GHCR 拉取超时或拒绝访问 | 检查服务器到 `ghcr.io` 的网络及 Docker 守护进程代理配置；当前发布包支持匿名拉取 |
| `/data` 写入报 `Permission denied` | 确认实际绑定目录与 `.env` 一致，并允许 UID/GID `10001:10001` 读写；不要只修改容器内目录 |
| 提示端口已被占用 | 修改 `.env` 的 `SPATIALBRIDGE_PORT`，然后重新执行 `up -d --no-build` |
| 容器正常但远端浏览器无法访问 | 检查绑定地址、宿主机防火墙或云安全组；`127.0.0.1` 仅允许本机访问 |
| 容器退出或一直不健康 | 查看 `ps`、日志和健康接口；核对数据目录权限、磁盘剩余空间和可用内存 |

#### 5. 可选：从源码构建

需要验证未发布的本地代码时，将 `.env` 中的 `SPATIALBRIDGE_IMAGE` 改为 `spatialbridge:local`，再运行：

```bash
sudo docker compose up -d --build --pull never
```

这样不会将本地构建结果误标为 GHCR 发布版本；更新源码后也使用此命令重新构建。切回发布镜像时，恢复 `.env` 中的 GHCR 地址，再执行 `docker compose pull` 和 `docker compose up -d --no-build`。

---

### 3.2 方案二：macOS 容器化运行（Apple Container）

在支持的 macOS 26+ 系统上安装并启动 Apple `container` 运行时后，可直接拉取发布的 ARM64 镜像。这里映射到 `18000` 端口，避免与本机 8000 服务冲突：

```bash
# 1. 拉取发布镜像
container image pull ghcr.io/smartisannaive/spatialbridge:latest

# 2. 首次部署：创建持久化命名卷并授权，容量按数据规模调整
container volume create -s 100G spatialbridge-data
container run --rm --user 0:0 --entrypoint /bin/chown \
  -v spatialbridge-data:/data ghcr.io/smartisannaive/spatialbridge:latest 10001:10001 /data

# 3. 启动长期容器服务
container run -d --name spatialbridge --cpus 4 --memory 6G \
  -p 127.0.0.1:18000:8000 -v spatialbridge-data:/data ghcr.io/smartisannaive/spatialbridge:latest

# 4. 验证服务健康状态
curl -fsS http://127.0.0.1:18000/api/health
```

需要从源码构建时，在仓库根目录运行 `container build -f Dockerfile.api -t spatialbridge:local --cpus 4 --memory 4G .`，再将上述运行命令中的镜像名改为 `spatialbridge:local`。命名卷独立保存数据；更新发布镜像后，需要停止并移除旧服务容器，再使用同一卷重新创建服务，单独 `container start` 不会切换到新镜像。

访问入口：`http://127.0.0.1:18000`。
容器启停与维护命令：
```bash
container logs spatialbridge                 # 查看日志
container stop --time 60 spatialbridge       # 优雅停止（等待当前瓦片或文件保存）
container start spatialbridge                # 启动已有容器
container delete spatialbridge               # 删除容器（不会删除 spatialbridge-data 命名卷）
```

---

## 4. 性能要求与容量规划

根据真实显微图数据（单图 $73953 \times 8538 \approx 6.3$ 亿像素）实测评估，建议按照以下规格进行硬件配置：

| 资源维度 | 最低配置（测试/小图） | 推荐生产配置（标准显微大图） | 高负载/团队多项目配置 | 关键瓶颈说明 |
| :--- | :--- | :--- | :--- | :--- |
| **CPU** | 2 vCPU | **4 ~ 8 核 (vCPU)** | 8 ~ 16 vCPU | 金字塔瓦片多线程编码（`TILE_WRITERS=8`），多核加速明显。 |
| **内存 (RAM)** | 4 GiB | **6 GiB ~ 8 GiB** | 16 GiB | **关键瓶颈**：全幅双图解码与最高层级下采样峰值约 2.8 ~ 3.5 GB。容器需限制 `--memory 6G` 以上防 OOM。 |
| **磁盘类型** | SATA SSD | **NVMe SSD / 高 IOPS 云盘** | 高性能 NVMe SSD | 单图金字塔切片产生数万个小 PNG 文件，高随机写入 IOPS 提升效率 3~5 倍。 |
| **磁盘空间** | 按输入估算 | **100 GB ~ 200 GB SSD 起，按项目数量扩容** | 500 GB+ SSD | 完整 SBD + 原始 PNG + 金字塔 + 渲染缓存；合并时另需容纳分片与目标文件。 |
| **网络上行** | 10 Mbps | **50 Mbps ~ 100 Mbps (LAN/专线)** | 1 Gbps (局域网) | 保证十万 spot 方框动态拉取与前后卷帘对比流畅无延迟。 |

---

当前上传保留完整 SBD，不再以约 27 MB 的坐标精简包代替。已验证样本原文件为 5,809,336,884 字节（约 5.4 GiB），这部分需要计入每个上传项目的持久化容量。合并完成前，分片与组装中的完整文件可能同时占用磁盘；PNG、瓦片、渲染缓存与备份还需额外空间。上表为规划起点，实际内存、处理耗时与 I/O 性能需以部署机器和数据实测。

光谱读取按需打开压缩块，不需要将整份 SBD 放入内存；多目标提取仍会分配逐点结果，不能据此把并发大请求视为零成本。API 限制单次 1–32 个目标、窗口合计 4,096 个分箱。

## 5. Nginx 反向代理与 SSL/TLS 终止

在公网或机构内网生产环境中，推荐使用 Nginx 作为前端反向代理并配置 HTTPS：

```nginx
server {
    listen 80;
    server_name spatialbridge.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name spatialbridge.example.com;

    ssl_certificate     /etc/ssl/certs/spatialbridge.crt;
    ssl_certificate_key /etc/ssl/private/spatialbridge.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # 分片上传支持：允许单片 16 MiB 传输（设置略高于 16M 以容纳协议头）
    client_max_body_size 24M;

    # 超大瓦片生成与密集查询的长连接超时
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 启用 HTTP/1.1 支持
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

---

## 6. 运维管理、备份与灾难恢复

### 6.1 服务升级与版本回退

更新前按[备份策略](#62-备份策略)备份数据和 `.env`，并记录当前运行版本。发布镜像带有源码提交标签，可用以下命令查看：

```bash
sudo docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' spatialbridge
```

等待目标提交的 GitHub Actions `Container image` 任务发布成功，再在部署目录执行：

```bash
# 1. 更新部署配置；保留服务器已有的 .env
git pull --ff-only origin main

# 2. 按 .env 指定的 latest 或 SHA 标签拉取镜像并更新容器
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d --no-build

# 3. 验证服务状态
sudo docker compose ps
sudo docker compose logs --tail=100 spatialbridge
curl -fsS http://127.0.0.1:8000/api/health
```

`pull` 只下载镜像，`up -d --no-build` 才会在镜像变化后重新创建容器。更新可能短暂中断服务，应在上传和图像处理任务结束后执行。`restart` 或 `start` 不会把现有容器切换到刚拉取的新镜像。更新时无需删除数据目录。

固定版本或回退时，编辑 `.env`，将以下占位符替换为先前已成功发布的完整 40 位提交 SHA：

```dotenv
SPATIALBRIDGE_IMAGE=ghcr.io/smartisannaive/spatialbridge:sha-<先前版本的完整40位提交SHA>
```

然后再次执行 `sudo docker compose pull` 和 `sudo docker compose up -d --no-build`，并验证健康状态。标签需确实存在于 GHCR，不能只凭源码提交推断已经发布。

此操作回退应用镜像，不会回退数据库或用户数据。若版本之间存在数据格式迁移，需核对对应版本说明，必要时使用更新前备份恢复；不要用旧镜像直接假定数据兼容。本地源码构建用户将 `.env` 保持为 `spatialbridge:local`，更新源码后按[源码构建](#5-可选从源码构建)的命令重新构建。

### 6.2 备份策略

为确保 SQLite 数据库、完整上传来源、原始分片与项目缓存状态一致，备份前建议先停止容器。另行保留部署目录中的 `.env`、Compose 配置和当前运行版本，方便恢复相同的数据路径和镜像。下面的归档示例使用默认 `/srv/spatialbridge/data`，自定义 `SPATIALBRIDGE_DATA_DIR` 时需调整归档目录，并先确认 `/srv/backups` 存在且可写。

目录导入或 `spectra-source.json` 关联的外部 SBD 不会被数据目录备份自动包含，需单独备份，并在恢复后保持原路径或重新关联。容器关联路径必须是容器内可访问的路径，宿主机文件需另设只读挂载。

```text
# 可选 Compose 挂载示例，放在服务的 volumes 中
- /srv/scils:/sources/scils:ro
```

此时在光谱面板填写 `/sources/scils/file.sbd`，不是宿主机路径。

数据目录备份示例：

```bash
# 1. 停止容器
sudo docker compose stop

# 2. 打包数据目录（务必添加 --numeric-owner 保留 10001 用户权限）
BACKUP_FILE="/srv/backups/spatialbridge-$(date +%Y%m%d-%H%M%S).tar.gz"
sudo tar --numeric-owner -czf "$BACKUP_FILE" -C /srv/spatialbridge data

# 3. 恢复容器运行
sudo docker compose start
```

### 6.3 灾难恢复

在全新服务器或故障恢复时，先准备 Docker、部署仓库和备份的 `.env`，确认目标镜像与数据目录。以下示例使用默认路径，恢复到新建空目录，已有数据应先另行保留，再将备份包解压并校正权限：

```bash
# 1. 停止当前服务
sudo docker compose down

# 2. 解压备份数据
sudo tar --numeric-owner -xzf /path/to/spatialbridge-backup.tar.gz -C /srv/spatialbridge

# 3. 校验并确保数据目录权限
sudo chown -R 10001:10001 /srv/spatialbridge/data
sudo chmod -R 770 /srv/spatialbridge/data

# 4. 拉取 .env 中指定的已发布版本并启动
sudo docker compose pull
sudo docker compose up -d --no-build
curl -fsS http://127.0.0.1:8000/api/health
```

### 6.4 数据目录内部结构说明
数据目录（如 `/srv/spatialbridge/data`）的布局如下：
```text
data/
├── spatialbridge.sqlite        # SQLite 元数据库（项目、上传、人工标注等）
├── uploads/                    # 上传分片临时目录及装配后的原始文件
│   └── <upload_id>/
│       ├── chunks/             # 未合并时的 16 MiB 临时分片
│       └── files/              # 合并完成后的原始 PNG 与完整 .sbd
└── projects/                   # 项目计算产物与图像缓存
    └── <project_id>/
        ├── report.json         # 综合配准与晶格报告
        ├── sbd-spots.npz       # SBD 坐标与 normalization 数组缓存
        ├── spectra-source.json # 可选：外部完整 SBD 关联路径
        ├── pyramids/           # 多分辨率瓦片金字塔（pre 与 after）
        ├── rendered-tiles-v3/  # 动态渲染的卷帘对比/透视切片缓存
        └── validation/         # 叠加校验图与晶格诊断图
```
数据目录内部引用使用 `data://` 和 `project://`，可随数据目录迁移。目录导入及本地关联的外部来源是例外，必须保留可访问路径或重新关联；不能仅迁移缓存便认定原始光谱可用。

---

## 7. 容器验证记录与验收清单

### GitHub Actions 与 GHCR 发布验证

首次发布对应提交 `ee27ef1da28196f0c70c0474b0ff0a1b4fc7aa5e`，见[成功的流水线](https://github.com/SmartisanNaive/SpatialBridge/actions/runs/44766639658)：

- 前后端测试及 `Container image` 任务均成功。
- GHCR 镜像清单包含 Linux amd64 和 arm64，支持匿名访问。
- 当次发布的 `latest` 与 `sha-ee27ef1da28196f0c70c0474b0ff0a1b4fc7aa5e` 指向同一个镜像清单；后续 `latest` 会随成功发布更新。
- Bun 1.4.4 的 Linux 前端构建及本地完整 ARM64 应用镜像构建成功；完整镜像中已确认前端存在，`cv2`、`h5py`、NumPy 和 SBD 读取器可以导入。

上述记录不替代目标服务器上的完整业务验收，真实文件上传、持久化、光谱读取与浏览器交互仍按本节清单核对。

### 本地容器验证记录（已通过）

- **2026-11-14 (macOS Apple Container 1.6.1)**：
  - 前端 TypeScript 编译与 Vite 生产打包验证；
  - 当时的宿主机后端与前端逻辑测试通过（不代表当前套件数量）；
  - 真实双 PNG（$73953 \times 8538$，合计 482 MB）分片上传、gzip 传输、SHA-256 篡改拒绝与重复片幂等；
  - 上传首片后停止并重建容器，断点续传恢复成功；
  - 瓦片金字塔切片、浏览器卷帘交互与 CSV 导出通过。
- **2026-11-17 (macOS Apple Container 1.6.1 全流程 6 阶段自动化测试)**：
  - 自动化脚本覆盖系统环境（UID 10001、Python 3.12.16、Tesseract 5.3.0、`pyvips`/`cv2`/`h5py` 协同导入）；
  - HTTP 静态路由与 SPA 兜底（`/workbench` 返回 index.html，未知 `/api` 严格返回 404）；
  - 端到端双图配准计算（8 点方孔单应拟合 RMSE $< 10^{-12}\text{ px}$）；
  - 容器停机销毁后基于相同命名卷重建，数据库项目与瓦片保持可用；
  - 合成 SBD 精简包在容器内解析出 3 个 spot 及 TIC 归一化字段；该项不验证完整真实 SBD 的光谱解码。

当前 SBD 读取工作的合成与可选真实样本测试见 [SBD 验证](sbd-spectra-reader.md#验证)。这些读取验证与历史容器验收范围不同；新部署应另验完整文件上传、自动光谱读取与多目标 CSV。

### 生产服务器部署验收清单

在部署到真实 Linux 服务器与生产网络时，请按照以下清单逐项验证：

- [ ] **网络连通性**：从外部网络或局域网客户端访问，确认首页、API、瓦片加载与 CSV 导出无跨域或端口拦截。
- [ ] **反向代理配置**：Nginx 配置 `client_max_body_size 24M`，验证 16 MiB 分片上传不会触发 `413 Request Entity Too Large`。
- [ ] **大数据集上传**：上传完整真实 GB 级 SBD 与高清显微图，测试中文文件名、断点暂停、刷新重选恢复与哈希校验，确认保存的 SBD 可读取光谱。
- [ ] **光谱与数值**：验证自动使用项目 SBD、点击网格自动读取对应点光谱、排序/分页/CSV、平均谱与多窗口提取；有已知样本时核对峰与全局分箱值。
- [ ] **外部源关联**：若使用外部 SBD，只读挂载后验证容器路径、重启和恢复后仍可读取。
- [ ] **单任务队列行为**：连续提交两个不同项目，确认后台按队列串行处理，无内存雪崩或 OOM 现象。
- [ ] **容器意外中断恢复**：在上传过程中执行 `docker compose restart`，确认分片完整保留并能无缝续传；在图像切片处理中重启，确认任务标记为 `failed` 且支持一键重试。
- [ ] **备份恢复演练**：使用 `tar --numeric-owner` 完成一次停止、打包、删除数据目录并恢复的完整灾备演练。
