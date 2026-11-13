export type AppRoute = {kind: 'home'} | {kind: 'project'; id: string};

export type ProjectLike = {id: string; source_dir?: string; project_name?: string; created_at?: string; status: string};
export type ViewLike = {viewport?: Record<string, unknown> | null; settings?: Record<string, unknown>};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseRoute(hash?: string): AppRoute {
  const value = hash ?? (typeof window === 'undefined' ? '' : window.location.hash);
  const match = value.match(/^#\/projects\/([^/]+)$/);
  if (!match) return {kind: 'home'};
  try { return {kind: 'project', id: decodeURIComponent(match[1])}; } catch { return {kind: 'home'}; }
}

export function projectName(project: ProjectLike) {
  if (project.project_name?.trim()) return project.project_name.trim();
  const source = project.source_dir?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return source || `项目 ${project.id.slice(0, 8)}`;
}

export function projectStatusLabel(status: string) {
  if (status === 'ready') return '可复核';
  if (status === 'failed') return '处理失败';
  if (status === 'assembling') return '文件合并中';
  if (status === 'running') return '处理中';
  return '等待处理';
}

export function formatCreatedAt(value?: string) {
  if (!value) return '创建时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '创建时间未知' : date.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

export function selectInitialViewport(session: ViewLike | null | undefined, saved: ViewLike | null | undefined) {
  const sessionViewport = isRecord(session?.viewport) ? session.viewport : undefined;
  const savedViewport = isRecord(saved?.viewport) ? saved.viewport : undefined;
  if (hasViewport(sessionViewport)) return sessionViewport;
  if (hasViewport(savedViewport)) return savedViewport;
  return sessionViewport ?? savedViewport ?? {};
}

export function hasViewport(viewport: Record<string, unknown> | null | undefined) {
  return Boolean(viewport && typeof viewport.x === 'number' && Number.isFinite(viewport.x) && typeof viewport.y === 'number' && Number.isFinite(viewport.y) && typeof viewport.zoom === 'number' && Number.isFinite(viewport.zoom));
}
