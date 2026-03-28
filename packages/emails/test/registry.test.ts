import { describe, it, expect } from "bun:test";
import { renderEmail, registerEmailOverrides } from "../src/index.ts";
import type { EmailRenderer } from "../src/index.ts";

describe("email registry", () => {
  it("renders default verification template", () => {
    const result = renderEmail("verification", {
      user: { name: "Test", email: "test@example.com" },
      url: "https://example.com/verify",
      locale: "fr",
    });
    expect(result.subject).toBe("Vérifiez votre adresse email");
    expect(result.html).toContain("https://example.com/verify");
  });

  it("renders default invitation template", () => {
    const result = renderEmail("invitation", {
      email: "test@example.com",
      inviteUrl: "https://example.com/invite/abc/accept",
      orgName: "TestOrg",
      inviterName: "Admin",
      role: "member",
      locale: "fr",
    });
    expect(result.subject).toContain("TestOrg");
  });

  it("allows overriding a specific template", () => {
    const customVerification: EmailRenderer<"verification"> = (props) => ({
      subject: "Custom: Verify",
      html: `<p>Custom template for ${props.user.email}</p>`,
    });

    registerEmailOverrides({ verification: customVerification });

    const result = renderEmail("verification", {
      user: { name: "Test", email: "test@example.com" },
      url: "https://example.com/verify",
      locale: "fr",
    });
    expect(result.subject).toBe("Custom: Verify");
    expect(result.html).toContain("Custom template for test@example.com");
  });

  it("keeps non-overridden templates as defaults", () => {
    // After the override above, invitation should still be the default
    const result = renderEmail("invitation", {
      email: "test@example.com",
      inviteUrl: "https://example.com/invite/abc/accept",
      orgName: "TestOrg",
      inviterName: "Admin",
      role: "member",
      locale: "fr",
    });
    // Default invitation template still works (not overridden)
    expect(result.html).toContain("TestOrg");
  });
});
