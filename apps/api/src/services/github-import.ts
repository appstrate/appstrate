import { zipArtifact } from "@appstrate/core/zip";

const MAX_FILES = 50;
const MAX_FILE_SIZE = 1_000_000; // 1 MB per file
const MAX_TOTAL_SIZE = 5_000_000; // 5 MB total
const FETCH_TIMEOUT = 30_000; // 30s

export interface GithubRef {
  owner: string;
  repo: string;
  ref: string | null; // null = default branch
  path: string; // "" = repo root
}

/**
 * Parse a GitHub URL into its components.
 * Supports:
 *   github.com/{owner}/{repo}
 *   github.com/{owner}/{repo}/tree/{ref}/{path}
 *   github.com/{owner}/{repo}/blob/{ref}/{path}
 */
export function parseGithubUrl(url: string): GithubRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "github.com") return null;

  // Remove leading slash, split segments
  const segments = parsed.pathname.slice(1).split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  const repo = segments[1]!;

  // github.com/{owner}/{repo}
  if (segments.length === 2) {
    return { owner, repo, ref: null, path: "" };
  }

  const action = segments[2]; // "tree", "blob", etc.
  if (action !== "tree" && action !== "blob") return null;
  if (segments.length < 4) return null;

  const ref = segments[3]!;
  const path = segments.slice(4).join("/");

  return { owner, repo, ref, path };
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

/**
 * Fetch a directory from GitHub and return it as a ZIP.
 * Uses the Trees API (1 API call) + raw.githubusercontent.com (no rate limit).
 */
export async function fetchGithubDirectory(url: string): Promise<Uint8Array> {
  const parsed = parseGithubUrl(url);
  if (!parsed) {
    throw new GithubImportError("INVALID_URL", "Invalid GitHub URL");
  }

  const { owner, repo, path } = parsed;
  let ref = parsed.ref;

  // Resolve default branch if no ref in URL
  if (!ref) {
    const repoInfo = await githubApiFetch<{ default_branch: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
    );
    ref = repoInfo.default_branch;
  }

  // Fetch full tree in one API call
  const tree = await githubApiFetch<{ tree: TreeEntry[]; truncated: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
  );

  if (tree.truncated) {
    throw new GithubImportError("REPO_TOO_LARGE", "Repository is too large for direct import");
  }

  // Filter entries by path prefix
  const prefix = path ? `${path}/` : "";
  const blobs = tree.tree.filter(
    (e) => e.type === "blob" && (prefix ? e.path.startsWith(prefix) : true),
  );

  if (blobs.length === 0) {
    throw new GithubImportError("EMPTY_PATH", `No files found in '${path || "/"}'`);
  }

  if (blobs.length > MAX_FILES) {
    throw new GithubImportError(
      "TOO_MANY_FILES",
      `Too many files (${blobs.length}, max ${MAX_FILES})`,
    );
  }

  // Check total size estimate
  const totalSize = blobs.reduce((sum, b) => sum + (b.size ?? 0), 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new GithubImportError(
      "TOO_LARGE",
      `Total size too large (${Math.round(totalSize / 1024)}KB, max ${MAX_TOTAL_SIZE / 1024}KB)`,
    );
  }

  // Download all files via raw.githubusercontent.com (no API rate limit)
  const files: Record<string, Uint8Array> = {};

  const downloads = blobs.map(async (blob) => {
    if (blob.size && blob.size > MAX_FILE_SIZE) {
      throw new GithubImportError(
        "FILE_TOO_LARGE",
        `File '${blob.path}' is too large (${Math.round(blob.size / 1024)}KB, max ${MAX_FILE_SIZE / 1024}KB)`,
      );
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${blob.path}`;
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });

    if (!res.ok) {
      throw new GithubImportError(
        "DOWNLOAD_FAILED",
        `Failed to download '${blob.path}' (HTTP ${res.status})`,
      );
    }

    const data = new Uint8Array(await res.arrayBuffer());

    // Relativize path: remove the prefix to keep the folder structure relative
    const relativePath = prefix ? blob.path.slice(prefix.length) : blob.path;
    files[relativePath] = data;
  });

  await Promise.all(downloads);

  if (Object.keys(files).length === 0) {
    throw new GithubImportError("EMPTY_PATH", "No files downloaded");
  }

  return zipArtifact(files, 6);
}

export class GithubImportError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubImportError";
  }
}

async function githubApiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Appstrate" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (res.status === 404) {
    throw new GithubImportError("NOT_FOUND", "Repository or branch not found");
  }
  if (res.status === 403 || res.status === 429) {
    throw new GithubImportError(
      "RATE_LIMITED",
      "GitHub rate limit reached, please try again in a few minutes",
    );
  }
  if (!res.ok) {
    throw new GithubImportError("GITHUB_ERROR", `GitHub error (HTTP ${res.status})`);
  }

  return (await res.json()) as T;
}
