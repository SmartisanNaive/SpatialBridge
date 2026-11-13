
export const API = '/api';

export function apiUrl(path: string) {
  return `${API}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || `请求失败（${response.status}）`);
  return payload as T;
}

export function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    'The source directory is required': '请先填写来源目录。',
    'The source directory does not exist': '来源目录不存在，请检查路径后重试。',
    'Project not found': '项目不存在或已被移除，请从项目首页重新选择。',
    'Failed to fetch': '无法连接本地处理服务，请确认后端已启动。',
    'NetworkError when attempting to fetch resource.': '无法连接本地处理服务，请确认后端已启动。',
    'Load failed': '无法连接本地处理服务，请确认后端已启动。',
    'Network request failed': '无法连接本地处理服务，请确认后端已启动。',
    '上传来源清单不可用，请重新上传文件': '上传来源清单不可用，请重新上传文件。',
  };
  return known[value] ?? value;
}
