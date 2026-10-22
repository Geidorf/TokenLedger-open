import { invoke } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { installDevMockTauri } from '../../devMockTauri';
import type { AppSettings, CostProfile, CostProfileFieldError, CostSubscriptionPlan } from '../../types';
import {
  COST_PROFILE_DEFAULT_CNY_PER_USD,
  CostProfileContractError,
  checkCostProfileInput,
  clearCostProfile,
  costProfileInput,
  getCostProfile,
  isCostProfileCleared,
  parseCostProfile,
  parseCostProfileClearResult,
  parseCostProfileSaveResult,
  parseCostProfileValidation,
  saveCostProfile,
  validateCostProfile,
} from './costProfile';

// 订阅设置契约（T10.188）：原生返回值失败即关闭；devMock 的校验与 Rust 同规则。

const PARSER_SOURCE = Object.values(import.meta.glob<string>('./costProfile.ts', { query: '?raw', import: 'default', eager: true }))[0];

const PLAN: CostSubscriptionPlan = {
  id: 'sub-0123456789abcdef',
  name: 'Claude Max',
  provider: 'anthropic',
  fee: 200,
  currency: 'USD',
  cycle: 'monthly',
  anchorDay: 15,
  startDate: '2026-03-15',
  endDate: null,
  tools: ['claude'],
  modelPrefixes: ['claude-'],
  machines: [],
};

const CLEARED_PROFILE = { plans: [], toolBillingModes: {}, cnyPerUsd: COST_PROFILE_DEFAULT_CNY_PER_USD };

function view(patch: Partial<CostProfile> = {}): CostProfile {
  return { revision: 3, plans: [PLAN], toolBillingModes: { opencode: 'payg' }, cnyPerUsd: 7.2, ...patch };
}

function plan(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...PLAN, ...patch };
}

/** 返回违约时固定的问题代码。 */
function violation(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(CostProfileContractError);
    return (error as Error).message;
  }
  throw new Error('expected a contract violation');
}

function fieldError(patch: Partial<CostProfileFieldError> = {}): CostProfileFieldError {
  return {
    planIndex: 1,
    field: 'name',
    itemIndex: null,
    key: null,
    relatedPlanIndex: 0,
    code: 'duplicate',
    message: '已有同名订阅',
    ...patch,
  };
}

const PROFILE_REQUIRED: CostProfileFieldError = {
  planIndex: null,
  field: 'profile',
  itemIndex: null,
  key: null,
  relatedPlanIndex: null,
  code: 'required',
  message: '缺少订阅设置',
};

describe('parseCostProfile：失败即关闭', () => {
  it('规范的订阅设置原样通过；汇率不可得是 null，不是 0 也不是 7.2', () => {
    expect(parseCostProfile(view())).toEqual(view());
    expect(parseCostProfile(view({ cnyPerUsd: null })).cnyPerUsd).toBeNull();
    const empty = parseCostProfile({ revision: 0, ...CLEARED_PROFILE });
    expect(isCostProfileCleared(empty)).toBe(true);
  });

  it('换方案的相邻时段、闰日开始的年付与用前缀或设备区分的订阅都不算重叠', () => {
    const plans = [
      plan({ id: 'sub-0000000000000001', name: 'Claude Pro', fee: 20, startDate: '2026-01-01', endDate: '2026-08-31' }),
      plan({ id: 'sub-0000000000000002', startDate: '2026-09-01' }),
      plan({ id: 'sub-0000000000000003', name: 'GLM 编程套餐', provider: 'zhipu', startDate: '2026-01-01', modelPrefixes: ['glm-'] }),
      plan({ id: 'sub-0000000000000004', name: 'Gemini 年付', provider: 'google', cycle: 'yearly', anchorDay: 29, startDate: '2024-02-29', tools: ['gemini'], modelPrefixes: [] }),
      plan({ id: 'sub-0000000000000005', name: '工作站', startDate: '2026-01-01', tools: ['codex'], modelPrefixes: [], machines: ['Studio-PC'] }),
      plan({ id: 'sub-0000000000000006', name: '笔记本', startDate: '2026-01-01', tools: ['codex'], modelPrefixes: [], machines: ['Travel-Laptop'] }),
    ];
    expect(parseCostProfile(view({ plans: plans as unknown as CostSubscriptionPlan[] })).plans).toHaveLength(6);
  });

  it('模型前缀可以含 ASCII 可见符号', () => {
    const prefixes = ['claude-3-5-sonnet-v2@20241022', 'claude-sonnet-4[1m]', 'gpt-4o+search'];
    expect(parseCostProfile(view({ plans: [{ ...PLAN, modelPrefixes: prefixes }] })).plans[0].modelPrefixes).toEqual(prefixes);
  });

  it.each([
    [{ provider: 'xai' }, 'provider:invalid'],
    [{ currency: 'EUR' }, 'currency:invalid'],
    [{ cycle: 'quarterly' }, 'cycle:invalid'],
    [{ id: null }, 'id:required'],
    [{ id: 'sub-0123456789ABCDEF' }, 'id:invalid'],
    [{ name: ' Claude Max' }, 'name:invalid'],
    [{ name: '' }, 'name:required'],
    [{ name: 'Claude\u{202e}Max' }, 'name:invalid'],
    [{ name: 'Claude\u{200b}Max' }, 'name:invalid'],
    [{ fee: 0 }, 'fee:out_of_range'],
    [{ fee: 19.999 }, 'fee:precision'],
    [{ fee: 19.999999999 }, 'fee:precision'],
    [{ fee: '200' }, 'fee:invalid'],
    [{ anchorDay: 32 }, 'anchorDay:out_of_range'],
    [{ anchorDay: 1.5 }, 'anchorDay:invalid'],
    [{ startDate: '2026-02-29' }, 'startDate:invalid'],
    [{ startDate: '2019-12-31' }, 'startDate:out_of_range'],
    [{ endDate: '2026-03-14' }, 'endDate:before_start'],
    [{ endDate: undefined }, 'endDate:invalid'],
    [{ tools: [] }, 'tools:required'],
    [{ tools: ['claude', 'claude'] }, 'tools:duplicate'],
    [{ modelPrefixes: ['claude-', 'CLAUDE-'] }, 'modelPrefixes:duplicate'],
    [{ modelPrefixes: ['claude sonnet'] }, 'modelPrefixes:invalid'],
    [{ modelPrefixes: ['混元-'] }, 'modelPrefixes:invalid'],
    [{ machines: ['all'] }, 'machines:invalid'],
    [{ machines: undefined }, 'machines:required'],
    [{ nickname: 'x' }, 'plan:invalid'],
  ])('一条订阅不合契约（%j）就整份拒绝，问题代码不含内容', (patch, problem) => {
    const broken = view({ plans: [plan(patch) as unknown as CostSubscriptionPlan] });
    const message = violation(() => parseCostProfile(broken));
    expect(message).toBe(problem);
    expect(message).not.toMatch(/Claude|200/);
  });

  it('订阅之间 ID 重复、重名或时段重叠时整份拒绝', () => {
    const twice = (second: Record<string, unknown>) => view({ plans: [PLAN, plan(second)] as unknown as CostSubscriptionPlan[] });
    expect(violation(() => parseCostProfile(twice({ name: 'Other', tools: ['codex'] })))).toBe('id:duplicate');
    expect(violation(() => parseCostProfile(twice({ id: 'sub-0000000000000001', name: 'claude max', tools: ['codex'] })))).toBe('name:duplicate');
    expect(violation(() => parseCostProfile(twice({ id: 'sub-0000000000000001', name: 'Claude Team', startDate: '2026-06-01' })))).toBe('tools:overlap');
    // 同一天交接两段都含这一天，仍是重叠。
    expect(violation(() => parseCostProfile(view({
      plans: [
        plan({ endDate: '2026-06-01' }),
        plan({ id: 'sub-0000000000000001', name: 'Claude Team', startDate: '2026-06-01' }),
      ] as unknown as CostSubscriptionPlan[],
    })))).toBe('tools:overlap');
    const thirteen = Array.from({ length: 13 }, (_, index) => plan({
      id: `sub-${index.toString(16).padStart(16, '0')}`,
      name: `plan ${index}`,
      tools: [`tool${index}`],
    }));
    expect(violation(() => parseCostProfile(view({ plans: thirteen as unknown as CostSubscriptionPlan[] })))).toBe('plans:too_many');
  });

  it.each([
    [{ ...view(), revision: -1 }, 'invalid-revision'],
    [{ ...view(), revision: 1.5 }, 'invalid-revision'],
    [{ ...view(), revision: 2 ** 53 }, 'invalid-revision'],
    [{ ...view(), revision: '3' }, 'invalid-revision'],
    [{ ...view(), extra: true }, 'invalid-profile'],
    [{ revision: 3, plans: [], cnyPerUsd: 7.2 }, 'toolBillingModes:required'],
    [{ ...view(), toolBillingModes: { kilo: 'subscription' } }, 'toolBillingModes:invalid'],
    [{ ...view(), toolBillingModes: { ' spaced': 'payg' } }, 'toolBillingModes:invalid'],
    [{ revision: 3, plans: [], toolBillingModes: {} }, 'cnyPerUsd:required'],
    [{ ...view(), cnyPerUsd: 0.5 }, 'cnyPerUsd:out_of_range'],
    [{ ...view(), cnyPerUsd: 7.23456 }, 'cnyPerUsd:precision'],
    [{ ...view(), cnyPerUsd: 7.20000000001 }, 'cnyPerUsd:precision'],
    [{ ...view(), cnyPerUsd: '7.2' }, 'cnyPerUsd:invalid'],
    [{ ...view(), plans: null }, 'plans:required'],
    [[], 'invalid-profile'],
  ])('整份设置不合契约就拒绝（%#）', (value, problem) => {
    expect(violation(() => parseCostProfile(value))).toBe(problem);
  });

  it('解析器从不打印响应内容', () => {
    expect(PARSER_SOURCE).toBeTruthy();
    expect(PARSER_SOURCE).not.toMatch(/console\./);
  });
});

describe('parseCostProfileValidation、parseCostProfileSaveResult 与 parseCostProfileClearResult', () => {
  it('字段级错误按固定形态通过，valid 必须与「没有错误」一致', () => {
    expect(parseCostProfileValidation({ valid: true, errors: [] })).toEqual({ valid: true, errors: [] });
    const result = { valid: false, errors: [fieldError(), fieldError({ planIndex: null, field: 'cnyPerUsd', relatedPlanIndex: null, code: 'out_of_range', message: '汇率需在 1 到 20 之间' })] };
    expect(parseCostProfileValidation(result)).toEqual(result);
    expect(parseCostProfileValidation({ valid: false, errors: [PROFILE_REQUIRED] })).toEqual({ valid: false, errors: [PROFILE_REQUIRED] });
    expect(violation(() => parseCostProfileValidation({ valid: true, errors: [fieldError()] }))).toBe('validation-mismatch');
    expect(violation(() => parseCostProfileValidation({ valid: false, errors: [] }))).toBe('validation-mismatch');
  });

  it.each([
    [{ code: 'unknown' }],
    [{ field: 'nickname' }],
    [{ planIndex: null }],
    [{ planIndex: 0, field: 'cnyPerUsd', relatedPlanIndex: null }],
    [{ relatedPlanIndex: 1 }],
    [{ itemIndex: -1 }],
    [{ key: 3 }],
    [{ message: '  ' }],
  ])('字段级错误不合契约就拒绝（%j）', (patch) => {
    const errors = [{ ...fieldError(), ...patch }];
    expect(violation(() => parseCostProfileValidation({ valid: false, errors }))).toBe('invalid-field-error');
  });

  it('保存结果：saved 的 cleared 与内容一致、revision 至少为 1；conflict 与 invalid 形态固定', () => {
    const saved = { status: 'saved', profile: view(), cleared: false };
    expect(parseCostProfileSaveResult(saved)).toEqual(saved);
    const cleared = { status: 'saved', profile: { revision: 4, ...CLEARED_PROFILE }, cleared: true };
    expect(parseCostProfileSaveResult(cleared)).toEqual(cleared);
    expect(violation(() => parseCostProfileSaveResult({ ...cleared, cleared: false }))).toBe('cleared-mismatch');
    expect(violation(() => parseCostProfileSaveResult({ ...saved, profile: view({ revision: 0 }) }))).toBe('invalid-revision');
    expect(parseCostProfileSaveResult({ status: 'conflict', currentRevision: 7 })).toEqual({ status: 'conflict', currentRevision: 7 });
    expect(violation(() => parseCostProfileSaveResult({ status: 'conflict', currentRevision: -1 }))).toBe('invalid-save-result');
    const invalid = { status: 'invalid', errors: [fieldError()] };
    expect(parseCostProfileSaveResult(invalid)).toEqual(invalid);
    expect(violation(() => parseCostProfileSaveResult({ status: 'invalid', errors: [] }))).toBe('invalid-save-result');
    expect(violation(() => parseCostProfileSaveResult({ status: 'merged' }))).toBe('invalid-save-result');
    // 汇率不可得的保存结果不是规范空状态。
    const unavailable = { status: 'saved', profile: { revision: 2, plans: [], toolBillingModes: {}, cnyPerUsd: null }, cleared: false };
    expect(parseCostProfileSaveResult(unavailable)).toEqual(unavailable);
  });

  it('删除全部的结果：只接受规范空状态的 saved 或 conflict', () => {
    const cleared = { status: 'saved', profile: { revision: 4, ...CLEARED_PROFILE }, cleared: true };
    expect(parseCostProfileClearResult(cleared)).toEqual(cleared);
    expect(parseCostProfileClearResult({ status: 'conflict', currentRevision: 7 })).toEqual({ status: 'conflict', currentRevision: 7 });
    expect(violation(() => parseCostProfileClearResult({ status: 'saved', profile: view(), cleared: false }))).toBe('invalid-clear-result');
    expect(violation(() => parseCostProfileClearResult({ status: 'invalid', errors: [PROFILE_REQUIRED] }))).toBe('invalid-clear-result');
    expect(violation(() => parseCostProfileClearResult({ ...cleared, cleared: false }))).toBe('cleared-mismatch');
  });
});

describe('costProfileInput', () => {
  it('去掉 revision、复制列表；汇率不可得时原样保留 null，不代填默认值', () => {
    const source = view({ cnyPerUsd: null });
    const input = costProfileInput(source);
    expect(input).toEqual({ plans: [PLAN], toolBillingModes: { opencode: 'payg' }, cnyPerUsd: null });
    expect('revision' in input).toBe(false);
    input.plans[0].tools.push('codex');
    input.toolBillingModes.kilo = 'payg';
    expect(source.plans[0].tools).toEqual(['claude']);
    expect(source.toolBillingModes).toEqual({ opencode: 'payg' });
  });
});

describe('checkCostProfileInput：Rust 校验规则的前端镜像', () => {
  const TODAY = '2026-09-25';
  const input = (plans: unknown[], extra: Record<string, unknown> = {}) => ({ plans, toolBillingModes: {}, cnyPerUsd: 7.2, ...extra });
  const codesOf = (raw: unknown) => checkCostProfileInput(raw, { plans: [] }, TODAY).errors.map((error) => `${error.field}:${error.code}`);

  it('新订阅可以不带 id；名称去首尾空白，省略的可选字段补齐', () => {
    const required: Record<string, unknown> = { ...PLAN, name: '  Claude Max  ' };
    for (const optional of ['id', 'endDate', 'modelPrefixes', 'machines']) delete required[optional];
    const checked = checkCostProfileInput(input([required]), { plans: [] }, TODAY);
    expect(checked.errors).toEqual([]);
    expect(checked.profile?.plans).toEqual([{ ...PLAN, id: null, modelPrefixes: [] }]);
  });

  it('重叠提示与 Rust 同文案，指向较早的订阅', () => {
    const checked = checkCostProfileInput(input([
      plan({ id: null, name: 'Claude Pro', startDate: '2026-01-01', endDate: '2026-09-01' }),
      plan({ id: null, startDate: '2026-09-01' }),
    ]), { plans: [] }, TODAY);
    expect(checked.profile).toBeNull();
    expect(checked.errors).toEqual([{
      planIndex: 1,
      field: 'tools',
      itemIndex: null,
      key: null,
      relatedPlanIndex: 0,
      code: 'overlap',
      message: '「Claude Pro」与「Claude Max」自 2026-09-01 起同时覆盖 claude，账本无法区分记录来自哪个订阅。请用模型前缀或设备区分，或合并为一个订阅（订阅费相加）。',
    }]);
  });

  it('「不晚于今天」只检查新订阅与改过开始日期的订阅', () => {
    const stored = { plans: [{ ...PLAN, startDate: '2026-09-26' }] };
    const codes = (startDate: string, id: string | null = PLAN.id) =>
      checkCostProfileInput(input([plan({ id, startDate })]), stored, TODAY).errors.map((error) => `${error.field}:${error.code}`);
    expect(codes('2026-09-26')).toEqual([]);
    expect(codes('2026-09-27')).toEqual(['startDate:in_future']);
    expect(codes('2026-09-25')).toEqual([]);
    expect(codes('2026-09-26', null)).toEqual(['startDate:in_future']);
  });

  it('整份设置的错误：拼错地方的 revision、汇率不可得、不支持的付费方式', () => {
    const errors = checkCostProfileInput(
      { plans: [], toolBillingModes: { kilo: 'subscription' }, cnyPerUsd: null, revision: 3 },
      { plans: [] },
      TODAY,
    ).errors;
    expect(errors.map(({ field, code, key, message }) => ({ field, code, key, message }))).toEqual([
      { field: 'profile', code: 'invalid', key: 'revision', message: '订阅设置包含无法识别的字段' },
      { field: 'toolBillingModes', code: 'invalid', key: 'kilo', message: '付费方式只能是按量付费（payg）' },
      { field: 'cnyPerUsd', code: 'required', key: null, message: '汇率需在 1 到 20 之间' },
    ]);
  });

  it('null 不是订阅设置：报 profile 的 required；其他非对象报 invalid', () => {
    expect(checkCostProfileInput(null, { plans: [] }, TODAY)).toEqual({ errors: [PROFILE_REQUIRED], profile: null });
    for (const raw of [[], 'plans', 0, false]) expect(codesOf(raw), JSON.stringify(raw)).toEqual(['profile:invalid']);
  });

  it.each([
    'Claude\u{200b}Max',
    '\u{200e}Claude Max',
    'Claude Max\u{200f}',
    'Claude\u{061c}Max',
    '\u{feff}Claude Max',
    'Claude\u{200c}Max',
    'Claude\u{200d}Max',
    'Claude\u{2060}Max',
    'Claude\u{00ad}Max',
    'Claude\u{202a}Max\u{202c}',
    '\u{2066}Claude Max\u{2069}',
    'Claude Max\u{200b}  ',
    '  \u{200b}  ',
  ])('名称含零宽或文字方向控制字符（%j）报 invalid：先去首尾空白再判断', (name) => {
    const errors = checkCostProfileInput(input([plan({ id: null, name })]), { plans: [] }, TODAY).errors;
    expect(errors.map(({ field, code, message }) => ({ field, code, message }))).toEqual([
      { field: 'name', code: 'invalid', message: '订阅名称不能包含控制字符、零宽字符或文字方向控制字符' },
    ]);
  });

  it('普通的中文、emoji 与首尾全角空格的名称照常，全角空格去掉', () => {
    for (const name of ['智谱 编程套餐', 'Claude Max \u{1f680}', 'Kimi（会员）']) {
      expect(codesOf(input([plan({ id: null, name })])), name).toEqual([]);
    }
    const checked = checkCostProfileInput(input([plan({ id: null, name: '\u{3000}Claude Max\u{3000}' })]), { plans: [] }, TODAY);
    expect(checked.profile?.plans[0].name).toBe('Claude Max');
  });

  it('金额按币种允许的位数严格判断，多一位就是 precision，不设容差', () => {
    const fee = (value: number) => codesOf(input([plan({ id: null, fee: value })]));
    for (const value of [19.999999999, 19.999, 0.001, 1e-9, 99999.991]) expect(fee(value), String(value)).toEqual(['fee:precision']);
    for (const value of [19.99, 0.07, 0.01, 99999.99, 100000, 200]) expect(fee(value), String(value)).toEqual([]);
    const rate = (value: number) => codesOf(input([], { cnyPerUsd: value }));
    for (const value of [7.20000000001, 7.23456, 1.00001]) expect(rate(value), String(value)).toEqual(['cnyPerUsd:precision']);
    for (const value of [7.2345, 7.2, 1, 19.9999]) expect(rate(value), String(value)).toEqual([]);
  });

  it('模型前缀接受 ASCII 可见字符（0x21–0x7E），不接受空白与非 ASCII', () => {
    const prefixErrors = (value: string) => checkCostProfileInput(input([plan({ id: null, modelPrefixes: [value] })]), { plans: [] }, TODAY).errors;
    for (const value of [
      'claude-3-5-sonnet-v2@20241022',
      'claude-sonnet-4[1m]',
      'gpt-4o+search',
      'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
      'qwen2.5-coder:7b',
      'anthropic/claude',
      '!',
      '~',
    ]) {
      expect(prefixErrors(value), value).toEqual([]);
    }
    for (const value of ['claude sonnet', 'claude\tsonnet', '混元-', 'claude\u{7f}', 'claude\u{a0}', '']) {
      expect(prefixErrors(value).map(({ field, code, itemIndex, message }) => ({ field, code, itemIndex, message })), JSON.stringify(value)).toEqual([
        { field: 'modelPrefixes', code: 'invalid', itemIndex: 0, message: '模型前缀只能包含英文字母、数字和英文符号，不能有空格' },
      ]);
    }
  });
});

describe('devMock 的四个订阅设置命令', () => {
  afterEach(() => {
    clearMocks();
  });

  it('按 revision 条件保存、冲突不改、删除全部回到规范空状态；通用 save_settings 覆盖不了', async () => {
    clearMocks();
    installDevMockTauri();
    const initial = parseCostProfile(await invoke('get_cost_profile'));
    expect(initial).toEqual({ revision: 0, ...CLEARED_PROFILE });

    const first = { ...PLAN, id: null, startDate: '2024-01-01' };
    const overlapping = { plans: [first, { ...first, name: 'Claude Team' }], toolBillingModes: {}, cnyPerUsd: 7.2 };
    const validation = parseCostProfileValidation(await invoke('validate_cost_profile', { profile: overlapping }));
    expect(validation.errors.map((error) => `${error.planIndex}:${error.field}:${error.code}`)).toEqual(['1:tools:overlap']);
    const rejected = parseCostProfileSaveResult(await invoke('save_cost_profile', { profile: overlapping, expectedRevision: 0 }));
    expect(rejected.status).toBe('invalid');
    expect(parseCostProfile(await invoke('get_cost_profile')).revision).toBe(0);

    const profile = { plans: [first], toolBillingModes: { opencode: 'payg' }, cnyPerUsd: 7.25 };
    const saved = parseCostProfileSaveResult(await invoke('save_cost_profile', { profile, expectedRevision: 0 }));
    if (saved.status !== 'saved') throw new Error(`expected saved, got ${saved.status}`);
    expect(saved.cleared).toBe(false);
    expect(saved.profile.revision).toBe(1);
    expect(saved.profile.plans[0].id).toMatch(/^sub-[0-9a-f]{16}$/);

    // 另一扇窗口还拿着 revision 0：保存与删除全部都冲突，什么都不改。
    expect(parseCostProfileSaveResult(await invoke('save_cost_profile', { profile, expectedRevision: 0 })))
      .toEqual({ status: 'conflict', currentRevision: 1 });
    expect(parseCostProfileClearResult(await invoke('clear_cost_profile', { expectedRevision: 0 })))
      .toEqual({ status: 'conflict', currentRevision: 1 });
    // 通用设置保存带着过时的 cost_* 字段，也覆盖不了订阅设置。
    const stale = { ...(await invoke<AppSettings>('get_settings')), cost_subscription_plans: [], cost_profile_revision: 0 };
    await invoke('save_settings', { settings: stale });
    expect(parseCostProfile(await invoke('get_cost_profile'))).toEqual(saved.profile);

    // 再次保存沿用原 ID。
    const resubmit = costProfileInput(saved.profile);
    resubmit.plans[0].name = 'Claude Max（改名）';
    const renamed = parseCostProfileSaveResult(await invoke('save_cost_profile', { profile: resubmit, expectedRevision: 1 }));
    if (renamed.status !== 'saved') throw new Error(`expected saved, got ${renamed.status}`);
    expect(renamed.profile.plans[0].id).toBe(saved.profile.plans[0].id);

    // 误传 null（例如订阅设置还没加载完）：报 required，不清空。
    expect(parseCostProfileValidation(await invoke('validate_cost_profile', { profile: null })))
      .toEqual({ valid: false, errors: [PROFILE_REQUIRED] });
    expect(parseCostProfileSaveResult(await invoke('save_cost_profile', { profile: null, expectedRevision: 2 })))
      .toEqual({ status: 'invalid', errors: [PROFILE_REQUIRED] });
    expect(parseCostProfile(await invoke('get_cost_profile'))).toEqual(renamed.profile);

    const deleted = parseCostProfileClearResult(await invoke('clear_cost_profile', { expectedRevision: 2 }));
    expect(deleted).toEqual({ status: 'saved', profile: { revision: 3, ...CLEARED_PROFILE }, cleared: true });
    // 参数缺失时与原生端一样整个调用失败。
    await expect(invoke('save_cost_profile', { profile: null })).rejects.toMatch(/expectedRevision/);
    await expect(invoke('save_cost_profile', { expectedRevision: 3 })).rejects.toMatch(/profile/);
    await expect(invoke('clear_cost_profile', {})).rejects.toMatch(/expectedRevision/);
  });

  it('「今天」是其余 mock 统一的 2026-07-15，不随真实时钟漂移', async () => {
    clearMocks();
    installDevMockTauri();
    const starting = (startDate: string) => ({ plans: [{ ...PLAN, id: null, startDate }], toolBillingModes: {}, cnyPerUsd: 7.2 });
    const codes = async (startDate: string) => parseCostProfileValidation(await invoke('validate_cost_profile', { profile: starting(startDate) }))
      .errors.map((error) => `${error.field}:${error.code}`);
    expect(await codes('2026-07-15')).toEqual([]);
    expect(await codes('2026-07-16')).toEqual(['startDate:in_future']);
    const rejected = parseCostProfileSaveResult(await invoke('save_cost_profile', { profile: starting('2026-07-16'), expectedRevision: 0 }));
    expect(rejected.status).toBe('invalid');
  });
});

describe('类型化封装', () => {
  afterEach(() => {
    clearMocks();
  });

  it('四个封装各调对应的命令并解析返回；删除全部只有 clearCostProfile 一个入口', async () => {
    clearMocks();
    installDevMockTauri();
    expect(await getCostProfile()).toEqual({ revision: 0, ...CLEARED_PROFILE });
    const input = { plans: [{ ...PLAN, id: null, startDate: '2024-01-01' }], toolBillingModes: {}, cnyPerUsd: 7.2 };
    expect(await validateCostProfile(input)).toEqual({ valid: true, errors: [] });
    const saved = await saveCostProfile(input, 0);
    if (saved.status !== 'saved') throw new Error(`expected saved, got ${saved.status}`);
    expect(saved.profile.revision).toBe(1);
    expect(await clearCostProfile(0)).toEqual({ status: 'conflict', currentRevision: 1 });
    expect(await clearCostProfile(1)).toEqual({ status: 'saved', profile: { revision: 2, ...CLEARED_PROFILE }, cleared: true });
    expect(await getCostProfile()).toEqual({ revision: 2, ...CLEARED_PROFILE });
  });

  it('参数原样传给原生端；不合契约的返回整份拒绝', async () => {
    const calls: Array<[string, unknown]> = [];
    let response: unknown = null;
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return response;
    });
    const input = { plans: [], toolBillingModes: {}, cnyPerUsd: 7.2 };
    response = { status: 'saved', profile: view(), cleared: false };
    await expect(clearCostProfile(3)).rejects.toThrow('invalid-clear-result');
    response = { status: 'conflict', currentRevision: 4 };
    expect(await saveCostProfile(input, 3)).toEqual({ status: 'conflict', currentRevision: 4 });
    response = { valid: true, errors: [fieldError()] };
    await expect(validateCostProfile(input)).rejects.toThrow('validation-mismatch');
    response = { ...view(), revision: -1 };
    await expect(getCostProfile()).rejects.toBeInstanceOf(CostProfileContractError);
    expect(calls).toEqual([
      ['clear_cost_profile', { expectedRevision: 3 }],
      ['save_cost_profile', { profile: input, expectedRevision: 3 }],
      ['validate_cost_profile', { profile: input }],
      ['get_cost_profile', {}],
    ]);
  });
});
