import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const schema = import.meta.env.VITE_SUPABASE_SCHEMA ?? 'molip_english_blank'

export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: false },
        db: { schema },
      })
    : null
