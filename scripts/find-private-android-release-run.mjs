import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_FILE = 'release-rc.yml';

function fail(message) {
  throw new Error(message);
}

// 上一正式发布的 tag 由 release-lineage.mjs 在 preflight 阶段解析后经工作流
// 环境变量传入；这里不再写死任何版本号。
export function requirePreviousReleaseTag(value = process.env.TOKENLEDGER_PREVIOUS_RELEASE_TAG) {
  const tag = value?.trim();
  if (!tag || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
    fail(`TOKENLEDGER_PREVIOUS_RELEASE_TAG must be a formal vMAJOR.MINOR.PATCH tag, got ${tag || '<missing>'}`);
  }
  return tag;
}

function previousTagRefs(previousTag) {
  return [`@${previousTag}`, `@refs/tags/${previousTag}`];
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`required GitHub Actions value ${name} is missing`);
  }
  return value;
}

export function selectPrivateReleaseRun(runs, expectedSha, currentRunId, previousTag) {
  if (!Array.isArray(runs)) {
    fail('GitHub workflow-runs response is malformed');
  }
  const tagRefs = previousTagRefs(requirePreviousReleaseTag(previousTag));
  const candidates = runs
    .filter(
      (run) =>
        Number.isSafeInteger(run?.id)
        && run.status === 'completed'
        && run.conclusion === 'success'
        && run.event === 'push'
        && run.head_sha === expectedSha
        && typeof run.path === 'string'
        && tagRefs.some((suffix) => run.path.endsWith(suffix))
        && String(run.id) !== String(currentRunId),
    )
    .sort((left, right) => {
      const attempt = Number(right.run_attempt ?? 0) - Number(left.run_attempt ?? 0);
      return attempt || Number(right.id) - Number(left.id);
    });
  if (candidates.length === 0) {
    fail(`no successful ${previousTag} run matches immutable tag SHA ${expectedSha}`);
  }
  return candidates[0];
}

export function selectAndroidArtifact(artifacts) {
  if (!Array.isArray(artifacts)) {
    fail('GitHub artifacts response is malformed');
  }
  const matches = artifacts.filter(
    (artifact) =>
      Number.isSafeInteger(artifact?.id)
      && artifact.name === 'release-android'
      && artifact.expired === false,
  );
  if (matches.length !== 1) {
    fail(`expected one unexpired release-android artifact, found ${matches.length}`);
  }
  return matches[0];
}

async function githubJson(pathname, token) {
  const apiUrl = process.env.GITHUB_API_URL?.trim() || 'https://api.github.com';
  const response = await fetch(`${apiUrl}${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tokenledger-release-evidence',
    },
  });
  if (!response.ok) {
    fail(`GitHub Actions API ${pathname.split('?')[0]} returned HTTP ${response.status}`);
  }
  return response.json();
}

function appendGithubOutput(values) {
  const outputFile = requireValue('GITHUB_OUTPUT');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(outputFile, `${lines}\n`);
}

async function main() {
  const token = requireValue('GITHUB_TOKEN');
  const repository = requireValue('GITHUB_REPOSITORY');
  const currentRunId = requireValue('GITHUB_RUN_ID');
  const previousTag = requirePreviousReleaseTag();
  const expectedSha = execFileSync('git', ['rev-list', '-n', '1', previousTag], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    fail(`${previousTag} is missing or does not resolve to an immutable commit`);
  }

  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      event: 'push',
      status: 'success',
      head_sha: expectedSha,
      per_page: '100',
      page: String(page),
    });
    const response = await githubJson(
      `/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?${query}`,
      token,
    );
    if (!Array.isArray(response.workflow_runs)) {
      fail('GitHub workflow-runs response is malformed');
    }
    runs.push(...response.workflow_runs);
    if (response.workflow_runs.length < 100) {
      break;
    }
    if (page === 10) {
      fail('private release workflow lookup exceeded 1,000 matching runs');
    }
  }
  const run = selectPrivateReleaseRun(runs, expectedSha, currentRunId, previousTag);
  const artifactResponse = await githubJson(
    `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    token,
  );
  const artifact = selectAndroidArtifact(artifactResponse.artifacts);
  appendGithubOutput({
    run_id: run.id,
    run_url: run.html_url,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    artifact_id: artifact.id,
  });
  console.log(
    `Located immutable ${previousTag} Android artifact in successful workflow run ${run.id}.`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(`Private Android release lookup failed: ${error.message}`);
    process.exit(1);
  }
}
