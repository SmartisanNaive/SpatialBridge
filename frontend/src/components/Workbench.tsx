import GlassSurface from './GlassSurface';
import './Workbench.css';
import React, {useEffect, useRef, useState} from 'react';
import {AnimatePresence, LayoutGroup, motion} from 'motion/react';
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Dropdown,
  Input,
  Spin,
  Slider,
  Switch,
  Tooltip,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AimOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CompressOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  SaveOutlined,
  SettingOutlined,
  SlidersOutlined,
  SwapOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {hasViewport, projectName, selectInitialViewport} from '../flow';
import type {
  Project,
  Viewport,
  WorkspaceSettings,
  SavedViewResponse,
  ViewLayer,
  ViewMode,
  ManualPoint,
  GridPoint,
  SpotOverlayResponse,
  NearestSpot,
  HeatmapInfo,
  HeatmapColors,
} from '../types';
import {apiUrl, apiFetch, errorText} from '../api';
import {
  heatmapOrientation,
  spotNumber,
  sanitizeManualPoints,
  manualPointsFromView,
  methodLabel,
  limitationLabel,
} from '../utils';
import {CanvasViewer} from './CanvasViewer';

export function ToolButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <Tooltip title={shortcut ? `${label} · ${shortcut}` : label} placement="top">
      <button type="button" className={`tool-button${active ? ' is-active' : ''}`} onClick={onClick} disabled={disabled}>
        <span className="tool-button-icon">{icon}</span>
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}

export function Workbench({project, onHome}: {project: Project; onHome: () => void}) {
  const [layer, setLayer] = useState<ViewLayer>('pre');
  const [viewport, setViewport] = useState<Viewport>({});
  const [pixelsPerImagePixel, setPixelsPerImagePixel] = useState(0);
  const [viewerInitial, setViewerInitial] = useState<Viewport>();
  const [viewLoaded, setViewLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gridPoints, setGridPoints] = useState<GridPoint[]>([]);
  const [gridSampled, setGridSampled] = useState(false);
  const [autoPitTotal, setAutoPitTotal] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState<NearestSpot | null>(null);
  const [spotLoading, setSpotLoading] = useState(false);
  const [manualPoints, setManualPoints] = useState<ManualPoint[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 680);
  const [reportOpen, setReportOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPits, setShowPits] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(86);
  const [heatmap, setHeatmap] = useState<HeatmapInfo | null>(null);
  const [heatmapColors, setHeatmapColors] = useState<HeatmapColors>(() => new Map());
  const [heatmapFile, setHeatmapFile] = useState<File | null>(null);
  const [heatmapLabel, setHeatmapLabel] = useState('');
  const [heatmapError, setHeatmapError] = useState('');
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapUploading, setHeatmapUploading] = useState(false);
  const [heatmapVersion, setHeatmapVersion] = useState(0);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [heatmapOpacity, setHeatmapOpacity] = useState(75);
  const heatmapUploadToken = useRef(0);
  const [mode, setMode] = useState<ViewMode>('single');
  const [comparePosition, setComparePosition] = useState(50);
  const [swapLayers, setSwapLayers] = useState(false);
  const [lensSize, setLensSize] = useState(220);
  const [lensOverlap, setLensOverlap] = useState(90);
  const [lensFixed, setLensFixed] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const viewportRef = useRef<Viewport>({});
  const savedViewportRef = useRef<Viewport | null>(null);
  const savedSettingsRef = useRef<Partial<WorkspaceSettings>>({});
  const sessionHydratedRef = useRef(false);
  const sessionPersistRef = useRef<(() => void) | null>(null);
  const spotRequestRef = useRef(0);
  const sessionKey = `spatialbridge:session:${project.id}`;
  const [messageApi, holder] = message.useMessage();
  const report = project.report;
  const mapping = report?.spatial_mapping;
  const maldiAvailable = Boolean(mapping?.available && mapping.spot_cache);
  const valueFields = mapping?.value_fields?.length ? mapping.value_fields : (report?.maldi_data?.value_fields ?? []);
  const selectedFieldKey = valueFields[0]?.key ?? '';

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      const action = key === '+' || key === '=' ? 'spatialbridge-zoom-in'
        : key === '-' || key === '_' ? 'spatialbridge-zoom-out'
          : key === 'h' ? 'spatialbridge-fit'
            : key === 'l' ? 'spatialbridge-locate'
              : key === 'r' ? 'spatialbridge-restore' : null;
      if (!action) return;
      event.preventDefault();
      window.dispatchEvent(new Event(action));
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => () => {
    // A point lookup can outlive the project route. Incrementing the token
    // prevents its response from reopening a detail panel for a stale view.
    spotRequestRef.current += 1;
  }, []);


  useEffect(() => {
    const available = Boolean(project?.status === 'ready' && maldiAvailable);
    setAutoPitTotal(mapping?.detected_pit_count ?? 0);
    if (!available) {
      setGridPoints([]);
      setGridSampled(false);
      return;
    }
    let active = true;
    apiFetch<SpotOverlayResponse>(`/projects/${project!.id}/spots/overlay?mapped=true&raster=${mapping?.primary_raster ?? 0}`)
      .then((result) => {
        if (!active) return;
        setGridPoints(result.items);
        setGridSampled(result.sampled);
        setAutoPitTotal(result.detected_total);
      })
      .catch((error) => {
        if (active) messageApi.error(`灼烧坑显示失败：${errorText(error)}`);
      });
    return () => { active = false; };
  }, [maldiAvailable, mapping?.detected_pit_count, mapping?.primary_raster, messageApi, project?.id, project?.status]);

  useEffect(() => {
    heatmapUploadToken.current += 1;
    setHeatmapFile(null);
    setHeatmapLabel('');
    setHeatmapUploading(false);
    return () => { heatmapUploadToken.current += 1; };
  }, [project.id]);

  useEffect(() => {
    let active = true;
    setHeatmap(null);
    setHeatmapColors(new Map());
    setHeatmapError('');
    if (project.status !== 'ready') {
      setHeatmapLoading(false);
      return () => { active = false; };
    }
    setHeatmapLoading(true);
    const path = `/projects/${encodeURIComponent(project.id)}/heatmap`;
    apiFetch<HeatmapInfo>(path).then(async (info) => {
      if (!active) return;
      setHeatmap(info);
      if (!info.available) return;
      const response = await apiFetch<{items: Array<[number, number, number, number]>}>(`${path}/colors?raster=${encodeURIComponent(mapping?.primary_raster ?? 0)}`);
      if (!active) return;
      const colors: HeatmapColors = new Map();
      for (const [id, r, g, b] of response.items) {
        if ([id, r, g, b].every(Number.isFinite) && [r, g, b].every((value) => value >= 0 && value <= 255)) {
          colors.set(id, `rgb(${r}, ${g}, ${b})`);
        }
      }
      setHeatmapColors(colors);
    }).catch((error) => {
      if (active) setHeatmapError(`热图读取失败：${errorText(error)}`);
    }).finally(() => { if (active) setHeatmapLoading(false); });
    return () => { active = false; };
  }, [project.id, project.status, mapping?.primary_raster, heatmapVersion]);

  const uploadHeatmap = async () => {
    if (!heatmapFile || heatmapUploading) return;
    if (heatmapFile.type !== 'image/png' && !/\.png$/i.test(heatmapFile.name)) {
      setHeatmapError('请选择 PNG 图片。');
      return;
    }
    const token = ++heatmapUploadToken.current;
    setHeatmapUploading(true);
    setHeatmapError('');
    const data = new FormData();
    data.append('file', heatmapFile);
    if (heatmapLabel.trim()) data.append('label', heatmapLabel.trim());
    try {
      await apiFetch(`/projects/${encodeURIComponent(project.id)}/heatmap`, {method: 'POST', body: data});
      if (token !== heatmapUploadToken.current) return;
      setHeatmapFile(null);
      setShowHeatmap(true);
      setHeatmapVersion((version) => version + 1);
    } catch (error) {
      if (token === heatmapUploadToken.current) setHeatmapError(`热图配准失败：${errorText(error)}`);
    } finally {
      if (token === heatmapUploadToken.current) setHeatmapUploading(false);
    }
  };

  useEffect(() => {
    if (project.status !== 'ready') {
      setViewLoaded(false);
      setSelectedSpot(null);
      setSpotLoading(false);
      return;
    }
    let active = true;
    let sessionRaw: string | null = null;
    try { sessionRaw = window.sessionStorage.getItem(sessionKey); } catch { sessionRaw = null; }
    let session: {viewport?: Viewport; settings?: Partial<WorkspaceSettings>} | null = null;
    try { session = sessionRaw ? JSON.parse(sessionRaw) : null; } catch { session = null; }
    apiFetch<SavedViewResponse>(`/projects/${project.id}/view`)
      .then((saved) => {
        if (!active) return;
        const next = selectInitialViewport(session, saved) as Viewport;
        const settings = {...(saved.settings ?? {}), ...(session?.settings ?? {})};
        const nextLayer: ViewLayer = settings.layer === 'after' || settings.layer === 'pre'
          ? settings.layer
          : next.layer === 'after' ? 'after' : 'pre';
        const durableManualPoints = manualPointsFromView(saved);
        const durableViewport = saved.viewport ? {...saved.viewport, manualPoints: durableManualPoints} : null;
        savedViewportRef.current = durableViewport;
        savedSettingsRef.current = saved.settings ?? {};
        setManualPoints(durableManualPoints);
        viewportRef.current = next;
        setViewport(next);
        setViewerInitial({...next, layer: nextLayer});
        setLayer(nextLayer);
        if (settings.mode === 'single' || settings.mode === 'compare' || settings.mode === 'lens') setMode(settings.mode);
        if (typeof settings.swapLayers === 'boolean') setSwapLayers(settings.swapLayers);
        if (typeof settings.comparePosition === 'number') setComparePosition(settings.comparePosition);
        if (typeof settings.lensSize === 'number') setLensSize(settings.lensSize);
        if (typeof settings.lensOverlap === 'number') setLensOverlap(settings.lensOverlap);
        if (typeof settings.lensFixed === 'boolean') setLensFixed(settings.lensFixed);
        if (typeof settings.showGrid === 'boolean') setShowGrid(settings.showGrid);
        if (typeof settings.showPits === 'boolean') setShowPits(settings.showPits);
        if (typeof settings.overlayOpacity === 'number') setOverlayOpacity(settings.overlayOpacity);
        if (typeof settings.sidebarOpen === 'boolean') setSidebarOpen(settings.sidebarOpen);
        if (typeof settings.reducedMotion === 'boolean') setReducedMotion(settings.reducedMotion);
        sessionHydratedRef.current = true;
        setSelectedSpot(null);
      })
      .catch(() => {
        if (!active) return;
        savedViewportRef.current = null;
        savedSettingsRef.current = {};
        setManualPoints([]);
        // If the service is temporarily unavailable, keep the tab-local
        // session usable instead of replacing it with a blank full view.
        const next = selectInitialViewport(session, null) as Viewport;
        const settings = session?.settings ?? {};
        const nextLayer: ViewLayer = settings.layer === 'after' || settings.layer === 'pre'
          ? settings.layer
          : next.layer === 'after' ? 'after' : 'pre';
        viewportRef.current = next;
        setViewport(next);
        setViewerInitial({...next, layer: nextLayer});
        setLayer(nextLayer);
        if (settings.mode === 'single' || settings.mode === 'compare' || settings.mode === 'lens') setMode(settings.mode);
        if (typeof settings.swapLayers === 'boolean') setSwapLayers(settings.swapLayers);
        if (typeof settings.comparePosition === 'number') setComparePosition(settings.comparePosition);
        if (typeof settings.lensSize === 'number') setLensSize(settings.lensSize);
        if (typeof settings.lensOverlap === 'number') setLensOverlap(settings.lensOverlap);
        if (typeof settings.lensFixed === 'boolean') setLensFixed(settings.lensFixed);
        if (typeof settings.showGrid === 'boolean') setShowGrid(settings.showGrid);
        if (typeof settings.showPits === 'boolean') setShowPits(settings.showPits);
        if (typeof settings.overlayOpacity === 'number') setOverlayOpacity(settings.overlayOpacity);
        if (typeof settings.sidebarOpen === 'boolean') setSidebarOpen(settings.sidebarOpen);
        if (typeof settings.reducedMotion === 'boolean') setReducedMotion(settings.reducedMotion);
        sessionHydratedRef.current = true;
        setSelectedSpot(null);
        messageApi.warning(next.x != null ? '未能读取服务器保存视野，已恢复当前标签页会话' : '未能读取已保存视野，已使用全图打开项目');
      })
      .finally(() => { if (active) setViewLoaded(true); });
    return () => { active = false; sessionHydratedRef.current = false; };
  }, [messageApi, project.id, project.status, sessionKey]);

  const updateViewport = (next: Viewport) => {
    viewportRef.current = next;
    setViewport(next);
  };

  const preSource = report?.sources.find((source) => source.key === 'pre');
  const afterSource = report?.sources.find((source) => source.key === 'after');
  const compare = mode === 'compare';
  const lens = mode === 'lens';
  const primaryLayerForMode = (modeValue: ViewMode, swapped: boolean): ViewLayer => {
    if (modeValue === 'lens') return swapped ? 'pre' : 'after';
    return swapped ? 'after' : 'pre';
  };
  const currentLayer: ViewLayer = mode === 'single' ? layer : primaryLayerForMode(mode, swapLayers);
  const compareLayer: ViewLayer = currentLayer === 'pre' ? 'after' : 'pre';
  const lensLayer: ViewLayer = currentLayer === 'pre' ? 'after' : 'pre';

  useEffect(() => {
    if (!sessionHydratedRef.current) return;
    const settings: WorkspaceSettings = {
      version: 2,
      layer: currentLayer,
      mode,
      swapLayers,
      comparePosition,
      lensSize,
      lensOverlap,
      lensFixed,
      showGrid,
      showPits,
      overlayOpacity,
      sidebarOpen,
      reducedMotion,
    };
    const persist = () => {
      try {
        window.sessionStorage.setItem(sessionKey, JSON.stringify({version: 2, viewport: viewportRef.current, settings}));
      } catch {
        // Session storage is optional; the server saved view remains available.
      }
    };
    sessionPersistRef.current = persist;
    const timer = window.setTimeout(persist, 250);
    window.addEventListener('pagehide', persist);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', persist);
    };
  }, [comparePosition, currentLayer, lensFixed, lensOverlap, lensSize, mode, overlayOpacity, reducedMotion, sessionKey, showGrid, showPits, sidebarOpen, swapLayers, viewport]);

  useEffect(() => () => {
    sessionPersistRef.current?.();
    sessionPersistRef.current = null;
  }, [sessionKey]);

  if (!report || !preSource || !afterSource) return <>{holder}<div className="canvas-empty">该项目缺少可用的显微图配准结果。</div></>;

  const hasSavedView = hasViewport(savedViewportRef.current);
  const restoreSavedView = () => {
    const saved = savedViewportRef.current;
    if (!saved) return;
    const settings = savedSettingsRef.current;
    const nextLayer: ViewLayer = settings.layer === 'after' || settings.layer === 'pre'
      ? settings.layer
      : saved.layer === 'after' ? 'after' : 'pre';
    setViewport({...saved, layer: nextLayer});
    viewportRef.current = {...saved, layer: nextLayer};
    setLayer(nextLayer);
    setManualPoints(sanitizeManualPoints(saved.manualPoints));
    if (settings.mode === 'single' || settings.mode === 'compare' || settings.mode === 'lens') setMode(settings.mode);
    if (typeof settings.swapLayers === 'boolean') setSwapLayers(settings.swapLayers);
    if (typeof settings.comparePosition === 'number') setComparePosition(settings.comparePosition);
    if (typeof settings.lensSize === 'number') setLensSize(settings.lensSize);
    if (typeof settings.lensOverlap === 'number') setLensOverlap(settings.lensOverlap);
    if (typeof settings.lensFixed === 'boolean') setLensFixed(settings.lensFixed);
    if (typeof settings.showGrid === 'boolean') setShowGrid(settings.showGrid);
    if (typeof settings.showPits === 'boolean') setShowPits(settings.showPits);
    if (typeof settings.overlayOpacity === 'number') setOverlayOpacity(settings.overlayOpacity);
    if (typeof settings.sidebarOpen === 'boolean') setSidebarOpen(settings.sidebarOpen);
    if (typeof settings.reducedMotion === 'boolean') setReducedMotion(settings.reducedMotion);
    setViewerInitial({...saved, layer: nextLayer});
    // The viewer already has the durable checkpoint in its ref. Dispatch
    // synchronously so a route change cannot deliver a generic event to the
    // next project's canvas.
    window.dispatchEvent(new Event('spatialbridge-restore'));
  };
  const activeSource = currentLayer === 'after' ? afterSource : preSource;
  const activeRegistration = report.registrations.find((item) => item.source_key === currentLayer) ?? report.registrations[0];
  if (!activeRegistration) return <>{holder}<div className="canvas-empty">该项目缺少可用的配准结果。</div></>;
  const pitDetection = mapping?.metrics?.pit_detection;
  const chainP95 = mapping?.coordinate_validation?.world_chain_pre_vs_after_px?.p95_px;
  const opticalP95 = mapping?.metrics?.lattice_matching?.optical_validation?.candidates?.find(
    (item) => item.degree === mapping?.metrics?.lattice_matching?.optical_validation?.selected_degree,
  )?.validation?.p95_px;
  const cornerMedian = activeRegistration.metric.corner_median_px;
  const artifact = report.validation_artifacts?.find((item) => item.includes('pre_after_overlay'));
  const pitArtifact = report.validation_artifacts?.find((item) => item.includes('after_burn_pits_overlay'));
  const regionArtifact = report.validation_artifacts?.find((item) => item.includes('lattice_fixed_regions'));
  const dispatchCanvasEvent = (name: string) => window.dispatchEvent(new Event(name));
  const chooseLayer = (choice: ViewLayer) => {
    spotRequestRef.current += 1;
    if (mode !== 'single') setMode('single');
    setLayer(choice);
    setSpotLoading(false);
    setSelectedSpot(null);
  };
  const chooseMode = (nextMode: ViewMode) => {
    spotRequestRef.current += 1;
    const nextLayer = nextMode === 'single' ? currentLayer : primaryLayerForMode(nextMode, swapLayers);
    setMode(nextMode);
    setLayer(nextLayer);
    setSpotLoading(false);
    setSelectedSpot(null);
  };
  const toggleComparisonLayers = () => {
    const next = !swapLayers;
    // Role exchange is rendered by the two persistent image layers. Keep the
    // single-mode selection and restore checkpoint untouched while the
    // compare/lens roles change, so swapping never nudges or rebuilds the view.
    setSwapLayers(next);
  };
  const handleSpotSelect = async (point: {x: number; y: number; layer: string}) => {
    if (!maldiAvailable) {
      messageApi.info('当前来源没有可用的 SBD 点位缓存');
      return;
    }
    const requestId = spotRequestRef.current + 1;
    spotRequestRef.current = requestId;
    setSelectedSpot(null);
    setSpotLoading(true);
    try {
      const fieldQuery = selectedFieldKey ? `&field=${encodeURIComponent(selectedFieldKey)}` : '';
      const match = await apiFetch<NearestSpot>(
        `/projects/${project.id}/spots/nearest?x=${encodeURIComponent(point.x)}&y=${encodeURIComponent(point.y)}&layer=${encodeURIComponent(point.layer)}&detected_only=false&max_distance=45${fieldQuery}`,
      );
      if (requestId !== spotRequestRef.current) return;
      if (!match.found) {
        messageApi.info(match.reason ?? '点击位置附近没有对应的 SBD 点');
        return;
      }
      setSelectedSpot(match);
      if (Number.isFinite(match.pre_x) && Number.isFinite(match.pre_y)) {
        window.dispatchEvent(new CustomEvent('spatialbridge-focus-spot', {detail: {x: match.pre_x, y: match.pre_y}}));
      }
    } catch (error) {
      if (requestId !== spotRequestRef.current) return;
      messageApi.error(`读取 MALDI 点失败：${errorText(error)}`);
    } finally {
      if (requestId === spotRequestRef.current) setSpotLoading(false);
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      const settings: WorkspaceSettings = {
        version: 2,
        layer: currentLayer,
        mode,
        swapLayers,
        comparePosition,
        lensSize,
        lensOverlap,
        lensFixed,
        showGrid,
        showPits,
        overlayOpacity,
        sidebarOpen,
        reducedMotion,
      };
      const savedViewport = {...viewport, layer: currentLayer, manualPoints};
      await apiFetch(`/projects/${project.id}/view`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({version: 2, viewport: savedViewport, settings}),
      });
      savedViewportRef.current = savedViewport;
      savedSettingsRef.current = settings;
      setViewerInitial(savedViewport);
      setSaveConfirmed(true);
      window.setTimeout(() => setSaveConfirmed(false), 1800);
    } catch (error) {
      messageApi.error(`保存失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const footprintWorld = pitDetection?.spot_size_world?.[0];
  const footprintPixels = pitDetection?.spot_size_pre_px?.[0];
  const reliableScale = maldiAvailable && mapping?.status === 'calibrated' &&
    Number.isFinite(footprintWorld) && Number(footprintWorld) > 0 &&
    Number.isFinite(footprintPixels) && Number(footprintPixels) > 0 &&
    Number.isFinite(pixelsPerImagePixel) && pixelsPerImagePixel > 0;
  const pixelsPerMicron = reliableScale
    ? Number(footprintPixels) * pixelsPerImagePixel / Number(footprintWorld)
    : 0;
  const readableDistances = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const scaleDistance = reliableScale
    ? readableDistances.find((distance) => distance * pixelsPerMicron >= 42 && distance * pixelsPerMicron <= 120)
      ?? readableDistances.reduce((closest, distance) => Math.abs(distance * pixelsPerMicron - 78) < Math.abs(closest * pixelsPerMicron - 78) ? distance : closest, 20)
    : 0;
  const scaleBarWidth = scaleDistance > 0 ? Math.max(24, Math.min(120, scaleDistance * pixelsPerMicron)) : 28;
  const scaleLabel = scaleDistance >= 1000 ? `${(scaleDistance / 1000).toFixed(scaleDistance % 1000 ? 1 : 0)} mm` : `${scaleDistance} μm`;
  const scaleText = reliableScale && scaleDistance > 0 ? `${scaleLabel} · 图上约 ${scaleBarWidth.toFixed(1)} px` : '比例尺不可用';
  const rasterText = mapping?.primary_raster == null ? 'Raster —' : `Raster ${mapping.primary_raster}`;
  const coordinateText = viewport.imageX == null || viewport.imageY == null
    ? '坐标 —'
    : `坐标 ${Math.round(viewport.imageX).toLocaleString()}, ${Math.round(viewport.imageY).toLocaleString()} px`;
  const projectLabel = projectName(project);
  const mappingSuccess = mapping?.status === 'calibrated';

  return (
    <>
    {holder}
    <div className={`workspace-app redesigned-workspace${sidebarOpen ? '' : ' sidebar-collapsed'}${reducedMotion ? ' motion-reduced' : ''}`}>
      <header className="workspace-header">
        <div className="workspace-brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="/spatialbridge-logo.png" alt="" />
          </div>
          <div>
            <div className="workspace-title">SpatialBridge</div>
            <div className="workspace-subtitle"><DatabaseOutlined /> {projectLabel} <span>·</span> {project.id.slice(0, 8)}</div>
          </div>
        </div>
        <div className="workspace-flow">
          <button type="button" className="workspace-back" onClick={onHome}>
            <FolderOpenOutlined /> <span>项目首页</span>
          </button>
          <span className="workspace-route-separator" aria-hidden="true">/</span>
          <span className="workspace-route-label">数据工作台</span>
        </div>
        <div className="header-observation">
        <LayoutGroup id="observation-controls">
          <div className="observation-controls">
          <nav className="view-tabs mode-tabs" aria-label="观察模式" role="tablist">
            {([
              ['single', '单图', '选择采集前或采集后'],
              ['compare', '卷帘', '同步视口，拖动分界线'],
              ['lens', '透镜', '同坐标局部放大对比'],
            ] as Array<[ViewMode, string, string]>).map(([value, label, hint]) => (
              <Tooltip title={hint} key={value}>
                <button type="button" role="tab" aria-selected={mode === value} className={mode === value ? 'is-active' : ''} onClick={() => chooseMode(value)}>
                  {mode === value && <motion.span className="tab-selection" layoutId="observation-mode-selection" transition={{duration: reducedMotion ? 0 : .18}} />}
                  <span className="tab-label">{label}</span>
                </button>
              </Tooltip>
            ))}
          </nav>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              className={`mode-operations mode-operations-${mode}`}
              key={mode}
              initial={{opacity: 0, y: -3}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: 3}}
              transition={{duration: reducedMotion ? 0 : .16}}
            >
              {mode === 'single' && (
                <div className="mode-operations-panel mode-layer-switch" role="group" aria-label="单图图层">
                  {(['pre', 'after'] as ViewLayer[]).map((value) => (
                    <button type="button" className={`mode-layer-option${currentLayer === value ? ' is-active' : ''}`} aria-pressed={currentLayer === value} key={value} onClick={() => chooseLayer(value)}>
                      {currentLayer === value && <motion.span className="tab-selection" layoutId="single-layer-selection" transition={{duration: reducedMotion ? 0 : .18}} />}
                      <span className="tab-label">{value === 'pre' ? '采集前' : '采集后'}</span>
                    </button>
                  ))}
                </div>
              )}
              {mode === 'compare' && (
                <div className="mode-operations-panel" role="group" aria-label="卷帘图像与操作">
                  <div className="mode-role-pair" aria-label={`左侧${currentLayer === 'pre' ? '采集前' : '采集后'}，右侧${compareLayer === 'pre' ? '采集前' : '采集后'}`}>
                    <span className="mode-role"><small>左</small><strong>{currentLayer === 'pre' ? '采集前' : '采集后'}</strong></span>
                    <span className="mode-role-divider" aria-hidden="true">／</span>
                    <span className="mode-role"><small>右</small><strong>{compareLayer === 'pre' ? '采集前' : '采集后'}</strong></span>
                  </div>
                  <button type="button" className={`mode-action${swapLayers ? ' is-active' : ''}`} onClick={toggleComparisonLayers} aria-label="交换左右图像"><SwapOutlined /><span>交换左右</span></button>
                  <button type="button" className="mode-action" onClick={() => setComparePosition(50)} aria-label="复位分界线"><span aria-hidden="true">↔</span><span>复位分界</span></button>
                  <span className="mode-readout" aria-live="polite">{Math.round(comparePosition)}%</span>
                </div>
              )}
              {mode === 'lens' && (
                <div className="mode-operations-panel" role="group" aria-label="透镜图像与操作">
                  <div className="mode-role-pair" aria-label={`外部${currentLayer === 'pre' ? '采集前' : '采集后'}，内部${lensLayer === 'pre' ? '采集前' : '采集后'}`}>
                    <span className="mode-role"><small>外</small><strong>{currentLayer === 'pre' ? '采集前' : '采集后'}</strong></span>
                    <span className="mode-role-divider" aria-hidden="true">／</span>
                    <span className="mode-role"><small>内</small><strong>{lensLayer === 'pre' ? '采集前' : '采集后'}</strong></span>
                  </div>
                  <button type="button" className={`mode-action${swapLayers ? ' is-active' : ''}`} onClick={toggleComparisonLayers} aria-label="交换内外图像"><SwapOutlined /><span>交换内外</span></button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          </div>
        </LayoutGroup>
        </div>
        <div className="header-actions">
          {!mappingSuccess && <div className="header-result is-warning">
            <SettingOutlined />
            <span>{mapping?.available ? '需复核' : '图像已就绪'}</span>
          </div>}
          <Button type="text" icon={<FileSearchOutlined />} onClick={() => setReportOpen(true)}>配准报告</Button>
          <Tooltip title={maldiAvailable ? '导出已确认灼烧坑及对应 normalization 数值' : '当前项目没有可用 MALDI/SBD 数据'}>
            <Button type="text" icon={<DownloadOutlined />} disabled={!maldiAvailable} href={maldiAvailable ? `${apiUrl(`/projects/${project.id}/burn-pits.csv`)}${selectedFieldKey ? `?field=${encodeURIComponent(selectedFieldKey)}` : ''}` : undefined} target="_blank">导出灼烧坑 CSV</Button>
          </Tooltip>
          <Button className={saveConfirmed ? 'save-confirmed' : ''} type="primary" icon={saveConfirmed ? <CheckCircleFilled /> : <SaveOutlined />} loading={saving} onClick={save}>{saveConfirmed ? '已保存' : '保存视野'}</Button>
          <Dropdown
            className="mobile-actions"
            menu={{items: [
              {key: 'report', label: '打开配准报告'},
              {key: 'export', label: '导出灼烧坑 CSV', disabled: !maldiAvailable},
              {key: 'home', label: '返回项目首页'},
            ], onClick: ({key}) => {
              if (key === 'report') setReportOpen(true);
              if (key === 'export' && maldiAvailable) window.open(`${apiUrl(`/projects/${project.id}/burn-pits.csv`)}${selectedFieldKey ? `?field=${encodeURIComponent(selectedFieldKey)}` : ''}`, '_blank');
              if (key === 'home') { spotRequestRef.current += 1; setSelectedSpot(null); setSpotLoading(false); onHome(); }
            }}}
          >
            <Button aria-label="更多操作" icon={<MoreOutlined />} />
          </Dropdown>
          <Tooltip title="返回项目首页"><Button className="home-nav-button" aria-label="返回项目首页" icon={<FolderOpenOutlined />} onClick={() => {spotRequestRef.current += 1; setSelectedSpot(null); setSpotLoading(false); onHome();}} /></Tooltip>
        </div>
      </header>

      <div className="workspace-body">
        <aside className={`control-sidebar${sidebarOpen ? '' : ' is-hidden'}`} aria-label="图层与分析控制">
          <div className="sidebar-scroll">
            <div className="sidebar-heading">
              <h2>观察与叠加</h2>
              <Tooltip title="收起控制栏"><button type="button" className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起控制栏"><MenuFoldOutlined /></button></Tooltip>
            </div>
            <section className="control-section project-summary">
              <div className="section-heading"><span>项目摘要</span><span className="section-meta">只读</span></div>
              <div className="summary-row"><span>来源</span><strong title={projectLabel}>{projectLabel}</strong></div>
              {!mappingSuccess && <div className="summary-row"><span>映射状态</span><strong className="summary-muted">{mapping?.available ? '需复核' : report?.maldi_data?.available ? 'SBD 已读取，尚未定位' : '无 MALDI 数据'}</strong></div>}
              <div className="summary-row"><span>SBD 采样点</span><strong>{report?.maldi_data?.spot_count?.toLocaleString() ?? '—'}</strong></div>
              <div className="summary-row"><span>已映射点</span><strong>{mapping?.mapped_spot_count?.toLocaleString() ?? '—'}</strong></div>
            </section>
            <AnimatePresence initial={false} mode="wait">
              {mode === 'lens' && (
                <motion.section
                  className="control-section mode-settings"
                  key="lens-settings"
                  initial={{opacity: 0, height: 0, y: -4}}
                  animate={{opacity: 1, height: 'auto', y: 0}}
                  exit={{opacity: 0, height: 0, y: -4}}
                  transition={{duration: reducedMotion ? 0 : .18}}
                >
                  <div className="section-heading"><span>透镜设置</span><span className="section-meta">当前模式</span></div>
                  <div className="parameter-block lens-setting-block">
                    <div className="parameter-label"><span>窗口大小</span><span className="parameter-value">{lensSize} px</span></div>
                    <input className="sidebar-range" aria-label="透镜窗口大小" type="range" min="150" max="340" step="10" value={lensSize} onChange={(event) => setLensSize(Number(event.target.value))} />
                  </div>
                  <div className="parameter-block lens-setting-block">
                    <div className="parameter-label"><span>内外重叠度</span><span className="parameter-value">{lensOverlap}%</span></div>
                    <input className="sidebar-range" aria-label="透镜内外重叠度" type="range" min="0" max="100" step="5" value={lensOverlap} onChange={(event) => setLensOverlap(Number(event.target.value))} />
                  </div>
                  <div className="switch-row"><span><AimOutlined /> 固定透镜位置</span><Switch size="small" checked={lensFixed} onChange={setLensFixed} /></div>
                </motion.section>
              )}
            </AnimatePresence>

            <section className="control-section">
              <div className="section-heading"><span>叠加与参数</span></div>
              <div className="switch-row"><span><EyeOutlined /> 采样网格</span><Switch size="small" checked={showGrid} onChange={setShowGrid} /></div>
              <div className="switch-row"><span><AimOutlined /> 灼烧坑标记 <em>{autoPitTotal.toLocaleString()}</em></span><Switch size="small" checked={showPits} onChange={setShowPits} disabled={!maldiAvailable} /></div>
              <div className="parameter-block opacity-block"><div className="parameter-label"><span>叠加透明度</span><span className="parameter-value">{overlayOpacity}%</span></div><Slider min={0} max={100} value={overlayOpacity} onChange={setOverlayOpacity} tooltip={{formatter: (value) => `${value}%`}} /></div>
              {!maldiAvailable && <div className="sidebar-empty-note">{report?.maldi_data?.available
                ? `SBD 已读取，但尚未建立显微图坐标对应关系，暂时无法显示光斑标记与导出 CSV。${mapping?.reason ?? ''}`
                : '当前未读取 MALDI/SBD 数据，无法显示光斑标记与导出 CSV。'}</div>}
            </section>

            <section className="control-section">
              <div className="section-heading"><span>MALDI 热图</span></div>
              {heatmapUploading ? <div className="sidebar-empty-note">正在上传并进行空间配准…</div> : heatmapLoading ? <div className="sidebar-empty-note">正在载入热图…</div> : heatmap?.available ? (
                <div className="sidebar-empty-note">
                  {heatmap.label || heatmap.filename || 'PNG 热图'}
                </div>
              ) : <div className="sidebar-empty-note">{heatmap?.warning || '暂未导入热图，可按需添加。'}</div>}
              {heatmapError && <Alert type="error" showIcon message={heatmapError} />}
              {heatmap?.available && <>
                <div className="switch-row"><span><EyeOutlined /> 显示热图</span><Switch size="small" checked={showHeatmap} onChange={setShowHeatmap} disabled={!heatmapColors.size} /></div>
                <div className="parameter-block opacity-block"><div className="parameter-label"><span>热图透明度</span><span className="parameter-value">{heatmapOpacity}%</span></div><Slider min={0} max={100} value={heatmapOpacity} onChange={setHeatmapOpacity} tooltip={{formatter: (value) => `${value}%`}} /></div>
              </>}
              <Collapse className="sidebar-collapse" ghost items={[{
                key: 'upload',
                label: heatmap?.available ? '更换热图' : '添加热图（可选）',
                children: <>
                  <label className={`heatmap-file-picker${heatmapUploading ? ' is-disabled' : ''}`}>
                    <input key={`${project.id}-${heatmapVersion}`} type="file" accept="image/png,.png" aria-label="选择 PNG 热图" disabled={heatmapUploading} onChange={(event) => setHeatmapFile(event.target.files?.[0] ?? null)} />
                    <span className="heatmap-file-button"><FolderOpenOutlined /> 选择文件</span>
                    {heatmapFile && <span className="heatmap-file-name" title={heatmapFile.name}>{heatmapFile.name}</span>}
                  </label>
                  <Input size="small" aria-label="热图标注" placeholder="标注名称，如 726.5025 m/z（选填）" value={heatmapLabel} onChange={(event) => setHeatmapLabel(event.target.value)} disabled={heatmapUploading} />
                  <Button size="small" icon={<UploadOutlined />} loading={heatmapUploading} disabled={!heatmapFile || !maldiAvailable} onClick={uploadHeatmap} style={{marginTop: 8}}>上传并自动配准</Button>
                  {!maldiAvailable && <div className="sidebar-empty-note">需具备 MALDI/SBD 坐标数据方可配准热图。</div>}
                </>,
              }]} />
            </section>

            <Collapse className="sidebar-collapse" ghost items={[{
              key: 'details',
              label: <span><SlidersOutlined /> 数据详情</span>,
              children: <div className="sidebar-detail-list">
                <div><span>来源</span><strong>{activeSource.label}</strong></div>
                <div><span>配准方法</span><strong>{methodLabel(activeRegistration.method)}</strong></div>
                <div><span>坐标模型</span><strong>{mapping?.coordinate_model ? `degree ${mapping.coordinate_model.degree}` : '—'}</strong></div>
                <div><span>校准版本</span><strong>{mapping?.calibration_version ?? '—'}</strong></div>
                {heatmap?.available && <>
                  {heatmapOrientation(heatmap) && <div><span>热图方向</span><strong>{heatmapOrientation(heatmap)}</strong></div>}
                  {heatmap.inliers != null && <div><span>热图有效匹配点</span><strong>{heatmap.inliers}</strong></div>}
                  {heatmap.error_p95_px != null && <div><span>板图配准误差 p95</span><strong>{spotNumber(heatmap.error_p95_px, 2)} px</strong></div>}
                </>}
              </div>,
            }]} />
            <div className="sidebar-footer">
              <div><span>减少动态效果</span><Switch size="small" checked={reducedMotion} onChange={setReducedMotion} /></div>
            </div>
          </div>
        </aside>

        {!sidebarOpen && <Tooltip title="展开控制栏"><button type="button" className="sidebar-reopen" onClick={() => setSidebarOpen(true)} aria-label="展开控制栏"><MenuUnfoldOutlined /></button></Tooltip>}

        <main className="workspace-main">
          {viewLoaded ? (
            <div className="canvas-shell">
              <CanvasViewer
                key={project.id}
                projectId={project.id}
                report={report}
                layer={currentLayer}
                onViewport={updateViewport}
                onImageScale={setPixelsPerImagePixel}
                initialViewport={viewerInitial}
                restoreViewport={savedViewportRef.current}
                manualPoints={manualPoints}
                onSpotSelect={handleSpotSelect}
                gridPoints={gridPoints}
                gridSampled={gridSampled}
                selectedSpot={selectedSpot}
                showGrid={showGrid}
                showPits={showPits}
                overlayOpacity={overlayOpacity}
                heatmapColors={heatmapColors}
                showHeatmap={showHeatmap}
                heatmapOpacity={heatmapOpacity}
                compare={compare}
                comparePosition={comparePosition}
                onComparePosition={setComparePosition}
                compareSwap={swapLayers}
                lens={lens}
                lensSize={lensSize}
                lensOverlap={lensOverlap}
                lensFixed={lensFixed}
                lensSwap={swapLayers}
                reducedMotion={reducedMotion}
              />
              <motion.div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
                <ToolButton icon={<ZoomInOutlined />} label="放大" onClick={() => dispatchCanvasEvent('spatialbridge-zoom-in')} shortcut="+" />
                <ToolButton icon={<ZoomOutOutlined />} label="缩小" onClick={() => dispatchCanvasEvent('spatialbridge-zoom-out')} shortcut="−" />
                <ToolButton icon={<CompressOutlined />} label="查看全图" onClick={() => dispatchCanvasEvent('spatialbridge-fit')} shortcut="H" />
                <ToolButton icon={<AimOutlined />} label={selectedSpot ? '定位选中点' : '查看采样区域'} onClick={() => dispatchCanvasEvent('spatialbridge-locate')} shortcut="L" />
                <ToolButton icon={<HomeOutlined />} label="恢复已保存视野" onClick={restoreSavedView} disabled={!hasSavedView} shortcut="R" />
              </motion.div>
              {((showPits && maldiAvailable) || (showGrid && gridPoints.length > 0)) && <div className="canvas-legend">
                <GlassSurface
                  width="max-content"
                  height="auto"
                  borderRadius={12}
                  borderWidth={0.07}
                  brightness={50}
                  opacity={0.93}
                  blur={11}
                  displace={0.5}
                  backgroundOpacity={0.12}
                  saturation={1}
                  distortionScale={-120}
                  className="canvas-legend-glass"
                >
                  {showPits && maldiAvailable && <span className="legend-item"><i className="legend-line legend-confirmed" />已确认</span>}
                  {showGrid && gridPoints.length > 0 && <span className="legend-item"><i className="legend-line legend-candidate" />网格候选</span>}
                </GlassSurface>
              </div>}
              <div className="canvas-statusbar">
                <span className="scale-readout">{reliableScale && scaleDistance > 0 && <i className="scale-line" style={{width: `${scaleBarWidth}px`}} />}{scaleText}</span>
                <span>{coordinateText}</span>
                <span>缩放 {viewport.zoom == null ? '—' : `${viewport.zoom.toFixed(2)}×`}</span>
                <span>{rasterText} · 范围 {mapping?.mapped_spot_count?.toLocaleString() ?? '—'} 点 · 坐标链一致性 p95 {Number.isFinite(chainP95) ? `${chainP95!.toFixed(3)} px` : '—'}</span>
              </div>
            </div>
          ) : (
            <div className="canvas-empty"><div className="loading-stack"><Spin /><span>正在恢复上次视野…</span></div></div>
          )}
        </main>
      </div>

      <Drawer
        className="spot-drawer"
        placement="right"
        width={360}
        open={Boolean(spotLoading || selectedSpot)}
        mask={false}
        closable={false}
        onClose={() => {spotRequestRef.current += 1; setSelectedSpot(null); setSpotLoading(false);}}
        title={<div className="drawer-title"><div><strong>选中 MALDI 点</strong></div><button type="button" className="icon-button" onClick={() => {spotRequestRef.current += 1; setSelectedSpot(null); setSpotLoading(false);}} aria-label="关闭点位详情"><CloseOutlined /></button></div>}
      >
        {spotLoading ? <motion.div className="drawer-loading" initial={{opacity: 0}} animate={{opacity: 1}} transition={{duration: reducedMotion ? 0 : .18}}><Spin /><span>正在读取对应的 SBD 数据…</span></motion.div> : selectedSpot && (
          <motion.div className="spot-inspector" initial={{opacity: 0, x: 12}} animate={{opacity: 1, x: 0}} transition={{duration: reducedMotion ? 0 : .2}}>
            <div className="spot-hero"><span className="spot-id">SPOT #{selectedSpot.spot_id}</span><Tag color={selectedSpot.detected ? 'success' : 'default'}>{selectedSpot.detected ? '图像确认' : '网格候选'}</Tag><strong>{spotNumber(selectedSpot.value, 3)}</strong><small>{selectedSpot.field_label ?? '当前 normalization 字段'}</small></div>
            <div className="inspector-section"><div className="inspector-label">热图图片颜色采样</div>{selectedSpot.raster === (mapping?.primary_raster ?? 0) && heatmapColors.has(selectedSpot.spot_id) ? <div className="inspector-value"><span>{heatmap?.label || heatmap?.filename || 'PNG 热图'}</span><strong><span aria-hidden="true" style={{display: 'inline-block', width: 14, height: 14, background: heatmapColors.get(selectedSpot.spot_id), border: '1px solid currentColor', marginRight: 8, verticalAlign: 'middle'}} />{heatmapColors.get(selectedSpot.spot_id)}</strong></div> : <Typography.Text type="secondary">此点没有可用的图片颜色（可能被采集框遮挡或位于有效区域外）</Typography.Text>}</div>
            <div className="inspector-section"><div className="inspector-label">Normalization 值</div>{selectedSpot.normalizations?.length ? selectedSpot.normalizations.map((value) => <div className={`inspector-value${value.key === (selectedSpot.field_key ?? selectedFieldKey) ? ' is-selected' : ''}`} key={value.key}><span>{value.label}</span><strong>{spotNumber(value.value, 3)}</strong></div>) : <Typography.Text type="secondary">当前缓存未包含 normalization 数值</Typography.Text>}</div>
            <div className="inspector-section"><div className="inspector-label">空间定位与匹配</div><Descriptions column={1} size="small">
              <Descriptions.Item label="raster">{selectedSpot.raster}</Descriptions.Item>
              <Descriptions.Item label="网格坐标">({spotNumber(selectedSpot.pre_x, 1)}, {spotNumber(selectedSpot.pre_y, 1)})</Descriptions.Item>
              <Descriptions.Item label="采集后坐标">({spotNumber(selectedSpot.after_x, 1)}, {spotNumber(selectedSpot.after_y, 1)})</Descriptions.Item>
              <Descriptions.Item label="原始采集坐标">({spotNumber(selectedSpot.original_x, 0)}, {spotNumber(selectedSpot.original_y, 0)})</Descriptions.Item>
              <Descriptions.Item label="world 坐标">({spotNumber(selectedSpot.world_x, 3)}, {spotNumber(selectedSpot.world_y, 3)})</Descriptions.Item>
              <Descriptions.Item label="点位匹配距离">{spotNumber(selectedSpot.distance_px, 2)} px</Descriptions.Item>
              <Descriptions.Item label="图像响应分数">{spotNumber(selectedSpot.pit_score, 3)}</Descriptions.Item>
              <Descriptions.Item label="校准版本">{selectedSpot.calibration_version ?? '—'}</Descriptions.Item>
            </Descriptions></div>
          </motion.div>
        )}
      </Drawer>

      <Drawer
        className="report-drawer"
        placement="right"
        width={520}
        open={reportOpen}
        mask={false}
        onClose={() => setReportOpen(false)}
        title={<div className="drawer-title"><div><strong>配准报告</strong></div><button type="button" className="icon-button" onClick={() => setReportOpen(false)} aria-label="关闭配准报告"><CloseOutlined /></button></div>}
      >
        <motion.div className="report-drawer-content" initial={{opacity: 0, x: 12}} animate={{opacity: 1, x: 0}} transition={{duration: reducedMotion ? 0 : .2}}>
        <div className="report-summary">
          <div className={`report-summary-icon${mappingSuccess ? ' is-success' : ' is-warning'}`}>{mappingSuccess ? <CheckCircleFilled /> : <SettingOutlined />}</div>
          <div>{!mappingSuccess && <strong>结果需复核</strong>}<span>{mapping?.quality ?? '前后显微图区域级对齐'}</span></div>
        </div>
        <div className="report-metrics"><div><strong>{mapping?.mapped_spot_count?.toLocaleString() ?? '—'}</strong><span>映射点</span></div><div><strong>{autoPitTotal.toLocaleString()}</strong><span>已确认灼烧坑</span></div><div><strong>{Number.isFinite(opticalP95) ? `${opticalP95!.toFixed(2)} px` : '—'}</strong><span>光学验证误差 p95</span></div></div>
        <Collapse className="report-collapse" ghost items={[
          {key: 'data', label: '数据详情', children: <div className="report-detail-grid">
            <div><span>显微来源</span><strong>{preSource.label || preSource.path || '—'}</strong></div>
            <div><span>采集后来源</span><strong>{afterSource.label || afterSource.path || '—'}</strong></div>
            <div><span>算法 / 方法</span><strong>{methodLabel(activeRegistration.method)}</strong></div>
            <div><span>坐标模型</span><strong>{mapping?.coordinate_model ? `normalized_polynomial · degree ${mapping.coordinate_model.degree}` : '—'}</strong></div>
            <div><span>校准版本</span><strong>{mapping?.calibration_version ?? '—'}</strong></div>
            <div><span>主 Raster / 范围</span><strong>{mapping?.primary_raster ?? '—'} / {mapping?.mapped_spot_count?.toLocaleString() ?? '—'} 个映射点</strong></div>
            <div><span>坐标链一致性 p95</span><strong>{Number.isFinite(chainP95) ? `${chainP95!.toFixed(3)} px · world→pre/after` : '—'}</strong></div>
            <div><span>角点中位误差</span><strong>{typeof cornerMedian === 'number' && Number.isFinite(cornerMedian) ? `${cornerMedian.toFixed(2)} px · 区域级` : '—'}</strong></div>
          </div>},
          {key: 'validation', label: '验证预览', children: <div className="report-previews">
            {artifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${artifact.replace(/^validation\//, '')}`)} alt="采集前与采集后叠加验证" /><figcaption>前后图像叠加 · 检查区域级对应关系</figcaption></figure>}
            {pitArtifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${pitArtifact.replace(/^validation\//, '')}`)} alt="采集后显微图上的 SBD 灼烧坑检测" /><figcaption>自动灼烧坑检测 · {autoPitTotal.toLocaleString()} 个确认点</figcaption></figure>}
            {regionArtifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${regionArtifact.replace(/^validation\//, '')}`)} alt="全幅网格五个固定区域复核" /><figcaption>全幅网格固定区域复核</figcaption></figure>}
            {!artifact && !pitArtifact && !regionArtifact && <Typography.Text type="secondary">暂无验证预览</Typography.Text>}
          </div>},
          {key: 'limitations', label: '限制与数据含义', children: <ul className="report-limitations">{report.limitations.map((item) => <li key={item}>{limitationLabel(item)}</li>)}</ul>},
        ]} />
        </motion.div>
      </Drawer>
    </div>
  </>
  );
}
