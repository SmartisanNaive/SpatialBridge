import {useEffect, useState} from 'react';
import {Alert, Button, Card, Layout, Progress, Typography, Space} from 'antd';
import {FolderOpenOutlined} from '@ant-design/icons';
import {projectName} from '../flow';
import type {Project} from '../types';
import {apiUrl} from '../api';
import {getCachedPreviewThumbnail} from '../utils';
import {TranslatedText, useI18n, LanguageSwitch} from '../i18n';
import LatticeLoader from './LatticeLoader';
import StatusMark, {type MarkStatus} from './StatusMark';
import RefineFrame, {type RefineFrameStatus} from './RefineFrame';

function getActiveStepIndex(stage: string, isQueued: boolean): number {
  if (isQueued) return 0;
  if (!stage) return 0;
  if (stage.includes('扫描') || stage.includes('准备') || stage.includes('排队')) return 0;
  if (stage.includes('瓦片') || stage.includes('金字塔')) return 1;
  if (stage.includes('配准') || stage.includes('锚点')) return 2;
  if (
    stage.includes('MALDI') ||
    stage.includes('SBD') ||
    stage.includes('坐标') ||
    stage.includes('热图') ||
    stage.includes('板图') ||
    stage.includes('弹坑') ||
    stage.includes('灼烧坑')
  ) {
    return 3;
  }
  if (stage.includes('叠加图') || stage.includes('验证') || stage.includes('报告') || stage.includes('完成')) {
    return 4;
  }
  return 0;
}

function getRefineStatus(status: string, stage: string): RefineFrameStatus {
  if (status === 'failed') return 'error';
  if (status === 'ready') return 'complete';
  if (status === 'queued') return 'queued';
  if (
    stage.includes('配准') ||
    stage.includes('锚点') ||
    stage.includes('SBD') ||
    stage.includes('坐标') ||
    stage.includes('热图') ||
    stage.includes('板图') ||
    stage.includes('弹坑') ||
    stage.includes('灼烧坑') ||
    stage.includes('叠加图')
  ) {
    return 'refining';
  }
  return 'generating';
}

function localizeBackendStage(rawStage: string, lang: 'zh' | 'en'): string {
  if (lang !== 'en') return rawStage;
  if (!rawStage) return '';
  if (rawStage.includes('排队等待处理')) return 'Queued for processing';
  if (rawStage.includes('准备处理数据') || rawStage.includes('准备处理来源数据')) return 'Preparing data for processing';
  if (rawStage.includes('扫描来源文件')) return 'Scanning source files';
  if (rawStage.includes('生成多级图像瓦片')) return 'Generating multi-level image tiles';
  const tileMatch = rawStage.match(/生成\s*(\w+)\s*高清瓦片[（(](\d+\s*\/\s*\d+)[)）]/);
  if (tileMatch) {
    const layer = tileMatch[1] === 'pre' ? 'pre-acquisition' : tileMatch[1] === 'after' ? 'post-acquisition' : tileMatch[1];
    return `Generating ${layer} tiles (${tileMatch[2]})`;
  }
  if (rawStage.includes('高清瓦片')) return 'Generating high-res tiles';
  if (rawStage.includes('检测锚点并计算配准')) return 'Detecting anchors & computing registration';
  if (rawStage.includes('读取 MALDI 数据索引')) return 'Reading MALDI data index';
  if (rawStage.includes('生成验证叠加图')) return 'Generating validation overlay';
  if (rawStage.includes('建立 SBD 与显微图坐标对应关系')) return 'Building SBD to microscopy coordinate mapping';
  if (rawStage.includes('已完成')) return 'Completed';
  if (rawStage.includes('处理失败')) return 'Processing failed';
  if (rawStage.includes('已中断')) return 'Interrupted';
  return rawStage;
}

export function ProcessingScreen({project, onHome, connectionError}: {project: Project; onHome: () => void; connectionError?: string}) {
  const {t, language} = useI18n();
  const progress = project.progress;
  const hasTotal = Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && Number(progress?.total) > 0;
  const percent = hasTotal ? Math.min(100, Math.max(0, Math.round((Number(progress?.completed) / Number(progress?.total)) * 100))) : undefined;
  const rawStage = progress?.stage || project.stage || (project.status === 'queued' ? '排队等待处理' : '准备处理数据');
  const stage = localizeBackendStage(rawStage, language);
  const isQueued = project.status === 'queued';
  const activeStepIndex = getActiveStepIndex(rawStage, isQueued);
  const refineStatus = getRefineStatus(project.status, rawStage);

  const pipelineSteps = [
    {
      id: 'inputs',
      title: t.processing.step1Title,
      description: t.processing.step1Desc,
    },
    {
      id: 'pyramids',
      title: t.processing.step2Title,
      description: t.processing.step2Desc,
    },
    {
      id: 'registration',
      title: t.processing.step3Title,
      description: t.processing.step3Desc,
    },
    {
      id: 'mapping',
      title: t.processing.step4Title,
      description: t.processing.step4Desc,
    },
    {
      id: 'artifacts',
      title: t.processing.step5Title,
      description: t.processing.step5Desc,
    },
  ];

  const refineLabels: Record<RefineFrameStatus, string> = {
    queued: t.processing.stageQueued,
    generating: t.processing.stageGenerating,
    refining: t.processing.stageRefining,
    complete: t.processing.stageComplete,
    error: t.processing.stageError,
  };

  const localThumb = getCachedPreviewThumbnail(project.id);
  const previewUrl = localThumb || apiUrl(`/projects/${encodeURIComponent(project.id)}/preview/pre?thumb=1`);
  const [previewError, setPreviewError] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (previewError) {
      setPreviewError(false);
      setPreviewKey((k) => k + 1);
    }
  }, [rawStage]);

  return (
    <Layout className="app processing-app">
      <header className="home-header">
        <div className="home-brand">
          <img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" />
          <div>
            <strong>SpatialBridge</strong>
            <span><TranslatedText text={t.processing.pageTitle} /></span>
          </div>
        </div>
        <Space size={8}>
          <LanguageSwitch />
          <Button onClick={onHome} icon={<FolderOpenOutlined />}><TranslatedText text={t.common.backHome} /></Button>
        </Space>
      </header>
      <main className="processing-page">
        <div className="processing-breadcrumb"><TranslatedText text={t.processing.breadcrumbProject} /> / <TranslatedText text={projectName(project, language)} /></div>
        <Card className="processing-card" variant="borderless">
          <div className="processing-loader-header">
            <LatticeLoader
              label={isQueued ? t.processing.loaderQueued : t.processing.loaderRunning}
              status="working"
              pattern="orbit"
              grid={4}
              cellSize={7}
              gap={3}
              fontSize={20}
              color="#2d6a5b"
              glow
              glowColor="rgba(45, 106, 91, 0.25)"
              showTimer
            />
          </div>
          <Typography.Paragraph type="secondary">
            <TranslatedText text={t.processing.loaderDesc} />
          </Typography.Paragraph>

          <div className="processing-layout">
            <div className="processing-preview-panel">
              <div className="processing-preview-title">
                <span><TranslatedText text={t.processing.previewTitle} /></span>
                <span className="processing-preview-badge">Refine Preview</span>
              </div>
              <div className="processing-preview-frame-wrap">
                <RefineFrame
                  status={refineStatus}
                  width={320}
                  aspectRatio="4 / 3"
                  labels={refineLabels}
                  onRetry={() => {
                    setPreviewError(false);
                    setPreviewKey((k) => k + 1);
                  }}
                >
                  <img
                    key={previewKey}
                    src={`${previewUrl}?t=${previewKey}`}
                    alt={t.processing.previewAlt}
                    crossOrigin="anonymous"
                    onError={() => setPreviewError(true)}
                  />
                </RefineFrame>
              </div>
            </div>

            <div className="processing-details-panel">
              <div className="processing-stage">
                <div className="processing-stage-main">
                  <StatusMark
                    status={isQueued ? 'pending' : 'running'}
                    progress={hasTotal && percent !== undefined ? percent / 100 : undefined}
                    size={20}
                    strokeWidth={2}
                  />
                  <div className="processing-stage-text">
                    <span><TranslatedText text={t.processing.currentStage} /></span>
                    <strong><TranslatedText text={stage} /></strong>
                  </div>
                </div>
                {hasTotal && <em>{Number(progress?.completed)} / {Number(progress?.total)}</em>}
              </div>

              {hasTotal && <Progress percent={percent} showInfo strokeColor="#2d6a5b" />}
              {!hasTotal && (
                <div className="processing-indeterminate">
                  <div className="processing-indeterminate-bar" aria-hidden="true">
                    <span />
                  </div>
                  <span><TranslatedText text={t.processing.autoEnter} /></span>
                </div>
              )}

              <div className="processing-steps">
                <div className="processing-steps-header">
                  <span className="processing-steps-title"><TranslatedText text={t.processing.pipelineProgress} /></span>
                </div>
                <div className="processing-steps-list">
                  {pipelineSteps.map((step, idx) => {
                    let stepStatus: MarkStatus = 'pending';
                    let stepProgress: number | undefined = undefined;

                    if (isQueued) {
                      stepStatus = 'pending';
                    } else if (idx < activeStepIndex) {
                      stepStatus = 'done';
                    } else if (idx === activeStepIndex) {
                      stepStatus = 'running';
                      if (idx === 1 && hasTotal && percent !== undefined) {
                        stepProgress = percent / 100;
                      }
                    } else {
                      stepStatus = 'pending';
                    }

                    const isActive = !isQueued && idx === activeStepIndex;

                    return (
                      <div key={step.id} className={`processing-step-item step-${stepStatus}`}>
                        <div className="processing-step-mark">
                          <StatusMark
                            status={stepStatus}
                            progress={stepProgress}
                            size={18}
                            strokeWidth={2}
                          />
                        </div>
                        <div className="processing-step-content">
                          <div className="processing-step-title-row">
                            <span className="processing-step-name"><TranslatedText text={step.title} /></span>
                            {isActive && hasTotal && (
                              <span className="processing-step-count">
                                {Number(progress?.completed)} / {Number(progress?.total)}
                              </span>
                            )}
                          </div>
                          <div className="processing-step-desc">
                            {isActive ? stage : step.description}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {connectionError && (
            <Alert
              type="warning"
              showIcon
              message={<TranslatedText text={t.processing.disconnectedTitle} />}
              description={<TranslatedText text={t.processing.disconnectedDesc} />}
            />
          )}
        </Card>
      </main>
    </Layout>
  );
}

export function FailedProjectScreen({
  project,
  onHome,
  onRetry,
  busy,
  error,
}: {
  project: Project;
  onHome: () => void;
  onRetry: () => void;
  busy?: boolean;
  error?: string;
}) {
  const {t, language} = useI18n();
  const localThumb = getCachedPreviewThumbnail(project.id);
  const previewUrl = localThumb || apiUrl(`/projects/${encodeURIComponent(project.id)}/preview/pre?thumb=1`);

  const refineLabels: Record<RefineFrameStatus, string> = {
    queued: t.processing.stageQueued,
    generating: t.processing.stageGenerating,
    refining: t.processing.stageRefining,
    complete: t.processing.stageComplete,
    error: t.processing.stageError,
  };

  return (
    <Layout className="app processing-app">
      <header className="home-header">
        <div className="home-brand">
          <img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" />
          <div>
            <strong>SpatialBridge</strong>
            <span><TranslatedText text={t.processing.stageError} /></span>
          </div>
        </div>
        <Space size={8}>
          <LanguageSwitch />
          <Button onClick={onHome} icon={<FolderOpenOutlined />}><TranslatedText text={t.common.backHome} /></Button>
        </Space>
      </header>
      <main className="processing-page">
        <div className="processing-breadcrumb"><TranslatedText text={t.processing.breadcrumbProject} /> / <TranslatedText text={projectName(project, language)} /></div>
        <Card className="processing-card failed-card" variant="borderless">
          <div className="processing-layout">
            <div className="processing-preview-panel">
              <div className="processing-preview-title">
                <span><TranslatedText text={t.processing.previewAlt} /></span>
                <span className="processing-preview-badge" style={{color: '#dc2626', background: '#fee2e2'}}>
                  <TranslatedText text={t.processing.interruptedTag} />
                </span>
              </div>
              <div className="processing-preview-frame-wrap">
                <RefineFrame
                  status="error"
                  width={320}
                  aspectRatio="4 / 3"
                  labels={refineLabels}
                  onRetry={onRetry}
                >
                  <img
                    src={previewUrl}
                    alt={t.processing.previewAlt}
                    crossOrigin="anonymous"
                  />
                </RefineFrame>
              </div>
            </div>

            <div className="processing-details-panel">
              <div className="processing-icon failed">
                <StatusMark status="failed" size={24} strokeWidth={2.5} errorColor="#b45309" />
              </div>
              <Typography.Title level={2}><TranslatedText text={t.processing.errorTitle} /></Typography.Title>
              <Typography.Paragraph type="secondary">
                <TranslatedText text={project.error || t.processing.errorFallback} />
              </Typography.Paragraph>
              {error && <Alert type="error" showIcon message={<TranslatedText text={t.processing.retryFailed} />} description={error} />}
              <div className="processing-actions">
                <Button type="primary" loading={busy} disabled={busy || !project.source_dir} onClick={onRetry}>
                  <TranslatedText text={t.processing.btnReprocess} />
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </main>
    </Layout>
  );
}
