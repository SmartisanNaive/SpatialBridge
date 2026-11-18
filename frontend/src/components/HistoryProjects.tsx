import {useEffect, useRef, useState} from 'react';
import {Button, Popconfirm, Space} from 'antd';
import {CloseOutlined, DatabaseOutlined, PictureOutlined, ScanOutlined, ThunderboltOutlined} from '@ant-design/icons';
import {apiUrl} from '../api';
import {formatCreatedAt, projectName, projectStatusLabel} from '../flow';
import type {Project} from '../types';
import {TranslatedText, useI18n} from '../i18n';
import CardSwap from './CardSwap';
import ShredOverlay, {
  prefersReducedMotion,
  preloadShredImages,
  prepareShred,
  resolveShredTexture,
  type ShredOverlayHandle,
} from './ShredOverlay';

export default function HistoryProjects({projects, onOpen, onRetry, onDelete, busy}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onRetry: (project: Project) => void;
  onDelete: (project: Project) => Promise<boolean>;
  busy: boolean;
}) {
  const {t, language} = useI18n();
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState(new Set<string>());
  const sectionRef = useRef<HTMLElement>(null);
  const shredderRef = useRef<ShredOverlayHandle>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const visibleProjects = projects.filter(project => !project.deleted_at);
  const active = visibleProjects.find(project => project.id === selectedId) ?? visibleProjects[0];

  useEffect(() => {
    if (!visibleProjects.length) return;
    const timer = window.setTimeout(() => preloadShredImages(sectionRef.current), 250);
    return () => window.clearTimeout(timer);
  }, [visibleProjects.length, view, active?.id]);

  const setItemRef = (id: string) => (node: HTMLElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  };

  const handleDelete = async (project: Project) => {
    const rawEl = itemRefs.current.get(project.id);
    const targetEl = rawEl ? ((rawEl.closest('.card-swap-slot') as HTMLElement | null) ?? rawEl) : null;
    const prepared = targetEl && !prefersReducedMotion() ? prepareShred(targetEl) : null;
    const texture = prepared ? await resolveShredTexture(prepared) : null;
    const deleted = await onDelete(project);
    if (!deleted) return;
    if (prepared && texture) {
      shredderRef.current?.launch(prepared, texture);
    }
    if (active && project.id === active.id) {
      const index = visibleProjects.findIndex(item => item.id === project.id);
      const next = visibleProjects[index + 1] ?? visibleProjects[index - 1] ?? null;
      setSelectedId(next ? next.id : null);
    }
  };
  const deleteTrigger = (project: Project, variant: 'card' | 'list') => (
    <Popconfirm
      title={t.history.deleteConfirmTitle}
      okText={t.history.deleteConfirmOk}
      cancelText={t.common.cancel}
      okButtonProps={{danger: true}}
      placement="topRight"
      onConfirm={() => handleDelete(project)}
    >
      <button
        type="button"
        className={`history-project-delete history-project-delete--${variant}`}
        disabled={busy}
        aria-label={`${t.history.deleteRecord}: ${projectName(project, language)}`}
        title={t.history.deleteRecord}
        onClick={(event) => event.stopPropagation()}
      >
        <CloseOutlined />
      </button>
    </Popconfirm>
  );
  const actions = (project: Project) => project.status === 'failed'
    ? <Button size="small" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}><TranslatedText text={t.common.retry} /></Button>
    : project.status === 'ready' ? <>
      <Button size="small" type="primary" disabled={busy} onClick={() => onOpen(project)}><TranslatedText text={t.common.enterWorkbench} /></Button>
      <Button size="small" type="link" disabled={busy || !project.source_dir} onClick={() => onRetry(project)}><TranslatedText text={t.common.reprocess} /></Button>
    </> : <Button size="small" disabled={busy} onClick={() => onOpen(project)}><TranslatedText text={t.common.viewProgress} /></Button>;
  return <>
    {active && <section ref={sectionRef} className="home-lens-card" aria-label={t.history.title}>
      <div className="home-lens-heading history-project-heading">
        <div><h3><TranslatedText text={t.history.title} /></h3></div>
        <Space size={6}>
          <Button size="small" type={view === 'cards' ? 'primary' : 'text'} aria-pressed={view === 'cards'} onClick={() => setView('cards')}><TranslatedText text={t.history.cards} /></Button>
          <Button size="small" type={view === 'list' ? 'primary' : 'text'} aria-pressed={view === 'list'} onClick={() => setView('list')}><TranslatedText text={t.history.list} /></Button>
          <span className="home-lens-count"><TranslatedText text={t.history.count(visibleProjects.length)} /></span>
        </Space>
      </div>
      {view === 'cards' ? <CardSwap activeId={active.id} onChange={setSelectedId} items={visibleProjects.map(project => {
        const source = project.report?.sources?.find(item => item.key === 'pre');
        const spots = project.report?.maldi_data?.spot_count;
        const name = projectName(project, language);
        return {id: project.id, label: name, content: <article ref={setItemRef(project.id)} className="history-project-card" aria-label={name}>
          {deleteTrigger(project, 'card')}
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
        {visibleProjects.map(project => {
          const name = projectName(project, language);
          return <div ref={setItemRef(project.id)} className="project-list-item" key={project.id}>
            <div className="project-list-icon"><DatabaseOutlined /></div>
            <div className="project-list-main"><strong>{name}</strong><span><TranslatedText text={formatCreatedAt(project.created_at, language)} /> · <TranslatedText text={projectStatusLabel(project.status, language)} /></span></div>
            <Space size={4}>{actions(project)}{deleteTrigger(project, 'list')}</Space>
          </div>;
        })}
      </div>}
    </section>}
    <ShredOverlay ref={shredderRef} />
  </>;
}
