# SpatialBridge 文档体系

欢迎查阅 SpatialBridge 项目的技术与运维文档。本项目是一套用于**采集前/采集后显微图与单细胞 MALDI 空间质谱数据高精度自动配准与交互联动查看**的系统。

---

## 📚 文档导航

| 文档 | 适用对象 | 核心内容 |
| :--- | :--- | :--- |
| **[技术架构与计算机视觉算法解析](technical-architecture.md)** | 算法研究员 / 核心开发者 | 8 点方孔单应配准、FLANN 晶格近轴拓扑、多项式曲面留出集拟合、闭环多模态坐标链、亿级瓦片金字塔流式引擎与 WASM 本地轻量提取。 |
| **[配准方法与输出规范](algorithm.md)** | 数据分析师 / 算法用户 | 坐标系统约定（$xy$/$yx$）、输出文件结构（`report.json`、`sbd-spots.npz`）、HTTP API 接口定义与工作台交互逻辑。 |
| **[系统部署与运维全指南](deployment.md)** | 运维工程师 / 部署人员 | 本地开发部署、Linux Docker Compose 生产部署、macOS Apple Container 运行、容量规划、性能规格、备份恢复与验收清单。 |
| **[开发规范与贡献指南](development-guide.md)** | 代码贡献者 / 开发者 | 代码风格规范、模块分层与解耦原则、测试隔离要求、Git 提交规范与 Pull Request 流程。 |

---

## 🧭 建议阅读路径

```mermaid
flowchart TD
    Start["开始了解 SpatialBridge"] --> Role{"您的关注方向？"}
    
    Role -->|"算法研究与原理"| Arch["阅读 technical-architecture.md<br/>深入多模态 CV 配准与晶格流形"]
    Arch --> Algo["阅读 algorithm.md<br/>了解坐标矩阵约定与 API 数据模型"]

    Role -->|"安装部署与运维"| Deploy["阅读 deployment.md<br/>选择开发环境或容器部署"]
    Deploy --> Cap["评估硬件容量与资源限制"]

    Role -->|"参与代码开发"| Dev["阅读 development-guide.md<br/>熟悉代码规范与质量门禁"]
    Dev --> Test["运行 pytest 与 node:test 本地测试"]
```

---

## 🔗 相关链接

- [项目首页 README](../../README.md)（[English](../../README.en.md)）
- [贡献简要指南 (CONTRIBUTING)](../../CONTRIBUTING.md)
- [开源许可证 (MIT)](../../LICENSE)
