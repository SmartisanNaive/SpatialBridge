import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Button, Descriptions, Input, Select, Space, Table, Typography} from 'antd';
import {apiFetch, errorText} from '../api';
import {useI18n} from '../i18n';
import './SpectraPanel.css';

type Summary = {
  available: boolean; reason?: string; filename?: string; spot_count?: number; mz_count?: number;
  mz_min?: number; mz_max?: number; producer?: string; version?: number | null;
  normalizations: {id: string; name: string}[];
  mean_spectra: {id: string; region_id: string; normalization_id: string | null}[];
  regions: {id: string; name: string; spot_count: number}[];
  spot_spectra_available: boolean;
};
type Spectrum = {mz: number[]; intensities: number[]; spot_id?: number; region_id?: string; normalization_id?: string | null};
type Ions = {
  spot_ids: number[]; coordinates: number[][]; rasters: number[];
  channels: {mz: number; tolerance: number; unit: 'ppm' | 'Da'; mz_min: number; mz_max: number; bin_count: number; intensities: number[]}[];
  normalization: string | null; aggregation: 'sum' | 'max';
};

// Abort superseded requests and gate every completion against both query and request identity.
function useQuery<T>(key: string) {
  const currentKey = useRef(key);
  currentKey.current = key;
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<{key: string; data?: T; error?: unknown; loading: boolean}>({key, loading: false});
  useEffect(() => {
    controller.current?.abort();
    return () => { controller.current?.abort(); };
  }, [key]);
  const run = useCallback(async (path: string, init?: RequestInit) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({key, loading: true});
    try {
      const data = await apiFetch<T>(path, {...init, signal: request.signal});
      if (request.signal.aborted || currentKey.current !== key || controller.current !== request) return;
      setState({key, data, loading: false});
      return data;
    } catch (error) {
      if (!request.signal.aborted && currentKey.current === key && controller.current === request) setState({key, error, loading: false});
    }
  }, [key]);
  return {...(state.key === key ? state : {key, data: undefined, error: undefined, loading: false}), run};
}

function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const escape = (value: string | number | null | undefined) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const blob = new Blob(['﻿', rows.map(row => row.map(escape).join(',')).join('\r\n')], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SpectraPanel({projectId}: {projectId: string}) {
  const {language} = useI18n();
  const text = (zh: string, en: string) => language === 'zh' ? zh : en;
  const base = `/projects/${encodeURIComponent(projectId)}/spectra`;
  const [sourceVersion, setSourceVersion] = useState(0);
  const [path, setPath] = useState('');
  const [meanId, setMeanId] = useState<string>();
  const [spotId, setSpotId] = useState('');
  const [masses, setMasses] = useState('726.5025');
  const [tolerance, setTolerance] = useState('5');
  const [unit, setUnit] = useState<'ppm' | 'Da'>('ppm');
  const [aggregation, setAggregation] = useState<'sum' | 'max'>('sum');
  const [normalization, setNormalization] = useState<string>('');
  const [region, setRegion] = useState<string>('');
  const scope = `${projectId}:${sourceVersion}`;
  const summary = useQuery<Summary>(scope);
  const attachment = useQuery<Summary>(`${projectId}:${path}`);
  const mean = useQuery<Spectrum>(`${scope}:${meanId ?? ''}`);
  const spot = useQuery<Spectrum>(`${scope}:${spotId}`);
  const ions = useQuery<Ions>(JSON.stringify([scope, masses, tolerance, unit, aggregation, normalization, region]));
  useEffect(() => { void summary.run(base); }, [base, summary.run]);
  useEffect(() => {
    setPath(''); setMeanId(undefined); setSpotId(''); setNormalization(''); setRegion('');
  }, [projectId]);
  useEffect(() => {
    setMeanId(undefined); setNormalization(''); setRegion('');
  }, [sourceVersion]);
  const info = summary.data;
  const available = !!info?.available && !summary.loading && !attachment.loading;
  const parsedMasses = masses.split(',').map(value => Number(value.trim()));
  const validTargets = masses.split(',').every(value => value.trim() !== '') && parsedMasses.length <= 32
    && parsedMasses.every(value => Number.isFinite(value) && value > 0) && tolerance.trim() !== '' && Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0;
  const validSpot = /^\d+$/.test(spotId.trim()) && Number.isSafeInteger(Number(spotId));
  const ionRows = useMemo(() => ions.data?.spot_ids.map((id, index) => ({
    key: index, spot_id: id, x: ions.data!.coordinates[index]?.[0], y: ions.data!.coordinates[index]?.[1],
    raster: ions.data!.rasters[index], values: ions.data!.channels.map(channel => channel.intensities[index]),
  })) ?? [], [ions.data]);
  const strongest = useMemo(() => [...ionRows].sort((a, b) => Math.max(...b.values) - Math.max(...a.values)).slice(0, 50), [ionRows]);
  const error = (value: unknown) => value ? <Alert type="error" showIcon message={errorText(value, language)} /> : null;
  const spectrumView = (result: typeof mean, name: string) => result.data && <>
    <Typography.Text>{text('数据点数', 'Data points')}: {result.data.mz.length}</Typography.Text>
    <Button onClick={() => downloadCsv(`${name}.csv`, [['mz', 'intensity'], ...result.data!.mz.map((mz, i) => [mz, result.data!.intensities[i]])])}>{text('下载 CSV（全部数据）', 'Download CSV (all data)')}</Button>
    <Table size="small" pagination={false} dataSource={result.data.mz.slice(0, 20).map((mz, i) => ({key: i, mz, intensity: result.data!.intensities[i]}))}
      columns={[{title: 'm/z', dataIndex: 'mz'}, {title: text('强度', 'Intensity'), dataIndex: 'intensity'}]} />
    <Typography.Text type="secondary">{text('预览前 20 个数据点；CSV 包含全部数据。', 'Preview of the first 20 points; CSV contains all data.')}</Typography.Text>
  </>;
  return <div className="spectra-panel">
    <section>
      <div className="spectra-heading"><Typography.Title level={4}>{text('光谱状态', 'Spectral data status')}</Typography.Title><Button loading={summary.loading} onClick={() => { setSourceVersion(v => v + 1); }}>{text('刷新', 'Refresh')}</Button></div>
      {error(summary.error)}
      {info && <>
        <Alert type={info.available ? 'success' : 'warning'} showIcon message={info.available ? text('光谱数据可读取', 'Spectral data available') : text('光谱不可用', 'Spectral data unavailable')} description={info.reason} />
        <Descriptions column={1} size="small" items={[
          {key: 'file', label: text('文件', 'File'), children: info.filename ?? '—'},
          {key: 'spots', label: text('点数 / m/z 数', 'Spots / m/z bins'), children: `${info.spot_count ?? '—'} / ${info.mz_count ?? '—'}`},
          {key: 'range', label: text('m/z 范围', 'm/z range'), children: `${info.mz_min ?? '—'} – ${info.mz_max ?? '—'}`},
          {key: 'producer', label: text('生成程序 / 版本', 'Producer / version'), children: `${info.producer ?? '—'} / ${info.version ?? '—'}`},
          {key: 'spot', label: text('单点光谱', 'Spot spectra'), children: info.spot_spectra_available ? text('可用', 'Available') : text('不可用', 'Unavailable')},
        ]} />
      </>}
      <label htmlFor="spectra-source">{text('关联完整 SBD 的服务器本地路径', 'Attach full SBD by local server path')}</label>
      <Input id="spectra-source" value={path} onChange={e => setPath(e.target.value)} placeholder="/absolute/path/data.sbd" />
      <Typography.Text type="secondary">{text('填写服务器可访问的完整文件路径，不是浏览器所在设备的路径。已有精简文件不包含完整光谱。', 'Enter the full file path accessible to the server. A compact file does not contain full spectra.')}</Typography.Text>
      <Button loading={attachment.loading} disabled={!path.trim()} onClick={async () => {
        const result = await attachment.run(`${base}/source`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: path.trim()})});
        if (result) setSourceVersion(v => v + 1);
      }}>{text('关联文件', 'Attach file')}</Button>
      {error(attachment.error)}
    </section>
    <Alert type="info" showIcon message={text('数值解释', 'Interpreting values')} description={text('稀疏数据中缺失的值填为 0，不保证为物理零值。保存的归一化采用强度除以存储因子，属于实验性处理。', 'Missing sparse values are filled with 0; this does not guarantee a physical zero. Saved normalization divides intensity by the stored factor and is experimental.')} />
    <section>
      <Typography.Title level={4}>{text('质谱 / 平均光谱', 'Mass / mean spectra')}</Typography.Title>
      <label htmlFor="spectra-mean">{text('已保存的平均光谱（区域 / 归一化）', 'Saved mean spectrum (region / normalization)')}</label>
      <Select id="spectra-mean" value={meanId} disabled={!available} placeholder={text('选择平均光谱', 'Select mean spectrum')} onChange={setMeanId}
        options={(info?.mean_spectra ?? []).map(item => ({value: item.id, label: `${item.id} · ${info?.regions.find(r => r.id === item.region_id)?.name ?? item.region_id ?? text('全部区域', 'All regions')} · ${info?.normalizations.find(n => n.id === item.normalization_id)?.name ?? item.normalization_id ?? text('原始强度', 'Raw')}`}))} />
      <Button disabled={!available || !meanId} loading={mean.loading} onClick={() => void mean.run(`${base}/mean?id=${encodeURIComponent(meanId!)}`)}>{text('读取平均光谱', 'Read mean spectrum')}</Button>
      {available && !info?.mean_spectra.length && <Typography.Text type="secondary">{text('没有已保存的平均光谱。', 'No saved mean spectra.')}</Typography.Text>}
      {error(mean.error)}{spectrumView(mean, 'mean-spectrum')}
    </section>
    <section>
      <Typography.Title level={4}>{text('单点光谱', 'Spot spectrum')}</Typography.Title>
      <label htmlFor="spectra-spot">{text('点 ID', 'Spot ID')}</label>
      <Input id="spectra-spot" value={spotId} onChange={e => setSpotId(e.target.value)} inputMode="numeric" />
      <Button disabled={!available || !info?.spot_spectra_available || !validSpot} loading={spot.loading} onClick={() => void spot.run(`${base}/spots/${Number(spotId)}`)}>{text('查询单点', 'Query spot')}</Button>
      {error(spot.error)}{spectrumView(spot, `spot-${spotId}`)}
    </section>
    <section>
      <Typography.Title level={4}>{text('多目标离子提取', 'Multi-target ion extraction')}</Typography.Title>
      <Typography.Text type="secondary">{text('窗口按全局质量轴的分箱中心筛选，包含上下界；单点光谱的 m/z 精度更高，窄窗口结果可能不同。无命中分箱时返回 0，不自动改取最近质量点。', 'Windows select global mass-bin centers, including both bounds. Spot spectra have more precise m/z values, so narrow windows may differ. Windows with no matching bins return 0 without selecting a nearest bin.')}</Typography.Text>
      <label htmlFor="spectra-masses">{text('目标 m/z（逗号分隔，最多 32 个）', 'Target m/z (comma separated, up to 32)')}</label>
      <Input id="spectra-masses" value={masses} onChange={e => setMasses(e.target.value)} />
      <label htmlFor="spectra-tolerance">{text('容差', 'Tolerance')}</label>
      <Space.Compact block><Input id="spectra-tolerance" value={tolerance} onChange={e => setTolerance(e.target.value)} inputMode="decimal" /><Select aria-label={text('容差单位', 'Tolerance unit')} value={unit} onChange={setUnit} options={[{value: 'ppm', label: 'ppm'}, {value: 'Da', label: 'Da'}]} /></Space.Compact>
      <label htmlFor="spectra-aggregation">{text('窗口内聚合', 'Aggregation within window')}</label>
      <Select id="spectra-aggregation" value={aggregation} onChange={setAggregation} options={[{value: 'sum', label: text('求和', 'Sum')}, {value: 'max', label: text('最大值', 'Max')}]} />
      <label htmlFor="spectra-normalization">{text('归一化', 'Normalization')}</label>
      <Select id="spectra-normalization" value={normalization} onChange={setNormalization} options={[{value: '', label: text('原始强度', 'Raw intensity')}, ...(info?.normalizations ?? []).map(n => ({value: n.id, label: n.name}))]} />
      <label htmlFor="spectra-region">{text('区域（可选）', 'Region (optional)')}</label>
      <Select id="spectra-region" value={region} onChange={setRegion} options={[{value: '', label: text('全部区域', 'All regions')}, ...(info?.regions ?? []).map(r => ({value: r.id, label: `${r.name} (${r.spot_count})`}))]} />
      {!validTargets && <Typography.Text type="danger">{text('请输入 1–32 个正数 m/z 和非负容差。', 'Enter 1–32 positive m/z values and a nonnegative tolerance.')}</Typography.Text>}
      <Button type="primary" disabled={!available || !validTargets} loading={ions.loading} onClick={() => void ions.run(`${base}/ions`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({targets: parsedMasses.map(mz => ({mz, tolerance: Number(tolerance), unit})), aggregation, normalization: normalization || null, region: region || null})})}>{text('提取离子数值', 'Extract ion values')}</Button>
      {error(ions.error)}
      {ions.data && <>
        <Typography.Text>{text('各通道窗口与命中 bin 数', 'Channel windows and matching bin counts')}</Typography.Text>
        {ions.data.channels.map((c, i) => <Typography.Text key={i}>{i + 1}: m/z {c.mz} ± {c.tolerance} {c.unit} · [{c.mz_min}, {c.mz_max}] · {c.bin_count} bins</Typography.Text>)}
        <Typography.Text>{text('按各点最强通道降序，显示前 50 个点', 'Top 50 points, ranked by their strongest channel')} ({ionRows.length} {text('点', 'points')})</Typography.Text>
        <Typography.Text type="secondary">{text('X / Y 为 SBD 原始网格坐标。', 'X / Y are original SBD grid coordinates.')}</Typography.Text>
        <Button onClick={() => downloadCsv('ion-values.csv', [
          ['spot_id', 'x', 'y', 'raster', ...ions.data!.channels.map((c, i) => `channel_${i + 1}_mz_${c.mz}_${c.tolerance}${c.unit}`), 'normalization', 'aggregation'],
          ...ionRows.map(row => [row.spot_id, row.x, row.y, row.raster, ...row.values, ions.data!.normalization, ions.data!.aggregation]),
        ])}>{text('下载 CSV（全部点、坐标及通道）', 'Download CSV (all points, coordinates and channels)')}</Button>
        <Table size="small" pagination={false} scroll={{x: 'max-content'}} dataSource={strongest} columns={[
          {title: text('点 ID', 'Spot ID'), dataIndex: 'spot_id'}, {title: 'X', dataIndex: 'x'}, {title: 'Y', dataIndex: 'y'}, {title: 'Raster', dataIndex: 'raster'},
          ...ions.data.channels.map((c, i) => ({title: `${i + 1}: m/z ${c.mz}`, key: `channel-${i}`, render: (_: unknown, row: typeof ionRows[number]) => row.values[i]})),
        ]} />
      </>}
    </section>
  </div>;
}
