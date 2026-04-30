#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const categoryOrder = [
  'Breaking Changes',
  'Features',
  'Fixes',
  'Performance',
  'Maintenance',
  'Other Changes',
];

const looseVerbToCategory = new Map([
  ['add', 'Features'],
  ['build', 'Maintenance'],
  ['cleanup', 'Maintenance'],
  ['ci', 'Maintenance'],
  ['docs', 'Maintenance'],
  ['fix', 'Fixes'],
  ['get', 'Maintenance'],
  ['implement', 'Features'],
  ['improve', 'Maintenance'],
  ['make', 'Maintenance'],
  ['perf', 'Performance'],
  ['refactor', 'Maintenance'],
  ['remove', 'Maintenance'],
  ['revert', 'Other Changes'],
  ['support', 'Features'],
  ['update', 'Maintenance'],
]);

function parseArgs(argv) {
  const result = {
    format: 'preview',
    limit: 8,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--format') {
      result.format = argv[index + 1] ?? result.format;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.limit = parsed;
      }
      index += 1;
    }
  }

  return result;
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getLatestTag() {
  return runGit(['describe', '--tags', '--abbrev=0']);
}

function getCommitsSinceLatestTag() {
  const latestTag = getLatestTag();
  const args = latestTag
    ? ['log', '--pretty=format:%H%x1f%s%x1f%b%x1e', `${latestTag}..HEAD`]
    : ['log', '--max-count=20', '--pretty=format:%H%x1f%s%x1f%b%x1e'];
  const output = runGit(args);
  if (!output) {
    return {
      commits: [],
      latestTag,
    };
  }

  const commits = output
    .split('\x1e')
    .map((rawEntry) => rawEntry.trim())
    .filter(Boolean)
    .map((rawEntry) => {
      const [sha = '', subject = '', body = ''] = rawEntry.split('\x1f');
      return {
        body: body.trim(),
        sha: sha.trim(),
        subject: subject.trim(),
      };
    })
    .filter((entry) => entry.subject.length > 0);

  return {
    commits,
    latestTag,
  };
}

function normalizeSummary(summary) {
  return summary
    .replace(/\s+\([^)]+\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateLine(value, maxLength = 120) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function classifyCommit(subject) {
  const conventional = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<summary>.+)$/i.exec(subject);
  if (conventional?.groups) {
    const rawType = conventional.groups.type.toLowerCase();
    const summary = normalizeSummary(conventional.groups.summary);
    if (conventional.groups.breaking) {
      return {
        category: 'Breaking Changes',
        summary,
      };
    }
    if (rawType === 'feat') {
      return { category: 'Features', summary };
    }
    if (rawType === 'fix') {
      return { category: 'Fixes', summary };
    }
    if (rawType === 'perf') {
      return { category: 'Performance', summary };
    }
    if (['refactor', 'chore', 'build', 'ci', 'docs', 'test'].includes(rawType)) {
      return { category: 'Maintenance', summary };
    }
    if (rawType === 'revert') {
      return { category: 'Other Changes', summary };
    }
    return { category: 'Other Changes', summary };
  }

  const loose = /^(?<verb>add|build|cleanup|ci|docs|fix|get|implement|improve|make|perf|refactor|remove|revert|support|update)\b[: -]?\s*(?<summary>.+)$/i.exec(subject);
  if (loose?.groups) {
    const verb = loose.groups.verb.toLowerCase();
    const category = looseVerbToCategory.get(verb) ?? 'Other Changes';
    return {
      category,
      summary: normalizeSummary(loose.groups.summary),
    };
  }

  return {
    category: 'Other Changes',
    summary: normalizeSummary(subject),
  };
}

function groupCommitNotes(commits, limit) {
  const grouped = new Map();
  for (const category of categoryOrder) {
    grouped.set(category, []);
  }

  for (const commit of commits) {
    const { category, summary } = classifyCommit(commit.subject);
    const entries = grouped.get(category) ?? [];
    if (!entries.includes(summary)) {
      entries.push(summary);
      grouped.set(category, entries);
    }
  }

  const ordered = [];
  for (const category of categoryOrder) {
    const entries = grouped.get(category) ?? [];
    if (entries.length > 0) {
      ordered.push([category, entries.slice(0, limit)]);
    }
  }
  return ordered;
}

function parseLatestChangelogRelease() {
  if (!fs.existsSync(changelogPath)) {
    return null;
  }

  const source = fs.readFileSync(changelogPath, 'utf8');
  const headerPattern = /^##\s+\[?v?(?<version>\d+\.\d+\.\d+[^\]\s]*)\]?(?:\s+\((?<date>[^)]+)\))?/gm;
  const match = headerPattern.exec(source);
  if (!match?.groups) {
    return null;
  }

  const startIndex = match.index + match[0].length;
  const nextMatch = headerPattern.exec(source);
  const endIndex = nextMatch ? nextMatch.index : source.length;
  const sectionSource = source.slice(startIndex, endIndex).trim();
  const sections = [];

  const lines = sectionSource.split(/\r?\n/);
  let currentSection = '';
  let currentItems = [];

  const flush = () => {
    if (currentSection && currentItems.length > 0) {
      sections.push([currentSection, [...currentItems]]);
    }
    currentItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = /^###\s+(.+)$/.exec(line);
    if (headingMatch) {
      flush();
      currentSection = headingMatch[1].trim();
      continue;
    }
    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      currentItems.push(
        bulletMatch[1]
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
  }
  flush();

  return {
    date: match.groups.date?.trim() ?? '',
    sections,
    version: match.groups.version.trim(),
  };
}

function buildPreviewFromCommits(commitData, limit) {
  if (commitData.commits.length === 0) {
    return '';
  }

  const grouped = groupCommitNotes(commitData.commits, limit);
  const heading = commitData.latestTag
    ? `## Unreleased since ${commitData.latestTag}`
    : '## Unreleased changes';
  const lines = [heading];

  for (const [category, entries] of grouped) {
    lines.push('', `### ${category}`);
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

function buildTestflightNotesFromSections(versionLabel, sections, limit) {
  const lines = [];
  if (versionLabel) {
    lines.push(`Build notes for ${versionLabel}`);
  } else {
    lines.push('Build notes');
  }

  let included = 0;
  for (const [category, entries] of sections) {
    if (included >= limit) {
      break;
    }
    for (const entry of entries) {
      if (included >= limit) {
        break;
      }
      lines.push(`- ${truncateLine(entry)}`);
      included += 1;
    }
  }

  return truncateForTestflight(lines.join('\n'));
}

function truncateForTestflight(value) {
  const hardLimit = 3900;
  if (value.length <= hardLimit) {
    return value;
  }

  return `${value.slice(0, hardLimit - 3).trimEnd()}...`;
}

function buildMessageFromCommitData(commitData) {
  if (commitData.commits.length === 0) {
    return '';
  }

  if (commitData.latestTag) {
    return `Preview build from ${commitData.commits.length} change${commitData.commits.length === 1 ? '' : 's'} since ${commitData.latestTag}`;
  }

  return `Preview build from ${commitData.commits.length} recent change${commitData.commits.length === 1 ? '' : 's'}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const commitData = getCommitsSinceLatestTag();
  const latestRelease = parseLatestChangelogRelease();

  if (args.format === 'build-message') {
    const fromCommits = buildMessageFromCommitData(commitData);
    if (fromCommits) {
      process.stdout.write(`${fromCommits}\n`);
      return;
    }
    if (latestRelease?.version) {
      process.stdout.write(`Release v${latestRelease.version}\n`);
    }
    return;
  }

  if (args.format === 'testflight') {
    if (commitData.commits.length > 0) {
      const grouped = groupCommitNotes(commitData.commits, args.limit);
      process.stdout.write(`${buildTestflightNotesFromSections(commitData.latestTag ? `changes since ${commitData.latestTag}` : 'latest preview', grouped, args.limit)}\n`);
      return;
    }
    if (latestRelease) {
      process.stdout.write(`${buildTestflightNotesFromSections(`v${latestRelease.version}`, latestRelease.sections, args.limit)}\n`);
    }
    return;
  }

  const fromCommits = buildPreviewFromCommits(commitData, args.limit);
  if (fromCommits) {
    process.stdout.write(fromCommits);
    return;
  }

  if (latestRelease) {
    const lines = [`## Release v${latestRelease.version}`];
    for (const [sectionName, entries] of latestRelease.sections) {
      lines.push('', `### ${sectionName}`);
      for (const entry of entries.slice(0, args.limit)) {
        lines.push(`- ${entry}`);
      }
    }
    process.stdout.write(`${lines.join('\n').trim()}\n`);
  }
}

main();
