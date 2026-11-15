import {Alert, Button, Card, Layout, Progress, Spin, Typography} from 'antd';
import {FolderOpenOutlined} from '@ant-design/icons';
import {projectName} from '../flow';
import type {Project} from '../types';

export function ProcessingScreen({project, onHome, connectionError}: {project: Project; onHome: () => void; connectionError?: string}) {
  const progress = project.progress;
  const hasTotal = Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && Number(progress?.total) > 0;
  const percent = hasTotal ? Math.min(100, Math.max(0, Math.round((Number(progress?.completed) / Number(progress?.total)) * 100))) : undefined;
  const stage = progress?.stage || project.stage || (project.status === 'queued' ? '等待处理队列' : '准备处理来源数据');
  return (
    <Layout className="app processing-app">
      <header className="home-header">
        <div className="home-brand"><img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" /><div><strong>SpatialBridge</strong><span>项目处理中</span></div></div>
        <Button onClick={onHome} icon={<FolderOpenOutlined />}>项目首页</Button>
      </header>
      <main className="processing-page">
        <div className="processing-breadcrumb">项目 / {projectName(project)}</div>
        <Card className="processing-card" variant="borderless">
          <div className="processing-icon"><Spin /></div>
          <Typography.Title level={2}>{project.status === 'queued' ? '项目排队中' : '正在建立空间配准'}</Typography.Title>
          <Typography.Paragraph type="secondary">正在对齐采集前后图像并关联采样点，完成后将自动进入工作台。</Typography.Paragraph>
          <div className="processing-stage"><span>当前阶段</span><strong>{stage}</strong>{hasTotal && <em>{Number(progress?.completed)} / {Number(progress?.total)}</em>}</div>
          {hasTotal && <Progress percent={percent} showInfo strokeColor="#2d6a5b" />}
          {!hasTotal && <div className="processing-indeterminate"><div className="processing-indeterminate-bar" aria-hidden="true"><span /></div><span>处理阶段会随任务推进更新，完成后自动打开工作台。</span></div>}
          {connectionError && <Alert type="warning" showIcon message="暂时无法连接处理服务" description="正在自动重试，页面不会丢失当前项目。" />}
        </Card>
      </main>
    </Layout>
  );
}

export function FailedProjectScreen({project, onHome, onRetry, busy, error}: {project: Project; onHome: () => void; onRetry: () => void; busy?: boolean; error?: string}) {
  return (
    <Layout className="app processing-app">
      <header className="home-header"><div className="home-brand"><img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" /><div><strong>SpatialBridge</strong><span>项目处理</span></div></div><Button onClick={onHome} icon={<FolderOpenOutlined />}>项目首页</Button></header>
      <main className="processing-page"><div className="processing-breadcrumb">项目 / {projectName(project)}</div><Card className="processing-card failed-card" variant="borderless"><div className="processing-icon failed">!</div><Typography.Title level={2}>项目处理未通过</Typography.Title><Typography.Paragraph type="secondary">{project.error || '未能完成处理，请检查目录结构和文件格式。'}</Typography.Paragraph>{error && <Alert type="error" showIcon message="重试请求失败" description={error} />}<div className="processing-actions"><Button type="primary" loading={busy} disabled={busy || !project.source_dir} onClick={onRetry}>重试处理</Button></div></Card></main>
    </Layout>
  );
}
