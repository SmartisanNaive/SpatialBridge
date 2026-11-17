import {useState} from 'react';
import {Button, Space} from 'antd';
import {DatabaseOutlined, PictureOutlined, ScanOutlined, ThunderboltOutlined} from '@ant-design/icons';
import {apiUrl} from '../api';
import {formatCreatedAt, projectName, projectStatusLabel} from '../flow';
import type {Project} from '../types';
import {TranslatedText, useI18n} from '../i18n';
import CardSwap from './CardSwap';

export default function HistoryProjects({projects, onOpen, onRetry, busy}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onRetry: (project: Project) => void;
  busy: boolean;
}) {
  const {t, language} = useI18n();
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState(new Set<string>());
  const active = projects.find(project => project.id === selectedId) ?? projects[0];
  if (!active) return null;
  const actions = (project: Project) => project.status === 'failed'
    ? <Button size="small" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}><TranslatedText text={t.common.retry} /></Button>
    : project.status === 'ready' ? <>
      <Button size="small" type="primary" disabled={busy} onClick={() => onOpen(project)}><TranslatedText text={t.common.enterWorkbench} /></Button>
      <Button size="small" type="link" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}><TranslatedText text={t.common.reprocess} /></Button>
    </> : <Button size="small" disabled={busy} onClick={() => onOpen(project)}><TranslatedText text={t.common.viewProgress} /></Button>;
  return <section className="home-lens-card" aria-label={t.history.title}>
    <div className="home-lens-heading history-project-heading">
      <div><div className="home-card-kicker"><TranslatedText text={t.history.kicker} /></div><h3><TranslatedText text={t.history.title} /></h3></div>
      <Space size={6}>
        <Button size="small" type={view === 'cards' ? 'primary' : 'text'} aria-pressed={view === 'cards'} onClick={() => setView('cards')}><TranslatedText text={t.history.cards} /></Button>
        <Button size="small" type={view === 'list' ? 'primary' : 'text'} aria-pressed={view === 'list'} onClick={() => setView('list')}><TranslatedText text={t.history.list} /></Button>
        <span className="home-lens-count"><TranslatedText text={t.history.count(projects.length)} /></span>
      </Space>
    </div>
    {view === 'cards' ? <CardSwap activeId={active.id} onChange={setSelectedId} items={projects.map(project => {
      const source = project.report?.sources?.find(item => item.key === 'pre');
      const spots = project.report?.maldi_data?.spot_count;
      const name = projectName(project, language);
      return {id: project.id, label: name, content: <article className="history-project-card" aria-label={name}>
        {failedImages.has(project.id)
          ? <div className="history-project-image history-project-image-placeholder"><span><PictureOutlined /> <TranslatedText text={t.history.noPreview} /></span></div>
          : <img className="history-project-image" src={apiUrl(`/projects/${encodeURIComponent(project.id)}/thumbnail`)}
              alt={name} draggable={false} onError={() => setFailedImages(previous => new Set(previous).add(project.id))} />}
        <div className="history-project-card-title"><strong title={name}>{name}</strong><span className="history-project-status"><TranslatedText text={projectStatusLabel(project.status, language)} /></span></div>
        <div className="lens-project-specs">
          {source && <span><ScanOutlined /> {source.width.toLocaleString()} × {source.height.toLocaleString()} px</span>}
          {spots != null && <span><ThunderboltOutlined /> <TranslatedText text={t.history.spotsUnit(spots.toLocaleString())} /></span>}
          <span><TranslatedText text={formatCreatedAt(project.created_at, language)} /></span>
        </div>
        <div className="history-project-card-actions">{actions(project)}</div>
      </article>};
    })} /> : <div className="project-list">
      {projects.map(project => {
        const name = projectName(project, language);
        return <div className="project-list-item" key={project.id}>
          <div className="project-list-icon"><DatabaseOutlined /></div>
          <div className="project-list-main"><strong>{name}</strong><span><TranslatedText text={formatCreatedAt(project.created_at, language)} /> · <TranslatedText text={projectStatusLabel(project.status, language)} /></span></div>
          <Space size={4}>{actions(project)}</Space>
        </div>;
      })}
    </div>}
  </section>;
}
