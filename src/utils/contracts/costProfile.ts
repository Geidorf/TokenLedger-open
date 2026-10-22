import { invoke } from '@tauri-apps/api/core';
import type {
  CostBillingCycle,
  CostBillingMode,
  CostCurrency,
  CostProfile,
  CostProfileClearResult,
  CostProfileErrorCode,
  CostProfileErrorField,
  CostProfileFieldError,
  CostProfileInput,
  CostProfileSaveResult,
  CostProfileValidation,
  CostProvider,
  CostSubscriptionPlan,
  CostSubscriptionPlanInput,
} from '../../types';
import { isRecord } from './internal';

/**
 * 订阅设置契约（T10.188，docs/contracts/cost-profile-local-v1.md）的前端边界。
 *
 * - `getCostProfile` / `validateCostProfile` / `saveCostProfile` / `clearCostProfile`：四个命令的
 *   类型化封装，设置页只经它们调用；「删除全部订阅设置」只有 `clearCostProfile` 一个入口。
 * - `parseCostProfile` / `parseCostProfileValidation` / `parseCostProfileSaveResult` /
 *   `parseCostProfileClearResult`：原生端返回值的失败即关闭解析，任何一处不合契约就整份拒绝，
 *   不给出部分数据。
 * - `checkCostProfileInput`：Rust 校验规则的前端镜像，只给 devMock 与测试用；设置页的
 *   权威校验一律调用 `validate_cost_profile` / `save_cost_profile`。
 */

/** 汇率默认值；「删除全部订阅设置」后回到它。 */
export const COST_PROFILE_DEFAULT_CNY_PER_USD = 7.2;
/** 最多登记的订阅数。 */
export const COST_PROFILE_MAX_PLANS = 12;
export const COST_PROVIDERS: readonly CostProvider[] = ['anthropic', 'openai', 'google', 'moonshot', 'zhipu', 'minimax', 'deepseek', 'other'];
export const COST_CURRENCIES: readonly CostCurrency[] = ['USD', 'CNY'];
export const COST_BILLING_CYCLES: readonly CostBillingCycle[] = ['monthly', 'yearly'];

const ERROR_CODES = new Set<string>([
  'required', 'invalid', 'too_long', 'too_many', 'duplicate', 'out_of_range', 'precision', 'in_future', 'before_start', 'overlap',
]);
const PROFILE_FIELDS = new Set<string>(['profile', 'plans', 'toolBillingModes', 'cnyPerUsd']);
const PLAN_FIELDS = new Set<string>([
  'plan', 'id', 'name', 'provider', 'fee', 'currency', 'cycle', 'anchorDay', 'startDate', 'endDate', 'tools', 'modelPrefixes', 'machines',
]);
const PLAN_KEYS = new Set<string>([
  'id', 'name', 'provider', 'fee', 'currency', 'cycle', 'anchorDay', 'startDate', 'endDate', 'tools', 'modelPrefixes', 'machines',
]);
const INPUT_KEYS = new Set<string>(['plans', 'toolBillingModes', 'cnyPerUsd']);
const VIEW_KEYS = new Set<string>(['revision', 'plans', 'toolBillingModes', 'cnyPerUsd']);
const ERROR_KEYS = new Set<string>(['planIndex', 'field', 'itemIndex', 'key', 'relatedPlanIndex', 'code', 'message']);
const VALIDATION_KEYS = new Set<string>(['valid', 'errors']);
const SAVED_KEYS = new Set<string>(['status', 'profile', 'cleared']);
const CONFLICT_KEYS = new Set<string>(['status', 'currentRevision']);
const INVALID_KEYS = new Set<string>(['status', 'errors']);
const MAX_NAME_CHARS = 40;
const MAX_FEE = 100_000;
const MAX_LIST_ITEMS = 16;
const MAX_MODEL_PREFIX_CHARS = 64;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_BILLING_MODES = 64;
const EARLIEST_START_DATE = '2020-01-01';
const PLAN_ID = /^sub-[0-9a-f]{16}$/;
/** ASCII 可见字符 0x21–0x7E（方案 §3.2 规则栏），不含空格。 */
const MODEL_PREFIX = /^[!-~]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 首尾空白按 Rust `str::trim`（White_Space 属性）判断：与 JS trim 不同，不含 U+FEFF、含 U+0085。 */
const EDGE_SPACE = /^[\t\n\v\f\r \u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+|[\t\n\v\f\r \u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+$/gu;
const CONTROL = /\p{Cc}/u;
/**
 * 名称里不允许的字符，与 Rust `forbidden_name_char` 相同：控制字符；软连字符、阿拉伯字母标记、
 * 蒙古文元音分隔符；零宽字符与从左到右、从右到左标记；行、段分隔符与双向嵌入、覆盖；词连接符与
 * 不可见运算符；双向隔离与已弃用的格式控制；BOM。
 */
const FORBIDDEN_NAME_CHAR = /[\p{Cc}\u{ad}\u{61c}\u{180e}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}]/u;
const FEE_DECIMALS = 2;
const CNY_PER_USD_DECIMALS = 4;

type Code = CostProfileErrorCode;
type Field = CostProfileErrorField;

/** 与 `CostProfileFieldError` 同形，但不带提示文案；`note`、`overlap` 只影响文案。 */
interface Issue {
  planIndex: number | null;
  field: Field;
  code: Code;
  itemIndex: number | null;
  key: string | null;
  relatedPlanIndex: number | null;
  note?: 'unknown-field' | 'tool-id' | 'billing-mode';
  overlap?: { since: string; tool: string };
}

/** `input`：设置页的提交（新订阅可无 id、可选字段可省略、名称去首尾空白）；`view`：原生端返回的规范形态。 */
type Mode = 'input' | 'view';

/** 逐字段解析的订阅：合规的字段才有值；`id` 为 null 表示提交里的新订阅。 */
interface Draft {
  id?: string | null;
  name?: string;
  provider?: CostProvider;
  fee?: number;
  currency?: CostCurrency;
  cycle?: CostBillingCycle;
  anchorDay?: number;
  startDate?: string;
  endDate?: string | null;
  tools?: string[];
  modelPrefixes?: string[];
  machines?: string[];
}

interface Coverage {
  start: string;
  end: string | null;
  tools: string[];
  modelPrefixes: string[];
  machines: string[];
}

interface ListRule {
  field: 'tools' | 'modelPrefixes' | 'machines';
  allowEmpty: boolean;
  check: (value: string) => Code | null;
  fold: (value: string) => string;
}

function issue(planIndex: number | null, field: Field, code: Code, extra: Partial<Issue> = {}): Issue {
  return { planIndex, field, code, itemIndex: null, key: null, relatedPlanIndex: null, ...extra };
}

function requiredOrInvalid(value: unknown): Code {
  return value === undefined || value === null ? 'required' : 'invalid';
}

function trimSpace(value: string): string {
  return value.replace(EDGE_SPACE, '');
}

/**
 * 小数位数：按最短往返的十进制写法数（与 Rust `f64` 的 Display 同一口径），不设容差。
 * JS 对很小的数用科学计数法（`1e-9`），这里把指数折回小数位。调用前已确认是有限数。
 */
function decimalPlaces(value: number): number {
  const [mantissa, exponent = '0'] = String(Math.abs(value)).split('e');
  const fraction = mantissa.split('.')[1] ?? '';
  return Math.max(0, fraction.length - Number(exponent));
}

function nameIssue(name: string): Code | null {
  if (name === '') return 'required';
  if (FORBIDDEN_NAME_CHAR.test(name)) return 'invalid';
  return [...name].length > MAX_NAME_CHARS ? 'too_long' : null;
}

function feeIssue(value: number): Code | null {
  if (!Number.isFinite(value)) return 'invalid';
  if (value <= 0 || value > MAX_FEE) return 'out_of_range';
  return decimalPlaces(value) > FEE_DECIMALS ? 'precision' : null;
}

function rateIssue(value: number): Code | null {
  if (!Number.isFinite(value)) return 'invalid';
  if (value < 1 || value > 20) return 'out_of_range';
  return decimalPlaces(value) > CNY_PER_USD_DECIMALS ? 'precision' : null;
}

/** 只认 `YYYY-MM-DD` 写法的真实日历日期。 */
function isDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

/** 工具与设备 ID：非空、无首尾空白与控制字符、不超过 256 个 UTF-8 字节。 */
function identifierIssue(value: string): Code | null {
  if (value === '' || trimSpace(value) !== value || CONTROL.test(value)) return 'invalid';
  return new TextEncoder().encode(value).length > MAX_IDENTIFIER_BYTES ? 'too_long' : null;
}

function machineIssue(value: string): Code | null {
  // `all` 与 `all_cloud` 是看板筛选里「全部设备」的哨兵值，不是设备 ID。
  return identifierIssue(value) ?? (value === 'all' || value === 'all_cloud' ? 'invalid' : null);
}

function modelPrefixIssue(value: string): Code | null {
  if (!MODEL_PREFIX.test(value)) return 'invalid';
  return value.length > MAX_MODEL_PREFIX_CHARS ? 'too_long' : null;
}

const same = (value: string) => value;
const lower = (value: string) => value.toLowerCase();
const TOOLS_RULE: ListRule = { field: 'tools', allowEmpty: false, check: identifierIssue, fold: same };
const MODEL_PREFIXES_RULE: ListRule = { field: 'modelPrefixes', allowEmpty: true, check: modelPrefixIssue, fold: lower };
const MACHINES_RULE: ListRule = { field: 'machines', allowEmpty: true, check: machineIssue, fold: same };

function parseClosed<T extends string>(
  value: unknown,
  allowed: readonly T[],
  planIndex: number,
  field: Field,
  issues: Issue[],
): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push(issue(planIndex, field, typeof value === 'string' ? 'invalid' : requiredOrInvalid(value)));
  return undefined;
}

function parseList(value: unknown, rule: ListRule, planIndex: number, mode: Mode, issues: Issue[]): string[] | undefined {
  if (!Array.isArray(value)) {
    if (mode === 'input' && rule.allowEmpty && (value === undefined || value === null)) return [];
    issues.push(issue(planIndex, rule.field, requiredOrInvalid(value)));
    return undefined;
  }
  if (value.length > MAX_LIST_ITEMS) {
    issues.push(issue(planIndex, rule.field, 'too_many'));
    return undefined;
  }
  if (value.length === 0 && !rule.allowEmpty) {
    issues.push(issue(planIndex, rule.field, 'required'));
    return undefined;
  }
  const seen = new Set<string>();
  const list: string[] = [];
  value.forEach((item: unknown, itemIndex) => {
    const code = typeof item !== 'string'
      ? 'invalid'
      : rule.check(item) ?? (seen.has(rule.fold(item)) ? 'duplicate' : null);
    if (code) {
      issues.push(issue(planIndex, rule.field, code, { itemIndex }));
    } else {
      seen.add(rule.fold(item as string));
      list.push(item as string);
    }
  });
  return list.length === value.length ? list : undefined;
}

function parsePlan(
  raw: unknown,
  planIndex: number,
  mode: Mode,
  storedStarts: ReadonlyMap<string, string>,
  today: string | null,
  issues: Issue[],
): Draft {
  const draft: Draft = {};
  if (!isRecord(raw)) {
    issues.push(issue(planIndex, 'plan', 'invalid'));
    return draft;
  }
  for (const key of Object.keys(raw)) {
    if (!PLAN_KEYS.has(key)) issues.push(issue(planIndex, 'plan', 'invalid', { key, note: 'unknown-field' }));
  }

  if (mode === 'input' && (raw.id === undefined || raw.id === null)) draft.id = null;
  else if (typeof raw.id === 'string' && PLAN_ID.test(raw.id)) draft.id = raw.id;
  else issues.push(issue(planIndex, 'id', mode === 'input' ? 'invalid' : requiredOrInvalid(raw.id)));

  if (typeof raw.name === 'string') {
    const name = trimSpace(raw.name);
    // 原生端只写出去掉首尾空白的名称。
    const code = nameIssue(name) ?? (mode === 'view' && name !== raw.name ? 'invalid' : null);
    if (code) issues.push(issue(planIndex, 'name', code));
    else draft.name = name;
  } else {
    issues.push(issue(planIndex, 'name', requiredOrInvalid(raw.name)));
  }

  draft.provider = parseClosed(raw.provider, COST_PROVIDERS, planIndex, 'provider', issues);

  if (typeof raw.fee === 'number') {
    const code = feeIssue(raw.fee);
    if (code) issues.push(issue(planIndex, 'fee', code));
    else draft.fee = raw.fee;
  } else {
    issues.push(issue(planIndex, 'fee', requiredOrInvalid(raw.fee)));
  }

  draft.currency = parseClosed(raw.currency, COST_CURRENCIES, planIndex, 'currency', issues);
  draft.cycle = parseClosed(raw.cycle, COST_BILLING_CYCLES, planIndex, 'cycle', issues);

  const anchor = raw.anchorDay;
  if (typeof anchor === 'number' && Number.isInteger(anchor) && anchor >= 1 && anchor <= 31) {
    draft.anchorDay = anchor;
  } else {
    const code = typeof anchor !== 'number' ? requiredOrInvalid(anchor) : Number.isInteger(anchor) ? 'out_of_range' : 'invalid';
    issues.push(issue(planIndex, 'anchorDay', code));
  }

  const start = raw.startDate;
  if (typeof start !== 'string') {
    issues.push(issue(planIndex, 'startDate', requiredOrInvalid(start)));
  } else if (!isDate(start)) {
    issues.push(issue(planIndex, 'startDate', 'invalid'));
  } else if (start < EARLIEST_START_DATE) {
    issues.push(issue(planIndex, 'startDate', 'out_of_range'));
  } else {
    // 「不晚于今天」只检查新订阅与改过开始日期的订阅。
    const unchanged = typeof draft.id === 'string' && storedStarts.get(draft.id) === start;
    if (today !== null && !unchanged && start > today) issues.push(issue(planIndex, 'startDate', 'in_future'));
    draft.startDate = start;
  }

  const end = raw.endDate;
  if (end === null || (end === undefined && mode === 'input')) {
    draft.endDate = null;
  } else if (typeof end !== 'string' || !isDate(end)) {
    issues.push(issue(planIndex, 'endDate', 'invalid'));
  } else if (draft.startDate !== undefined && end < draft.startDate) {
    issues.push(issue(planIndex, 'endDate', 'before_start'));
  } else {
    draft.endDate = end;
  }

  draft.tools = parseList(raw.tools, TOOLS_RULE, planIndex, mode, issues);
  draft.modelPrefixes = parseList(raw.modelPrefixes, MODEL_PREFIXES_RULE, planIndex, mode, issues);
  draft.machines = parseList(raw.machines, MACHINES_RULE, planIndex, mode, issues);
  return draft;
}

function coverageOf(draft: Draft): Coverage | null {
  const { startDate, endDate, tools, modelPrefixes, machines } = draft;
  if (startDate === undefined || endDate === undefined || !tools || !modelPrefixes || !machines) return null;
  return { start: startDate, end: endDate, tools, modelPrefixes, machines };
}

function prefixesIntersect(left: string[], right: string[]): boolean {
  return left.length === 0 || right.length === 0 || left.some((a) => right.some((b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x.startsWith(y) || y.startsWith(x);
  }));
}

/** 两个订阅同时覆盖同一类记录时，给出重叠的起始日期与一个共同的工具；起止日期都含。 */
function overlapOf(earlier: Coverage, later: Coverage): { since: string; tool: string } | null {
  if ((later.end !== null && earlier.start > later.end) || (earlier.end !== null && later.start > earlier.end)) return null;
  if (!prefixesIntersect(earlier.modelPrefixes, later.modelPrefixes)) return null;
  if (earlier.machines.length > 0 && later.machines.length > 0
    && !earlier.machines.some((machine) => later.machines.includes(machine))) return null;
  const tool = later.tools.find((candidate) => earlier.tools.includes(candidate));
  if (tool === undefined) return null;
  return { since: earlier.start > later.start ? earlier.start : later.start, tool };
}

function parsePlans(
  value: unknown,
  mode: Mode,
  storedStarts: ReadonlyMap<string, string>,
  today: string | null,
  issues: Issue[],
): Draft[] {
  if (!Array.isArray(value)) {
    issues.push(issue(null, 'plans', requiredOrInvalid(value)));
    return [];
  }
  if (value.length > COST_PROFILE_MAX_PLANS) {
    issues.push(issue(null, 'plans', 'too_many'));
    return [];
  }
  const drafts = value.map((raw: unknown, index) => parsePlan(raw, index, mode, storedStarts, today, issues));
  // 订阅之间：ID 不重复、不重名（不区分大小写）、同一时刻一个工具只属于一个订阅。
  drafts.forEach((later, laterIndex) => {
    drafts.slice(0, laterIndex).forEach((earlier, earlierIndex) => {
      const related = { relatedPlanIndex: earlierIndex };
      if (typeof earlier.id === 'string' && earlier.id === later.id) issues.push(issue(laterIndex, 'id', 'duplicate', related));
      if (earlier.name !== undefined && later.name !== undefined && earlier.name.toLowerCase() === later.name.toLowerCase()) {
        issues.push(issue(laterIndex, 'name', 'duplicate', related));
      }
      const left = coverageOf(earlier);
      const right = coverageOf(later);
      const overlap = left && right ? overlapOf(left, right) : null;
      if (overlap) issues.push(issue(laterIndex, 'tools', 'overlap', { ...related, overlap }));
    });
  });
  return drafts;
}

function parseBillingModes(value: unknown, issues: Issue[]): Record<string, CostBillingMode> | undefined {
  if (!isRecord(value)) {
    issues.push(issue(null, 'toolBillingModes', requiredOrInvalid(value)));
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_BILLING_MODES) {
    issues.push(issue(null, 'toolBillingModes', 'too_many'));
    return undefined;
  }
  const kept: Array<[string, CostBillingMode]> = [];
  for (const [tool, mode] of entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const code = identifierIssue(tool);
    if (code) issues.push(issue(null, 'toolBillingModes', code, { key: tool, note: 'tool-id' }));
    else if (mode !== 'payg') issues.push(issue(null, 'toolBillingModes', 'invalid', { key: tool, note: 'billing-mode' }));
    else kept.push([tool, mode]);
  }
  // fromEntries 按数据属性写入，工具名碰巧是 `__proto__` 也不会改原型。
  return kept.length === entries.length ? Object.fromEntries(kept) : undefined;
}

function parseRate(value: unknown, issues: Issue[]): number | undefined {
  const code = typeof value === 'number' ? rateIssue(value) : requiredOrInvalid(value);
  if (code === null) return value as number;
  issues.push(issue(null, 'cnyPerUsd', code));
  return undefined;
}

function toPlan(draft: Draft): CostSubscriptionPlanInput | null {
  const { id, name, provider, fee, currency, cycle, anchorDay, startDate, endDate, tools, modelPrefixes, machines } = draft;
  if (id === undefined || name === undefined || provider === undefined || fee === undefined || currency === undefined
    || cycle === undefined || anchorDay === undefined || startDate === undefined || endDate === undefined
    || !tools || !modelPrefixes || !machines) return null;
  return { id, name, provider, fee, currency, cycle, anchorDay, startDate, endDate, tools, modelPrefixes, machines };
}

/** 原生端返回值不合契约。`message` 是固定的问题代码，从不含订阅名称、金额等响应内容。 */
export class CostProfileContractError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'CostProfileContractError';
  }
}

function violation(problem: string): never {
  throw new CostProfileContractError(problem);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIndex(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** 规范空状态：没有订阅、没有付费方式、汇率为默认值。从未登记与「删除全部」之后都是它。 */
export function isCostProfileCleared(profile: Pick<CostProfile, 'plans' | 'toolBillingModes' | 'cnyPerUsd'>): boolean {
  return profile.plans.length === 0
    && Object.keys(profile.toolBillingModes).length === 0
    && profile.cnyPerUsd === COST_PROFILE_DEFAULT_CNY_PER_USD;
}

/**
 * `get_cost_profile` 的返回（也是保存成功时的 `profile`）。失败即关闭：任何一处不合契约就
 * 整份拒绝（抛 `CostProfileContractError`），不返回部分数据——设置页保存的是整份订阅设置，
 * 少显示一条再保存就等于删掉它。未知字段同样拒绝。
 */
export function parseCostProfile(value: unknown): CostProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, VIEW_KEYS)) violation('invalid-profile');
  const revision = value.revision;
  if (!isRevision(revision)) violation('invalid-revision');
  const issues: Issue[] = [];
  const drafts = parsePlans(value.plans, 'view', new Map(), null, issues);
  const toolBillingModes = parseBillingModes(value.toolBillingModes, issues);
  // null：设置文件里的汇率无法识别，人民币换算不可得（GLB-01），不是 0 也不是 7.2。
  const cnyPerUsd = value.cnyPerUsd === null ? null : parseRate(value.cnyPerUsd, issues);
  if (issues.length > 0) violation(`${issues[0].field}:${issues[0].code}`);
  const plans = drafts.map(toPlan);
  if (!toolBillingModes || cnyPerUsd === undefined || plans.some((plan) => plan === null || plan.id === null)) {
    violation('incomplete-profile');
  }
  return { revision, plans: plans as CostSubscriptionPlan[], toolBillingModes, cnyPerUsd };
}

function parseFieldError(value: unknown): CostProfileFieldError {
  if (!isRecord(value) || !hasOnlyKeys(value, ERROR_KEYS)) violation('invalid-field-error');
  const { planIndex, field, itemIndex, key, relatedPlanIndex, code, message } = value;
  if (!isIndex(planIndex) || !isIndex(itemIndex) || !isIndex(relatedPlanIndex)
    || typeof field !== 'string' || typeof code !== 'string' || !ERROR_CODES.has(code)
    || (key !== null && typeof key !== 'string')
    || typeof message !== 'string' || message.trim() === '') violation('invalid-field-error');
  // 订阅内的字段必须指明是第几个订阅；整份设置的字段不指向任何订阅。
  const planField = PLAN_FIELDS.has(field);
  if (!planField && !PROFILE_FIELDS.has(field)) violation('invalid-field-error');
  if (planField !== (planIndex !== null)) violation('invalid-field-error');
  if (relatedPlanIndex !== null && (planIndex === null || relatedPlanIndex >= planIndex)) violation('invalid-field-error');
  return {
    planIndex,
    field: field as Field,
    itemIndex,
    key: key as string | null,
    relatedPlanIndex,
    code: code as Code,
    message,
  };
}

/** `validate_cost_profile` 的返回：`valid` 与「没有错误」必须一致。 */
export function parseCostProfileValidation(value: unknown): CostProfileValidation {
  if (!isRecord(value) || !hasOnlyKeys(value, VALIDATION_KEYS)) violation('invalid-validation');
  const { valid, errors: rawErrors } = value;
  if (typeof valid !== 'boolean' || !Array.isArray(rawErrors)) violation('invalid-validation');
  const errors = rawErrors.map(parseFieldError);
  if (valid !== (errors.length === 0)) violation('validation-mismatch');
  return { valid, errors };
}

/**
 * `save_cost_profile` 与 `clear_cost_profile` 的返回。`saved` 的 revision 至少为 1，`cleared`
 * 必须与保存后的内容一致。
 */
export function parseCostProfileSaveResult(value: unknown): CostProfileSaveResult {
  if (!isRecord(value)) violation('invalid-save-result');
  const { status, profile: rawProfile, cleared, currentRevision, errors } = value;
  if (status === 'saved') {
    if (!hasOnlyKeys(value, SAVED_KEYS) || typeof cleared !== 'boolean') violation('invalid-save-result');
    const profile = parseCostProfile(rawProfile);
    if (profile.revision < 1) violation('invalid-revision');
    if (cleared !== isCostProfileCleared(profile)) violation('cleared-mismatch');
    return { status: 'saved', profile, cleared };
  }
  if (status === 'conflict') {
    if (!hasOnlyKeys(value, CONFLICT_KEYS) || !isRevision(currentRevision)) violation('invalid-save-result');
    return { status: 'conflict', currentRevision };
  }
  if (status === 'invalid') {
    if (!hasOnlyKeys(value, INVALID_KEYS) || !Array.isArray(errors) || errors.length === 0) violation('invalid-save-result');
    return { status: 'invalid', errors: errors.map(parseFieldError) };
  }
  return violation('invalid-save-result');
}

/** `clear_cost_profile` 的返回：只能是规范空状态的 `saved`，或 `conflict`；删除全部没有校验错误。 */
export function parseCostProfileClearResult(value: unknown): CostProfileClearResult {
  const result = parseCostProfileSaveResult(value);
  if (result.status === 'conflict') return result;
  if (result.status === 'saved' && result.cleared) return { status: 'saved', profile: result.profile, cleared: true };
  return violation('invalid-clear-result');
}

/** 读取订阅设置（`get_cost_profile`）。 */
export async function getCostProfile(): Promise<CostProfile> {
  return parseCostProfile(await invoke<unknown>('get_cost_profile'));
}

/** 只校验、不写入（`validate_cost_profile`），用于设置页就地显示字段级错误。 */
export async function validateCostProfile(profile: CostProfileInput): Promise<CostProfileValidation> {
  return parseCostProfileValidation(await invoke<unknown>('validate_cost_profile', { profile }));
}

/** 按 revision 条件保存整份订阅设置（`save_cost_profile`）。删除全部用 `clearCostProfile`。 */
export async function saveCostProfile(profile: CostProfileInput, expectedRevision: number): Promise<CostProfileSaveResult> {
  return parseCostProfileSaveResult(await invoke<unknown>('save_cost_profile', { profile, expectedRevision }));
}

/** 「删除全部订阅设置」（`clear_cost_profile`），与保存一样按 revision 条件执行。 */
export async function clearCostProfile(expectedRevision: number): Promise<CostProfileClearResult> {
  return parseCostProfileClearResult(await invoke<unknown>('clear_cost_profile', { expectedRevision }));
}

/**
 * 把读到的订阅设置转成可提交的形态（去掉 revision，另作 `expectedRevision` 传）。
 * 汇率不可得（null）时原样保留，由校验要求用户填写，不代填默认值。
 */
export function costProfileInput(profile: CostProfile): CostProfileInput {
  return {
    plans: profile.plans.map((plan) => ({
      ...plan,
      tools: [...plan.tools],
      modelPrefixes: [...plan.modelPrefixes],
      machines: [...plan.machines],
    })),
    toolBillingModes: { ...profile.toolBillingModes },
    cnyPerUsd: profile.cnyPerUsd,
  };
}

const MESSAGES: Readonly<Record<string, string>> = {
  'profile.required': '缺少订阅设置',
  profile: '订阅设置格式无效',
  'plans.too_many': '最多登记 12 个订阅',
  plans: '订阅列表格式无效',
  plan: '订阅格式无效',
  'id.duplicate': '订阅 ID 重复',
  id: '订阅 ID 无效',
  'name.required': '请填写订阅名称',
  'name.too_long': '订阅名称最多 40 个字',
  'name.duplicate': '已有同名订阅',
  name: '订阅名称不能包含控制字符、零宽字符或文字方向控制字符',
  provider: '请选择服务商',
  'fee.required': '请填写订阅费',
  'fee.precision': '订阅费最多两位小数',
  fee: '订阅费需大于 0，且不超过 100,000',
  currency: '请选择币种（美元或人民币）',
  cycle: '请选择计费周期（每月或每年）',
  anchorDay: '计费日需是 1 到 31 的整数；大于当月天数时按月末扣费',
  'startDate.required': '请填写开始日期',
  'startDate.out_of_range': '开始日期不能早于 2020-01-01',
  'startDate.in_future': '开始日期不能晚于今天',
  startDate: '开始日期应为有效日期（YYYY-MM-DD）',
  'endDate.before_start': '结束日期不能早于开始日期',
  endDate: '结束日期应为有效日期（YYYY-MM-DD），仍在订阅就留空',
  'tools.required': '至少选择一个工具',
  'tools.too_many': '最多选择 16 个工具',
  'tools.duplicate': '工具重复',
  'tools.too_long': '工具 ID 过长',
  tools: '工具 ID 无效',
  'modelPrefixes.too_many': '最多 16 个模型前缀',
  'modelPrefixes.too_long': '模型前缀最多 64 个字符',
  'modelPrefixes.duplicate': '模型前缀重复（不区分大小写）',
  modelPrefixes: '模型前缀只能包含英文字母、数字和英文符号，不能有空格',
  'machines.too_many': '最多选择 16 台设备',
  'machines.duplicate': '设备重复',
  'machines.too_long': '设备 ID 过长',
  machines: '设备 ID 无效',
  'toolBillingModes.too_many': '付费方式最多 64 项',
  'toolBillingModes.required': '缺少付费方式',
  toolBillingModes: '付费方式格式无效',
  'cnyPerUsd.precision': '汇率最多 4 位小数',
  cnyPerUsd: '汇率需在 1 到 20 之间',
};

function messageOf(item: Issue, drafts: Draft[]): string {
  if (item.overlap && item.planIndex !== null && item.relatedPlanIndex !== null) {
    const label = (index: number) => drafts[index]?.name ?? `第 ${index + 1} 个订阅`;
    return `「${label(item.relatedPlanIndex)}」与「${label(item.planIndex)}」自 ${item.overlap.since} 起同时覆盖 ${item.overlap.tool}，`
      + '账本无法区分记录来自哪个订阅。请用模型前缀或设备区分，或合并为一个订阅（订阅费相加）。';
  }
  if (item.note === 'unknown-field') return item.field === 'plan' ? '订阅包含无法识别的字段' : '订阅设置包含无法识别的字段';
  if (item.note === 'tool-id') return '工具 ID 无效';
  if (item.note === 'billing-mode') return '付费方式只能是按量付费（payg）';
  return MESSAGES[`${item.field}.${item.code}`] ?? MESSAGES[item.field] ?? '订阅设置格式无效';
}

export interface CostProfileInputCheck {
  errors: CostProfileFieldError[];
  /** 没有错误时是规范化后的提交（名称去首尾空白、省略的可选字段补齐）；新订阅的 id 仍为 null。 */
  profile: (CostProfileInput & { cnyPerUsd: number }) | null;
}

/**
 * Rust `validate_cost_profile` 的前端镜像：同样的规则、错误顺序与提示文案，只给 devMock 与
 * 测试用。`today` 是本地日期 `YYYY-MM-DD`，即设置页录入时开始日期的上界（含）；`stored` 用来
 * 判断开始日期是否改过（没改过的不再按「不晚于今天」重判）。`null` 不是订阅设置，报 `required`。
 */
export function checkCostProfileInput(raw: unknown, stored: Pick<CostProfile, 'plans'>, today: string): CostProfileInputCheck {
  const issues: Issue[] = [];
  let drafts: Draft[] = [];
  if (!isRecord(raw)) {
    issues.push(issue(null, 'profile', requiredOrInvalid(raw)));
  } else {
    for (const key of Object.keys(raw)) {
      if (!INPUT_KEYS.has(key)) issues.push(issue(null, 'profile', 'invalid', { key, note: 'unknown-field' }));
    }
    const storedStarts = new Map(stored.plans.map((plan) => [plan.id, plan.startDate]));
    drafts = parsePlans(raw.plans, 'input', storedStarts, today, issues);
    const toolBillingModes = parseBillingModes(raw.toolBillingModes, issues);
    const cnyPerUsd = parseRate(raw.cnyPerUsd, issues);
    const plans = drafts.map(toPlan);
    if (issues.length === 0 && toolBillingModes && cnyPerUsd !== undefined && plans.every((plan) => plan !== null)) {
      return { errors: [], profile: { plans: plans as CostSubscriptionPlanInput[], toolBillingModes, cnyPerUsd } };
    }
  }
  const errors = issues.map((item): CostProfileFieldError => ({
    planIndex: item.planIndex,
    field: item.field,
    itemIndex: item.itemIndex,
    key: item.key,
    relatedPlanIndex: item.relatedPlanIndex,
    code: item.code,
    message: messageOf(item, drafts),
  }));
  return { errors, profile: null };
}
