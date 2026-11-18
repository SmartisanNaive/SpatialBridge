import {useEffect, useState} from 'react';
import {Alert, Button, Layout, Progress, Typography} from 'antd';
import {projectName} from '../flow';
import type {Project} from '../types';
import {apiUrl} from '../api';
import {getCachedPreviewThumbnail} from '../utils';
import {TranslatedText, useI18n} from '../i18n';
import {AppHeader} from './AppHeader';
import CubeLoader from './CubeLoader';
import StatusMark, {type MarkStatus} from './StatusMark';
import PixelatedCanvas from './PixelatedCanvas';

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

// Only expose a preview after it has loaded and decoded. Local blob/data URLs
// must remain untouched; cache-busting parameters belong only on API requests.
function usePreviewImage(projectId: string, retryKey = 0): string | undefined {
  const [preview, setPreview] = useState<{projectId: string; src: string}>();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: HTMLImageElement | undefined;
    const localThumb = getCachedPreviewThumbnail(projectId);
    const endpoint = apiUrl(`/projects/${encodeURIComponent(projectId)}/preview/pre?thumb=1`);

    const load = (src: string, isLocal: boolean) => {
      if (cancelled) return;
      const image = new Image();
      pending = image;
      const failed = () => {
        if (cancelled) return;
        if (isLocal) {
          load(endpoint, false);
        } else {
          timer = setTimeout(() => load(`${endpoint}&t=${Date.now()}`, false), 3000);
        }
      };
      image.onerror = failed;
      image.onload = async () => {
        try {
          await image.decode();
          if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty preview');
          if (!cancelled) setPreview({projectId, src});
        } catch {
          failed();
        }
      };
      image.src = src;
    };

    load(localThumb || endpoint, Boolean(localThumb));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (pending) {
        pending.onload = null;
        pending.onerror = null;
      }
    };
  }, [projectId, retryKey]);

  return preview?.projectId === projectId ? preview.src : undefined;
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

  const previewUrl = usePreviewImage(project.id);
  const currentProjectName = projectName(project, language);
  const currentStepNumber = Math.min(pipelineSteps.length, activeStepIndex + 1);

  return (
    <Layout className="app processing-app">
      <AppHeader
        sticky
        onHome={onHome}
        projectTitle={currentProjectName}
        projectTooltip={`${currentProjectName} · ${project.id.slice(0, 8)}`}
        status={{
          label: isQueued ? t.status.queued : t.processing.pageTitle,
          tone: isQueued ? 'queued' : 'processing',
        }}
      />
      <main className="processing-workspace">
        <section className="processing-dock" aria-label={t.processing.pipelineProgress}>
          <div className="processing-dock-inner">
            <div className="processing-status-bar">
              <div className="processing-status-lead">
                <CubeLoader label={isQueued ? t.processing.loaderQueued : t.processing.loaderRunning} />
                <Typography.Paragraph type="secondary" className="processing-subtitle">
                  <TranslatedText text={t.processing.loaderDesc} />
                </Typography.Paragraph>
              </div>

              <div className="processing-telemetry">
                <div className="processing-telemetry-row">
                  <span className="processing-telemetry-stage">
                    <StatusMark
                      status={isQueued ? 'pending' : 'running'}
                      progress={hasTotal && percent !== undefined ? percent / 100 : undefined}
                      size={16}
                      strokeWidth={2}
                    />
                    <strong><TranslatedText text={stage} /></strong>
                  </span>
                  <div className="processing-telemetry-badges">
                    {hasTotal && (
                      <em className="processing-telemetry-count">
                        {Number(progress?.completed)} / {Number(progress?.total)}
                      </em>
                    )}
                    <span className="processing-step-pill">
                      <TranslatedText text={t.processing.stepCounter(currentStepNumber, pipelineSteps.length)} />
                    </span>
                  </div>
                </div>
                <div className="processing-telemetry-meter">
                  {hasTotal ? (
                    <Progress percent={percent} showInfo strokeColor="#2d6a5b" trailColor="#dce8e2" size="small" />
                  ) : (
                    <div className="processing-indeterminate">
                      <div className="processing-indeterminate-bar" aria-hidden="true">
                        <span />
                      </div>
                      <span><TranslatedText text={t.processing.autoEnter} /></span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="processing-pipeline-rail">
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
                  <div key={step.id} className={`processing-rail-step step-${stepStatus}`}>
                    <div className="processing-rail-head">
                      <span className="processing-rail-mark">
                        <StatusMark
                          status={stepStatus}
                          progress={stepProgress}
                          size={17}
                          strokeWidth={2}
                        />
                      </span>
                      <span className="processing-rail-line" aria-hidden="true" />
                    </div>
                    <div className="processing-rail-body">
                      <div className="processing-rail-title-row">
                        <span className="processing-rail-name"><TranslatedText text={step.title} /></span>
                        {isActive && hasTotal && (
                          <span className="processing-rail-count">
                            {Number(progress?.completed)} / {Number(progress?.total)}
                          </span>
                        )}
                      </div>
                      <p className="processing-rail-desc">
                        {isActive ? stage : step.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {connectionError && (
              <Alert
                className="processing-connection-alert"
                type="warning"
                showIcon
                message={<TranslatedText text={t.processing.disconnectedTitle} />}
                description={<TranslatedText text={t.processing.disconnectedDesc} />}
              />
            )}
          </div>
        </section>

        <section className="processing-canvas-area" aria-label={t.processing.previewTitle}>
          <div className="processing-canvas-viewport">
            {previewUrl ? (
              <PixelatedCanvas
                src={previewUrl}
                cellSize={4}
                dotScale={0.9}
                shape="square"
                backgroundColor="transparent"
                dropoutStrength={0.08}
                interactive
                distortionStrength={0.1}
                distortionRadius={260}
                distortionMode="repel"
                followSpeed={0.2}
                jitterStrength={4}
                jitterSpeed={1}
                sampleAverage
                responsive
                fillHeight
                objectFit="contain"
                maxWidth={1680}
                maxHeight={760}
                className="processing-canvas-surface"
                ariaLabel={t.processing.previewAlt}
              />
            ) : (
              <div className="processing-canvas-placeholder">
                <StatusMark status="running" size={20} strokeWidth={2} />
                <span><TranslatedText text={t.processing.previewLoading} /></span>
              </div>
            )}
          </div>
        </section>
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
  const previewUrl = usePreviewImage(project.id);
  const currentProjectName = projectName(project, language);

  return (
    <Layout className="app processing-app">
      <AppHeader
        sticky
        onHome={onHome}
        projectTitle={currentProjectName}
        projectTooltip={`${currentProjectName} · ${project.id.slice(0, 8)}`}
        status={{
          label: t.status.failed,
          tone: 'error',
        }}
      />
      <main className="processing-workspace">
        <section className="processing-dock processing-dock--failed">
          <div className="processing-dock-inner">
            <div className="processing-failed-bar">
              <div className="processing-failed-lead">
                <div className="processing-icon failed">
                  <StatusMark status="failed" size={22} strokeWidth={2.5} errorColor="#b45309" />
                </div>
                <div className="processing-failed-copy">
                  <Typography.Title level={3} className="processing-failed-title">
                    <TranslatedText text={t.processing.errorTitle} />
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" className="processing-subtitle">
                    <TranslatedText text={project.error || t.processing.errorFallback} />
                  </Typography.Paragraph>
                </div>
              </div>
              <div className="processing-failed-actions">
                <Button type="primary" loading={busy} disabled={busy || !project.source_dir} onClick={onRetry}>
                  <TranslatedText text={t.processing.btnReprocess} />
                </Button>
              </div>
            </div>
            {error && (
              <Alert
                className="processing-connection-alert"
                type="error"
                showIcon
                message={<TranslatedText text={t.processing.retryFailed} />}
                description={error}
              />
            )}
          </div>
        </section>

        <section className="processing-canvas-area processing-canvas-area--failed" aria-label={t.processing.previewAlt}>
          <div className="processing-canvas-viewport">
            {previewUrl ? (
              <PixelatedCanvas
                src={previewUrl}
                cellSize={4}
                dotScale={0.9}
                shape="square"
                backgroundColor="transparent"
                dropoutStrength={0.12}
                grayscale
                interactive={false}
                sampleAverage
                responsive
                fillHeight
                objectFit="contain"
                maxWidth={1680}
                maxHeight={760}
                className="processing-canvas-surface"
                ariaLabel={t.processing.previewAlt}
              />
            ) : (
              <div className="processing-canvas-placeholder">
                <StatusMark status="failed" size={20} strokeWidth={2} errorColor="#b45309" />
                <span><TranslatedText text={t.processing.interruptedTag} /></span>
              </div>
            )}
          </div>
        </section>
      </main>
    </Layout>
  );
}
