import {useEffect, useRef, useState} from 'react';
import './ProjectHome.css';
import {Alert, Button, Card, Input, Layout, Progress, Space, Typography} from 'antd';
import {
  SafetyOutlined,
  AimOutlined,
  HistoryOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {AppHeader} from './AppHeader';
import HistoryProjects from './HistoryProjects';
import LetterGlitch from './LetterGlitch';
import StatusMark, {type MarkStatus} from './StatusMark';
import {projectName, projectStatusLabel} from '../flow';
import {sha256Hex} from '../hash';
import {compressionSupported, gzip, shouldCompress} from '../compress';
import type {CompressionSample} from '../compress';
import {optimizePng} from '../png';
import type {PngOptimization} from '../png';
import type {Project, UploadRole, UploadSession} from '../types';
import {apiUrl, apiFetch, errorText} from '../api';
import {cachePreviewThumbnail, generateClientThumbnail} from '../utils';
import {TranslatedText, useI18n} from '../i18n';

export const uploadRoleLabels: Record<UploadRole, string> = {
  pre: '采集前显微图 (PNG)', after: '采集后显微图 (PNG)', sbd: 'SBD 数据文件 (可选)',
  heatmap: 'MALDI 热图 (PNG)',
};
export const uploadRoleExtensions: Record<UploadRole, string[]> = {
  pre: ['.png'], after: ['.png'], sbd: ['.sbd'], heatmap: ['.png'],
};
export const uploadRoles: UploadRole[] = ['pre', 'after', 'sbd', 'heatmap'];
export const uploadSessionStorageKey = 'spatialbridge.pending-upload';

export function selectedFileKey(role: UploadRole, file: File) {
  return `${role}\u0000${file.name}\u0000${file.size}`;
}

export function uploadSessionMatches(session: UploadSession | null, selected: Record<UploadRole, File[]>) {
  if (!session || !['pending', 'assembling', 'failed'].includes(session.status)) return false;
  const selectedFiles = uploadRoles.flatMap((role) => selected[role].map((file) => ({role, file})));
  if (selectedFiles.length !== session.files.length) return false;
  const counts = new Map<string, number>();
  for (const item of selectedFiles) counts.set(selectedFileKey(item.role, item.file), (counts.get(selectedFileKey(item.role, item.file)) ?? 0) + 1);
  for (const item of session.files) {
    const key = `${item.role}\u0000${item.filename}\u0000${item.size}`;
    const count = counts.get(key) ?? 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return Array.from(counts.values()).every((count) => count === 0);
}

export function ProjectHome({
  projects,
  currentProject,
  onProject,
  onDemo,
  demoAvailable,
  onOpen,
  onRetry,
  onDelete,
  busy,
  error,
}: {
  projects: Project[];
  currentProject?: Project | null;
  onProject: (project: Project) => void;
  onDemo: () => void;
  demoAvailable: boolean;
  onOpen: (project: Project) => void;
  onRetry: (project: Project) => void;
  onDelete: (project: Project) => Promise<boolean>;
  busy: boolean;
  error?: string;
}) {
  const {t, language} = useI18n();
  const localizedRoleLabels: Record<UploadRole, string> = {
    pre: t.home.rolePre,
    after: t.home.roleAfter,
    sbd: t.home.roleSbd,
    heatmap: t.home.roleHeatmap,
  };
  const emptySelection = (): Record<UploadRole, File[]> => ({pre: [], after: [], sbd: [], heatmap: []});
  const [selected, setSelected] = useState<Record<UploadRole, File[]>>(emptySelection);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [session, setSession] = useState<UploadSession | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadCompleted, setUploadCompleted] = useState(false);
  const [preparingFiles, setPreparingFiles] = useState(false);
  const imageCache = useRef(new WeakMap<File, PngOptimization>());
  const [imageOptimizations, setImageOptimizations] = useState<Map<File, PngOptimization>>(new Map());
  const [paused, setPaused] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
  const pauseRef = useRef(false);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRefs = useRef<Partial<Record<UploadRole, HTMLInputElement | null>>>({});

  interface SelectionAnimState {
    status: MarkStatus;
    progress?: number;
    label: string;
  }
  const [selectionAnims, setSelectionAnims] = useState<Map<File, SelectionAnimState>>(new Map());
  const selectionAnimTimers = useRef<Map<File, number[]>>(new Map());

  interface VisualFileState {
    percent: number;
    done: boolean;
  }
  const [visualFileProgress, setVisualFileProgress] = useState<Record<string, VisualFileState>>({});
  const visualAnimRefs = useRef<Record<string, number>>({});

  const animateSelection = (file: File, delay = 0) => {
    const existing = selectionAnimTimers.current.get(file);
    if (existing) {
      existing.forEach((id) => {
        cancelAnimationFrame(id);
        clearTimeout(id);
      });
    }
    const timerIds: number[] = [];
    selectionAnimTimers.current.set(file, timerIds);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setSelectionAnims((prev) => new Map(prev).set(file, {status: 'done', label: t.home.animSelected}));
      return;
    }

    const startAnim = () => {
      const startTime = performance.now();
      const duration = 750;

      setSelectionAnims((prev) => new Map(prev).set(file, {
        status: 'running',
        progress: 0.05,
        label: t.home.animReading,
      }));

      const tick = (now: number) => {
        const elapsed = now - startTime;
        const timeFraction = Math.min(1, Math.max(0, elapsed / duration));
        const eased = 1 - Math.pow(1 - timeFraction, 3);

        if (timeFraction < 1) {
          const p = Math.max(0.05, Math.min(0.99, eased));
          setSelectionAnims((prev) => new Map(prev).set(file, {
            status: 'running',
            progress: p,
            label: p > 0.6 ? t.home.animValidating : t.home.animReading,
          }));
          const raf = requestAnimationFrame(tick);
          timerIds.push(raf);
        } else {
          setSelectionAnims((prev) => new Map(prev).set(file, {
            status: 'running',
            progress: 1,
            label: t.home.animValidationComplete,
          }));
          const timer = window.setTimeout(() => {
            setSelectionAnims((prev) => new Map(prev).set(file, {
              status: 'done',
              label: t.home.animSelected,
            }));
          }, 180);
          timerIds.push(timer);
        }
      };

      const raf = requestAnimationFrame(tick);
      timerIds.push(raf);
    };

    if (delay > 0) {
      const delayTimer = window.setTimeout(startAnim, delay);
      timerIds.push(delayTimer);
    } else {
      startAnim();
    }
  };

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [id, target] of Object.entries(fileProgress)) {
      const current = visualFileProgress[id]?.percent ?? 0;
      if (reduce) {
        setVisualFileProgress((prev) => ({
          ...prev,
          [id]: {percent: target, done: target >= 100},
        }));
        continue;
      }
      if (target > current) {
        if (visualAnimRefs.current[id]) {
          cancelAnimationFrame(visualAnimRefs.current[id]);
        }
        const startVal = current;
        const startTime = performance.now();
        const duration = Math.max(350, ((target - startVal) / 100) * 650);

        const step = (now: number) => {
          const elapsed = now - startTime;
          const progressFraction = Math.min(1, elapsed / duration);
          const eased = 1 - Math.pow(1 - progressFraction, 3);
          const nextVal = Math.round(startVal + (target - startVal) * eased);

          if (progressFraction < 1) {
            setVisualFileProgress((prev) => ({
              ...prev,
              [id]: {percent: nextVal, done: false},
            }));
            visualAnimRefs.current[id] = requestAnimationFrame(step);
          } else {
            setVisualFileProgress((prev) => ({
              ...prev,
              [id]: {percent: target, done: false},
            }));
            if (target >= 100) {
              window.setTimeout(() => {
                setVisualFileProgress((prev) => ({
                  ...prev,
                  [id]: {percent: 100, done: true},
                }));
              }, 200);
            }
          }
        };
        visualAnimRefs.current[id] = requestAnimationFrame(step);
      }
    }
  }, [fileProgress]);

  useEffect(() => {
    const active = new Set([...selected.pre, ...selected.after, ...selected.heatmap]);
    setImageOptimizations((current) => Array.from(current.keys()).every((file) => active.has(file))
      ? current : new Map(Array.from(current).filter(([file]) => active.has(file))));
  }, [selected]);

  useEffect(() => {
    const storedId = window.localStorage.getItem(uploadSessionStorageKey);
    if (!storedId) return;
    apiFetch<UploadSession>(`/uploads/${encodeURIComponent(storedId)}`).then(async (value) => {
      if (['pending', 'assembling', 'failed'].includes(value.status)) {
        setSession(value);
        setProjectNameInput(value.project_name ?? '');
        setFileProgress(Object.fromEntries(value.files.map((file) => [file.id, file.size ? Math.round(file.uploaded_size / file.size * 100) : 0])));
        setUploadStatus(value.status === 'assembling'
          ? t.home.sessionAssemblingNotice
          : value.status === 'failed'
            ? t.home.sessionInterruptedNotice
            : t.home.sessionUnfinishedNotice);
        if (value.error) setUploadError(value.error);
      } else if (value.completed_project_id) {
        const project = await apiFetch<Project>(`/projects/${encodeURIComponent(value.completed_project_id)}`);
        window.localStorage.removeItem(uploadSessionStorageKey);
        onProject(project);
      } else {
        window.localStorage.removeItem(uploadSessionStorageKey);
      }
    }).catch(() => window.localStorage.removeItem(uploadSessionStorageKey));
  }, []);

  const addFiles = (role: UploadRole, incoming: File[]) => {
    const accepted = incoming.filter((file) => uploadRoleExtensions[role].includes(`.${file.name.split('.').pop()?.toLowerCase() ?? ''}`) && file.size > 0);
    if (!accepted.length) {
      setUploadError(t.home.formatNotSupported(localizedRoleLabels[role]));
      return;
    }
    setUploadError('');
    setSelected((current) => ({...current, [role]: role === 'heatmap' ? [...current[role], ...accepted] : [accepted[0]]}));
    accepted.forEach((file, idx) => {
      animateSelection(file, idx * 80);
    });
  };

  const removeFile = (role: UploadRole, index: number) => {
    const fileToRemove = selected[role][index];
    if (fileToRemove) {
      const timers = selectionAnimTimers.current.get(fileToRemove);
      if (timers) {
        timers.forEach((id) => {
          cancelAnimationFrame(id);
          clearTimeout(id);
        });
        selectionAnimTimers.current.delete(fileToRemove);
      }
      setSelectionAnims((current) => {
        const next = new Map(current);
        next.delete(fileToRemove);
        return next;
      });
    }
    setSelected((current) => ({...current, [role]: current[role].filter((_, itemIndex) => itemIndex !== index)}));
  };
  const prepareFile = (role: UploadRole, file: File) => role === 'sbd'
    ? file
    : (imageOptimizations.get(file)?.file ?? file);
  const preparedSelection = Object.fromEntries(uploadRoles.map((role) => [role, selected[role].map((file) => prepareFile(role, file))])) as Record<UploadRole, File[]>;
  const selectedImages = [...selected.pre, ...selected.after, ...selected.heatmap];
  const checkedImages = selectedImages.filter((file) => imageOptimizations.has(file));
  const originalImageBytes = checkedImages.reduce((sum, file) => sum + file.size, 0);
  const optimizedImageBytes = checkedImages.reduce((sum, file) => sum + imageOptimizations.get(file)!.file.size, 0);
  const allSelected = uploadRoles.flatMap((role) => preparedSelection[role].map((file) => ({role, file})));
  const selectedTotal = allSelected.reduce((sum, item) => sum + item.file.size, 0);
  const canStart = selected.pre.length === 1 && selected.after.length === 1 && !uploading && !busy;

  const fileStatus = (
    file: File,
    percent: number | undefined,
    isDoneUpload: boolean,
  ): {status: MarkStatus; label: string; progress?: number} => {
    if (uploadCompleted || isDoneUpload) return {status: 'done', label: t.home.animUploaded};
    if (uploadError) return {status: 'failed', label: t.home.animInterrupted};
    if (paused) return {status: 'paused', label: t.home.animPaused};
    if (uploading) {
      if (preparingFiles) return {status: 'running', label: t.home.uploadStatusPreparing};
      return {
        status: 'running',
        label: percent != null && percent >= 100 ? t.home.animUploadDone : t.home.animUploading,
        progress: percent != null ? percent / 100 : undefined,
      };
    }

    const anim = selectionAnims.get(file);
    if (anim) {
      return {
        status: anim.status,
        label: anim.label,
        progress: anim.status === 'running' ? anim.progress : undefined,
      };
    }

    if (percent == null) return {status: 'done', label: t.home.animSelected};
    return {status: 'pending', label: t.home.animPendingUpload};
  };
  const overallStatus: MarkStatus = uploadCompleted ? 'done' : uploadError ? 'failed'
    : paused ? 'paused' : cancelRef.current ? 'cancelled' : 'running';

  const waitIfPaused = async () => {
    while (pauseRef.current && !cancelRef.current) await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    if (cancelRef.current) throw new Error(t.home.uploadStatusCancelled);
  };

  const finishUpload = async (uploadId: string) => {
    setUploadStatus(t.home.uploadStatusAssembling);
    const started = await apiFetch<UploadSession | Project>(`/uploads/${encodeURIComponent(uploadId)}/complete?background=true`, {method: 'POST'});
    if (!('files' in started)) return started;
    setSession(started);
    while (!cancelRef.current) {
      const remote = await apiFetch<UploadSession>(`/uploads/${encodeURIComponent(uploadId)}`);
      if (remote.status === 'failed') throw new Error(remote.error || t.home.uploadStatusAssemblyFailed);
      if (remote.status === 'completed' && remote.completed_project_id) {
        return apiFetch<Project>(`/projects/${encodeURIComponent(remote.completed_project_id)}`);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
    }
    throw new Error(t.home.uploadStatusCancelled);
  };

  const cancelUpload = async () => {
    cancelRef.current = true;
    pauseRef.current = false;
    abortRef.current?.abort();
    Object.values(visualAnimRefs.current).forEach((raf) => cancelAnimationFrame(raf));
    visualAnimRefs.current = {};
    setVisualFileProgress({});
    const current = session;
    if (current?.status === 'pending' || current?.status === 'failed') {
      try {
        await apiFetch(`/uploads/${encodeURIComponent(current.id)}`, {method: 'DELETE'});
      } catch (error) {
        setUploadError(errorText(error, language));
        setUploadStatus(t.home.uploadStatusCancelNotFinished);
        return;
      }
    }
    window.localStorage.removeItem(uploadSessionStorageKey);
    setSession(null);
    setProjectNameInput('');
    setUploading(false);
    setPaused(false);
    setUploadStatus(t.home.uploadStatusCancelled);
    setUploadedBytes(0);
    setFileProgress({});
  };

  const showUploadComplete = async (project: Project) => {
    // Generate low-weight client thumbnail strictly for the loading/refining preview
    if (selected.pre[0]) {
      try {
        const thumbUrl = await generateClientThumbnail(selected.pre[0], 640);
        cachePreviewThumbnail(project.id, thumbUrl);
      } catch {
        // Fallback to backend thumbnail
      }
    }
    // Server work is finished; each pause only lets the mark finish its animation.
    setUploadStatus(t.home.uploadStatusComplete);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 800));
      setUploadCompleted(true);
      await new Promise<void>(resolve => window.setTimeout(resolve, 1500));
    }
    setSession(null);
    setFileProgress({});
    setVisualFileProgress({});
    onProject(project);
  };

  const startUpload = async () => {
    if (!canStart) return;
    setUploadCompleted(false);
    setUploadError('');
    setUploadStatus(t.home.uploadStatusPreparing);
    setUploadedBytes(0);
    setTotalBytes(0);
    cancelRef.current = false;
    pauseRef.current = false;
    setPaused(false);
    setUploading(true);
    try {
      let uploadSelection = selected;
      setPreparingFiles(true);
      abortRef.current = new AbortController();
      const optimized = new Map<File, PngOptimization>();
      uploadSelection = {...uploadSelection};
      for (const role of ['pre', 'after', 'heatmap'] as const) {
        uploadSelection[role] = [];
        for (const source of selected[role]) {
          setUploadStatus(t.home.uploadStatusCheckingPng(source.name));
          // Resume older sessions with their original PNG bytes and chunk hashes.
          const resumeOriginal = session?.files.some((file) => file.role === role && file.filename === source.name && file.size === source.size);
          const result = resumeOriginal ? {file: source, reason: 'unchanged' as const}
            : imageCache.current.get(source) ?? await optimizePng(source, {
              signal: abortRef.current.signal,
              onProgress: (bytes) => setUploadStatus(t.home.uploadStatusOptimizingPng(source.name, (bytes / 1024 / 1024).toFixed(0))),
            });
          if (cancelRef.current) return;
          if (!resumeOriginal) imageCache.current.set(source, result);
          optimized.set(source, result);
          uploadSelection[role].push(result.file);
        }
      }
      setImageOptimizations(optimized);
      setPreparingFiles(false);
      abortRef.current = null;
      const uploadFiles = uploadRoles.flatMap((role) => uploadSelection[role].map((file) => ({role, file})));
      let currentSession = session && uploadSessionMatches(session, uploadSelection)
        ? await apiFetch<UploadSession>(`/uploads/${encodeURIComponent(session.id)}`)
        : null;
      if (!currentSession) {
        currentSession = await apiFetch<UploadSession>('/uploads', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({project_name: projectNameInput.trim() || null, files: uploadFiles.map(({role, file}) => ({role, filename: file.name, size: file.size}))}),
        });
        setSession(currentSession);
        setProjectNameInput(currentSession.project_name ?? '');
        setFileProgress(Object.fromEntries(currentSession.files.map((file) => [file.id, file.size ? Math.round(file.uploaded_size / file.size * 100) : 0])));
        window.localStorage.setItem(uploadSessionStorageKey, currentSession.id);
      }
      if (currentSession.status === 'completed' && currentSession.completed_project_id) {
        const project = await apiFetch<Project>(`/projects/${encodeURIComponent(currentSession.completed_project_id)}`);
        window.localStorage.removeItem(uploadSessionStorageKey);
        await showUploadComplete(project);
        return;
      }
      if (['assembling', 'failed'].includes(currentSession.status)) {
        const project = await finishUpload(currentSession.id);
        window.localStorage.removeItem(uploadSessionStorageKey);
        await showUploadComplete(project);
        return;
      }
      const used = new Set<number>();
      const matchingFiles = currentSession.files.map((remote) => {
        const index = uploadFiles.findIndex((item, itemIndex) => !used.has(itemIndex) && item.role === remote.role && item.file.name === remote.filename && item.file.size === remote.size);
        if (index < 0) throw new Error(t.home.selectMatchingFile(remote.filename));
        used.add(index);
        return {remote, local: uploadFiles[index].file};
      });
      const total = currentSession.files.reduce((sum, file) => sum + file.size, 0);
      let completedBytes = currentSession.files.reduce((sum, file) => sum + file.uploaded_size, 0);
      setTotalBytes(total);
      setUploadedBytes(completedBytes);
      setFileProgress(Object.fromEntries(currentSession.files.map((file) => [file.id, file.size ? Math.round(file.uploaded_size / file.size * 100) : 0])));
      for (const {remote, local} of matchingFiles) {
        const uploaded = new Set(remote.uploaded_chunks);
        // PNG already contains Deflate; avoid redundant gzip and server decompression.
        let compression = null as CompressionSample | null;
        const canCompress = !local.name.toLowerCase().endsWith('.png') && compressionSupported();
        for (let index = 0; index < remote.total_chunks; index += 1) {
          await waitIfPaused();
          if (uploaded.has(index)) continue;
          const start = index * remote.chunk_size;
          const chunk = local.slice(start, Math.min(local.size, start + remote.chunk_size));
          const buffer = await chunk.arrayBuffer();
          const hash = await sha256Hex(buffer);
          let body = buffer;
          const headers: Record<string, string> = {'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hash};
          if (canCompress && buffer.byteLength > 0 && shouldCompress(compression)) {
            const compressStarted = performance.now();
            const compressed = await gzip(buffer);
            const seconds = Math.max((performance.now() - compressStarted) / 1000, 1e-3);
            compression = {
              ratio: compressed.byteLength / buffer.byteLength,
              compressBytesPerSecond: buffer.byteLength / seconds,
              networkBytesPerSecond: compression?.networkBytesPerSecond ?? 0,
            };
            if (shouldCompress({...compression, compressBytesPerSecond: 0, networkBytesPerSecond: 0})) {
              body = compressed;
              headers['Content-Encoding'] = 'gzip';
            }
          }
          let response: Response | undefined;
          let chunkUploaded = false;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await waitIfPaused();
            try {
              abortRef.current = new AbortController();
              const sendStarted = performance.now();
              response = await fetch(apiUrl(`/uploads/${encodeURIComponent(currentSession.id)}/files/${encodeURIComponent(remote.id)}/chunks/${index}`), {
                method: 'PUT', body, signal: abortRef.current.signal, headers,
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.detail || (language === 'en' ? `Chunk upload failed (${response.status})` : `分片上传失败（${response.status}）`));
              }
              if (compression) {
                compression = {...compression, networkBytesPerSecond: body.byteLength / Math.max((performance.now() - sendStarted) / 1000, 1e-3)};
              }
              chunkUploaded = true;
              break;
            } catch (error) {
              lastError = error;
              if (cancelRef.current) throw new Error(t.home.uploadStatusCancelled);
              if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
            }
          }
          if (!chunkUploaded) throw lastError instanceof Error ? lastError : new Error(t.home.chunkUploadFailed);
          completedBytes += chunk.size;
          setUploadedBytes(completedBytes);
          setFileProgress((current) => ({...current, [remote.id]: Math.min(100, Math.round((start + chunk.size) / local.size * 100))}));
          setUploadStatus(t.home.uploadStatusUploadingChunk(remote.filename, index + 1, remote.total_chunks));
        }
      }
      const project = await finishUpload(currentSession.id);
      window.localStorage.removeItem(uploadSessionStorageKey);
      await showUploadComplete(project);
    } catch (error) {
      if (!cancelRef.current) {
        setPaused(true);
        pauseRef.current = true;
        setUploadError(errorText(error, language));
        setUploadStatus(t.home.uploadStatusIncomplete);
      }
    } finally {
      abortRef.current = null;
      setPreparingFiles(false);
      setUploading(false);
    }
  };


  const visibleProjects = projects.filter((item) => !item.deleted_at);
  const activeProcessingProjects = visibleProjects.filter((item) => item.status === 'running' || item.status === 'queued');

  return (
    <Layout className="app project-home-app">
      <LetterGlitch />
      <AppHeader
        sticky
        tagline={t.home.brandSubtitle}
        actions={activeProcessingProjects.length > 0 ? (
          <button
            type="button"
            className="app-header__live-pill"
            disabled={busy || uploading}
            onClick={() => onOpen(activeProcessingProjects[0])}
          >
            <span className="app-header__status-dot" aria-hidden="true" />
            <TranslatedText text={t.home.processingCount(activeProcessingProjects.length)} />
          </button>
        ) : undefined}
      />
      <main className="project-home">
        <section className="home-intro">
          <Typography.Title><TranslatedText text={t.home.heroTitle} /></Typography.Title>
          <Typography.Paragraph><TranslatedText text={t.home.heroDesc} /></Typography.Paragraph>
          {currentProject && <div className="home-current"><div><span><TranslatedText text={t.home.currentProjectPrefix} /><TranslatedText text={projectStatusLabel(currentProject.status, language)} /></span><strong><TranslatedText text={projectName(currentProject, language)} /></strong></div><Button size="small" disabled={busy || uploading} onClick={() => onOpen(currentProject)}><TranslatedText text={t.home.enterCurrentProject} /></Button></div>}
        </section>
        <div className={`home-grid${visibleProjects.length ? '' : ' is-empty'}`}>
          <Card className="home-import-card" variant="borderless">
            <Typography.Title level={3}><TranslatedText text={t.home.newProject} /></Typography.Title>
            <Typography.Text type="secondary"><TranslatedText text={t.home.uploadDesc} /></Typography.Text>
            <Input aria-label={t.workbench.projectName} value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} placeholder={t.home.projectNamePlaceholder} maxLength={200} disabled={uploading || busy || !!session} />
            <div className="upload-file-pickers">
              {uploadRoles.map((role) => <div className="upload-file-picker" key={role}>
                <input ref={(element) => {inputRefs.current[role] = element;}} type="file" accept={uploadRoleExtensions[role].join(',')} multiple={role === 'heatmap'} hidden onChange={(event) => {addFiles(role, Array.from(event.target.files ?? [])); event.currentTarget.value = '';}} />
                <div className="upload-picker-heading"><span><TranslatedText text={localizedRoleLabels[role]} /></span><Button size="small" icon={<UploadOutlined />} disabled={uploading || busy} onClick={() => inputRefs.current[role]?.click()}><TranslatedText text={t.common.selectFile} /></Button></div>
                {selected[role].length > 0 ? <div className="upload-selected-list">{selected[role].map((file, index) => {
                  const preparedFile = prepareFile(role, file);
                  const remote = session?.files.find((item) => item.role === role && item.filename === preparedFile.name && item.size === preparedFile.size);
                  const visual = remote ? visualFileProgress[remote.id] : undefined;
                  const percent = visual?.percent ?? (remote ? (fileProgress[remote.id] ?? 0) : undefined);
                  const isDoneUpload = visual?.done ?? (uploadCompleted || (percent != null && percent >= 100));
                  const mark = fileStatus(file, percent, isDoneUpload);
                  const opt = imageOptimizations.get(file);
                  const sizeDiff = opt && opt.file.size < file.size ? Math.round((1 - opt.file.size / file.size) * 100) : 0;

                  return (
                    <div className="upload-selected-file" key={`${file.name}-${file.size}-${index}`}>
                      <div className="upload-selected-file-main">
                        <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                          <StatusMark status={mark.status} progress={mark.progress} size={16} />
                          <span title={file.name} style={{fontWeight: 500}}>{file.name}</span>
                          <span style={{color: '#8c9c96', fontSize: 10}}>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                          <span className="upload-file-state" data-status={mark.status}><TranslatedText text={mark.label} /></span>
                          {sizeDiff > 0 && <span className="lens-tag"><TranslatedText text={t.home.optimizedSaving(sizeDiff)} /></span>}
                        </div>
                        {percent != null && <Progress percent={percent} size="small" showInfo={false} strokeColor="#2d6a5b" />}
                      </div>
                      <Button type="text" size="small" disabled={uploading} onClick={() => removeFile(role, index)}><TranslatedText text={t.common.remove} /></Button>
                    </div>
                  );
                })}</div> : <StatusMark className="upload-empty" status="pending" size={14} fontSize={10} label={t.home.noFileSelected} />}
              </div>)}
            </div>
            {checkedImages.length > 0 && <Typography.Paragraph type="secondary"><TranslatedText text={optimizedImageBytes < originalImageBytes
              ? t.home.pngOptimizationSummary((originalImageBytes / 1024 / 1024).toFixed(1), (optimizedImageBytes / 1024 / 1024).toFixed(1))
              : t.home.pngOptimizationSkipped} /></Typography.Paragraph>}
            {session && <Alert type="info" showIcon message={<TranslatedText text={t.home.sessionDetectedTitle} />} description={<TranslatedText text={uploadSessionMatches(session, preparedSelection) ? t.home.sessionMatched : t.home.sessionReselect} />} />}
            {(preparingFiles || uploading || uploadedBytes > 0 || (session && uploadStatus) || cancelRef.current && uploadStatus) && <div className="upload-progress-block" role="status">
              <div className="upload-progress-heading">
                <StatusMark status={overallStatus} progress={!preparingFiles && totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : undefined}
                  size={20} label={uploadStatus || t.home.uploadStatusPreparing} />
                {!preparingFiles && totalBytes > 0 && <span className="upload-progress-percent"><TranslatedText text={t.home.uploadProgressPercent(Math.min(100, Math.round(uploadedBytes / totalBytes * 100)))} /></span>}
              </div>
              {!preparingFiles && totalBytes > 0 && <>
                <Progress percent={Math.min(100, Math.round(uploadedBytes / totalBytes * 100))} showInfo={false}
                  status={uploadError ? 'exception' : uploadCompleted ? 'success' : 'normal'} strokeColor="#2d6a5b" />
                <Typography.Text type="secondary">{(uploadedBytes / 1024 / 1024).toFixed(1)} / {(Math.max(totalBytes, selectedTotal) / 1024 / 1024).toFixed(1)} MB</Typography.Text>
              </>}
            </div>}
            <Space wrap className="home-actions">
              <Button type="primary" onClick={startUpload} disabled={!canStart} loading={uploading && !paused && !uploadCompleted}><TranslatedText text={uploadCompleted ? t.home.btnUploadComplete : t.home.btnStartUpload} /></Button>
              {uploading && !preparingFiles && session && session.status !== 'assembling' && <Button icon={<PauseOutlined />} onClick={() => {pauseRef.current = !pauseRef.current; setPaused(pauseRef.current);}}><TranslatedText text={paused ? t.home.btnResumeUpload : t.home.btnPauseUpload} /></Button>}
              {!uploading && paused && session && <Button icon={<PlayCircleOutlined />} onClick={startUpload}><TranslatedText text={t.home.btnResumeUpload} /></Button>}
              {(preparingFiles || session && session.status !== 'assembling') && <Button danger onClick={cancelUpload}><TranslatedText text={t.home.btnCancelUpload} /></Button>}
              {demoAvailable && <Button onClick={onDemo} disabled={busy || uploading}><TranslatedText text={t.home.btnLoadDemo} /></Button>}
            </Space>
            {(error || uploadError) && <Alert type="error" showIcon message={<TranslatedText text={t.common.operationFailed} />} description={error || uploadError} />}
            <div className="home-notes"><span><SafetyOutlined /><TranslatedText text={t.home.featureIntegrity} /></span><span><AimOutlined /><TranslatedText text={t.home.featureMapping} /></span><span><HistoryOutlined /><TranslatedText text={t.home.featurePersistence} /></span></div>
          </Card>
          <HistoryProjects projects={visibleProjects} onOpen={onOpen} onRetry={onRetry} onDelete={onDelete} busy={busy} />
        </div>
      </main>
    </Layout>
  );
}
