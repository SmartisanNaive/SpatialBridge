import React, {useEffect, useRef, useState} from 'react';
import OpenSeadragon, {Viewer as OSDViewer} from 'openseadragon';
import {AnimatePresence, motion} from 'motion/react';
import {SwapOutlined} from '@ant-design/icons';
import {PointerGesture} from '../pointerGesture';
import {gridLineOpacity, selectGridDetail, SPOT_INTERACTIVE_PX, type GridDetail} from '../gridDetail';
import {groupGridPoints} from '../gridGroups';
import './CanvasViewer.css';
import type {
  Report,
  Viewport,
  ViewLayer,
  LensCenter,
  LensRoles,
  LensTransition,
  ManualPoint,
  GridPoint,
  NearestSpot,
  HeatmapColors,
  FramePoint,
  GridSpatialIndex,
} from '../types';
import {evaluateCoordinateModel, GRID_INDEX_BUCKET_SIZE, convexHull, projectPoint, makeTileSource} from '../utils';

// Attempts after the first before a tile is reported as failed.
const TILE_RETRIES = 3;
const TILE_RECOVERY_DELAY_MS = 6000;
// After this long a layer switch is reported as slow, but it keeps waiting.
const SLOW_LAYER_MS = 15000;
const PROGRESS_UPDATE_MS = 250;

export function CanvasViewer({
  projectId,
  report,
  layer,
  onViewport,
  onImageScale,
  initialViewport,
  restoreViewport,
  manualPoints,
  annotationMode,
  onAnnotationPlace,
  onAnnotationSelect,
  selectedAnnotationId,
  onSpotSelect,
  gridPoints,
  gridSampled,
  selectedSpot,
  showGrid,
  showPits,
  overlayOpacity,
  heatmapColors,
  showHeatmap,
  heatmapOpacity,
  compare,
  comparePosition,
  onComparePosition,
  compareSwap,
  lens,
  lensSize,
  lensOverlap,
  lensFixed,
  lensSwap,
  reducedMotion,
}: {
  projectId: string;
  report: Report;
  layer: ViewLayer;
  onViewport: (viewport: Viewport) => void;
  onImageScale?: (pixelsPerImagePixel: number) => void;
  initialViewport?: Viewport;
  restoreViewport?: Viewport | null;
  manualPoints?: ManualPoint[];
  annotationMode?: boolean;
  onAnnotationPlace?: (point: {x: number; y: number}) => void;
  onAnnotationSelect?: (id: string) => void;
  selectedAnnotationId?: string;
  onSpotSelect: (point: {x: number; y: number; layer: string}) => void;
  gridPoints: GridPoint[];
  gridSampled?: boolean;
  selectedSpot?: NearestSpot | null;
  showGrid: boolean;
  showPits: boolean;
  overlayOpacity: number;
  heatmapColors: HeatmapColors;
  showHeatmap: boolean;
  heatmapOpacity: number;
  compare: boolean;
  comparePosition: number;
  onComparePosition: (value: number) => void;
  compareSwap: boolean;
  lens: boolean;
  lensSize: number;
  lensOverlap: number;
  lensFixed: boolean;
  lensSwap: boolean;
  reducedMotion: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const compareElement = useRef<HTMLDivElement>(null);
  const annotationLayer = useRef<HTMLDivElement>(null);
  const lensWindowNode = useRef<HTMLDivElement>(null);
  const pitCanvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<OSDViewer | null>(null);
  const compareViewer = useRef<OSDViewer | null>(null);
  const onSpotSelectRef = useRef(onSpotSelect);
  const manualPointsRef = useRef(manualPoints ?? []);
  const annotationModeRef = useRef(Boolean(annotationMode));
  const selectedAnnotationIdRef = useRef(selectedAnnotationId);
  const onAnnotationPlaceRef = useRef(onAnnotationPlace);
  const onAnnotationSelectRef = useRef(onAnnotationSelect);
  const onViewportRef = useRef(onViewport);
  const onImageScaleRef = useRef(onImageScale);
  const gridPointsRef = useRef(gridPoints);
  const selectedSpotRef = useRef(selectedSpot);
  const viewerSettingsRef = useRef({showGrid, showPits, overlayOpacity, showHeatmap, heatmapOpacity, heatmapColors});
  const compareLock = useRef(false);
  const annotationOverlays = useRef(new Map<string, HTMLElement>());
  const annotationOverlayReady = useRef(false);
  const annotationSync = useRef<(() => void) | null>(null);
  // Keep the first viewport and the durable restore checkpoint separate. A
  // session view should win when the project opens, while the restore action
  // must continue to target the last explicit server save.
  const initialViewportRef = useRef(initialViewport);
  const restoreViewportRef = useRef(restoreViewport);
  const pitOverlaySync = useRef<(() => void) | null>(null);
  const outerFrameCache = useRef<{source: GridPoint[]; points: FramePoint[]} | null>(null);
  const gridSpatialIndex = useRef<GridSpatialIndex | null>(null);
  const [gridDetail, setGridDetail] = useState<GridDetail>('overview');
  const gridDetailRef = useRef<GridDetail>('overview');
  const cellScreenSideRef = useRef(0);
  const heatmapOverviewCache = useRef<{source: GridPoint[]; colors: HeatmapColors; report: Report; image: HTMLCanvasElement} | null>(null);
  const footprintCache = useRef<{report: Report; points: WeakMap<GridPoint, FramePoint[]>} | null>(null);
  const groupedGridCache = useRef<{source: GridPoint[]; report: Report; groups: {corners: FramePoint[]; left: number; right: number; top: number; bottom: number}[]} | null>(null);
  const focusPulseRef = useRef<{x: number; y: number; startedAt: number} | null>(null);
  const focusPendingRef = useRef(false);
  const lensDraggingRef = useRef(false);
  const lensCenterRef = useRef<LensCenter>({x: 0, y: 0});
  const singleDisplayedLayerRef = useRef<ViewLayer>(layer);
  const singleTransitionRef = useRef<{from: ViewLayer; to: ViewLayer; id: number} | null>(null);
  const transitionRequestRef = useRef(0);
  const singleModeRef = useRef(!compare && !lens);
  const readinessCancelRef = useRef<(() => void) | null>(null);
  const waitForLayerReadyRef = useRef<(target: ViewLayer) => Promise<boolean>>(() => Promise.resolve(false));
  const tileFailureRef = useRef<Record<ViewLayer, boolean>>({pre: false, after: false});
  const tileRetryingRef = useRef<Record<ViewLayer, boolean>>({pre: false, after: false});
  const tilesLoadedRef = useRef<Record<ViewLayer, number>>({pre: 0, after: 0});
  const lensTransitionRequestRef = useRef(0);
  const lensTransitionRef = useRef<LensTransition | null>(null);
  const lensTransitionFrameRef = useRef<number | null>(null);
  const initialLensRoles: LensRoles = {outer: layer, inner: layer === 'pre' ? 'after' : 'pre'};
  const lensVisualRolesRef = useRef<LensRoles>(initialLensRoles);
  const pointerGestureRef = useRef(new PointerGesture());
  const [outside, setOutside] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [lensCenter, setLensCenter] = useState<LensCenter>({x: 0, y: 0});
  const [singleDisplayedLayer, setSingleDisplayedLayer] = useState<ViewLayer>(layer);
  const [singleTransition, setSingleTransition] = useState<{from: ViewLayer; to: ViewLayer; id: number} | null>(null);
  const [transitionPending, setTransitionPending] = useState<ViewLayer | null>(null);
  const [loadProgress, setLoadProgress] = useState<{loaded: number; seconds: number; slow: boolean} | null>(null);
  const [lensVisualRoles, setLensVisualRoles] = useState<LensRoles>(initialLensRoles);
  const [lensTransition, setLensTransition] = useState<LensTransition | null>(null);
  const pre = report.sources.find((source) => source.key === 'pre');
  const after = report.sources.find((source) => source.key === 'after');
  const registration = report.registrations.find((item) => item.source_key === layer);
  const preRegistration = report.registrations.find((item) => item.source_key === 'pre') ?? registration;
  const afterRegistration = report.registrations.find((item) => item.source_key === 'after');
  const compareLayer: ViewLayer = compareSwap ? (layer === 'pre' ? 'after' : 'pre') : (layer === 'pre' ? 'after' : 'pre');

  useEffect(() => {
    onSpotSelectRef.current = onSpotSelect;
    manualPointsRef.current = manualPoints ?? [];
    annotationModeRef.current = Boolean(annotationMode);
    selectedAnnotationIdRef.current = selectedAnnotationId;
    onAnnotationPlaceRef.current = onAnnotationPlace;
    onAnnotationSelectRef.current = onAnnotationSelect;
    onViewportRef.current = onViewport;
    onImageScaleRef.current = onImageScale;
    gridPointsRef.current = gridPoints;
    selectedSpotRef.current = selectedSpot;
    viewerSettingsRef.current = {showGrid, showPits, overlayOpacity, showHeatmap, heatmapOpacity, heatmapColors};
    initialViewportRef.current = initialViewport;
    restoreViewportRef.current = restoreViewport;
    annotationSync.current?.();
    pitOverlaySync.current?.();
  }, [annotationMode, gridPoints, initialViewport, manualPoints, onAnnotationPlace, onAnnotationSelect, onImageScale, onSpotSelect, onViewport, restoreViewport, selectedAnnotationId, selectedSpot, showGrid, showPits, overlayOpacity, showHeatmap, heatmapOpacity, heatmapColors]);

  useEffect(() => {
    const gesture = pointerGestureRef.current;
    const handlePointerMove = (event: PointerEvent) => {
      // Keep measuring after the pointer leaves the canvas when the browser
      // does not grant pointer capture to the underlying viewer.
      gesture.move({pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY});
    };
    const handlePointerUp = (event: PointerEvent) => {
      gesture.end(event.pointerId);
      lensDraggingRef.current = false;
    };
    const handlePointerCancel = (event: PointerEvent) => {
      gesture.cancel(event.pointerId);
      lensDraggingRef.current = false;
    };
    const handleWindowBlur = () => {
      gesture.cancelAll();
      lensDraggingRef.current = false;
    };
    // React capture handlers cover events inside the canvas. Window listeners
    // finish the same sequence when the pointer is released outside it.
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
      gesture.cancelAll();
    };
  }, []);

  useEffect(() => {
    if (!element.current || !compareElement.current || !pre || !after || !preRegistration || !afterRegistration) return;
    const applyViewport = (instance: OSDViewer, saved: Viewport | null | undefined, immediate = true) => {
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.zoom === 'number') {
        instance.viewport.zoomTo(saved.zoom, undefined, immediate);
        instance.viewport.panTo(new OpenSeadragon.Point(saved.x, saved.y), immediate);
      } else {
        instance.viewport.goHome(immediate);
      }
    };
    const restoreInitial = (instance: OSDViewer, immediate = true) =>
      applyViewport(instance, initialViewportRef.current, immediate);
    const restoreSaved = (instance: OSDViewer, immediate = true) => {
      const saved = restoreViewportRef.current;
      if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number' || typeof saved.zoom !== 'number') return;
      applyViewport(instance, saved, immediate);
      updateImageScale();
    };
    const makeViewer = (target: HTMLDivElement, showNavigator: boolean) => OpenSeadragon({
      element: target,
      showNavigator,
      navigatorAutoFade: false,
      navigatorOpacity: 0.92,
      showRotationControl: false,
      showNavigationControl: false,
      animationTime: 0.38,
      crossOriginPolicy: 'Anonymous',
      gestureSettingsMouse: {clickToZoom: false},
      // Keep both registered layers alive in the shared viewport.  The
      // inactive layer can prepare its visible tiles before Motion reveals it.
      preload: true,
      // The backend renders registered tiles locally. A small queue keeps a
      // zoom burst from decoding several large source regions at once.
      imageLoaderLimit: 3,
      // A relay or tunnel in front of the backend may drop connections during
      // a burst of tile requests; retry instead of leaving holes in the image.
      // (The bundled typings do not list these two options.)
      ...({tileRetryMax: TILE_RETRIES, tileRetryDelay: 1200} as object),
      prefixUrl: '/openseadragon/images/',
    });
    const instance = makeViewer(element.current, true);
    viewer.current = instance;
    // This second viewer is retained for single-mode crossfades as well as
    // the existing compare/lens modes; switching a layer never rebuilds the
    // canvas or its viewport.
    const compareInstance = makeViewer(compareElement.current, false);
    compareViewer.current = compareInstance;
    setTileError(false);
    tileFailureRef.current = {pre: false, after: false};
    tileRetryingRef.current = {pre: false, after: false};
    annotationOverlayReady.current = false;
    annotationOverlays.current.clear();
    const waitForLayerReady = (target: ViewLayer) => {
      readinessCancelRef.current?.();
      return new Promise<boolean>((resolve) => {
        let timer: number | undefined;
        let settled = false;
        const finish = (ready: boolean) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) window.clearTimeout(timer);
          if (readinessCancelRef.current === cancel) {
            readinessCancelRef.current = null;
            setLoadProgress(null);
          }
          resolve(ready);
        };
        const cancel = () => finish(false);
        readinessCancelRef.current = cancel;
        const startedAt = performance.now();
        const loadedAtStart = tilesLoadedRef.current[target];
        let lastProgressAt = -Infinity;
        setLoadProgress({loaded: 0, seconds: 0, slow: false});
        const check = () => {
          const targetViewer = target === 'pre' ? instance : compareInstance;
          const item = targetViewer.world.getItemCount() > 0 ? targetViewer.world.getItemAt(0) : null;
          if (item?.getFullyLoaded() && !tileRetryingRef.current[target]) {
            finish(true);
            return;
          }
          // Failed tile batches are retried by watchTiles. Keep this switch
          // pending so it completes automatically when the connection recovers.
          const now = performance.now();
          if (now - lastProgressAt >= PROGRESS_UPDATE_MS) {
            lastProgressAt = now;
            const elapsed = now - startedAt;
            setLoadProgress({
              loaded: tilesLoadedRef.current[target] - loadedAtStart,
              seconds: Math.floor(elapsed / 1000),
              slow: elapsed > SLOW_LAYER_MS,
            });
          }
          timer = window.setTimeout(check, 48);
        };
        check();
      });
    };
    waitForLayerReadyRef.current = waitForLayerReady;
    const syncAnnotationOverlays = () => {
      if (!annotationOverlayReady.current) return;
      const visibleIds = new Set<string>();
      for (const point of manualPointsRef.current) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        visibleIds.add(point.id);
        let marker = annotationOverlays.current.get(point.id);
        if (!marker) {
          marker = document.createElement('div');
          marker.className = 'manual-point';
          marker.setAttribute('role', 'button');
          marker.setAttribute('tabindex', '0');
          const label = document.createElement('span');
          label.className = 'manual-point-label';
          marker.appendChild(label);
          const select = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            onAnnotationSelectRef.current?.(point.id);
          };
          marker.addEventListener('click', select);
          marker.addEventListener('keydown', (event) => {
            if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) select(event);
          });
          annotationOverlays.current.set(point.id, marker);
          annotationLayer.current?.appendChild(marker);
        }
        const pixel = instance.viewport.pixelFromPoint(instance.viewport.imageToViewportCoordinates(point.x, point.y), true);
        const viewerBounds = element.current?.getBoundingClientRect();
        const layerBounds = annotationLayer.current?.getBoundingClientRect();
        if (viewerBounds && layerBounds) {
          marker.style.left = `${pixel.x + viewerBounds.left - layerBounds.left}px`;
          marker.style.top = `${pixel.y + viewerBounds.top - layerBounds.top}px`;
        }
        marker.classList.toggle('manual-point-selected', point.id === selectedAnnotationIdRef.current);
        marker.classList.toggle('manual-point-pending', point.id === 'pending');
        const valueLabel = marker.querySelector('.manual-point-label');
        if (valueLabel) valueLabel.textContent = point.value === undefined ? '?' : String(point.value);
        const valueText = point.value === undefined ? '未赋值' : `值 ${point.value}`;
        marker.setAttribute('aria-label', `灼烧坑 ${valueText}，坐标 (${Math.round(point.x)}, ${Math.round(point.y)})`);
        marker.title = `${valueText} · (${Math.round(point.x)}, ${Math.round(point.y)})${point.note ? ` · ${point.note}` : ''}`;
      }
      for (const [id, marker] of annotationOverlays.current) {
        if (visibleIds.has(id)) continue;
        marker.remove();
        annotationOverlays.current.delete(id);
      }
    };
    annotationSync.current = syncAnnotationOverlays;
    const updateImageScale = () => {
      if (!instance.world.getItemCount()) return;
      const origin = instance.viewport.pixelFromPoint(instance.viewport.imageToViewportCoordinates(0, 0), true);
      const unitX = instance.viewport.pixelFromPoint(instance.viewport.imageToViewportCoordinates(1, 0), true);
      const pixelsPerImagePixel = Math.hypot(unitX.x - origin.x, unitX.y - origin.y);
      if (Number.isFinite(pixelsPerImagePixel) && pixelsPerImagePixel > 0) onImageScaleRef.current?.(pixelsPerImagePixel);
    };
    let pitFrame: number | undefined;
    const drawPitOverlay = () => {
      const canvas = pitCanvas.current;
      const container = element.current?.parentElement;
      if (!canvas || !container) return;
      const bounds = container.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!instance.world.getItemCount()) return;
      const drawGrid = viewerSettingsRef.current.showGrid;
      const drawPits = viewerSettingsRef.current.showPits;
      const drawOpacity = viewerSettingsRef.current.overlayOpacity;
      const {showHeatmap: drawHeatmap, heatmapOpacity: colorOpacity, heatmapColors: colors} = viewerSettingsRef.current;
      if (!drawGrid && !drawPits && !drawHeatmap && !selectedSpotRef.current) return;
      const viewerBounds = element.current?.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      const offsetX = (viewerBounds?.left ?? canvasBounds.left) - canvasBounds.left;
      const offsetY = (viewerBounds?.top ?? canvasBounds.top) - canvasBounds.top;
      const pitDetection = report.spatial_mapping?.metrics?.pit_detection;
      const coordinateModel = report.spatial_mapping?.coordinate_model;
      const configuredFallback = pitDetection?.expected_spot_diameter_px ?? pitDetection?.expected_grid_pitch_px ?? 20;
      const fallbackSpotSide = Number.isFinite(configuredFallback) && configuredFallback > 0 ? configuredFallback : 20;
      const configuredVectors = pitDetection?.spot_vectors_pre_px;
      const hasConfiguredVectors = configuredVectors?.length === 2 && configuredVectors.every((vector) =>
        vector.length === 2 && vector.every((value) => Number.isFinite(value)));
      const worldToPre = report.spatial_mapping?.matrices?.world_to_pre;
      const afterToPre = report.spatial_mapping?.matrices?.after_to_pre;
      const hasWorldTransform = worldToPre?.length === 3 && worldToPre.every((row) =>
        row.length === 3 && row.every((value) => Number.isFinite(value)));
      const hasCoordinateModel = Boolean(coordinateModel?.model_type && coordinateModel.normalization &&
        coordinateModel.coefficients?.length && coordinateModel.degree >= 1);
      const hasAfterToPre = afterToPre?.length === 3 && afterToPre.every((row) =>
        row.length === 3 && row.every((value) => Number.isFinite(value)));
      const spotWorldSize = pitDetection?.spot_size_world;
      const hasWorldFootprint = (hasCoordinateModel && hasAfterToPre || hasWorldTransform) && spotWorldSize?.length === 2 &&
        spotWorldSize.every((value) => Number.isFinite(value) && value > 0);
      const imageVectorX: [number, number] = hasConfiguredVectors
        ? [configuredVectors![0][0], configuredVectors![0][1]]
        : [fallbackSpotSide, 0];
      const imageVectorY: [number, number] = hasConfiguredVectors
        ? [configuredVectors![1][0], configuredVectors![1][1]]
        : [0, fallbackSpotSide];
      const imageToScreen = (x: number, y: number) => {
        const viewportPoint = instance.viewport.imageToViewportCoordinates(x, y);
        return instance.viewport.pixelFromPoint(viewportPoint, true);
      };
      const imageOrigin = imageToScreen(0, 0);
      const imageUnitX = imageToScreen(1, 0);
      const imageUnitY = imageToScreen(0, 1);
      const screenUnitX = {x: imageUnitX.x - imageOrigin.x, y: imageUnitX.y - imageOrigin.y};
      const screenUnitY = {x: imageUnitY.x - imageOrigin.x, y: imageUnitY.y - imageOrigin.y};
      const vectorToScreen = (vector: [number, number]) => ({
        x: screenUnitX.x * vector[0] + screenUnitY.x * vector[1],
        y: screenUnitX.y * vector[0] + screenUnitY.y * vector[1],
      });
      const imagePointToScreen = (point: {x: number; y: number}) => ({
        x: imageOrigin.x + screenUnitX.x * point.x + screenUnitY.x * point.y + offsetX,
        y: imageOrigin.y + screenUnitX.y * point.x + screenUnitY.y * point.y + offsetY,
      });
      // A grid node can be close enough to the viewport edge to be selected
      // even when one or more of its footprint corners are outside the
      // registered image. Keep the partial footprint visible, but clip it
      // to the actual image/registration coverage so it cannot spill onto
      // the black canvas background. For a registered layer use the source
      // quadrilateral itself; its axis-aligned coverage box is only a safe
      // fallback for legacy or malformed registration metadata.
      // Grid, selection and focus graphics live in the public pre-image
      // coordinate frame.  Keep that frame fixed while the image pixels
      // crossfade so the overlay cannot jump or fade with either layer.
      const overlayRegistration = preRegistration;
      const coverage = overlayRegistration.coverage;
      const coverageValues = coverage.length === 4 && coverage.every((value) => Number.isFinite(value))
        ? coverage
        : [0, 0, pre.width, pre.height];
      const transformedSourceCorners = [
        projectPoint(overlayRegistration.matrix, 0, 0),
        projectPoint(overlayRegistration.matrix, pre.width, 0),
        projectPoint(overlayRegistration.matrix, pre.width, pre.height),
        projectPoint(overlayRegistration.matrix, 0, pre.height),
      ];
      const hasTransformedSource = transformedSourceCorners.every((point): point is FramePoint => point !== null);
      const clipImageCorners: FramePoint[] = hasTransformedSource
        ? transformedSourceCorners
        : [
            {x: Math.max(0, Math.min(pre.width, Math.min(coverageValues[0], coverageValues[2]))),
              y: Math.max(0, Math.min(pre.height, Math.min(coverageValues[1], coverageValues[3])))},
            {x: Math.max(0, Math.min(pre.width, Math.max(coverageValues[0], coverageValues[2]))),
              y: Math.max(0, Math.min(pre.height, Math.min(coverageValues[1], coverageValues[3])))},
            {x: Math.max(0, Math.min(pre.width, Math.max(coverageValues[0], coverageValues[2]))),
              y: Math.max(0, Math.min(pre.height, Math.max(coverageValues[1], coverageValues[3])))},
            {x: Math.max(0, Math.min(pre.width, Math.min(coverageValues[0], coverageValues[2]))),
              y: Math.max(0, Math.min(pre.height, Math.max(coverageValues[1], coverageValues[3])))},
          ];
      const clipCorners = clipImageCorners.map((point) => imagePointToScreen(point));
      const worldPointToImage = (x: number, y: number) => {
        if (hasCoordinateModel && coordinateModel && hasAfterToPre && afterToPre) {
          const mappedAfter = evaluateCoordinateModel(coordinateModel, x, y);
          if (!mappedAfter) return null;
          const denominator = afterToPre[2][0] * mappedAfter.x + afterToPre[2][1] * mappedAfter.y + afterToPre[2][2];
          if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
          const mappedX = (afterToPre[0][0] * mappedAfter.x + afterToPre[0][1] * mappedAfter.y + afterToPre[0][2]) / denominator;
          const mappedY = (afterToPre[1][0] * mappedAfter.x + afterToPre[1][1] * mappedAfter.y + afterToPre[1][2]) / denominator;
          return Number.isFinite(mappedX) && Number.isFinite(mappedY) ? {x: mappedX, y: mappedY} : null;
        }
        if (!hasWorldTransform || !worldToPre) return null;
        const denominator = worldToPre[2][0] * x + worldToPre[2][1] * y + worldToPre[2][2];
        if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
        const mappedX = (worldToPre[0][0] * x + worldToPre[0][1] * y + worldToPre[0][2]) / denominator;
        const mappedY = (worldToPre[1][0] * x + worldToPre[1][1] * y + worldToPre[1][2]) / denominator;
        return Number.isFinite(mappedX) && Number.isFinite(mappedY) ? {x: mappedX, y: mappedY} : null;
      };
      const screenVectorX = vectorToScreen(imageVectorX);
      const screenVectorY = vectorToScreen(imageVectorY);
      const viewportBounds = instance.viewport.getBounds(true);
      const viewportTopLeft = instance.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(viewportBounds.x, viewportBounds.y),
      );
      const viewportBottomRight = instance.viewport.viewportToImageCoordinates(
        new OpenSeadragon.Point(viewportBounds.x + viewportBounds.width, viewportBounds.y + viewportBounds.height),
      );
      const imageLeft = Math.min(viewportTopLeft.x, viewportBottomRight.x);
      const imageRight = Math.max(viewportTopLeft.x, viewportBottomRight.x);
      const imageTop = Math.min(viewportTopLeft.y, viewportBottomRight.y);
      const imageBottom = Math.max(viewportTopLeft.y, viewportBottomRight.y);
      const boxMarginX = (Math.abs(imageVectorX[0]) + Math.abs(imageVectorY[0])) / 2;
      const boxMarginY = (Math.abs(imageVectorX[1]) + Math.abs(imageVectorY[1])) / 2;
      const screenBoxSpan = Math.max(
        Math.hypot(screenVectorX.x, screenVectorX.y),
        Math.hypot(screenVectorY.x, screenVectorY.y),
      );
      // Use the shorter cell side so a narrow or rotated cell must also be
      // readable. Hysteresis keeps tiny zoom changes from flickering layers.
      const screenCellSide = Math.min(
        Math.hypot(screenVectorX.x, screenVectorX.y),
        Math.hypot(screenVectorY.x, screenVectorY.y),
      );
      cellScreenSideRef.current = screenCellSide;
      const detail = selectGridDetail(screenCellSide, gridDetailRef.current);
      if (detail !== gridDetailRef.current) {
        gridDetailRef.current = detail;
        setGridDetail(detail);
      }
      if (footprintCache.current?.report !== report) {
        footprintCache.current = {report, points: new WeakMap()};
      }
      const computeFootprint = (pit: GridPoint): FramePoint[] => {
        if (hasWorldFootprint && spotWorldSize && pit.world_x != null && pit.world_y != null) {
          const halfX = spotWorldSize[0] / 2;
          const halfY = spotWorldSize[1] / 2;
          const corners = [
            worldPointToImage(pit.world_x - halfX, pit.world_y - halfY),
            worldPointToImage(pit.world_x + halfX, pit.world_y - halfY),
            worldPointToImage(pit.world_x + halfX, pit.world_y + halfY),
            worldPointToImage(pit.world_x - halfX, pit.world_y + halfY),
          ];
          if (corners.every((corner): corner is FramePoint => corner !== null)) return corners;
        }
        return [
          {x: pit.x - imageVectorX[0] / 2 - imageVectorY[0] / 2, y: pit.y - imageVectorX[1] / 2 - imageVectorY[1] / 2},
          {x: pit.x + imageVectorX[0] / 2 - imageVectorY[0] / 2, y: pit.y + imageVectorX[1] / 2 - imageVectorY[1] / 2},
          {x: pit.x + imageVectorX[0] / 2 + imageVectorY[0] / 2, y: pit.y + imageVectorX[1] / 2 + imageVectorY[1] / 2},
          {x: pit.x - imageVectorX[0] / 2 + imageVectorY[0] / 2, y: pit.y - imageVectorX[1] / 2 + imageVectorY[1] / 2},
        ];
      };
      const imageFootprint = (pit: GridPoint): FramePoint[] => {
        const cache = footprintCache.current!.points;
        let corners = cache.get(pit);
        if (!corners) {
          corners = computeFootprint(pit);
          cache.set(pit, corners);
        }
        return corners;
      };
      const drawGroupedGrid = () => {
        if (!drawGrid) return;
        const source = gridPointsRef.current;
        let cached = groupedGridCache.current;
        if (!cached || cached.source !== source || cached.report !== report) {
          const groups = groupGridPoints(source).map((group) => {
            const corners = convexHull(group.flatMap(imageFootprint));
            return {corners, left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)),
              top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y))};
          });
          cached = {source, report, groups};
          groupedGridCache.current = cached;
        }
        const path = new Path2D();
        for (const group of cached.groups) {
          if (group.right < imageLeft || group.left > imageRight || group.bottom < imageTop || group.top > imageBottom) continue;
          const corners = group.corners.map(imagePointToScreen);
          if (!corners.length) continue;
          path.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < corners.length; i++) path.lineTo(corners[i].x, corners[i].y);
          path.closePath();
        }
        context.lineWidth = 1;
        context.strokeStyle = 'rgba(194, 205, 205, .48)';
        context.stroke(path);
      };
      const drawHeatmapOverview = () => {
        const source = gridPointsRef.current;
        let cached = heatmapOverviewCache.current;
        if (!cached || cached.source !== source || cached.colors !== colors || cached.report !== report) {
          // Rasterize every coloured footprint once. Browser image filtering
          // preserves the overall colour field without sparse substitute dots.
          const image = document.createElement('canvas');
          const scale = Math.min(1, 4096 / Math.max(pre.width, pre.height));
          image.width = Math.max(1, Math.round(pre.width * scale));
          image.height = Math.max(1, Math.round(pre.height * scale));
          const bitmap = image.getContext('2d');
          if (!bitmap) return;
          bitmap.setTransform(image.width / pre.width, 0, 0, image.height / pre.height, 0, 0);
          for (const pit of source) {
            const color = colors.get(pit.spot_id);
            if (!color || !Number.isFinite(pit.x) || !Number.isFinite(pit.y)) continue;
            const corners = imageFootprint(pit);
            bitmap.beginPath();
            bitmap.moveTo(corners[0].x, corners[0].y);
            for (const corner of corners.slice(1)) bitmap.lineTo(corner.x, corner.y);
            bitmap.closePath();
            bitmap.fillStyle = color;
            bitmap.fill();
          }
          cached = {source, colors, report, image};
          heatmapOverviewCache.current = cached;
        }
        context.save();
        context.transform(screenUnitX.x, screenUnitX.y, screenUnitY.x, screenUnitY.y,
                          imageOrigin.x + offsetX, imageOrigin.y + offsetY);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(cached.image, 0, 0, pre.width, pre.height);
        context.restore();
      };
      const buildOuterFrame = () => {
        const source = gridPointsRef.current;
        if (outerFrameCache.current?.source === source) return outerFrameCache.current.points;
        const indexedCentres = source
          .map((pit, index) => ({x: pit.x, y: pit.y, index}))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        const centreHull = convexHull(indexedCentres);
        const footprintPoints: FramePoint[] = [];
        for (const hullPoint of centreHull) {
          const pit = source[hullPoint.index ?? -1];
          if (!pit || !Number.isFinite(pit.x) || !Number.isFinite(pit.y)) continue;
          const worldX = pit.world_x;
          const worldY = pit.world_y;
          if (worldX != null && worldY != null && spotWorldSize && hasWorldFootprint) {
            const halfX = spotWorldSize[0] / 2;
            const halfY = spotWorldSize[1] / 2;
            const corners = [
              worldPointToImage(worldX - halfX, worldY - halfY),
              worldPointToImage(worldX + halfX, worldY - halfY),
              worldPointToImage(worldX + halfX, worldY + halfY),
              worldPointToImage(worldX - halfX, worldY + halfY),
            ];
            corners.forEach((corner) => {
              if (corner) footprintPoints.push(corner);
            });
            continue;
          }
          footprintPoints.push(
            {x: pit.x - imageVectorX[0] / 2 - imageVectorY[0] / 2, y: pit.y - imageVectorX[1] / 2 - imageVectorY[1] / 2},
            {x: pit.x + imageVectorX[0] / 2 - imageVectorY[0] / 2, y: pit.y + imageVectorX[1] / 2 - imageVectorY[1] / 2},
            {x: pit.x + imageVectorX[0] / 2 + imageVectorY[0] / 2, y: pit.y + imageVectorX[1] / 2 + imageVectorY[1] / 2},
            {x: pit.x - imageVectorX[0] / 2 + imageVectorY[0] / 2, y: pit.y - imageVectorX[1] / 2 + imageVectorY[1] / 2},
          );
        }
        const frame = convexHull(footprintPoints);
        outerFrameCache.current = {source, points: frame};
        return frame;
      };
      const drawOuterFrame = () => {
        const frame = buildOuterFrame();
        if (frame.length < 3) return;
        const path = new Path2D();
        const first = imagePointToScreen(frame[0]);
        path.moveTo(first.x, first.y);
        for (const point of frame.slice(1)) {
          const screenPoint = imagePointToScreen(point);
          path.lineTo(screenPoint.x, screenPoint.y);
        }
        path.closePath();
        context.lineWidth = 1.4;
        context.strokeStyle = 'rgba(91, 225, 166, .96)';
        context.stroke(path);
      };
      const drawGridPoints = (heatmap = false) => {
        const source = gridPointsRef.current;
        if (!gridSpatialIndex.current || gridSpatialIndex.current.source !== source) {
          const buckets = new Map<string, number[]>();
          source.forEach((pit, index) => {
            if (!Number.isFinite(pit.x) || !Number.isFinite(pit.y)) return;
            const bucketX = Math.floor(pit.x / GRID_INDEX_BUCKET_SIZE);
            const bucketY = Math.floor(pit.y / GRID_INDEX_BUCKET_SIZE);
            const key = `${bucketX}:${bucketY}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(index);
            else buckets.set(key, [index]);
          });
          gridSpatialIndex.current = {source, bucketSize: GRID_INDEX_BUCKET_SIZE, buckets};
        }
        const index = gridSpatialIndex.current;
        const queryLeft = Math.max(0, imageLeft - boxMarginX);
        const queryRight = Math.min(pre.width, imageRight + boxMarginX);
        const queryTop = Math.max(0, imageTop - boxMarginY);
        const queryBottom = Math.min(pre.height, imageBottom + boxMarginY);
        if (queryLeft > queryRight || queryTop > queryBottom) return;
        const visibleIndices: number[] = [];
        const firstBucketX = Math.floor(queryLeft / index.bucketSize);
        const lastBucketX = Math.floor(queryRight / index.bucketSize);
        const firstBucketY = Math.floor(queryTop / index.bucketSize);
        const lastBucketY = Math.floor(queryBottom / index.bucketSize);
        for (let bucketY = firstBucketY; bucketY <= lastBucketY; bucketY += 1) {
          for (let bucketX = firstBucketX; bucketX <= lastBucketX; bucketX += 1) {
            const bucket = index.buckets.get(`${bucketX}:${bucketY}`);
            if (bucket) visibleIndices.push(...bucket);
          }
        }
        // Once cells are readable, draw every visible footprint; dropping
        // nodes to meet a screen budget makes the grid appear incomplete.
        const selected: GridPoint[] = [];
        for (const index of visibleIndices) {
          const pit = source[index];
          if (heatmap ? !colors.has(pit.spot_id) :
              detail === 'grid' ? !drawGrid : (pit.detected ? !drawPits : !drawGrid)) continue;
          if (!Number.isFinite(pit.x) || !Number.isFinite(pit.y)) continue;
          if (pit.x < imageLeft - boxMarginX || pit.x > imageRight + boxMarginX ||
              pit.y < imageTop - boxMarginY || pit.y > imageBottom + boxMarginY) continue;
          const centre = imagePointToScreen(pit);
          const x = centre.x;
          const y = centre.y;
          if (x < -screenBoxSpan || y < -screenBoxSpan || x > width + screenBoxSpan || y > height + screenBoxSpan) continue;
          selected.push(pit);
        }
        const paths: [Path2D, Path2D] = [new Path2D(), new Path2D()];
        for (const pit of selected) {
          const state = detail === 'spots' && pit.detected ? 1 : 0;
          const screenCorners = imageFootprint(pit).map(imagePointToScreen);
          const path = heatmap ? new Path2D() : paths[state];
          path.moveTo(screenCorners[0].x, screenCorners[0].y);
          for (const corner of screenCorners.slice(1)) path.lineTo(corner.x, corner.y);
          path.closePath();
          if (heatmap) {
            context.fillStyle = colors.get(pit.spot_id)!;
            context.fill(path);
          }
        }
        if (heatmap) return;
        context.lineWidth = 1;
        paths.forEach((path, state) => {
          context.strokeStyle = state ? 'rgba(91, 225, 166, .92)' : 'rgba(194, 205, 205, .48)';
          context.fillStyle = state ? 'rgba(91, 225, 166, .10)' : 'rgba(194, 205, 205, .025)';
          if (state) context.fill(path);
          context.stroke(path);
        });
      };
      if (clipCorners.length < 3 || clipCorners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return;
      context.save();
      context.globalAlpha = Math.max(0, Math.min(100, drawOpacity)) / 100;
      context.beginPath();
      context.moveTo(clipCorners[0].x, clipCorners[0].y);
      for (const point of clipCorners.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.clip();
      if (drawHeatmap && colors.size) {
        context.globalAlpha = Math.max(0, Math.min(100, colorOpacity)) / 100;
        if (detail === 'spots') drawGridPoints(true);
        else drawHeatmapOverview();
      }
      context.globalAlpha = Math.max(0, Math.min(100, drawOpacity)) / 100;
      if (drawGrid || drawPits) drawOuterFrame();
      if (detail === 'grid') {
        context.globalAlpha *= gridLineOpacity(screenCellSide);
        drawGroupedGrid();
      } else if (detail === 'spots') {
        drawGridPoints();
      }
      const selected = selectedSpotRef.current;
      if (detail === 'spots' && selected && Number.isFinite(selected.pre_x) && Number.isFinite(selected.pre_y)) {
        const marker = imagePointToScreen({x: selected.pre_x, y: selected.pre_y});
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(marker.x, marker.y, 9, 0, Math.PI * 2);
        context.strokeStyle = '#f6c453';
        context.lineWidth = 2;
        context.stroke();
        context.beginPath();
        context.moveTo(marker.x - 13, marker.y);
        context.lineTo(marker.x + 13, marker.y);
        context.moveTo(marker.x, marker.y - 13);
        context.lineTo(marker.x, marker.y + 13);
        context.strokeStyle = 'rgba(246, 196, 83, .9)';
        context.lineWidth = 1;
        context.stroke();
      }
      const pulse = focusPulseRef.current;
      if (pulse) {
        const progress = (performance.now() - pulse.startedAt) / 520;
        if (progress < 1) {
          const marker = imagePointToScreen(pulse);
          context.globalAlpha = Math.max(0, 1 - progress);
          context.beginPath();
          context.arc(marker.x, marker.y, 14 + progress * 25, 0, Math.PI * 2);
          context.strokeStyle = '#f4d477';
          context.lineWidth = 2;
          context.stroke();
          requestPitOverlay();
        } else {
          focusPulseRef.current = null;
        }
      }
      context.restore();
    };
    const requestPitOverlay = () => {
      if (pitFrame !== undefined) return;
      pitFrame = window.requestAnimationFrame(() => {
        pitFrame = undefined;
        drawPitOverlay();
      });
    };
    pitOverlaySync.current = requestPitOverlay;
    const onWindowResize = () => { updateImageScale(); requestPitOverlay(); };
    window.addEventListener('resize', onWindowResize);
    const syncCompare = () => {
      if (!compareInstance || compareLock.current) return;
      compareLock.current = true;
      compareInstance.viewport.zoomTo(instance.viewport.getZoom(), undefined, true);
      compareInstance.viewport.panTo(instance.viewport.getCenter(), true);
      compareLock.current = false;
    };
    const syncPrimary = () => {
      if (!compareInstance || compareLock.current) return;
      compareLock.current = true;
      instance.viewport.zoomTo(compareInstance.viewport.getZoom(), undefined, true);
      instance.viewport.panTo(compareInstance.viewport.getCenter(), true);
      compareLock.current = false;
      requestPitOverlay();
    };
    instance.addHandler('viewport-change', () => {
      const center = instance.viewport.getCenter();
      const imageCenter = instance.viewport.viewportToImageCoordinates(center);
      onViewportRef.current({
        x: center.x,
        y: center.y,
        zoom: instance.viewport.getZoom(),
        imageX: imageCenter.x,
        imageY: imageCenter.y,
      });
      syncAnnotationOverlays();
      updateImageScale();
      syncCompare();
      requestPitOverlay();
    });
    const finishFocus = () => {
      if (!focusPendingRef.current) return;
      focusPendingRef.current = false;
      const focused = focusTargetRef.current;
      if (!focused) return;
      focusPulseRef.current = {...focused, startedAt: performance.now()};
      requestPitOverlay();
    };
    const cancelFocus = () => {
      focusPendingRef.current = false;
    };
    const focusTargetRef = {current: null as {x: number; y: number} | null};
    const focusTo = (point: {x: number; y: number}) => {
      if (!instance.world.getItemCount() || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const target = instance.viewport.imageToViewportCoordinates(point.x, point.y);
      const homeZoom = instance.viewport.getHomeZoom();
      const targetZoom = Math.max(instance.viewport.getZoom(), homeZoom * 2.2);
      focusTargetRef.current = point;
      focusPendingRef.current = true;
      instance.viewport.zoomTo(targetZoom, target, false);
      instance.viewport.panTo(target, false);
      syncCompare();
    };
    instance.addHandler('animation-finish', finishFocus);
    instance.addHandler('canvas-drag', cancelFocus);
    compareInstance?.addHandler('viewport-change', syncPrimary);
    // A tile only counts as failed once its retries are used up, and the
    // notice clears again once no such tile is still wanted by the view.
    const tileRecoveryTimers = new Set<number>();
    const scheduleTileRecovery = (callback: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        tileRecoveryTimers.delete(timer);
        callback();
      }, delay);
      tileRecoveryTimers.add(timer);
    };
    const watchTiles = (target: OSDViewer, layer: ViewLayer) => {
      const attempts = new Map<string, number>();
      const refresh = () => {
        let failed = false;
        attempts.forEach((count) => { if (count > TILE_RETRIES) failed = true; });
        tileRetryingRef.current[layer] = attempts.size > 0;
        tileFailureRef.current[layer] = failed;
        setTileError(tileFailureRef.current.pre || tileFailureRef.current.after);
      };
      const keyOf = (tile: any) => String(tile?.cacheKey ?? tile?.getUrl?.() ?? '');
      target.addHandler('tile-load-failed', (event: any) => {
        const tile = event.tile;
        const key = keyOf(tile);
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        refresh();
        if (count <= TILE_RETRIES || !tile) return;
        // OpenSeadragon gives up on a tile once its retries are spent. Offer
        // it again later so a connection that recovers fills the gap; a tile
        // the view no longer asks for is simply forgotten.
        scheduleTileRecovery(() => {
          if (!target.isOpen()) return;
          // Reset the exhausted batch before retrying, including its notice.
          // A fast new failure must be counted in the new batch as well.
          attempts.set(key, 0);
          refresh();
          tile.exists = true;
          target.forceRedraw();
          scheduleTileRecovery(() => {
            // A tile no longer requested by this viewport must not block a
            // switch. Never discard failures from the new retry batch.
            if (attempts.get(key) === 0 && !tile.loading) {
              attempts.delete(key);
              refresh();
            }
          }, 400);
        }, TILE_RECOVERY_DELAY_MS);
      });
      target.addHandler('tile-loaded', (event: any) => {
        tilesLoadedRef.current[layer] += 1;
        if (attempts.delete(keyOf(event.tile))) refresh();
      });
    };
    watchTiles(instance, 'pre');
    watchTiles(compareInstance, 'after');
    instance.addHandler('open', () => {
      annotationOverlayReady.current = true;
      syncAnnotationOverlays();
      restoreInitial(instance);
      updateImageScale();
      syncCompare();
      requestPitOverlay();
    });
    compareInstance?.addHandler('open', () => {
      syncCompare();
      requestPitOverlay();
    });
    instance.open(makeTileSource(projectId, 'pre', pre.width, pre.height));
    compareInstance.open(makeTileSource(projectId, 'after', pre.width, pre.height));
    const home = () => {
      instance.viewport.goHome(false);
      compareInstance?.viewport.goHome(false);
    };
    const restoreSavedEvent = () => restoreSaved(instance, false);
    const locate = () => {
      const selected = selectedSpotRef.current;
      if (selected && Number.isFinite(selected.pre_x) && Number.isFinite(selected.pre_y)) {
        focusTo({x: selected.pre_x, y: selected.pre_y});
        return;
      }
      const source = gridPointsRef.current.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (!source.length) return home();
      const xs = source.map((point) => point.x);
      const ys = source.map((point) => point.y);
      const left = Math.max(0, Math.min(...xs) - 360);
      const top = Math.max(0, Math.min(...ys) - 260);
      const right = Math.min(pre.width, Math.max(...xs) + 360);
      const bottom = Math.min(pre.height, Math.max(...ys) + 260);
      instance.viewport.fitBounds(instance.viewport.imageToViewportRectangle(left, top, right - left, bottom - top), false);
      syncCompare();
    };
    const zoomIn = () => instance.viewport.zoomBy(1.45, instance.viewport.getCenter(), false);
    const zoomOut = () => instance.viewport.zoomBy(1 / 1.45, instance.viewport.getCenter(), false);
    const focusSpot = (event: Event) => {
      const detail = (event as CustomEvent<{x?: number; y?: number}>).detail;
      if (detail && Number.isFinite(detail.x) && Number.isFinite(detail.y)) focusTo({x: detail.x!, y: detail.y!});
    };
    window.addEventListener('spatialbridge-home', home);
    window.addEventListener('spatialbridge-fit', home);
    window.addEventListener('spatialbridge-restore', restoreSavedEvent);
    window.addEventListener('spatialbridge-locate', locate);
    window.addEventListener('spatialbridge-zoom-in', zoomIn);
    window.addEventListener('spatialbridge-zoom-out', zoomOut);
    window.addEventListener('spatialbridge-focus-spot', focusSpot);
    return () => {
      window.removeEventListener('spatialbridge-home', home);
      window.removeEventListener('spatialbridge-fit', home);
      window.removeEventListener('spatialbridge-restore', restoreSavedEvent);
      window.removeEventListener('spatialbridge-locate', locate);
      window.removeEventListener('spatialbridge-zoom-in', zoomIn);
      window.removeEventListener('spatialbridge-zoom-out', zoomOut);
      window.removeEventListener('spatialbridge-focus-spot', focusSpot);
      window.removeEventListener('resize', onWindowResize);
      transitionRequestRef.current += 1;
      singleModeRef.current = false;
      singleTransitionRef.current = null;
      lensTransitionRequestRef.current += 1;
      lensTransitionRef.current = null;
      if (lensTransitionFrameRef.current !== null) window.cancelAnimationFrame(lensTransitionFrameRef.current);
      lensTransitionFrameRef.current = null;
      readinessCancelRef.current?.();
      readinessCancelRef.current = null;
      waitForLayerReadyRef.current = () => Promise.resolve(false);
      annotationOverlays.current.forEach((marker) => marker.remove());
      annotationOverlays.current.clear();
      annotationOverlayReady.current = false;
      annotationSync.current = null;
      if (pitFrame !== undefined) window.cancelAnimationFrame(pitFrame);
      tileRecoveryTimers.forEach((timer) => window.clearTimeout(timer));
      tileRecoveryTimers.clear();
      instance.destroy();
      compareInstance.destroy();
      viewer.current = null;
      compareViewer.current = null;
      pitOverlaySync.current = null;
    };
  }, [after, afterRegistration, pre, preRegistration, projectId]);

  const cancelSingleTransition = () => {
    transitionRequestRef.current += 1;
    readinessCancelRef.current?.();
    readinessCancelRef.current = null;
    singleTransitionRef.current = null;
    setSingleTransition(null);
    setTransitionPending(null);
  };
  const requestSingleTransition = (target: ViewLayer) => {
    const displayed = singleDisplayedLayerRef.current;
    const active = singleTransitionRef.current;
    if (active?.to === target) return;
    if (displayed === target) {
      cancelSingleTransition();
      return;
    }
    const requestId = transitionRequestRef.current + 1;
    transitionRequestRef.current = requestId;
    readinessCancelRef.current?.();
    setTransitionPending(target);
    waitForLayerReadyRef.current(target).then((ready) => {
      if (requestId !== transitionRequestRef.current || !singleModeRef.current) return;
      setTransitionPending(null);
      if (!ready) return;
      const from = singleDisplayedLayerRef.current;
      if (from === target) return;
      const next = {from, to: target, id: requestId};
      singleTransitionRef.current = next;
      setSingleTransition(next);
    });
  };
  const finishSingleTransition = (id: number) => {
    const active = singleTransitionRef.current;
    if (!active || active.id !== id) return;
    singleDisplayedLayerRef.current = active.to;
    setSingleDisplayedLayer(active.to);
    singleTransitionRef.current = null;
    setSingleTransition(null);
  };

  const lensRolesForLayer = (outer: ViewLayer): LensRoles => ({
    outer,
    inner: outer === 'pre' ? 'after' : 'pre',
  });
  const commitLensRoles = (roles: LensRoles) => {
    lensVisualRolesRef.current = roles;
    setLensVisualRoles(roles);
  };
  const abortLensTransition = (roles?: LensRoles) => {
    lensTransitionRequestRef.current += 1;
    readinessCancelRef.current?.();
    readinessCancelRef.current = null;
    if (lensTransitionFrameRef.current !== null) window.cancelAnimationFrame(lensTransitionFrameRef.current);
    lensTransitionFrameRef.current = null;
    lensTransitionRef.current = null;
    setLensTransition(null);
    setTransitionPending(null);
    if (roles) commitLensRoles(roles);
  };
  const requestLensTransition = (target: LensRoles) => {
    const active = lensTransitionRef.current;
    if (active?.to.outer === target.outer) return;
    // If the user reverses while the previous transition is still running,
    // settle to its target first. This keeps the next transition fully
    // opaque and avoids exposing an intermediate or empty lens state.
    const from = active?.to ?? lensVisualRolesRef.current;
    abortLensTransition(from);
    if (from.outer === target.outer) return;
    const requestId = lensTransitionRequestRef.current + 1;
    lensTransitionRequestRef.current = requestId;
    setTransitionPending(target.outer);
    waitForLayerReadyRef.current(target.outer).then((ready) => {
      if (requestId !== lensTransitionRequestRef.current || !lens || lensTransitionRef.current) return;
      setTransitionPending(null);
      if (!ready) return;
      const next: LensTransition = {from, to: target, phase: 'expand', id: requestId};
      lensTransitionRef.current = next;
      setLensTransition(next);
    });
  };
  const finishLensTransition = (id: number) => {
    const active = lensTransitionRef.current;
    if (!active || active.id !== id) return;
    commitLensRoles(active.to);
    lensTransitionRef.current = null;
    setLensTransition(null);
  };

  useEffect(() => {
    const isSingle = !compare && !lens;
    if (!isSingle) {
      singleModeRef.current = false;
      cancelSingleTransition();
      singleDisplayedLayerRef.current = layer;
      setSingleDisplayedLayer(layer);
      return;
    }
    if (!singleModeRef.current) {
      singleModeRef.current = true;
      cancelSingleTransition();
      singleDisplayedLayerRef.current = layer;
      setSingleDisplayedLayer(layer);
      return;
    }
    requestSingleTransition(layer);
  }, [compare, layer, lens]);

  useEffect(() => {
    if (!lens) {
      abortLensTransition(lensRolesForLayer(layer));
      return;
    }
    requestLensTransition(lensRolesForLayer(layer));
  }, [layer, lens]);

  useEffect(() => {
    if (!lensTransition || lensTransition.phase !== 'crossfade-prep') return;
    const transitionId = lensTransition.id;
    const frame = window.requestAnimationFrame(() => {
      lensTransitionFrameRef.current = null;
      const active = lensTransitionRef.current;
      if (!active || active.id !== transitionId || active.phase !== 'crossfade-prep') return;
      const next: LensTransition = {...active, phase: 'crossfade'};
      lensTransitionRef.current = next;
      setLensTransition(next);
    });
    lensTransitionFrameRef.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (lensTransitionFrameRef.current === frame) lensTransitionFrameRef.current = null;
    };
  }, [lensTransition]);

  useEffect(() => {
    const instance = viewer.current;
    if (!instance || !registration || !pre) return;
    const checkCoverage = () => {
      if (!instance.world.getItemCount()) return;
      const point = instance.viewport.viewportToImageCoordinates(instance.viewport.getCenter());
      const [left, top, right, bottom] = registration.coverage;
      setOutside(point.x < left || point.x > right || point.y < top || point.y > bottom);
    };
    instance.addHandler('viewport-change', checkCoverage);
    instance.addHandler('open', checkCoverage);
    checkCoverage();
    return () => {
      instance.removeHandler('viewport-change', checkCoverage);
      instance.removeHandler('open', checkCoverage);
    };
  }, [pre, registration]);

  const updateComparePosition = (clientX: number, target: HTMLElement) => {
    const bounds = target.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const next = ((clientX - bounds.left) / bounds.width) * 100;
    onComparePosition(Math.min(95, Math.max(5, next)));
  };
  const handleComparePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    updateComparePosition(event.clientX, target);
    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateComparePosition(moveEvent.clientX, target);
    };
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, {once: true});
  };

  const updateLensCenter = (clientX: number, clientY: number) => {
    const bounds = element.current?.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const next = {
      x: Math.max(lensSize / 2, Math.min(bounds.width - lensSize / 2, clientX - bounds.left)),
      y: Math.max(lensSize / 2, Math.min(bounds.height - lensSize / 2, clientY - bounds.top)),
    };
    // Keep the clipped image and its chrome on the same React state path.
    // Directly mutating one of the persistent image layers can leave an old
    // clip-path behind after the inner/outer roles are exchanged.
    if (next.x === lensCenterRef.current.x && next.y === lensCenterRef.current.y) return;
    lensCenterRef.current = next;
    setLensCenter(next);
  };
  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerGestureRef.current.move({pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY});
    if (!lens) return;
    if (!lensFixed || lensDraggingRef.current) updateLensCenter(event.clientX, event.clientY);
  };
  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerGestureRef.current.begin({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
    });
  };
  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerGestureRef.current.end(event.pointerId);
    lensDraggingRef.current = false;
  };
  const handleCanvasPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerGestureRef.current.cancel(event.pointerId);
    lensDraggingRef.current = false;
  };
  const handleCanvasClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    // Keyboard activation of an overlay has no preceding pointer gesture and
    // should keep its accessible Enter/Space behavior.
    if (event.detail === 0) return;
    if (!pointerGestureRef.current.consumeClick()) return;
    event.preventDefault();
    // Run in capture phase so a drag-generated click cannot reach a manual
    // point's native listener before the canvas click handler sees it.
    event.stopPropagation();
  };
  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!pre) return;
    const target = event.target;
    // The secondary compare/lens viewer can own the DOM click target. Resolve
    // every canvas click through the shared primary viewport instead.
    if (target instanceof Element && target.closest('.compare-divider, .compare-range, .lens-window.is-fixed, .manual-point, .navigator, .openseadragon-navigator, .openseadragon-navigation-control')) return;
    const instance = viewer.current;
    const viewerElement = element.current;
    if (!instance || !viewerElement || !instance.world.getItemCount()) return;
    const bounds = viewerElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const pixel = new OpenSeadragon.Point(event.clientX - bounds.left, event.clientY - bounds.top);
    const viewportPoint = instance.viewport.pointFromPixel(pixel);
    const imagePoint = instance.viewport.viewportToImageCoordinates(viewportPoint);
    if (!Number.isFinite(imagePoint.x) || !Number.isFinite(imagePoint.y) ||
        imagePoint.x < 0 || imagePoint.y < 0 || imagePoint.x > pre.width || imagePoint.y > pre.height) return;
    if (layer === 'after' && annotationModeRef.current) {
      onAnnotationPlaceRef.current?.({x: imagePoint.x, y: imagePoint.y});
      return;
    }
    if (gridPointsRef.current.length && gridDetailRef.current !== 'spots') {
      // A small footprint is not a reliable click target. Use overview clicks
      // to move into the readable scale instead of selecting an invisible node.
      const side = cellScreenSideRef.current;
      if (Number.isFinite(side) && side > 0) {
        const factor = Math.max(1.5, (SPOT_INTERACTIVE_PX + 1) / side);
        instance.viewport.zoomTo(instance.viewport.getZoom() * factor, viewportPoint, false);
      }
      return;
    }
    onSpotSelectRef.current({x: imagePoint.x, y: imagePoint.y, layer});
  };
  const handleLensPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!lensFixed || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    lensDraggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateLensCenter(event.clientX, event.clientY);
  };

  useEffect(() => {
    if (!lens) return;
    const bounds = element.current?.parentElement?.getBoundingClientRect();
    if (bounds) {
      const next = {x: bounds.width / 2, y: bounds.height / 2};
      lensCenterRef.current = next;
      setLensCenter(next);
    }
  }, [lens, lensSize]);

  if (!pre || !registration) return <div className="canvas-empty">该图层没有可用的配准结果。</div>;
  const layerLabel = (value: ViewLayer) => value === 'pre' ? '采集前' : '采集后';
  const lensX = lensCenter.x || lensSize / 2;
  const lensY = lensCenter.y || lensSize / 2;
  const isSingle = !compare && !lens;
  const lensBounds = element.current?.parentElement?.getBoundingClientRect();
  const lensFullRadius = lensBounds && lensBounds.width > 0 && lensBounds.height > 0
    ? Math.hypot(lensBounds.width, lensBounds.height) + lensSize
    : 100000;
  const lensClipPath = `circle(${lensSize / 2}px at ${lensX}px ${lensY}px)`;
  const lensFullClipPath = `circle(${lensFullRadius}px at ${lensX}px ${lensY}px)`;
  const renderedLensRoles: LensRoles = lensTransition
    ? lensTransition.phase === 'expand' ? lensTransition.from : lensTransition.to
    : lensVisualRoles;
  const lensInnerOpacity = Math.max(0, Math.min(100, lensOverlap)) / 100;
  const imageOpacity = (value: ViewLayer) => {
    if (isSingle) {
      if (singleTransition) return singleTransition.to === value ? 1 : 0;
      return singleDisplayedLayer === value ? 1 : 0;
    }
    if (lens) {
      if (lensTransition?.phase === 'crossfade-prep' && value === lensTransition.from.outer) return 0;
      if (value === renderedLensRoles.inner) return lensInnerOpacity;
    }
    return 1;
  };
  const imageClipPath = (value: ViewLayer) => {
    if (compare && value === compareLayer) return `inset(0 0 0 ${comparePosition}%)`;
    if (lens) {
      // Use matching circle primitives throughout the transition so Motion
      // can interpolate the old inner lens into a full-frame image without
      // falling back to a discrete `none`/`circle` switch.
      if (lensTransition?.phase === 'expand') return lensFullClipPath;
      return value === renderedLensRoles.inner ? lensClipPath : lensFullClipPath;
    }
    // An explicit reset matters when a persistent layer changes from the
    // inner lens role to the outer role during an exchange.
    return 'none';
  };
  const imageZIndex = (value: ViewLayer) => {
    if (compare) return value === compareLayer ? 3 : 2;
    if (lens) return value === renderedLensRoles.inner ? 3 : 2;
    return value === 'after' ? 2 : 1;
  };
  const imageLayer = (value: ViewLayer, imageElement: React.RefObject<HTMLDivElement>) => {
    const activeTransition = singleTransition;
    const clipPath = imageClipPath(value);
    const lensClipDuration = lens && lensTransition?.phase === 'expand' && value === lensTransition.from.inner
      ? (reducedMotion ? 0 : .28)
      : 0;
    const lensOpacityDuration = lens && lensTransition?.phase === 'crossfade' && value === lensTransition.from.outer
      ? (reducedMotion ? 0 : .32)
      : 0;
    return (
      <motion.div
        className={`image-layer image-layer-${value}${value === renderedLensRoles.inner && lens ? ' lens-image-layer' : ''}`}
        style={{zIndex: imageZIndex(value), ...(lens ? {} : {clipPath}), pointerEvents: value === layer ? 'auto' : 'none'}}
        initial={false}
        animate={lens ? {opacity: imageOpacity(value), clipPath} : {opacity: imageOpacity(value)}}
        transition={lens
          ? {
              opacity: {duration: lensOpacityDuration, ease: 'easeInOut'},
              clipPath: {duration: lensClipDuration, ease: 'easeInOut'},
            }
          : {duration: isSingle && activeTransition ? (reducedMotion ? 0 : .2) : 0, ease: 'easeInOut'}}
        onAnimationComplete={() => {
          const currentSingle = singleTransitionRef.current;
          if (isSingle && currentSingle?.to === value) finishSingleTransition(currentSingle.id);
          const currentLens = lensTransitionRef.current;
          if (!lens || !currentLens || currentLens.id !== lensTransition?.id) return;
          if (currentLens.phase === 'expand' && value === currentLens.from.inner) {
            const next: LensTransition = {...currentLens, phase: 'crossfade-prep'};
            lensTransitionRef.current = next;
            setLensTransition(next);
          } else if (currentLens.phase === 'crossfade' && value === currentLens.from.outer) {
            finishLensTransition(currentLens.id);
          }
        }}
      >
        <div ref={imageElement} className={`viewer ${value === 'pre' ? 'viewer-base' : 'viewer-compare'}`} />
      </motion.div>
    );
  };
  return (
    <div
      className={`canvas-wrap${annotationMode && layer === 'after' ? ' viewer-annotation-mode' : ''}`}
      data-grid-detail={gridDetail}
      onPointerDownCapture={handleCanvasPointerDown}
      onPointerMoveCapture={handleCanvasPointerMove}
      onPointerUpCapture={handleCanvasPointerUp}
      onPointerCancelCapture={handleCanvasPointerCancel}
      onClickCapture={handleCanvasClickCapture}
      onClick={handleCanvasClick}
    >
      {imageLayer('pre', element)}
      {imageLayer('after', compareElement)}
      <canvas ref={pitCanvas} className="pit-overlay" aria-hidden="true" />
      <div ref={annotationLayer} className="manual-overlay-layer" aria-label="人工赋值点" />
      {compare && (
        <>
          <div className="compare-divider" style={{left: `${comparePosition}%`}} onPointerDown={handleComparePointerDown} aria-hidden="true">
            <span><SwapOutlined /></span>
          </div>
          <input
            className="compare-range"
            aria-label="动态对比分界位置"
            type="range"
            min={5}
            max={95}
            value={comparePosition}
            onChange={(event) => onComparePosition(Number(event.target.value))}
          />
          <div className="compare-label compare-label-pre">{layerLabel(layer)}</div>
          <div className="compare-label compare-label-after">{layerLabel(compareLayer)}</div>
        </>
      )}
      <AnimatePresence initial={false}>
        {lens && (
          <>
            <motion.div
              ref={lensWindowNode}
              className={`lens-window${lensFixed ? ' is-fixed' : ''}`}
              initial={{opacity: 0}}
              animate={{opacity: 1}}
              exit={{opacity: 0}}
              transition={{duration: reducedMotion ? 0 : .15}}
              style={{left: lensX, top: lensY, width: lensSize, height: lensSize}}
              onPointerDown={handleLensPointerDown}
              aria-label={`${lensFixed ? '固定' : '跟随鼠标'}透镜，内部${layerLabel(renderedLensRoles.inner)}`}
            >
              <span className="lens-window-label">内部 · {layerLabel(renderedLensRoles.inner)}</span>
            </motion.div>
            <motion.div className="lens-label lens-label-outer" initial={{opacity: 0, y: -3}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: -3}} transition={{duration: reducedMotion ? 0 : .15}}>外部 · {layerLabel(renderedLensRoles.outer)}</motion.div>
          </>
        )}
      </AnimatePresence>
      <div className={`coverage ${tileError && !transitionPending ? 'coverage-error' : ''}${transitionPending ? ' coverage-preparing' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        {transitionPending ? <>
          <strong>正在切换至{layerLabel(transitionPending)}…</strong>
          <span className="coverage-detail">{preparingText(layerLabel(transitionPending), loadProgress)}</span>
          {tileRetryingRef.current[transitionPending] && <span className="coverage-detail">部分图像正在重试，恢复后将自动切换</span>}
        </> : tileError ? '部分切片暂未加载，正在自动重试…' : outside ? '当前视野超出该图层范围' : gridPoints.length > 0 && (showGrid || showPits) && gridDetail === 'overview' ? '采样区域概览 · 点击或放大查看方格' : gridPoints.length > 0 && (showGrid || showPits) && gridDetail === 'grid' ? '4×4 区域格 · 每格最多 16 个采样点 · 放大后查询单点' : gridSampled && showGrid ? '当前数据已抽稀显示' : compare ? '双图卷帘对比' : lens ? '局部透镜对比' : '前后图像对齐'}
        {transitionPending && <span className="coverage-progress" aria-hidden="true"><span /></span>}
      </div>
    </div>
  );
}

function preparingText(label: string, progress: {loaded: number; seconds: number; slow: boolean} | null) {
  const base = `正在准备${label}当前视野`;
  if (!progress || progress.seconds < 1) return `${base}，就绪后自动显示`;
  const detail = progress.loaded > 0 ? `本次新增载入 ${progress.loaded} 块 · 已等待 ${progress.seconds}s` : `已等待 ${progress.seconds}s`;
  return progress.slow ? `加载耗时较长，仍在处理中 · ${detail}` : detail;
}
