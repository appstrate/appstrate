import { describe, expect, it } from "bun:test";

import { GithubImportError, parseGithubUrl } from "../../src/services/github-import";

describe("parseGithubUrl", () => {
  describe("standard repo URLs", () => {
    it("parses owner/repo URL", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: null, path: "" });
    });

    it("parses owner/repo with trailing slash", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo/");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: null, path: "" });
    });
  });

  describe("tree URLs (branch/path)", () => {
    it("parses URL with tree/branch", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo/tree/main");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: "main", path: "" });
    });

    it("parses URL with tree/branch/path", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo/tree/main/src/flows/my-flow");
      expect(result).toEqual({
        owner: "acme",
        repo: "my-repo",
        ref: "main",
        path: "src/flows/my-flow",
      });
    });

    it("parses URL with tree and nested path", () => {
      const result = parseGithubUrl(
        "https://github.com/acme/my-repo/tree/develop/deep/nested/path",
      );
      expect(result).toEqual({
        owner: "acme",
        repo: "my-repo",
        ref: "develop",
        path: "deep/nested/path",
      });
    });

    it("parses URL with tree/branch and trailing slash", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo/tree/main/src/");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: "main", path: "src" });
    });
  });

  describe("blob URLs", () => {
    it("parses blob URL with branch and file path", () => {
      const result = parseGithubUrl(
        "https://github.com/acme/my-repo/blob/main/src/index.ts",
      );
      expect(result).toEqual({
        owner: "acme",
        repo: "my-repo",
        ref: "main",
        path: "src/index.ts",
      });
    });
  });

  describe("ref variations", () => {
    it("parses URL with feature branch containing slashes in ref segment", () => {
      // Note: the parser treats segment[3] as the ref, so only the first segment after tree/ is the ref
      const result = parseGithubUrl(
        "https://github.com/acme/my-repo/tree/v1.0.0/src",
      );
      expect(result).toEqual({
        owner: "acme",
        repo: "my-repo",
        ref: "v1.0.0",
        path: "src",
      });
    });

    it("parses URL with tag ref", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo/tree/v2.3.1");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: "v2.3.1", path: "" });
    });

    it("parses URL with commit SHA ref", () => {
      const result = parseGithubUrl(
        "https://github.com/acme/my-repo/tree/abc1234/src",
      );
      expect(result).toEqual({
        owner: "acme",
        repo: "my-repo",
        ref: "abc1234",
        path: "src",
      });
    });
  });

  describe("invalid URLs", () => {
    it("returns null for non-GitHub URL", () => {
      expect(parseGithubUrl("https://gitlab.com/acme/my-repo")).toBeNull();
    });

    it("returns null for completely invalid URL", () => {
      expect(parseGithubUrl("not-a-url")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseGithubUrl("")).toBeNull();
    });

    it("returns null for GitHub URL with only owner (no repo)", () => {
      expect(parseGithubUrl("https://github.com/acme")).toBeNull();
    });

    it("returns null for GitHub root URL", () => {
      expect(parseGithubUrl("https://github.com/")).toBeNull();
    });

    it("returns null for unsupported action (not tree/blob)", () => {
      expect(parseGithubUrl("https://github.com/acme/my-repo/issues/42")).toBeNull();
    });

    it("returns null for tree URL without ref", () => {
      // segments = [owner, repo, "tree"] — length < 4
      expect(parseGithubUrl("https://github.com/acme/my-repo/tree")).toBeNull();
    });

    it("returns null for blob URL without ref", () => {
      expect(parseGithubUrl("https://github.com/acme/my-repo/blob")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles .git suffix in repo name", () => {
      // URL constructor preserves .git in pathname — the parser does not strip it
      const result = parseGithubUrl("https://github.com/acme/my-repo.git");
      expect(result).not.toBeNull();
      expect(result!.owner).toBe("acme");
      expect(result!.repo).toBe("my-repo.git");
    });

    it("ignores query parameters", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo?tab=code");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: null, path: "" });
    });

    it("ignores fragment", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo#readme");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: null, path: "" });
    });

    it("handles URL with multiple trailing slashes", () => {
      const result = parseGithubUrl("https://github.com/acme/my-repo///");
      expect(result).toEqual({ owner: "acme", repo: "my-repo", ref: null, path: "" });
    });
  });
});

describe("GithubImportError", () => {
  it("constructs with code and message", () => {
    const error = new GithubImportError("INVALID_URL", "Invalid GitHub URL");
    expect(error.code).toBe("INVALID_URL");
    expect(error.message).toBe("Invalid GitHub URL");
    expect(error.name).toBe("GithubImportError");
  });

  it("is an instance of Error", () => {
    const error = new GithubImportError("TEST_CODE", "test message");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GithubImportError);
  });

  it("has a stack trace", () => {
    const error = new GithubImportError("STACK_TEST", "stack check");
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain("GithubImportError");
  });
});
