import type {
  BehaviorAnalysisResponse,
  BehaviorProject,
  BehaviorProjectDimensionMeta,
  BehaviorProjectFailureCode,
  BehaviorProjectKind,
  BehaviorProjectRef,
  BehaviorProjectsRemainder,
  BehaviorSessionProjectReason,
  BehaviorUnattributed,
  BehaviorUnattributedReason,
  BehaviorUnattributedReasonRow,
} from '../../types';
import { isRecord } from './internal';

/** 项目筛选的保留值：全部未归属（行为契约 v1.2）。 */
export const BEHAVIOR_UNATTRIBUTED_FILTER_KEY = '@unattributed';

/** 项目维度未开启或授权版本过低时，带非空项目筛选得到的错误码（行为契约 v1.2）。 */
export const BEHAVIOR_PROJECT_DIMENSION_DISABLED = 'project_dimension_disabled';

/**
 * 本机项目索引读不出来时，带非空项目筛选得到的错误码（行为契约 v1.2）。不带筛选时响应省略
 * `meta.projectDimension`，按「后端不支持」处理。
 */
export const BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE = 'project_dimension_unavailable';

/** Top-level fields v1.2 adds while the index collects. */
const TOP_LEVEL_PROJECT_FIELDS = ['projects', 'projectLimit', 'projectsTruncated', 'projectsRemainder', 'unattributed'] as const;
/** `meta.projectDimension` fields that exist only while the index collects. */
const COLLECTING_META_FIELDS = ['indexedSessions', 'pendingSessions', 'filter', 'lastFailure'] as const;
const OFF_STATES = new Set<string>(['disabled', 'consent_required']);
const COLLECTING_STATES = new Set<string>(['indexing', 'ready', 'failed']);
const GROUP_KINDS = new Set<string>(['home', 'root', 'temp', 'managed']);
const REASONS: readonly BehaviorUnattributedReason[] = ['unsupported_source', 'unresolved', 'pending', 'missing_session'];
const SESSION_REASONS = new Set<string>(['unsupported_source', 'unresolved', 'pending']);
/** The only backfill failure codes the native view passes on (review P3-1). */
const FAILURE_CODES = new Set<string>(['database_error', 'internal_error']);
/** Index constraint on a stored folder name (characters). */
const LABEL_MAX_CHARS = 256;
/** A key is `n:` plus the lower-case name; lower-casing may lengthen a name a little. */
const KEY_MAX_CHARS = 1024;
/** Control, bidi-override and path-separator characters never belong in a name or key. */
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/;

class ProjectContractViolation extends Error {}

function violation(problem: string): never {
  throw new ProjectContractViolation(problem);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function count(value: unknown, problem: string): number {
  return isCount(value) ? value : violation(problem);
}

function cost(value: unknown, problem: string): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : violation(problem);
}

/** A share exists exactly when `summary.tokens > 0`; its ratio is checked with the invariants. */
function share(value: unknown, total: number, problem: string): number | null {
  if (total === 0) return value === null ? null : violation(problem);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) violation(problem);
  return value;
}

function characters(value: string): number {
  return [...value].length;
}

function projectRef(value: unknown): BehaviorProjectRef {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.kind !== 'string') violation('invalid-project-ref');
  const { key, kind, label } = value;
  if (kind === 'named') {
    if (typeof label !== 'string' || label.trim() === '' || characters(label) > LABEL_MAX_CHARS
      || FORBIDDEN_NAME_CHARS.test(label)) violation('invalid-project-label');
    const name = key.startsWith('n:') ? key.slice(2) : '';
    if (name === '' || characters(key) > KEY_MAX_CHARS || FORBIDDEN_NAME_CHARS.test(name)) violation('invalid-project-key');
    // The key is derived from the name and carries nothing more, e.g. no hash (review P3-2).
    if (key !== `n:${label.toLowerCase()}`) violation('project-key-mismatch');
    return { key, label, kind };
  }
  if (!GROUP_KINDS.has(kind)) violation('invalid-project-kind');
  // Fixed groups carry no name: the front end shows its own words.
  if (label !== null || key !== `@${kind}`) violation('invalid-group-ref');
  return { key, label: null, kind: kind as BehaviorProjectKind };
}

function tools(value: unknown): BehaviorProject['tools'] {
  if (!Array.isArray(value)) violation('invalid-project-tools');
  return value.map((tool) => {
    if (!isRecord(tool) || typeof tool.id !== 'string' || tool.id === '') violation('invalid-project-tools');
    return { id: tool.id, tokens: count(tool.tokens, 'invalid-project-tools') };
  });
}

interface Summary {
  tokens: number;
  requests: number;
  sessionCount: number;
  totalCost: number | null | undefined;
  /** v1.1 fields, as sent; checked against `missing_session` only when present (invariant 6). */
  unknownSessionRecords: unknown;
  unknownSessionTokens: unknown;
}

/** Relative tolerance of a share against `tokens / summary.tokens` (contract client rules). */
const SHARE_TOLERANCE = 1e-9;

interface CollectingFields {
  projects: BehaviorProject[];
  projectLimit: number;
  projectsTruncated: boolean;
  projectsRemainder: BehaviorProjectsRemainder | null;
  unattributed: BehaviorUnattributed;
  sessions: Array<{ project: BehaviorProjectRef | null; projectReason?: BehaviorSessionProjectReason }>;
}

interface ParsedSection {
  dimension: BehaviorProjectDimensionMeta;
  collecting: CollectingFields | null;
}

function summaryOf(raw: Record<string, unknown>): Summary {
  const summary = raw.summary;
  if (!isRecord(summary)) violation('missing-summary');
  const totalCost = summary.totalCost;
  if (totalCost !== undefined && totalCost !== null && (typeof totalCost !== 'number' || !Number.isFinite(totalCost))) {
    violation('invalid-summary');
  }
  return {
    tokens: count(summary.tokens, 'invalid-summary'),
    requests: count(summary.requests, 'invalid-summary'),
    sessionCount: count(summary.sessionCount, 'invalid-summary'),
    totalCost: totalCost as number | null | undefined,
    unknownSessionRecords: summary.unknownSessionRecords,
    unknownSessionTokens: summary.unknownSessionTokens,
  };
}

function hasSessionProjectFields(session: unknown): boolean {
  return isRecord(session) && ('project' in session || 'projectReason' in session);
}

function parseSection(raw: Record<string, unknown>, dimension: unknown): ParsedSection {
  if (!isRecord(dimension) || typeof dimension.state !== 'string') violation('invalid-state');
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : violation('missing-sessions');
  if (OFF_STATES.has(dimension.state)) {
    // Off or paused: the state alone, never a project field (invariant 5).
    // Unknown fields are left to later add-only versions and dropped here.
    if (COLLECTING_META_FIELDS.some((field) => field in dimension)
      || TOP_LEVEL_PROJECT_FIELDS.some((field) => field in raw) || sessions.some(hasSessionProjectFields)) {
      violation('project-data-while-off');
    }
    return { dimension: { state: dimension.state as 'disabled' | 'consent_required' }, collecting: null };
  }
  if (!COLLECTING_STATES.has(dimension.state)) violation('invalid-state');
  const state = dimension.state as 'indexing' | 'ready' | 'failed';
  if (!Array.isArray(dimension.filter) || dimension.filter.some((key) => typeof key !== 'string')) violation('invalid-filter');
  const filter = [...dimension.filter as string[]];
  const indexedSessions = count(dimension.indexedSessions, 'invalid-coverage');
  const pendingSessions = count(dimension.pendingSessions, 'invalid-coverage');
  const meta: BehaviorProjectDimensionMeta = { state, indexedSessions, pendingSessions, filter };
  if ('lastFailure' in dimension) {
    if (state !== 'failed') violation('invalid-last-failure');
    // Only the two fixed codes pass; any other value is an unknown failure
    // (null), exactly as the native view reports it (review P3-1).
    const failure = dimension.lastFailure;
    meta.lastFailure = typeof failure === 'string' && FAILURE_CODES.has(failure)
      ? failure as BehaviorProjectFailureCode
      : null;
  }

  const summary = summaryOf(raw);
  const total = summary.tokens;
  if (!Array.isArray(raw.projects)) violation('invalid-projects');
  const projectLimit = count(raw.projectLimit, 'invalid-project-limit');
  if (projectLimit === 0 || raw.projects.length > projectLimit) violation('invalid-project-limit');
  const seen = new Map<string, BehaviorProjectRef>();
  const projects: BehaviorProject[] = raw.projects.map((item) => {
    const ref = projectRef(item);
    if (seen.has(ref.key)) violation('duplicate-project-key');
    seen.set(ref.key, ref);
    const entry = item as Record<string, unknown>;
    return {
      ...ref,
      tokens: count(entry.tokens, 'invalid-project-totals'),
      requests: count(entry.requests, 'invalid-project-totals'),
      sessionCount: count(entry.sessionCount, 'invalid-project-totals'),
      cost: cost(entry.cost, 'invalid-project-cost'),
      share: share(entry.share, total, 'invalid-project-share'),
      tools: tools(entry.tools),
    };
  });

  if (typeof raw.projectsTruncated !== 'boolean') violation('invalid-remainder');
  const truncated = raw.projectsTruncated;
  let remainder: BehaviorProjectsRemainder | null = null;
  if (truncated) {
    const rest = raw.projectsRemainder;
    if (!isRecord(rest) || projects.length !== projectLimit) violation('invalid-remainder');
    remainder = {
      tokens: count(rest.tokens, 'invalid-remainder'),
      requests: count(rest.requests, 'invalid-remainder'),
      sessionCount: count(rest.sessionCount, 'invalid-remainder'),
      cost: cost(rest.cost, 'invalid-remainder'),
      share: share(rest.share, total, 'invalid-remainder'),
      projectCount: count(rest.projectCount, 'invalid-remainder'),
    };
    if (remainder.projectCount === 0) violation('invalid-remainder');
  } else if (raw.projectsRemainder !== null) {
    violation('invalid-remainder');
  }

  const other = raw.unattributed;
  if (!isRecord(other) || !Array.isArray(other.reasons)) violation('invalid-unattributed');
  const listed = new Set<string>();
  const reasons: BehaviorUnattributedReasonRow[] = other.reasons.map((row) => {
    if (!isRecord(row) || typeof row.reason !== 'string' || !REASONS.includes(row.reason as BehaviorUnattributedReason)
      || listed.has(row.reason)) violation('invalid-unattributed-reason');
    listed.add(row.reason);
    const reason = row.reason as BehaviorUnattributedReason;
    // Records without a session ID are no sessions: their count is unknown (null), never 0.
    const sessionCount = reason === 'missing_session'
      ? (row.sessionCount === null ? null : violation('invalid-unattributed-reason'))
      : count(row.sessionCount, 'invalid-unattributed-reason');
    return {
      reason,
      tokens: count(row.tokens, 'invalid-unattributed-reason'),
      requests: count(row.requests, 'invalid-unattributed-reason'),
      sessionCount,
      share: share(row.share, total, 'invalid-unattributed-reason'),
    };
  });
  const unattributed: BehaviorUnattributed = {
    tokens: count(other.tokens, 'invalid-unattributed'),
    requests: count(other.requests, 'invalid-unattributed'),
    sessionCount: count(other.sessionCount, 'invalid-unattributed'),
    cost: cost(other.cost, 'invalid-unattributed'),
    share: share(other.share, total, 'invalid-unattributed'),
    reasons,
  };

  // Invariants 1–2: projects, remainder and unattributed partition the summary.
  for (const field of ['tokens', 'requests', 'sessionCount'] as const) {
    const sum = projects.reduce((value, project) => value + project[field], 0)
      + (remainder?.[field] ?? 0) + unattributed[field];
    if (sum !== summary[field]) violation('partition-mismatch');
  }
  for (const field of ['tokens', 'requests', 'sessionCount'] as const) {
    if (reasons.reduce((value, row) => value + (row[field] ?? 0), 0) !== unattributed[field]) violation('reason-mismatch');
  }
  // GLB-01: an unavailable part makes the total unavailable, and only then.
  if (summary.totalCost !== undefined) {
    const partUnknown = [...projects, ...(remainder ? [remainder] : []), unattributed].some((part) => part.cost === null);
    if (partUnknown !== (summary.totalCost === null)) violation('cost-mismatch');
  }
  // Every share is `tokens / summary.tokens` (null when the total is 0, checked above).
  if (total > 0 && [...projects, ...(remainder ? [remainder] : []), unattributed, ...reasons].some((part) => {
    const expected = part.tokens / total;
    return part.share === null || Math.abs(part.share - expected) > SHARE_TOLERANCE * expected;
  })) {
    violation('share-mismatch');
  }
  // Invariant 6: records without a session ID are the v1.1 unknown-session records.
  const missing = reasons.find((row) => row.reason === 'missing_session');
  if ((summary.unknownSessionRecords !== undefined && summary.unknownSessionRecords !== (missing?.requests ?? 0))
    || (summary.unknownSessionTokens !== undefined && summary.unknownSessionTokens !== (missing?.tokens ?? 0))) {
    violation('missing-session-mismatch');
  }
  // Invariant 7: without a filter, coverage counts every real session once.
  if (filter.length === 0) {
    const pending = reasons.find((row) => row.reason === 'pending')?.sessionCount ?? 0;
    if (indexedSessions + pendingSessions !== summary.sessionCount || pending !== pendingSessions) {
      violation('coverage-mismatch');
    }
  }

  // Every session names its project, or null plus the reason, and matches the
  // ranking (invariant 3): a ranked project, one cut into the remainder, or a
  // listed reason.
  const sessionFields = sessions.map((session) => {
    if (!isRecord(session) || !('project' in session)) violation('invalid-session-project');
    if (session.project === null) {
      if (typeof session.projectReason !== 'string' || !SESSION_REASONS.has(session.projectReason)) {
        violation('invalid-session-project');
      }
      if (!listed.has(session.projectReason)) violation('session-project-mismatch');
      return { project: null, projectReason: session.projectReason as BehaviorSessionProjectReason };
    }
    if ('projectReason' in session) violation('invalid-session-project');
    const ref = projectRef(session.project);
    const ranked = seen.get(ref.key);
    if (ranked ? ranked.label !== ref.label || ranked.kind !== ref.kind : !truncated) violation('session-project-mismatch');
    return { project: ref };
  });

  return {
    dimension: meta,
    collecting: {
      projects,
      projectLimit,
      projectsTruncated: truncated,
      projectsRemainder: remainder,
      unattributed,
      sessions: sessionFields,
    },
  };
}

function withoutProjectFields(response: BehaviorAnalysisResponse): BehaviorAnalysisResponse {
  const next = { ...response } as BehaviorAnalysisResponse & Record<string, unknown>;
  for (const field of TOP_LEVEL_PROJECT_FIELDS) delete next[field];
  if (isRecord(response.meta)) {
    const meta = { ...response.meta };
    delete meta.projectDimension;
    next.meta = meta;
  }
  if (Array.isArray(response.sessions)) {
    next.sessions = response.sessions.map((session) => {
      if (!hasSessionProjectFields(session)) return session;
      const rest = { ...session };
      delete rest.project;
      delete rest.projectReason;
      return rest;
    });
  }
  return next;
}

function withProjectFields(response: BehaviorAnalysisResponse, section: ParsedSection): BehaviorAnalysisResponse {
  const next = withoutProjectFields(response);
  next.meta = { ...next.meta, projectDimension: section.dimension };
  const collecting = section.collecting;
  if (!collecting) return next;
  next.projects = collecting.projects;
  next.projectLimit = collecting.projectLimit;
  next.projectsTruncated = collecting.projectsTruncated;
  next.projectsRemainder = collecting.projectsRemainder;
  next.unattributed = collecting.unattributed;
  next.sessions = next.sessions.map((session, index) => ({ ...session, ...collecting.sessions[index] }));
  return next;
}

/**
 * Result of reading the v1.2 project fields: `problem` names the broken rule
 * (a fixed code, never response content) when the fields were dropped.
 */
export interface BehaviorProjectFieldsResult {
  response: BehaviorAnalysisResponse;
  problem: string | null;
}

/**
 * Fail-closed boundary for the behavior contract v1.2 project fields. v1.1
 * fields pass through untouched. Valid project fields are kept (known keys
 * only); if any of them breaks the contract, every project field is dropped,
 * `meta.projectDimension` included, so the page treats the response like one
 * from a backend without the dimension instead of showing partial or
 * inconsistent project data. A response without project fields is returned
 * as it is: a missing `meta.projectDimension` (an older backend, or a project
 * index that could not be read) means 「后端不支持」, never off or 0.
 */
export function inspectBehaviorProjectFields(response: BehaviorAnalysisResponse): BehaviorProjectFieldsResult {
  if (!isRecord(response)) return { response, problem: null };
  const raw = response as unknown as Record<string, unknown>;
  const dimension = isRecord(raw.meta) ? raw.meta.projectDimension : undefined;
  const hasProjectData = TOP_LEVEL_PROJECT_FIELDS.some((field) => field in raw)
    || (Array.isArray(raw.sessions) && raw.sessions.some(hasSessionProjectFields));
  if (dimension === undefined && !hasProjectData) return { response, problem: null };
  try {
    if (dimension === undefined) violation('project-data-without-state');
    return { response: withProjectFields(response, parseSection(raw, dimension)), problem: null };
  } catch (error) {
    if (!(error instanceof ProjectContractViolation)) throw error;
    return { response: withoutProjectFields(response), problem: error.message };
  }
}

export function parseBehaviorProjectFields(response: BehaviorAnalysisResponse): BehaviorAnalysisResponse {
  return inspectBehaviorProjectFields(response).response;
}
