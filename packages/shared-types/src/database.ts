export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      execution_logs: {
        Row: {
          created_at: string | null
          data: Json | null
          event: string | null
          execution_id: string
          id: number
          message: string | null
          org_id: string
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          data?: Json | null
          event?: string | null
          execution_id: string
          id?: number
          message?: string | null
          org_id: string
          type?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          data?: Json | null
          event?: string | null
          execution_id?: string
          id?: number
          message?: string | null
          org_id?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "execution_logs_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      executions: {
        Row: {
          completed_at: string | null
          cost_usd: number | null
          duration: number | null
          error: string | null
          flow_id: string
          flow_version_id: number | null
          id: string
          input: Json | null
          org_id: string
          result: Json | null
          schedule_id: string | null
          started_at: string | null
          state: Json | null
          status: string
          token_usage: Json | null
          tokens_used: number | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          cost_usd?: number | null
          duration?: number | null
          error?: string | null
          flow_id: string
          flow_version_id?: number | null
          id: string
          input?: Json | null
          org_id: string
          result?: Json | null
          schedule_id?: string | null
          started_at?: string | null
          state?: Json | null
          status?: string
          token_usage?: Json | null
          tokens_used?: number | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          cost_usd?: number | null
          duration?: number | null
          error?: string | null
          flow_id?: string
          flow_version_id?: number | null
          id?: string
          input?: Json | null
          org_id?: string
          result?: Json | null
          schedule_id?: string | null
          started_at?: string | null
          state?: Json | null
          status?: string
          token_usage?: Json | null
          tokens_used?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "executions_flow_version_id_fkey"
            columns: ["flow_version_id"]
            isOneToOne: false
            referencedRelation: "flow_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "executions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_admin_connections: {
        Row: {
          admin_user_id: string
          connected_at: string | null
          flow_id: string
          org_id: string
          service_id: string
        }
        Insert: {
          admin_user_id: string
          connected_at?: string | null
          flow_id: string
          org_id: string
          service_id: string
        }
        Update: {
          admin_user_id?: string
          connected_at?: string | null
          flow_id?: string
          org_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_admin_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_configs: {
        Row: {
          config: Json
          created_at: string | null
          flow_id: string
          org_id: string
          updated_at: string | null
        }
        Insert: {
          config?: Json
          created_at?: string | null
          flow_id: string
          org_id: string
          updated_at?: string | null
        }
        Update: {
          config?: Json
          created_at?: string | null
          flow_id?: string
          org_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flow_configs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_schedules: {
        Row: {
          created_at: string | null
          cron_expression: string
          enabled: boolean | null
          flow_id: string
          id: string
          input: Json | null
          last_run_at: string | null
          name: string | null
          next_run_at: string | null
          org_id: string
          timezone: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          cron_expression: string
          enabled?: boolean | null
          flow_id: string
          id: string
          input?: Json | null
          last_run_at?: string | null
          name?: string | null
          next_run_at?: string | null
          org_id: string
          timezone?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          cron_expression?: string
          enabled?: boolean | null
          flow_id?: string
          id?: string
          input?: Json | null
          last_run_at?: string | null
          name?: string | null
          next_run_at?: string | null
          org_id?: string
          timezone?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      flow_versions: {
        Row: {
          created_at: string | null
          created_by: string | null
          flow_id: string
          id: number
          version_number: number
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          flow_id: string
          id?: number
          version_number: number
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          flow_id?: string
          id?: number
          version_number?: number
        }
        Relationships: []
      }
      flows: {
        Row: {
          created_at: string | null
          id: string
          manifest: Json
          org_id: string
          prompt: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id: string
          manifest: Json
          org_id: string
          prompt: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          manifest?: Json
          org_id?: string
          prompt?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flows_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          joined_at: string | null
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          joined_at?: string | null
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          joined_at?: string | null
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          name: string
          slug: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          name: string
          slug: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          name?: string
          slug?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string | null
          display_name: string | null
          id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          display_name?: string | null
          id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          display_name?: string | null
          id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      schedule_runs: {
        Row: {
          created_at: string | null
          execution_id: string | null
          fire_time: string
          id: string
          instance_id: string | null
          schedule_id: string
        }
        Insert: {
          created_at?: string | null
          execution_id?: string | null
          fire_time: string
          id?: string
          instance_id?: string | null
          schedule_id: string
        }
        Update: {
          created_at?: string | null
          execution_id?: string | null
          fire_time?: string
          id?: string
          instance_id?: string | null
          schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_runs_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "flow_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      share_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string | null
          created_by: string
          execution_id: string | null
          expires_at: string
          flow_id: string
          id: string
          org_id: string
          token: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string | null
          created_by: string
          execution_id?: string | null
          expires_at: string
          flow_id: string
          id?: string
          org_id: string
          token: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string | null
          created_by?: string
          execution_id?: string | null
          expires_at?: string
          flow_id?: string
          id?: string
          org_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "share_tokens_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "share_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cleanup_old_schedule_runs: {
        Args: { retention_days?: number }
        Returns: number
      }
      consume_share_token: {
        Args: { p_token: string }
        Returns: {
          created_by: string
          flow_id: string
          id: string
        }[]
      }
      create_flow_version: {
        Args: { p_created_by: string; p_flow_id: string }
        Returns: number
      }
      is_org_admin: { Args: { p_org_id: string }; Returns: boolean }
      is_org_member: { Args: { p_org_id: string }; Returns: boolean }
      try_acquire_schedule_lock: {
        Args: {
          p_fire_time: string
          p_instance_id: string
          p_schedule_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
