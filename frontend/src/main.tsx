import React, {Suspense, lazy, useEffect, useRef, useState} from 'react';
import ReactDOM from 'react-dom/client';
import {AnimatePresence, motion} from 'motion/react';
import GradientASCII from './components/GradientASCII';
import {parseRoute} from './flow';
import type {AppRoute} from './flow';
import type {Project, DemoInfo} from './types';
import {apiFetch, errorText} from './api';
import {ProjectHome} from './components/ProjectHome';
import {ProcessingScreen, FailedProjectScreen} from './components/StatusScreens';
import {TranslatedText, LanguageProvider, useI18n} from './i18n';
import 'antd/dist/reset.css';
import './styles.css';

// The workbench pulls in OpenSeadragon and the canvas viewer; load it only
// when a project is opened so the home page stays light.
const Workbench = lazy(() => import('./components/Workbench').then((module) => ({default: module.Workbench})));

function RedesignedApp() {
  const {t, language} = useI18n();
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const routeMotionDuration = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : .2;

  const navigateHome = () => {
    if (window.location.hash !== '#/') window.location.hash = '#/';
    else setRoute({kind: 'home'});
  };
  const navigateProject = (id: string) => {
    const hash = `#/projects/${encodeURIComponent(id)}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    else setRoute({kind: 'project', id});
  };

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [projectsResult, demoResult] = await Promise.allSettled([
        apiFetch<Project[]>('/projects'),
        apiFetch<DemoInfo>('/demo'),
      ]);
      if (!active) return;
      if (projectsResult.status === 'fulfilled') setProjects(projectsResult.value);
      else setHomeError(errorText(projectsResult.reason));
      if (demoResult.status === 'fulfilled') {
        const demo = demoResult.value;
        setDemoAvailable(demo.available);
      } else if (projectsResult.status === 'fulfilled') {
        // Keep the project list usable when only the optional demo endpoint
        // is unavailable.
        setHomeError(errorText(demoResult.reason));
      }
      if (projectsResult.status === 'fulfilled' && demoResult.status === 'fulfilled') setHomeError('');
    };
    load();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (route.kind !== 'project') {
      setProjectLoading(false);
      setConnectionError('');
      return;
    }
    const version = ++requestVersion.current;
    let active = true;
    setProjectLoading(true);
    setConnectionError('');
    setActiveProject(null);
    apiFetch<Project>(`/projects/${encodeURIComponent(route.id)}`)
      .then((item) => {
        if (active && version === requestVersion.current) {
          setHomeError('');
          setActiveProject(item);
          setProjects((items) => items.some((existing) => existing.id === item.id)
            ? items.map((existing) => existing.id === item.id ? {...existing, ...item} : existing)
            : [item, ...items]);
        }
      })
      .catch((error) => {
        if (!active || version !== requestVersion.current) return;
        setHomeError(errorText(error));
        navigateHome();
      })
      .finally(() => { if (active && version === requestVersion.current) setProjectLoading(false); });
    return () => { active = false; };
  }, [route.kind, route.kind === 'project' ? route.id : '']);

  useEffect(() => {
    if (route.kind !== 'project' || !activeProject || activeProject.id !== route.id || !['queued', 'running'].includes(activeProject.status)) return;
    let active = true;
    let timer: number | undefined;
    let delay = 900;
    const poll = async () => {
      try {
        const item = await apiFetch<Project>(`/projects/${activeProject.id}`);
        if (!active) return;
        setActiveProject(item);
        setProjects((items) => items.some((existing) => existing.id === item.id)
          ? items.map((existing) => existing.id === item.id ? {...existing, ...item} : existing)
          : [item, ...items]);
        setConnectionError('');
        delay = 900;
      } catch {
        if (active) setConnectionError('offline');
        delay = Math.min(delay * 2, 8000);
      } finally {
        if (active) timer = window.setTimeout(poll, delay);
      }
    };
    timer = window.setTimeout(poll, 0);
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [activeProject?.id, activeProject?.status, route.kind, route.kind === 'project' ? route.id : '']);

  const hasProcessingProjects = projects.some((item) => ['queued', 'running'].includes(item.status));
  useEffect(() => {
    const viewingProcessingProject = route.kind === 'project' && activeProject?.id === route.id &&
      Boolean(activeProject && ['queued', 'running'].includes(activeProject.status));
    if (viewingProcessingProject || !hasProcessingProjects) return;
    let active = true;
    let timer: number | undefined;
    let delay = 2400;
    const refresh = async () => {
      try {
        const items = await apiFetch<Project[]>('/projects');
        if (active) {
          setProjects(items);
          setActiveProject((current) => current && items.some((item) => item.id === current.id)
            ? {...current, ...items.find((item) => item.id === current.id)}
            : current);
          setHomeError('');
        }
        delay = 2400;
      } catch {
        // The next scheduled refresh retries without repeatedly surfacing a
        // toast while the processing task continues in the backend.
        if (active) setHomeError(t.main.refreshFailed);
        delay = Math.min(delay * 2, 8000);
      } finally {
        if (active) timer = window.setTimeout(refresh, delay);
      }
    };
    timer = window.setTimeout(refresh, delay);
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [activeProject?.id, activeProject?.status, hasProcessingProjects, route.kind === 'project' ? route.id : '', t.main.refreshFailed]);

  const startDemo = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setHomeError('');
    try {
      const item = await apiFetch<Project>('/demo', {method: 'POST'});
      setActiveProject(item);
      setProjects((items) => [item, ...items.filter((existing) => existing.id !== item.id)]);
      navigateProject(item.id);
    } catch (error) {
      setHomeError(errorText(error, language));
    } finally { busyRef.current = false; setBusy(false); }
  };
  const retryProject = async (item: Project) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setHomeError('');
    try {
      const retried = await apiFetch<Project>(`/projects/${encodeURIComponent(item.id)}/retry`, {method: 'POST'});
      setActiveProject(retried);
      setProjects((items) => [retried, ...items.filter((existing) => existing.id !== retried.id)]);
      navigateProject(retried.id);
    } catch (error) {
      setHomeError(errorText(error, language));
    } finally { busyRef.current = false; setBusy(false); }
  };
  const handleUploadedProject = (item: Project) => {
    setActiveProject(item);
    setProjects((items) => [item, ...items.filter((existing) => existing.id !== item.id)]);
    navigateProject(item.id);
  };
  const openProject = (item: Project) => { setActiveProject(null); navigateProject(item.id); };

  const routeLoading = (
    <div className="route-loading" aria-busy="true">
      <GradientASCII />
      <span className="route-loading__label" role="status"><TranslatedText text={t.main.loadingProject} /></span>
    </div>
  );
  let content: React.ReactNode;
  if (route.kind === 'home') {
    content = <ProjectHome projects={projects} currentProject={activeProject} onProject={handleUploadedProject} onDemo={startDemo} demoAvailable={demoAvailable} onOpen={openProject} onRetry={retryProject} busy={busy} error={homeError || undefined} />;
  } else if (projectLoading || !activeProject) {
    content = routeLoading;
  } else if (activeProject.status === 'failed') {
    content = <FailedProjectScreen project={activeProject} onHome={navigateHome} onRetry={() => retryProject(activeProject)} busy={busy} error={homeError || undefined} />;
  } else if (activeProject.status === 'ready' && !activeProject.report) {
    content = <FailedProjectScreen project={activeProject} onHome={navigateHome} onRetry={() => retryProject(activeProject)} busy={busy} error={t.main.missingReport} />;
  } else if (activeProject.status !== 'ready') {
    content = <ProcessingScreen project={activeProject} onHome={navigateHome} connectionError={connectionError || undefined} />;
  } else {
    content = <Suspense fallback={routeLoading}><Workbench project={activeProject} onHome={navigateHome} /></Suspense>;
  }
  return <AnimatePresence initial={false} mode="wait"><motion.div key={route.kind === 'home' ? 'home' : `project-${route.id}-${activeProject?.status ?? 'loading'}`} className="screen-transition" initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}} transition={{duration: routeMotionDuration}}>{content}</motion.div></AnimatePresence>;
}

const appRoot = ReactDOM.createRoot(document.getElementById('root')!);
appRoot.render(
  <LanguageProvider>
    <RedesignedApp />
  </LanguageProvider>
);
const hotModule = (import.meta as ImportMeta & {hot?: {dispose: (callback: () => void) => void}}).hot;
hotModule?.dispose(() => appRoot.unmount());
