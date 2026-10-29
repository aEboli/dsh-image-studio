import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEnhance,
  appendRatioHint,
  applyVariables,
  composeFieldset,
  composePrompt,
  extractVariables,
  resolveVariables
} from '../lib/compose.js'

test('extractVariables 抽取 name/default 且去重', () => {
  const body = 'A {argument name="ratio" default="9:16"} B {argument name="ratio" default="9:16"} C {argument name="place" default="Paris"}'
  const vars = extractVariables(body)
  assert.deepEqual(
    vars.map((v) => v.name),
    ['ratio', 'place']
  )
  assert.equal(vars[0].default, '9:16')
})

test('applyVariables 替换并回落默认值', () => {
  const body = '画幅 {argument name="ratio" default="9:16"}，地点 {argument name="place" default="Paris"}'
  assert.equal(applyVariables(body, { ratio: '3:4' }), '画幅 3:4，地点 Paris')
  assert.equal(applyVariables(body, {}), '画幅 9:16，地点 Paris')
})

test('applyVariables 不把未声明的变量当占位符', () => {
  assert.equal(applyVariables('{notAVariable}', { notAVariable: 'x' }), '{notAVariable}')
})

test('resolveVariables 只保留模板声明过的变量', () => {
  const body = '{argument name="ratio" default="1:1"}'
  assert.deepEqual(resolveVariables(body, { ratio: '4:5', extra: 'x' }), { ratio: '4:5' })
  assert.deepEqual(resolveVariables(body, {}), { ratio: '1:1' })
})

test('composeFieldset 拼中文标签行、跳过空值、保持顺序', () => {
  const fields = [
    { key: 'theme', label: '主题风格' },
    { key: 'makeup', label: '妆感目标' },
    { key: 'extra', label: '补充要求' }
  ]
  const text = composeFieldset(fields, {
    theme: '古风贵女高饱和美妆封面',
    makeup: '  ',
    extra: '红、白、墨青形成鲜明层次'
  })
  assert.equal(text, '主题风格：古风贵女高饱和美妆封面\n补充要求：红、白、墨青形成鲜明层次')
})

test('appendRatioHint 幂等', () => {
  const once = appendRatioHint('一只猫', '16:9')
  assert.equal(once, '一只猫\n\nAspect ratio: 16:9.')
  assert.equal(appendRatioHint(once, '16:9'), once)
})

test('applyEnhance 与上游一致：换行拼接 / 逗号开头不换行 / 空文本不拼', () => {
  assert.equal(applyEnhance('猫', 'Quality only.'), '猫\n\nQuality only.')
  assert.equal(applyEnhance('猫', ', quality'), '猫, quality')
  assert.equal(applyEnhance('猫', '   '), '猫')
})

test('composePrompt：模板 + 变量 + 比例 + 增强 全链路', () => {
  const result = composePrompt({
    body: '主题：古风\n画幅比例：{argument name="ratio" default="9:16"}',
    variables: { ratio: '3:4' },
    ratio: '3:4',
    enhance: 'Quality only.'
  })
  assert.equal(
    result.prompt,
    '主题：古风\n画幅比例：3:4\n\nAspect ratio: 3:4.\n\nQuality only.'
  )
  assert.equal(result.parts.template, '主题：古风\n画幅比例：3:4')
  assert.equal(result.parts.enhance, 'Quality only.')
})

test('composePrompt：字段集路径', () => {
  const result = composePrompt({
    fields: [{ key: 'a', label: '甲' }],
    fieldValues: { a: '一' }
  })
  assert.equal(result.prompt, '甲：一')
  assert.equal(result.parts.fields, '甲：一')
})

test('composePrompt：三者都给时模板优先', () => {
  const result = composePrompt({
    body: '模板',
    fields: [{ key: 'a', label: '甲' }],
    fieldValues: { a: '一' },
    prompt: '直给'
  })
  assert.equal(result.prompt, '模板')
})

test('composePrompt：空输入得到空串而不是 undefined', () => {
  const result = composePrompt({})
  assert.equal(result.prompt, '')
  assert.deepEqual(result.parts, {})
})
