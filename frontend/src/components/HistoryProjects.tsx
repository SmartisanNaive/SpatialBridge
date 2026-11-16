import {useState} from 'react';
import {Button, Space} from 'antd';
import {DatabaseOutlined, PictureOutlined, ScanOutlined, ThunderboltOutlined} from '@ant-design/icons';
import {apiUrl} from '../api';
import {formatCreatedAt, projectName, projectStatusLabel} from '../flow';
import type {Project} from '../types';
import CardSwap from './CardSwap';

export default function HistoryProjects({projects, onOpen, onRetry, busy}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onRetry: (project: Project) => void;
  busy: boolean;
}) {
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState(new Set<string>());
  const active = projects.find(project => project.id === selectedId) ?? projects[0];
  if (!active) return null;
  const actions = (project: Project) => project.status === 'failed'
    ? <Button size="small" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}>重试</Button>
    : project.status === 'ready' ? <>
      <Button size="small" type="primary" disabled={busy} onClick={() => onOpen(project)}>进入工作台</Button>
      <Button size="small" type="link" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}>重新处理</Button>
    </> : <Button size="small" disabled={busy} onClick={() => onOpen(project)}>查看进度</Button>;
  return <section className="home-lens-card" aria-label="历史项目">
    <div className="home-lens-heading history-project-heading">
      <div><div className="home-card-kicker">项目预览</div><h3>历史项目</h3></div>
      <Space size={6}>
        <Button size="small" type={view === 'cards' ? 'primary' : 'text'} aria-pressed={view === 'cards'} onClick={() => setView('cards')}>卡片</Button>
        <Button size="small" type={view === 'list' ? 'primary' : 'text'} aria-pressed={view === 'list'} onClick={() => setView('list')}>列表</Button>
        <span className="home-lens-count">{projects.length} 个</span>
      </Space>
    </div>
    {view === 'cards' ? <CardSwap activeId={active.id} onChange={setSelectedId} items={projects.map(project => {
      const source = project.report?.sources?.find(item => item.key === 'pre');
      const spots = project.report?.maldi_data?.spot_count;
      return {id: project.id, label: projectName(project), content: <article className="history-project-card" aria-label={projectName(project)}>
        {failedImages.has(project.id)
          ? <div className="history-project-image history-project-image-placeholder"><span><PictureOutlined /> 暂无预览图</span></div>
          : <img className="history-project-image" src={apiUrl(`/projects/${encodeURIComponent(project.id)}/thumbnail`)}
              alt={projectName(project)} draggable={false} onError={() => setFailedImages(previous => new Set(previous).add(project.id))} />}
        <div className="history-project-card-title"><strong title={projectName(project)}>{projectName(project)}</strong><span className="history-project-status">{projectStatusLabel(project.status)}</span></div>
        <div className="lens-project-specs">
          {source && <span><ScanOutlined /> {source.width.toLocaleString()} × {source.height.toLocaleString()} px</span>}
          {spots != null && <span><ThunderboltOutlined /> {spots.toLocaleString()} 靶点</span>}
          <span>{formatCreatedAt(project.created_at)}</span>
        </div>
        <div className="history-project-card-actions">{actions(project)}</div>
      </article>};
    })} /> : <div className="project-list">
      {projects.map(project => <div className="project-list-item" key={project.id}>
        <div className="project-list-icon"><DatabaseOutlined /></div>
        <div className="project-list-main"><strong>{projectName(project)}</strong><span>{formatCreatedAt(project.created_at)} · {projectStatusLabel(project.status)}</span></div>
        <Space size={4}>{actions(project)}</Space>
      </div>)}
    </div>}
  </section>;
}
