import { describe, test, expect } from "bun:test";
import { parseGithubUrl } from "../github-import.ts";

describe("parseGithubUrl", () => {
  test("tree URL with path → owner, repo, ref, path", () => {
    const result = parseGithubUrl(
      "https://github.com/mattpocock/skills/tree/main/git-guardrails-claude-code",
    );
    expect(result).toEqual({
      owner: "mattpocock",
      repo: "skills",
      ref: "main",
      path: "git-guardrails-claude-code",
    });
  });

  test("tree URL with nested path", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/tree/develop/src/components/auth");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "develop",
      path: "src/components/auth",
    });
  });

  test("blob URL → parsed like tree", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/blob/main/README.md");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "README.md",
    });
  });

  test("repo root URL → ref null, path empty", () => {
    const result = parseGithubUrl("https://github.com/mattpocock/skills");
    expect(result).toEqual({
      owner: "mattpocock",
      repo: "skills",
      ref: null,
      path: "",
    });
  });

  test("tree URL at repo root (no path)", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/tree/main");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "",
    });
  });

  test("tag as ref", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/tree/v1.0.0/src");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "v1.0.0",
      path: "src",
    });
  });

  test("commit SHA as ref", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/tree/abc123def456/src");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "abc123def456",
      path: "src",
    });
  });

  // --- Invalid URLs ---

  test("non-GitHub URL → null", () => {
    expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  test("invalid URL → null", () => {
    expect(parseGithubUrl("not-a-url")).toBeNull();
  });

  test("GitHub URL with only owner → null", () => {
    expect(parseGithubUrl("https://github.com/owner")).toBeNull();
  });

  test("GitHub issues URL → null", () => {
    expect(parseGithubUrl("https://github.com/owner/repo/issues/42")).toBeNull();
  });

  test("GitHub pull URL → null", () => {
    expect(parseGithubUrl("https://github.com/owner/repo/pull/1")).toBeNull();
  });

  test("tree URL without ref → null", () => {
    expect(parseGithubUrl("https://github.com/owner/repo/tree")).toBeNull();
  });

  test("URL with trailing slash is handled", () => {
    const result = parseGithubUrl("https://github.com/owner/repo/tree/main/src/");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "src",
    });
  });

  test("http URL is accepted", () => {
    const result = parseGithubUrl("http://github.com/owner/repo/tree/main/src");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "src",
    });
  });
});
