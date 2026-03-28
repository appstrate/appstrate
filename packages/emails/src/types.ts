export type SupportedLocale = "fr" | "en";

export type EmailType = "verification" | "invitation";

export interface EmailPropsMap {
  verification: {
    user: { name: string; email: string };
    url: string;
    locale: SupportedLocale;
  };
  invitation: {
    email: string;
    inviteUrl: string;
    orgName: string;
    inviterName: string;
    role: string;
    locale: SupportedLocale;
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export type EmailRenderer<T extends EmailType> = (props: EmailPropsMap[T]) => RenderedEmail;
