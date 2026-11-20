import assert from 'node:assert/strict';
import test from 'node:test';
import {hasViewport, parseRoute, projectName, projectStatusLabel, selectInitialViewport} from '../src/flow.ts';

test('hash routes preserve project ids and fall back to home', () => {
  assert.deepEqual(parseRoute('#/'), {kind: 'home'});
  assert.deepEqual(parseRoute('#/projects/a%2Fb'), {kind: 'project', id: 'a/b'});
  assert.deepEqual(parseRoute('#/unknown'), {kind: 'home'});
});

test('project summaries use the source directory and explicit status labels', () => {
  assert.equal(projectName({id: '123456789', source_dir: '/tmp/sample-data', status: 'ready'}), 'sample-data');
  assert.equal(projectName({id: '123456789', project_name: '上传项目', source_dir: '/tmp/upload-id', status: 'ready'}), '上传项目');
  assert.equal(projectName({id: '123456789', project_name: '内置示例', source_dir: '/tmp/sample-data', status: 'ready'}), 'DEMO');
  assert.equal(projectName({id: '123456789', status: 'ready'}), '项目 12345678');
  assert.equal(projectName({id: '123456789', status: 'ready'}, 'en'), 'Project 12345678');
  assert.equal(projectStatusLabel('queued'), '排队中');
  assert.equal(projectStatusLabel('running'), '处理中');
  assert.equal(projectStatusLabel('ready'), '已就绪');
  assert.equal(projectStatusLabel('failed'), '处理失败');
  assert.equal(projectStatusLabel('assembling'), '文件合并中');

  assert.equal(projectStatusLabel('queued', 'en'), 'Queued');
  assert.equal(projectStatusLabel('running', 'en'), 'Processing');
  assert.equal(projectStatusLabel('ready', 'en'), 'Ready');
  assert.equal(projectStatusLabel('failed', 'en'), 'Failed');
  assert.equal(projectStatusLabel('assembling', 'en'), 'Assembling');
});

test('only a valid tab session supplies the initial viewport', () => {
  const session = {viewport: {x: 4, y: 5, zoom: 6}};
  assert.deepEqual(selectInitialViewport(session), session.viewport);
  assert.deepEqual(selectInitialViewport(null), {});
  assert.deepEqual(selectInitialViewport({viewport: {x: 1, y: 2}}), {});
  assert.deepEqual(selectInitialViewport({viewport: {x: 1, y: 2, zoom: NaN}}), {});
  assert.equal(hasViewport(session.viewport), true);
  assert.equal(hasViewport({x: 1, y: 2}), false);
});
