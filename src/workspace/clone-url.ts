import type { RepositoryConfig } from '../config/schema.js';

export function buildCloneUrl(repo: RepositoryConfig): string {
  switch (repo.kind) {
    case 'github':
      return `https://github.com/${repo.repo}.git`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo.workspace}/${repo.repo_slug}.git`;
  }
}
