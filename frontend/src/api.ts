
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

export function errorText(error: unknown, lang: 'zh' | 'en' = 'zh') {
  const value = error instanceof Error ? error.message : String(error);
  if (lang === 'en') {
    const knownEn: Record<string, string> = {
      'The source directory is required': 'Please specify the data directory.',
      'The source directory does not exist': 'The specified directory does not exist. Please check the path.',
      'Project not found': 'Project not found or has been deleted. Please return to home.',
      'Failed to fetch': 'Cannot connect to backend service. Please ensure the server is running.',
      'NetworkError when attempting to fetch resource.': 'Cannot connect to backend service. Please ensure the server is running.',
      'Load failed': 'Cannot connect to backend service. Please ensure the server is running.',
      'Network request failed': 'Cannot connect to backend service. Please ensure the server is running.',
      '上传来源清单不可用，请重新上传文件': 'Upload session expired. Please reselect files to upload.',
    };
    return knownEn[value] ?? value;
  }
  const known: Record<string, string> = {
    'The source directory is required': '请填写数据所在目录。',
    'The source directory does not exist': '指定的目录不存在，请检查路径。',
    'Project not found': '项目不存在或已被删除，请返回首页重新选择。',
    'Failed to fetch': '无法连接后端服务，请确认服务已启动。',
    'NetworkError when attempting to fetch resource.': '无法连接后端服务，请确认服务已启动。',
    'Load failed': '无法连接后端服务，请确认服务已启动。',
    'Network request failed': '无法连接后端服务，请确认服务已启动。',
    '上传来源清单不可用，请重新上传文件': '上传文件信息失效，请重新选择文件上传。',
  };
  return known[value] ?? value;
}
