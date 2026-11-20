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
  Typography,
  message,
} from 'antd';
import {
  AimOutlined,
  AppstoreOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CompressOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HeatMapOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  SettingOutlined,
  SlidersOutlined,
  SwapOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {projectName, selectInitialViewport} from '../flow';
import {AppHeader} from './AppHeader';
import GlassSurface from './GlassSurface';
import './Workbench.css';
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
  manualPointsFromView,
  methodLabel,
  limitationLabel,
  qualityLabel,
} from '../utils';
import {TranslatedText, useI18n} from '../i18n';
import {CanvasViewer} from './CanvasViewer';
import {SpectraPanel} from './SpectraPanel';
import {SpotSpectrum} from './SpotSpectrum';

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
        <span><TranslatedText text={label} /></span>
      </button>
    </Tooltip>
  );
}

export function Workbench({project, onHome}: {project: Project; onHome: () => void}) {
  const {t, language, toggleLanguage} = useI18n();
  const [layer, setLayer] = useState<ViewLayer>('pre');
  const [viewport, setViewport] = useState<Viewport>({});
  const [pixelsPerImagePixel, setPixelsPerImagePixel] = useState(0);
  const [viewerInitial, setViewerInitial] = useState<Viewport>();
  const [viewLoaded, setViewLoaded] = useState(false);
  const [gridPoints, setGridPoints] = useState<GridPoint[]>([]);
  const [gridSampled, setGridSampled] = useState(false);
  const [autoPitTotal, setAutoPitTotal] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState<NearestSpot | null>(null);
  const [spotLoading, setSpotLoading] = useState(false);
  const [manualPoints, setManualPoints] = useState<ManualPoint[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 680);
  const [reportOpen, setReportOpen] = useState(false);
  const [spectraOpen, setSpectraOpen] = useState(false);
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
  const [reducedMotion, setReducedMotion] = useState(false);
  const viewportRef = useRef<Viewport>({});
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
            : key === 'l' ? 'spatialbridge-locate' : null;
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
        if (active) messageApi.error(t.workbench.failedLoadSpots(errorText(error, language)));
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
      if (active) setHeatmapError(t.workbench.failedLoadHeatmap(errorText(error, language)));
    }).finally(() => { if (active) setHeatmapLoading(false); });
    return () => { active = false; };
  }, [project.id, project.status, mapping?.primary_raster, heatmapVersion]);

  const uploadHeatmap = async () => {
    if (!heatmapFile || heatmapUploading) return;
    if (heatmapFile.type !== 'image/png' && !/\.png$/i.test(heatmapFile.name)) {
      setHeatmapError(t.workbench.selectPngOnly);
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
      if (token === heatmapUploadToken.current) setHeatmapError(t.workbench.failedRegHeatmap(errorText(error, language)));
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
    // Continue the current tab's session without reusing an explicit saved view.
    // Read legacy records only to preserve existing manual annotations.
    apiFetch<SavedViewResponse>(`/projects/${project.id}/view`)
      .then((saved) => {
        if (!active) return;
        const next = selectInitialViewport(session) as Viewport;
        const settings = session?.settings ?? {};
        const nextLayer: ViewLayer = settings.layer === 'after' || settings.layer === 'pre'
          ? settings.layer
          : next.layer === 'after' ? 'after' : 'pre';
        setManualPoints(manualPointsFromView(saved));
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
        setManualPoints([]);
        // If the service is temporarily unavailable, keep the tab-local
        // session usable instead of replacing it with a blank full view.
        const next = selectInitialViewport(session) as Viewport;
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
        // Session storage is optional; a new tab can start at the overview.
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

  if (!report || !preSource || !afterSource) return <>{holder}<div className="canvas-empty"><TranslatedText text={t.workbench.noRegData} /></div></>;

  const activeSource = currentLayer === 'after' ? afterSource : preSource;
  const activeRegistration = report.registrations.find((item) => item.source_key === currentLayer) ?? report.registrations[0];
  if (!activeRegistration) return <>{holder}<div className="canvas-empty"><TranslatedText text={t.workbench.noAvailableRegData} /></div></>;
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
    // The two persistent image layers exchange roles without nudging the view.
    setSwapLayers(next);
  };
  const handleSpotSelect = async (point: {x: number; y: number; layer: string}) => {
    if (!maldiAvailable) {
      messageApi.info(t.workbench.noCachedSbdSpots);
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
        messageApi.info(t.workbench.noSpotNearClick(match.reason));
        return;
      }
      setSelectedSpot(match);
      if (Number.isFinite(match.pre_x) && Number.isFinite(match.pre_y)) {
        window.dispatchEvent(new CustomEvent('spatialbridge-focus-spot', {detail: {x: match.pre_x, y: match.pre_y}}));
      }
    } catch (error) {
      if (requestId !== spotRequestRef.current) return;
      messageApi.error(t.workbench.failedReadSpot(errorText(error, language)));
    } finally {
      if (requestId === spotRequestRef.current) setSpotLoading(false);
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
  const scaleText = reliableScale && scaleDistance > 0 ? `${scaleLabel} · ~${scaleBarWidth.toFixed(1)} px` : t.workbench.scaleUnavailable;
  const rasterText = mapping?.primary_raster == null ? 'Raster —' : `Raster ${mapping.primary_raster}`;
  const coordinateText = viewport.imageX == null || viewport.imageY == null
    ? t.workbench.coordEmpty
    : t.workbench.coordPrefix(Math.round(viewport.imageX).toLocaleString(), Math.round(viewport.imageY).toLocaleString());
  const projectLabel = projectName(project, language);
  const mappingSuccess = mapping?.status === 'calibrated';

  const handleGoHome = () => {
    spotRequestRef.current += 1;
    setSelectedSpot(null);
    setSpotLoading(false);
    onHome();
  };

  return (
    <>
    {holder}
    <div className={`workspace-app redesigned-workspace${sidebarOpen ? '' : ' sidebar-collapsed'}${reducedMotion ? ' motion-reduced' : ''}`}>
      <AppHeader
        className="app-header--workbench"
        onHome={handleGoHome}
        projectTitle={projectLabel}
        projectTooltip={`${projectLabel} · ${project.id.slice(0, 8)}`}
        status={!mappingSuccess ? {
          label: mapping?.available ? t.workbench.pendingReview : t.workbench.imageReady,
          tone: 'warning',
        } : undefined}
        center={
          <div className="header-observation">
            <LayoutGroup id="observation-controls">
              <div className="observation-controls">
                <nav className="view-tabs mode-tabs" aria-label={t.workbench.viewMode} role="tablist">
                  {([
                    ['single', t.workbench.modeSingle, t.workbench.modeSingleHint],
                    ['compare', t.workbench.modeCompare, t.workbench.modeCompareHint],
                    ['lens', t.workbench.modeLens, t.workbench.modeLensHint],
                  ] as Array<[ViewMode, string, string]>).map(([value, label, hint]) => (
                    <Tooltip title={hint} key={value}>
                      <button type="button" role="tab" aria-selected={mode === value} className={mode === value ? 'is-active' : ''} onClick={() => chooseMode(value)}>
                        {mode === value && <motion.span className="tab-selection" layoutId="observation-mode-selection" transition={{duration: reducedMotion ? 0 : .18}} />}
                        <span className="tab-label"><TranslatedText text={label} /></span>
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
                      <div className="mode-operations-panel mode-layer-switch" role="group" aria-label={t.workbench.singleLayerAria}>
                        {(['pre', 'after'] as ViewLayer[]).map((value) => (
                          <button type="button" className={`mode-layer-option${currentLayer === value ? ' is-active' : ''}`} aria-pressed={currentLayer === value} key={value} onClick={() => chooseLayer(value)}>
                            {currentLayer === value && <motion.span className="tab-selection" layoutId="single-layer-selection" transition={{duration: reducedMotion ? 0 : .18}} />}
                            <span className="tab-label"><TranslatedText text={value === 'pre' ? t.common.pre : t.common.after} /></span>
                          </button>
                        ))}
                      </div>
                    )}
                    {mode === 'compare' && (
                      <div className="mode-operations-panel" role="group" aria-label="compare-operations">
                        <div className="mode-role-pair" aria-label={t.workbench.compareLayerAria(currentLayer === 'pre' ? t.common.pre : t.common.after, compareLayer === 'pre' ? t.common.pre : t.common.after)}>
                          <span className="mode-role"><small><TranslatedText text={t.common.left} /></small><strong><TranslatedText text={currentLayer === 'pre' ? t.common.pre : t.common.after} /></strong></span>
                          <span className="mode-role-divider" aria-hidden="true">/</span>
                          <span className="mode-role"><small><TranslatedText text={t.common.right} /></small><strong><TranslatedText text={compareLayer === 'pre' ? t.common.pre : t.common.after} /></strong></span>
                        </div>
                        <Tooltip title={<TranslatedText text={t.workbench.swapLeftRight} />}>
                          <button type="button" className={`mode-action${swapLayers ? ' is-active' : ''}`} onClick={toggleComparisonLayers} aria-label={t.workbench.swapLeftRight}><SwapOutlined /><span><TranslatedText text={t.workbench.swapShort} /></span></button>
                        </Tooltip>
                        <Tooltip title={<TranslatedText text={t.workbench.centerDivider} />}>
                          <button type="button" className="mode-action" onClick={() => setComparePosition(50)} aria-label={t.workbench.centerDivider}><span aria-hidden="true">↔</span><span><TranslatedText text={t.workbench.centerShort} /></span></button>
                        </Tooltip>
                        <span className="mode-readout" aria-live="polite">{Math.round(comparePosition)}%</span>
                      </div>
                    )}
                    {mode === 'lens' && (
                      <div className="mode-operations-panel" role="group" aria-label="lens-operations">
                        <div className="mode-role-pair" aria-label={t.workbench.lensLayerAria(currentLayer === 'pre' ? t.common.pre : t.common.after, lensLayer === 'pre' ? t.common.pre : t.common.after)}>
                          <span className="mode-role"><small><TranslatedText text={t.common.outer} /></small><strong><TranslatedText text={currentLayer === 'pre' ? t.common.pre : t.common.after} /></strong></span>
                          <span className="mode-role-divider" aria-hidden="true">/</span>
                          <span className="mode-role"><small><TranslatedText text={t.common.inner} /></small><strong><TranslatedText text={lensLayer === 'pre' ? t.common.pre : t.common.after} /></strong></span>
                        </div>
                        <Tooltip title={<TranslatedText text={t.workbench.swapInsideOutside} />}>
                          <button type="button" className={`mode-action${swapLayers ? ' is-active' : ''}`} onClick={toggleComparisonLayers} aria-label={t.workbench.swapInsideOutside}><SwapOutlined /><span><TranslatedText text={t.workbench.swapShort} /></span></button>
                        </Tooltip>
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </LayoutGroup>
          </div>
        }
        actions={
          <>
            <Button type="text" icon={<FileSearchOutlined />} onClick={() => setSpectraOpen(true)}>{language === 'zh' ? '光谱数据' : 'Spectra'}</Button>
            <Tooltip title={<TranslatedText text={t.workbench.reportTitle} />}>
              <Button type="text" icon={<FileSearchOutlined />} onClick={() => setReportOpen(true)}><TranslatedText text={t.workbench.reportBtn} /></Button>
            </Tooltip>
            <Tooltip title={<TranslatedText text={maldiAvailable ? t.workbench.exportCsvTooltip : t.workbench.exportCsvNoDataTooltip} />}>
              <Button type="text" icon={<DownloadOutlined />} disabled={!maldiAvailable} href={maldiAvailable ? `${apiUrl(`/projects/${project.id}/burn-pits.csv`)}${selectedFieldKey ? `?field=${encodeURIComponent(selectedFieldKey)}` : ''}` : undefined} target="_blank"><TranslatedText text={t.workbench.exportCsvBtn} /></Button>
            </Tooltip>
          </>
        }
        mobileActions={
          <Dropdown
            className="mobile-actions"
            menu={{items: [
              {key: 'spectra', label: language === 'zh' ? '光谱数据' : 'Spectra'},
              {key: 'report', label: t.workbench.viewReportAction},
              {key: 'export', label: t.workbench.exportCsvAction, disabled: !maldiAvailable},
              {key: 'lang', label: language === 'zh' ? 'English (EN)' : '中文版 (ZH)'},
              {key: 'home', label: t.common.backHome},
            ], onClick: ({key}) => {
              if (key === 'spectra') setSpectraOpen(true);
              if (key === 'report') setReportOpen(true);
              if (key === 'export' && maldiAvailable) window.open(`${apiUrl(`/projects/${project.id}/burn-pits.csv`)}${selectedFieldKey ? `?field=${encodeURIComponent(selectedFieldKey)}` : ''}`, '_blank');
              if (key === 'lang') toggleLanguage();
              if (key === 'home') handleGoHome();
            }}}
          >
            <Button size="small" aria-label={t.common.moreActions} icon={<MoreOutlined />} />
          </Dropdown>
        }
      />

      <Drawer title={language === 'zh' ? '光谱数据' : 'Spectral data'} open={spectraOpen} onClose={() => setSpectraOpen(false)} width={760} destroyOnClose>
        {spectraOpen && <SpectraPanel key={project.id} projectId={project.id} />}
      </Drawer>

      <div className="workspace-body">
        <aside className={`control-sidebar${sidebarOpen ? '' : ' is-hidden'}`} aria-label={t.workbench.sidebarTitle}>
          <div className="sidebar-scroll">
            <div className="sidebar-heading">
              <h2><TranslatedText text={t.workbench.sidebarTitle} /></h2>
              <Tooltip title={<TranslatedText text={t.workbench.collapseSidebar} />}><button type="button" className="icon-button" onClick={() => setSidebarOpen(false)} aria-label={t.workbench.collapseSidebar}><MenuFoldOutlined /></button></Tooltip>
            </div>
            <section className="control-section project-summary">
              <div className="section-heading"><span><TranslatedText text={t.workbench.projectInfo} /></span></div>
              <div className="summary-row"><span><TranslatedText text={t.workbench.projectName} /></span><strong title={projectLabel}><TranslatedText text={projectLabel} /></strong></div>
              {!mappingSuccess && <div className="summary-row"><span><TranslatedText text={t.workbench.regStatus} /></span><strong className="summary-muted"><TranslatedText text={mapping?.available ? t.workbench.pendingReview : report?.maldi_data?.available ? t.workbench.sbdReadNotMapped : t.workbench.noMassSpecData} /></strong></div>}
              <div className="summary-row"><span><TranslatedText text={t.workbench.sbdSpots} /></span><strong>{report?.maldi_data?.spot_count?.toLocaleString() ?? '—'}</strong></div>
              <div className="summary-row"><span><TranslatedText text={t.workbench.mappedSpots} /></span><strong>{mapping?.mapped_spot_count?.toLocaleString() ?? '—'}</strong></div>
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
                  <div className="section-heading"><span><TranslatedText text={t.workbench.lensSettings} /></span><span className="section-meta"><TranslatedText text={t.workbench.currentMode} /></span></div>
                  <div className="parameter-block lens-setting-block">
                    <div className="parameter-label"><span><TranslatedText text={t.workbench.lensSize} /></span><span className="parameter-value">{lensSize} px</span></div>
                    <input className="sidebar-range" aria-label={t.workbench.lensSize} type="range" min="150" max="340" step="10" value={lensSize} onChange={(event) => setLensSize(Number(event.target.value))} />
                  </div>
                  <div className="parameter-block lens-setting-block">
                    <div className="parameter-label"><span><TranslatedText text={t.workbench.lensOverlap} /></span><span className="parameter-value">{lensOverlap}%</span></div>
                    <input className="sidebar-range" aria-label={t.workbench.lensOverlap} type="range" min="0" max="100" step="5" value={lensOverlap} onChange={(event) => setLensOverlap(Number(event.target.value))} />
                  </div>
                  <div className="switch-row"><span><AimOutlined /> <TranslatedText text={t.workbench.lockLens} /></span><Switch size="small" checked={lensFixed} onChange={setLensFixed} /></div>
                </motion.section>
              )}
            </AnimatePresence>

            <section className="control-section">
              <div className="section-heading"><span><TranslatedText text={t.workbench.layerOverlay} /></span></div>
              <div className="switch-row"><span><AppstoreOutlined /> <TranslatedText text={t.workbench.samplingGrid} /></span><Switch size="small" checked={showGrid} onChange={setShowGrid} /></div>
              <div className="switch-row"><span><AimOutlined /> <TranslatedText text={t.workbench.burnPits} /> <em>{autoPitTotal.toLocaleString()}</em></span><Switch size="small" checked={showPits} onChange={setShowPits} disabled={!maldiAvailable} /></div>
              <div className="parameter-block opacity-block"><div className="parameter-label"><span><TranslatedText text={t.workbench.layerOpacity} /></span><span className="parameter-value">{overlayOpacity}%</span></div><Slider min={0} max={100} value={overlayOpacity} onChange={setOverlayOpacity} tooltip={{formatter: (value) => `${value}%`}} /></div>
              {!maldiAvailable && <div className="sidebar-empty-note"><TranslatedText text={report?.maldi_data?.available
                ? t.workbench.sbdNotMappedWarning(mapping?.reason)
                : t.workbench.noSbdWarning} /></div>}
            </section>

            <section className="control-section">
              <div className="section-heading"><span><TranslatedText text={t.workbench.maldiHeatmap} /></span></div>
              {heatmapUploading ? <div className="sidebar-empty-note"><TranslatedText text={t.workbench.heatmapUploading} /></div> : heatmapLoading ? <div className="sidebar-empty-note"><TranslatedText text={t.workbench.heatmapLoading} /></div> : heatmap?.available ? (
                <div className="sidebar-empty-note">
                  <TranslatedText text={heatmap.label || heatmap.filename || t.workbench.heatmapPng} />
                </div>
              ) : <div className="sidebar-empty-note"><TranslatedText text={heatmap?.warning || t.workbench.noHeatmap} /></div>}
              {heatmapError && <Alert type="error" showIcon message={heatmapError} />}
              {heatmap?.available && <>
                <div className="switch-row"><span><HeatMapOutlined /> <TranslatedText text={t.workbench.showHeatmap} /></span><Switch size="small" checked={showHeatmap} onChange={setShowHeatmap} disabled={!heatmapColors.size} /></div>
                <div className="parameter-block opacity-block"><div className="parameter-label"><span><TranslatedText text={t.workbench.heatmapOpacity} /></span><span className="parameter-value">{heatmapOpacity}%</span></div><Slider min={0} max={100} value={heatmapOpacity} onChange={setHeatmapOpacity} tooltip={{formatter: (value) => `${value}%`}} /></div>
              </>}
              <Collapse className="sidebar-collapse" ghost items={[{
                key: 'upload',
                label: heatmap?.available ? t.workbench.replaceHeatmap : t.workbench.addHeatmap,
                children: <>
                  <label className={`heatmap-file-picker${heatmapUploading ? ' is-disabled' : ''}`}>
                    <input key={`${project.id}-${heatmapVersion}`} type="file" accept="image/png,.png" aria-label={t.workbench.selectPngHeatmap} disabled={heatmapUploading} onChange={(event) => setHeatmapFile(event.target.files?.[0] ?? null)} />
                    <span className="heatmap-file-button"><FolderOpenOutlined /> <TranslatedText text={t.common.selectFile} /></span>
                    {heatmapFile && <span className="heatmap-file-name" title={heatmapFile.name}>{heatmapFile.name}</span>}
                  </label>
                  <Input size="small" aria-label={t.workbench.maldiHeatmap} placeholder={t.workbench.heatmapLabelPlaceholder} value={heatmapLabel} onChange={(event) => setHeatmapLabel(event.target.value)} disabled={heatmapUploading} />
                  <Button size="small" icon={<UploadOutlined />} loading={heatmapUploading} disabled={!heatmapFile || !maldiAvailable} onClick={uploadHeatmap} style={{marginTop: 8}}><TranslatedText text={t.workbench.uploadAndRegister} /></Button>
                  {!maldiAvailable && <div className="sidebar-empty-note"><TranslatedText text={t.workbench.needSbdForHeatmap} /></div>}
                </>,
              }]} />
            </section>

            <Collapse className="sidebar-collapse" ghost items={[{
              key: 'details',
              label: <span><SlidersOutlined /> <TranslatedText text={t.workbench.regParamsTitle} /></span>,
              children: <div className="sidebar-detail-list">
                <div><span><TranslatedText text={t.workbench.currentLayer} /></span><strong>{activeSource.label}</strong></div>
                <div><span><TranslatedText text={t.workbench.regMethod} /></span><strong><TranslatedText text={methodLabel(activeRegistration.method, language)} /></strong></div>
                <div><span><TranslatedText text={t.workbench.coordModel} /></span><strong>{mapping?.coordinate_model ? `degree ${mapping.coordinate_model.degree}` : '—'}</strong></div>
                <div><span><TranslatedText text={t.workbench.calibrationVer} /></span><strong>{mapping?.calibration_version ?? '—'}</strong></div>
                {heatmap?.available && <>
                  {heatmapOrientation(heatmap, language) && <div><span><TranslatedText text={t.workbench.heatmapOrientation} /></span><strong><TranslatedText text={heatmapOrientation(heatmap, language)} /></strong></div>}
                  {heatmap.inliers != null && <div><span><TranslatedText text={t.workbench.heatmapInliers} /></span><strong>{heatmap.inliers}</strong></div>}
                  {heatmap.error_p95_px != null && <div><span><TranslatedText text={t.workbench.plateRegError} /></span><strong>{spotNumber(heatmap.error_p95_px, 2)} px</strong></div>}
                </>}
              </div>,
            }]} />
            <div className="sidebar-footer">
              <div><span><TranslatedText text={t.workbench.reduceMotion} /></span><Switch size="small" checked={reducedMotion} onChange={setReducedMotion} /></div>
            </div>
          </div>
        </aside>

        {!sidebarOpen && <Tooltip title={<TranslatedText text={t.workbench.expandSidebar} />}><button type="button" className="sidebar-reopen" onClick={() => setSidebarOpen(true)} aria-label={t.workbench.expandSidebar}><MenuUnfoldOutlined /></button></Tooltip>}

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
              <motion.div className="canvas-toolbar" role="toolbar" aria-label="canvas-toolbar">
                <GlassSurface
                  width="max-content"
                  height="auto"
                  borderRadius={24}
                  borderWidth={0.07}
                  brightness={50}
                  opacity={0.93}
                  blur={11}
                  displace={0.5}
                  backgroundOpacity={0.1}
                  saturation={1}
                  distortionScale={-180}
                  redOffset={0}
                  greenOffset={10}
                  blueOffset={20}
                  refraction={true}
                  className="canvas-toolbar-glass"
                >
                  <ToolButton icon={<ZoomInOutlined />} label={t.workbench.zoomIn} onClick={() => dispatchCanvasEvent('spatialbridge-zoom-in')} shortcut="+" />
                  <ToolButton icon={<ZoomOutOutlined />} label={t.workbench.zoomOut} onClick={() => dispatchCanvasEvent('spatialbridge-zoom-out')} shortcut="−" />
                  <ToolButton icon={<CompressOutlined />} label={t.workbench.fit} onClick={() => dispatchCanvasEvent('spatialbridge-fit')} shortcut="H" />
                  <ToolButton icon={<AimOutlined />} label={selectedSpot ? t.workbench.focusSpot : t.workbench.locateArea} onClick={() => dispatchCanvasEvent('spatialbridge-locate')} shortcut="L" />
                </GlassSurface>
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
                  {showPits && maldiAvailable && <span className="legend-item"><i className="legend-line legend-confirmed" /><TranslatedText text={t.workbench.legendDetected} /></span>}
                  {showGrid && gridPoints.length > 0 && <span className="legend-item"><i className="legend-line legend-candidate" /><TranslatedText text={t.workbench.legendGrid} /></span>}
                </GlassSurface>
              </div>}
              <div className="canvas-statusbar">
                <span className="scale-readout">{reliableScale && scaleDistance > 0 && <i className="scale-line" style={{width: `${scaleBarWidth}px`}} />}<TranslatedText text={scaleText} /></span>
                <span><TranslatedText text={coordinateText} /></span>
                <span><TranslatedText text={t.workbench.zoomPrefix(viewport.zoom == null ? '—' : viewport.zoom.toFixed(2))} /></span>
                <span><TranslatedText text={rasterText} /> · <TranslatedText text={t.workbench.totalSpots(mapping?.mapped_spot_count?.toLocaleString() ?? '—')} /> · <TranslatedText text={t.workbench.coordConsistency(Number.isFinite(chainP95) ? `${chainP95!.toFixed(3)} px` : '—')} /></span>
              </div>
            </div>
          ) : (
            <div className="canvas-empty"><div className="loading-stack"><Spin /><span><TranslatedText text={t.workbench.loadingView} /></span></div></div>
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
        title={<div className="drawer-title"><div><strong><TranslatedText text={t.workbench.spotDetails} /></strong></div><button type="button" className="icon-button" onClick={() => {spotRequestRef.current += 1; setSelectedSpot(null); setSpotLoading(false);}} aria-label={t.workbench.closeSpotDetails}><CloseOutlined /></button></div>}
      >
        {spotLoading ? <motion.div className="drawer-loading" initial={{opacity: 0}} animate={{opacity: 1}} transition={{duration: reducedMotion ? 0 : .18}}><Spin /><span><TranslatedText text={t.workbench.loadingSbdData} /></span></motion.div> : selectedSpot && (
          <motion.div className="spot-inspector" initial={{opacity: 0, x: 12}} animate={{opacity: 1, x: 0}} transition={{duration: reducedMotion ? 0 : .2}}>
            <div className="spot-hero"><span className="spot-id">SPOT #{selectedSpot.spot_id}</span><strong>{spotNumber(selectedSpot.value, 3)}</strong></div>
            <SpotSpectrum key={`${project.id}:${selectedSpot.spot_id}`} projectId={project.id} spotId={selectedSpot.spot_id} onOpenData={() => setSpectraOpen(true)} />
            <div className="inspector-section"><div className="inspector-label"><TranslatedText text={t.workbench.heatmapColorSample} /></div><Typography.Paragraph type="secondary">{language === 'zh' ? 'PNG 热图的显示颜色，不是 SBD 原始离子强度。' : 'Display color from the PNG heatmap, not raw SBD ion intensity.'}</Typography.Paragraph>{selectedSpot.raster === (mapping?.primary_raster ?? 0) && heatmapColors.has(selectedSpot.spot_id) ? <div className="inspector-value"><span><TranslatedText text={heatmap?.label || heatmap?.filename || t.workbench.heatmapPng} /></span><strong><span aria-hidden="true" style={{display: 'inline-block', width: 14, height: 14, background: heatmapColors.get(selectedSpot.spot_id), border: '1px solid currentColor', marginRight: 8, verticalAlign: 'middle'}} />{heatmapColors.get(selectedSpot.spot_id)}</strong></div> : <Typography.Text type="secondary"><TranslatedText text={t.workbench.noColorSample} /></Typography.Text>}</div>
            <div className="inspector-section"><div className="inspector-label"><TranslatedText text={t.workbench.normValues} /></div>{selectedSpot.normalizations?.length ? selectedSpot.normalizations.map((value) => <div className={`inspector-value${value.key === (selectedSpot.field_key ?? selectedFieldKey) ? ' is-selected' : ''}`} key={value.key}><span>{value.label}</span><strong>{spotNumber(value.value, 3)}</strong></div>) : <Typography.Text type="secondary"><TranslatedText text={t.workbench.noNormValues} /></Typography.Text>}</div>
            <div className="inspector-section"><div className="inspector-label"><TranslatedText text={t.workbench.spatialCoordInfo} /></div><Descriptions column={1} size="small">
              <Descriptions.Item label={<TranslatedText text={t.workbench.rasterLabel} />}>{selectedSpot.raster}</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.gridCoord} />}>({spotNumber(selectedSpot.pre_x, 1)}, {spotNumber(selectedSpot.pre_y, 1)})</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.afterCoord} />}>({spotNumber(selectedSpot.after_x, 1)}, {spotNumber(selectedSpot.after_y, 1)})</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.originalCoord} />}>({spotNumber(selectedSpot.original_x, 0)}, {spotNumber(selectedSpot.original_y, 0)})</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.worldCoord} />}>({spotNumber(selectedSpot.world_x, 3)}, {spotNumber(selectedSpot.world_y, 3)})</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.regOffset} />}>{spotNumber(selectedSpot.distance_px, 2)} px</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.pitConfidence} />}>{spotNumber(selectedSpot.pit_score, 3)}</Descriptions.Item>
              <Descriptions.Item label={<TranslatedText text={t.workbench.calibrationVer} />}>{selectedSpot.calibration_version ?? '—'}</Descriptions.Item>
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
        title={<div className="drawer-title"><div><strong><TranslatedText text={t.workbench.reportTitle} /></strong></div><button type="button" className="icon-button" onClick={() => setReportOpen(false)} aria-label={t.workbench.closeReport}><CloseOutlined /></button></div>}
      >
        <motion.div className="report-drawer-content" initial={{opacity: 0, x: 12}} animate={{opacity: 1, x: 0}} transition={{duration: reducedMotion ? 0 : .2}}>
        <div className="report-summary">
          <div className={`report-summary-icon${mappingSuccess ? ' is-success' : ' is-warning'}`}>{mappingSuccess ? <CheckCircleFilled /> : <SettingOutlined />}</div>
          <div>{!mappingSuccess && <strong><TranslatedText text={t.workbench.suggestReview} /></strong>}<span><TranslatedText text={qualityLabel(mapping?.quality, language)} /></span></div>
        </div>
        <div className="report-metrics"><div><strong>{mapping?.mapped_spot_count?.toLocaleString() ?? '—'}</strong><span><TranslatedText text={t.workbench.mappedSpotsMetric} /></span></div><div><strong>{autoPitTotal.toLocaleString()}</strong><span><TranslatedText text={t.workbench.confirmedPitsMetric} /></span></div><div><strong>{Number.isFinite(opticalP95) ? `${opticalP95!.toFixed(2)} px` : '—'}</strong><span><TranslatedText text={t.workbench.opticalP95} /></span></div></div>
        <Collapse className="report-collapse" ghost items={[
          {key: 'data', label: t.workbench.regParamsTab, children: <div className="report-detail-grid">
            <div><span><TranslatedText text={t.workbench.preImage} /></span><strong>{preSource.label || preSource.path || '—'}</strong></div>
            <div><span><TranslatedText text={t.workbench.afterImage} /></span><strong>{afterSource.label || afterSource.path || '—'}</strong></div>
            <div><span><TranslatedText text={t.workbench.regAlgorithm} /></span><strong><TranslatedText text={methodLabel(activeRegistration.method, language)} /></strong></div>
            <div><span><TranslatedText text={t.workbench.coordModel} /></span><strong>{mapping?.coordinate_model ? `normalized_polynomial · degree ${mapping.coordinate_model.degree}` : '—'}</strong></div>
            <div><span><TranslatedText text={t.workbench.calibrationVer} /></span><strong>{mapping?.calibration_version ?? '—'}</strong></div>
            <div><span><TranslatedText text={t.workbench.primaryRasterSpot(mapping?.primary_raster ?? '—', mapping?.mapped_spot_count?.toLocaleString() ?? '—')} /></span></div>
            <div><span><TranslatedText text={t.workbench.coordConsistency(Number.isFinite(chainP95) ? `${chainP95!.toFixed(3)} px · world→pre/after` : '—')} /></span></div>
            <div><span><TranslatedText text={t.workbench.cornerMedian(typeof cornerMedian === 'number' && Number.isFinite(cornerMedian) ? cornerMedian.toFixed(2) : '—')} /></span></div>
          </div>},
          {key: 'validation', label: t.workbench.validationTab, children: <div className="report-previews">
            {artifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${artifact.replace(/^validation\//, '')}`)} alt={t.workbench.preAfterOverlay} /><figcaption><TranslatedText text={t.workbench.preAfterOverlayCaption} /></figcaption></figure>}
            {pitArtifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${pitArtifact.replace(/^validation\//, '')}`)} alt={t.workbench.pitDetection} /><figcaption><TranslatedText text={t.workbench.pitDetectionCaption(autoPitTotal.toLocaleString())} /></figcaption></figure>}
            {regionArtifact && <figure><img src={apiUrl(`/projects/${project.id}/validation/${regionArtifact.replace(/^validation\//, '')}`)} alt={t.workbench.regionValidation} /><figcaption><TranslatedText text={t.workbench.regionValidationCaption} /></figcaption></figure>}
            {!artifact && !pitArtifact && !regionArtifact && <Typography.Text type="secondary"><TranslatedText text={t.workbench.noValidationPreview} /></Typography.Text>}
          </div>},
          {key: 'limitations', label: t.workbench.limitationsTab, children: <ul className="report-limitations">{report.limitations.map((item) => <li key={item}><TranslatedText text={limitationLabel(item, language)} /></li>)}</ul>},
        ]} />
        </motion.div>
      </Drawer>
    </div>
  </>
  );
}
