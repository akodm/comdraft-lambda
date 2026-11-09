import { GithubApiError } from './errors.ts';

const GITHUB_API_URL = 'https://api.github.com';

// 한 번에 보내는 GitHub 요청 수 (보조 rate limit 을 피하기 위해 제한)
const COMMIT_FETCH_CONCURRENCY = 5;

// 커밋 상세 (변경 파일과 patch 포함, 메모리에서만 사용하고 저장하지 않음)
export interface CommitDetail {
  sha: string;
  message: string;
  htmlUrl: string;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    // 파일이 크면 GitHub 이 생략함
    patch?: string;
  }>;
}

interface GithubCommitResponse {
  sha: string;
  html_url: string;
  commit: { message: string };
  files?: CommitDetail['files'];
}

export type FetchCommit = (input: {
  owner: string;
  repo: string;
  sha: string;
}) => Promise<CommitDetail>;

// 사용자 GitHub 토큰으로 커밋 상세 조회 (사용자가 접근 권한을 잃었으면 404)
export const createCommitFetcher = (
  token: string,
  fetchImpl: typeof fetch = fetch,
): FetchCommit => {
  return async ({ owner, repo, sha }) => {
    const response = await fetchImpl(
      `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'comdraft-lambda',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new GithubApiError(response.status);
    }

    const data = (await response.json()) as GithubCommitResponse;

    return {
      sha: data.sha,
      message: data.commit.message,
      htmlUrl: data.html_url,
      files: data.files ?? [],
    };
  };
};

// 선택한 커밋을 순서를 유지하며 동시 요청 수를 제한해 조회
export const fetchCommits = async (
  fetchCommit: FetchCommit,
  { owner, repo, shas }: { owner: string; repo: string; shas: string[] },
): Promise<CommitDetail[]> => {
  const results: CommitDetail[] = new Array(shas.length);
  let next = 0;

  const worker = async () => {
    while (next < shas.length) {
      const index = next++;
      results[index] = await fetchCommit({ owner, repo, sha: shas[index] });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(COMMIT_FETCH_CONCURRENCY, shas.length) },
      worker,
    ),
  );

  return results;
};
