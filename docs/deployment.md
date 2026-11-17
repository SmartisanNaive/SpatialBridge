# SpatialBridge 部署与运维全指南

[← 返回文档索引](README.md) | [返回 README](../../README.md)

SpatialBridge 提供两种部署与运行方式：
- **开发部署**：本地原生运行前后端开发服务，支持热重载与实时调试。
- **容器部署**：基于 Docker Compose（Linux 生产环境）或 Apple Container（macOS 容器测试），前后端一体化打包，开箱即用。

FastAPI 在同一 HTTP 端口提供前端生产静态页面、`/api` REST 接口、动态图像瓦片、验证叠加图和 CSV 下载，浏览器使用同源地址，不依赖客户端电脑的本地后端。

---

## 1. 系统模式与使用边界

- **共享单机服务模式**：适合实验室或课题组少量成员共同访问。项目不内置账号体系、RBAC 角色权限、用户数据隔离或多人协同编辑互斥锁。视口设置与人工标注属于项目级共享数据。
- **通信安全**：应用提供标准 HTTP 服务，不内置 TLS。生产环境暴露于公网时**必须**置于 Nginx / Caddy 等反向代理之后启用 HTTPS。
- **分片上传与断点续传**：
  - 文件按 **16 MiB** 分片上传，单片传输前自动计算 SHA-256 并由服务端校验；
  - 浏览器端自适应决策：充分压缩的 PNG 原样发送，可压缩数据启用无损 gzip 传输；
  - 支持重复分片幂等、暂停续传、页面刷新后重新选择原文件直接跳过已完成分片；
  - 服务端合并在后台异步执行，即使中途重启服务，已上传分片依旧保留。
- **单图像任务队列**：为防止多张 6.3 亿像素超大显微图并发处理导致服务器瞬时内存崩溃（OOM），后端设计为严格的单任务处理队列（`max_workers=1`），任务按提交顺序串行处理。
- **数据持久化隔离**：数据库、上传分片、计算报告和瓦片金字塔写入挂载的数据目录（容器内为 `/data`，本地开发默认为 `./workspace-data`），容器销毁不会丢失数据。

---

## 2. 开发部署指南（本地原生运行）

本地开发环境适合调试前端组件、修改后端算法或运行自动化测试。

### 2.1 环境准备

#### 1. 基础运行时
- **Python**: 3.11 或更高版本，推荐安装 [uv](https://docs.astral.sh/uv/) 作为包管理工具。
- **Node.js**: 22+ 及 npm。

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
cd frontend
npm install
cd ..
```

> [!NOTE]
> `uv` 虚拟环境记录绝对路径。若移动或重命名了项目目录，请删除 `.venv` 后重新执行 `uv sync`；前端 `node_modules` 同理。

### 2.3 启动开发服务

建议开启两个终端分别运行前后端：

```bash
# 终端 1：启动后端 API 服务（默认监听 http://127.0.0.1:8000）
uv run spatialbridge serve --data-dir ./workspace-data --host 127.0.0.1 --port 8000

# 终端 2：启动前端 Vite 开发服务器（默认监听 http://localhost:5173）
cd frontend
npm run dev
```

打开浏览器访问 `http://localhost:5173`。Vite 会将 `/api` 请求自动反向代理至 `127.0.0.1:8000`。若后端运行在其他主机或端口，可通过环境变量覆盖代理目标：
```bash
SPATIALBRIDGE_API_URL=http://192.168.1.100:8000 npm run dev
```

### 2.4 离线批处理 CLI

若无需 Web 交互界面，可直接在命令行对包含显微图和 SBD 的来源目录执行自动化配准并导出报告：

```bash
uv run spatialbridge register --source-dir ./参考数据 --output-dir ./workspace-data/manual-check
```

---

## 3. 容器部署指南

SpatialBridge 提供了基于 [Dockerfile.api](../../Dockerfile.api) 的前后端一体化多阶段构建镜像（前端编译产物直接注入 FastAPI 静态分发层）。

### 3.1 方案一：Linux 服务器生产部署（Docker Compose）

#### 1. 准备配置与目录
```bash
# 复制环境变量模板
cp .env.example .env

# 创建数据持久化目录，并将属主设为镜像内的运行用户 (UID 10001:10001)
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
```

#### 2. 检查 `.env` 配置
编辑 `.env` 文件，确认或修改以下关键配置：
```bash
# 发布绑定的宿主机网卡（0.0.0.0 表示所有网卡，127.0.0.1 表示仅允许本机或反向代理访问）
SPATIALBRIDGE_BIND_ADDRESS=0.0.0.0

# 宿主机对外映射的端口
SPATIALBRIDGE_PORT=8000

# 数据持久化目录（与上面创建的目录一致）
SPATIALBRIDGE_DATA_DIR=/srv/spatialbridge/data
```

#### 3. 启动容器
```bash
# 构建并后台启动服务
sudo docker compose up -d --build

# 查看运行状态与日志
sudo docker compose ps
sudo docker compose logs -f spatialbridge
```

浏览器访问 `http://<服务器IP>:8000` 即可开始使用。

---

### 3.2 方案二：macOS 容器化运行（Apple Container）

macOS 26+ 内置了原生的 Apple `container` 运行时，可直接用于本地隔离运行与测试，并映射到 `18000` 端口以避免与本地开发端口冲突：

```bash
# 1. 构建 ARM64 Linux 容器镜像
container build -f Dockerfile.api -t spatialbridge:local --cpus 4 --memory 4G .

# 2. 创建 16GB 独立持久化命名卷并授权
container volume create -s 16G spatialbridge-data
container run --rm --user 0:0 --entrypoint /bin/chown \
  -v spatialbridge-data:/data spatialbridge:local 10001:10001 /data

# 3. 启动长期容器服务
container run -d --name spatialbridge --cpus 4 --memory 6G \
  -p 127.0.0.1:18000:8000 -v spatialbridge-data:/data spatialbridge:local

# 4. 验证服务健康状态
curl -fsS http://127.0.0.1:18000/api/health
```

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
| **磁盘空间** | 20 GB | **100 GB ~ 200 GB SSD** | 500 GB+ SSD | 单项目典型占用 **3 ~ 5 GB**（原始图 + 金字塔 + 缓存）。 |
| **网络上行** | 10 Mbps | **50 Mbps ~ 100 Mbps (LAN/专线)** | 1 Gbps (局域网) | 保证十万 spot 方框动态拉取与前后卷帘对比流畅无延迟。 |

---

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

### 6.1 服务升级与平滑重启

```bash
# 1. 拉取最新代码
git pull origin main

# 2. 重新构建镜像并平滑更新容器
sudo docker compose up -d --build

# 3. 验证服务状态
curl -fsS http://127.0.0.1:8000/api/health
```

### 6.2 备份策略

为确保 SQLite 数据库、原始分片与项目缓存状态一致，备份前建议先暂停容器：

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

在全新服务器或故障恢复时，将备份包解压至数据目录并校正权限：

```bash
# 1. 停止当前服务
sudo docker compose down

# 2. 解压备份数据
sudo tar --numeric-owner -xzf /path/to/spatialbridge-backup.tar.gz -C /srv/spatialbridge

# 3. 校验并确保数据目录权限
sudo chown -R 10001:10001 /srv/spatialbridge/data
sudo chmod -R 770 /srv/spatialbridge/data

# 4. 重新启动服务
sudo docker compose up -d
```

### 6.4 数据目录内部结构说明
数据目录（如 `/srv/spatialbridge/data`）的布局如下：
```text
data/
├── spatialbridge.sqlite        # SQLite 元数据库（项目、上传、视口）
├── uploads/                    # 上传分片临时目录及装配后的原始文件
│   └── <upload_id>/
│       ├── chunks/             # 未合并时的 16 MiB 临时分片
│       └── files/              # 合并完成后的源图像与 .sbdx 包
└── projects/                   # 项目计算产物与图像缓存
    └── <project_id>/
        ├── report.json         # 综合配准与晶格报告
        ├── sbd-spots.npz       # SBD 坐标与 normalization 数组缓存
        ├── pyramids/           # 多分辨率瓦片金字塔（pre 与 after）
        ├── rendered-tiles-v3/  # 动态渲染的卷帘对比/透视切片缓存
        └── validation/         # 叠加校验图与晶格诊断图
```
系统内部通过 `data://` 和 `project://` 协议记录相对位置，因此整个数据目录支持整盘迁移，不会因宿主机绝对路径变化而失效。

---

## 7. 容器验证记录与验收清单

### 本地容器验证记录（已通过）

- **2026-11-14 (macOS Apple Container 1.6.1)**：
  - 前端 TypeScript 编译与 Vite 生产打包验证；
  - 宿主机后端 42 项单元测试、前端 17 项逻辑测试全部通过；
  - 真实双 PNG（$73953 \times 8538$，合计 482 MB）分片上传、gzip 传输、SHA-256 篡改拒绝与重复片幂等；
  - 上传首片后停止并重建容器，断点续传恢复成功；
  - 瓦片金字塔切片、浏览器卷帘交互、视野保存与 CSV 导出完整通过。
- **2026-11-17 (macOS Apple Container 1.6.1 全流程 6 阶段自动化测试)**：
  - 自动化脚本覆盖系统环境（UID 10001、Python 3.12.16、Tesseract 5.3.0、`pyvips`/`cv2`/`h5py` 协同导入）；
  - HTTP 静态路由与 SPA 兜底（`/workbench` 返回 index.html，未知 `/api` 严格返回 404）；
  - 端到端双图配准计算（8 点方孔单应拟合 RMSE $< 10^{-12}\text{ px}$）；
  - 容器停机销毁后基于相同命名卷重建，数据库项目、视口配置与瓦片切片 100% 保持可用；
  - SBD（HDF5 结构）精简包在容器内解析出 3 个 spot 及 TIC 归一化字段。

### 生产服务器部署验收清单

在部署到真实 Linux 服务器与生产网络时，请按照以下清单逐项验证：

- [ ] **网络连通性**：从外部网络或局域网客户端访问，确认首页、API、瓦片加载与 CSV 导出无跨域或端口拦截。
- [ ] **反向代理配置**：Nginx 配置 `client_max_body_size 24M`，验证 16 MiB 分片上传不会触发 `413 Request Entity Too Large`。
- [ ] **大数据集上传**：上传真实 GB 级 SBD 与高清显微图，测试中文文件名、断点暂停、刷新重选恢复与哈希校验。
- [ ] **单任务队列行为**：连续提交两个不同项目，确认后台按队列串行处理，无内存雪崩或 OOM 现象。
- [ ] **容器意外中断恢复**：在上传过程中执行 `docker compose restart`，确认分片完整保留并能无缝续传；在图像切片处理中重启，确认任务标记为 `failed` 且支持一键重试。
- [ ] **备份恢复演练**：使用 `tar --numeric-owner` 完成一次停止、打包、删除数据目录并恢复的完整灾备演练。
