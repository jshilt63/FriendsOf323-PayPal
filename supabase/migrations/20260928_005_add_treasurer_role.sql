-- Separate migration because PostgreSQL enum additions must commit before use.
alter type public.app_role add value if not exists 'treasurer';
