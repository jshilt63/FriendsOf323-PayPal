import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const userId = '732d1ddc-2470-454b-bd29-4c963d2d5dfb';

const { data, error } = await supabase.auth.admin.updateUserById(
  userId,
  {
    user_metadata: {
      display_name: 'Jim Shilt',
      full_name: 'Jim Shilt'
    }
  }
);

if (error) {
  console.error('Display name update failed:');
  console.error(error);
  process.exit(1);
}

console.log('Display name updated successfully.');
console.log('UID:', data.user.id);
console.log('Email:', data.user.email);
console.log('Display name:', data.user.user_metadata?.display_name);