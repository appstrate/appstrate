// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for per-application SMTP + social auth configuration.
 * Mirrors `/api/applications/:id/smtp-config` and
 * `/api/applications/:id/social-providers/:provider` routes.
 *
 * Inputs are Zod-validated client-side before hitting the API so the form
 * gets immediate feedback on obvious errors (bad port range, malformed
 * email). The server still validates — this is purely UX.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { client, ApiError, type components } from "@/api/client";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";

/** Wire shapes from the OpenAPI spec. */
export type SmtpConfigView = components["schemas"]["SmtpConfigView"];
export type SocialProviderView = components["schemas"]["SocialProviderView"];
export type SocialProviderId = SocialProviderView["provider"];

export const upsertSmtpSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1, "Username is required"),
  pass: z.string().min(1, "Password is required"),
  fromAddress: z.email("Invalid email address"),
  fromName: z.string().nullable().optional(),
  secureMode: z.enum(["auto", "tls", "starttls", "none"]).optional(),
});

export type UpsertSmtpInput = z.infer<typeof upsertSmtpSchema>;

export const upsertSocialSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
  scopes: z.array(z.string()).nullable().optional(),
});

export type UpsertSocialInput = z.infer<typeof upsertSocialSchema>;

export function useSmtpConfig() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Same [method, path, init] shape as the $api hooks so the typed
    // path-string invalidations below hit this query too.
    queryKey: [
      "get",
      "/api/applications/{id}/smtp-config",
      { params: { path: { id: applicationId } } },
    ] as const,
    enabled: !!orgId && !!applicationId,
    queryFn: async (): Promise<SmtpConfigView | null> => {
      try {
        const { data } = await client.GET("/api/applications/{id}/smtp-config", {
          params: { path: { id: applicationId! } },
        });
        return data ?? null;
      } catch (err) {
        // 404 = not configured yet — render the empty form.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useUpsertSmtpConfig() {
  const qc = useQueryClient();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async (data: UpsertSmtpInput) => {
      const parsed = upsertSmtpSchema.parse(data);
      const { data: saved } = await client.PUT("/api/applications/{id}/smtp-config", {
        params: { path: { id: applicationId! } },
        // The wire format has no `null` — an empty fromName is omitted.
        body: { ...parsed, fromName: parsed.fromName ?? undefined },
      });
      if (!saved) throw new Error("empty response");
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/applications/{id}/smtp-config"] });
    },
  });
}

export function useDeleteSmtpConfig() {
  const qc = useQueryClient();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async () => {
      await client.DELETE("/api/applications/{id}/smtp-config", {
        params: { path: { id: applicationId! } },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/applications/{id}/smtp-config"] });
    },
  });
}

export function useTestSmtp() {
  const applicationId = useCurrentApplicationId();
  const toSchema = z.email("Invalid email address");
  return useMutation({
    mutationFn: async (to: string) => {
      const parsed = toSchema.parse(to);
      const { data } = await client.POST("/api/applications/{id}/smtp-config/test", {
        params: { path: { id: applicationId! } },
        body: { to: parsed },
      });
      if (!data) throw new Error("empty response");
      return data;
    },
  });
}

export function useSocialProvider(provider: SocialProviderId) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Same [method, path, init] shape as the $api hooks so the typed
    // path-string invalidations below hit this query too.
    queryKey: [
      "get",
      "/api/applications/{id}/social-providers/{provider}",
      { params: { path: { id: applicationId, provider } } },
    ] as const,
    enabled: !!orgId && !!applicationId,
    queryFn: async (): Promise<SocialProviderView | null> => {
      try {
        const { data } = await client.GET("/api/applications/{id}/social-providers/{provider}", {
          params: { path: { id: applicationId!, provider } },
        });
        return data ?? null;
      } catch (err) {
        // 404 = not configured yet — render the empty form.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useUpsertSocialProvider(provider: SocialProviderId) {
  const qc = useQueryClient();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async (data: UpsertSocialInput) => {
      const parsed = upsertSocialSchema.parse(data);
      const { data: saved } = await client.PUT(
        "/api/applications/{id}/social-providers/{provider}",
        {
          params: { path: { id: applicationId!, provider } },
          // The wire format has no `null` — empty scopes are omitted.
          body: { ...parsed, scopes: parsed.scopes ?? undefined },
        },
      );
      if (!saved) throw new Error("empty response");
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["get", "/api/applications/{id}/social-providers/{provider}"],
      });
    },
  });
}

export function useDeleteSocialProvider(provider: SocialProviderId) {
  const qc = useQueryClient();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async () => {
      await client.DELETE("/api/applications/{id}/social-providers/{provider}", {
        params: { path: { id: applicationId!, provider } },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["get", "/api/applications/{id}/social-providers/{provider}"],
      });
    },
  });
}
