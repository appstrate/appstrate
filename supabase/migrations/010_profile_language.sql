ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'fr'
    CHECK (language IN ('fr', 'en'));
