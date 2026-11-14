# 容器部署

[← 返回 README](../README.md)

Docker Compose 构建并运行一个长期服务。FastAPI 在同一 HTTP 端口提供前端页面、`/api`、图像瓦片、验证图和 CSV 下载，浏览器使用同源地址，不需要访问用户电脑上的本地后端。默认监听 `0.0.0.0:8000`，入口是 `http://服务器地址:8000`。镜像不包含本机的示例或参考数据。

## 功能与使用边界

- **上传和续传：**文件按 16 MiB 分片上传。浏览器按文件实测压缩率和网速，只在能缩短上传时间时对分片做无损 gzip 压缩（已压缩的 PNG 原样发送，SBD 约可减小三分之一），服务端保存的始终是原始字节。前端为每片计算并发送 SHA-256，服务端进行校验；浏览器优先使用 Web Crypto，在不支持的 HTTP 环境下回退到 JavaScript 实现。上传支持重复分片幂等、暂停、刷新后重新选择相同文件续传。文件合并在后台执行，界面可查询合并状态；服务在合并期间重启后保留分片，可重新提交。
- **项目处理：**采集前后显微 PNG 必需，SBD 和热图可选。上传完成后项目进入处理队列，同一时刻只运行一个图像处理任务。进程重启时未完成的处理项目会标记为失败，可在界面手动重试，不需要重新上传。
- **浏览、保存和导出：**支持配准结果瓦片浏览、spot 信息查看、人工标注、保存视野，以及人工标注和自动检测 CSV 导出。完整源文件、SQLite 数据库、处理报告、标注和缓存保存在宿主机数据目录，重建容器不会清除这些数据。
- **服务管理：**容器设有健康检查、异常自动重启、日志轮转和停机等待时间。健康接口为 `/api/health`。

云端部署是单机共享项目模式，适合少量用户共同访问。项目不提供账号、角色权限、用户数据隔离或多人编辑锁，视野和标注属于共享项目数据。应用提供普通 HTTP 服务，不内置 TLS。默认绑定服务器所有网卡，是否允许公网访问由服务器网络和防火墙决定。默认数据目录是 `/srv/spatialbridge/data`，开发机上的 `workspace-data` 不会自动迁移到服务器。

## 安装与启动

在 Linux 服务器安装 Docker Engine 与 Docker Compose 插件，将项目代码放到服务器后执行。若当前账户不在 `docker` 用户组，请在 `docker compose` 命令前加 `sudo`：

```bash
sudo systemctl enable --now docker
cp .env.example .env
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
sudo docker compose up -d --build
sudo docker compose ps
```

## macOS：使用 Apple Container

安装并启动 Apple 的 `container` 运行时后，可以直接构建同一份 `Dockerfile.api`。以下命令使用独立的持久化卷，并将服务发布到本机 `18000` 端口，便于和本地开发服务并行运行：

```bash
container build -f Dockerfile.api -t spatialbridge:local --cpus 4 --memory 4G .
container volume create -s 16G spatialbridge-data

# 新卷先授权给镜像中的运行用户；应用本身仍以 UID/GID 10001 运行。
container run --rm --user 0:0 --entrypoint /bin/chown \
  -v spatialbridge-data:/data spatialbridge:local 10001:10001 /data

container run -d --name spatialbridge --cpus 4 --memory 6G \
  -p 127.0.0.1:18000:8000 -v spatialbridge-data:/data spatialbridge:local

curl -fsS http://127.0.0.1:18000/api/health
```

打开 `http://127.0.0.1:18000`，前端和 API 均由容器提供，不依赖宿主机的 Vite 或 Python 服务。示例和参考数据不包含在镜像中，首次使用需上传自己的文件。这里为大图处理分配了 6 GiB 内存；小图可按实际需要调整。

查看日志、停止和重新启动：

```bash
container logs spatialbridge
container stop --time 60 spatialbridge
container start spatialbridge
```

更新镜像后可以删除并重建容器，保留同一数据卷：

```bash
container stop --time 60 spatialbridge
container delete spatialbridge
container build -f Dockerfile.api -t spatialbridge:local --cpus 4 --memory 4G .
container run -d --name spatialbridge --cpus 4 --memory 6G \
  -p 127.0.0.1:18000:8000 -v spatialbridge-data:/data spatialbridge:local
```

`container delete` 不会删除命名卷；不要删除仍需保留项目的 `spatialbridge-data` 卷。这套命令验证的是 OCI 镜像与 Apple Container 运行方式；`compose.yaml` 中的自动重启、健康检查调度及日志轮转仍由 Linux Docker Compose 管理。

## 配置

根目录 `.env.example` 是部署配置模板。复制出的 `.env` 由 Docker Compose 读取，主要调整以下三项：

| 变量 | 示例值 | 用途 |
| --- | --- | --- |
| `SPATIALBRIDGE_BIND_ADDRESS` | `0.0.0.0` | 发布到服务器的哪些网卡；`0.0.0.0` 表示所有网卡，`127.0.0.1` 表示仅本机可访问。 |
| `SPATIALBRIDGE_PORT` | `8000` | Linux 主机对外提供服务的端口；容器内部端口固定为 `8000`。 |
| `SPATIALBRIDGE_DATA_DIR` | `/srv/spatialbridge/data` | 数据持久化目录。自定义路径时，先创建目录并将其所有者设为 UID/GID `10001`。 |

例如，将端口改为 `18000`、数据目录改为 `/data/spatialbridge` 后，先创建并授权该目录，再执行 `sudo docker compose up -d` 使配置生效，无需重新构建镜像。从同一网络的另一台电脑访问 `http://服务器地址:18000`。处理并发数和 16 MiB 分片大小当前固定，不由 `.env` 调整。

## 运维

可从服务器本机验证服务健康状态：

```bash
curl -fsS http://127.0.0.1:8000/api/health
```

查看服务状态和日志，或更新程序：

```bash
sudo docker compose logs -f spatialbridge
sudo docker compose restart
git pull
sudo docker compose up -d --build
```

更新前备份当前 `.env` 与数据目录。若需回滚，切回此前使用的 Git 标签或提交并重新构建：

```bash
git checkout <previous-tag-or-commit>
sudo docker compose up -d --build
```

## 备份与恢复

定期备份时先停止容器，保证 SQLite 数据库和来源文件来自同一时间点：

```bash
sudo docker compose stop
sudo tar --numeric-owner -czf "/srv/spatialbridge-backup-$(date +%Y%m%d-%H%M%S).tar.gz" -C /srv/spatialbridge data
sudo docker compose start
```

恢复示例（将备份路径替换为实际文件）：

```bash
sudo docker compose stop
sudo tar --numeric-owner -xzf /path/to/spatialbridge-backup.tar.gz -C /srv/spatialbridge
sudo chown -R 10001:10001 /srv/spatialbridge/data
sudo docker compose up -d
```

若 `.env` 中设置了其他数据目录，备份和恢复时也要对应调整。数据库和来源文件须成套恢复。

### 数据目录迁移

应用使用 `data://` 表示相对于数据目录的上传文件，使用 `project://` 表示相对于项目目录的图像缓存；两者是报告中的路径标记，不是网络地址。迁移时完整移动数据目录（包含数据库、上传文件和项目缓存），旧版本记录中的内部缓存和上传文件也会按项目或上传 ID 定位。目录导入的来源文件仍在原位置，不包含在数据目录备份中；迁移后如需重新处理，请同时保留来源文件并在新位置重新导入。

## 本地容器验证记录

2026-11-14，在 macOS 的 Apple Container 1.6.1 上构建并运行了 Linux/ARM64 镜像，应用以 UID/GID `10001:10001` 运行。已通过以下检查：

- 前端 TypeScript 检查和生产构建；宿主机后端 42 项、前端 17 项单元测试。
- 容器提供首页、静态资源、SPA 路由、健康接口和 JSON API；未知 API 返回 404，镜像未包含本机参考数据。
- 两张真实 `73953 × 8538` 显微 PNG（合计约 482 MB）的中文文件名上传、16 MiB 分片、gzip 传输、SHA-256 错误拒绝和重复分片幂等。
- 上传首片后停止、删除并重建容器，使用同一命名卷继续完成上传和后台合并。
- 两图配准、低倍率与原始分辨率瓦片、验证叠加图、浏览器卷帘对比、视野保存、人工标注及 CSV 导出。
- 处理完成后再次停止、删除并重建容器，确认项目、源图、瓦片、视野、人工标注和导出仍可用。
- 按应用导入顺序检查 HDF5 文件读写、libvips 图像读取和 Tesseract 可执行程序。

额外的依赖诊断发现：在独立 Python 进程中先导入 `pyvips` 再导入 `h5py`，会因系统 HDF5 1.10.8 与 h5py wheel 的 HDF5 2.0.0 冲突而失败；先导入应用和 `h5py`、再导入 `pyvips` 时，HDF5 与图像读写检查通过。本次没有修改这个导入顺序问题。

本次没有在容器中执行包含真实 SBD 和热图的完整配准流程，也没有验证 GB 级文件上传、合并/处理中的中断恢复、Linux Docker Compose 运维行为及跨主机备份恢复。这些仍保留在下面的服务器验收清单中。

## 部署验收清单

镜像已通过上述 macOS 本地验证，仍需在真实 Linux 服务器、网络入口和数据上完成以下验收：

- [ ] 从另一台电脑访问页面，确认 API、瓦片、验证图和 CSV 下载正常。
- [ ] 上传 GB 级数据，检查中文文件名、暂停续传、刷新后重选恢复、重复提交和摘要错误处理。
- [ ] 跑完仅含两张显微 PNG 的流程，以及包含 SBD 和热图的完整流程；检查配准、标注、保存视野和导出。
- [ ] 分别在分片上传、文件合并和图像处理中重启容器；再重建容器或重启服务器，确认数据保留及失败任务重试。
- [ ] 停服备份数据目录，并在 Linux 服务器完成一次恢复演练。
