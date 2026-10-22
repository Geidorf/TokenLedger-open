const REQUIRED_M10_TASKS = new Set(
  Array.from({ length: 10 }, (_, index) => `T10.${index}`),
);

function fail(message) {
  throw new Error(message);
}

function stripCode(value) {
  return value.replace(/^`|`$/g, '');
}

// Rows of the `### M10` section. The main ledger must have the section; the archive
// (`docs/TASKS-archive.md`, T10.211) only has it once some M10 row has been archived.
function m10Rows(markdown, label, required) {
  if (typeof markdown !== 'string') {
    fail(`${label} must be Markdown text`);
  }
  const start = markdown.search(/^### M10\b/m);
  if (start < 0) {
    if (required) fail(`${label} is missing the M10 milestone`);
    return [];
  }
  const remainder = markdown.slice(start);
  const firstLineEnd = remainder.indexOf('\n');
  const body = firstLineEnd < 0 ? '' : remainder.slice(firstLineEnd + 1);
  const nextSection = body.search(/^#{2,3} /m);
  const section = nextSection < 0
    ? remainder
    : remainder.slice(0, firstLineEnd + 1 + nextSection);
  const tasks = [];
  for (const line of section.split(/\r?\n/)) {
    if (!/^\|\s*T10[.]/.test(line)) {
      continue;
    }
    const columns = line.split('|').slice(1, -1).map((value) => value.trim());
    if (columns.length !== 8) {
      fail(`M10 task row has ${columns.length} columns instead of 8`);
    }
    const [id, , , , status, integration, validation] = columns;
    if (!/^T10[.]\d+(?:[a-z])?$/.test(id)) {
      fail(`M10 task id ${id} has an invalid format`);
    }
    tasks.push({
      id,
      status,
      integration: stripCode(integration),
      validation: stripCode(validation),
    });
  }
  return tasks;
}

/**
 * M10 rows from the main ledger plus, when given, the archive: archived rows are closed
 * tasks that moved out of `docs/TASKS.md`, so the public RC exit still counts them.
 */
export function parseM10Tasks(markdown, archiveMarkdown = null) {
  const tasks = [
    ...m10Rows(markdown, 'TASKS ledger', true),
    ...(archiveMarkdown === null ? [] : m10Rows(archiveMarkdown, 'TASKS archive', false)),
  ];
  if (tasks.length === 0) {
    fail('TASKS ledger contains no M10 task rows');
  }
  const ids = tasks.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    fail('TASKS ledger contains duplicate M10 task ids');
  }
  for (const required of REQUIRED_M10_TASKS) {
    if (!ids.includes(required)) {
      fail(`TASKS ledger is missing required public RC task ${required}`);
    }
  }
  return tasks;
}

export function assertM10PublicRcExit(markdown, archiveMarkdown = null) {
  const tasks = parseM10Tasks(markdown, archiveMarkdown);
  const incomplete = tasks.filter(
    (task) =>
      task.status !== '[x]'
      || task.integration !== 'merged-remote'
      || task.validation !== 'complete',
  );
  if (incomplete.length > 0) {
    fail(
      'public RC M10 exit is not closed: '
        + incomplete
          .map(
            ({ id, status, integration, validation }) =>
              `${id}=${status}/${integration}/${validation}`,
          )
          .join(', '),
    );
  }
  return tasks;
}

export function assertReleaseLedgerForChannel(channel, markdown, archiveMarkdown = null) {
  if (channel === 'public-rc') {
    return assertM10PublicRcExit(markdown, archiveMarkdown);
  }
  return [];
}
