import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Card, Input, Layout, Progress, Space, Typography} from 'antd';
import {
  CheckCircleOutlined,
  DatabaseOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {formatCreatedAt, projectName, projectStatusLabel} from '../flow';
import {sha256Hex} from '../hash';
import {compressionSupported, gzip, shouldCompress} from '../compress';
import type {CompressionSample} from '../compress';
import type {Project, UploadRole, UploadSession} from '../types';
import {apiUrl, apiFetch, errorText} from '../api';

export const uploadRoleLabels: Record<UploadRole, string> = {
  pre: '采集前显微图（PNG）', after: '采集后显微图（PNG）', sbd: 'SBD 数据（可选）',
  heatmap: 'MALDI 热图（PNG，可多选）',
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
    const storedId = window.localStorage.getItem(uploadSessionStorageKey);
    if (!storedId) return;
    apiFetch<UploadSession>(`/uploads/${encodeURIComponent(storedId)}`).then(async (value) => {
      if (['pending', 'assembling', 'failed'].includes(value.status)) {
        setSession(value);
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
    if (role === 'pre' && !projectNameInput.trim()) setProjectNameInput(accepted[0].name);
  };

  const removeFile = (role: UploadRole, index: number) => setSelected((current) => ({...current, [role]: current[role].filter((_, itemIndex) => itemIndex !== index)}));
  const allSelected = uploadRoles.flatMap((role) => selected[role].map((file) => ({role, file})));
  const selectedTotal = allSelected.reduce((sum, item) => sum + item.file.size, 0);
  const canStart = selected.pre.length === 1 && selected.after.length === 1 && !uploading && !busy;

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
      try { await apiFetch(`/uploads/${encodeURIComponent(current.id)}`, {method: 'DELETE'}); } catch { /* local cleanup still clears the resumable session */ }
    }
    window.localStorage.removeItem(uploadSessionStorageKey);
    setSession(null);
    setUploading(false);
    setPaused(false);
    setUploadStatus('上传已取消。');
    setUploadedBytes(0);
    setFileProgress({});
  };

  const startUpload = async () => {
    if (!canStart) return;
    setUploadError('');
    setUploadStatus('准备上传…');
    cancelRef.current = false;
    pauseRef.current = false;
    setPaused(false);
    setUploading(true);
    try {
      let currentSession = session && uploadSessionMatches(session, selected)
        ? await apiFetch<UploadSession>(`/uploads/${encodeURIComponent(session.id)}`)
        : null;
      if (!currentSession) {
        currentSession = await apiFetch<UploadSession>('/uploads', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({project_name: projectNameInput.trim() || selected.pre[0].name, files: allSelected.map(({role, file}) => ({role, filename: file.name, size: file.size}))}),
        });
        setSession(currentSession);
        setFileProgress(Object.fromEntries(currentSession.files.map((file) => [file.id, file.size ? Math.round(file.uploaded_size / file.size * 100) : 0])));
        window.localStorage.setItem(uploadSessionStorageKey, currentSession.id);
      }
      if (currentSession.status === 'completed' && currentSession.completed_project_id) {
        const project = await apiFetch<Project>(`/projects/${encodeURIComponent(currentSession.completed_project_id)}`);
        window.localStorage.removeItem(uploadSessionStorageKey);
        setSession(null);
        onProject(project);
        return;
      }
      if (['assembling', 'failed'].includes(currentSession.status)) {
        const project = await finishUpload(currentSession.id);
        window.localStorage.removeItem(uploadSessionStorageKey);
        setSession(null);
        setFileProgress({});
        onProject(project);
        return;
      }
      const used = new Set<number>();
      const matchingFiles = currentSession.files.map((remote) => {
        const index = allSelected.findIndex((item, itemIndex) => !used.has(itemIndex) && item.role === remote.role && item.file.name === remote.filename && item.file.size === remote.size);
        if (index < 0) throw new Error(`请重新选择上传文件：${remote.filename}`);
        used.add(index);
        return {remote, local: allSelected[index].file};
      });
      const total = currentSession.files.reduce((sum, file) => sum + file.size, 0);
      let completedBytes = currentSession.files.reduce((sum, file) => sum + file.uploaded_size, 0);
      setTotalBytes(total);
      setUploadedBytes(completedBytes);
      setFileProgress(Object.fromEntries(currentSession.files.map((file) => [file.id, file.size ? Math.round(file.uploaded_size / file.size * 100) : 0])));
      for (const {remote, local} of matchingFiles) {
        const uploaded = new Set(remote.uploaded_chunks);
        // Per-file measurements: PNGs stop being compressed after one
        // attempt, SBD data keeps being compressed while it saves time.
        let compression = null as CompressionSample | null;
        const canCompress = compressionSupported();
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
      setFileProgress({});
      onProject(project);
    } catch (error) {
      if (!cancelRef.current) {
        setPaused(true);
        pauseRef.current = true;
        setUploadError(errorText(error));
        setUploadStatus('本次上传或文件合并未完成，可重新选择相同文件后继续。');
      }
    } finally {
      abortRef.current = null;
      setUploading(false);
    }
  };

  return (
    <Layout className="app project-home-app">
      <header className="home-header">
        <div className="home-brand"><img className="brand-logo small" src="/spatialbridge-logo.png" alt="SpatialBridge logo" /><div><strong>SpatialBridge</strong><span>显微图与 MALDI 空间配准</span></div></div>
        <div className="home-header-meta"><span className="status-dot" />共享项目</div>
      </header>
      <main className="project-home">
        <section className="home-intro">
          <Typography.Text className="eyebrow">PROJECTS / LOCAL WORKSPACE</Typography.Text>
          <Typography.Title>从一个项目开始</Typography.Title>
          <Typography.Paragraph>上传采集前后显微图，生成可复核的空间坐标工作台。</Typography.Paragraph>
          {currentProject && <div className="home-current"><div><span>当前项目 · {projectStatusLabel(currentProject.status)}</span><strong>{projectName(currentProject)}</strong></div><Button size="small" disabled={busy || uploading} onClick={() => onOpen(currentProject)}>继续当前项目</Button></div>}
        </section>
        <div className={`home-grid${projects.length ? '' : ' is-empty'}`}>
          <Card className="home-import-card" variant="borderless">
            <div className="home-card-kicker">新建项目</div>
            <Typography.Title level={3}>上传项目文件</Typography.Title>
            <Typography.Text type="secondary">采集前和采集后 PNG 必填；SBD 和热图可选，两者都提供时会建立 SBD 点位到显微图的坐标映射。文件分片上传，网络中断后可以继续。</Typography.Text>
            <Input aria-label="项目名称" value={projectNameInput} onChange={(event) => setProjectNameInput(event.target.value)} placeholder="项目名称（可选）" disabled={uploading || busy} />
            <div className="upload-file-pickers">
              {uploadRoles.map((role) => <div className="upload-file-picker" key={role}>
                <input ref={(element) => {inputRefs.current[role] = element;}} type="file" accept={uploadRoleExtensions[role].join(',')} multiple={role === 'heatmap'} hidden onChange={(event) => {addFiles(role, Array.from(event.target.files ?? [])); event.currentTarget.value = '';}} />
                <div className="upload-picker-heading"><span>{uploadRoleLabels[role]}</span><Button size="small" icon={<UploadOutlined />} disabled={uploading || busy} onClick={() => inputRefs.current[role]?.click()}>选择</Button></div>
                {selected[role].length > 0 ? <div className="upload-selected-list">{selected[role].map((file, index) => {
                  const remote = session?.files.find((item) => item.role === role && item.filename === file.name && item.size === file.size);
                  const percent = remote ? (fileProgress[remote.id] ?? 0) : undefined;
                  return <div className="upload-selected-file" key={`${file.name}-${file.size}-${index}`}><div className="upload-selected-file-main"><span title={file.name}>{file.name}</span>{percent != null && <Progress percent={percent} size="small" showInfo={false} strokeColor="#2d6a5b" />}</div><Button type="text" size="small" disabled={uploading} onClick={() => removeFile(role, index)}>移除</Button></div>;
                })}</div> : <span className="upload-empty">尚未选择</span>}
              </div>)}
            </div>
            {session && <Alert type="info" showIcon message="发现可恢复的上传会话" description={uploadSessionMatches(session, selected) ? '已匹配本地文件，可以继续上传。' : '请重新选择与上次相同的文件，浏览器刷新后仍可继续。'} />}
            {(uploading || uploadedBytes > 0 || (session && uploadStatus)) && <div className="upload-progress-block"><div className="upload-progress-heading"><span>{uploadStatus || '准备上传…'}</span><span>{totalBytes ? `${Math.round(uploadedBytes / totalBytes * 100)}%` : '—'}</span></div><Progress percent={totalBytes ? Math.min(100, Math.round(uploadedBytes / totalBytes * 100)) : 0} showInfo={false} strokeColor="#2d6a5b" /><Typography.Text type="secondary">{(uploadedBytes / 1024 / 1024).toFixed(1)} / {(Math.max(totalBytes, selectedTotal) / 1024 / 1024).toFixed(1)} MB</Typography.Text></div>}
            <Space wrap className="home-actions">
              <Button type="primary" onClick={startUpload} disabled={!canStart} loading={uploading && !paused}>开始上传并处理</Button>
              {uploading && session?.status !== 'assembling' && <Button icon={<PauseOutlined />} onClick={() => {pauseRef.current = !pauseRef.current; setPaused(pauseRef.current);}}>{paused ? '继续上传' : '暂停上传'}</Button>}
              {!uploading && paused && session && <Button icon={<PlayCircleOutlined />} onClick={startUpload}>继续上传</Button>}
              {session && session.status !== 'assembling' && <Button danger onClick={cancelUpload}>取消上传</Button>}
              {demoAvailable && <Button onClick={onDemo} disabled={busy || uploading}>载入内置示例</Button>}
            </Space>
            {(error || uploadError) && <Alert type="error" showIcon message="项目请求失败" description={error || uploadError} />}
            <div className="home-notes"><span><CheckCircleOutlined />来源文件只读</span><span><CheckCircleOutlined />自动建立空间坐标</span><span><CheckCircleOutlined />支持断点续传</span></div>
          </Card>
          {projects.length > 0 && <Card className="home-recent-card" variant="borderless">
            <div className="home-recent-heading"><div><div className="home-card-kicker">最近项目</div><Typography.Title level={3}>继续工作</Typography.Title></div><span>{projects.length} 个</span></div>
            <div className="project-list">{projects.slice(0, 8).map((item) => <div className="project-list-item" key={item.id}>
              <div className="project-list-icon"><DatabaseOutlined /></div><div className="project-list-main"><strong>{projectName(item)}</strong><span>{formatCreatedAt(item.created_at)} · {projectStatusLabel(item.status)}</span></div>
              {item.status === 'failed' ? <Button size="small" disabled={busy || !item.source_dir} onClick={() => onRetry(item)}>重试</Button> : item.status === 'ready' ? <Space size={4}><Button size="small" type="primary" disabled={busy} onClick={() => onOpen(item)}>打开工作台</Button><Button size="small" type="link" disabled={busy || !item.source_dir} onClick={() => onRetry(item)}>重新处理</Button></Space> : <Button size="small" type="default" disabled={busy} onClick={() => onOpen(item)}>继续处理</Button>}
            </div>)}</div>
          </Card>}
        </div>
      </main>
    </Layout>
  );
}
