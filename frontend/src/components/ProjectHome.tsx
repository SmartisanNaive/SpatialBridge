import './ProjectHome.css';
import HistoryProjects from './HistoryProjects';
import LetterGlitch from './LetterGlitch';
import StatusMark, {type MarkStatus} from './StatusMark';
import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Card, Input, Layout, Progress, Space, Typography} from 'antd';
import {
  SafetyOutlined,
  AimOutlined,
  HistoryOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {projectName, projectStatusLabel} from '../flow';
import {sha256Hex} from '../hash';
import {compressionSupported, gzip, shouldCompress} from '../compress';
import type {CompressionSample} from '../compress';
import {extractSbd} from '../sbd';
import type {SbdExtraction} from '../sbd';
import {optimizePng} from '../png';
import type {PngOptimization} from '../png';
import type {Project, UploadRole, UploadSession} from '../types';
import {apiUrl, apiFetch, errorText} from '../api';

export const uploadRoleLabels: Record<UploadRole, string> = {
  pre: '采集前显微图（PNG）', after: '采集后显微图（PNG）', sbd: 'SBD 数据（可选）',
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
  busy: boolean;
  error?: string;
}) {
  const emptySelection = (): Record<UploadRole, File[]> => ({pre: [], after: [], sbd: [], heatmap: []});
  const [selected, setSelected] = useState<Record<UploadRole, File[]>>(emptySelection);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [session, setSession] = useState<UploadSession | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadCompleted, setUploadCompleted] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [sbdExtraction, setSbdExtraction] = useState<{source: File; result: SbdExtraction} | null>(null);
  const extractionRef = useRef<{source: File; result: SbdExtraction} | null>(null);
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
          ? '服务器正在合并上次上传的文件。请重新选择相同文件后查看进度。'
          : value.status === 'failed'
            ? '上次文件合并中断。请重新选择相同文件后重试，已上传分片会保留。'
            : '发现未完成的上传。请重新选择相同文件后即可继续。');
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
      setUploadError(`${uploadRoleLabels[role]}格式不正确或文件为空。`);
      return;
    }
    setUploadError('');
    setSelected((current) => ({...current, [role]: role === 'heatmap' ? [...current[role], ...accepted] : [accepted[0]]}));
  };

  const removeFile = (role: UploadRole, index: number) => setSelected((current) => ({...current, [role]: current[role].filter((_, itemIndex) => itemIndex !== index)}));
  const prepareFile = (role: UploadRole, file: File) => role === 'sbd'
    ? (sbdExtraction?.source === file ? sbdExtraction.result.file : file)
    : (imageOptimizations.get(file)?.file ?? file);
  const preparedSelection = Object.fromEntries(uploadRoles.map((role) => [role, selected[role].map((file) => prepareFile(role, file))])) as Record<UploadRole, File[]>;
  const selectedImages = [...selected.pre, ...selected.after, ...selected.heatmap];
  const checkedImages = selectedImages.filter((file) => imageOptimizations.has(file));
  const originalImageBytes = checkedImages.reduce((sum, file) => sum + file.size, 0);
  const optimizedImageBytes = checkedImages.reduce((sum, file) => sum + imageOptimizations.get(file)!.file.size, 0);
  const allSelected = uploadRoles.flatMap((role) => preparedSelection[role].map((file) => ({role, file})));
  const selectedTotal = allSelected.reduce((sum, item) => sum + item.file.size, 0);
  const legacySbdSession = !!session?.files.some((file) => file.role === 'sbd' && file.filename.toLowerCase().endsWith('.sbd'));
  const canStart = selected.pre.length === 1 && selected.after.length === 1 && !uploading && !busy && !legacySbdSession;

  const fileStatus = (percent: number | undefined): {status: MarkStatus; label: string; progress?: number} => {
    if (uploadCompleted || percent != null && percent >= 100) return {status: 'done', label: '已上传'};
    if (percent == null) return {status: 'done', label: '已选择'};
    if (uploadError) return {status: 'failed', label: '上传中断'};
    if (paused) return {status: 'paused', label: '已暂停'};
    if (uploading && !extracting) return {status: 'running', label: '上传中', progress: percent / 100};
    return {status: 'pending', label: '等待上传'};
  };
  const overallStatus: MarkStatus = uploadCompleted ? 'done' : uploadError ? 'failed'
    : paused ? 'paused' : cancelRef.current ? 'cancelled' : 'running';

  const waitIfPaused = async () => {
    while (pauseRef.current && !cancelRef.current) await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    if (cancelRef.current) throw new Error('上传已取消');
  };

  const finishUpload = async (uploadId: string) => {
    setUploadStatus('正在服务器校验并合并文件…');
    const started = await apiFetch<UploadSession | Project>(`/uploads/${encodeURIComponent(uploadId)}/complete?background=true`, {method: 'POST'});
    if (!('files' in started)) return started;
    setSession(started);
    while (!cancelRef.current) {
      const remote = await apiFetch<UploadSession>(`/uploads/${encodeURIComponent(uploadId)}`);
      if (remote.status === 'failed') throw new Error(remote.error || '文件合并失败，请重新尝试。');
      if (remote.status === 'completed' && remote.completed_project_id) {
        return apiFetch<Project>(`/projects/${encodeURIComponent(remote.completed_project_id)}`);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
    }
    throw new Error('上传已取消');
  };

  const cancelUpload = async () => {
    cancelRef.current = true;
    pauseRef.current = false;
    abortRef.current?.abort();
    const current = session;
    if (current?.status === 'pending' || current?.status === 'failed') {
      try {
        await apiFetch(`/uploads/${encodeURIComponent(current.id)}`, {method: 'DELETE'});
      } catch (error) {
        setUploadError(errorText(error));
        setUploadStatus('取消未完成，请重试；上传会话仍然保留。');
        return;
      }
    }
    window.localStorage.removeItem(uploadSessionStorageKey);
    setSession(null);
    setProjectNameInput('');
    setUploading(false);
    setPaused(false);
    setUploadStatus('上传已取消。');
    setUploadedBytes(0);
    setFileProgress({});
  };

  const showUploadComplete = async (project: Project) => {
    // Server work is finished; each pause only lets the mark finish its animation.
    setUploadStatus('文件上传完成');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 700));
      setUploadCompleted(true);
      await new Promise<void>(resolve => window.setTimeout(resolve, 1500));
    }
    setSession(null);
    setFileProgress({});
    onProject(project);
  };

  const startUpload = async () => {
    if (!canStart) return;
    setUploadCompleted(false);
    setUploadError('');
    setUploadStatus('准备上传…');
    setUploadedBytes(0);
    setTotalBytes(0);
    cancelRef.current = false;
    pauseRef.current = false;
    setPaused(false);
    setUploading(true);
    try {
      let uploadSelection = selected;
      if (selected.sbd.length) {
        const source = selected.sbd[0];
        setExtracting(true);
        setUploadStatus('正在本地读取 SBD 索引…');
        abortRef.current = new AbortController();
        const cached = extractionRef.current?.source === source ? extractionRef.current.result : null;
        const result = cached ?? await extractSbd(source, {
          signal: abortRef.current.signal,
          onProgress: ({stage}) => setUploadStatus(stage),
        });
        if (cancelRef.current) return;
        extractionRef.current = {source, result};
        setSbdExtraction({source, result});
        uploadSelection = {...selected, sbd: [result.file]};
        setExtracting(false);
        abortRef.current = null;
      }
      setExtracting(true);
      abortRef.current = new AbortController();
      const optimized = new Map<File, PngOptimization>();
      uploadSelection = {...uploadSelection};
      for (const role of ['pre', 'after', 'heatmap'] as const) {
        uploadSelection[role] = [];
        for (const source of selected[role]) {
          setUploadStatus(`正在本地检查并无损优化图片：${source.name}`);
          // Resume older sessions with their original PNG bytes and chunk hashes.
          const resumeOriginal = session?.files.some((file) => file.role === role && file.filename === source.name && file.size === source.size);
          const result = resumeOriginal ? {file: source, reason: 'unchanged' as const}
            : imageCache.current.get(source) ?? await optimizePng(source, {
              signal: abortRef.current.signal,
              onProgress: (bytes) => setUploadStatus(`正在本地无损优化 ${source.name}，已处理 ${(bytes / 1024 / 1024).toFixed(0)} MB 图像数据…`),
            });
          if (cancelRef.current) return;
          if (!resumeOriginal) imageCache.current.set(source, result);
          optimized.set(source, result);
          uploadSelection[role].push(result.file);
        }
      }
      setImageOptimizations(optimized);
      setExtracting(false);
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
        if (index < 0) throw new Error(`请重新选择上传文件：${remote.filename}`);
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
                throw new Error(payload.detail || `分片上传失败（${response.status}）`);
              }
              if (compression) {
                compression = {...compression, networkBytesPerSecond: body.byteLength / Math.max((performance.now() - sendStarted) / 1000, 1e-3)};
              }
              chunkUploaded = true;
              break;
            } catch (error) {
              lastError = error;
              if (cancelRef.current) throw new Error('上传已取消');
              if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
            }
          }
          if (!chunkUploaded) throw lastError instanceof Error ? lastError : new Error('分片上传失败，请稍后继续');
          completedBytes += chunk.size;
          setUploadedBytes(completedBytes);
          setFileProgress((current) => ({...current, [remote.id]: Math.min(100, Math.round((start + chunk.size) / local.size * 100))}));
          setUploadStatus(`正在上传 ${remote.filename}（${index + 1}/${remote.total_chunks}）`);
        }
      }
      const project = await finishUpload(currentSession.id);
      window.localStorage.removeItem(uploadSessionStorageKey);
      setSession(null);
      await showUploadComplete(project);
    } catch (error) {
      if (!cancelRef.current) {
        setPaused(true);
        pauseRef.current = true;
        setUploadError(errorText(error));
        setUploadStatus('本次上传或文件合并未完成，可重新选择相同文件后继续。');
      }
    } finally {
      abortRef.current = null;
      setExtracting(false);
      setUploading(false);
    }
  };

  return (
    <Layout className="app project-home-app">
      <LetterGlitch />
      <header className="home-header">
        <div className="home-brand"><img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" /><div><strong>SpatialBridge</strong><span>显微图与 MALDI 空间配准</span></div></div>
        <div className="home-header-meta"><span className="status-dot" />共享项目</div>
      </header>
      <main className="project-home">
        <section className="home-intro">
          <Typography.Title>从一个项目开始</Typography.Title>
          <Typography.Paragraph>上传采集前后显微图，生成可复核的空间坐标工作台。</Typography.Paragraph>
          {currentProject && <div className="home-current"><div><span>当前项目 · {projectStatusLabel(currentProject.status)}</span><strong>{projectName(currentProject)}</strong></div><Button size="small" disabled={busy || uploading} onClick={() => onOpen(currentProject)}>继续当前项目</Button></div>}
        </section>
        <div className={`home-grid${projects.length ? '' : ' is-empty'}`}>
          <Card className="home-import-card" variant="borderless">
            <div className="home-card-kicker">新建项目</div>
            <Typography.Title level={3}>上传项目文件</Typography.Title>
            <Typography.Text type="secondary">采集前和采集后 PNG 必填；SBD 和热图可选。SBD 会先在本机提取配准所需数据；PNG 自动尝试无损优化，已充分压缩的图片直接上传。像素、尺寸和原始文件保持不变。文件分片上传，网络中断后可以继续。</Typography.Text>
            <Input aria-label="项目名称" value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} placeholder="自定义项目名称（留空则使用创建时间戳）" maxLength={200} disabled={uploading || busy || !!session} />
            <div className="upload-file-pickers">
              {uploadRoles.map((role) => <div className="upload-file-picker" key={role}>
                <input ref={(element) => {inputRefs.current[role] = element;}} type="file" accept={uploadRoleExtensions[role].join(',')} multiple={role === 'heatmap'} hidden onChange={(event) => {addFiles(role, Array.from(event.target.files ?? [])); event.currentTarget.value = '';}} />
                <div className="upload-picker-heading"><span>{uploadRoleLabels[role]}</span><Button size="small" icon={<UploadOutlined />} disabled={uploading || busy} onClick={() => inputRefs.current[role]?.click()}>选择</Button></div>
                {selected[role].length > 0 ? <div className="upload-selected-list">{selected[role].map((file, index) => {
                  const preparedFile = prepareFile(role, file);
                  const remote = session?.files.find((item) => item.role === role && item.filename === preparedFile.name && item.size === preparedFile.size);
                  const percent = remote ? (fileProgress[remote.id] ?? 0) : undefined;
                  const mark = fileStatus(percent);
                  return <div className="upload-selected-file" key={`${file.name}-${file.size}-${index}`}><div className="upload-selected-file-main"><div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}><StatusMark status={mark.status} progress={mark.progress} size={16} /><span title={file.name} style={{fontWeight: 500}}>{file.name}</span><span className="upload-file-state" data-status={mark.status}>{mark.label}</span></div>{percent != null && <Progress percent={percent} size="small" showInfo={false} strokeColor="#2d6a5b" />}</div><Button type="text" size="small" disabled={uploading} onClick={() => removeFile(role, index)}>移除</Button></div>;
                })}</div> : <StatusMark className="upload-empty" status="pending" size={14} fontSize={10} label="尚未选择" />}
              </div>)}
            </div>
            {sbdExtraction && sbdExtraction.source === selected.sbd[0] && <Typography.Paragraph type="secondary">SBD 已在本地提取：{(sbdExtraction.result.stats.sourceBytes / 1024 / 1024).toFixed(1)} MB → {(sbdExtraction.result.file.size / 1024 / 1024).toFixed(1)} MB，仅上传精简数据。</Typography.Paragraph>}
            {checkedImages.length > 0 && <Typography.Paragraph type="secondary">{optimizedImageBytes < originalImageBytes
              ? `图片已无损优化：${(originalImageBytes / 1024 / 1024).toFixed(1)} MB → ${(optimizedImageBytes / 1024 / 1024).toFixed(1)} MB，像素与尺寸保持不变。`
              : '图片检查完成，复用原图上传；已压缩或重压无收益的图片不重复处理。'}</Typography.Paragraph>}
            {session && <Alert type="info" showIcon message="发现可恢复的上传会话" description={legacySbdSession ? '这是旧版完整 SBD 上传。请先点击“取消上传”释放该会话的数据，再重新开始，改用本地精简上传。' : uploadSessionMatches(session, preparedSelection) ? '已匹配本地文件，可以继续上传。' : '请重新选择与上次相同的文件；SBD 会在本地重新提取后匹配上传会话。'} />}
            {(extracting || uploading || uploadedBytes > 0 || (session && uploadStatus)) && <div className="upload-progress-block" role="status">
              <div className="upload-progress-heading">
                <StatusMark status={overallStatus} progress={!extracting && totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : undefined}
                  size={20} label={uploadStatus || '准备上传…'} />
                {!extracting && totalBytes > 0 && <span className="upload-progress-percent">文件已上传 {Math.min(100, Math.round(uploadedBytes / totalBytes * 100))}%</span>}
              </div>
              {!extracting && totalBytes > 0 && <>
                <Progress percent={Math.min(100, Math.round(uploadedBytes / totalBytes * 100))} showInfo={false}
                  status={uploadError ? 'exception' : uploadCompleted ? 'success' : 'normal'} strokeColor="#2d6a5b" />
                <Typography.Text type="secondary">{(uploadedBytes / 1024 / 1024).toFixed(1)} / {(Math.max(totalBytes, selectedTotal) / 1024 / 1024).toFixed(1)} MB</Typography.Text>
              </>}
            </div>}
            <Space wrap className="home-actions">
              <Button type="primary" onClick={startUpload} disabled={!canStart} loading={uploading && !paused && !uploadCompleted}>{uploadCompleted ? '上传完成' : '开始上传并处理'}</Button>
              {uploading && !extracting && session && session.status !== 'assembling' && <Button icon={<PauseOutlined />} onClick={() => {pauseRef.current = !pauseRef.current; setPaused(pauseRef.current);}}>{paused ? '继续上传' : '暂停上传'}</Button>}
              {!uploading && paused && session && <Button icon={<PlayCircleOutlined />} onClick={startUpload}>继续上传</Button>}
              {(extracting || session && session.status !== 'assembling') && <Button danger onClick={cancelUpload}>{extracting ? '取消本地处理' : '取消上传'}</Button>}
              {demoAvailable && <Button onClick={onDemo} disabled={busy || uploading}>载入内置示例</Button>}
            </Space>
            {(error || uploadError) && <Alert type="error" showIcon message="项目请求失败" description={error || uploadError} />}
            <div className="home-notes"><span><SafetyOutlined />来源文件只读</span><span><AimOutlined />自动建立空间坐标</span><span><HistoryOutlined />支持断点续传</span></div>
          </Card>
          <HistoryProjects projects={projects} onOpen={onOpen} onRetry={onRetry} busy={busy} />
        </div>
      </main>
    </Layout>
  );
}
