import {useEffect, useState} from 'react';
import {Alert, Button, Space, Spin, Table, Typography} from 'antd';
import {apiFetch, errorText} from '../api';
import {useI18n} from '../i18n';

type Spectrum = {spot_id: number; mz: number[]; intensities: number[]};

/** The ID is the SBD file spot ID returned by the calibrated nearest-spot API. */
export function SpotSpectrum({projectId, spotId, onOpenData}: {
  projectId: string; spotId: number; onOpenData: () => void;
}) {
  const {language} = useI18n();
  const text = (zh: string, en: string) => language === 'zh' ? zh : en;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{data?: Spectrum; error?: unknown; loading: boolean}>({loading: true});
  useEffect(() => {
    const controller = new AbortController();
    setState({loading: true});
    void apiFetch<Spectrum>(`/projects/${encodeURIComponent(projectId)}/spectra/spots/${spotId}`, {signal: controller.signal})
      .then(data => { if (!controller.signal.aborted) setState({data, loading: false}); })
      .catch(error => { if (!controller.signal.aborted) setState({error, loading: false}); });
    return () => controller.abort();
  }, [projectId, spotId, revision]);
  const data = state.data;
  const exportCsv = () => {
    if (!data) return;
    const rows = ['spot_id,mz,intensity', ...data.mz.map((mz, index) => `${data.spot_id},${mz},${data.intensities[index]}`)];
    const url = URL.createObjectURL(new Blob(['﻿', rows.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `spot-${data.spot_id}-spectrum.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="inspector-section spot-spectrum" data-spot-id={spotId}>
    <div className="inspector-label">{text('该点质谱', 'Spot mass spectrum')}</div>
    {state.loading && <Space role="status"><Spin size="small" /><span>{text('读取该点完整光谱…', 'Reading full spot spectrum…')}</span></Space>}
    {state.error != null && <>
      <Alert type="warning" showIcon message={text('该点光谱暂不可用', 'Spot spectrum unavailable')} description={errorText(state.error, language)} />
      <Button size="small" onClick={onOpenData}>{text('检查或关联完整 SBD', 'Check or attach full SBD')}</Button>
    </>}
    {data && <>
      <Typography.Paragraph>{text(`点位 ${data.spot_id} · ${data.mz.length.toLocaleString()} 个峰 · 原始强度`, `Spot ${data.spot_id} · ${data.mz.length.toLocaleString()} peaks · raw intensity`)}</Typography.Paragraph>
      <Table size="small" rowKey="index" dataSource={data.mz.map((mz, index) => ({index, mz, intensity: data.intensities[index]}))}
        pagination={{defaultPageSize: 10, showSizeChanger: false, simple: true, size: 'small'}}
        columns={[
          {title: 'm/z', dataIndex: 'mz', render: (value: number) => <span title={String(value)}>{value.toFixed(6)}</span>},
          {title: text('强度', 'Intensity'), dataIndex: 'intensity', sorter: (a, b) => a.intensity - b.intensity},
        ]} />
      <Button size="small" onClick={exportCsv}>{text('下载该点全部光谱 CSV', 'Download full spot spectrum CSV')}</Button>
    </>}
    <Button size="small" type="link" disabled={state.loading} onClick={() => setRevision(value => value + 1)}>{text('重新读取', 'Reload')}</Button>
  </div>;
}
